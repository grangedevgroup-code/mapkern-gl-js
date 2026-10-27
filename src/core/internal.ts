import type { Style } from "../style/style.ts";
import type { LayerSpec } from "../style/types.ts";
import type { QueryGeometry, QueryOptions } from "./map.ts";
import type { QueriedFeature, SourceQueriedFeature } from "./query.ts";

export interface MapInternals {
  style(): Style | null;
  enableSyncQueries(): void;
  queryRenderedFeaturesSync(geometry?: QueryGeometry, options?: QueryOptions): QueriedFeature[];
  restyleLayer(spec: LayerSpec): void;
  querySourceFeaturesSync(sourceId: string, sourceLayer?: string): SourceQueriedFeature[];
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
