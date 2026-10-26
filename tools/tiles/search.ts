import { deflateSync } from "node:zlib";
import { tokenize } from "../../src/search/text.ts";
import { writeSearchFile } from "../../src/search/write.ts";
import type { RegionData } from "./extract.ts";
import type { Ring } from "./geometry.ts";
import { joinWays, pointInRing, ringBounds, simplify, splitRings } from "./geometry.ts";
import type { Tags } from "./osm-pbf.ts";
import { categoryOf, hasAddress, isNameKey, streetClass } from "./search-schema.ts";

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
  "public_transport=platform": 30,
  "highway=bus_stop": 30,
  "public_transport=stop_position": 20,
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
const CONTEXT_ABOVE: Record<string, number> = {
  country: 3,
  state: 2,
  province: 2,
  region: 2,
  county: 0,
  district: 0,
  municipality: 0,
  city: 0,
  town: 0,
  village: 0,
  island: 0,
  archipelago: 0,
};
const GROUP_GAP = 0.02;

interface Area {
  osm: number;
  name: string;
  level: number;
  rings: Ring[];
  outer: boolean[];
  bbox: [number, number, number, number];
}

export interface Entry {
  osm: number;
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
const BAND = 0.05;
const COARSE = 1;

class AreaIndex {
  private readonly areas: Area[];
  private readonly coarse = new Map<number, number[]>();
  private readonly bands: Map<number, Float64Array>[] = [];

  constructor(areas: Area[]) {
    this.areas = areas;
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i]!;
      const lists = new Map<number, number[]>();
      for (const ring of a.rings) {
        for (let k = 0, j = ring.length - 2; k < ring.length; j = k, k += 2) {
          const x0 = ring[j]!;
          const y0 = ring[j + 1]!;
          const x1 = ring[k]!;
          const y1 = ring[k + 1]!;
          if (y0 === y1) continue;
          const from = Math.floor(Math.min(y0, y1) / BAND);
          const to = Math.floor(Math.max(y0, y1) / BAND);
          for (let b = from; b <= to; b++) {
            const list = lists.get(b);
            if (list) list.push(x0, y0, x1, y1);
            else lists.set(b, [x0, y0, x1, y1]);
          }
        }
      }
      const bands = new Map<number, Float64Array>();
      for (const [b, list] of lists) bands.set(b, Float64Array.from(list));
      this.bands.push(bands);
      for (let x = Math.floor(a.bbox[0] / COARSE); x <= Math.floor(a.bbox[2] / COARSE); x++) {
        for (let y = Math.floor(a.bbox[1] / COARSE); y <= Math.floor(a.bbox[3] / COARSE); y++) {
          const key = coarseKey(x, y);
          const list = this.coarse.get(key);
          if (list) list.push(i);
          else this.coarse.set(key, [i]);
        }
      }
    }
  }

  lookup(lon: number, lat: number): (Area | null)[] {
    const out: (Area | null)[] = [null, null, null, null];
    for (const i of this.coarse.get(coarseKey(Math.floor(lon / COARSE), Math.floor(lat / COARSE))) ?? []) {
      const a = this.areas[i]!;
      const slot = SLOT_OF_LEVEL[a.level];
      if (slot === undefined) continue;
      const best = out[slot];
      if (best && best.level >= a.level) continue;
      if (lon < a.bbox[0] || lon > a.bbox[2] || lat < a.bbox[1] || lat > a.bbox[3]) continue;
      if (this.contains(i, lon, lat)) out[slot] = a;
    }
    return out;
  }

  contains(index: number, lon: number, lat: number): boolean {
    const edges = this.bands[index]!.get(Math.floor(lat / BAND));
    if (!edges) return false;
    let inside = false;
    for (let k = 0; k < edges.length; k += 4) {
      const y0 = edges[k + 1]!;
      const y1 = edges[k + 3]!;
      if (y0 > lat === y1 > lat) continue;
      const x0 = edges[k]!;
      const x = x0 + ((lat - y0) / (y1 - y0)) * (edges[k + 2]! - x0);
      if (x > lon) inside = !inside;
    }
    return inside;
  }
}

