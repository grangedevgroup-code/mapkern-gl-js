import type { RequestParameters, ResourceKind } from "./fetch.ts";

export interface ProtocolRequest extends RequestParameters {
  kind: ResourceKind;
}

export type ProtocolResult = ArrayBuffer | Uint8Array | { data: ArrayBuffer | Uint8Array; contentType?: string } | null;

export type ProtocolHandler = (request: ProtocolRequest, signal: AbortSignal) => Promise<ProtocolResult>;

const handlers = new Map<string, ProtocolHandler>();

export function addProtocol(scheme: string, handler: ProtocolHandler): void {
  const key = normalize(scheme);
  if (!/^[a-z][a-z0-9+.-]*$/.test(key)) throw new TypeError(`Invalid protocol name "${scheme}"`);
  if (key === "http" || key === "https") throw new TypeError("http and https cannot be replaced");
  handlers.set(key, handler);
}

export function removeProtocol(scheme: string): void {
  handlers.delete(normalize(scheme));
}

export function protocolFor(url: string): ProtocolHandler | undefined {
  const i = url.indexOf("://");
  if (i <= 0) return undefined;
  return handlers.get(url.slice(0, i).toLowerCase());
}

function normalize(scheme: string): string {
  return scheme.replace(/:\/*$/, "").toLowerCase();
}
