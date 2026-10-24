import type { VectorTileRequest } from "./vector-task.ts";
import { buildVectorTile } from "./vector-task.ts";
import { startWorker } from "./worker.ts";

startWorker({
  vector: (payload, signal) => buildVectorTile(payload as VectorTileRequest, signal),
});
