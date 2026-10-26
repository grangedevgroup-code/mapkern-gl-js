import type { SearchMeta } from "./format.ts";
import {
  CATEGORY_WORD,
  CONTEXT_BLOCK,
  CONTEXT_WORD,
  ENTRY_BLOCK,
  encoder,
  HEAD,
  HEADER_SIZE,
  hilbert,
  INLINE_POSTINGS,
  MAGIC,
  POSTING_CHUNK,
  PREFIX_TOP,
  quantize,
  SEARCH_KINDS,
  SECTIONS,
  SUMMARY_CHUNK,
  VERSION,
  Writer,
  writeEntry,
} from "./format.ts";
import { categoryWords, isNumber, tokenize } from "./text.ts";

export interface IndexEntry {
  osm: number;
  kind: number;
  rank: number;
  category: string | null;
  name: string;
  number: string | null;
  street: string | null;
  context: string;
  lon: number;
  lat: number;
  shape: ArrayLike<number>[] | null;
  tokens: Set<string>;
}

export interface WriteOptions {
  bbox: [number, number, number, number];
  compress: (bytes: Uint8Array) => Uint8Array;
  attribution?: string;
  log?: (message: string) => void;
}

const TERMS_PER_BLOCK = 256;
const TERM_BLOCK_BYTES = 64 * 1024;
const PREFIX_TOPS = 32;

