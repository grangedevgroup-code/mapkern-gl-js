export interface RasterRequest {
  bytes: ArrayBuffer;
  type: string;
}

export interface RasterReply {
  image: ImageBitmap;
  hash: number;
}

export const NOT_AN_IMAGE = "Tile image could not be decoded";

export async function decodeRaster(request: RasterRequest, signal: AbortSignal): Promise<RasterReply> {
  const hash = fingerprint(new Uint8Array(request.bytes));
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(new Blob([request.bytes], { type: request.type }), {
      premultiplyAlpha: "premultiply",
      colorSpaceConversion: "none",
    });
  } catch {
    throw new Error(NOT_AN_IMAGE);
  }
  if (signal.aborted) {
    image.close();
    throw new DOMException("Aborted", "AbortError");
  }
  return { image, hash };
}

export async function decodeRasterTile(
  request: RasterRequest,
  signal: AbortSignal,
): Promise<{ result: RasterReply; transfer: Transferable[] }> {
  const reply = await decodeRaster(request, signal);
  return { result: reply, transfer: [reply.image] };
}

export function fingerprint(bytes: Uint8Array): number {
  let h = 0x811c9dc5 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
