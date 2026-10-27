import { inflateSync } from "../formats/inflate.ts";
import type { RangeSource } from "../sources/pmtiles.ts";
import type { EntryRecord, SearchMeta } from "./format.ts";
import { decoder, HEADER_SIZE, MAGIC, Reader, readEntry, SECTIONS, SearchIndexError, VERSION } from "./format.ts";

export interface TermInfo {
  term: string;
  count: number;
  head: Uint32Array;
  ranks: Uint8Array;
  inline: Uint32Array | null;
  chunks: { first: number; last: number; at: number; length: number }[];
}

export class MemoryRangeSource implements RangeSource {
  readonly key: string;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, key = "memory") {
    this.bytes = bytes;
    this.key = key;
  }

  async read(offset: number, length: number): Promise<{ data: Uint8Array }> {
    return { data: this.bytes.subarray(offset, offset + length) };
  }
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return inflateSync(data);
}

const SPAN_GAP = 16 * 1024;
const SPAN_MAX = 4 * 1024 * 1024;

class Cache {
  private readonly items = new Map<string, { value: unknown; size: number }>();
  private size = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get<T>(key: string): T | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    this.items.delete(key);
    this.items.set(key, item);
    return item.value as T;
  }

  set(key: string, value: unknown, size: number): void {
    const old = this.items.get(key);
    if (old) this.size -= old.size;
    this.items.delete(key);
    this.items.set(key, { value, size });
    this.size += size;
    for (const [k, v] of this.items) {
      if (this.size <= this.limit) break;
      this.items.delete(k);
      this.size -= v.size;
    }
  }
}

interface TermBlock {
  terms: string[];
  infos: TermInfo[];
}

export class SearchFile {
  readonly meta: SearchMeta;
  private readonly source: RangeSource;
  private readonly signal = new AbortController().signal;
  private readonly cache: Cache;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly termFirst: string[];
  private readonly termAt: number[];
  private readonly termLength: number[];
  private readonly entryAt: Float64Array;
  private readonly entryLength: Uint32Array;
  readonly entryBox: Float64Array;
  private readonly summaryAt: Float64Array;
  private readonly summaryLength: Uint32Array;
  private readonly contextAt: Float64Array;
  private readonly contextLength: Uint32Array;

  private constructor(source: RangeSource, meta: SearchMeta, sections: Uint8Array[], cacheBytes: number) {
    this.source = source;
    this.meta = meta;
    this.cache = new Cache(cacheBytes);
    const terms = new Reader(sections[1]!);
    const tn = terms.varint();
    this.termFirst = new Array<string>(tn);
    this.termAt = new Array<number>(tn);
    this.termLength = new Array<number>(tn);
    for (let i = 0; i < tn; i++) {
      this.termFirst[i] = terms.text();
      this.termAt[i] = terms.varint();
      this.termLength[i] = terms.varint();
    }
    const entries = new Reader(sections[2]!);
    const en = entries.varint();
    this.entryAt = new Float64Array(en);
    this.entryLength = new Uint32Array(en);
    this.entryBox = new Float64Array(en * 4);
    for (let i = 0; i < en; i++) {
      this.entryAt[i] = entries.varint();
      this.entryLength[i] = entries.varint();
      for (let k = 0; k < 4; k++) this.entryBox[i * 4 + k] = entries.signed() / 1e5;
    }
    [this.summaryAt, this.summaryLength] = offsets(sections[3]!);
    [this.contextAt, this.contextLength] = offsets(sections[4]!);
  }

  static async open(source: RangeSource, cacheBytes = 8 * 1024 * 1024): Promise<SearchFile> {
    const signal = new AbortController().signal;
    const { data: header } = await source.read(0, HEADER_SIZE, signal);
    if (header.length < HEADER_SIZE || decoder.decode(header.subarray(0, 4)) !== MAGIC)
      throw new SearchIndexError("this is not a Mapkern search index");
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const version = view.getUint32(4, true);
    if (version !== VERSION) throw new SearchIndexError(`search index version ${version} is not supported`);
    const places = SECTIONS.map((_, i) => [view.getFloat64(12 + i * 16, true), view.getFloat64(20 + i * 16, true)]);
    const start = Math.min(...places.map(([at]) => at!));
    const end = Math.max(...places.map(([at, length]) => at! + length!));
    const { data: tail } = await source.read(start, end - start, signal);
    if (tail.length < end - start) throw new SearchIndexError("the search index is truncated");
    const sections = await Promise.all(
      places.map(([at, length]) => inflate(tail.subarray(at! - start, at! - start + length!))),
    );
    const meta = JSON.parse(decoder.decode(sections[0]!)) as SearchMeta;
    return new SearchFile(source, meta, sections, cacheBytes);
  }

