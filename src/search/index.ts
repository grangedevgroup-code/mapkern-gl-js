import type { RangeSource } from "../sources/pmtiles.ts";
import { BlobRangeSource, HttpRangeSource } from "../sources/pmtiles.ts";
import type { TermInfo } from "./file.ts";
import { MemoryRangeSource, SearchFile } from "./file.ts";
import type { EntryRecord, SearchKind } from "./format.ts";
import {
  CATEGORY_WORD,
  CONTEXT_WORD,
  ENTRY_BLOCK,
  PREFIX_TOP,
  SEARCH_KINDS,
  SUMMARY_CHUNK,
  unquantize,
} from "./format.ts";
import { expandPrefix, isNumber, tokenize, withinEdits } from "./text.ts";

export interface SearchResult {
  id: number;
  osm: string | null;
  kind: SearchKind;
  name: string;
  label: string;
  context: string;
  category: string | null;
  center: [number, number];
  zoom: number;
  address?: { number: string; street: string };
  distance?: number;
  score: number;
}

export interface SearchOptions {
  near?: [number, number];
  bbox?: [number, number, number, number];
  kinds?: readonly SearchKind[];
  limit?: number;
  autocomplete?: boolean;
}

export interface ReverseOptions {
  kinds?: readonly SearchKind[];
  limit?: number;
  radius?: number;
}

export interface Geocoder {
  search(query: string, options?: SearchOptions): SearchResult[] | Promise<SearchResult[]>;
  reverse?(position: [number, number], options?: ReverseOptions): SearchResult[] | Promise<SearchResult[]>;
}

export type SearchIndexSource = string | URL | Blob | ArrayBuffer | Uint8Array;

export interface SearchIndexOptions {
  cacheBytes?: number;
  headers?: Record<string, string>;
}

const KIND_ZOOM: Record<SearchKind, number> = { place: 12, address: 18, street: 16, poi: 17 };
const PLACE_ZOOM: Record<string, number> = {
  country: 5,
  state: 7,
  region: 7,
  province: 7,
  county: 9,
  district: 10,
  municipality: 11,
  city: 11,
  town: 13,
  village: 14,
  suburb: 14,
  borough: 13,
  quarter: 15,
  neighbourhood: 15,
  hamlet: 15,
  locality: 15,
  island: 12,
  archipelago: 8,
  islet: 15,
};
const REVERSE_RADIUS: Record<SearchKind, number> = { address: 100, poi: 80, street: 300, place: 20000 };
const REVERSE_ORDER: SearchKind[] = ["address", "poi", "street", "place"];
const PLACE_REACH: Record<string, number> = {
  city: 15000,
  town: 8000,
  borough: 4000,
  village: 4000,
  suburb: 2000,
  hamlet: 2000,
  quarter: 1500,
  locality: 1500,
  neighbourhood: 1000,
};
const POSTING_LIMIT = 200_000;
const CANDIDATE_LIMIT = 30_000;
const PREFIX_BLOCKS = 4;
const TYPO_BLOCKS = 16;
const OSM_TYPES = ["node", "way", "relation"];

interface Match {
  ids: Uint32Array;
  quality: number;
  direct: boolean;
}

interface Candidate {
  id: number;
  text: number;
  missing: number;
}

interface Ranked {
  id: number;
  score: number;
  distance: number | undefined;
}

export class SearchIndex implements Geocoder {
  readonly bbox: [number, number, number, number];
  readonly size: number;
  private readonly file: SearchFile;

  private constructor(file: SearchFile) {
    this.file = file;
    this.bbox = file.meta.bbox;
    this.size = file.meta.entries;
  }

