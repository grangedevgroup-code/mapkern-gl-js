import type { SearchData, SearchKind } from "../../src/search/format.ts";
import { NO_CATEGORY, NONE, SEARCH_KINDS } from "../../src/search/format.ts";
import { tokenize } from "../../src/search/text.ts";
import type { RegionData } from "./extract.ts";
import type { Ring } from "./geometry.ts";
import { joinWays, pointInRing, ringBounds, simplify, splitRings } from "./geometry.ts";
import type { Tags } from "./osm-pbf.ts";
import { categoryOf, hasAddress, isNameKey, streetClass } from "./search-schema.ts";

export interface SearchStats {
  entries: number;
  byKind: Record<SearchKind, number>;
  terms: number;
  areas: number;
}

const PLACE_RANK: Record<string, number> = {
  country: 250,
  state: 230,
  province: 230,
  region: 220,
  county: 190,
  city: 200,
  town: 170,
  borough: 140,
  suburb: 130,
  village: 140,
  quarter: 110,
  neighbourhood: 100,
  hamlet: 100,
  island: 120,
  islet: 80,
  locality: 70,
  isolated_dwelling: 50,
  farm: 40,
};

const POI_RANK: Record<string, number> = {
  "aeroway=aerodrome": 170,
  "amenity=university": 140,
  "amenity=hospital": 140,
  "amenity=college": 120,
  "railway=station": 130,
  "public_transport=station": 120,
  "tourism=attraction": 120,
  "tourism=museum": 120,
  "leisure=park": 110,
  "leisure=stadium": 120,
  "natural=peak": 110,
  "natural=water": 100,
  "waterway=river": 110,
  "amenity=school": 90,
  "shop=supermarket": 90,
  "amenity=townhall": 110,
  "historic=monument": 100,
};

const STREET_RANK: Record<string, number> = {
  motorway: 130,
  trunk: 120,
  primary: 110,
  secondary: 100,
  tertiary: 90,
  unclassified: 70,
  residential: 70,
  living_street: 60,
  pedestrian: 60,
  road: 60,
};

const NEAREST_PLACE: Record<string, number> = { city: 15000, town: 8000, village: 4000, hamlet: 2000 };
const CELL = 0.002;
const GROUP_GAP = 0.02;

interface Area {
  name: string;
  level: number;
  rings: Ring[];
  outer: boolean[];
  bbox: [number, number, number, number];
}

interface Entry {
  kind: number;
  rank: number;
  category: string | null;
  name: string;
  context: string;
  number: string | null;
  street: string | null;
  lon: number;
  lat: number;
  shape: Float64Array[] | null;
  tokens: Set<string>;
}

type Slot = 0 | 1 | 2 | 3;
const SLOT_OF_LEVEL: Record<number, Slot> = { 2: 3, 4: 2, 6: 1, 7: 0, 8: 0 };

class AreaGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly inside: Int32Array[];
  private readonly edges: Map<number, number[]>[];

  constructor(
    private readonly bbox: [number, number, number, number],
    private readonly areas: Area[],
  ) {
    this.cols = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / CELL));
    this.rows = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / CELL));
    this.inside = [0, 1, 2, 3].map(() => new Int32Array(this.cols * this.rows).fill(-1));
    this.edges = [0, 1, 2, 3].map(() => new Map<number, number[]>());
    areas.forEach((a, i) => this.add(a, i));
  }

  lookup(lon: number, lat: number): (Area | null)[] {
    const col = Math.floor((lon - this.bbox[0]) / CELL);
    const row = Math.floor((lat - this.bbox[1]) / CELL);
    const out: (Area | null)[] = [null, null, null, null];
    for (let s = 0; s < 4; s++) {
      if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) {
        out[s] = this.exact(s, lon, lat, null);
        continue;
      }
      const cell = row * this.cols + col;
      const edge = this.edges[s]!.get(cell);
      const filled = this.inside[s]![cell]!;
      if (edge) out[s] = this.exact(s, lon, lat, filled >= 0 ? [...edge, filled] : edge);
      else out[s] = filled >= 0 ? this.areas[filled]! : null;
    }
    return out;
  }

  private exact(slot: number, lon: number, lat: number, candidates: number[] | null): Area | null {
    let best: Area | null = null;
    const list = candidates ?? this.areas.map((_, i) => i);
    for (const i of list) {
      const a = this.areas[i]!;
      if (SLOT_OF_LEVEL[a.level] !== slot) continue;
      if (lon < a.bbox[0] || lon > a.bbox[2] || lat < a.bbox[1] || lat > a.bbox[3]) continue;
      if (!contains(a, lon, lat)) continue;
      if (!best || a.level > best.level) best = a;
    }
    return best;
  }

  private add(area: Area, index: number): void {
    const slot = SLOT_OF_LEVEL[area.level];
    if (slot === undefined) return;
    const inside = this.inside[slot]!;
    const edges = this.edges[slot]!;
    const [w, s] = this.bbox;
    const markEdge = (col: number, row: number) => {
      if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return;
      const cell = row * this.cols + col;
      const list = edges.get(cell);
      if (!list) edges.set(cell, [index]);
      else if (list[list.length - 1] !== index) list.push(index);
    };
    for (const ring of area.rings) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const x0 = ring[i]!;
        const y0 = ring[i + 1]!;
        const x1 = ring[i + 2]!;
        const y1 = ring[i + 3]!;
        const steps = Math.max(1, Math.ceil((Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / CELL) * 2));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          markEdge(Math.floor((x0 + (x1 - x0) * t - w) / CELL), Math.floor((y0 + (y1 - y0) * t - s) / CELL));
        }
      }
    }
    const rowFrom = Math.max(0, Math.floor((area.bbox[1] - s) / CELL));
    const rowTo = Math.min(this.rows - 1, Math.floor((area.bbox[3] - s) / CELL));
    for (let row = rowFrom; row <= rowTo; row++) {
      const y = s + (row + 0.5) * CELL;
      const xs: number[] = [];
      for (const ring of area.rings) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const yi = ring[i + 1]!;
          const yj = ring[j + 1]!;
          if (yi > y !== yj > y) xs.push(ring[i]! + ((y - yi) / (yj - yi)) * (ring[j]! - ring[i]!));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k]! - w) / CELL - 0.5));
        const to = Math.min(this.cols - 1, Math.floor((xs[k + 1]! - w) / CELL - 0.5));
        for (let col = from; col <= to; col++) {
          const cell = row * this.cols + col;
          const prev = inside[cell]!;
          if (prev < 0 || this.areas[prev]!.level < area.level) inside[cell] = index;
        }
      }
    }
  }
}

function contains(area: Area, lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of area.rings) if (pointInRing(lon, lat, ring)) inside = !inside;
  return inside;
}

