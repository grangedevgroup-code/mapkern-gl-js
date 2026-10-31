import type { WorkerFactory } from "./pool.ts";

declare const MAPKERN_WORKER_SOURCE: string | undefined;

let blobUrl: string | null = null;

export function workerFactory(url: string | undefined): WorkerFactory | null {
  if (typeof Worker === "undefined") return null;
  if (url) return () => new Worker(url);
  const source = typeof MAPKERN_WORKER_SOURCE === "string" ? MAPKERN_WORKER_SOURCE : undefined;
  if (!source) return null;
  return () => {
    blobUrl ??= URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return new Worker(blobUrl);
  };
}