  static async load(source: SearchIndexSource, options: SearchIndexOptions = {}): Promise<SearchIndex> {
    return new SearchIndex(await SearchFile.open(rangeSource(source, options), options.cacheBytes));
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const limit = Math.max(1, options.limit ?? 8);
    const prefixLast = (options.autocomplete ?? true) && !/\s$/.test(query);
    const matches = await Promise.all(tokens.map((t, i) => this.match(t, prefixLast && i === tokens.length - 1)));
    const wanted = options.kinds ?? (prefixLast && tokens.length === 1 && tokens[0]!.length === 1 ? ["place"] : null);
    const kinds = wanted ? new Set(wanted.map((k) => SEARCH_KINDS.indexOf(k))) : null;
    let candidates: Candidate[] = [];
    for (const allowMissing of tokens.length >= 3 ? [0, 1] : [0]) {
      candidates = this.combine(matches, allowMissing, options.near);
      if (candidates.length > 0) break;
    }
    if (candidates.length === 0) return [];
    const summaries = await this.file.summaries(candidates.map((c) => c.id));
    const ranked: Ranked[] = [];
    for (const c of candidates) {
      const s = summary(summaries, c.id);
      if (kinds && !kinds.has(s.kind)) continue;
      if (options.bbox) {
        const [w, south, e, n] = options.bbox;
        if (s.lon < w - 0.01 || s.lon > e + 0.01 || s.lat < south - 0.01 || s.lat > n + 0.01) continue;
      }
      const distance = options.near ? metres(options.near[0], options.near[1], s.lon, s.lat) : undefined;
      const near = distance === undefined ? 0.5 : 1 / (1 + distance / (5000 * spread(s.rank)));
      const text = c.text / tokens.length;
      ranked.push({ id: c.id, score: text * 0.6 + (s.rank / 255) * 0.2 + near * 0.2 - c.missing * 0.1, distance });
    }
    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, Math.max(limit * 6, 30));
    const records = await Promise.all(top.map((r) => this.file.entry(r.id)));
    const scored: { r: Ranked; e: EntryRecord }[] = [];
    top.forEach((r, i) => {
      const e = records[i]!;
      if (options.bbox) {
        const [w, s, east, n] = options.bbox;
        if (e.lon < w || e.lon > east || e.lat < s || e.lat > n) return;
      }
      const names = tokenize(e.name);
      const cover = names.length ? Math.min(1, tokens.length / names.length) : 1;
      const distance = options.near ? metres(options.near[0], options.near[1], e.lon, e.lat) : undefined;
      scored.push({ r: { id: r.id, score: r.score + cover * 0.15, distance }, e });
    });
    scored.sort((a, b) => b.r.score - a.r.score);
    const out: SearchResult[] = [];
    for (const { r, e } of scored) {
      const result = await this.result(r.id, e, r.score, r.distance);
      if (
        out.some(
          (o) => o.kind === result.kind && o.name === result.name && o.context === result.context && close(o, result),
        )
      )
        continue;
      out.push(result);
      if (out.length >= limit) break;
    }
    return out;
  }

  async reverse(position: [number, number], options: ReverseOptions = {}): Promise<SearchResult[]> {
    const kinds = options.kinds ?? REVERSE_ORDER;
    const single = kinds.length === 1;
    const limit = options.limit ?? (single ? 5 : kinds.length);
    const [lon, lat] = position;
    const found = new Map<SearchKind, { id: number; e: EntryRecord; distance: number; order: number }[]>();
    const keep = (kind: SearchKind, id: number, e: EntryRecord, distance: number, order: number) => {
      const list = found.get(kind);
      if (list) list.push({ id, e, distance, order });
      else found.set(kind, [{ id, e, distance, order }]);
    };
    const local: readonly SearchKind[] = kinds.filter((k) => k !== "place");
    if (local.length) {
      const radius = Math.max(...local.map((k) => options.radius ?? REVERSE_RADIUS[k]));
      const blocks = this.blocksNear(lon, lat, radius);
      const loaded = await Promise.all(blocks.map((b) => this.file.entryBlock(b)));
      blocks.forEach((b, n) => {
        loaded[n]!.forEach((e, i) => {
          const kind = SEARCH_KINDS[e.kind]!;
          if (!local.includes(kind)) return;
          const distance = distanceTo(e, lon, lat);
          if (distance <= (options.radius ?? REVERSE_RADIUS[kind]))
            keep(kind, b * ENTRY_BLOCK + i, e, distance, distance);
        });
      });
    }
    if (kinds.includes("place")) {
      const radius = options.radius ?? REVERSE_RADIUS.place;
      const ranges = this.rangesNear(lon, lat, radius);
      const ids = new Set<number>();
      for (const type of Object.keys(PLACE_REACH)) {
        const info = await this.file.term(CATEGORY_WORD + type);
        if (info) for (const id of await this.postingsIn(info, ranges)) ids.add(id);
      }
      const list = [...ids];
      const summaries = await this.file.summaries(list);
      const near = list.filter((id) => {
        const s = summary(summaries, id);
        return SEARCH_KINDS[s.kind] === "place" && metres(lon, lat, s.lon, s.lat) <= radius + 2000;
      });
      const records = await Promise.all(near.map((id) => this.file.entry(id)));
      near.forEach((id, i) => {
        const e = records[i]!;
        const distance = metres(lon, lat, e.lon, e.lat);
        const type = this.category(e);
        const reach = type ? PLACE_REACH[type] : undefined;
        if (distance <= radius && reach !== undefined) keep("place", id, e, distance, distance / reach);
      });
    }
    const out: SearchResult[] = [];
    for (const kind of REVERSE_ORDER) {
      const list = found.get(kind);
      if (!list) continue;
      list.sort((a, b) => a.order - b.order || b.e.rank - a.e.rank);
      for (const { id, e, distance } of list.slice(0, single ? limit : 1))
        out.push(await this.result(id, e, 1, distance));
    }
    return out.slice(0, limit);
  }

  private async match(token: string, prefix: boolean): Promise<Match[]> {
    const file = this.file;
    const out: Match[] = [];
    const seen = new Set<string>();
    const add = async (info: TermInfo | null, quality: number, direct: boolean) => {
      if (!info || seen.has(info.term)) return;
      seen.add(info.term);
      out.push({ ids: await file.postings(info, POSTING_LIMIT), quality, direct });
    };
    if (prefix && token.length === 1) {
      await add(await file.term(PREFIX_TOP + token), 0.9, true);
      return out;
    }
    await add(await file.term(token), 1, true);
    if (prefix) {
      if (token.length <= 3) await add(await file.term(PREFIX_TOP + token), 0.9, true);
      else {
        const { infos } = await file.range(token, PREFIX_BLOCKS);
        for (const info of infos) await add(info, 0.85 + 0.1 * (token.length / info.term.length), true);
      }
      for (const short of expandPrefix(token)) await add(await file.term(short), 0.9, true);
    }
    if (!out.some((m) => m.direct) && token.length >= 4 && !isNumber(token)) {
      const limit = token.length >= 8 ? 2 : 1;
      const { infos } = await file.range(token.slice(0, 2), TYPO_BLOCKS);
      for (const info of infos) {
        const t = info.term;
        const edits = withinEdits(token, t, limit, prefix ? Math.min(t.length, token.length) : t.length);
        if (edits > 0) await add(info, edits === 1 ? 0.75 : 0.6, true);
      }
    }
    await add(await file.term(CATEGORY_WORD + token), 0.8, true);
    await add(await file.term(CONTEXT_WORD + token), 0.7, false);
    if (prefix && token.length >= 3) {
      for (const info of (await file.range(CONTEXT_WORD + token, 1)).infos) await add(info, 0.6, false);
      for (const info of (await file.range(CATEGORY_WORD + token, 1)).infos) await add(info, 0.7, true);
    }
    return out;
  }

  private combine(all: Match[][], allowMissing: number, near: [number, number] | undefined): Candidate[] {
    const matches = all.length === 1 ? all.map((list) => list.filter((m) => m.direct)) : all;
    const sizes = matches.map((list) => list.reduce((s, m) => s + m.ids.length, 0));
    const order = sizes
      .map((_, i) => i)
      .filter((i) => sizes[i]! > 0)
      .sort((a, b) => sizes[a]! - sizes[b]!);
    if (order.length === 0 || order.length < matches.length - allowMissing) return [];
    const pool = new Set<number>();
    for (const i of order.slice(0, allowMissing + 1)) for (const m of matches[i]!) for (const id of m.ids) pool.add(id);
    let ids = [...pool];
    if (ids.length > CANDIDATE_LIMIT) ids = this.narrow(ids, near);
    const out: Candidate[] = [];
    for (const id of ids) {
      let text = 0;
      let missing = 0;
      let named = false;
      for (const list of matches) {
        let best = 0;
        let direct = false;
        for (const m of list) {
          if (m.quality <= best && (direct || !m.direct)) continue;
          if (!sortedHas(m.ids, id)) continue;
          if (m.quality > best) best = m.quality;
          if (m.direct) direct = true;
        }
        if (best === 0 && ++missing > allowMissing) break;
        if (direct) named = true;
        text += best;
      }
      if (missing > allowMissing || !named) continue;
      out.push({ id, text, missing });
    }
    return out;
  }

  private narrow(ids: number[], near: [number, number] | undefined): number[] {
    if (!near) return ids.slice(0, CANDIDATE_LIMIT);
    for (const radius of [5000, 25000, 100000, 400000]) {
      const ranges = this.rangesNear(near[0], near[1], radius);
      const kept = ids.filter((id) => inRanges(ranges, id));
      if (kept.length >= 200 || radius === 400000) return kept.slice(0, CANDIDATE_LIMIT);
    }
    return ids.slice(0, CANDIDATE_LIMIT);
  }

  private blocksNear(lon: number, lat: number, radius: number): number[] {
    const dy = radius / 111195;
    const dx = dy / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    const box = this.file.entryBox;
    const out: number[] = [];
    for (let b = 0; b < this.file.blocks; b++) {
      if (
        box[b * 4]! > lon + dx ||
        box[b * 4 + 2]! < lon - dx ||
        box[b * 4 + 1]! > lat + dy ||
        box[b * 4 + 3]! < lat - dy
      )
        continue;
      out.push(b);
    }
    return out;
  }

  private rangesNear(lon: number, lat: number, radius: number): [number, number][] {
    const out: [number, number][] = [];
    for (const b of this.blocksNear(lon, lat, radius)) {
      const last = out[out.length - 1];
      if (last && last[1] === b * ENTRY_BLOCK) last[1] = (b + 1) * ENTRY_BLOCK;
      else out.push([b * ENTRY_BLOCK, (b + 1) * ENTRY_BLOCK]);
    }
    return out;
  }

  private async postingsIn(info: TermInfo, ranges: [number, number][]): Promise<number[]> {
    const ids = info.inline ?? (await this.file.postings(info));
    return Array.from(ids).filter((id) => inRanges(ranges, id));
  }

  private category(e: EntryRecord): string | null {
    const raw = e.category > 0 ? this.file.meta.categories[e.category - 1] : undefined;
    return raw ? raw.slice(raw.indexOf("=") + 1) : null;
  }

  private async result(id: number, e: EntryRecord, score: number, distance: number | undefined): Promise<SearchResult> {
    const kind = SEARCH_KINDS[e.kind]!;
    const context = await this.file.context(e.context);
    const category = this.category(e);
    const zoom = kind === "place" && category ? (PLACE_ZOOM[category] ?? KIND_ZOOM.place) : KIND_ZOOM[kind];
    const r: SearchResult = {
      id,
      osm: e.osm > 0 ? `${OSM_TYPES[e.osm % 4] ?? "node"}/${Math.floor(e.osm / 4)}` : null,
      kind,
      name: e.name,
      label: context ? `${e.name}, ${context}` : e.name,
      context,
      category,
      center: [e.lon, e.lat],
      zoom,
      score: Math.round(score * 1000) / 1000,
    };
    if (e.number) r.address = { number: e.number, street: e.street };
    if (distance !== undefined) r.distance = Math.round(distance);
    return r;
  }
}

