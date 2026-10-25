import { bytesToGeoJSON, objectToGeoJSON } from "../formats/convert.ts";
import type { FeatureFormat } from "../formats/feature-format.ts";
import type { GeometryType } from "../style/expression.ts";
import { compile } from "../style/expression.ts";
import type { GeoJSONOptions, GeoJSONSummary, QueriedSourceFeature, SourceGeoJSONFeature } from "./geojson.ts";
import { GeoJSONIndex } from "./geojson.ts";
import type { LayerProgram, VectorTileResult } from "./vector-task.ts";
import { buildBuckets } from "./vector-task.ts";

export interface GeoJSONLoadRequest {
  source: string;
  data?: unknown;
  bytes?: ArrayBuffer;
  name?: string;
  format?: FeatureFormat | undefined;
  options: GeoJSONOptions;
}

export interface GeoJSONTileRequest {
  source: string;
  z: number;
  x: number;
  y: number;
  layers: LayerProgram[];
  overzoom: boolean;
}

export type GeoJSONTileReply = { missing: true } | { missing: false; tile: VectorTileResult };

const indexes = new Map<string, GeoJSONIndex>();

export async function loadGeoJSON(request: GeoJSONLoadRequest): Promise<{ result: GeoJSONSummary }> {
  const data = request.bytes
    ? await bytesToGeoJSON(new Uint8Array(request.bytes), request.name ?? "", request.format)
    : objectToGeoJSON(request.data);
  const index = new GeoJSONIndex(data, request.options);
  indexes.set(request.source, index);
  return { result: index.summary };
}

export async function buildGeoJSONTile(
  request: GeoJSONTileRequest,
): Promise<{ result: GeoJSONTileReply; transfer?: Transferable[] }> {
  const index = indexes.get(request.source);
  if (!index) return { result: { missing: true } };
  const started = performance.now();
  const layer = index.tile(request.z, request.x, request.y);
  const built = buildBuckets(new Map([[layer.name, layer]]), request.z, request.layers, request.overzoom, started);
  return { result: { missing: false, tile: built.result }, transfer: built.transfer };
}

export async function geojsonFeatures(request: {
  source: string;
  indices: number[];
}): Promise<{ result: QueriedSourceFeature[] | null }> {
  const index = indexes.get(request.source);
  return { result: index ? index.features(request.indices) : null };
}

export interface GeoJSONSourceQuery {
  source: string;
  tiles: [number, number, number][];
  filter: unknown;
}

const TYPES: Record<number, GeometryType> = { 1: "Point", 2: "LineString", 3: "Polygon" };

export async function geojsonSourceQuery(
  request: GeoJSONSourceQuery,
): Promise<{ result: QueriedSourceFeature[] | null }> {
  const index = indexes.get(request.source);
  if (!index) return { result: null };
  const filter =
    request.filter === undefined || request.filter === null
      ? null
      : compile<boolean>(request.filter, "boolean", false, "filter");
  const found = new Set<number>();
  const order: number[] = [];
  for (const [z, x, y] of request.tiles) {
    const layer = index.tile(z, x, y);
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const at = feature.source ?? -1;
      if (at < 0 || found.has(at)) continue;
      if (filter) {
        const context = {
          properties: feature.properties(),
          id: feature.textId ?? feature.id,
          geometryType: TYPES[feature.type] ?? "Unknown",
        };
        if (filter.evaluate({ zoom: z, feature: context }) !== true) continue;
      }
      found.add(at);
      order.push(at);
    }
  }
  return { result: index.features(order) };
}

export interface GeoJSONClusterRequest {
  source: string;
  op: "expansion" | "children" | "leaves";
  id: number;
  limit?: number;
  offset?: number;
}

export type GeoJSONClusterReply =
  | { missing: true }
  | { missing: false; found: false }
  | { missing: false; found: true; zoom?: number; features?: SourceGeoJSONFeature[] };

export async function geojsonCluster(request: GeoJSONClusterRequest): Promise<{ result: GeoJSONClusterReply }> {
  const index = indexes.get(request.source);
  if (!index) return { result: { missing: true } };
  if (request.op === "expansion") {
    const zoom = index.clusterExpansionZoom(request.id);
    return { result: zoom === null ? { missing: false, found: false } : { missing: false, found: true, zoom } };
  }
  const features =
    request.op === "children"
      ? index.clusterChildren(request.id)
      : index.clusterLeaves(request.id, request.limit ?? 10, request.offset ?? 0);
  return { result: features === null ? { missing: false, found: false } : { missing: false, found: true, features } };
}

export async function removeGeoJSON(request: { source: string }): Promise<{ result: null }> {
  indexes.delete(request.source);
  return { result: null };
}
