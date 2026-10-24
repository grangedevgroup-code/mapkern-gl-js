import type { Transform } from "../camera/transform.ts";
import type { MapletError } from "../core/errors.ts";
import type { GL } from "../render/gl.ts";
import type { SourceSpec } from "../style/types.ts";
import type { TransformRequest } from "../tiles/fetch.ts";
import type { TileStats } from "../tiles/manager.ts";
import type { RequestScheduler } from "../tiles/scheduler.ts";
import type { WorkerPool } from "../worker/pool.ts";

export interface SourceContext {
  readonly gl: GL;
  readonly scheduler: RequestScheduler;
  workers(): WorkerPool;
  readonly transformRequest: TransformRequest | undefined;
  readonly requestTimeoutMs: number;
  readonly cacheBytes: number;
  readonly fadeDuration: number;
  readonly prefetchLimit: number;
  readonly pixelRatio: () => number;
  error(error: MapletError): void;
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
}
