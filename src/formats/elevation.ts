import { blocksAcross, readBlock, readTiff } from "./tiff.ts";
import { isZip, readZipEntry, zipEntries } from "./zip.ts";

export class ElevationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevationError";
  }
}

export interface ElevationGrid {
  columns: number;
  rows: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  values: Float32Array;
}

export function gridBounds(g: ElevationGrid): [number, number, number, number] {
  return [
    g.x0 - g.dx / 2,
    g.y0 - (g.rows - 1) * g.dy - g.dy / 2,
    g.x0 + (g.columns - 1) * g.dx + g.dx / 2,
    g.y0 + g.dy / 2,
  ];
}

export function sampleGrid(g: ElevationGrid, lon: number, lat: number): number {
  const fx = (lon - g.x0) / g.dx;
  const fy = (g.y0 - lat) / g.dy;
  if (fx < -0.5 || fy < -0.5 || fx > g.columns - 0.5 || fy > g.rows - 0.5) return Number.NaN;
  const cx = Math.min(Math.max(fx, 0), g.columns - 1);
  const cy = Math.min(Math.max(fy, 0), g.rows - 1);
  const i = Math.min(Math.floor(cx), g.columns - 2);
  const j = Math.min(Math.floor(cy), g.rows - 2);
  const tx = cx - i;
  const ty = cy - j;
  const v = g.values;
  const a = v[j * g.columns + i]!;
  const b = v[j * g.columns + i + 1]!;
  const c = v[(j + 1) * g.columns + i]!;
  const d = v[(j + 1) * g.columns + i + 1]!;
  if (!Number.isNaN(a) && !Number.isNaN(b) && !Number.isNaN(c) && !Number.isNaN(d)) {
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  const nearest = [
    [a, (1 - tx) * (1 - ty)],
    [b, tx * (1 - ty)],
    [c, (1 - tx) * ty],
    [d, tx * ty],
  ].filter(([value]) => !Number.isNaN(value!));
  if (nearest.length === 0) return Number.NaN;
  nearest.sort((p, q) => q[1]! - p[1]!);
  return nearest[0]![0]!;
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function isDted(bytes: Uint8Array): boolean {
  return bytes.length > 3428 && text(bytes, 0, 4) === "UHL1";
}

function dtedAngle(value: string): number {
  const m = /^\s*(\d{3})(\d{2})(\d{2})([NSEW])/.exec(value);
  if (!m) throw new ElevationError(`The DTED header has an unreadable position "${value}"`);
  const angle = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  return m[4] === "W" || m[4] === "S" ? -angle : angle;
}

export function readDted(bytes: Uint8Array): ElevationGrid {
  if (!isDted(bytes)) throw new ElevationError("The file is not a DTED cell");
  const lon0 = dtedAngle(text(bytes, 4, 8));
  const lat0 = dtedAngle(text(bytes, 12, 8));
  const dx = Number(text(bytes, 20, 4)) / 36000;
  const dy = Number(text(bytes, 24, 4)) / 36000;
  const columns = Number(text(bytes, 47, 4));
  const rows = Number(text(bytes, 51, 4));
  if (!(dx > 0 && dy > 0 && columns >= 2 && rows >= 2))
    throw new ElevationError("The DTED header has no usable grid size");
  const record = 8 + rows * 2 + 4;
  if (3428 + columns * record > bytes.length) throw new ElevationError("The DTED cell is shorter than its header says");
  const values = new Float32Array(columns * rows).fill(Number.NaN);
  for (let c = 0; c < columns; c++) {
    const p = 3428 + c * record;
    if (bytes[p] !== 0xaa) throw new ElevationError(`DTED data record ${c + 1} is damaged`);
    const column = (bytes[p + 4]! << 8) | bytes[p + 5]!;
    if (column >= columns) continue;
    for (let r = 0; r < rows; r++) {
      const q = p + 8 + r * 2;
      const raw = (bytes[q]! << 8) | bytes[q + 1]!;
      const value = raw & 0x8000 ? -(raw & 0x7fff) : raw;
      values[(rows - 1 - r) * columns + column] = value <= -32767 ? Number.NaN : value;
    }
  }
  return { columns, rows, x0: lon0, y0: lat0 + (rows - 1) * dy, dx, dy, values };
}

const HGT_NAME = /([NS])(\d{1,2})([EW])(\d{1,3})/i;

export function readHgt(bytes: Uint8Array, name: string): ElevationGrid {
  const file = name.split(/[\\/]/).pop() ?? "";
  const m = HGT_NAME.exec(file);
  if (!m) throw new ElevationError(`The .hgt file name "${file}" does not say where it is, like N47W123.hgt`);
  const n = Math.round(Math.sqrt(bytes.length / 2));
  if (n < 2 || n * n * 2 !== bytes.length) throw new ElevationError("The .hgt file is not a square grid of heights");
  const lat0 = Number(m[2]) * (m[1]!.toUpperCase() === "S" ? -1 : 1);
  const lon0 = Number(m[4]) * (m[3]!.toUpperCase() === "W" ? -1 : 1);
  const values = new Float32Array(n * n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n * n; i++) {
    const v = view.getInt16(i * 2, false);
    values[i] = v === -32768 ? Number.NaN : v;
  }
  return { columns: n, rows: n, x0: lon0, y0: lat0 + 1, dx: 1 / (n - 1), dy: 1 / (n - 1), values };
}

export async function readGeoTiffDem(bytes: Uint8Array): Promise<ElevationGrid> {
  const source = {
    size: bytes.length,
    read: (offset: number, length: number) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
  const [image] = await readTiff(source);
  if (!image) throw new ElevationError("The TIFF file has no image");
  const geo = image.geo;
  if (!geo) throw new ElevationError("The TIFF file has no position on the earth");
  if (!geo.geographic) {
    throw new ElevationError("Only GeoTIFF elevation in longitude and latitude (EPSG:4326) is supported here");
  }
  const [t0, t1, t2, t3, t4, t5] = geo.transform;
  if (t2 !== 0 || t4 !== 0) throw new ElevationError("Rotated GeoTIFF grids are not supported");
  const { width, height, blockWidth, blockHeight } = image;
  const values = new Float32Array(width * height);
  const across = blocksAcross(image);
  for (let index = 0; index < image.offsets.length; index++) {
    const block = await readBlock(source, image, index);
    const bx = (index % across) * blockWidth;
    const by = Math.floor(index / across) * blockHeight;
    for (let y = 0; y < blockHeight && by + y < height; y++) {
      for (let x = 0; x < blockWidth && bx + x < width; x++) {
        const v = block[y * blockWidth + x]!;
        values[(by + y) * width + bx + x] =
          v === image.noData || !Number.isFinite(v) || v < -11000 ? Number.NaN : v * geo.verticalUnit;
      }
    }
  }
  return { columns: width, rows: height, x0: t0 + t1 / 2, y0: t3 + t5 / 2, dx: t1, dy: -t5, values };
}

const DTED_EXT = /\.dt[0-3]$/i;

export async function readElevationFile(bytes: Uint8Array, name = ""): Promise<ElevationGrid[]> {
  if (isZip(bytes)) {
    const grids: ElevationGrid[] = [];
    for (const entry of zipEntries(bytes)) {
      if (entry.name.endsWith("/") || /(^|\/)__MACOSX\//.test(entry.name)) continue;
      if (!/\.(hgt|dt[0-3]|tiff?)$/i.test(entry.name)) continue;
      grids.push(...(await readElevationFile(await readZipEntry(bytes, entry), entry.name)));
    }
    if (grids.length === 0) throw new ElevationError("The ZIP file has no DTED, .hgt or GeoTIFF elevation in it");
    return grids;
  }
  if (isDted(bytes) || DTED_EXT.test(name)) return [readDted(bytes)];
  if (/\.hgt$/i.test(name)) return [readHgt(bytes, name)];
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
    return [await readGeoTiffDem(bytes)];
  }
  throw new ElevationError(`"${name || "The file"}" is not a DTED cell, an SRTM .hgt tile or a GeoTIFF`);
}
