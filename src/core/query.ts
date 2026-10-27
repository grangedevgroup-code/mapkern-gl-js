import type { VectorFeature, VectorLayer } from "../formats/mvt.ts";
import { classifyRings, decodeTile, featureIdValue } from "../formats/mvt.ts";
import type { Geometry, Position } from "../geo/geojson.ts";
import { latFromMercatorY, lngFromMercatorX } from "../geo/mercator.ts";
import type { PickedFeature } from "../render/painter.ts";
import type { GeoJSONSource } from "../sources/geojson.ts";
import type { MapSource } from "../sources/source.ts";
import type { VectorSource, VectorTile } from "../sources/vector.ts";
import type { Compiled, GeometryType } from "../style/expression.ts";
import type { Tile } from "../tiles/tile.ts";

export interface QueriedFeature {
  type: "Feature";
  id: number | string | undefined;
  properties: Record<string, unknown>;
  geometry: Geometry | null;
  layer: string;
  source: string;
  sourceLayer: string | undefined;
  state: Record<string, unknown>;
}

export interface SourceQueriedFeature {
  type: "Feature";
  id: number | string | undefined;
  properties: Record<string, unknown>;
  geometry: Geometry | null;
  source: string;
  sourceLayer: string | undefined;
  state: Record<string, unknown>;
}

const GEOMETRY_TYPES: Record<number, GeometryType> = { 1: "Point", 2: "LineString", 3: "Polygon" };

export async function queryVectorSource(
  source: VectorSource,
  sourceLayer: string | undefined,
  filter: Compiled<boolean> | null,
  stateOf: StateReader,
): Promise<SourceQueriedFeature[]> {
  const manager = source.manager;
  if (!manager) return [];
  const out: SourceQueriedFeature[] = [];
  const seen = new Set<number>();
  for (const piece of manager.pieces) {
    const tile = piece.tile;
    if (seen.has(tile.key)) continue;
    seen.add(tile.key);
    const raw = tile.data?.raw;
    if (!raw) continue;
    const layers = await decodedLayers(raw);
    const names = sourceLayer !== undefined ? [sourceLayer] : [...layers.keys()];
    for (const name of names) {
      const layer = layers.get(name);
      if (!layer) continue;
      const promote = promotedKey((source.spec as { promoteId?: unknown }).promoteId, name);
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        const properties: Record<string, unknown> = { ...feature.properties() };
        const id = promote ? featureIdValue(properties[promote]) : feature.id;
        if (filter) {
          const n = 2 ** tile.z;
          const context = {
            properties,
            id,
            geometryType: GEOMETRY_TYPES[feature.type] ?? "Unknown",
            geometry: () => ({
              type: feature.type as 1 | 2 | 3,
              parts: feature.geometry().map((part) => {
                const out = new Float64Array(part.length);
                for (let k = 0; k < part.length; k += 2) {
                  out[k] = (tile.x + part[k]! / feature.extent) / n;
                  out[k + 1] = (tile.y + part[k + 1]! / feature.extent) / n;
                }
                return out;
              }),
            }),
          };
          if (filter.evaluate({ zoom: tile.z, feature: context }) !== true) continue;
        }
        out.push({
          type: "Feature",
          id,
          properties,
          geometry: tileGeometry(feature, tile),
          source: source.id,
          sourceLayer: name,
          state: stateOf(source.id, name, id),
        });
      }
    }
  }
  return out;
}

export type StateReader = (
  source: string,
  sourceLayer: string | undefined,
  id: number | string | undefined,
) => Record<string, unknown>;

interface Pending {
  slot: number;
  index: number;
  hit: PickedFeature;
}

export async function resolveFeatures(
  picked: readonly PickedFeature[],
  sources: ReadonlyMap<string, MapSource>,
  stateOf: StateReader,
): Promise<QueriedFeature[]> {
  const out: (QueriedFeature | null)[] = new Array(picked.length).fill(null);
  const geojson = new Map<GeoJSONSource, Pending[]>();
  const seen = new Set<string>();
  for (let slot = 0; slot < picked.length; slot++) {
    const hit = picked[slot]!;
    const sourceId = hit.layer.source;
    if (!sourceId) continue;
    const source = sources.get(sourceId);
    const index = hit.bucket.features.source(hit.feature);
    if (source?.type === "geojson") {
      const key = `${hit.layer.id}|${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = geojson.get(source as GeoJSONSource) ?? [];
      list.push({ slot, index, hit });
      geojson.set(source as GeoJSONSource, list);
      continue;
    }
    if (source?.type !== "vector") continue;
    const raw = hit.tile.data?.raw;
    if (!raw) continue;
    out[slot] = vectorHit(hit, index, source, await decodedLayers(raw), seen, stateOf);
  }
  for (const [source, wanted] of geojson) {
    const found = new Map((await source.features(wanted.map((w) => w.index))).map((f) => [f.index, f]));
    for (const w of wanted) {
      const f = found.get(w.index);
      if (!f) continue;
      out[w.slot] = {
        type: "Feature",
        id: f.id,
        properties: { ...f.properties },
        geometry: f.geometry,
        layer: w.hit.layer.id,
        source: source.id,
        sourceLayer: undefined,
        state: stateOf(source.id, undefined, f.id),
      };
    }
  }
  return out.filter((f): f is QueriedFeature => f !== null);
}

export function resolveFeaturesSync(
  picked: readonly PickedFeature[],
  sources: ReadonlyMap<string, MapSource>,
  stateOf: StateReader,
): QueriedFeature[] {
  const out: QueriedFeature[] = [];
  const seen = new Set<string>();
  for (const hit of picked) {
    const sourceId = hit.layer.source;
    if (!sourceId) continue;
    const source = sources.get(sourceId);
    const index = hit.bucket.features.source(hit.feature);
    if (source?.type === "geojson") {
      const entry = hit.tile.data?.table?.get(index);
      if (!entry) continue;
      const key = `${hit.layer.id}|${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        type: "Feature",
        id: entry.id,
        properties: { ...entry.properties },
        geometry: tileGeometry({ type: entry.type, extent: entry.extent, geometry: () => entry.parts }, hit.tile),
        layer: hit.layer.id,
        source: sourceId,
        sourceLayer: undefined,
        state: stateOf(sourceId, undefined, entry.id),
      });
      continue;
    }
    if (source?.type !== "vector") continue;
    const raw = hit.tile.data?.raw;
    if (!raw) continue;
    const feature = vectorHit(hit, index, source, decodedLayersSync(raw), seen, stateOf);
    if (feature) out.push(feature);
  }
  return out;
}

