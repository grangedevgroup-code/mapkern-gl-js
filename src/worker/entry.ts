import type { GeoJSONLoadRequest, GeoJSONTileRequest } from "./geojson-task.ts";
import { buildGeoJSONTile, geojsonFeatures, loadGeoJSON, removeGeoJSON } from "./geojson-task.ts";
import type { VectorTileRequest } from "./vector-task.ts";
import { buildVectorTile } from "./vector-task.ts";
import { startWorker } from "./worker.ts";

startWorker({
  vector: (payload, signal) => buildVectorTile(payload as VectorTileRequest, signal),
  "geojson-load": (payload) => loadGeoJSON(payload as GeoJSONLoadRequest),
  "geojson-tile": (payload) => buildGeoJSONTile(payload as GeoJSONTileRequest),
  "geojson-remove": (payload) => removeGeoJSON(payload as { source: string }),
  "geojson-features": (payload) => geojsonFeatures(payload as { source: string; indices: number[] }),
});
