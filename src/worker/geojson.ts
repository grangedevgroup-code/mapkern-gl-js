import type { FeatureType, PropertyValue, VectorFeature } from "../formats/mvt.ts";
import { numericId, ringArea } from "../formats/mvt.ts";
import { ALWAYS_KEEP, clipLine, clipRing, rankVertices, reverseRing, ringBounds, signedArea } from "../geo/clip.ts";
import { latFromMercatorY, lngFromMercatorX, mercatorX, mercatorY } from "../geo/mercator.ts";
import type { Rect } from "../geo/tile.ts";
import { tileKey } from "../geo/tile.ts";
import type { FeatureLayer } from "./vector-task.ts";

export interface GeoJSONOptions {
  maxZoom: number;
  tolerance: number;
  buffer: number;
  extent: number;
  promoteId?: string | undefined;
}

export interface GeoJSONSummary {
  features: number;
  vertices: number;
  coverage: Rect | null;
  bounds: [number, number, number, number] | null;
}

interface SourceFeature {
  readonly id: number | undefined;
  readonly index: number;
  readonly properties: Record<string, PropertyValue>;
}

interface Part {
  readonly points: Float64Array;
  readonly outer: boolean;
  readonly size: number;
}

interface Item {
  readonly feature: SourceFeature;
  readonly type: 1 | 2 | 3;
  readonly parts: readonly Part[];
  readonly bounds: Rect;
  readonly vertices: number;
}

interface Node {
  readonly items: readonly Item[];
  readonly vertices: number;
  readonly cost: number;
}

const DIRECT_LIMIT = 16384;
const MIN_CACHE_COST = 1 << 20;
const MAX_CACHED_NODES = 4096;

export class GeoJSONIndex {
  readonly options: GeoJSONOptions;
  readonly summary: GeoJSONSummary;
  private readonly root: Node;
  private readonly cache = new Map<number, Node>();
  private readonly budget: number;
  private cachedCost = 0;

  constructor(data: unknown, options: GeoJSONOptions) {
    this.options = options;
    const { items, features, bounds } = readGeoJSON(data, options.promoteId);
    let vertices = 0;
    let coverage: Rect | null = null;
    for (const item of items) {
      vertices += item.vertices;
      coverage = coverage ? union(coverage, item.bounds) : { ...item.bounds };
    }
    this.root = { items, vertices, cost: vertices };
    this.budget = Math.max(MIN_CACHE_COST, vertices);
    this.summary = {
      features,
      vertices,
      coverage,
      bounds: bounds
        ? [
            lngFromMercatorX(bounds.x0),
            latFromMercatorY(bounds.y1),
            lngFromMercatorX(bounds.x1),
            latFromMercatorY(bounds.y0),
          ]
        : null,
    };
  }

  tile(z: number, x: number, y: number): FeatureLayer {
    const node = this.node(z, x, y);
    const extent = this.options.extent;
    const n = 2 ** z;
    const tolerance = z >= this.options.maxZoom ? 0 : this.options.tolerance / (512 * n);
    const grid: Grid = { scale: n * extent, ox: x * extent, oy: y * extent };
    const features: VectorFeature[] = [];
    for (const item of node.items) {
      const geometry =
        item.type === 1
          ? writePoints(item, grid)
          : item.type === 2
            ? writeLines(item, grid, tolerance)
            : writePolygons(item, grid, tolerance);
      if (geometry.length > 0) features.push(new TileFeature(item, geometry, extent));
    }
    return { name: "geojson", extent, length: features.length, feature: (index) => features[index]! };
  }

  private node(z: number, x: number, y: number): Node {
    const hit = this.touch(tileKey(z, x, y));
    if (hit) return hit;
    let parent = this.root;
    let level = -1;
    for (let k = z - 1; k >= 0; k--) {
      const ancestor = this.touch(tileKey(k, x >> (z - k), y >> (z - k)));
      if (ancestor) {
        parent = ancestor;
        level = k;
        break;
      }
    }
    for (;;) {
      const next = parent.vertices > DIRECT_LIMIT ? level + 1 : z;
      const node = this.derive(parent, next, x >> (z - next), y >> (z - next));
      if (next === z) return node;
      parent = node;
      level = next;
    }
  }

