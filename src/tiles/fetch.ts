import type { ProtocolHandler, ProtocolRequest } from "./protocols.ts";
import { protocolFor } from "./protocols.ts";
import type { TileFailure } from "./tile.ts";

export type ResourceKind = "style" | "source" | "tile" | "glyphs" | "image";

export interface RequestParameters {
  url: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
}

export type TransformRequest = (url: string, kind: ResourceKind) => RequestParameters | undefined | null;

export class FetchFailure extends Error {
  readonly failure: TileFailure;

  constructor(failure: TileFailure) {
    super(failure.message);
    this.name = "FetchFailure";
    this.failure = failure;
  }
}

export type FetchResult = { kind: "data"; data: ArrayBuffer; contentType: string } | { kind: "empty" };

export function resolveRequest(
  url: string,
  kind: ResourceKind,
  transform: TransformRequest | undefined,
): RequestParameters {
  const custom = transform?.(url, kind);
  return custom ?? { url };
}

export async function fetchBytes(
  params: RequestParameters,
  signal: AbortSignal,
  timeoutMs: number,
  kind: ResourceKind = "tile",
): Promise<FetchResult> {
  const handler = protocolFor(params.url);
  if (handler) return fetchWithProtocol(handler, { ...params, kind }, signal);
  const timeout = new AbortController();
  const onAbort = () => timeout.abort(signal.reason);
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          timeout.abort(new DOMException("Timed out", "TimeoutError"));
        }, timeoutMs)
      : undefined;
  try {
    const init: RequestInit = { signal: timeout.signal };
    if (params.headers) init.headers = params.headers;
    if (params.credentials) init.credentials = params.credentials;
    let response: Response;
    try {
      response = await fetch(params.url, init);
    } catch (error) {
      if (signal.aborted) throw error;
      if (timedOut) {
        throw new FetchFailure({
          kind: "timeout",
          message: `Request timed out after ${timeoutMs} ms`,
          retryable: true,
        });
      }
      throw new FetchFailure({ kind: "network", message: "Network request failed", retryable: true });
    }
    const status = response.status;
    if (status === 204 || status === 404 || status === 410) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "empty" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchFailure(classifyStatus(status, response.headers.get("retry-after")));
    }
    let data: ArrayBuffer;
    try {
      data = await response.arrayBuffer();
    } catch (error) {
      if (signal.aborted) throw error;
      if (timedOut) {
        throw new FetchFailure({
          kind: "timeout",
          message: `Request timed out after ${timeoutMs} ms`,
          retryable: true,
        });
      }
      throw new FetchFailure({ kind: "network", message: "Response body could not be read", retryable: true });
    }
    if (data.byteLength === 0) return { kind: "empty" };
    return { kind: "data", data, contentType: response.headers.get("content-type") ?? "" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function classifyStatus(status: number, retryAfter: string | null): TileFailure {
  if (status === 401 || status === 403) {
    return { kind: "auth", status, message: `Access denied (HTTP ${status})`, retryable: false };
  }
  if (status === 429) {
    const failure: TileFailure = { kind: "rate-limit", status, message: "Rate limited (HTTP 429)", retryable: true };
    const wait = parseRetryAfter(retryAfter);
    if (wait !== undefined) failure.retryAfterMs = wait;
    return failure;
  }
  const retryable = status >= 500 || status === 408 || status === 425;
  const failure: TileFailure = { kind: "http", status, message: `HTTP ${status}`, retryable };
  if (status === 503) {
    const wait = parseRetryAfter(retryAfter);
    if (wait !== undefined) failure.retryAfterMs = wait;
  }
  return failure;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 10 * 60 * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(date - now, 10 * 60 * 1000));
}

export function retryDelay(attempt: number, failure: TileFailure, random: () => number = Math.random): number {
  const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));
  const jittered = base * (0.8 + 0.4 * random());
  return Math.max(jittered, failure.retryAfterMs ?? 0);
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name: unknown }).name === "AbortError" || (error as { name: unknown }).name === "TimeoutError")
  );
}

export function expandTemplate(
  template: string,
  z: number,
  x: number,
  y: number,
  extra: (key: string) => string | undefined,
): string {
  return template.replace(/\{([a-z-]+)\}/gi, (match, key: string) => {
    switch (key) {
      case "z":
        return String(z);
      case "x":
        return String(x);
      case "y":
        return String(y);
      case "-y":
        return String(2 ** z - 1 - y);
      default:
        return extra(key) ?? match;
    }
  });
}
