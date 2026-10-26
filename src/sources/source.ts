import type { Transform } from "../camera/transform.ts";
import { MapletError } from "../core/errors.ts";
import type { GL } from "../render/gl.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { SourceSpec } from "../style/types.ts";
import type { ResponseStore } from "../tiles/cache.ts";
import type { TransformRequest } from "../tiles/fetch.ts";
import type { ManagerEvents, TileStats } from "../tiles/manager.ts";
import type { RequestScheduler } from "../tiles/scheduler.ts";
import type { WorkerPool } from "../worker/pool.ts";

export interface SourceContext {
  readonly gl: GL;
  readonly scheduler: RequestScheduler;
  workers(): WorkerPool;
  readonly transformRequest: TransformRequest | undefined;
  readonly requestTimeoutMs: number;
  readonly diskCache: ResponseStore | null;
  readonly cacheBytes: number;
  readonly fadeDuration: number;
  readonly prefetchLimit: number;
  readonly pixelRatio: () => number;
  error(error: MapletError): void;
  content(sourceId: string): void;
  changed(): void;
  wakeAt(time: number): void;
}

export interface MapSource {
  readonly id: string;
  readonly type: SourceSpec["type"];
  readonly attribution: string | undefined;
  readonly loaded: boolean;
  spec: SourceSpec;
  load(signal: AbortSignal): Promise<void>;
  update(transform: Transform, now: number, predicted: readonly Transform[]): void;
  uploadPending(deadline: number, now: number): boolean;
  isIdle(): boolean;
  isFading(): boolean;
  stats(): TileStats | null;
  reload(): void;
  destroy(): void;
  setLayers?(layers: readonly StyleLayer[]): void;
  adopt?(spec: SourceSpec): boolean;
}

export function tileEvents(sourceId: string, ctx: SourceContext): ManagerEvents {
  return {
    changed: () => ctx.changed(),
    failure: (failure, tile) => {
      const code = failure.kind === "auth" ? "auth" : failure.kind === "decode" ? "decode" : "tile-error";
      ctx.error(
        new MapletError(code, `Tile ${tile.z}/${tile.x}/${tile.y} of source "${sourceId}" failed: ${failure.message}`, {
          sourceId,
          tile: { z: tile.z, x: tile.x, y: tile.y },
          failure,
        }),
      );
    },
    wakeAt: (time) => ctx.wakeAt(time),
  };
}
