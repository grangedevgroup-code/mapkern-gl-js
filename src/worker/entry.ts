import type { DemRequest } from "./dem-task.ts";
import { decodeDemTile } from "./dem-task.ts";
import type { GeoJSONClusterRequest, GeoJSONLoadRequest, GeoJSONTileRequest } from "./geojson-task.ts";
import { buildGeoJSONTile, geojsonCluster, geojsonFeatures, loadGeoJSON, removeGeoJSON } from "./geojson-task.ts";
import type { VectorTileRequest } from "./vector-task.ts";
import { buildVectorTile } from "./vector-task.ts";
import { startWorker } from "./worker.ts";

startWorker({
  vector: (payload, signal) => buildVectorTile(payload as VectorTileRequest, signal),
  dem: (payload, signal) => decodeDemTile(payload as DemRequest, signal),
  "geojson-load": (payload) => loadGeoJSON(payload as GeoJSONLoadRequest),
  "geojson-tile": (payload) => buildGeoJSONTile(payload as GeoJSONTileRequest),
  "geojson-remove": (payload) => removeGeoJSON(payload as { source: string }),
  "geojson-features": (payload) => geojsonFeatures(payload as { source: string; indices: number[] }),
  "geojson-cluster": (payload) => geojsonCluster(payload as GeoJSONClusterRequest),
});
