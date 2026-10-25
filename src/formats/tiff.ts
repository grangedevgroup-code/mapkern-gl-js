export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface GeoInfo {
  epsg: number | null;
  geographic: boolean;
  transform: [number, number, number, number, number, number];
  linearUnit: number;
  verticalUnit: number;
}

export interface TiffImage {
  width: number;
  height: number;
  bitsPerSample: number;
  sampleFormat: number;
  samplesPerPixel: number;
  planar: number;
  compression: number;
  predictor: number;
  blockWidth: number;
  blockHeight: number;
  offsets: number[];
  counts: number[];
  noData: number | null;
  geo: GeoInfo | null;
  littleEndian: boolean;
}

export class TiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiffError";
  }
}

const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  16: 8,
  17: 8,
  18: 8,
};

interface Entry {
  type: number;
  count: number;
  values: (number | string)[];
}

export async function readTiff(source: ByteSource): Promise<TiffImage[]> {
  const head = await source.read(0, 16);
  const order = String.fromCharCode(head[0]!, head[1]!);
  if (order !== "II" && order !== "MM") throw new TiffError("This is not a TIFF file");
  const little = order === "II";
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const magic = view.getUint16(2, little);
  const big = magic === 43;
  if (magic !== 42 && !big) throw new TiffError("This is not a TIFF file");
  let next = big ? Number(view.getBigUint64(8, little)) : view.getUint32(4, little);
  const images: TiffImage[] = [];
  const seen = new Set<number>();
  while (next > 0 && !seen.has(next) && images.length < 64) {
    seen.add(next);
    const { entries, nextOffset } = await readIfd(source, next, little, big);
    images.push(imageFrom(entries, little));
    next = nextOffset;
  }
  if (images.length === 0) throw new TiffError("The TIFF file has no images");
  return images;
}

async function readIfd(
  source: ByteSource,
  offset: number,
  little: boolean,
  big: boolean,
): Promise<{ entries: Map<number, Entry>; nextOffset: number }> {
  const countBytes = await source.read(offset, big ? 8 : 2);
  const cv = new DataView(countBytes.buffer, countBytes.byteOffset, countBytes.byteLength);
  const count = big ? Number(cv.getBigUint64(0, little)) : cv.getUint16(0, little);
  const entrySize = big ? 20 : 12;
  const start = offset + (big ? 8 : 2);
  const raw = await source.read(start, count * entrySize + (big ? 8 : 4));
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const entries = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const o = i * entrySize;
    const tag = v.getUint16(o, little);
    const type = v.getUint16(o + 2, little);
    const n = big ? Number(v.getBigUint64(o + 4, little)) : v.getUint32(o + 4, little);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const inline = big ? 8 : 4;
    let bytes: Uint8Array;
    if (size <= inline) {
      bytes = raw.subarray(o + (big ? 12 : 8), o + (big ? 12 : 8) + size);
    } else {
      const at = big ? Number(v.getBigUint64(o + 12, little)) : v.getUint32(o + 8, little);
      bytes = await source.read(at, size);
    }
    entries.set(tag, { type, count: n, values: decodeValues(bytes, type, n, little) });
  }
  const tail = count * entrySize;
  const nextOffset = big ? Number(v.getBigUint64(tail, little)) : v.getUint32(tail, little);
  return { entries, nextOffset };
}

function decodeValues(bytes: Uint8Array, type: number, count: number, little: boolean): (number | string)[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: (number | string)[] = [];
  if (type === 2) {
    let text = "";
    for (const b of bytes) text += b === 0 ? "\u0000" : String.fromCharCode(b);
    return text.split("\u0000").filter((s, i, all) => s.length > 0 || i < all.length - 1);
  }
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1:
      case 7:
        out.push(v.getUint8(i));
        break;
      case 6:
        out.push(v.getInt8(i));
        break;
      case 3:
        out.push(v.getUint16(i * 2, little));
        break;
      case 8:
        out.push(v.getInt16(i * 2, little));
        break;
      case 4:
        out.push(v.getUint32(i * 4, little));
        break;
      case 9:
        out.push(v.getInt32(i * 4, little));
        break;
      case 5:
        out.push(v.getUint32(i * 8, little) / v.getUint32(i * 8 + 4, little));
        break;
      case 10:
        out.push(v.getInt32(i * 8, little) / v.getInt32(i * 8 + 4, little));
        break;
      case 11:
        out.push(v.getFloat32(i * 4, little));
        break;
      case 12:
        out.push(v.getFloat64(i * 8, little));
        break;
      case 16:
      case 18:
        out.push(Number(v.getBigUint64(i * 8, little)));
        break;
      case 17:
        out.push(Number(v.getBigInt64(i * 8, little)));
        break;
      default:
        out.push(0);
    }
  }
  return out;
}

