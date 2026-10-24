import type { Transform } from "../camera/transform.ts";
import { MapletError } from "../core/errors.ts";
import type { TileCoord } from "../geo/tile.ts";
import type { RasterSourceSpec } from "../style/types.ts";
import { FetchFailure, fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileLoader, TileStats } from "../tiles/manager.ts";
import { TileManager } from "../tiles/manager.ts";
import type { MapSource, SourceContext } from "./source.ts";
import type { TileSet } from "./tilejson.ts";
import { resolveTileSet, tileUrl } from "./tilejson.ts";

export interface RasterTile {
  image: ImageBitmap | null;
  texture: WebGLTexture | null;
  width: number;
  height: number;
}

export class RasterSource implements MapSource {
  readonly id: string;
  readonly type = "raster" as const;
  spec: RasterSourceSpec;
  manager: TileManager<RasterTile> | null = null;
  tileSet: TileSet | null = null;
  private readonly ctx: SourceContext;
  private fadeDuration: number;

  constructor(id: string, spec: RasterSourceSpec, ctx: SourceContext) {
    this.id = id;
    this.spec = spec;
    this.ctx = ctx;
    this.fadeDuration = ctx.fadeDuration;
  }

  get loaded(): boolean {
    return this.manager !== null;
  }

  get attribution(): string | undefined {
    return this.tileSet?.attribution ?? this.spec.attribution;
  }

  get tileSize(): number {
    const size = this.spec.tileSize ?? 256;
    return size > 0 ? size : 256;
  }

  async load(signal: AbortSignal): Promise<void> {
    const set = await resolveTileSet(
      this.id,
      this.spec,
      { minZoom: 0, maxZoom: 22 },
      this.ctx.transformRequest,
      this.ctx.requestTimeoutMs,
      signal,
    );
    if (signal.aborted) return;
    this.tileSet = set;
    this.ctx.scheduler.setGroupLimit(this.id, 16);
    this.manager = new TileManager<RasterTile>(
      this.id,
      { tileSize: this.tileSize, minZoom: set.minZoom, maxZoom: set.maxZoom, roundZoom: true, bounds: set.bounds },
      this.loader(set),
      this.ctx.scheduler,
      {
        fadeDuration: this.fadeDuration,
        backstopLevels: 2,
        maxRetries: 3,
        cacheBytes: this.ctx.cacheBytes,
        failureCooldownMs: 120000,
        prefetchLimit: this.ctx.prefetchLimit,
      },
      {
        changed: () => this.ctx.changed(),
        failure: (failure, tile) => {
          const code = failure.kind === "auth" ? "auth" : failure.kind === "decode" ? "decode" : "tile-error";
          this.ctx.error(
            new MapletError(
              code,
              `Tile ${tile.z}/${tile.x}/${tile.y} of source "${this.id}" failed: ${failure.message}`,
              {
                sourceId: this.id,
                tile: { z: tile.z, x: tile.x, y: tile.y },
                failure,
              },
            ),
          );
        },
        wakeAt: (time) => this.ctx.wakeAt(time),
      },
    );
  }

  setFadeDuration(ms: number): void {
    this.fadeDuration = ms;
    if (this.manager) this.manager.options = { ...this.manager.options, fadeDuration: ms };
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

  private loader(set: TileSet): TileLoader<RasterTile> {
    const gl = this.ctx.gl;
    const ctx = this.ctx;
    return {
      async load(tile: TileCoord, signal: AbortSignal, onDecoding: () => void): Promise<RasterTile | null> {
        const url = tileUrl(set, tile.z, tile.x, tile.y);
        const result = await fetchBytes(
          resolveRequest(url, "tile", ctx.transformRequest),
          signal,
          ctx.requestTimeoutMs,
        );
        if (result.kind === "empty") return null;
        onDecoding();
        let image: ImageBitmap;
        try {
          const type = result.contentType.split(";")[0]?.trim() || "image/png";
          image = await createImageBitmap(new Blob([result.data], { type }), {
            premultiplyAlpha: "premultiply",
            colorSpaceConversion: "none",
          });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new FetchFailure({ kind: "decode", message: "Tile image could not be decoded", retryable: false });
        }
        if (signal.aborted) {
          image.close();
          throw new DOMException("Aborted", "AbortError");
        }
        return { image, texture: null, width: image.width, height: image.height };
      },
      needsUpload(data: RasterTile): boolean {
        return data.texture === null;
      },
      upload(data: RasterTile): void {
        if (!data.image || gl.isLost) return;
        const pow2 = isPowerOfTwo(data.width) && isPowerOfTwo(data.height);
        data.texture = gl.createTexture(data.image, { mipmap: pow2, premultiplied: false });
        data.image.close();
        data.image = null;
      },
      release(data: RasterTile): void {
        data.image?.close();
        data.image = null;
        gl.deleteTexture(data.texture);
        data.texture = null;
      },
      byteSize(data: RasterTile): number {
        const base = data.width * data.height * 4;
        return data.texture ? Math.round(base * 1.34) : base;
      },
    };
  }
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}