export class SearchIndexSet implements Geocoder {
  readonly indexes: SearchIndex[];

  constructor(indexes: SearchIndex[]) {
    this.indexes = indexes;
  }

  static async load(sources: readonly SearchIndexSource[], options: SearchIndexOptions = {}): Promise<SearchIndexSet> {
    const results = await Promise.allSettled(sources.map((s) => SearchIndex.load(s, options)));
    const loaded = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (loaded.length === 0) {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      throw failed ? failed.reason : new Error("There is no search index to load");
    }
    return new SearchIndexSet(loaded);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 8;
    const all = (await Promise.all(this.indexes.map((index) => index.search(query, options)))).flat();
    all.sort((a, b) => b.score - a.score);
    const out: SearchResult[] = [];
    for (const r of all) {
      if (r.osm && out.some((o) => o.osm === r.osm)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  async reverse(position: [number, number], options: ReverseOptions = {}): Promise<SearchResult[]> {
    const all = (await Promise.all(this.indexes.map((index) => index.reverse(position, options)))).flat();
    const kinds = options.kinds ?? REVERSE_ORDER;
    const single = kinds.length === 1;
    const limit = options.limit ?? (single ? 5 : kinds.length);
    const out: SearchResult[] = [];
    for (const kind of REVERSE_ORDER) {
      const list = all.filter((r) => r.kind === kind).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
      const unique = list.filter((r, i) => !r.osm || list.findIndex((o) => o.osm === r.osm) === i);
      out.push(...unique.slice(0, single ? limit : 1));
    }
    return out.slice(0, limit);
  }
}

function rangeSource(source: SearchIndexSource, options: SearchIndexOptions): RangeSource {
  if (source instanceof Uint8Array) return new MemoryRangeSource(source);
  if (source instanceof ArrayBuffer) return new MemoryRangeSource(new Uint8Array(source));
  if (typeof Blob !== "undefined" && source instanceof Blob) return new BlobRangeSource(source, "blob");
  const base = typeof location === "undefined" ? undefined : location.href;
  return new HttpRangeSource(new URL(String(source), base).href, options.headers ?? {});
}

function summary(
  chunks: Map<number, Uint8Array>,
  id: number,
): { kind: number; rank: number; lon: number; lat: number } {
  const chunk = chunks.get(Math.floor(id / SUMMARY_CHUNK))!;
  const o = (id % SUMMARY_CHUNK) * 6;
  const [lon, lat] = unquantize(chunk[o + 2]! | (chunk[o + 3]! << 8), chunk[o + 4]! | (chunk[o + 5]! << 8));
  return { kind: chunk[o]!, rank: chunk[o + 1]!, lon, lat };
}

function spread(rank: number): number {
  return 2 ** Math.max(0, (rank - 100) / 30);
}

function sortedHas(a: Uint32Array, value: number): boolean {
  let lo = 0;
  let hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = a[mid]!;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function inRanges(ranges: [number, number][], id: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [a, b] = ranges[mid]!;
    if (id < a) hi = mid - 1;
    else if (id >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

function distanceTo(e: EntryRecord, lon: number, lat: number): number {
  if (!e.shape) return metres(lon, lat, e.lon, e.lat);
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Number.POSITIVE_INFINITY;
  for (const part of e.shape) {
    for (let v = 0; v < part.length; v += 2) {
      const ax = (part[v]! - lon) * k;
      const ay = part[v + 1]! - lat;
      if (v + 2 >= part.length) {
        best = Math.min(best, ax * ax + ay * ay);
        continue;
      }
      const bx = (part[v + 2]! - lon) * k;
      const by = part[v + 3]! - lat;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const x = ax + dx * t;
      const y = ay + dy * t;
      best = Math.min(best, x * x + y * y);
    }
  }
  return Math.sqrt(best) * 111195;
}

function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const k = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dx = (lon2 - lon1) * k;
  const dy = lat2 - lat1;
  return Math.sqrt(dx * dx + dy * dy) * 111195;
}

function close(a: SearchResult, b: SearchResult): boolean {
  return metres(a.center[0], a.center[1], b.center[0], b.center[1]) < 1500;
}