function imageFrom(entries: Map<number, Entry>, little: boolean): TiffImage {
  const num = (tag: number, fallback: number) => {
    const value = entries.get(tag)?.values[0];
    return typeof value === "number" ? value : fallback;
  };
  const list = (tag: number) => (entries.get(tag)?.values ?? []).filter((x): x is number => typeof x === "number");
  const width = num(256, 0);
  const height = num(257, 0);
  if (!(width > 0 && height > 0)) throw new TiffError("The TIFF image has no size");
  const tiled = entries.has(322);
  const blockWidth = tiled ? num(322, width) : width;
  const blockHeight = tiled ? num(323, height) : Math.min(height, num(278, height));
  const offsets = tiled ? list(324) : list(273);
  const counts = tiled ? list(325) : list(279);
  if (offsets.length === 0 || offsets.length !== counts.length) throw new TiffError("The TIFF image data is missing");
  const noDataText = entries.get(42113)?.values[0];
  const noData = typeof noDataText === "string" && noDataText.trim() !== "" ? Number(noDataText.trim()) : null;
  return {
    width,
    height,
    bitsPerSample: list(258)[0] ?? 1,
    sampleFormat: list(339)[0] ?? 1,
    samplesPerPixel: num(277, 1),
    planar: num(284, 1),
    compression: num(259, 1),
    predictor: num(317, 1),
    blockWidth,
    blockHeight,
    offsets,
    counts,
    noData: noData !== null && Number.isFinite(noData) ? noData : null,
    geo: geoInfo(entries),
    littleEndian: little,
  };
}

const UNIT: Record<number, number> = { 9001: 1, 9002: 0.3048, 9003: 1200 / 3937, 9036: 1000 };

function geoInfo(entries: Map<number, Entry>): GeoInfo | null {
  const numbers = (tag: number) => (entries.get(tag)?.values ?? []).filter((x): x is number => typeof x === "number");
  const directory = numbers(34735);
  const keys = new Map<number, number | string>();
  if (directory.length >= 4) {
    const doubles = numbers(34736);
    const ascii = (entries.get(34737)?.values ?? []).map(String).join("|");
    for (let i = 0; i < directory[3]!; i++) {
      const [key, location, count, value] = directory.slice(4 + i * 4, 8 + i * 4) as [number, number, number, number];
      if (location === 0) keys.set(key, value);
      else if (location === 34736) keys.set(key, doubles[value] ?? 0);
      else if (location === 34737) keys.set(key, ascii.slice(value, value + count));
    }
  }
  const scale = numbers(33550);
  const tie = numbers(33922);
  const matrix = numbers(34264);
  let transform: [number, number, number, number, number, number] | null = null;
  if (matrix.length >= 16) {
    transform = [matrix[3]!, matrix[0]!, matrix[1]!, matrix[7]!, matrix[4]!, matrix[5]!];
  } else if (scale.length >= 2 && tie.length >= 6) {
    const [i, j, , x, y] = tie as [number, number, number, number, number];
    transform = [x - i * scale[0]!, scale[0]!, 0, y + j * scale[1]!, 0, -scale[1]!];
  }
  if (!transform) return null;
  if (keys.get(1025) === 2) {
    transform[0] -= (transform[1] + transform[2]) / 2;
    transform[3] -= (transform[4] + transform[5]) / 2;
  }
  const model = keys.get(1024);
  const projected = keys.get(3072);
  const geographic = keys.get(2048);
  const isGeographic = model === 2 || (model === undefined && projected === undefined);
  const epsg = isGeographic
    ? typeof geographic === "number"
      ? geographic
      : 4326
    : typeof projected === "number" && projected !== 32767
      ? projected
      : null;
  const linear = keys.get(3076);
  const vertical = keys.get(4099);
  return {
    epsg,
    geographic: isGeographic,
    transform,
    linearUnit: typeof linear === "number" ? (UNIT[linear] ?? 1) : 1,
    verticalUnit: typeof vertical === "number" ? (UNIT[vertical] ?? 1) : 1,
  };
}

export async function readBlock(source: ByteSource, image: TiffImage, index: number): Promise<Float32Array> {
  const offset = image.offsets[index];
  const count = image.counts[index];
  if (offset === undefined || count === undefined) throw new TiffError(`TIFF block ${index} does not exist`);
  const rows = Math.min(image.blockHeight, image.height - Math.floor(index / blocksAcross(image)) * image.blockHeight);
  const tiled = image.blockWidth !== image.width || image.blockHeight !== image.height || image.offsets.length > 1;
  const height = tiled && image.blockWidth !== image.width ? image.blockHeight : rows;
  const bytesPerSample = image.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1 || bytesPerSample > 8) {
    throw new TiffError(`${image.bitsPerSample}-bit TIFF samples are not supported`);
  }
  const spp = image.planar === 2 ? 1 : image.samplesPerPixel;
  const expected = image.blockWidth * height * spp * bytesPerSample;
  const raw = count > 0 ? await source.read(offset, count) : new Uint8Array(expected);
  const data = await decompress(raw, image.compression, expected);
  if (data.length < expected) throw new TiffError("A TIFF block is shorter than expected");
  const rowBytes = image.blockWidth * spp * bytesPerSample;
  if (image.predictor === 3) floatPredictor(data, image.blockWidth * spp, bytesPerSample, height, spp);
  const out = new Float32Array(image.blockWidth * height);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const little = image.predictor === 3 ? false : image.littleEndian;
  const read = sampleReader(v, image.sampleFormat, bytesPerSample, little);
  for (let r = 0; r < height; r++) {
    const row = r * rowBytes;
    if (image.predictor === 2) {
      let previous = 0;
      for (let c = 0; c < image.blockWidth; c++) {
        const at = row + c * spp * bytesPerSample;
        const value = wrap(read(at) + previous, image.sampleFormat, image.bitsPerSample);
        previous = value;
        out[r * image.blockWidth + c] = value;
      }
    } else {
      for (let c = 0; c < image.blockWidth; c++) out[r * image.blockWidth + c] = read(row + c * spp * bytesPerSample);
    }
  }
  return out;
}

