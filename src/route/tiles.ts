export const TILED_MAGIC = 0x54524b4d;
export const TILED_VERSION = 2;
export const MIN_ZOOM = 8;
export const MAX_ZOOM = 14;
export const TILE_EDGES = 6000;
export const OVERVIEW_MIN_ZOOM = 5;
export const OVERVIEW_MAX_ZOOM = 10;
export const OVERVIEW_EDGES = 20000;
export const OVERVIEW_CLASSES = 8;
export const COORD = 1e6;

export interface TiledMeta {
  minZoom: number;
  maxZoom: number;
  bbox: [number, number, number, number];
  tiles: number;
  nodes: number;
  edges: number;
  overview?: { minZoom: number; maxZoom: number; tiles: number };
  attribution?: string;
  created?: string;
}

export interface TileEdge {
  owner: number;
  ownerIndex: number;
  fromTile: number;
  fromLocal: number;
  toTile: number;
  toLocal: number;
  busy?: number;
  farLon: number;
  farLat: number;
  cls: number;
  flags: number;
  speed: number;
  name: string;
  ref: string;
  lon: Float64Array;
  lat: Float64Array;
}

export interface TileRestriction {
  viaTile: number;
  via: number;
  from: number;
  to: number;
  kind: number;
  modes: number;
}

export interface TileData {
  id: number;
  lon: Float64Array;
  lat: Float64Array;
  edges: TileEdge[];
  restrictions: TileRestriction[];
}

export class Writer {
  private buf = new Uint8Array(1024);
  length = 0;

  byte(v: number): void {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }

  uint(v: number): void {
    while (v >= 0x80) {
      this.byte((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.byte(v);
  }

  int(v: number): void {
    this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  bytes(b: Uint8Array): void {
    for (const v of b) this.byte(v);
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export class Reader {
  private readonly buf: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  byte(): number {
    if (this.pos >= this.end) throw new Error("The route tile is cut short");
    return this.buf[this.pos++]!;
  }

  uint(): number {
    let v = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      v += (b & 0x7f) * scale;
      if (b < 0x80) return v;
      scale *= 0x80;
    }
  }

  int(): number {
    const v = this.uint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  slice(length: number): Uint8Array {
    if (this.pos + length > this.end) throw new Error("The route tile is cut short");
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

const Z = 2 ** 28;

export function tileKey(z: number, x: number, y: number): number {
  return z * Z + y * 2 ** z + x;
}

export function keyZXY(key: number): [number, number, number] {
  const z = Math.floor(key / Z);
  const rest = key - z * Z;
  const n = 2 ** z;
  return [z, rest % n, Math.floor(rest / n)];
}

export function keyAt(lon: number, lat: number, z: number): number {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  const y = Math.min(n - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)));
  return tileKey(z, x, y);
}

export function keyBounds(key: number): [number, number, number, number] {
  const [z, x, y] = keyZXY(key);
  const n = 2 ** z;
  const lon = (v: number) => (v / n) * 360 - 180;
  const lat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

const COLUMNS = [
  "nodes",
  "counts",
  "neighbors",
  "ends",
  "owners",
  "far",
  "classes",
  "flags",
  "speeds",
  "names",
  "refs",
  "shapes",
  "restrictions",
  "strings",
] as const;

export type Column = (typeof COLUMNS)[number];

export function packColumns(columns: Record<Column, Writer>): Uint8Array {
  const out = new Writer();
  for (const name of COLUMNS) out.uint(columns[name].length);
  for (const name of COLUMNS) out.bytes(columns[name].done());
  return out.done();
}

export function newColumns(): Record<Column, Writer> {
  return Object.fromEntries(COLUMNS.map((c) => [c, new Writer()])) as Record<Column, Writer>;
}

export function decodeTile(id: number, bytes: Uint8Array): TileData {
  const head = new Reader(bytes);
  const lengths = COLUMNS.map(() => head.uint());
  const col: Partial<Record<Column, Reader>> = {};
  let at = head.pos;
  COLUMNS.forEach((name, i) => {
    col[name] = new Reader(bytes, at, at + lengths[i]!);
    at += lengths[i]!;
  });
  const c = col as Record<Column, Reader>;
  const strings: string[] = [""];
  const text = new TextDecoder();
  const stringCount = c.strings.uint();
  for (let i = 0; i < stringCount; i++) strings.push(text.decode(c.strings.slice(c.strings.uint())));
  const neighbors = [id];
  const neighborCount = c.neighbors.uint();
  let last = 0;
  for (let i = 0; i < neighborCount; i++) {
    last += c.neighbors.uint();
    neighbors.push(last);
  }
  const nodeCount = c.counts.uint();
  const owned = c.counts.uint();
  const foreign = c.counts.uint();
  const restrictionCount = c.counts.uint();
  const lon = new Float64Array(nodeCount);
  const lat = new Float64Array(nodeCount);
  const [w, s] = keyBounds(id);
  let x = Math.round(w * COORD);
  let y = Math.round(s * COORD);
  for (let i = 0; i < nodeCount; i++) {
    x += c.nodes.int();
    y += c.nodes.int();
    lon[i] = x / COORD;
    lat[i] = y / COORD;
  }
  const ref = (r: Reader): [number, number] => {
    const tile = neighbors[r.uint()]!;
    return [tile, r.uint()];
  };
  const edges: TileEdge[] = [];
  let ownedSeen = 0;
  for (let i = 0; i < owned + foreign; i++) {
    const isOwned = i < owned;
    const [fromTile, fromLocal] = ref(c.ends);
    const [toTile, toLocal] = ref(c.ends);
    const ownerIndex = isOwned ? ownedSeen++ : c.owners.uint();
    const owner = fromTile;
    const pts = c.shapes.uint();
    const shapeLon = new Float64Array(pts + 2);
    const shapeLat = new Float64Array(pts + 2);
    const startLon = fromTile === id ? lon[fromLocal]! : 0;
    const startLat = fromTile === id ? lat[fromLocal]! : 0;
    let farLon = Number.NaN;
    let farLat = Number.NaN;
    let sx: number;
    let sy: number;
    if (fromTile === id) {
      sx = Math.round(startLon * COORD);
      sy = Math.round(startLat * COORD);
    } else {
      sx = Math.round(lon[toLocal]! * COORD) + c.far.int();
      sy = Math.round(lat[toLocal]! * COORD) + c.far.int();
      farLon = sx / COORD;
      farLat = sy / COORD;
    }
    shapeLon[0] = sx / COORD;
    shapeLat[0] = sy / COORD;
    for (let k = 1; k <= pts; k++) {
      sx += c.shapes.int();
      sy += c.shapes.int();
      shapeLon[k] = sx / COORD;
      shapeLat[k] = sy / COORD;
    }
    if (toTile === id) {
      shapeLon[pts + 1] = lon[toLocal]!;
      shapeLat[pts + 1] = lat[toLocal]!;
    } else {
      sx += c.far.int();
      sy += c.far.int();
      farLon = sx / COORD;
      farLat = sy / COORD;
      shapeLon[pts + 1] = farLon;
      shapeLat[pts + 1] = farLat;
    }
    edges.push({
      owner,
      ownerIndex,
      fromTile,
      fromLocal,
      toTile,
      toLocal,
      farLon,
      farLat,
      cls: c.classes.byte(),
      flags: c.flags.uint(),
      speed: c.speeds.byte(),
      name: strings[c.names.uint()] ?? "",
      ref: strings[c.refs.uint()] ?? "",
      lon: shapeLon,
      lat: shapeLat,
    });
  }
  const restrictions: TileRestriction[] = [];
  for (let i = 0; i < restrictionCount; i++) {
    restrictions.push({
      viaTile: id,
      via: c.restrictions.uint(),
      from: c.restrictions.uint(),
      to: c.restrictions.uint(),
      kind: c.restrictions.byte(),
      modes: c.restrictions.byte(),
    });
  }
  return { id, lon, lat, edges, restrictions };
}

function columnsOf(bytes: Uint8Array): Record<Column, Reader> {
  const head = new Reader(bytes);
  const lengths = COLUMNS.map(() => head.uint());
  const col: Partial<Record<Column, Reader>> = {};
  let at = head.pos;
  COLUMNS.forEach((name, i) => {
    col[name] = new Reader(bytes, at, at + lengths[i]!);
    at += lengths[i]!;
  });
  return col as Record<Column, Reader>;
}

export function decodeOverviewTile(id: number, bytes: Uint8Array): TileData {
  const c = columnsOf(bytes);
  const strings: string[] = [""];
  const text = new TextDecoder();
  const stringCount = c.strings.uint();
  for (let i = 0; i < stringCount; i++) strings.push(text.decode(c.strings.slice(c.strings.uint())));
  const table: number[] = [];
  const tableCount = c.neighbors.uint();
  let last = 0;
  for (let i = 0; i < tableCount; i++) {
    last += c.neighbors.uint();
    table.push(last);
  }
  const edgeCount = c.counts.uint();
  const restrictionCount = c.counts.uint();
  const [w, s] = keyBounds(id);
  let ox = Math.round(w * COORD);
  let oy = Math.round(s * COORD);
  const edges: TileEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const fromTile = table[c.ends.uint()]!;
    const fromLocal = c.ends.uint();
    const toTile = table[c.ends.uint()]!;
    const toLocal = c.ends.uint();
    const busy = c.ends.uint();
    const ownerIndex = c.owners.uint();
    ox += c.far.int();
    oy += c.far.int();
    const pts = c.shapes.uint();
    const lon = new Float64Array(pts + 2);
    const lat = new Float64Array(pts + 2);
    let sx = ox;
    let sy = oy;
    lon[0] = sx / COORD;
    lat[0] = sy / COORD;
    for (let k = 1; k <= pts; k++) {
      sx += c.shapes.int();
      sy += c.shapes.int();
      lon[k] = sx / COORD;
      lat[k] = sy / COORD;
    }
    sx += c.far.int();
    sy += c.far.int();
    lon[pts + 1] = sx / COORD;
    lat[pts + 1] = sy / COORD;
    edges.push({
      owner: fromTile,
      ownerIndex,
      busy,
      fromTile,
      fromLocal,
      toTile,
      toLocal,
      farLon: Number.NaN,
      farLat: Number.NaN,
      cls: c.classes.byte(),
      flags: c.flags.uint(),
      speed: c.speeds.byte(),
      name: strings[c.names.uint()] ?? "",
      ref: strings[c.refs.uint()] ?? "",
      lon,
      lat,
    });
  }
  const restrictions: TileRestriction[] = [];
  for (let i = 0; i < restrictionCount; i++) {
    restrictions.push({
      viaTile: table[c.restrictions.uint()]!,
      via: c.restrictions.uint(),
      from: c.restrictions.uint(),
      to: c.restrictions.uint(),
      kind: c.restrictions.byte(),
      modes: c.restrictions.byte(),
    });
  }
  return { id, lon: new Float64Array(0), lat: new Float64Array(0), edges, restrictions };
}

const Q_ZOOM = 16;

export function quadStart(key: number): number {
  const [z, x, y] = keyZXY(key);
  let q = 0;
  for (let i = z - 1; i >= 0; i--) {
    const bx = Math.floor(x / 2 ** i) % 2;
    const by = Math.floor(y / 2 ** i) % 2;
    q = q * 4 + by * 2 + bx;
  }
  return q * 4 ** (Q_ZOOM - z);
}

export function keyFromQuad(start: number, z: number): number {
  let q = Math.floor(start / 4 ** (Q_ZOOM - z));
  let x = 0;
  let y = 0;
  for (let i = 0; i < z; i++) {
    const d = q % 4;
    x += (d % 2) * 2 ** i;
    y += Math.floor(d / 2) * 2 ** i;
    q = Math.floor(q / 4);
  }
  return tileKey(z, x, y);
}

export interface DirectoryEntry {
  key: number;
  offset: number;
  length: number;
}

export function encodeDirectory(entries: { key: number; length: number }[]): Uint8Array {
  const sorted = entries.slice().sort((a, b) => quadStart(a.key) - quadStart(b.key));
  const w = new Writer();
  w.uint(sorted.length);
  let last = 0;
  for (const e of sorted) {
    const q = quadStart(e.key);
    w.uint(q - last);
    last = q;
    w.uint(keyZXY(e.key)[0]);
    w.uint(e.length);
  }
  return w.done();
}

export function decodeDirectory(bytes: Uint8Array, base: number): DirectoryEntry[] {
  const r = new Reader(bytes);
  const count = r.uint();
  const out: DirectoryEntry[] = [];
  let q = 0;
  let offset = base;
  for (let i = 0; i < count; i++) {
    q += r.uint();
    const z = r.uint();
    const length = r.uint();
    out.push({ key: keyFromQuad(q, z), offset, length });
    offset += length;
  }
  return out;
}
