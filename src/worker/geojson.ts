import type { FeatureType, PropertyValue, VectorFeature } from "../formats/mvt.ts";
import { clipLine, clipRing, reverseRing, signedArea, simplify } from "../geo/clip.ts";
import type { Rect } from "../geo/tile.ts";
import type { FeatureLayer } from "./vector-task.ts";

export interface GeoJSONOptions {
  promoteId?: string;
  tolerance: number;
  buffer: number;
  extent: number;
  maxZoom: number;
}

interface Indexed {
  id: number | undefined;
  type: 1 | 2 | 3;
  props: Record<string, PropertyValue>;
  parts: Float64Array[];
  bbox: Rect;
  simplified: Map<number, Float64Array[]>;
}

export interface GeoJSONStats {
  features: number;
  bounds: [number, number, number, number] | null;
}

const GRID = 64;
const MAX_LAT = 85.0511287798066;

function mercX(lng: number): number {
  return (lng + 180) / 360;
}

function mercY(lat: number): number {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function boundsOf(parts: Float64Array[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i]!;
      const y = p[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

function project(coords: unknown, closed: boolean): Float64Array | null {
  if (!Array.isArray(coords)) return null;
  const out: number[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") continue;
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    out.push(mercX(c[0]), mercY(c[1]));
  }
  if (closed && out.length >= 6 && (out[0] !== out[out.length - 2] || out[1] !== out[out.length - 1])) out.push(out[0]!, out[1]!);
  return Float64Array.from(out);
}

function polygonParts(rings: unknown, out: Float64Array[]): void {
  if (!Array.isArray(rings)) return;
  let first = true;
  for (const ring of rings) {
    const r = project(ring, true);
    if (!r || r.length < 8) {
      if (first) return;
      continue;
    }
    const area = signedArea(r);
    if (area === 0) continue;
    if (first) out.push(area > 0 ? r : reverseRing(r));
    else out.push(area < 0 ? r : reverseRing(r));
    first = false;
  }
}

function properties(raw: unknown): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (v !== null && v !== undefined) out[k] = JSON.stringify(v);
  }
  return out;
}

export class GeoJSONIndex {
  readonly options: GeoJSONOptions;
  private readonly features: Indexed[] = [];
  private readonly grid = new Map<number, number[]>();

  constructor(data: unknown, options: GeoJSONOptions) {
    this.options = options;
    this.add(data, undefined, {});
    for (let i = 0; i < this.features.length; i++) this.insert(i);
  }

  get stats(): GeoJSONStats {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of this.features) {
      x0 = Math.min(x0, f.bbox.x0);
      y0 = Math.min(y0, f.bbox.y0);
      x1 = Math.max(x1, f.bbox.x1);
      y1 = Math.max(y1, f.bbox.y1);
    }
    if (this.features.length === 0 || !Number.isFinite(x0)) return { features: 0, bounds: null };
    const lng = (x: number) => x * 360 - 180;
    const lat = (y: number) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;
    return { features: this.features.length, bounds: [lng(x0), lat(y1), lng(x1), lat(y0)] };
  }

  private add(node: unknown, id: unknown, props: Record<string, PropertyValue>): void {
    if (typeof node !== "object" || node === null) return;
    const n = node as Record<string, unknown>;
    switch (n.type) {
      case "FeatureCollection":
        if (Array.isArray(n.features)) for (const f of n.features) this.add(f, undefined, {});
        return;
      case "Feature": {
        const p = properties(n.properties);
        let fid: unknown = n.id;
        if (this.options.promoteId && p[this.options.promoteId] !== undefined) fid = p[this.options.promoteId];
        this.add(n.geometry, fid, p);
        return;
      }
      case "GeometryCollection":
        if (Array.isArray(n.geometries)) for (const g of n.geometries) this.add(g, id, props);
        return;
      default:
        this.geometry(n, id, props);
    }
  }

  private geometry(g: Record<string, unknown>, rawId: unknown, props: Record<string, PropertyValue>): void {
    const coords = g.coordinates;
    const parts: Float64Array[] = [];
    let type: 1 | 2 | 3;
    switch (g.type) {
      case "Point": {
        const p = project([coords], false);
        if (p && p.length === 2) parts.push(p);
        type = 1;
        break;
      }
      case "MultiPoint":
        if (Array.isArray(coords)) {
          for (const c of coords) {
            const p = project([c], false);
            if (p && p.length === 2) parts.push(p);
          }
        }
        type = 1;
        break;
      case "LineString": {
        const p = project(coords, false);
        if (p && p.length >= 4) parts.push(p);
        type = 2;
        break;
      }
      case "MultiLineString":
        if (Array.isArray(coords)) {
          for (const c of coords) {
            const p = project(c, false);
            if (p && p.length >= 4) parts.push(p);
          }
        }
        type = 2;
        break;
      case "Polygon":
        polygonParts(coords, parts);
        type = 3;
        break;
      case "MultiPolygon":
        if (Array.isArray(coords)) for (const poly of coords) polygonParts(poly, parts);
        type = 3;
        break;
      default:
        return;
    }
    if (parts.length === 0) return;
    const id = typeof rawId === "number" && Number.isFinite(rawId) ? rawId : typeof rawId === "string" && /^\d+$/.test(rawId) ? Number(rawId) : undefined;
    const bbox = boundsOf(parts);
    this.features.push({ id, type, props, parts, bbox, simplified: new Map() });
    for (const shift of [-1, 1]) {
      if ((shift < 0 && bbox.x1 > 1) || (shift > 0 && bbox.x0 < 0)) {
        const moved = parts.map((p) => {
          const m = new Float64Array(p.length);
          for (let i = 0; i < p.length; i += 2) {
            m[i] = p[i]! + shift;
            m[i + 1] = p[i + 1]!;
          }
          return m;
        });
        this.features.push({ id, type, props, parts: moved, bbox: boundsOf(moved), simplified: new Map() });
      }
    }
  }

  private insert(i: number): void {
    const b = this.features[i]!.bbox;
    const c0 = Math.max(0, Math.floor(b.x0 * GRID));
    const c1 = Math.min(GRID - 1, Math.floor(b.x1 * GRID));
    const r0 = Math.max(0, Math.floor(b.y0 * GRID));
    const r1 = Math.min(GRID - 1, Math.floor(b.y1 * GRID));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * GRID + c;
        let list = this.grid.get(key);
        if (!list) {
          list = [];
          this.grid.set(key, list);
        }
        list.push(i);
      }
    }
  }

  private candidates(rect: Rect): number[] {
    const c0 = Math.max(0, Math.floor(rect.x0 * GRID));
    const c1 = Math.min(GRID - 1, Math.floor(rect.x1 * GRID));
    const r0 = Math.max(0, Math.floor(rect.y0 * GRID));
    const r1 = Math.min(GRID - 1, Math.floor(rect.y1 * GRID));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > GRID * GRID / 4) return this.features.map((_, i) => i);
    const seen = new Set<number>();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const i of this.grid.get(r * GRID + c) ?? []) seen.add(i);
      }
    }
    return [...seen];
  }

  private simplifiedParts(f: Indexed, z: number): Float64Array[] {
    if (f.type === 1 || z >= this.options.maxZoom) return f.parts;
    let cached = f.simplified.get(z);
    if (!cached) {
      const tolerance = this.options.tolerance / (512 * 2 ** z);
      cached = [];
      for (const part of f.parts) {
        const s = simplify(part, tolerance, f.type === 3);
        if (f.type === 3) {
          if (s.length >= 8 && signedArea(s) !== 0 && Math.sign(signedArea(s)) === Math.sign(signedArea(part))) cached.push(s);
          else if (cached.length === 0 && signedArea(part) > 0) {
            continue;
          }
        } else if (s.length >= 4) {
          cached.push(s);
        }
      }
      f.simplified.set(z, cached);
    }
    return cached;
  }

  tile(z: number, x: number, y: number): FeatureLayer {
    const extent = this.options.extent;
    const n = 2 ** z;
    const tile: Rect = { x0: x / n, y0: y / n, x1: (x + 1) / n, y1: (y + 1) / n };
    const pad = this.options.buffer / extent / n;
    const buffered: Rect = { x0: tile.x0 - pad, y0: tile.y0 - pad, x1: tile.x1 + pad, y1: tile.y1 + pad };
    const out: VectorFeature[] = [];
    for (const i of this.candidates(buffered)) {
      const f = this.features[i]!;
      const b = f.bbox;
      if (b.x1 < buffered.x0 || b.x0 > buffered.x1 || b.y1 < buffered.y0 || b.y0 > buffered.y1) continue;
      const parts = this.simplifiedParts(f, z);
      const clipped: Float64Array[] = [];
      if (f.type === 1) {
        for (const p of parts) {
          if (p[0]! >= tile.x0 && p[0]! < tile.x1 && p[1]! >= tile.y0 && p[1]! < tile.y1) clipped.push(p);
        }
      } else if (f.type === 2) {
        for (const p of parts) clipped.push(...clipLine(p, buffered));
      } else {
        let keepHoles = false;
        for (const p of parts) {
          const outer = signedArea(p) > 0;
          const c = clipRing(p, buffered);
          if (outer) {
            keepHoles = c !== null;
            if (c) clipped.push(c);
          } else if (keepHoles && c) {
            clipped.push(c);
          }
        }
      }
      if (clipped.length === 0) continue;
      out.push(toFeature(f, clipped, z, x, y, extent));
    }
    return { name: "geojson", extent, length: out.length, feature: (index) => out[index]! };
  }
}

function toFeature(f: Indexed, parts: Float64Array[], z: number, x: number, y: number, extent: number): VectorFeature {
  const scale = 2 ** z * extent;
  const ox = x * extent;
  const oy = y * extent;
  let geometry: Int32Array[] | null = null;
  const type: FeatureType = f.type;
  return {
    id: f.id,
    type,
    extent,
    properties: () => f.props,
    property: (key: string) => f.props[key],
    geometry: () => {
      if (geometry) return geometry;
      geometry = [];
      for (const part of parts) {
        const q = new Int32Array(part.length);
        for (let i = 0; i < part.length; i += 2) {
          q[i] = Math.round(part[i]! * scale - ox);
          q[i + 1] = Math.round(part[i + 1]! * scale - oy);
        }
        geometry.push(q);
      }
      return geometry;
    },
  };
}
