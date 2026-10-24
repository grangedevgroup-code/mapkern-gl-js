import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import * as zlib from "node:zlib";
import { BYTES, Reader, decodeUtf8 } from "../../src/formats/protobuf.ts";

export interface BlobRef {
  offset: number;
  size: number;
  type: string;
}

export type Tags = Record<string, string>;

export interface DenseNodeVisitor {
  node(id: number, lon: number, lat: number, tags: Tags | null): void;
  wantTags: boolean;
}

export interface WayVisitor {
  way(id: number, refs: Float64Array, tags: Tags): void;
}

export interface RelationMember {
  type: 0 | 1 | 2;
  ref: number;
  role: string;
}

export interface RelationVisitor {
  relation(id: number, members: RelationMember[], tags: Tags): void;
}

export interface BlockVisitor {
  nodes?: DenseNodeVisitor;
  ways?: WayVisitor;
  relations?: RelationVisitor;
}

export interface BlockKinds {
  nodes: boolean;
  ways: boolean;
  relations: boolean;
}

export function indexBlobs(path: string): BlobRef[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const refs: BlobRef[] = [];
    const lengthBuf = Buffer.alloc(4);
    let pos = 0;
    while (pos < size) {
      if (readSync(fd, lengthBuf, 0, 4, pos) !== 4) throw new Error(`Truncated blob header length at ${pos}`);
      const headerLength = lengthBuf.readUInt32BE(0);
      if (headerLength > 64 * 1024) throw new Error(`Blob header at ${pos} is too large (${headerLength} bytes)`);
      const header = Buffer.alloc(headerLength);
      if (readSync(fd, header, 0, headerLength, pos + 4) !== headerLength) throw new Error(`Truncated blob header at ${pos}`);
      const r = new Reader(header);
      let type = "";
      let dataSize = 0;
      while (!r.done) {
        const tag = r.tag();
        const field = tag >> 3;
        if (field === 1) type = r.string();
        else if (field === 3) dataSize = r.varint();
        else r.skip(tag & 7);
      }
      if (dataSize <= 0 || dataSize > 64 * 1024 * 1024) throw new Error(`Blob at ${pos} has an invalid size ${dataSize}`);
      refs.push({ offset: pos + 4 + headerLength, size: dataSize, type });
      pos += 4 + headerLength + dataSize;
    }
    return refs;
  } finally {
    closeSync(fd);
  }
}

export function readBlob(fd: number, ref: BlobRef): Uint8Array {
  const buf = Buffer.allocUnsafe(ref.size);
  const n = readSync(fd, buf, 0, ref.size, ref.offset);
  if (n !== ref.size) throw new Error(`Short read at ${ref.offset}`);
  return decodeBlob(buf);
}

export function decodeBlob(blob: Uint8Array): Uint8Array {
  const r = new Reader(blob);
  let rawSize = 0;
  while (!r.done) {
    const tag = r.tag();
    const field = tag >> 3;
    switch (field) {
      case 1:
        return r.bytes();
      case 2:
        rawSize = r.varint();
        break;
      case 3:
        return zlib.inflateSync(r.bytes(), rawSize > 0 ? { maxOutputLength: rawSize + 1024 } : {});
      case 7: {
        const data = r.bytes();
        const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Uint8Array) => Buffer }).zstdDecompressSync;
        if (!zstd) throw new Error("This file uses zstd compression, which needs Node.js 23.8 or newer");
        return zstd(data);
      }
      case 4:
        throw new Error("LZMA-compressed OSM blobs are not supported");
      case 6:
        throw new Error("LZ4-compressed OSM blobs are not supported");
      default:
        r.skip(tag & 7);
    }
  }
  throw new Error("Blob has no data");
}

interface BlockContext {
  strings: string[];
  granularity: number;
  latOffset: number;
  lonOffset: number;
}

export function visitBlock(data: Uint8Array, visitor: BlockVisitor): BlockKinds {
  const kinds: BlockKinds = { nodes: false, ways: false, relations: false };
  const r = new Reader(data);
  const ctx: BlockContext = { strings: [], granularity: 100, latOffset: 0, lonOffset: 0 };
  const groups: [number, number][] = [];
  while (!r.done) {
    const tag = r.tag();
    const field = tag >> 3;
    if (field === 1 && (tag & 7) === BYTES) {
      const st = r.sub();
      while (!st.done) {
        const t = st.tag();
        if (t >> 3 === 1) ctx.strings.push(decodeUtf8(st.bytes()));
        else st.skip(t & 7);
      }
    } else if (field === 2 && (tag & 7) === BYTES) {
      const len = r.varint();
      groups.push([r.pos, r.pos + len]);
      r.pos += len;
    } else if (field === 17) {
      ctx.granularity = r.varint();
    } else if (field === 19) {
      ctx.latOffset = r.int64();
    } else if (field === 20) {
      ctx.lonOffset = r.int64();
    } else {
      r.skip(tag & 7);
    }
  }
  for (const [start, end] of groups) {
    const g = new Reader(data, start, end);
    while (!g.done) {
      const tag = g.tag();
      const field = tag >> 3;
      if (field === 2) {
        kinds.nodes = true;
        const sub = g.sub();
        if (visitor.nodes) readDense(sub, ctx, visitor.nodes);
      } else if (field === 1) {
        kinds.nodes = true;
        const sub = g.sub();
        if (visitor.nodes) readNode(sub, ctx, visitor.nodes);
      } else if (field === 3) {
        kinds.ways = true;
        const sub = g.sub();
        if (visitor.ways) readWay(sub, ctx, visitor.ways);
      } else if (field === 4) {
        kinds.relations = true;
        const sub = g.sub();
        if (visitor.relations) readRelation(sub, ctx, visitor.relations);
      } else {
        g.skip(tag & 7);
      }
    }
  }
  return kinds;
}

