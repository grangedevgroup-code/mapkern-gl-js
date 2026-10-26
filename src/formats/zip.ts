export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  offset: number;
  encrypted: boolean;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("The file is not a ZIP archive");
  const count = view.getUint16(eocd + 10, true);
  const start = view.getUint32(eocd + 16, true);
  if (count === 0xffff || start === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = start;
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50)
      throw new ZipError("The ZIP directory is damaged");
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    entries.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      crc: view.getUint32(p + 16, true),
      offset: view.getUint32(p + 42, true),
      encrypted: (view.getUint16(p + 8, true) & 1) !== 0,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.offset;
  if (p + 30 > bytes.length || view.getUint32(p, true) !== 0x04034b50) throw new ZipError(`${entry.name} is damaged`);
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const data = bytes.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8)
    throw new ZipError(`${entry.name} uses compression method ${entry.method}, which is not supported`);
  return inflateRaw(data, entry.crc, entry.size, rawDeflateSupported());
}

export async function inflateRaw(data: Uint8Array, crc: number, size: number, raw: boolean): Promise<Uint8Array> {
  const input = raw ? data : asGzip(data, crc, size);
  const stream = new Blob([input as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream(raw ? "deflate-raw" : "gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let rawSupport: boolean | undefined;

function rawDeflateSupported(): boolean {
  if (rawSupport === undefined) {
    try {
      new DecompressionStream("deflate-raw");
      rawSupport = true;
    } catch {
      rawSupport = false;
    }
  }
  return rawSupport;
}

function asGzip(data: Uint8Array, crc: number, size: number): Uint8Array {
  const out = new Uint8Array(10 + data.length + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff], 0);
  out.set(data, 10);
  const view = new DataView(out.buffer);
  view.setUint32(10 + data.length, crc >>> 0, true);
  view.setUint32(14 + data.length, size >>> 0, true);
  return out;
}