  private touch(key: number): Node | undefined {
    const node = this.cache.get(key);
    if (node) {
      this.cache.delete(key);
      this.cache.set(key, node);
    }
    return node;
  }

  private derive(parent: Node, z: number, x: number, y: number): Node {
    const n = 2 ** z;
    const pad = this.options.buffer / 512 / n;
    const rect: Rect = { x0: x / n - pad, y0: y / n - pad, x1: (x + 1) / n + pad, y1: (y + 1) / n + pad };
    const items: Item[] = [];
    let vertices = 0;
    let cost = 0;
    for (const item of parent.items) {
      const clipped = clipItem(item, rect);
      if (!clipped) continue;
      items.push(clipped);
      vertices += clipped.vertices;
      cost += clipped === item ? 1 : clipped.vertices;
    }
    const node: Node = { items, vertices, cost };
    this.cache.set(tileKey(z, x, y), node);
    this.cachedCost += cost;
    this.trim();
    return node;
  }

  private trim(): void {
    if (this.cachedCost <= this.budget && this.cache.size <= MAX_CACHED_NODES) return;
    for (const [key, node] of this.cache) {
      if (this.cachedCost <= this.budget * 0.75 && this.cache.size <= MAX_CACHED_NODES * 0.75) break;
      this.cache.delete(key);
      this.cachedCost -= node.cost;
    }
  }
}

interface Grid {
  scale: number;
  ox: number;
  oy: number;
}

class TileFeature implements VectorFeature {
  readonly id: number | undefined;
  readonly source: number;
  readonly type: FeatureType;
  readonly extent: number;
  private readonly feature: SourceFeature;
  private readonly parts: Int32Array[];

  constructor(item: Item, parts: Int32Array[], extent: number) {
    this.id = item.feature.id;
    this.source = item.feature.index;
    this.type = item.type;
    this.extent = extent;
    this.feature = item.feature;
    this.parts = parts;
  }

  properties(): Record<string, PropertyValue> {
    return this.feature.properties;
  }

  property(key: string): PropertyValue | undefined {
    return this.feature.properties[key];
  }

  geometry(): Int32Array[] {
    return this.parts;
  }
}

function writePoints(item: Item, grid: Grid): Int32Array[] {
  let total = 0;
  for (const part of item.parts) total += part.points.length / 3;
  if (total === 0) return [];
  const out = new Int32Array(total * 2);
  let k = 0;
  for (const part of item.parts) {
    const p = part.points;
    for (let i = 0; i < p.length; i += 3) {
      out[k++] = Math.round(p[i]! * grid.scale - grid.ox);
      out[k++] = Math.round(p[i + 1]! * grid.scale - grid.oy);
    }
  }
  return [out];
}

function writeLines(item: Item, grid: Grid, tolerance: number): Int32Array[] {
  const out: Int32Array[] = [];
  const sq = tolerance * tolerance;
  for (const part of item.parts) {
    if (tolerance > 0 && part.size < tolerance) continue;
    const line = quantize(part.points, sq, grid, false);
    if (line.length >= 4) out.push(line);
  }
  return out;
}

function writePolygons(item: Item, grid: Grid, tolerance: number): Int32Array[] {
  const out: Int32Array[] = [];
  const sq = tolerance * tolerance;
  let open = false;
  for (const part of item.parts) {
    const small = tolerance > 0 && part.size < sq;
    if (part.outer) open = !small;
    if (!open || small) continue;
    let ring = quantize(part.points, sq, grid, true);
    const area = ring.length >= 8 ? ringArea(ring) : 0;
    if (area === 0) {
      if (part.outer) open = false;
      continue;
    }
    if (area > 0 !== part.outer) ring = reverseInts(ring);
    out.push(ring);
  }
  return out;
}

let scratch = new Int32Array(4096);