function toFixed(ctx: BlockContext, raw: number, offset: number): number {
  return Math.round((offset + ctx.granularity * raw) / 100);
}

function readDense(r: Reader, ctx: BlockContext, visitor: DenseNodeVisitor): void {
  let ids: number[] = [];
  let lats: number[] = [];
  let lons: number[] = [];
  let kvStart = -1;
  let kvEnd = -1;
  while (!r.done) {
    const tag = r.tag();
    const field = tag >> 3;
    if (field === 1) ids = packedSigned(r);
    else if (field === 8) lats = packedSigned(r);
    else if (field === 9) lons = packedSigned(r);
    else if (field === 10) {
      kvEnd = r.packedEnd();
      kvStart = r.pos;
      r.pos = kvEnd;
    } else r.skip(tag & 7);
  }
  const kv = kvStart >= 0 ? new Reader(r.buf, kvStart, kvEnd) : null;
  let id = 0;
  let lat = 0;
  let lon = 0;
  const strings = ctx.strings;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i]!;
    lat += lats[i]!;
    lon += lons[i]!;
    let tags: Tags | null = null;
    if (kv && !kv.done) {
      for (;;) {
        const k = kv.varint();
        if (k === 0) break;
        const v = kv.varint();
        if (visitor.wantTags) {
          tags ??= {};
          tags[strings[k]!] = strings[v]!;
        }
        if (kv.done) break;
      }
    }
    visitor.node(id, toFixed(ctx, lon, ctx.lonOffset), toFixed(ctx, lat, ctx.latOffset), tags);
  }
}

function readNode(r: Reader, ctx: BlockContext, visitor: DenseNodeVisitor): void {
  let id = 0;
  let lat = 0;
  let lon = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  while (!r.done) {
    const tag = r.tag();
    const field = tag >> 3;
    if (field === 1) id = r.svarint();
    else if (field === 2) keys = packedUnsigned(r);
    else if (field === 3) vals = packedUnsigned(r);
    else if (field === 8) lat = r.svarint();
    else if (field === 9) lon = r.svarint();
    else r.skip(tag & 7);
  }
  const tags = keys.length > 0 && visitor.wantTags ? makeTags(ctx.strings, keys, vals) : null;
  visitor.node(id, toFixed(ctx, lon, ctx.lonOffset), toFixed(ctx, lat, ctx.latOffset), tags);
}

function readWay(r: Reader, ctx: BlockContext, visitor: WayVisitor): void {
  let id = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  let refs: Float64Array = new Float64Array(0);
  while (!r.done) {
    const tag = r.tag();
    const field = tag >> 3;
    if (field === 1) id = r.varint();
    else if (field === 2) keys = packedUnsigned(r);
    else if (field === 3) vals = packedUnsigned(r);
    else if (field === 8) {
      const end = r.packedEnd();
      const out: number[] = [];
      let ref = 0;
      while (r.pos < end) {
        ref += r.svarint();
        out.push(ref);
      }
      refs = Float64Array.from(out);
    } else r.skip(tag & 7);
  }
  visitor.way(id, refs, makeTags(ctx.strings, keys, vals));
}

function readRelation(r: Reader, ctx: BlockContext, visitor: RelationVisitor): void {
  let id = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  let roles: number[] = [];
  let memids: number[] = [];
  let types: number[] = [];
  while (!r.done) {
    const tag = r.tag();
    const field = tag >> 3;
    if (field === 1) id = r.varint();
    else if (field === 2) keys = packedUnsigned(r);
    else if (field === 3) vals = packedUnsigned(r);
    else if (field === 8) roles = packedUnsigned(r);
    else if (field === 9) memids = packedSigned(r);
    else if (field === 10) types = packedUnsigned(r);
    else r.skip(tag & 7);
  }
  const members: RelationMember[] = [];
  let ref = 0;
  for (let i = 0; i < memids.length; i++) {
    ref += memids[i]!;
    const t = types[i] ?? 0;
    members.push({ type: (t === 1 ? 1 : t === 2 ? 2 : 0) as 0 | 1 | 2, ref, role: ctx.strings[roles[i] ?? 0] ?? "" });
  }
  visitor.relation(id, members, makeTags(ctx.strings, keys, vals));
}

function makeTags(strings: string[], keys: number[], vals: number[]): Tags {
  const tags: Tags = {};
  for (let i = 0; i < keys.length; i++) tags[strings[keys[i]!]!] = strings[vals[i]!] ?? "";
  return tags;
}

function packedSigned(r: Reader): number[] {
  const end = r.packedEnd();
  const out: number[] = [];
  while (r.pos < end) out.push(r.svarint());
  return out;
}

function packedUnsigned(r: Reader): number[] {
  const end = r.packedEnd();
  const out: number[] = [];
  while (r.pos < end) out.push(r.varint());
  return out;
}