  get blocks(): number {
    return this.entryAt.length;
  }

  get blockSize(): number {
    return this.meta.entryBlock;
  }

  async term(term: string): Promise<TermInfo | null> {
    const b = this.blockFor(term);
    if (b < 0) return null;
    const block = await this.termBlock(b);
    const i = search(block.terms, term);
    return i >= 0 ? block.infos[i]! : null;
  }

  async range(prefix: string, maxBlocks: number): Promise<{ infos: TermInfo[]; complete: boolean }> {
    const wanted: number[] = [];
    let complete = true;
    for (let b = Math.max(0, this.blockFor(prefix)); b < this.termFirst.length; b++) {
      if (b > 0 && this.termFirst[b]! > prefix && !this.termFirst[b]!.startsWith(prefix)) break;
      if (wanted.length >= maxBlocks) {
        complete = false;
        break;
      }
      wanted.push(b);
    }
    const blocks = await this.batch(
      wanted.map((b) => ({ key: `t${b}`, at: this.termAt[b]!, length: this.termLength[b]! })),
      parseTermBlock,
    );
    const out: TermInfo[] = [];
    for (const block of blocks)
      for (let i = 0; i < block.terms.length; i++) if (block.terms[i]!.startsWith(prefix)) out.push(block.infos[i]!);
    return { infos: out, complete };
  }

