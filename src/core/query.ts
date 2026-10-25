import type { VectorFeature, VectorLayer } from "../formats/mvt.ts";
import { classifyRings, decodeTile, featureIdValue } from "../formats/mvt.ts";
import type { Geometry, Position } from "../geo/geojson.ts";
import { latFromMercatorY, lngFromMercatorX } from "../geo/mercator.ts";
import type { PickedFeature } from "../render/painter.ts";
import type { GeoJSONSource } from "../sources/geojson.ts";
import type { MapSource } from "../sources/source.ts";
import type { VectorTile } from "../sources/vector.ts";
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
  const decoded = new Map<Tile<VectorTile>, Promise<Map<string, VectorLayer>>>();
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
    let layers = decoded.get(hit.tile);
    if (!layers) {
      layers = decodeRaw(raw);
      decoded.set(hit.tile, layers);
    }
    const tileLayers = await layers;
    const name = hit.layer.sourceLayer;
    const layer = name ? tileLayers.get(name) : tileLayers.values().next().value;
    if (!layer || index >= layer.length) continue;
    const feature = layer.feature(index);
    const properties: Record<string, unknown> = { ...feature.properties() };
    const promote = promotedKey((source.spec as { promoteId?: unknown }).promoteId, layer.name);
    const id = promote ? featureIdValue(properties[promote]) : feature.id;
    const key = id !== undefined ? `${hit.layer.id}|id:${id}` : `${hit.layer.id}|${hit.tile.key}|${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out[slot] = {
      type: "Feature",
      id,
      properties,
      geometry: tileGeometry(feature, hit.tile),
      layer: hit.layer.id,
      source: sourceId,
      sourceLayer: name,
      state: stateOf(sourceId, name, id),
    };
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

function promotedKey(promote: unknown, layer: string): string | undefined {
  if (typeof promote === "string") return promote;
  if (typeof promote === "object" && promote !== null) {
    const key = (promote as Record<string, unknown>)[layer];
    return typeof key === "string" ? key : undefined;
  }
  return undefined;
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
