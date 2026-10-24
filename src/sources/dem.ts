import type { Transform } from "../camera/transform.ts";
import type { LngLatLike } from "../geo/mercator.ts";
import { clampLatitude, mercatorX, mercatorY, toLngLat } from "../geo/mercator.ts";
import type { TileCoord } from "../geo/tile.ts";
import type { DemSourceSpec } from "../style/types.ts";
import type { DemGrid, Unpack } from "../terrain/dem.ts";
import { backfill, frameStrips, NEIGHBORS, sampleElevation, unpackFor, writeFrame } from "../terrain/dem.ts";
import { fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileLoader, TileStats } from "../tiles/manager.ts";
import { TileManager } from "../tiles/manager.ts";
import type { DemReply, DemRequest } from "../worker/dem-task.ts";
import type { MapSource, SourceContext } from "./source.ts";
import { tileEvents } from "./source.ts";
import type { TileSet } from "./tilejson.ts";
import { archiveSpec, resolveTileSet, tileUrl } from "./tilejson.ts";

export interface DemTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly grid: DemGrid;
  gradient: Float32Array | null;
  gradientTexture: WebGLTexture | null;
  maskTexture: WebGLTexture | null;
}

export class DemSource implements MapSource {
  readonly id: string;
  readonly type = "dem" as const;
  spec: DemSourceSpec;
  manager: TileManager<DemTile> | null = null;
  tileSet: TileSet | null = null;
  private readonly ctx: SourceContext;
  private readonly unpack: Unpack;

  constructor(id: string, spec: DemSourceSpec, ctx: SourceContext) {
    this.id = id;
    this.spec = spec;
    this.ctx = ctx;
    this.unpack = unpackFor(spec.encoding);
  }

  get loaded(): boolean {
    return this.manager !== null;
  }

  get attribution(): string | undefined {
    return this.tileSet?.attribution ?? this.spec.attribution;
  }

  get tileSize(): number {
    const size = this.spec.tileSize ?? 512;
    return size > 0 ? size : 512;
  }

  async load(signal: AbortSignal): Promise<void> {
    const set = await resolveTileSet(
      this.id,
      archiveSpec(this.spec),
      { minZoom: 0, maxZoom: 15 },
      this.ctx.transformRequest,
      this.ctx.requestTimeoutMs,
      signal,
    );
    if (signal.aborted) return;
    this.tileSet = set;
    this.ctx.scheduler.setGroupLimit(this.id, 12);
    this.manager = new TileManager<DemTile>(
      this.id,
      { tileSize: this.tileSize, minZoom: set.minZoom, maxZoom: set.maxZoom, roundZoom: true, bounds: set.bounds },
      this.loader(set),
      this.ctx.scheduler,
      {
        fadeDuration: this.ctx.fadeDuration,
        backstopLevels: [2, 4],
        maxRetries: 3,
        cacheBytes: this.ctx.cacheBytes,
        failureCooldownMs: 120000,
        prefetchLimit: this.ctx.prefetchLimit,
      },
      tileEvents(this.id, this.ctx),
    );
  }

  elevationAt(lngLat: LngLatLike): number | null {
    const manager = this.manager;
    if (!manager) return null;
    const [lng, lat] = toLngLat(lngLat);
    const wx = mercatorX(lng);
    const x = wx - Math.floor(wx);
    const y = mercatorY(clampLatitude(lat));
    for (let z = manager.tiling.maxZoom; z >= manager.tiling.minZoom; z--) {
      const n = 2 ** z;
      const tx = Math.min(n - 1, Math.floor(x * n));
      const ty = Math.min(n - 1, Math.floor(y * n));
      const tile = manager.getTile(z, tx, ty);
      if (tile?.isReady && tile.data) return sampleElevation(tile.data.grid, x * n - tx, y * n - ty);
    }
    return null;
  }

  update(transform: Transform, now: number, predicted: readonly Transform[]): void {
    this.manager?.update(transform, now, predicted);
  }

  uploadPending(deadline: number, now: number): boolean {
    return this.manager?.uploadPending(deadline, now) ?? false;
  }

  isIdle(): boolean {
    return this.manager ? this.manager.isLoaded && !this.manager.hasPendingUploads : false;
  }

  isFading(): boolean {
    return this.manager?.isFading ?? false;
  }

  stats(): TileStats | null {
    return this.manager?.stats ?? null;
  }

  reload(): void {
    this.manager?.reload();
  }

  destroy(): void {
    this.manager?.destroy();
    this.manager = null;
  }

  private stitch(data: DemTile): void {
    const manager = this.manager;
    if (!manager) return;
    const n = 2 ** data.z;
    for (const [dx, dy] of NEIGHBORS) {
      const y = data.y + dy;
      if (y < 0 || y >= n) continue;
      const x = (((data.x + dx) % n) + n) % n;
      const other = manager.getTile(data.z, x, y)?.data ?? null;
      if (!other || !backfill(data.grid, other.grid, dx, dy) || other === data) continue;
      backfill(other.grid, data.grid, -dx, -dy);
      this.refreshFrame(other);
    }
  }

  private refreshFrame(data: DemTile): void {
    const texture = data.gradientTexture;
    if (data.gradient) writeFrame(data.grid, data.gradient);
    if (!texture) return;
    for (const strip of frameStrips(data.grid)) {
      this.ctx.gl.updateDataTexture(texture, strip.x, strip.y, strip.width, strip.height, "rg16f", strip.data);
    }
  }

  private loader(set: TileSet): TileLoader<DemTile> {
    const gl = this.ctx.gl;
    const ctx = this.ctx;
    const unpack = this.unpack;
    return {
      load: async (tile: TileCoord, signal: AbortSignal, onDecoding: () => void): Promise<DemTile | null> => {
        const url = tileUrl(set, tile.z, tile.x, tile.y);
        const result = await fetchBytes(
          resolveRequest(url, "tile", ctx.transformRequest),
          signal,
          ctx.requestTimeoutMs,
        );
        if (result.kind === "empty") return null;
        onDecoding();
        const request: DemRequest = { bytes: result.data, unpack };
        const reply = await ctx
          .workers()
          .send<DemReply | null>("dem", request, [result.data], signal, tile.x + tile.y);
        if (!reply) return null;
        return {
          z: tile.z,
          x: tile.x,
          y: tile.y,
          grid: reply.grid,
          gradient: reply.gradient,
          gradientTexture: null,
          maskTexture: null,
        };
      },
      needsUpload: (data: DemTile): boolean => data.gradient !== null,
      upload: (data: DemTile): void => {
        const gradient = data.gradient;
        if (!gradient || gl.isLost) return;
        this.stitch(data);
        writeFrame(data.grid, gradient);
        const n = data.grid.size + 2;
        data.gradientTexture = gl.createDataTexture(n, n, "rg16f", gradient, true);
        const mask = data.grid.mask;
        if (mask) data.maskTexture = gl.createDataTexture(data.grid.size, data.grid.size, "r8", mask, true);
        data.gradient = null;
      },
      release: (data: DemTile): void => {
        gl.deleteTexture(data.gradientTexture);
        gl.deleteTexture(data.maskTexture);
        data.gradientTexture = null;
        data.maskTexture = null;
        data.gradient = null;
      },
      byteSize: (data: DemTile): number => {
        const size = data.grid.size;
        const cpu = data.grid.elevation.byteLength + (data.grid.mask?.byteLength ?? 0) + (data.gradient?.byteLength ?? 0);
        const gpu = (data.gradientTexture ? (size + 2) ** 2 * 4 : 0) + (data.maskTexture ? size * size : 0);
        return cpu + gpu;
      },
    };
  }
}
