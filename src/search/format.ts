export const SEARCH_KINDS = ["place", "address", "street", "poi"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const MAGIC = "MKS2";
export const VERSION = 2;
export const ENTRY_BLOCK = 128;
export const SUMMARY_CHUNK = 4096;
export const CONTEXT_BLOCK = 256;
export const POSTING_CHUNK = 4096;
export const INLINE_POSTINGS = 512;
export const HEAD = 64;
export const COORD = 1e6;
export const SECTIONS = ["meta", "terms", "entries", "summaries", "contexts"] as const;
export const HEADER_SIZE = 8 + 4 + SECTIONS.length * 16;

export const CONTEXT_WORD = "\u0001";
export const CATEGORY_WORD = "\u0002";
export const PREFIX_TOP = "\u0003";
export const OTHER_NAME = "\u0004";
export const CODE_WORD = "\u0005";

export class SearchIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchIndexError";
  }
}

export interface SearchMeta {
  version: number;
  bbox: [number, number, number, number];
  entries: number;
  terms: number;
  categories: string[];
  attribution?: string;
}

export interface EntryRecord {
  kind: number;
  rank: number;
  category: number;
  osm: number;
  name: string;
  number: string;
  street: string;
  context: number;
  lon: number;
  lat: number;
  shape: number[][] | null;
}

export class Writer {
  private bytes = new Uint8Array(1024);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  byte(v: number): void {
    this.room(1);
    this.bytes[this.length++] = v;
  }

  varint(value: number): void {
    let v = value;
    this.room(10);
    while (v >= 128) {
      this.bytes[this.length++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.bytes[this.length++] = v;
  }

  signed(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  raw(bytes: Uint8Array): void {
    this.room(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  text(s: string): void {
    const bytes = encoder.encode(s);
    this.varint(bytes.length);
    this.raw(bytes);
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

export class Reader {
  at = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  byte(): number {
    if (this.at >= this.bytes.length) throw new SearchIndexError("the search index is damaged");
    return this.bytes[this.at++]!;
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      result += (b & 127) * scale;
      if (b < 128) return result;
      scale *= 128;
    }
    throw new SearchIndexError("the search index is damaged");
  }

  signed(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  raw(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new SearchIndexError("the search index is damaged");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  text(): string {
    return decoder.decode(this.raw(this.varint()));
  }
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function writeEntry(w: Writer, e: EntryRecord, prev: { lon: number; lat: number }): void {
  w.byte(e.kind);
  w.byte(e.rank);
  w.varint(e.category);
  w.varint(e.osm);
  w.text(e.name);
  w.text(e.number);
  w.text(e.street);
  w.varint(e.context);
  const lon = Math.round(e.lon * COORD);
  const lat = Math.round(e.lat * COORD);
  w.signed(lon - prev.lon);
  w.signed(lat - prev.lat);
  prev.lon = lon;
  prev.lat = lat;
  const parts = e.shape ?? [];
  w.varint(parts.length);
  for (const part of parts) {
    w.varint(part.length / 2);
    let x = lon;
    let y = lat;
    for (let i = 0; i < part.length; i += 2) {
      const px = Math.round(part[i]! * COORD);
      const py = Math.round(part[i + 1]! * COORD);
      w.signed(px - x);
      w.signed(py - y);
      x = px;
      y = py;
    }
  }
}

export function readEntry(r: Reader, prev: { lon: number; lat: number }): EntryRecord {
  const kind = r.byte();
  const rank = r.byte();
  const category = r.varint();
  const osm = r.varint();
  const name = r.text();
  const number = r.text();
  const street = r.text();
  const context = r.varint();
  const lon = prev.lon + r.signed();
  const lat = prev.lat + r.signed();
  prev.lon = lon;
  prev.lat = lat;
  const count = r.varint();
  let shape: number[][] | null = null;
  if (count > 0) {
    shape = [];
    for (let p = 0; p < count; p++) {
      const n = r.varint();
      const part: number[] = [];
      let x = lon;
      let y = lat;
      for (let i = 0; i < n; i++) {
        x += r.signed();
        y += r.signed();
        part.push(x / COORD, y / COORD);
      }
      shape.push(part);
    }
  }
  return { kind, rank, category, osm, name, number, street, context, lon: lon / COORD, lat: lat / COORD, shape };
}

export function quantize(lon: number, lat: number): [number, number] {
  return [
    Math.max(0, Math.min(65535, Math.round(((lon + 180) / 360) * 65535))),
    Math.max(0, Math.min(65535, Math.round(((lat + 90) / 180) * 65535))),
  ];
}

export function unquantize(x: number, y: number): [number, number] {
  return [(x / 65535) * 360 - 180, (y / 65535) * 180 - 90];
}

export function hilbert(lon: number, lat: number): number {
  const n = 65536;
  let x = Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
  let y = Math.max(0, Math.min(n - 1, Math.floor(((lat + 90) / 180) * n)));
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}