function vectorHit(
  hit: PickedFeature,
  index: number,
  source: MapSource,
  tileLayers: Map<string, VectorLayer>,
  seen: Set<string>,
  stateOf: StateReader,
): QueriedFeature | null {
  const name = hit.layer.sourceLayer;
  const layer = name ? tileLayers.get(name) : tileLayers.values().next().value;
  if (!layer || index >= layer.length) return null;
  const feature = layer.feature(index);
  const properties: Record<string, unknown> = { ...feature.properties() };
  const promote = promotedKey((source.spec as { promoteId?: unknown }).promoteId, layer.name);
  const id = promote ? featureIdValue(properties[promote]) : feature.id;
  const key = id !== undefined ? `${hit.layer.id}|id:${id}` : `${hit.layer.id}|${hit.tile.key}|${index}`;
  if (seen.has(key)) return null;
  seen.add(key);
  return {
    type: "Feature",
    id,
    properties,
    geometry: tileGeometry(feature, hit.tile),
    layer: hit.layer.id,
    source: source.id,
    sourceLayer: name,
    state: stateOf(source.id, name, id),
  };
}

const syncDecoded = new Map<ArrayBuffer, Map<string, VectorLayer>>();

function decodedLayersSync(raw: ArrayBuffer): Map<string, VectorLayer> {
  const cached = syncDecoded.get(raw);
  if (cached) {
    syncDecoded.delete(raw);
    syncDecoded.set(raw, cached);
    return cached;
  }
  let bytes = new Uint8Array(raw);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const layers = decodeTile(bytes);
  syncDecoded.set(raw, layers);
  while (syncDecoded.size > DECODED_TILES) syncDecoded.delete(syncDecoded.keys().next().value!);
  return layers;
}

function promotedKey(promote: unknown, layer: string): string | undefined {
  if (typeof promote === "string") return promote;
  if (typeof promote === "object" && promote !== null) {
    const key = (promote as Record<string, unknown>)[layer];
    return typeof key === "string" ? key : undefined;
  }
  return undefined;
}

const DECODED_TILES = 8;
const decoded = new Map<ArrayBuffer, Promise<Map<string, VectorLayer>>>();

function decodedLayers(raw: ArrayBuffer): Promise<Map<string, VectorLayer>> {
  const cached = decoded.get(raw);
  if (cached) {
    decoded.delete(raw);
    decoded.set(raw, cached);
    return cached;
  }
  const layers = decodeRaw(raw);
  decoded.set(raw, layers);
  layers.catch(() => decoded.delete(raw));
  while (decoded.size > DECODED_TILES) decoded.delete(decoded.keys().next().value!);
  return layers;
}

async function decodeRaw(raw: ArrayBuffer): Promise<Map<string, VectorLayer>> {
  let bytes = new Uint8Array(raw);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return decodeTile(bytes);
}

function tileGeometry(feature: VectorFeature, tile: Tile<VectorTile>): Geometry | null {
  const n = 2 ** tile.z;
  const extent = feature.extent;
  const ring = (part: Int32Array): Position[] => {
    const out: Position[] = [];
    for (let i = 0; i < part.length; i += 2) {
      out.push([
        lngFromMercatorX((tile.x + part[i]! / extent) / n),
        latFromMercatorY((tile.y + part[i + 1]! / extent) / n),
      ]);
    }
    return out;
  };
  const parts = feature.geometry();
  switch (feature.type) {
    case 1: {
      const points = parts.flatMap(ring);
      if (points.length === 0) return null;
      return points.length === 1
        ? { type: "Point", coordinates: points[0]! }
        : { type: "MultiPoint", coordinates: points };
    }
    case 2: {
      const lines = parts.map(ring).filter((l) => l.length >= 2);
      if (lines.length === 0) return null;
      return lines.length === 1
        ? { type: "LineString", coordinates: lines[0]! }
        : { type: "MultiLineString", coordinates: lines };
    }
    case 3: {
      const polygons = classifyRings(parts).map((rings) => rings.map(ring));
      if (polygons.length === 0) return null;
      return polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0]! }
        : { type: "MultiPolygon", coordinates: polygons };
    }
    default:
      return null;
  }
}