export function writeSearchFile(input: IndexEntry[], options: WriteOptions): Uint8Array {
  const log = options.log ?? (() => undefined);
  const compress = options.compress;
  const keys = input.map((e) => hilbert(e.lon, e.lat));
  const order = input.map((_, i) => i).sort((a, b) => keys[a]! - keys[b]! || input[a]!.osm - input[b]!.osm);
  const entries = order.map((i) => input[i]!);
  const n = entries.length;

  const categories: string[] = [];
  const categoryIds = new Map<string, number>();
  const contexts: string[] = [];
  const contextIds = new Map<string, number>();
  const contextWords = new Map<string, string[]>();
  const categoryTerms = new Map<string, string[]>();
  const postings = new Map<string, number[]>();
  const tops = new Map<string, number[]>();
  const add = (term: string, id: number) => {
    const list = postings.get(term);
    if (!list) postings.set(term, [id]);
    else if (list[list.length - 1] !== id) list.push(id);
  };
  const offerTop = (prefix: string, id: number) => {
    const list = tops.get(prefix);
    const rank = entries[id]!.rank;
    if (!list) {
      tops.set(prefix, [id]);
      return;
    }
    if (list[list.length - 1] === id) return;
    if (list.length >= PREFIX_TOPS && entries[list[list.length - 1]!]!.rank >= rank) return;
    let at = list.length;
    while (at > 0 && entries[list[at - 1]!]!.rank < rank) at--;
    list.splice(at, 0, id);
    if (list.length > PREFIX_TOPS) list.pop();
  };

  for (let id = 0; id < n; id++) {
    const e = entries[id]!;
    for (const t of e.tokens) add(t, id);
    if (e.context) {
      let words = contextWords.get(e.context);
      if (!words) {
        words = [...new Set(tokenize(e.context))];
        contextWords.set(e.context, words);
        contextIds.set(e.context, contexts.length + 1);
        contexts.push(e.context);
      }
      for (const w of words) add(CONTEXT_WORD + w, id);
    }
    if (e.category) {
      let words = categoryTerms.get(e.category);
      if (!words) {
        words = categoryWords(e.category).map((w) => CATEGORY_WORD + w);
        categoryTerms.set(e.category, words);
        categoryIds.set(e.category, categories.length + 1);
        categories.push(e.category);
      }
      for (const w of words) add(w, id);
    }
    for (const t of tokenize(e.name)) {
      if (isNumber(t)) continue;
      for (let k = 1; k <= Math.min(3, t.length); k++) offerTop(t.slice(0, k), id);
    }
  }
  for (const [prefix, ids] of tops)
    postings.set(
      PREFIX_TOP + prefix,
      [...ids].sort((a, b) => a - b),
    );
  log(`search terms: ${postings.size.toLocaleString()}, contexts: ${contexts.length.toLocaleString()}`);

  const chunks: Uint8Array[] = [];
  let offset = HEADER_SIZE;
  const put = (bytes: Uint8Array): [number, number] => {
    chunks.push(bytes);
    const at = offset;
    offset += bytes.length;
    return [at, bytes.length];
  };

  const entryDir = new Writer();
  entryDir.varint(Math.ceil(n / ENTRY_BLOCK));
  for (let start = 0; start < n; start += ENTRY_BLOCK) {
    const w = new Writer();
    const prev = { lon: 0, lat: 0 };
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    const end = Math.min(n, start + ENTRY_BLOCK);
    for (let id = start; id < end; id++) {
      const e = entries[id]!;
      const shape = e.shape ? e.shape.map((p) => Array.from(p)) : null;
      writeEntry(
        w,
        {
          kind: e.kind,
          rank: e.rank,
          category: e.category ? categoryIds.get(e.category)! : 0,
          osm: e.osm,
          name: e.name,
          number: e.number ?? "",
          street: e.street ?? "",
          context: e.context ? contextIds.get(e.context)! : 0,
          lon: e.lon,
          lat: e.lat,
          shape,
        },
        prev,
      );
      const points = shape ? shape.flat() : [];
      points.push(e.lon, e.lat);
      for (let k = 0; k < points.length; k += 2) {
        x0 = Math.min(x0, points[k]!);
        x1 = Math.max(x1, points[k]!);
        y0 = Math.min(y0, points[k + 1]!);
        y1 = Math.max(y1, points[k + 1]!);
      }
    }
    const [at, length] = put(compress(w.finish()));
    entryDir.varint(at);
    entryDir.varint(length);
    entryDir.signed(Math.floor(x0 * 1e5));
    entryDir.signed(Math.floor(y0 * 1e5));
    entryDir.signed(Math.ceil(x1 * 1e5));
    entryDir.signed(Math.ceil(y1 * 1e5));
  }

  const summaryDir = new Writer();
  summaryDir.varint(Math.ceil(n / SUMMARY_CHUNK));
  for (let start = 0; start < n; start += SUMMARY_CHUNK) {
    const end = Math.min(n, start + SUMMARY_CHUNK);
    const raw = new Uint8Array((end - start) * 6);
    for (let id = start; id < end; id++) {
      const e = entries[id]!;
      const [qx, qy] = quantize(e.lon, e.lat);
      const o = (id - start) * 6;
      raw[o] = e.kind;
      raw[o + 1] = e.rank;
      raw[o + 2] = qx & 255;
      raw[o + 3] = qx >> 8;
      raw[o + 4] = qy & 255;
      raw[o + 5] = qy >> 8;
    }
    const [at, length] = put(compress(raw));
    summaryDir.varint(at);
    summaryDir.varint(length);
  }

  const contextDir = new Writer();
  contextDir.varint(Math.ceil(contexts.length / CONTEXT_BLOCK));
  for (let start = 0; start < contexts.length; start += CONTEXT_BLOCK) {
    const w = new Writer();
    const end = Math.min(contexts.length, start + CONTEXT_BLOCK);
    w.varint(end - start);
    for (let i = start; i < end; i++) w.text(contexts[i]!);
    const [at, length] = put(compress(w.finish()));
    contextDir.varint(at);
    contextDir.varint(length);
  }

  const terms = [...postings.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const termDir = new Writer();
  const blocks: { first: string; at: number; length: number }[] = [];
  let blockTerms: string[] = [];
  let blockInfo = new Writer();
  const flush = () => {
    if (blockTerms.length === 0) return;
    const w = new Writer();
    w.varint(blockTerms.length);
    let prev = new Uint8Array(0);
    for (const t of blockTerms) {
      const bytes = encoder.encode(t);
      let shared = 0;
      while (shared < prev.length && shared < bytes.length && prev[shared] === bytes[shared]) shared++;
      w.varint(shared);
      w.varint(bytes.length - shared);
      w.raw(bytes.subarray(shared));
      prev = bytes;
    }
    w.raw(blockInfo.finish());
    const [at, length] = put(compress(w.finish()));
    blocks.push({ first: blockTerms[0]!, at, length });
    blockTerms = [];
    blockInfo = new Writer();
  };
  for (const term of terms) {
    const ids = postings.get(term)!;
    const info = blockInfo;
    info.varint(ids.length);
    if (ids.length > INLINE_POSTINGS) {
      const head = [...ids]
        .sort((a, b) => entries[b]!.rank - entries[a]!.rank || a - b)
        .slice(0, HEAD)
        .sort((a, b) => a - b);
      info.varint(head.length);
      let last = 0;
      for (const id of head) {
        info.varint(id - last);
        last = id;
      }
      const count = Math.ceil(ids.length / POSTING_CHUNK);
      info.varint(count);
      for (let c = 0; c < count; c++) {
        const part = ids.slice(c * POSTING_CHUNK, (c + 1) * POSTING_CHUNK);
        const w = new Writer();
        let prev = 0;
        for (const id of part) {
          w.varint(id - prev);
          prev = id;
        }
        const [at, length] = put(compress(w.finish()));
        info.varint(part[0]!);
        info.varint(part[part.length - 1]!);
        info.varint(at);
        info.varint(length);
      }
    } else {
      info.varint(0);
      let prev = 0;
      for (const id of ids) {
        info.varint(id - prev);
        prev = id;
      }
    }
    blockTerms.push(term);
    if (blockTerms.length >= TERMS_PER_BLOCK || blockInfo.length >= TERM_BLOCK_BYTES) flush();
  }
  flush();
  termDir.varint(blocks.length);
  for (const b of blocks) {
    termDir.text(b.first);
    termDir.varint(b.at);
    termDir.varint(b.length);
  }

  const meta: SearchMeta = {
    version: VERSION,
    bbox: options.bbox,
    entries: n,
    terms: terms.length,
    categories,
  };
  if (options.attribution) meta.attribution = options.attribution;
  const sections = [
    compress(encoder.encode(JSON.stringify(meta))),
    compress(termDir.finish()),
    compress(entryDir.finish()),
    compress(summaryDir.finish()),
    compress(contextDir.finish()),
  ];
  const places: [number, number][] = sections.map((s) => put(s));

  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header.set(encoder.encode(MAGIC), 0);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, SECTIONS.length, true);
  places.forEach(([at, length], i) => {
    view.setFloat64(12 + i * 16, at, true);
    view.setFloat64(20 + i * 16, length, true);
  });
  const out = new Uint8Array(offset);
  out.set(header, 0);
  let at = HEADER_SIZE;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  const byKind = SEARCH_KINDS.map((k, i) => `${entries.filter((e) => e.kind === i).length.toLocaleString()} ${k}`);
  log(`search file: ${n.toLocaleString()} entries (${byKind.join(", ")}), ${(out.length / 1e6).toFixed(1)} MB`);
  return out;
}
