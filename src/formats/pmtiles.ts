import { Reader, Writer } from "./protobuf.ts";

export const HEADER_SIZE = 127;
export const ROOT_LIMIT = 16384;

export const Compression = { unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4 } as const;
export const TileType = { unknown: 0, mvt: 1, png: 2, jpeg: 3, webp: 4, avif: 5, mlt: 6 } as const;

export interface Header {
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  leafLength: number;
  dataOffset: number;
  dataLength: number;
  addressedTiles: number;
  tileEntries: number;
  tileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
}

export interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

export class PMTilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PMTilesError";
  }
}

const ZOOM_BASE: number[] = (() => {
  const base = [0];
  for (let z = 1; z <= 32; z++) base.push(base[z - 1]! + 4 ** (z - 1));
  return base;
})();

export function tileId(z: number, x: number, y: number): number {
  if (z > 26) throw new PMTilesError("Zoom levels above 26 are not supported");
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new PMTilesError(`Tile ${z}/${x}/${y} is outside the grid`);
  let d = 0;
  let tx = x;
  let ty = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        tx = n - 1 - tx;
        ty = n - 1 - ty;
      }
      const t = tx;
      tx = ty;
      ty = t;
    }
  }
  return ZOOM_BASE[z]! + d;
}

export function tileCoord(id: number): { z: number; x: number; y: number } {
  let z = 0;
  while (z < 27 && ZOOM_BASE[z + 1]! <= id) z++;
  if (z >= 27) throw new PMTilesError(`Tile id ${id} is too large`);
  const n = 2 ** z;
  let d = id - ZOOM_BASE[z]!;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & Math.floor(d / 2);
    const ry = 1 & (Math.floor(d) ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
    x += s * rx;
    y += s * ry;
    d = Math.floor(d / 4);
  }
  return { z, x, y };
}

function u64(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  if (hi > 0x1fffff) throw new PMTilesError("Offset is larger than 2^53");
  return hi * 0x100000000 + lo;
}

export function readHeader(bytes: Uint8Array): Header {
  if (bytes.length < HEADER_SIZE) throw new PMTilesError("File is too small to be a PMTiles archive");
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== "PMTiles") throw new PMTilesError("Not a PMTiles archive");
  const version = bytes[7];
  if (version !== 3) throw new PMTilesError(`PMTiles version ${version} is not supported (only version 3)`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);
  return {
    rootOffset: u64(v, 8),
    rootLength: u64(v, 16),
    metadataOffset: u64(v, 24),
    metadataLength: u64(v, 32),
    leafOffset: u64(v, 40),
    leafLength: u64(v, 48),
    dataOffset: u64(v, 56),
    dataLength: u64(v, 64),
    addressedTiles: u64(v, 72),
    tileEntries: u64(v, 80),
    tileContents: u64(v, 88),
    clustered: v.getUint8(96) === 1,
    internalCompression: v.getUint8(97),
    tileCompression: v.getUint8(98),
    tileType: v.getUint8(99),
    minZoom: v.getUint8(100),
    maxZoom: v.getUint8(101),
    minLon: v.getInt32(102, true) / 1e7,
    minLat: v.getInt32(106, true) / 1e7,
    maxLon: v.getInt32(110, true) / 1e7,
    maxLat: v.getInt32(114, true) / 1e7,
    centerZoom: v.getUint8(118),
    centerLon: v.getInt32(119, true) / 1e7,
    centerLat: v.getInt32(123, true) / 1e7,
  };
}

export function writeHeader(h: Header): Uint8Array {
  const bytes = new Uint8Array(HEADER_SIZE);
  const v = new DataView(bytes.buffer);
  bytes.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 3], 0);
  const put64 = (offset: number, value: number) => {
    v.setUint32(offset, value % 0x100000000, true);
    v.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
  };
  put64(8, h.rootOffset);
  put64(16, h.rootLength);
  put64(24, h.metadataOffset);
  put64(32, h.metadataLength);
  put64(40, h.leafOffset);
  put64(48, h.leafLength);
  put64(56, h.dataOffset);
  put64(64, h.dataLength);
  put64(72, h.addressedTiles);
  put64(80, h.tileEntries);
  put64(88, h.tileContents);
  v.setUint8(96, h.clustered ? 1 : 0);
  v.setUint8(97, h.internalCompression);
  v.setUint8(98, h.tileCompression);
  v.setUint8(99, h.tileType);
  v.setUint8(100, h.minZoom);
  v.setUint8(101, h.maxZoom);
  v.setInt32(102, Math.round(h.minLon * 1e7), true);
  v.setInt32(106, Math.round(h.minLat * 1e7), true);
  v.setInt32(110, Math.round(h.maxLon * 1e7), true);
  v.setInt32(114, Math.round(h.maxLat * 1e7), true);
  v.setUint8(118, h.centerZoom);
  v.setInt32(119, Math.round(h.centerLon * 1e7), true);
  v.setInt32(123, Math.round(h.centerLat * 1e7), true);
  return bytes;
}

export function decodeDirectory(bytes: Uint8Array): Entry[] {
  const r = new Reader(bytes);
  const n = r.varint();
  if (n > 10_000_000) throw new PMTilesError("Directory has too many entries");
  const entries: Entry[] = new Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last += r.varint();
    entries[i] = { tileId: last, offset: 0, length: 0, runLength: 0 };
  }
  for (let i = 0; i < n; i++) entries[i]!.runLength = r.varint();
  for (let i = 0; i < n; i++) entries[i]!.length = r.varint();
  for (let i = 0; i < n; i++) {
    const value = r.varint();
    const e = entries[i]!;
    if (value === 0 && i > 0) {
      const prev = entries[i - 1]!;
      e.offset = prev.offset + prev.length;
    } else {
      e.offset = value - 1;
    }
  }
  return entries;
}

export function encodeDirectory(entries: readonly Entry[]): Uint8Array {
  const w = new Writer(entries.length * 8 + 16);
  w.varint(entries.length);
  let last = 0;
  for (const e of entries) {
    w.varint(e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) w.varint(e.runLength);
  for (const e of entries) w.varint(e.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const prev = entries[i - 1];
    if (i > 0 && prev && e.offset === prev.offset + prev.length) w.varint(0);
    else w.varint(e.offset + 1);
  }
  return w.finish();
}

export function findEntry(entries: readonly Entry[], id: number): Entry | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const e = entries[mid]!;
    if (e.tileId < id) lo = mid + 1;
    else if (e.tileId > id) hi = mid - 1;
    else return e;
  }
  if (hi >= 0) {
    const e = entries[hi]!;
    if (e.runLength === 0) return e;
    if (id - e.tileId < e.runLength) return e;
  }
  return null;
}