  async postings(info: TermInfo, limit = Number.POSITIVE_INFINITY): Promise<Uint32Array> {
    if (info.inline) return info.inline;
    if (info.count > limit) return info.head;
    const parts = await this.batch(
      info.chunks.map((c) => ({ key: `p${c.at}`, at: c.at, length: c.length })),
      parsePostings,
    );
    const out = new Uint32Array(info.count);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  async postingsWithin(info: TermInfo, ranges: readonly (readonly [number, number])[]): Promise<number[]> {
    const inside = (id: number) => ranges.some(([a, b]) => id >= a && id < b);
    if (info.inline) return Array.from(info.inline).filter(inside);
    const wanted = info.chunks.filter((c) => ranges.some(([a, b]) => c.first < b && c.last >= a));
    const lists = await this.batch(
      wanted.map((c) => ({ key: `p${c.at}`, at: c.at, length: c.length })),
      parsePostings,
    );
    return lists.flatMap((ids) => Array.from(ids).filter(inside));
  }

  async summaries(ids: ArrayLike<number>): Promise<Map<number, Uint8Array>> {
    const chunks = new Set<number>();
    const size = this.meta.summaryChunk;
    for (let i = 0; i < ids.length; i++) chunks.add(Math.floor(ids[i]! / size));
    const list = [...chunks];
    const loaded = await this.batch(
      list.map((c) => ({ key: `s${c}`, at: this.summaryAt[c]!, length: this.summaryLength[c]! })),
      (bytes) => bytes,
    );
    return new Map(list.map((c, i) => [c, loaded[i]!]));
  }

  async entryBlock(b: number): Promise<EntryRecord[]> {
    return (await this.entryBlocks([b]))[0]!;
  }

  entryBlocks(list: number[]): Promise<EntryRecord[][]> {
    return this.batch(
      list.map((b) => ({ key: `e${b}`, at: this.entryAt[b]!, length: this.entryLength[b]! })),
      parseEntries,
    );
  }

  async entry(id: number): Promise<EntryRecord> {
    const block = await this.entryBlock(Math.floor(id / this.meta.entryBlock));
    const e = block[id % this.meta.entryBlock];
    if (!e) throw new SearchIndexError("the search index is damaged");
    return e;
  }

  async context(id: number): Promise<string> {
    if (id === 0) return "";
    const b = Math.floor((id - 1) / this.meta.contextBlock);
    const list = await this.load(`c${b}`, async () => {
      const r = new Reader(await this.bytes(this.contextAt[b]!, this.contextLength[b]!));
      const n = r.varint();
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push(r.text());
      return out;
    });
    return list[(id - 1) % this.meta.contextBlock] ?? "";
  }

  private blockFor(term: string): number {
    let lo = 0;
    let hi = this.termFirst.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.termFirst[mid]! <= term) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  private termBlock(b: number): Promise<TermBlock> {
    return this.load(`t${b}`, async () => parseTermBlock(await this.bytes(this.termAt[b]!, this.termLength[b]!)));
  }

  private batch<T>(
    items: { key: string; at: number; length: number }[],
    parse: (bytes: Uint8Array) => T,
  ): Promise<T[]> {
    const missing = items
      .filter((it) => this.cache.get(it.key) === undefined && !this.pending.has(it.key))
      .sort((a, b) => a.at - b.at);
    const groups: (typeof missing)[] = [];
    for (const it of missing) {
      const group = groups[groups.length - 1];
      const last = group?.[group.length - 1];
      if (group && last && it.at - (last.at + last.length) <= SPAN_GAP && it.at + it.length - group[0]!.at <= SPAN_MAX)
        group.push(it);
      else groups.push([it]);
    }
    for (const group of groups) {
      const start = group[0]!.at;
      const end = group[group.length - 1]!.at + group[group.length - 1]!.length;
      const span = this.source.read(start, end - start, this.signal).then(({ data }) => {
        if (data.length < end - start) throw new SearchIndexError("the search index is truncated");
        return data;
      });
      for (const it of group) {
        const job = span
          .then(async (data) => parse(await inflate(data.subarray(it.at - start, it.at - start + it.length))))
          .then(
            (value) => {
              this.pending.delete(it.key);
              this.cache.set(it.key, value, sizeOf(value));
              return value;
            },
            (error: unknown) => {
              this.pending.delete(it.key);
              throw error;
            },
          );
        this.pending.set(it.key, job);
      }
    }
    return Promise.all(items.map((it) => this.load(it.key, async () => parse(await this.bytes(it.at, it.length)))));
  }

  private async bytes(at: number, length: number): Promise<Uint8Array> {
    const { data } = await this.source.read(at, length, this.signal);
    if (data.length < length) throw new SearchIndexError("the search index is truncated");
    return inflate(data);
  }

  private load<T>(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const waiting = this.pending.get(key) as Promise<T> | undefined;
    if (waiting) return waiting;
    const job = make().then(
      (value) => {
        this.pending.delete(key);
        this.cache.set(key, value, sizeOf(value));
        return value;
      },
      (error: unknown) => {
        this.pending.delete(key);
        throw error;
      },
    );
    this.pending.set(key, job);
    return job;
  }
}

function parseTermBlock(bytes: Uint8Array): TermBlock {
  const r = new Reader(bytes);
  const n = r.varint();
  const terms: string[] = [];
  let prev = new Uint8Array(0);
  for (let i = 0; i < n; i++) {
    const shared = r.varint();
    const suffix = r.raw(r.varint());
    const bytes = new Uint8Array(shared + suffix.length);
    bytes.set(prev.subarray(0, shared));
    bytes.set(suffix, shared);
    terms.push(decoder.decode(bytes));
    prev = bytes;
  }
  const infos: TermInfo[] = [];
  for (let i = 0; i < n; i++) {
    const count = r.varint();
    const headLength = r.varint();
    if (headLength === 0) {
      const ids = new Uint32Array(count);
      let id = 0;
      for (let k = 0; k < count; k++) {
        id += r.varint();
        ids[k] = id;
      }
      const ranks = r.raw(count).slice();
      infos.push({ term: terms[i]!, count, head: ids, ranks, inline: ids, chunks: [] });
      continue;
    }
    const head = new Uint32Array(headLength);
    let id = 0;
    for (let k = 0; k < headLength; k++) {
      id += r.varint();
      head[k] = id;
    }
    const ranks = r.raw(headLength).slice();
    const chunks: TermInfo["chunks"] = [];
    const c = r.varint();
    for (let k = 0; k < c; k++)
      chunks.push({ first: r.varint(), last: r.varint(), at: r.varint(), length: r.varint() });
    infos.push({ term: terms[i]!, count, head, ranks, inline: null, chunks });
  }
  return { terms, infos };
}

function parseEntries(bytes: Uint8Array): EntryRecord[] {
  const r = new Reader(bytes);
  const prev = { lon: 0, lat: 0 };
  const out: EntryRecord[] = [];
  while (!r.done) out.push(readEntry(r, prev));
  return out;
}

function parsePostings(bytes: Uint8Array): Uint32Array {
  const r = new Reader(bytes);
  const ids: number[] = [];
  let id = 0;
  while (!r.done) {
    id += r.varint();
    ids.push(id);
  }
  return Uint32Array.from(ids);
}

function offsets(bytes: Uint8Array): [Float64Array, Uint32Array] {
  const r = new Reader(bytes);
  const n = r.varint();
  const at = new Float64Array(n);
  const length = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    at[i] = r.varint();
    length[i] = r.varint();
  }
  return [at, length];
}

function search(list: string[], value: string): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = list[mid]!;
    if (v === value) return mid;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function sizeOf(value: unknown): number {
  if (value instanceof Uint8Array || value instanceof Uint32Array) return value.byteLength + 64;
  if (Array.isArray(value)) return value.length * 160 + 64;
  if (value && typeof value === "object" && "terms" in value) return (value as TermBlock).terms.length * 200 + 64;
  return 256;
}
