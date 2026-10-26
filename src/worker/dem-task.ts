import type { DemGrid, Unpack } from "../terrain/dem.ts";
import { decodeDem, decodeElevations, gradients } from "../terrain/dem.ts";

export interface DemPixels {
  data: Uint8ClampedArray;
  size: number;
}

export interface DemRequest {
  bytes?: ArrayBuffer;
  pixels?: DemPixels;
  raw?: ArrayBuffer;
  unpack: Unpack;
}

const RAW_MAGIC = [0x4d, 0x4b, 0x45, 0x4c];

export function encodeRawElevation(values: Float32Array, size: number): ArrayBuffer {
  const out = new ArrayBuffer(8 + size * size * 4);
  new Uint8Array(out, 0, 4).set(RAW_MAGIC);
  new DataView(out).setUint32(4, size, true);
  new Float32Array(out, 8, size * size).set(values.subarray(0, size * size));
  return out;
}

export function isRawElevation(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 8) return false;
  const head = new Uint8Array(bytes, 0, 4);
  return RAW_MAGIC.every((b, i) => head[i] === b);
}

export const NO_OFFSCREEN = "This browser cannot read elevation tiles off screen";

interface Canvas2D {
  getContext(
    type: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
}

export interface DemReply {
  grid: DemGrid;
  gradient: Float32Array;
}

export async function decodeDemTile(
  request: DemRequest,
  signal: AbortSignal,
): Promise<{ result: DemReply | null; transfer?: Transferable[] }> {
  if (request.raw) {
    const size = new DataView(request.raw).getUint32(4, true);
    if (request.raw.byteLength < 8 + size * size * 4) throw new Error("Elevation tile is shorter than its size says");
    return finish(decodeElevations(new Float32Array(request.raw, 8, size * size), size));
  }
  let pixels = request.pixels;
  if (!pixels) {
    if (typeof OffscreenCanvas === "undefined" || !request.bytes) throw new Error(NO_OFFSCREEN);
    pixels = await readPixels(request.bytes, signal, (size) => new OffscreenCanvas(size, size));
  }
  return finish(decodeDem(pixels.data, pixels.size, request.unpack));
}

function finish(grid: ReturnType<typeof decodeDem>): { result: DemReply | null; transfer?: Transferable[] } {
  if (!grid) return { result: null };
  const gradient = gradients(grid);
  const transfer: Transferable[] = [grid.elevation.buffer, gradient.buffer];
  if (grid.mask) transfer.push(grid.mask.buffer);
  return { result: { grid, gradient }, transfer };
}

export async function readPixels(
  bytes: ArrayBuffer,
  signal: AbortSignal,
  canvas: (size: number) => Canvas2D | null,
): Promise<DemPixels> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: imageType(new Uint8Array(bytes)) }), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  } catch {
    throw new Error("Elevation tile image could not be decoded");
  }
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const size = bitmap.width;
    if (size !== bitmap.height || size < 2) {
      throw new Error(`Elevation tiles must be square, this one is ${bitmap.width}x${bitmap.height}`);
    }
    const ctx = canvas(size)?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (!ctx) throw new Error(NO_OFFSCREEN);
    ctx.drawImage(bitmap, 0, 0);
    return { data: ctx.getImageData(0, 0, size, size).data, size };
  } finally {
    bitmap.close();
  }
}

export function imageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57)
    return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "image/avif";
  return "image/png";
}
