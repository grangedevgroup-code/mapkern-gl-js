import type { Transform } from "../camera/transform.ts";
import { errorMessage, MapletError } from "../core/errors.ts";
import type { LngLatLike } from "../geo/mercator.ts";
import { mercatorX, mercatorY, toLngLat } from "../geo/mercator.ts";
import type { CanvasSourceSpec, ImageSourceSpec, VideoSourceSpec } from "../style/types.ts";
import { fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileStats } from "../tiles/manager.ts";
import type { MapSource, SourceContext } from "./source.ts";

export type Corners = [[number, number], [number, number], [number, number], [number, number]];

export type OverlaySpec = ImageSourceSpec | VideoSourceSpec | CanvasSourceSpec;

export interface OverlayMesh {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
}

const GRID = 16;

export class ImageSource implements MapSource {
  readonly id: string;
  readonly type: OverlaySpec["type"];
  spec: OverlaySpec;
  loaded = false;
  version = 0;
  private readonly ctx: SourceContext;
  private corners: Corners;
  private picture: ImageBitmap | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private texture: WebGLTexture | null = null;
  private mesh: OverlayMesh | null = null;
  private dirty = false;
  private request: AbortController | null = null;

  constructor(id: string, spec: OverlaySpec, ctx: SourceContext) {
    this.id = id;
    this.type = spec.type;
    this.spec = spec;
    this.ctx = ctx;
    this.corners = corners(spec.coordinates, id);
  }

  get attribution(): string | undefined {
    return this.spec.attribution;
  }

  get bounds(): [number, number, number, number] {
    const lngs = this.corners.map((c) => c[0]);
    const lats = this.corners.map((c) => c[1]);
    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  }

  getCoordinates(): Corners {
    return this.corners.map((c) => [c[0], c[1]]) as Corners;
  }

  setCoordinates(coordinates: readonly LngLatLike[]): this {
    this.corners = corners(coordinates, this.id);
    this.spec = { ...this.spec, coordinates: this.getCoordinates() } as OverlaySpec;
    this.releaseMesh();
    this.version++;
    this.ctx.changed();
    return this;
  }

  updateImage(options: { url?: string; coordinates?: readonly LngLatLike[] }): this {
    if (this.spec.type !== "image") {
      throw new MapletError("invalid-option", `updateImage works on image sources, not ${this.spec.type}`, {
        sourceId: this.id,
      });
    }
    if (options.coordinates) this.setCoordinates(options.coordinates);
    if (options.url !== undefined && options.url !== this.spec.url) {
      this.spec = { ...this.spec, url: options.url };
      this.fetchPicture(this.spec.url).catch((error: unknown) => this.ctx.error(this.failure(error)));
    }
    return this;
  }

  getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  play(): void {
    this.video?.play().catch(() => {});
    this.ctx.changed();
  }

  pause(): void {
    this.video?.pause();
  }

  async load(signal: AbortSignal): Promise<void> {
    const spec = this.spec;
    if (spec.type === "image") {
      await this.fetchPicture(spec.url, signal);
    } else if (spec.type === "video") {
      await this.openVideo(spec, signal);
    } else {
      const found = typeof spec.canvas === "string" ? document.getElementById(spec.canvas) : spec.canvas;
      if (!(found instanceof HTMLCanvasElement)) {
        throw new MapletError("source-error", `Canvas source "${this.id}" could not find its canvas`, {
          sourceId: this.id,
        });
      }
      this.canvas = found;
      this.dirty = true;
    }
    this.loaded = true;
    this.ctx.changed();
  }

  update(_transform: Transform, _now: number, _predicted: readonly Transform[]): void {}

