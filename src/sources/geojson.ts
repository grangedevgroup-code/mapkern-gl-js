import type { Transform } from "../camera/transform.ts";
import { errorMessage, MapletError } from "../core/errors.ts";
import type { Rect, TileCoord } from "../geo/tile.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { GeoJSONData, GeoJSONSourceSpec } from "../style/types.ts";
import { FetchFailure, fetchBytes, resolveRequest, retryDelay } from "../tiles/fetch.ts";
import type { TileStats, Tiling } from "../tiles/manager.ts";
import { TileManager } from "../tiles/manager.ts";
import type { GeoJSONOptions, GeoJSONSummary } from "../worker/geojson.ts";
import type { GeoJSONLoadRequest, GeoJSONTileReply, GeoJSONTileRequest } from "../worker/geojson-task.ts";
import type { MapSource, SourceContext } from "./source.ts";
import { tileEvents } from "./source.ts";
import type { VectorTile, VectorTileSource } from "./vector.ts";
import { LayerPrograms, vectorTile, vectorTileLoader } from "./vector.ts";

const EXTENT = 4096;
const NOWHERE: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
const FETCH_ATTEMPTS = 3;

let nextKey = 1;

export class GeoJSONSource implements MapSource, VectorTileSource {
  readonly id: string;
  readonly type = "geojson" as const;
  spec: GeoJSONSourceSpec;
  manager: TileManager<VectorTile> | null = null;
  private readonly ctx: SourceContext;
  private readonly key: string;
  private readonly affinity: number;
  private readonly layers = new LayerPrograms();
  private readonly controller = new AbortController();
  private summary: GeoJSONSummary | null = null;
  private version = 1;
  private applied = 0;
  private syncing: Promise<void> | null = null;
  private restoring: Promise<void> | null = null;
  private posted = false;

  constructor(id: string, spec: GeoJSONSourceSpec, ctx: SourceContext) {
    this.id = id;
    this.spec = spec;
    this.ctx = ctx;
    this.key = `${id}#${nextKey++}`;
    this.affinity = hash(id);
  }

  get loaded(): boolean {
    return this.manager !== null;
  }

  get attribution(): string | undefined {
    return this.spec.attribution;
  }

  get bounds(): [number, number, number, number] | null {
    return this.summary?.bounds ?? null;
  }

  get featureCount(): number {
    return this.summary?.features ?? 0;
  }

  async load(signal: AbortSignal): Promise<void> {
    const abort = () => this.controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.sync(true);
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (this.controller.signal.aborted) return;
    const options = this.options();
    this.ctx.scheduler.setGroupLimit(this.id, 16);
    this.manager = new TileManager<VectorTile>(
      this.id,
      this.tiling(options),
      vectorTileLoader(this.ctx.gl, (tile, tileSignal, onDecoding) => this.loadTile(tile, tileSignal, onDecoding)),
      this.ctx.scheduler,
      {
        fadeDuration: 0,
        backstopLevels: [2, 4],
        maxRetries: 2,
        cacheBytes: this.ctx.cacheBytes,
        failureCooldownMs: 120000,
        prefetchLimit: this.ctx.prefetchLimit,
      },
      tileEvents(this.id, this.ctx),
    );
  }

  setData(data: GeoJSONData): this {
    if (typeof data !== "string" && (typeof data !== "object" || data === null)) {
      throw new MapletError("invalid-option", "setData needs GeoJSON, a URL or a file", { sourceId: this.id });
    }
    this.spec = { ...this.spec, data };
    this.version++;
    if (this.manager) {
      this.sync(false).catch((error: unknown) => {
        if (!this.controller.signal.aborted) this.ctx.error(this.loadError(error));
      });
    }
    return this;
  }

  getData(): GeoJSONData {
    return this.spec.data;
  }

  setLayers(layers: readonly StyleLayer[]): void {
    if (this.layers.update(layers)) this.manager?.refresh();
  }

  update(transform: Transform, now: number, predicted: readonly Transform[]): void {
    this.manager?.update(transform, now, predicted);
  }

  uploadPending(deadline: number, now: number): boolean {
    return this.manager?.uploadPending(deadline, now) ?? false;
  }

  isIdle(): boolean {
    return this.manager !== null && this.syncing === null && this.manager.isLoaded && !this.manager.hasPendingUploads;
  }

  isFading(): boolean {
    return false;
  }

  stats(): TileStats | null {
    return this.manager?.stats ?? null;
  }

  reload(): void {
    this.manager?.reload();
  }

  destroy(): void {
    this.controller.abort();
    this.manager?.destroy();
    this.manager = null;
    if (!this.posted) return;
    const pool = this.ctx.workers();
    if (pool.available) pool.send("geojson-remove", { source: this.key }, [], undefined, this.affinity).catch(() => {});
  }

