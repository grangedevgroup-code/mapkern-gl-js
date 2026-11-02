import type { Transform } from "../camera/transform.ts";
import type { TileCoord } from "../geo/tile.ts";
import type { RasterSourceSpec } from "../style/types.ts";
import { FetchFailure, fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileLoader, TileStats, UploadBudget } from "../tiles/manager.ts";
import { TileManager } from "../tiles/manager.ts";
import type { WorkerPool } from "../worker/pool.ts";
import type { RasterReply } from "../worker/raster-task.ts";
import { decodeRaster, NOT_AN_IMAGE } from "../worker/raster-task.ts";
import type { MapSource, SourceContext } from "./source.ts";
import { sourceFailure, tileEvents } from "./source.ts";
import type { TileSet } from "./tilejson.ts";
import { archiveSpec, lngLatBounds, resolveTileSet, TileSetTarget, tileUrl, withTiles, withUrl } from "./tilejson.ts";

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

  get bounds(): [number, number, number, number] | null {
    return lngLatBounds(this.tileSet);
  }

  get tileSize(): number {
    const size = this.spec.tileSize ?? 256;
    return size > 0 ? size : 256;
  }

  private readonly target = new TileSetTarget(
    (signal) =>
      resolveTileSet(
        this.id,
        archiveSpec(this.spec),
        { minZoom: 0, maxZoom: 22 },
        this.ctx.transformRequest,
        this.ctx.requestTimeoutMs,
        signal,
        this.ctx.diskCache,
      ),
    (set) => this.start(set),
    (error) => this.ctx.error(sourceFailure(this.id, error)),
  );

  load(signal: AbortSignal): Promise<void> {
    return this.target.load(signal);
  }

  setTiles(tiles: readonly string[]): this {
    this.spec = withTiles(this.spec, tiles);
    this.target.retarget();
    return this;
  }

  setUrl(url: string): this {
    this.spec = withUrl(this.spec, url);
    this.target.retarget();
    return this;
  }

  private start(set: TileSet): void {
    const previous = this.manager;
    this.tileSet = set;
    this.ctx.scheduler.setGroupLimit(this.id, 16);
    previous?.destroy();
    this.manager = new TileManager<RasterTile>(
      this.id,
      { tileSize: this.tileSize, minZoom: set.minZoom, maxZoom: set.maxZoom, roundZoom: true, bounds: set.bounds },
      this.loader(set),
      this.ctx.scheduler,
      {
        fadeDuration: this.fadeDuration,
        backstopLevels: [2, 4],
        maxRetries: 3,
        cacheBytes: this.ctx.cacheBytes,
        failureCooldownMs: 120000,
        prefetchLimit: this.ctx.prefetchLimit,
      },
      tileEvents(this.id, this.ctx),
    );
    if (previous) this.ctx.content(this.id);
  }

  setFadeDuration(ms: number): void {
    this.fadeDuration = ms;
    if (this.manager) this.manager.options = { ...this.manager.options, fadeDuration: ms };
  }

  update(transform: Transform, now: number, predicted: readonly Transform[]): void {
    this.manager?.update(transform, now, predicted);
  }

  uploadPending(budget: UploadBudget, now: number): boolean {
    return this.manager?.uploadPending(budget, now) ?? false;
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
    const placeholders = new Placeholders((z, x, y) => this.manager?.forget(z, x, y));
    return {
      async load(tile: TileCoord, signal: AbortSignal, onDecoding: () => void): Promise<RasterTile | null> {
        const url = tileUrl(set, tile.z, tile.x, tile.y);
        const result = await fetchBytes(
          resolveRequest(url, "tile", ctx.transformRequest),
          signal,
          ctx.requestTimeoutMs,
          "tile",
          ctx.diskCache,
        );
        if (result.kind === "empty") return null;
        onDecoding();
        let decoded: RasterReply;
        try {
          decoded = await decodeImage(ctx, result.data, result.contentType, signal);
        } catch (error) {
          if (signal.aborted || error instanceof FetchFailure) throw error;
          throw new FetchFailure({ kind: "decode", message: NOT_AN_IMAGE, retryable: false });
        }
        const { image, hash } = decoded;
        if (signal.aborted) {
          image.close();
          throw new DOMException("Aborted", "AbortError");
        }
        if (placeholders.note(tile, hash) === null) {
          image.close();
          return null;
        }
        if (placeholders.suspect(tile, hash) && !isFlat(image)) {
          placeholders.confirm(hash, tile);
          image.close();
          return null;
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

export class Placeholders {
  private readonly keys = new Map<string, number>();
  private readonly twins = new Map<number, Map<string, number>>();
  private readonly known = new Set<number>();
  private readonly forget: (z: number, x: number, y: number) => void;

  constructor(forget: (z: number, x: number, y: number) => void) {
    this.forget = forget;
  }

  note(tile: TileCoord, hash: number): number | null {
    if (this.known.has(hash)) return null;
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    this.keys.delete(key);
    this.keys.set(key, hash);
    if (this.keys.size > 8192) this.keys.delete(this.keys.keys().next().value!);
    let twins = this.twins.get(hash);
    if (!twins) {
      twins = new Map();
      this.twins.set(hash, twins);
      if (this.twins.size > 8192) this.twins.delete(this.twins.keys().next().value!);
    }
    if (twins.size < 16) twins.set(key, tile.z);
    return hash;
  }

  suspect(tile: TileCoord, hash: number): boolean {
    const twins = this.twins.get(hash);
    if (!twins || twins.size < 2 || tile.z === 0) return false;
    for (const z of twins.values()) if (z !== tile.z) return true;
    return false;
  }

  confirm(hash: number, tile: TileCoord): void {
    this.known.add(hash);
    const current = `${tile.z}/${tile.x}/${tile.y}`;
    for (const key of this.twins.get(hash)?.keys() ?? []) {
      if (key === current) continue;
      const [z, x, y] = key.split("/").map(Number) as [number, number, number];
      this.forget(z, x, y);
    }
  }
}

const workerDecodes = new WeakMap<WorkerPool, boolean>();

async function decodeImage(
  ctx: SourceContext,
  bytes: ArrayBuffer,
  contentType: string,
  signal: AbortSignal,
): Promise<RasterReply> {
  const type = contentType.split(";")[0]?.trim() || "image/png";
  const pool = ctx.workers();
  const works = workerDecodes.get(pool);
  if (works === false || !pool.available) return decodeRaster({ bytes, type }, signal);
  const spare = works === undefined ? bytes.slice(0) : null;
  try {
    const reply = await pool.send<RasterReply>("raster", { bytes, type }, [bytes], signal);
    workerDecodes.set(pool, true);
    return reply;
  } catch (error) {
    if (signal.aborted) throw error;
    if (spare) {
      const reply = await decodeRaster({ bytes: spare, type }, signal);
      workerDecodes.set(pool, false);
      return reply;
    }
    if (error instanceof Error && error.message === NOT_AN_IMAGE) throw error;
    workerDecodes.set(pool, false);
    throw new FetchFailure({ kind: "network", message: "The map worker stopped", retryable: true });
  }
}

function isFlat(image: ImageBitmap): boolean {
  const size = 16;
  let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    context = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true });
  } else if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!context) return true;
  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  for (let i = 4; i < pixels.length; i += 4) {
    for (let c = 0; c < 4; c++) if (Math.abs(pixels[i + c]! - pixels[c]!) > 3) return false;
  }
  return true;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}