export function blocksAcross(image: TiffImage): number {
  return Math.ceil(image.width / image.blockWidth);
}

function wrap(value: number, format: number, bits: number): number {
  if (format === 3) return value;
  const range = 2 ** bits;
  let v = value % range;
  if (v < 0) v += range;
  if (format === 2 && v >= range / 2) v -= range;
  return v;
}

function sampleReader(v: DataView, format: number, bytes: number, little: boolean): (at: number) => number {
  if (format === 3) {
    if (bytes === 4) return (at) => v.getFloat32(at, little);
    if (bytes === 8) return (at) => v.getFloat64(at, little);
    throw new TiffError(`${bytes * 8}-bit floating point TIFF samples are not supported`);
  }
  const signed = format === 2;
  switch (bytes) {
    case 1:
      return signed ? (at) => v.getInt8(at) : (at) => v.getUint8(at);
    case 2:
      return signed ? (at) => v.getInt16(at, little) : (at) => v.getUint16(at, little);
    case 4:
      return signed ? (at) => v.getInt32(at, little) : (at) => v.getUint32(at, little);
    default:
      throw new TiffError(`${bytes * 8}-bit integer TIFF samples are not supported`);
  }
}

function floatPredictor(data: Uint8Array, samples: number, bytes: number, rows: number, spp: number): void {
  const rowBytes = samples * bytes;
  const copy = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const row = data.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = spp; i < rowBytes; i++) row[i] = (row[i]! + row[i - spp]!) & 255;
    copy.set(row);
    for (let s = 0; s < samples; s++) {
      for (let b = 0; b < bytes; b++) row[s * bytes + b] = copy[b * samples + s]!;
    }
  }
}

async function decompress(raw: Uint8Array, compression: number, expected: number): Promise<Uint8Array> {
  switch (compression) {
    case 1:
      return raw;
    case 8:
    case 32946:
      return inflate(raw);
    case 5:
      return lzw(raw, expected);
    case 32773:
      return packBits(raw, expected);
    default:
      throw new TiffError(
        `TIFF compression ${compression} is not supported. Save the file with deflate, LZW or no compression`,
      );
  }
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function lzw(input: Uint8Array, expected: number): Uint8Array {
  let out = new Uint8Array(Math.max(expected, 1024));
  let length = 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const size = new Int32Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
    size[i] = 1;
  }
  let next = 258;
  let width = 9;
  let previous = -1;
  let bit = 0;
  const total = input.length * 8;
  const emit = (code: number) => {
    const n = size[code]!;
    if (length + n > out.length) {
      const bigger = new Uint8Array(Math.max(out.length * 2, length + n));
      bigger.set(out);
      out = bigger;
    }
    let c = code;
    for (let i = length + n - 1; i >= length; i--) {
      out[i] = suffix[c]!;
      c = prefix[c]!;
    }
    length += n;
  };
  while (bit + width <= total) {
    let code = 0;
    for (let i = 0; i < width; i++) {
      const at = bit + i;
      code = (code << 1) | ((input[at >> 3]! >> (7 - (at & 7))) & 1);
    }
    bit += width;
    if (code === 257) break;
    if (code === 256) {
      next = 258;
      width = 9;
      previous = -1;
      continue;
    }
    if (previous < 0) {
      if (code > 255) throw new TiffError("The LZW data in this TIFF is damaged");
      emit(code);
      previous = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = previous;
        suffix[next] = first[code]!;
        first[next] = first[previous]!;
        size[next] = size[previous]! + 1;
        next++;
      }
    } else if (code === next && next < 4096) {
      prefix[next] = previous;
      suffix[next] = first[previous]!;
      first[next] = first[previous]!;
      size[next] = size[previous]! + 1;
      next++;
      emit(code);
    } else {
      throw new TiffError("The LZW data in this TIFF is damaged");
    }
    previous = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return out.subarray(0, length);
}

export function packBits(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < input.length && o < expected) {
    const n = (input[i++]! << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && i < input.length && o < expected; k++) out[o++] = input[i++]!;
    } else if (n !== -128) {
      const value = input[i++] ?? 0;
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = value;
    }
  }
  return out;
}
