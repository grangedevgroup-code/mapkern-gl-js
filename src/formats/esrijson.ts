import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import type { Unproject } from "../geo/projection.ts";
import { projectionFromEpsg, projectionFromWkt } from "../geo/projection.ts";
import { assemblePolygons } from "./rings.ts";

interface EsriSpatialReference {
  wkid?: number;
  latestWkid?: number;
  wkt?: string;
}

interface EsriGeometry {
  x?: number | string | null;
  y?: number | string | null;
  z?: number;
  points?: number[][];
  paths?: number[][][];
  rings?: number[][][];
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  hasZ?: boolean;
  hasM?: boolean;
  spatialReference?: EsriSpatialReference;
}

interface EsriFeature {
  attributes?: Record<string, unknown> | null;
  geometry?: EsriGeometry | null;
}

interface EsriFeatureSet {
  features?: EsriFeature[];
  spatialReference?: EsriSpatialReference;
  objectIdFieldName?: string;
  hasZ?: boolean;
  hasM?: boolean;
  fields?: { name?: string; type?: string }[];
}

const WEB_MERCATOR = new Set([102100, 102113, 3857, 900913, 3785]);

export function isEsriJson(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const set = data as EsriFeatureSet & { geometryType?: unknown; type?: unknown };
  if (set.type === "FeatureCollection") return false;
  if (typeof set.geometryType === "string" && set.geometryType.startsWith("esriGeometry")) return true;
  if (!Array.isArray(set.features)) return false;
  return set.features.some((f) => f && typeof f === "object" && "attributes" in f && !("properties" in f));
}

function projectionFor(sr: EsriSpatialReference | undefined): Unproject | null {
  if (!sr) return null;
  const wkid = sr.latestWkid ?? sr.wkid;
  if (typeof wkid === "number") return projectionFromEpsg(WEB_MERCATOR.has(wkid) ? 3857 : wkid);
  if (typeof sr.wkt === "string" && sr.wkt.trim()) return projectionFromWkt(sr.wkt);
  return null;
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "NaN") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function geometryOf(g: EsriGeometry, hasZ: boolean, unproject: Unproject | null): Geometry | null {
  const z = g.hasZ ?? hasZ;
  const point = (c: number[]): Position | null => {
    const x = number(c[0]);
    const y = number(c[1]);
    if (x === null || y === null) return null;
    const [lng, lat] = unproject ? unproject(x, y) : [x, y];
    const height = z ? number(c[2]) : null;
    return height === null ? [lng, lat] : [lng, lat, height];
  };
  const line = (cs: number[][]) => cs.map(point).filter((p): p is Position => p !== null);
  if (g.x !== undefined || g.y !== undefined) {
    const p = point([g.x as number, g.y as number, g.z as number]);
    return p ? { type: "Point", coordinates: p } : null;
  }
  if (Array.isArray(g.points)) {
    const pts = line(g.points);
    if (pts.length === 0) return null;
    return pts.length === 1 ? { type: "Point", coordinates: pts[0]! } : { type: "MultiPoint", coordinates: pts };
  }
  if (Array.isArray(g.paths)) {
    const paths = g.paths.map(line).filter((p) => p.length >= 2);
    if (paths.length === 0) return null;
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0]! }
      : { type: "MultiLineString", coordinates: paths };
  }
  if (Array.isArray(g.rings)) {
    const valid = g.rings
      .map((r) => r.map((c) => c.map(Number)))
      .filter((r) => r.length >= 4 && r.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1])));
    const grouped = assemblePolygons(valid);
    if (grouped?.type === "Polygon") return { type: "Polygon", coordinates: grouped.coordinates.map(line) };
    if (grouped?.type === "MultiPolygon") {
      return { type: "MultiPolygon", coordinates: grouped.coordinates.map((p) => p.map(line)) };
    }
    return null;
  }
  if (g.xmin !== undefined && g.ymin !== undefined && g.xmax !== undefined && g.ymax !== undefined) {
    const ring = line([
      [g.xmin, g.ymin],
      [g.xmax, g.ymin],
      [g.xmax, g.ymax],
      [g.xmin, g.ymax],
      [g.xmin, g.ymin],
    ]);
    return ring.length === 5 ? { type: "Polygon", coordinates: [ring] } : null;
  }
  return null;
}

export function esriJsonToGeoJSON(data: unknown): FeatureCollection {
  const set = data as EsriFeatureSet;
  const unproject = projectionFor(set.spatialReference);
  const idField = set.objectIdFieldName ?? set.fields?.find((f) => f.type === "esriFieldTypeOID")?.name ?? undefined;
  const dates = new Set((set.fields ?? []).filter((f) => f.type === "esriFieldTypeDate").map((f) => f.name));
  const features: Feature[] = [];
  for (const f of set.features ?? []) {
    if (!f || typeof f !== "object") continue;
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.attributes ?? {})) {
      properties[k] = dates.has(k) && typeof v === "number" ? new Date(v).toISOString() : v;
    }
    const own = f.geometry?.spatialReference ? projectionFor(f.geometry.spatialReference) : unproject;
    const geometry = f.geometry ? geometryOf(f.geometry, set.hasZ ?? false, own) : null;
    const feature: Feature = { type: "Feature", properties, geometry };
    const id = idField ? properties[idField] : undefined;
    if (typeof id === "number" || typeof id === "string") feature.id = id;
    features.push(feature);
  }
  return { type: "FeatureCollection", features };
}
