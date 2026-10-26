import type { RawImage, StyleImage } from "../render/images.ts";
import { premultiplied } from "../render/images.ts";
import { MapkernError } from "./errors.ts";

export type ImageInput =
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | ImageData
  | OffscreenCanvas
  | { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

export interface ImageOptions {
  pixelRatio?: number;
  sdf?: boolean;
  stretchX?: [number, number][];
  stretchY?: [number, number][];
  content?: [number, number, number, number];
}

export interface SpriteSheet {
  id: string;
  url: string;
}

export function styleImage(id: string, input: ImageInput, options: ImageOptions, sprite: boolean): StyleImage {
  if (typeof id !== "string" || id === "") throw new MapkernError("invalid-option", "Images need a non-empty name");
  const pixelRatio = options.pixelRatio ?? 1;
  if (typeof pixelRatio !== "number" || !Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new MapkernError("invalid-option", "pixelRatio must be a number greater than 0", { image: id });
  }
  const raw = pixelsOf(input, id);
  const stretchX = zonesOf(options.stretchX, raw.width);
  const stretchY = zonesOf(options.stretchY, raw.height);
  const content = contentOf(options.content, raw.width, raw.height);
  if (stretchX === null || stretchY === null || content === null) {
    throw new MapkernError(
      "invalid-option",
      `Image "${id}": stretchX and stretchY need [from, to] pixel ranges and content needs [left, top, right, bottom] inside the image`,
      { image: id },
    );
  }
  return {
    id,
    width: raw.width,
    height: raw.height,
    data: premultiplied(raw),
    pixelRatio,
    sdf: options.sdf === true,
    sprite,
    ...(stretchX ? { stretchX } : {}),
    ...(stretchY ? { stretchY } : {}),
    ...(content ? { content } : {}),
  };
}

function zonesOf(value: unknown, size: number): [number, number][] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const out: [number, number][] = [];
  for (const zone of value) {
    if (!Array.isArray(zone) || zone.length !== 2) return null;
    const [a, b] = zone as [unknown, unknown];
    if (typeof a !== "number" || typeof b !== "number" || !(a >= 0 && b > a && b <= size)) return null;
    out.push([a, b]);
  }
  out.sort((p, q) => p[0] - q[0]);
  for (let i = 1; i < out.length; i++) if (out[i]![0] < out[i - 1]![1]) return null;
  return out.length > 0 ? out : undefined;
}

function contentOf(value: unknown, width: number, height: number): [number, number, number, number] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === "number")) return null;
  const [x0, y0, x1, y1] = value as [number, number, number, number];
  return x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0 && x1 <= width && y1 <= height ? [x0, y0, x1, y1] : null;
}

export function pixelsOf(input: ImageInput, id: string): RawImage {
  if (typeof input !== "object" || input === null) {
    throw new MapkernError(
      "invalid-option",
      `Image "${id}" must be an image, canvas, bitmap or { width, height, data }`,
    );
  }
  if ("data" in input && !("getContext" in input)) {
    const { width, height, data } = input as RawImage;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new MapkernError("invalid-option", `Image "${id}" needs a whole-number width and height`);
    }
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
      throw new MapkernError("invalid-option", `Image "${id}" needs ${width * height * 4} bytes of RGBA data`);
    }
    return { width, height, data };
  }
  const source = input as CanvasImageSource & { width: number; height: number };
  const width = "naturalWidth" in source ? (source as HTMLImageElement).naturalWidth : source.width;
  const height = "naturalHeight" in source ? (source as HTMLImageElement).naturalHeight : source.height;
  if (!(width > 0 && height > 0)) {
    throw new MapkernError("invalid-option", `Image "${id}" has no pixels yet; wait for it to load before adding it`);
  }
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new MapkernError("invalid-option", `Image "${id}" could not be read`);
  ctx.drawImage(source, 0, 0);
  try {
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  } catch (error) {
    throw new MapkernError(
      "invalid-option",
      `Image "${id}" comes from another site that doesn't allow reading it; serve it with CORS headers`,
      { image: id },
      error,
    );
  }
}

export function spriteImages(prefix: string, index: unknown, sheet: RawImage): StyleImage[] {
  if (typeof index !== "object" || index === null || Array.isArray(index)) {
    throw new MapkernError("invalid-style", "A sprite index must be a JSON object of images");
  }
  const out: StyleImage[] = [];
  for (const [name, entry] of Object.entries(index as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { x, y, width, height, pixelRatio, sdf, stretchX, stretchY, content } = entry as Record<string, unknown>;
    if (![x, y, width, height].every((v) => Number.isInteger(v) && (v as number) >= 0)) continue;
    const w = width as number;
    const h = height as number;
    const left = x as number;
    const top = y as number;
    if (w === 0 || h === 0 || left + w > sheet.width || top + h > sheet.height) continue;
    const data = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((top + row) * sheet.width + left) * 4;
      data.set(sheet.data.subarray(from, from + w * 4), row * w * 4);
    }
    const ratio = typeof pixelRatio === "number" && pixelRatio > 0 ? pixelRatio : 1;
    const zonesX = zonesOf(stretchX, w) ?? undefined;
    const zonesY = zonesOf(stretchY, h) ?? undefined;
    const box = contentOf(content, w, h) ?? undefined;
    out.push({
      id: prefix ? `${prefix}:${name}` : name,
      width: w,
      height: h,
      data: premultiplied({ width: w, height: h, data }),
      pixelRatio: ratio,
      sdf: sdf === true,
      sprite: true,
      ...(zonesX ? { stretchX: zonesX } : {}),
      ...(zonesY ? { stretchY: zonesY } : {}),
      ...(box ? { content: box } : {}),
    });
  }
  return out;
}

export function spriteSheets(sprite: unknown): SpriteSheet[] {
  if (sprite === undefined) return [];
  if (typeof sprite === "string") return [{ id: "", url: sprite }];
  if (!Array.isArray(sprite)) return [];
  return sprite
    .filter((s): s is SpriteSheet => typeof s?.id === "string" && typeof s?.url === "string")
    .map((s) => ({ id: s.id === "default" ? "" : s.id, url: s.url }));
}

export function spriteUrl(url: string, suffix: string, extension: string): string {
  const cut = url.search(/[?#]/);
  const base = cut < 0 ? url : url.slice(0, cut);
  const rest = cut < 0 ? "" : url.slice(cut);
  return `${base}${suffix}${extension}${rest}`;
}
