import type { ResourceKind } from "../tiles/fetch.ts";
import type { ProtocolRequest, ProtocolResult } from "../tiles/protocols.ts";
import { addProtocol as addNativeProtocol, removeProtocol as removeNativeProtocol } from "../tiles/protocols.ts";

export type ResourceType =
  | "Unknown"
  | "Style"
  | "Source"
  | "Tile"
  | "Glyphs"
  | "SpriteImage"
  | "SpriteJSON"
  | "Image"
  | "JSON";

export interface RequestParameters {
  url: string;
  headers?: Record<string, string> | Headers | undefined;
  method?: "GET" | "POST" | "PUT" | undefined;
  body?: string | undefined;
  type?: "string" | "json" | "arrayBuffer" | "image" | undefined;
  credentials?: RequestCredentials | undefined;
  collectResourceTiming?: boolean | undefined;
  cache?: RequestCache | undefined;
}

export interface GetResourceResponse<T> {
  data: T;
  cacheControl?: string | null;
  expires?: string | null;
}

type Callback = (error?: unknown, data?: unknown, cacheControl?: string | null, expires?: string | null) => void;

export type AddProtocolAction = (
  params: RequestParameters,
  abortController: AbortController & Callback,
) => Promise<GetResourceResponse<unknown>> | { cancel(): void } | undefined;

export function resourceType(kind: ResourceKind, url: string): ResourceType {
  switch (kind) {
    case "style":
      return "Style";
    case "source":
      return "Source";
    case "tile":
      return "Tile";
    case "glyphs":
      return "Glyphs";
    case "sprite":
      return /\.json(\?|#|$)/i.test(url) ? "SpriteJSON" : "SpriteImage";
    case "image":
      return "Image";
    default:
      return "Unknown";
  }
}

function responseType(kind: ResourceKind, url: string): RequestParameters["type"] {
  if (kind === "style" || kind === "source") return "json";
  if (kind === "sprite") return /\.json(\?|#|$)/i.test(url) ? "json" : "image";
  if (kind === "image") return "image";
  return "arrayBuffer";
}

export function addProtocol(name: string, action: AddProtocolAction): void {
  addNativeProtocol(name, (request, signal) => runAction(action, request, signal));
}

export function removeProtocol(name: string): void {
  removeNativeProtocol(name);
}

async function runAction(
  action: AddProtocolAction,
  request: ProtocolRequest,
  signal: AbortSignal,
): Promise<ProtocolResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const params: RequestParameters = {
    url: request.url,
    type: responseType(request.kind, request.url),
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.credentials ? { credentials: request.credentials } : {}),
  };
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      const callback = ((error?: unknown, data?: unknown, cacheControl?: string | null, expires?: string | null) => {
        if (error) reject(error);
        else resolve({ data, cacheControl, expires });
      }) as AbortController & Callback;
      Object.defineProperty(callback, "signal", { value: controller.signal });
      Object.defineProperty(callback, "abort", { value: (reason?: unknown) => controller.abort(reason) });
      let returned: unknown;
      try {
        returned = action(params, callback);
      } catch (error) {
        reject(error);
        return;
      }
      if (returned && typeof (returned as Promise<unknown>).then === "function") {
        (returned as Promise<unknown>).then(resolve, reject);
      } else if (returned && typeof (returned as { cancel?: unknown }).cancel === "function") {
        controller.signal.addEventListener("abort", () => (returned as { cancel(): void }).cancel(), { once: true });
      }
    });
    const data = response && typeof response === "object" && "data" in response ? response.data : response;
    return await toBytes(data);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function toBytes(data: unknown): Promise<ProtocolResult> {
  if (data === null || data === undefined) return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { data: await data.arrayBuffer(), contentType: data.type };
  }
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (isDrawable(data)) return { data: await encodePng(data), contentType: "image/png" };
  return { data: new TextEncoder().encode(JSON.stringify(data)), contentType: "application/json" };
}

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData;

function isDrawable(data: unknown): data is Drawable {
  return (
    (typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== "undefined" && data instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== "undefined" && data instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== "undefined" && data instanceof OffscreenCanvas) ||
    (typeof ImageData !== "undefined" && data instanceof ImageData)
  );
}

async function encodePng(image: Drawable): Promise<ArrayBuffer> {
  const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not draw the protocol image");
    if (image instanceof ImageData) ctx.putImageData(image, 0, 0);
    else ctx.drawImage(image, 0, 0);
    return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw the protocol image");
  if (image instanceof ImageData) ctx.putImageData(image, 0, 0);
  else ctx.drawImage(image as CanvasImageSource, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the protocol image");
  return blob.arrayBuffer();
}