function coarseKey(x: number, y: number): number {
  return (x + 400) * 1000 + (y + 200);
}

export function collectEntries(data: RegionData, log: (message: string) => void = () => undefined): Entry[] {
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

  const ringsOf = (members: { ref: number; role: string }[], repair: boolean): Ring[] => {
    const parts: Float64Array[] = [];
    for (const m of members) {
      const w = findWay(m.ref);
      if (w >= 0) parts.push(wayRefs(w));
    }
    const { closed, open } = joinWays(parts);
    const rings = closed.map((refs) => line(refs)).filter((r) => r.length >= 8);
    if (repair) rings.push(...stitch(open.map((refs) => line(refs)).filter((c) => c.length >= 4)));
    return rings;
  };

  const areas: Area[] = [];
  const polygonPois: { tags: Tags; rings: Ring[]; osm: number }[] = [];
  for (const rel of data.relations) {
    const rings = ringsOf(rel.members, rel.tags.type === "boundary");
    if (rel.tags.type === "boundary") {
      const level = Number(rel.tags.admin_level);
      if (!rings.length || !Number.isInteger(level)) continue;
      const { outer, inner } = splitRings(rings.map((r) => simplify(r, 0.0002, true)).filter((r) => r.length >= 8));
      const all = [...outer, ...inner];
      const bounds: [number, number, number, number] = [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ];
      for (const r of all) {
        const b = ringBounds(r);
        bounds[0] = Math.min(bounds[0], b.x0);
        bounds[1] = Math.min(bounds[1], b.y0);
        bounds[2] = Math.max(bounds[2], b.x1);
        bounds[3] = Math.max(bounds[3], b.y1);
      }
      if (bounds[0] > maxLon || bounds[2] < minLon || bounds[1] > maxLat || bounds[3] < minLat) continue;
      areas.push({
        osm: rel.id * 4 + 2,
        name: rel.tags.name!,
        level,
        rings: all,
        outer: all.map((_, i) => i < outer.length),
        bbox: bounds,
      });
    } else {
      if (rings.length) polygonPois.push({ tags: rel.tags, rings, osm: rel.id * 4 + 2 });
    }
  }
  const grid = new AreaIndex(areas);

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

  const contextOf = (lon: number, lat: number, tags: Tags | null, self: string | null, above = -1): string => {
    const [locality, , state, country] = grid.lookup(lon, lat);
    const city = above >= 0 ? null : (locality?.name ?? tags?.["addr:city"] ?? nearestPlace(lon, lat));
    const parts: string[] = [];
    const add = (v: string | null | undefined) => {
      if (v && v !== self && parts[parts.length - 1] !== v) parts.push(v);
    };
    add(city);
    const postcode = tags?.["addr:postcode"];
    const region = above < 2 ? state?.name : undefined;
    if (region && postcode) add(`${region} ${postcode}`);
    else add(region ?? (postcode || null));
    if (above < 3) add(country?.name);
    return parts.join(", ");
  };

  const entries: Entry[] = [];
  const nameTokens = (tags: Tags): Set<string> => {
    const out = new Set<string>();
    for (const key in tags) if (isNameKey(key)) for (const t of tokenize(tags[key]!)) out.add(t);
    for (const code of [tags.iata, tags.icao]) if (code) for (const t of tokenize(code)) out.add(t);
    return out;
  };
  const addressOf = (tags: Tags): { number: string; street: string } | null => {
    if (!hasAddress(tags)) return null;
    return { number: tags["addr:housenumber"]!, street: tags["addr:street"] ?? tags["addr:place"]! };
  };
  const addFeature = (tags: Tags, lon: number, lat: number, osm: number) => {
    if (!inRegion(lon, lat)) return;
    const address = addressOf(tags);
    const category = tags.name ? categoryOf(tags) : null;
    if (tags.name && tags.place) {
      const rank = (PLACE_RANK[tags.place] ?? 60) + Math.min(40, Math.log10(Number(tags.population) || 1) * 6);
      entries.push({
        osm,
        kind: 0,
        rank: Math.min(255, rank),
        category: `place=${tags.place}`,
        name: tags.name,
        context: contextOf(lon, lat, null, tags.name, CONTEXT_ABOVE[tags.place] ?? -1),
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
        osm,
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
        osm,
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

  for (const p of data.points) addFeature(p.tags, p.lon / 1e7, p.lat / 1e7, p.id * 4);

  const streets = new Map<string, { tags: Tags; lines: Float64Array[]; osm: number }[]>();
  const group = (key: string, tags: Tags, pts: Float64Array, osm: number) => {
    const list = streets.get(key);
    if (list) list.push({ tags, lines: [pts], osm });
    else streets.set(key, [{ tags, lines: [pts], osm }]);
  };
  for (let w = 0; w < data.wayIds.length; w++) {
    const tags = data.wayTags[w];
    if (!tags) continue;
    const pts = line(wayRefs(w));
    if (pts.length < 2) continue;
    const osm = data.wayIds[w]! * 4 + 1;
    if (streetClass(tags)) {
      group(tags.name ?? tags.ref!, tags, pts, osm);
      continue;
    }
    if (tags.waterway && tags.name && !tags.place) {
      group(`\u0001${tags.waterway}\u0001${tags.name}`, tags, pts, osm);
      continue;
    }
    const refs = wayRefs(w);
    const closed = refs.length >= 4 && refs[0] === refs[refs.length - 1];
    if (!closed && !hasAddress(tags)) continue;
    const [lon, lat] = centerOf([pts]);
    addFeature(tags, lon, lat, osm);
  }
  for (const poi of polygonPois) {
    const { outer } = splitRings(poi.rings);
    if (!outer.length) continue;
    const [lon, lat] = centerOf(outer);
    addFeature(poi.tags, lon, lat, poi.osm);
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
        osm: group[0]!.osm,
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

  const placesByName = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.kind !== 0) continue;
    const list = placesByName.get(e.name);
    if (list) list.push(e);
    else placesByName.set(e.name, [e]);
  }
  areas.forEach((a, index) => {
    const type = a.level === 2 ? "country" : a.level === 4 ? "state" : a.level === 6 ? "county" : null;
    if (!type) return;
    const outer = a.rings.filter((_, i) => a.outer[i]);
    const [lon, lat] = centerOf(outer);
    if (placesByName.get(a.name)?.some((e) => grid.contains(index, e.lon, e.lat))) return;
    const parent = a.level > 2 ? contextOf(lon, lat, null, a.name, a.level === 4 ? 2 : 1) : "";
    entries.push({
      osm: a.osm,
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
  });

  log(`administrative areas: ${areas.length.toLocaleString()}, entries: ${entries.length.toLocaleString()}`);
  return entries;
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

export function writeSearchIndex(
  bbox: [number, number, number, number],
  entries: Entry[],
  log: (message: string) => void = () => undefined,
): Uint8Array {
  return writeSearchFile(entries, {
    bbox,
    compress: (bytes) => deflateSync(bytes, { level: 9 }),
    attribution: "© OpenStreetMap contributors",
    log,
  });
}

export function stitch(chains: Float64Array[]): Ring[] {
  const left = chains.map((c) => Array.from(c));
  const rings: Ring[] = [];
  while (left.length > 0) {
    const ring = left.pop()!;
    for (;;) {
      const ex = ring[ring.length - 2]!;
      const ey = ring[ring.length - 1]!;
      let best = -1;
      let flip = false;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < left.length; i++) {
        const c = left[i]!;
        const start = (c[0]! - ex) ** 2 + (c[1]! - ey) ** 2;
        const end = (c[c.length - 2]! - ex) ** 2 + (c[c.length - 1]! - ey) ** 2;
        if (start < bestD) {
          bestD = start;
          best = i;
          flip = false;
        }
        if (end < bestD) {
          bestD = end;
          best = i;
          flip = true;
        }
      }
      if (best < 0) break;
      const next = left.splice(best, 1)[0]!;
      if (flip) for (let k = next.length - 2; k >= 0; k -= 2) ring.push(next[k]!, next[k + 1]!);
      else for (let k = 0; k < next.length; k++) ring.push(next[k]!);
    }
    ring.push(ring[0]!, ring[1]!);
    if (ring.length >= 8) rings.push(Float64Array.from(ring));
  }
  return rings;
}
