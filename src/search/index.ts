import type { SearchData, SearchKind } from "./format.ts";
import { decodeSearchData, NONE, SEARCH_KINDS, SearchIndexError } from "./format.ts";
import { expandPrefix, isNumber, tokenize, withinEdits } from "./text.ts";

export interface SearchResult {
  id: number;
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

const SYNONYMS: Record<string, string[]> = {
  cafe: ["coffee"],
  fuel: ["gas", "petrol", "gas station"],
  fast_food: ["burger", "takeout"],
  supermarket: ["grocery", "groceries"],
  pharmacy: ["drugstore", "chemist"],
  atm: ["cash"],
  bar: ["pub"],
  pub: ["bar"],
  toilets: ["restroom", "bathroom", "wc"],
  hospital: ["er", "emergency"],
  charging_station: ["ev", "charger", "charging"],
  parking: ["car park"],
  hotel: ["lodging"],
  motel: ["lodging"],
  library: ["books"],
  doctors: ["doctor", "clinic"],
  clinic: ["doctor"],
  dentist: ["dental"],
  bank: ["atm"],
  post_office: ["post", "mail"],
};

const KIND_ZOOM: Record<SearchKind, number> = { place: 12, address: 18, street: 16, poi: 17 };
const PLACE_ZOOM: Record<string, number> = {
  country: 5,
  state: 7,
  region: 7,
  province: 7,
  county: 9,
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
  islet: 15,
};

const REVERSE_RADIUS: Record<SearchKind, number> = { address: 100, poi: 80, street: 300, place: 20000 };
const REVERSE_ORDER: SearchKind[] = ["address", "poi", "street", "place"];
const MAX_PREFIX_TERMS = 4000;
const CELL = 0.01;

interface TokenMatch {
  terms: { term: number; quality: number }[];
  postings: number;
  contexts: Map<number, number>;
  categories: Map<number, number>;
}

interface Scored {
  entry: number;
  text: number;
  score: number;
  distance: number | undefined;
}

export class SearchIndex implements Geocoder {
  readonly bbox: [number, number, number, number];
  readonly size: number;
  private readonly data: SearchData;
  private readonly termText: string[];
  private readonly contextVocab: Vocabulary;
  private readonly categoryVocab: Vocabulary;
  private readonly categoryLabels: string[];
  private grid: Map<number, number[]> | null = null;

  constructor(data: SearchData) {
    this.data = data;
    this.bbox = data.bbox;
    this.size = data.kind.length;
    this.termText = Array.from(data.terms, (id) => data.strings[id]!);
    const contexts = new Map<number, string>();
    for (const c of data.context) if (c !== NONE && !contexts.has(c)) contexts.set(c, data.strings[c]!);
    this.contextVocab = new Vocabulary(contexts);
    this.categoryLabels = data.categories.map(categoryLabel);
    const categories = new Map<number, string>();
    data.categories.forEach((c, i) => {
      const value = c.slice(c.indexOf("=") + 1);
      categories.set(i, [categoryLabel(c), ...(SYNONYMS[value] ?? [])].join(" "));
    });
    this.categoryVocab = new Vocabulary(categories);
    this.byContext = new Groups(data.context);
    this.byCategory = new Groups(data.category);
  }

  static fromBytes(bytes: ArrayBuffer | Uint8Array): SearchIndex {
    return new SearchIndex(decodeSearchData(bytes));
  }

