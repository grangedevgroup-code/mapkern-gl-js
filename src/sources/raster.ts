import type { Transform } from "../camera/transform.ts";
import type { TileCoord } from "../geo/tile.ts";
import type { RasterSourceSpec } from "../style/types.ts";
import { bodyBytes, FetchFailure, fetchBody, fetchBytes, resolveRequest, savedCopyFailed } from "../tiles/fetch.ts";
import type { TileLoader, TileStats, UploadBudget } from "../tiles/manager.ts";
import { TileManager } from "../tiles/manager.ts";
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
        const params = resolveRequest(url, "tile", ctx.transformRequest);
        const result = await fetchBody(params, signal, ctx.requestTimeoutMs, "tile", ctx.diskCache);
        if (result.kind === "empty") return null;
        const { body } = result;
        let fingerprint: number | null = null;
        const peers = placeholders.peers(tile, body instanceof Blob ? body.size : body.byteLength);
        if (peers) {
          for (const peer of peers) {
            const copy = await fetchBytes(
              resolveRequest(tileUrl(set, peer.z, peer.x, peer.y), "tile", ctx.transformRequest),
              signal,
              ctx.requestTimeoutMs,
              "tile",
              ctx.diskCache,
            ).catch(() => null);
            if (copy?.kind === "data") placeholders.note(peer, copy.data);
          }
          fingerprint = placeholders.note(tile, await bodyBytes(body));
          if (fingerprint === null) return null;
        }
        onDecoding();
        let image: ImageBitmap;
        try {
          image = await createImageBitmap(imageBlob(body, result.contentType), {
            premultiplyAlpha: "premultiply",
            colorSpaceConversion: "none",
          });
        } catch (error) {
          if (signal.aborted) throw error;
          if (result.saved) throw savedCopyFailed(params.url, ctx.diskCache);
          throw new FetchFailure({ kind: "decode", message: "Tile image could not be decoded", retryable: false });
        }
        if (signal.aborted) {
          image.close();
          throw new DOMException("Aborted", "AbortError");
        }
        if (fingerprint !== null && placeholders.suspect(tile, fingerprint) && !isFlat(image)) {
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

function imageBlob(body: ArrayBuffer | Blob, contentType: string): Blob {
  const type = contentType.split(";")[0]?.trim() || "image/png";
  if (!(body instanceof Blob)) return new Blob([body], { type });
  return body.type ? body : body.slice(0, body.size, type);
}

export class Placeholders {
  private readonly keys = new Map<string, number>();
  private readonly twins = new Map<number, Map<string, number>>();
  private readonly known = new Set<number>();
  private readonly sizes = new Map<number, TileCoord[]>();
  private readonly knownSizes = new Set<number>();
  private readonly sizeOf = new Map<number, number>();
  private readonly forget: (z: number, x: number, y: number) => void;

  constructor(forget: (z: number, x: number, y: number) => void) {
    this.forget = forget;
  }

  peers(tile: TileCoord, size: number): TileCoord[] | null {
    let list = this.sizes.get(size);
    if (!list) {
      list = [];
      this.sizes.set(size, list);
      if (this.sizes.size > 8192) this.sizes.delete(this.sizes.keys().next().value!);
    }
    const others = list.filter((t) => t.z !== tile.z || t.x !== tile.x || t.y !== tile.y);
    const check = this.knownSizes.has(size) || others.some((t) => t.z !== tile.z);
    if (others.length === list.length && list.length < 16) list.push({ z: tile.z, x: tile.x, y: tile.y });
    if (!check) return null;
    return others.filter((t) => !this.keys.has(`${t.z}/${t.x}/${t.y}`));
  }

  note(tile: TileCoord, data: ArrayBuffer): number | null {
    const hash = fingerprint(new Uint8Array(data));
    this.sizeOf.set(hash, data.byteLength);
    if (this.sizeOf.size > 8192) this.sizeOf.delete(this.sizeOf.keys().next().value!);
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    this.keys.delete(key);
    this.keys.set(key, hash);
    if (this.keys.size > 8192) this.keys.delete(this.keys.keys().next().value!);
    if (this.known.has(hash)) return null;
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
    const size = this.sizeOf.get(hash);
    if (size !== undefined) this.knownSizes.add(size);
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