function quantize(points: Float64Array, sq: number, grid: Grid, closed: boolean): Int32Array {
  const n = points.length / 3;
  if (scratch.length < n * 2 + 2) scratch = new Int32Array(n * 4 + 2);
  const out = scratch;
  const end = closed ? n - 1 : n;
  let k = 0;
  for (let i = 0; i < end; i++) {
    if (i !== 0 && i !== n - 1 && !(points[i * 3 + 2]! > sq)) continue;
    const x = Math.round(points[i * 3]! * grid.scale - grid.ox);
    const y = Math.round(points[i * 3 + 1]! * grid.scale - grid.oy);
    if (k >= 2 && x === out[k - 2] && y === out[k - 1]) continue;
    out[k++] = x;
    out[k++] = y;
  }
  if (closed) {
    while (k >= 4 && out[k - 2] === out[0] && out[k - 1] === out[1]) k -= 2;
    if (k >= 2) {
      out[k] = out[0]!;
      out[k + 1] = out[1]!;
      k += 2;
    }
  }
  return out.slice(0, k);
}

function reverseInts(ring: Int32Array): Int32Array {
  const out = new Int32Array(ring.length);
  for (let i = 0, j = ring.length - 2; i < ring.length; i += 2, j -= 2) {
    out[i] = ring[j]!;
    out[i + 1] = ring[j + 1]!;
  }
  return out;
}

function clipItem(item: Item, r: Rect): Item | null {
  const b = item.bounds;
  if (b.x0 > r.x1 || b.x1 < r.x0 || b.y0 > r.y1 || b.y1 < r.y0) return null;
  if (b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1) return item;
  const parts = item.type === 1 ? clipPoints(item, r) : item.type === 2 ? clipLines(item, r) : clipPolygons(item, r);
  return parts.length > 0 ? makeItem(item.feature, item.type, parts) : null;
}

function clipPoints(item: Item, r: Rect): Part[] {
  const out: Part[] = [];
  for (const part of item.parts) {
    const p = part.points;
    const kept = new Float64Array(p.length);
    let k = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!;
      const y = p[i + 1]!;
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      kept[k++] = x;
      kept[k++] = y;
      kept[k++] = ALWAYS_KEEP;
    }
    if (k > 0) out.push({ points: k === kept.length ? kept : kept.slice(0, k), outer: true, size: 0 });
  }
  return out;
}

function clipLines(item: Item, r: Rect): Part[] {
  const out: Part[] = [];
  for (const part of item.parts) {
    for (const points of clipLine(part.points, r, 3)) out.push({ points, outer: true, size: part.size });
  }
  return out;
}

function clipPolygons(item: Item, r: Rect): Part[] {
  const out: Part[] = [];
  const full = (r.x1 - r.x0) * (r.y1 - r.y0) * (1 - 1e-9);
  let group: Part[] = [];
  let hollow = false;
  for (const part of item.parts) {
    if (part.outer) {
      if (!hollow) for (const kept of group) out.push(kept);
      group = [];
      hollow = false;
      const ring = clipRing(part.points, r, 3);
      if (ring) group.push({ points: ring, outer: true, size: part.size });
      continue;
    }
    if (group.length === 0 || hollow) continue;
    const ring = clipRing(part.points, r, 3);
    if (!ring) continue;
    if (Math.abs(signedArea(ring, 3)) >= full) hollow = true;
    else group.push({ points: ring, outer: false, size: part.size });
  }
  if (!hollow) for (const kept of group) out.push(kept);
  return out;
}

function makeItem(feature: SourceFeature, type: 1 | 2 | 3, parts: readonly Part[]): Item {
  let bounds: Rect | null = null;
  let vertices = 0;
  for (const part of parts) {
    const b = ringBounds(part.points, 3);
    bounds = bounds ? union(bounds, b) : b;
    vertices += part.points.length / 3;
  }
  return { feature, type, parts, bounds: bounds!, vertices };
}

function union(a: Rect, b: Rect): Rect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function shifted(item: Item, dx: number): Item {
  const parts = item.parts.map((part) => {
    const points = part.points.slice();
    for (let i = 0; i < points.length; i += 3) points[i]! += dx;
    return { points, outer: part.outer, size: part.size };
  });
  return makeItem(item.feature, item.type, parts);
}

