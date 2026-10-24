import type { GeoJSONOptions, GeoJSONSummary } from "./geojson.ts";
import { GeoJSONIndex } from "./geojson.ts";
import type { LayerProgram, VectorTileResult } from "./vector-task.ts";
import { buildBuckets } from "./vector-task.ts";

export interface GeoJSONLoadRequest {
  source: string;
  data?: unknown;
  bytes?: ArrayBuffer;
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
  const data = request.bytes ? parseJSON(request.bytes) : request.data;
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

export async function removeGeoJSON(request: { source: string }): Promise<{ result: null }> {
  indexes.delete(request.source);
  return { result: null };
}

function parseJSON(bytes: ArrayBuffer): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The GeoJSON data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
