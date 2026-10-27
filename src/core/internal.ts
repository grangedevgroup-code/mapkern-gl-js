import type { Style } from "../style/style.ts";
import type { QueryGeometry, QueryOptions } from "./map.ts";
import type { QueriedFeature } from "./query.ts";

export interface MapInternals {
  style(): Style | null;
  enableSyncQueries(): void;
  queryRenderedFeaturesSync(geometry?: QueryGeometry, options?: QueryOptions): QueriedFeature[];
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