export function indexRegion(
  data: RegionData,
  log: (message: string) => void = () => undefined,
): {
  data: SearchData;
  stats: SearchStats;
} {
  const ids = data.nodeIds;
  const findNode = (id: number): number => {
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = ids[mid]!;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const findWay = (id: number): number => {
    const w = data.wayIds;
    let lo = 0;
    let hi = w.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = w[mid]!;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const wayRefs = (index: number) => data.wayRefs.subarray(data.wayOffsets[index]!, data.wayOffsets[index + 1]!);
  const line = (refs: ArrayLike<number>): Float64Array => {
    const out: number[] = [];
    for (let i = 0; i < refs.length; i++) {
      const n = findNode(refs[i]!);
      if (n >= 0) out.push(data.nodeLon[n]! / 1e7, data.nodeLat[n]! / 1e7);
    }
    return Float64Array.from(out);
  };
  const [minLon, minLat, maxLon, maxLat] = data.bbox;
  const inRegion = (lon: number, lat: number) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;

  const ringsOf = (members: { ref: number; role: string }[]): Ring[] => {
    const parts: Float64Array[] = [];
    for (const m of members) {
      const w = findWay(m.ref);
      if (w >= 0) parts.push(wayRefs(w));
    }
    const { closed } = joinWays(parts);
    return closed.map((refs) => line(refs)).filter((r) => r.length >= 8);
  };

  const areas: Area[] = [];
  const memberWays = new Set<number>();
  const polygonPois: { tags: Tags; rings: Ring[] }[] = [];
  for (const rel of data.relations) {
    const rings = ringsOf(rel.members);
    if (rel.tags.type === "boundary") {
      const level = Number(rel.tags.admin_level);
      if (!rings.length || !Number.isInteger(level)) continue;
      const { outer, inner } = splitRings(rings);
      const all = [...outer, ...inner];
      const b = all.map((r) => ringBounds(r));
      areas.push({
        name: rel.tags.name!,
        level,
        rings: all,
        outer: all.map((_, i) => i < outer.length),
        bbox: [
          Math.min(...b.map((r) => r.x0)),
          Math.min(...b.map((r) => r.y0)),
          Math.max(...b.map((r) => r.x1)),
          Math.max(...b.map((r) => r.y1)),
        ],
      });
    } else {
      for (const m of rel.members) memberWays.add(m.ref);
      if (rings.length) polygonPois.push({ tags: rel.tags, rings });
    }
  }
  const grid = new AreaGrid(data.bbox, areas);
  log(`administrative areas: ${areas.length.toLocaleString()}`);

  const places = data.points.filter((p) => p.tags.place && p.tags.name && NEAREST_PLACE[p.tags.place]);
  const placeGrid = new Map<number, number[]>();
  const placeCell = (lon: number, lat: number) => Math.floor(lon / 0.1) * 10000 + Math.floor(lat / 0.1);
  places.forEach((p, i) => {
    const key = placeCell(p.lon / 1e7, p.lat / 1e7);
    const list = placeGrid.get(key);
    if (list) list.push(i);
    else placeGrid.set(key, [i]);
  });
  const nearestPlace = (lon: number, lat: number): string | null => {
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const cx = Math.floor(lon / 0.1);
    const cy = Math.floor(lat / 0.1);
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (const i of placeGrid.get(x * 10000 + y) ?? []) {
          const p = places[i]!;
          const radius = NEAREST_PLACE[p.tags.place!]!;
          const d = metres(lon, lat, p.lon / 1e7, p.lat / 1e7);
          if (d > radius) continue;
          const score = d / radius;
          if (score < bestScore) {
            bestScore = score;
            best = p.tags.name!;
          }
        }
      }
    }
    return best;
  };

  const contextOf = (lon: number, lat: number, tags: Tags | null, self: string | null): string => {
    const [locality, county, state, country] = grid.lookup(lon, lat);
    void county;
    const city = locality?.name ?? tags?.["addr:city"] ?? nearestPlace(lon, lat);
    const parts: string[] = [];
    const add = (v: string | null | undefined) => {
      if (v && v !== self && parts[parts.length - 1] !== v) parts.push(v);
    };
    add(city);
    const postcode = tags?.["addr:postcode"];
    if (state && postcode) add(`${state.name} ${postcode}`);
    else add(state?.name ?? (postcode || null));
    add(country?.name);
    return parts.join(", ");
  };

  const entries: Entry[] = [];
  const nameTokens = (tags: Tags): Set<string> => {
    const out = new Set<string>();
    for (const key in tags) if (isNameKey(key)) for (const t of tokenize(tags[key]!)) out.add(t);
    return out;
  };
  const addressOf = (tags: Tags): { number: string; street: string } | null => {
    if (!hasAddress(tags)) return null;
    return { number: tags["addr:housenumber"]!, street: tags["addr:street"] ?? tags["addr:place"]! };
  };
  const addFeature = (tags: Tags, lon: number, lat: number) => {
    if (!inRegion(lon, lat)) return;
    const address = addressOf(tags);
    const category = tags.name ? categoryOf(tags) : null;
    if (tags.name && tags.place) {
      const rank = (PLACE_RANK[tags.place] ?? 60) + Math.min(40, Math.log10(Number(tags.population) || 1) * 6);
      entries.push({
        kind: 0,
        rank: Math.min(255, rank),
        category: `place=${tags.place}`,
        name: tags.name,
        context: contextOf(lon, lat, null, tags.name),
        number: null,
        street: null,
        lon,
        lat,
        shape: null,
        tokens: nameTokens(tags),
      });
      return;
    }
    if (tags.name && category) {
      const tokens = nameTokens(tags);
      entries.push({
        kind: 3,
        rank: (POI_RANK[category] ?? 70) + (tags.wikidata ? 30 : 0),
        category,
        name: tags.name,
        context: contextOf(lon, lat, tags, null),
        number: address?.number ?? null,
        street: address?.street ?? null,
        lon,
        lat,
        shape: null,
        tokens,
      });
      return;
    }
    if (address) {
      const tokens = new Set<string>([...tokenize(address.number), ...tokenize(address.street)]);
      entries.push({
        kind: 1,
        rank: 50,
        category: null,
        name: `${address.number} ${address.street}`,
        context: contextOf(lon, lat, tags, null),
        number: address.number,
        street: address.street,
        lon,
        lat,
        shape: null,
        tokens,
      });
    }
  };

  for (const p of data.points) addFeature(p.tags, p.lon / 1e7, p.lat / 1e7);

  const streets = new Map<string, { tags: Tags; lines: Float64Array[] }[]>();
  for (let w = 0; w < data.wayIds.length; w++) {
    const tags = data.wayTags[w];
    if (!tags) continue;
    const pts = line(wayRefs(w));
    if (pts.length < 2) continue;
    const street = streetClass(tags);
    if (street) {
      const name = tags.name ?? tags.ref!;
      let groups = streets.get(name);
      if (!groups) streets.set(name, (groups = []));
      groups.push({ tags, lines: [pts] });
      continue;
    }
    if (memberWays.has(data.wayIds[w]!) && !hasAddress(tags) && !tags.name) continue;
    if (tags.waterway && tags.name && !tags.place) {
      const name = tags.name;
      const key = `\u0001${tags.waterway}\u0001${name}`;
      let groups = streets.get(key);
      if (!groups) streets.set(key, (groups = []));
      groups.push({ tags, lines: [pts] });
      continue;
    }
    const [lon, lat] = centerOf([pts]);
    addFeature(tags, lon, lat);
  }
  for (const poi of polygonPois) {
    const { outer } = splitRings(poi.rings);
    if (!outer.length) continue;
    const [lon, lat] = centerOf(outer);
    addFeature(poi.tags, lon, lat);
  }

  for (const [key, ways] of streets) {
    for (const group of cluster(ways)) {
      const tags = group[0]!.tags;
      const lines = group.flatMap((g) => g.lines).map((l) => simplify(l, 0.00003, false));
      const [lon, lat] = middleOf(lines);
      if (!inRegion(lon, lat) && !lines.some((l) => inRegion(l[0]!, l[1]!))) continue;
      const waterway = key.startsWith("\u0001");
      const name = waterway ? tags.name! : key;
      const tokens = new Set<string>();
      for (const g of group) for (const t of nameTokens(g.tags)) tokens.add(t);
      if (!waterway && tags.ref) for (const t of tokenize(tags.ref)) tokens.add(t);
      if (!tags.name) for (const t of tokenize(name)) tokens.add(t);
      const best = group.reduce((r, g) => Math.max(r, STREET_RANK[g.tags.highway ?? ""] ?? 40), 40);
      entries.push({
        kind: waterway ? 3 : 2,
        rank: waterway ? (POI_RANK[`waterway=${tags.waterway}`] ?? 80) : best,
        category: waterway ? `waterway=${tags.waterway}` : `highway=${streetClass(tags)}`,
        name,
        context: contextOf(lon, lat, null, null),
        number: null,
        street: null,
        lon,
        lat,
        shape: lines,
        tokens,
      });
    }
  }

  for (const a of areas) {
    const type = a.level === 2 ? "country" : a.level === 4 ? "state" : a.level === 6 ? "county" : null;
    if (!type) continue;
    const outer = a.rings.filter((_, i) => a.outer[i]);
    const [lon, lat] = centerOf(outer);
    if (!inRegion(lon, lat) && !(lon < minLon || lon > maxLon || lat < minLat || lat > maxLat)) continue;
    if (entries.some((e) => e.kind === 0 && e.name === a.name && contains(a, e.lon, e.lat))) continue;
    const parent = a.level > 2 ? contextOf(lon, lat, null, a.name) : "";
    entries.push({
      kind: 0,
      rank: PLACE_RANK[type]!,
      category: `place=${type}`,
      name: a.name,
      context: parent,
      number: null,
      street: null,
      lon,
      lat,
      shape: null,
      tokens: new Set(tokenize(a.name)),
    });
  }

  return pack(data.bbox, entries, areas.length, log);
}