function readGeoJSON(
  data: unknown,
  promoteId: string | undefined,
): { items: Item[]; features: number; bounds: Rect | null } {
  const items: Item[] = [];
  let features = 0;
  let bounds: Rect | null = null;
  const add = (geometry: unknown, feature: SourceFeature): boolean => {
    if (typeof geometry !== "object" || geometry === null) return false;
    const g = geometry as Record<string, unknown>;
    if (g.type === "GeometryCollection") {
      let added = false;
      if (Array.isArray(g.geometries)) for (const child of g.geometries) added = add(child, feature) || added;
      return added;
    }
    const item = readGeometry(g, feature);
    if (!item) return false;
    items.push(item);
    bounds = bounds ? union(bounds, item.bounds) : item.bounds;
    if (item.bounds.x1 > 1) items.push(shifted(item, -1));
    if (item.bounds.x0 < 0) items.push(shifted(item, 1));
    return true;
  };
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as Record<string, unknown>;
    if (n.type === "FeatureCollection") {
      if (Array.isArray(n.features)) for (const f of n.features) visit(f);
    } else if (n.type === "Feature") {
      const properties = readProperties(n.properties);
      const raw = promoteId !== undefined && properties[promoteId] !== undefined ? properties[promoteId] : n.id;
      if (add(n.geometry, { id: numericId(raw), index: features, properties })) features++;
    } else if (add(n, { id: undefined, index: features, properties: {} })) {
      features++;
    }
  };
  visit(data);
  return { items, features, bounds };
}

function readProperties(raw: unknown): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (value !== null && value !== undefined) out[key] = JSON.stringify(value);
  }
  return out;
}

function readGeometry(g: Record<string, unknown>, feature: SourceFeature): Item | null {
  const c = g.coordinates;
  const parts: Part[] = [];
  let type: 1 | 2 | 3;
  switch (g.type) {
    case "Point":
    case "MultiPoint": {
      type = 1;
      const points = project(g.type === "Point" ? [c] : c, 1);
      if (points) {
        for (let i = 2; i < points.length; i += 3) points[i] = ALWAYS_KEEP;
        parts.push({ points, outer: true, size: 0 });
      }
      break;
    }
    case "LineString":
    case "MultiLineString": {
      type = 2;
      for (const line of g.type === "LineString" ? [c] : list(c)) {
        const points = project(line, 2);
        if (!points) continue;
        rankVertices(points);
        parts.push({ points, outer: true, size: pathLength(points) });
      }
      break;
    }
    case "Polygon":
    case "MultiPolygon":
      type = 3;
      for (const polygon of g.type === "Polygon" ? [c] : list(c)) readPolygon(polygon, parts);
      break;
    default:
      return null;
  }
  return parts.length > 0 ? makeItem(feature, type, parts) : null;
}

function readPolygon(polygon: unknown, parts: Part[]): void {
  if (!Array.isArray(polygon)) return;
  for (let r = 0; r < polygon.length; r++) {
    const outer = r === 0;
    const projected = project(polygon[r], 3);
    const ring = projected ? closeRing(projected) : null;
    const area = ring && ring.length >= 12 ? signedArea(ring, 3) : 0;
    if (!ring || area === 0) {
      if (outer) return;
      continue;
    }
    const oriented = area > 0 === outer ? ring : reverseRing(ring, 3);
    rankVertices(oriented);
    parts.push({ points: oriented, outer, size: Math.abs(area) });
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function project(positions: unknown, minimum: number): Float64Array | null {
  if (!Array.isArray(positions)) return null;
  const out = new Float64Array(positions.length * 3);
  let n = 0;
  for (const p of positions) {
    if (!Array.isArray(p)) continue;
    const lng = p[0];
    const lat = p[1];
    if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out[n] = mercatorX(lng);
    out[n + 1] = mercatorY(lat);
    n += 3;
  }
  if (n / 3 < minimum) return null;
  return n === out.length ? out : out.slice(0, n);
}

function closeRing(points: Float64Array): Float64Array {
  const last = points.length - 3;
  if (points[0] === points[last] && points[1] === points[last + 1]) return points;
  const out = new Float64Array(points.length + 3);
  out.set(points);
  out[points.length] = points[0]!;
  out[points.length + 1] = points[1]!;
  return out;
}

function pathLength(points: Float64Array): number {
  let length = 0;
  for (let i = 3; i < points.length; i += 3) {
    length += Math.hypot(points[i]! - points[i - 3]!, points[i + 1]! - points[i - 2]!);
  }
  return length;
}