  static async load(source: SearchIndexSource, options: { signal?: AbortSignal } = {}): Promise<SearchIndex> {
    let bytes: Uint8Array;
    if (source instanceof Uint8Array) bytes = source;
    else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
    else if (typeof Blob !== "undefined" && source instanceof Blob) bytes = new Uint8Array(await source.arrayBuffer());
    else {
      const response = await fetch(String(source), { signal: options.signal });
      if (!response.ok) throw new SearchIndexError(`could not load the search index (HTTP ${response.status})`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return SearchIndex.fromBytes(bytes);
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const limit = Math.max(1, options.limit ?? 8);
    const prefixLast = (options.autocomplete ?? true) && !/\s$/.test(query);
    const matches = tokens.map((t, i) => this.match(t, prefixLast && i === tokens.length - 1));
    const kinds = options.kinds ? new Set(options.kinds.map((k) => SEARCH_KINDS.indexOf(k))) : null;
    const d = this.data;
    let anchor = -1;
    let smallest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]!;
      let count = m.postings;
      for (const c of m.contexts.keys()) count += this.byContext.count(c);
      for (const c of m.categories.keys()) count += this.byCategory.count(c);
      if (count > 0 && count < smallest) {
        smallest = count;
        anchor = i;
      }
    }
    if (anchor < 0) return [];
    const candidates = new Set<number>();
    const a = matches[anchor]!;
    for (const { term } of a.terms)
      for (let p = d.termStart[term]!; p < d.termStart[term + 1]!; p++) candidates.add(d.postings[p]!);
    for (const c of a.contexts.keys()) this.byContext.each(c, (e) => candidates.add(e));
    for (const c of a.categories.keys()) this.byCategory.each(c, (e) => candidates.add(e));
    const allowMissing = tokens.length >= 3 ? 1 : 0;
    const scored: Scored[] = [];
    for (const e of candidates) {
      if (kinds && !kinds.has(d.kind[e]!)) continue;
      const lon = d.lon[e]! / 1e7;
      const lat = d.lat[e]! / 1e7;
      if (options.bbox) {
        const [w, s, east, n] = options.bbox;
        if (lon < w || lon > east || lat < s || lat > n) continue;
      }
      let total = 0;
      let missing = 0;
      let direct = false;
      for (const m of matches) {
        const q = this.quality(m, e);
        if (q.value === 0) missing++;
        if (q.direct) direct = true;
        total += q.value;
      }
      if (missing > allowMissing || !direct) continue;
      const text = total / matches.length;
      const distance = options.near ? metres(options.near[0], options.near[1], lon, lat) : undefined;
      const near = distance === undefined ? 0.5 : 1 / (1 + distance / 5000);
      scored.push({
        entry: e,
        text,
        score: text * 0.6 + (d.rank[e]! / 255) * 0.2 + near * 0.2 - missing * 0.1,
        distance,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(limit * 6, 30));
    for (const s of top) {
      const names = tokenize(this.text(d.name[s.entry]!));
      const cover = names.length ? Math.min(1, tokens.length / names.length) : 1;
      s.score += cover * 0.15;
    }
    top.sort((a, b) => b.score - a.score);
    const out: SearchResult[] = [];
    const seen: SearchResult[] = [];
    for (const s of top) {
      const r = this.result(s.entry, s.score, s.distance);
      if (seen.some((o) => o.kind === r.kind && o.name === r.name && o.context === r.context && close(o, r))) continue;
      seen.push(r);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  reverse(position: [number, number], options: ReverseOptions = {}): SearchResult[] {
    const grid = this.spatial();
    const kinds = options.kinds ?? REVERSE_ORDER;
    const single = kinds.length === 1;
    const limit = options.limit ?? (single ? 5 : kinds.length);
    const [lon, lat] = position;
    const d = this.data;
    const best = new Map<SearchKind, { entry: number; distance: number }[]>();
    const maxRadius = Math.max(...kinds.map((k) => options.radius ?? REVERSE_RADIUS[k]));
    const reach = Math.min(40, Math.ceil(maxRadius / 111000 / CELL / Math.max(0.2, Math.cos((lat * Math.PI) / 180))));
    const cx = Math.floor(lon / CELL);
    const cy = Math.floor(lat / CELL);
    const checked = new Set<number>();
    for (let y = cy - reach; y <= cy + reach; y++) {
      for (let x = cx - reach; x <= cx + reach; x++) {
        const list = grid.get(cellKey(x, y));
        if (!list) continue;
        for (const e of list) {
          if (checked.has(e)) continue;
          checked.add(e);
          const kind = SEARCH_KINDS[d.kind[e]!]!;
          if (!kinds.includes(kind)) continue;
          const distance = this.distanceTo(e, lon, lat);
          if (distance > (options.radius ?? REVERSE_RADIUS[kind])) continue;
          let list2 = best.get(kind);
          if (!list2) best.set(kind, (list2 = []));
          list2.push({ entry: e, distance });
        }
      }
    }
    const out: SearchResult[] = [];
    for (const kind of REVERSE_ORDER) {
      const list = best.get(kind);
      if (!list) continue;
      list.sort((a, b) => a.distance - b.distance || d.rank[b.entry]! - d.rank[a.entry]!);
      for (const { entry, distance } of list.slice(0, single ? limit : 1)) out.push(this.result(entry, 1, distance));
    }
    return out.slice(0, limit);
  }

  private match(token: string, prefix: boolean): TokenMatch {
    const terms: { term: number; quality: number }[] = [];
    const seen = new Set<number>();
    const add = (term: number, quality: number) => {
      if (seen.has(term)) return;
      seen.add(term);
      terms.push({ term, quality });
    };
    const exact = this.find(token);
    if (exact >= 0) add(exact, 1);
    if (prefix) {
      const [from, to] = this.prefixRange(token);
      for (let t = from; t < Math.min(to, from + MAX_PREFIX_TERMS); t++)
        add(t, 0.85 + 0.1 * (token.length / this.termText[t]!.length));
      for (const short of expandPrefix(token)) {
        const t = this.find(short);
        if (t >= 0) add(t, 0.9);
      }
    }
    if (terms.length === 0 && token.length >= 4 && !isNumber(token)) {
      const limit = token.length >= 8 ? 2 : 1;
      for (let t = 0; t < this.termText.length; t++) {
        const text = this.termText[t]!;
        const edits = withinEdits(
          token,
          prefix && text.length > token.length ? text.slice(0, token.length) : text,
          limit,
        );
        if (edits > 0) add(t, edits === 1 ? 0.75 : 0.6);
      }
    }
    let postings = 0;
    for (const { term } of terms) postings += this.data.termStart[term + 1]! - this.data.termStart[term]!;
    return {
      terms,
      postings,
      contexts: this.contextVocab.match(token, prefix),
      categories: this.categoryVocab.match(token, prefix),
    };
  }

  private quality(m: TokenMatch, e: number): { value: number; direct: boolean } {
    const d = this.data;
    let best = 0;
    for (const { term, quality } of m.terms) {
      if (quality <= best) continue;
      if (sortedHas(d.postings, d.termStart[term]!, d.termStart[term + 1]!, e)) best = quality;
    }
    const k = m.categories.get(d.category[e]!);
    if (k !== undefined) best = Math.max(best, k * 0.8);
    const direct = best > 0;
    const c = m.contexts.get(d.context[e]!);
    if (c !== undefined) best = Math.max(best, c * 0.85);
    return { value: best, direct };
  }

  private find(token: string): number {
    let lo = 0;
    let hi = this.termText.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.termText[mid]!;
      if (v === token) return mid;
      if (v < token) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private prefixRange(prefix: string): [number, number] {
    const lower = (value: string) => {
      let lo = 0;
      let hi = this.termText.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.termText[mid]! < value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const from = lower(prefix);
    let to = from;
    while (to < this.termText.length && this.termText[to]!.startsWith(prefix) && to - from <= MAX_PREFIX_TERMS) to++;
    return [from, to];
  }

  private text(id: number): string {
    return id === NONE ? "" : this.data.strings[id]!;
  }

  private result(e: number, score: number, distance: number | undefined): SearchResult {
    const d = this.data;
    const kind = SEARCH_KINDS[d.kind[e]!]!;
    const name = this.text(d.name[e]!);
    const context = this.text(d.context[e]!);
    const raw = d.category[e]! < d.categories.length ? d.categories[d.category[e]!]! : null;
    const category = raw ? raw.slice(raw.indexOf("=") + 1) : null;
    const zoom = kind === "place" && category ? (PLACE_ZOOM[category] ?? KIND_ZOOM.place) : KIND_ZOOM[kind];
    const r: SearchResult = {
      id: e,
      kind,
      name,
      label: context ? `${name}, ${context}` : name,
      context,
      category,
      center: [d.lon[e]! / 1e7, d.lat[e]! / 1e7],
      zoom,
      score: Math.round(score * 1000) / 1000,
    };
    if (d.number[e] !== NONE) r.address = { number: this.text(d.number[e]!), street: this.text(d.street[e]!) };
    if (distance !== undefined) r.distance = Math.round(distance);
    return r;
  }

  private spatial(): Map<number, number[]> {
    if (this.grid) return this.grid;
    const d = this.data;
    const grid = new Map<number, number[]>();
    const put = (key: number, e: number) => {
      const list = grid.get(key);
      if (list) {
        if (list[list.length - 1] !== e) list.push(e);
      } else grid.set(key, [e]);
    };
    for (let e = 0; e < this.size; e++) {
      const from = d.shapes[e]!;
      const to = d.shapes[e + 1]!;
      if (from === to) {
        put(cellKey(Math.floor(d.lon[e]! / 1e7 / CELL), Math.floor(d.lat[e]! / 1e7 / CELL)), e);
        continue;
      }
      for (let p = from; p < to; p++) {
        for (let v = d.parts[p]!; v < d.parts[p + 1]!; v++) {
          put(cellKey(Math.floor(d.coords[v * 2]! / 1e7 / CELL), Math.floor(d.coords[v * 2 + 1]! / 1e7 / CELL)), e);
        }
      }
    }
    this.grid = grid;
    return grid;
  }

  private distanceTo(e: number, lon: number, lat: number): number {
    const d = this.data;
    const from = d.shapes[e]!;
    const to = d.shapes[e + 1]!;
    if (from === to) return metres(lon, lat, d.lon[e]! / 1e7, d.lat[e]! / 1e7);
    const k = Math.cos((lat * Math.PI) / 180);
    let best = Number.POSITIVE_INFINITY;
    for (let p = from; p < to; p++) {
      const start = d.parts[p]!;
      const end = d.parts[p + 1]!;
      for (let v = start; v < end; v++) {
        const ax = (d.coords[v * 2]! / 1e7 - lon) * k;
        const ay = d.coords[v * 2 + 1]! / 1e7 - lat;
        if (v + 1 >= end) {
          best = Math.min(best, ax * ax + ay * ay);
          continue;
        }
        const bx = (d.coords[v * 2 + 2]! / 1e7 - lon) * k;
        const by = d.coords[v * 2 + 3]! / 1e7 - lat;
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
}

class Vocabulary {
  private readonly words = new Map<string, number[]>();

  constructor(texts: Map<number, string>) {
    for (const [id, text] of texts) {
      for (const word of new Set(tokenize(text))) {
        const list = this.words.get(word);
        if (list) list.push(id);
        else this.words.set(word, [id]);
      }
    }
  }

  match(token: string, prefix: boolean): Map<number, number> {
    const out = new Map<number, number>();
    const add = (ids: number[], quality: number) => {
      for (const id of ids) if ((out.get(id) ?? 0) < quality) out.set(id, quality);
    };
    const exact = this.words.get(token);
    if (exact) add(exact, 1);
    const fuzzy = token.length >= 4 && !isNumber(token);
    for (const [word, ids] of this.words) {
      if (word === token) continue;
      if (prefix && word.startsWith(token)) add(ids, 0.85);
      else if (fuzzy && !exact) {
        const edits = withinEdits(token, word, token.length >= 8 ? 2 : 1);
        if (edits > 0) add(ids, edits === 1 ? 0.75 : 0.6);
      }
    }
    return out;
  }
}

function categoryLabel(category: string): string {
  return category.slice(category.indexOf("=") + 1).replace(/_/g, " ");
}

function sortedHas(a: Uint32Array, from: number, to: number, value: number): boolean {
  let lo = from;
  let hi = to - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = a[mid]!;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function cellKey(x: number, y: number): number {
  return (x + 36000) * 20000 + (y + 9000);
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