  uploadPending(): boolean {
    const gl = this.ctx.gl;
    if (gl.isLost) return false;
    const live = this.live();
    if (!this.dirty && !live) return false;
    const pixels = this.picture ?? (this.video && this.video.readyState >= 2 ? this.video : null) ?? this.canvas;
    if (!pixels) return false;
    const g = gl.gl;
    if (!this.texture) {
      this.texture = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, this.texture);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    }
    g.bindTexture(g.TEXTURE_2D, this.texture);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, pixels);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.picture) {
      g.generateMipmap(g.TEXTURE_2D);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
      gl.applyAnisotropy();
    } else {
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    }
    this.dirty = false;
    this.version++;
    return live;
  }

  textureFor(): WebGLTexture | null {
    return this.texture;
  }

  meshFor(): OverlayMesh | null {
    if (this.mesh) return this.mesh;
    const gl = this.ctx.gl;
    if (gl.isLost) return null;
    const g = gl.gl;
    const world = this.corners.map(([lng, lat]) => [mercatorX(lng), mercatorY(lat)] as const);
    const [tl, tr, br, bl] = world as [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
    ];
    const data = new Float32Array(GRID * GRID * 6 * 4);
    let k = 0;
    const at = (u: number, v: number) => {
      const top0 = tl[0] + (tr[0] - tl[0]) * u;
      const top1 = tl[1] + (tr[1] - tl[1]) * u;
      const bot0 = bl[0] + (br[0] - bl[0]) * u;
      const bot1 = bl[1] + (br[1] - bl[1]) * u;
      data[k++] = top0 + (bot0 - top0) * v;
      data[k++] = top1 + (bot1 - top1) * v;
      data[k++] = u;
      data[k++] = v;
    };
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const u0 = i / GRID;
        const u1 = (i + 1) / GRID;
        const v0 = j / GRID;
        const v1 = (j + 1) / GRID;
        at(u0, v0);
        at(u1, v0);
        at(u1, v1);
        at(u0, v0);
        at(u1, v1);
        at(u0, v1);
      }
    }
    const vao = g.createVertexArray();
    const buffer = g.createBuffer();
    if (!vao || !buffer) return null;
    g.bindVertexArray(vao);
    g.bindBuffer(g.ARRAY_BUFFER, buffer);
    g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 16, 0);
    g.enableVertexAttribArray(1);
    g.vertexAttribPointer(1, 2, g.FLOAT, false, 16, 8);
    g.bindVertexArray(null);
    this.mesh = { vao, buffer, count: GRID * GRID * 6 };
    return this.mesh;
  }

  isIdle(): boolean {
    return this.loaded && !this.dirty;
  }

  isFading(): boolean {
    return this.live();
  }

  stats(): TileStats | null {
    return null;
  }

  reload(): void {
    this.texture = null;
    this.mesh = null;
    this.dirty = true;
  }

  destroy(): void {
    this.request?.abort();
    const gl = this.ctx.gl;
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.releaseMesh();
    this.picture?.close();
    this.picture = null;
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
      this.video = null;
    }
    this.canvas = null;
  }

  private live(): boolean {
    if (this.video) return !this.video.paused && !this.video.ended;
    if (this.canvas) return (this.spec as CanvasSourceSpec).animate !== false;
    return false;
  }

  private releaseMesh(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const gl = this.ctx.gl;
    gl.deleteBuffer(mesh.buffer);
    gl.deleteVertexArray(mesh.vao);
    this.mesh = null;
  }

  private async fetchPicture(url: string, signal?: AbortSignal): Promise<void> {
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const params = resolveRequest(url, "image", this.ctx.transformRequest);
      const result = await fetchBytes(params, controller.signal, this.ctx.requestTimeoutMs, "image");
      if (result.kind === "empty")
        throw new MapletError("source-error", `There is no image at ${url}`, { sourceId: this.id });
      const bitmap = await createImageBitmap(new Blob([result.data], { type: result.contentType || "image/png" }), {
        premultiplyAlpha: "premultiply",
      });
      if (controller.signal.aborted) {
        bitmap.close();
        return;
      }
      this.picture?.close();
      this.picture = bitmap;
      this.dirty = true;
      this.ctx.changed();
    } catch (error) {
      if (controller.signal.aborted) return;
      throw this.failure(error);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async openVideo(spec: VideoSourceSpec, signal: AbortSignal): Promise<void> {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    for (const url of spec.urls) {
      const source = document.createElement("source");
      source.src = resolveRequest(url, "image", this.ctx.transformRequest).url;
      video.appendChild(source);
    }
    this.video = video;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(
          new MapletError("source-error", `Video source "${this.id}" could not play any of its files`, {
            sourceId: this.id,
          }),
        );
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("error", failed, true);
        signal.removeEventListener("abort", failed);
      };
      video.addEventListener("loadeddata", done);
      video.addEventListener("error", failed, true);
      signal.addEventListener("abort", failed, { once: true });
      video.load();
    });
    video.addEventListener("play", () => this.ctx.changed());
    this.dirty = true;
    video.play().catch(() => {});
  }

  private failure(error: unknown): MapletError {
    if (error instanceof MapletError) return error;
    return new MapletError(
      "source-error",
      `Image source "${this.id}" could not load: ${errorMessage(error)}`,
      { sourceId: this.id },
      error,
    );
  }
}

function corners(value: readonly LngLatLike[] | undefined, id: string): Corners {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new MapletError(
      "invalid-option",
      `Source "${id}" needs four corner coordinates: top left, top right, bottom right, bottom left`,
      {
        sourceId: id,
      },
    );
  }
  return value.map((c) => toLngLat(c)) as Corners;
}
