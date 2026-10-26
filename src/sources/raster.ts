import type { Transform } from "../camera/transform.ts";
import type { TileCoord } from "../geo/tile.ts";
import type { RasterSourceSpec } from "../style/types.ts";
import { FetchFailure, fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileLoader, TileStats } from "../tiles/manager.ts";
import { TileManager } from "../tiles/manager.ts";
import type { MapSource, SourceContext } from "./source.ts";
import { tileEvents } from "./source.ts";
import type { TileSet } from "./tilejson.ts";
import { archiveSpec, lngLatBounds, resolveTileSet, tileUrl } from "./tilejson.ts";

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

  async load(signal: AbortSignal): Promise<void> {
    const set = await resolveTileSet(
      this.id,
      archiveSpec(this.spec),
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
        backstopLevels: [2, 4],
        maxRetries: 3,
        cacheBytes: this.ctx.cacheBytes,
        failureCooldownMs: 120000,
        prefetchLimit: this.ctx.prefetchLimit,
      },
      tileEvents(this.id, this.ctx),
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
    const placeholders = new Placeholders((z, x, y) => this.manager?.forget(z, x, y));
    return {
      async load(tile: TileCoord, signal: AbortSignal, onDecoding: () => void): Promise<RasterTile | null> {
        const url = tileUrl(set, tile.z, tile.x, tile.y);
        const result = await fetchBytes(
          resolveRequest(url, "tile", ctx.transformRequest),
          signal,
          ctx.requestTimeoutMs,
        );
        if (result.kind === "empty") return null;
        const fingerprint = placeholders.note(tile, result.data);
        if (fingerprint === null) return null;
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
        if (placeholders.suspect(tile, fingerprint) && !isFlat(image)) {
          placeholders.confirm(fingerprint, tile);
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

  note(tile: TileCoord, data: ArrayBuffer): number | null {
    const hash = fingerprint(new Uint8Array(data));
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

function fingerprint(bytes: Uint8Array): number {
  let h = 0x811c9dc5 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
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