function pack(
  bbox: [number, number, number, number],
  entries: Entry[],
  areas: number,
  log: (message: string) => void,
): { data: SearchData; stats: SearchStats } {
  const strings: string[] = [];
  const stringIds = new Map<string, number>();
  const str = (s: string | null): number => {
    if (s === null || s === "") return NONE;
    let id = stringIds.get(s);
    if (id === undefined) {
      id = strings.length;
      strings.push(s);
      stringIds.set(s, id);
    }
    return id;
  };
  const categories: string[] = [];
  const categoryIds = new Map<string, number>();
  const n = entries.length;
  const out: SearchData = {
    bbox,
    strings,
    categories,
    kind: new Uint8Array(n),
    rank: new Uint8Array(n),
    category: new Uint16Array(n),
    name: new Uint32Array(n),
    context: new Uint32Array(n),
    number: new Uint32Array(n),
    street: new Uint32Array(n),
    lon: new Int32Array(n),
    lat: new Int32Array(n),
    shapes: new Uint32Array(n + 1),
    parts: new Uint32Array(0),
    coords: new Int32Array(0),
    terms: new Uint32Array(0),
    termStart: new Uint32Array(0),
    postings: new Uint32Array(0),
  };
  const parts: number[] = [0];
  const coords: number[] = [];
  const postingLists = new Map<string, number[]>();
  const byKind = Object.fromEntries(SEARCH_KINDS.map((k) => [k, 0])) as Record<SearchKind, number>;
  entries.forEach((e, i) => {
    byKind[SEARCH_KINDS[e.kind]!]++;
    out.kind[i] = e.kind;
    out.rank[i] = Math.max(0, Math.min(255, Math.round(e.rank)));
    let cat = NO_CATEGORY;
    if (e.category) {
      cat = categoryIds.get(e.category) ?? -1;
      if (cat < 0 && categories.length < NO_CATEGORY) {
        cat = categories.length;
        categories.push(e.category);
        categoryIds.set(e.category, cat);
      }
      if (cat < 0) cat = NO_CATEGORY;
    }
    out.category[i] = cat;
    out.name[i] = str(e.name);
    out.context[i] = str(e.context);
    out.number[i] = str(e.number);
    out.street[i] = str(e.street);
    out.lon[i] = Math.round(e.lon * 1e7);
    out.lat[i] = Math.round(e.lat * 1e7);
    if (e.shape) {
      for (const l of e.shape) {
        for (let k = 0; k < l.length; k++) coords.push(Math.round(l[k]! * 1e7));
        parts.push(coords.length / 2);
      }
    }
    out.shapes[i + 1] = parts.length - 1;
    for (const t of e.tokens) {
      const list = postingLists.get(t);
      if (!list) postingLists.set(t, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    }
  });
  out.parts = Uint32Array.from(parts);
  out.coords = Int32Array.from(coords);
  const terms = [...postingLists.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  out.terms = Uint32Array.from(terms, (t) => str(t));
  out.termStart = new Uint32Array(terms.length + 1);
  let total = 0;
  for (let i = 0; i < terms.length; i++) {
    total += postingLists.get(terms[i]!)!.length;
    out.termStart[i + 1] = total;
  }
  out.postings = new Uint32Array(total);
  let at = 0;
  for (const t of terms) for (const e of postingLists.get(t)!) out.postings[at++] = e;
  const stats: SearchStats = { entries: n, byKind, terms: terms.length, areas };
  log(
    `search entries: ${n.toLocaleString()} (${SEARCH_KINDS.map((k) => `${byKind[k].toLocaleString()} ${k}`).join(", ")}), terms: ${terms.length.toLocaleString()}`,
  );
  return { data: out, stats };
}

function cluster<T extends { lines: Float64Array[] }>(items: T[]): T[][] {
  const boxes = items.map((it) => {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const l of it.lines) {
      for (let i = 0; i < l.length; i += 2) {
        x0 = Math.min(x0, l[i]!);
        x1 = Math.max(x1, l[i]!);
        y0 = Math.min(y0, l[i + 1]!);
        y1 = Math.max(y1, l[i + 1]!);
      }
    }
    return [x0, y0, x1, y1];
  });
  const parent = items.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const order = items.map((_, i) => i).sort((a, b) => boxes[a]![0]! - boxes[b]![0]!);
  for (let k = 0; k < order.length; k++) {
    const a = boxes[order[k]!]!;
    for (let m = k + 1; m < order.length; m++) {
      const b = boxes[order[m]!]!;
      if (b[0]! > a[2]! + GROUP_GAP) break;
      if (b[1]! > a[3]! + GROUP_GAP || a[1]! > b[3]! + GROUP_GAP) continue;
      parent[root(order[m]!)] = root(order[k]!);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((it, i) => {
    const r = root(i);
    const g = groups.get(r);
    if (g) g.push(it);
    else groups.set(r, [it]);
  });
  return [...groups.values()];
}

function centerOf(rings: Float64Array[]): [number, number] {
  let best = rings[0]!;
  for (const r of rings) if (r.length > best.length) best = r;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < best.length; i += 2) {
    x0 = Math.min(x0, best[i]!);
    x1 = Math.max(x1, best[i]!);
    y0 = Math.min(y0, best[i + 1]!);
    y1 = Math.max(y1, best[i + 1]!);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const closed = best.length >= 8 && best[0] === best[best.length - 2] && best[1] === best[best.length - 1];
  if (!closed || pointInRing(cx, cy, best)) return [cx, cy];
  const xs: number[] = [];
  for (let i = 0, j = best.length - 2; i < best.length; j = i, i += 2) {
    const yi = best[i + 1]!;
    const yj = best[j + 1]!;
    if (yi > cy !== yj > cy) xs.push(best[i]! + ((cy - yi) / (yj - yi)) * (best[j]! - best[i]!));
  }
  xs.sort((a, b) => a - b);
  let wide = 0;
  let mid = cx;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k + 1]! - xs[k]! > wide) {
      wide = xs[k + 1]! - xs[k]!;
      mid = (xs[k]! + xs[k + 1]!) / 2;
    }
  }
  return [mid, cy];
}

function middleOf(lines: Float64Array[]): [number, number] {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const l of lines) {
    for (let i = 0; i < l.length; i += 2) {
      x0 = Math.min(x0, l[i]!);
      x1 = Math.max(x1, l[i]!);
      y0 = Math.min(y0, l[i + 1]!);
      y1 = Math.max(y1, l[i + 1]!);
    }
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let best: [number, number] = [lines[0]![0]!, lines[0]![1]!];
  let bestD = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    for (let i = 0; i < l.length; i += 2) {
      const d = (l[i]! - cx) ** 2 + (l[i + 1]! - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = [l[i]!, l[i + 1]!];
      }
    }
  }
  return best;
}

function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const k = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dx = (lon2 - lon1) * k;
  const dy = lat2 - lat1;
  return Math.sqrt(dx * dx + dy * dy) * 111195;
}
