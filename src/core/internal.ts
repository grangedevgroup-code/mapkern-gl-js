import type { Style } from "../style/style.ts";
import type { QueryGeometry, QueryOptions } from "./map.ts";
import type { QueriedFeature } from "./query.ts";

export interface MapInternals {
  style(): Style | null;
  enableSyncQueries(): void;
  queryRenderedFeaturesSync(geometry?: QueryGeometry, options?: QueryOptions): QueriedFeature[];
  customLayers(): CustomLayerHost;
}

export interface CustomLayerHost {
  add(layer: CustomLayer, beforeId?: string): void;
  remove(id: string): boolean;
  has(id: string): boolean;
}

export interface CustomRenderInput {
  gl: WebGL2RenderingContext;
  matrix: Float64Array;
  projection: Float64Array;
  fov: number;
  nearZ: number;
  farZ: number;
}

export interface CustomLayer {
  readonly id: string;
  readonly renderingMode: "2d" | "3d";
  onAdd?(gl: WebGL2RenderingContext): void;
  onRemove?(gl: WebGL2RenderingContext): void;
  prerender?(input: CustomRenderInput): void;
  render(input: CustomRenderInput): void;
}

const registry = new WeakMap<object, MapInternals>();

export function registerInternals(map: object, internals: MapInternals): void {
  registry.set(map, internals);
}

export function internalsOf(map: object): MapInternals {
  const found = registry.get(map);
  if (!found) throw new TypeError("Not a Mapkern map");
  return found;
}