  private sync(initial: boolean): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.syncLoop(initial).finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async syncLoop(initial: boolean): Promise<void> {
    while (this.applied !== this.version && !this.controller.signal.aborted) {
      const version = this.version;
      let summary: GeoJSONSummary;
      try {
        summary = await this.send(this.spec.data);
      } catch (error) {
        this.applied = version;
        if (this.version === version) throw this.loadError(error);
        if (!initial) this.ctx.error(this.loadError(error));
        continue;
      }
      this.applied = version;
      if (this.controller.signal.aborted) return;
      this.summary = summary;
      if (this.manager) {
        this.manager.tiling = this.tiling(this.options());
        this.manager.refresh();
      }
      if (!initial) this.ctx.content(this.id);
    }
  }

  private async send(data: GeoJSONData): Promise<GeoJSONSummary> {
    const signal = this.controller.signal;
    const request: GeoJSONLoadRequest = { source: this.key, options: this.options(), format: this.spec.format };
    const transfer: Transferable[] = [];
    if (typeof data === "string") {
      const bytes = await this.fetchData(data, signal);
      request.bytes = bytes;
      request.name = data;
      transfer.push(bytes);
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      const bytes = await data.arrayBuffer();
      request.bytes = bytes;
      request.name = (data as Blob & { name?: string }).name ?? "";
      transfer.push(bytes);
    } else {
      request.data = data;
    }
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    this.posted = true;
    return this.ctx.workers().send<GeoJSONSummary>("geojson-load", request, transfer, signal, this.affinity);
  }

  private async fetchData(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const params = resolveRequest(url, "source", this.ctx.transformRequest);
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await fetchBytes(params, signal, this.ctx.requestTimeoutMs, "source");
        if (result.kind === "empty") {
          throw new MapletError("source-error", `GeoJSON source "${this.id}" found no data at ${url}`, {
            sourceId: this.id,
            url,
          });
        }
        return result.data;
      } catch (error) {
        if (
          signal.aborted ||
          !(error instanceof FetchFailure) ||
          !error.failure.retryable ||
          attempt >= FETCH_ATTEMPTS
        ) {
          throw error;
        }
        await delay(retryDelay(attempt, error.failure), signal);
      }
    }
  }

  private async loadTile(tile: TileCoord, signal: AbortSignal, onDecoding: () => void): Promise<VectorTile | null> {
    onDecoding();
    const { programs, signature } = this.layers;
    const request: GeoJSONTileRequest = {
      source: this.key,
      z: tile.z,
      x: tile.x,
      y: tile.y,
      layers: programs,
      overzoom: tile.z >= this.options().maxZoom,
    };
    const pool = this.ctx.workers();
    let reply = await pool.send<GeoJSONTileReply>("geojson-tile", request, [], signal, this.affinity);
    if (reply.missing) {
      await this.restore();
      reply = await pool.send<GeoJSONTileReply>("geojson-tile", request, [], signal, this.affinity);
    }
    if (reply.missing) {
      throw new FetchFailure({
        kind: "decode",
        message: "The GeoJSON data is not loaded in the worker",
        retryable: false,
      });
    }
    return vectorTile(reply.tile, signature);
  }

  private restore(): Promise<void> {
    if (!this.restoring) {
      this.restoring = this.send(this.spec.data)
        .then((summary) => {
          this.summary = summary;
        })
        .finally(() => {
          this.restoring = null;
        });
    }
    return this.restoring;
  }

  private options(): GeoJSONOptions {
    const s = this.spec;
    return {
      maxZoom: Math.min(24, Math.max(0, Math.round(s.maxZoom ?? 18))),
      tolerance: Math.max(0, s.tolerance ?? 0.375),
      buffer: Math.min(512, Math.max(0, s.buffer ?? 64)),
      extent: EXTENT,
      promoteId: s.promoteId,
    };
  }

  private tiling(options: GeoJSONOptions): Tiling {
    return {
      tileSize: 512,
      minZoom: 0,
      maxZoom: options.maxZoom,
      roundZoom: false,
      bounds: this.summary?.coverage ?? NOWHERE,
      boundsPadding: options.buffer / 512,
    };
  }

  private loadError(error: unknown): MapletError {
    if (error instanceof MapletError) return error;
    if (error instanceof FetchFailure) {
      return new MapletError(
        error.failure.kind === "auth" ? "auth" : "source-error",
        `GeoJSON source "${this.id}" could not load its data: ${error.failure.message}`,
        { sourceId: this.id, failure: error.failure },
        error,
      );
    }
    return new MapletError(
      "source-error",
      `GeoJSON source "${this.id}" could not load its data: ${errorMessage(error)}`,
      { sourceId: this.id },
      error,
    );
  }
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
