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

export type WorldRect = readonly [number, number, number, number];

export interface OverlayMesh {
  readonly vao: WebGLVertexArrayObject;
  readonly buffer: WebGLBuffer;
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

const UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

export class ImageSource implements MapSource {
  readonly id: string;
  readonly type: OverlaySpec["type"];
  spec: OverlaySpec;
  loaded = false;
  version = 0;
  private readonly ctx: SourceContext;
  private corners: Corners;
  private world: WorldRect;
  private picture: ImageBitmap | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private animate: boolean;
  private texture: WebGLTexture | null = null;
  private mesh: OverlayMesh | null = null;
  private dirty = false;
  private frameDriven = false;
  private frameRequest = 0;
  private oversize = false;
  private request: AbortController | null = null;

  constructor(id: string, spec: OverlaySpec, ctx: SourceContext) {
    this.id = id;
    this.type = spec.type;
    this.spec = spec;
    this.ctx = ctx;
    this.corners = corners(spec.coordinates, id);
    this.world = worldRect(this.corners);
    this.animate = spec.type === "canvas" && spec.animate !== false;
  }

  get attribution(): string | undefined {
    return this.spec.attribution;
  }

  get bounds(): WorldRect {
    return this.world;
  }

  getCoordinates(): Corners {
    return this.corners.map((c) => [c[0], c[1]]) as Corners;
  }

  setCoordinates(coordinates: readonly LngLatLike[]): this {
    this.corners = corners(coordinates, this.id);
    this.world = worldRect(this.corners);
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
      this.fetchPicture(this.spec.url, this.begin()).catch((error: unknown) => this.ctx.error(this.failure(error)));
    }
    return this;
  }

  getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  play(): void {
    if (this.video) this.video.play().catch(() => {});
    else if (this.canvas) this.animate = true;
    this.ctx.changed();
  }

  pause(): void {
    if (this.video) {
      this.video.pause();
      return;
    }
    if (!this.canvas) return;
    this.animate = false;
    this.dirty = true;
    this.ctx.changed();
  }

  async load(signal: AbortSignal): Promise<void> {
    const own = this.begin();
    const abort = () => own.abort(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const spec = this.spec;
      if (spec.type === "image") await this.fetchPicture(spec.url, own);
      else if (spec.type === "video") await this.openVideo(spec, own.signal);
      else this.findCanvas(spec);
    } finally {
      signal.removeEventListener("abort", abort);
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
    const pixels = this.pixels();
    if (!pixels) return live;
    const [width, height] = pixelSize(pixels);
    if (width > gl.maxTextureSize || height > gl.maxTextureSize) {
      this.dirty = false;
      if (!this.oversize) {
        this.oversize = true;
        this.ctx.error(
          new MapletError(
            "source-error",
            `Source "${this.id}" is ${width}×${height} pixels, larger than this device can draw (${gl.maxTextureSize})`,
            { sourceId: this.id },
          ),
        );
      }
      return false;
    }
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
    const [x0, y0, x1, y1] = this.world;
    const span = Math.max(x1 - x0, y1 - y0);
    if (!(span > 0)) return null;
    const points = this.corners.map(([lng, lat]) => [mercatorX(lng), mercatorY(lat)] as const);
    const weights = projectiveWeights(points);
    const data = new Float32Array(20);
    for (let i = 0; i < 4; i++) {
      const [px, py] = points[i]!;
      const [u, v] = UV[i]!;
      const q = weights[i]!;
      data.set([(px - x0) / span, (py - y0) / span, u * q, v * q, q], i * 5);
    }
    const g = gl.gl;
    const vao = g.createVertexArray();
    if (!vao) return null;
    g.bindVertexArray(vao);
    const buffer = gl.createBuffer(g.ARRAY_BUFFER, data);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 20, 0);
    g.enableVertexAttribArray(1);
    g.vertexAttribPointer(1, 3, g.FLOAT, false, 20, 8);
    g.bindVertexArray(null);
    this.mesh = { vao, buffer, z: -Math.log2(span), x: x0 / span, y: y0 / span };
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
    this.request = null;
    const gl = this.ctx.gl;
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.releaseMesh();
    this.picture?.close();
    this.picture = null;
    const video = this.video;
    if (video) {
      if (this.frameRequest) video.cancelVideoFrameCallback(this.frameRequest);
      this.frameRequest = 0;
      video.pause();
      video.replaceChildren();
      video.removeAttribute("src");
      video.load();
      this.video = null;
    }
    this.canvas = null;
  }

  private live(): boolean {
    const video = this.video;
    if (video) return !this.frameDriven && !video.paused && !video.ended;
    return this.canvas !== null && this.animate;
  }

  private pixels(): TexImageSource | null {
    if (this.picture) return this.picture;
    if (this.video) return this.video.readyState >= 2 ? this.video : null;
    return this.canvas;
  }

  private begin(): AbortController {
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    return controller;
  }

  private readonly refresh = () => {
    this.dirty = true;
    this.ctx.changed();
  };

  private releaseMesh(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const gl = this.ctx.gl;
    gl.deleteBuffer(mesh.buffer);
    gl.deleteVertexArray(mesh.vao);
    this.mesh = null;
  }

  private findCanvas(spec: CanvasSourceSpec): void {
    const found = typeof spec.canvas === "string" ? document.getElementById(spec.canvas) : spec.canvas;
    if (!(found instanceof HTMLCanvasElement)) {
      throw new MapletError("source-error", `Canvas source "${this.id}" could not find its canvas`, {
        sourceId: this.id,
      });
    }
    this.canvas = found;
    this.dirty = true;
  }

  private async fetchPicture(url: string, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    try {
      const params = resolveRequest(url, "image", this.ctx.transformRequest);
      const result = await fetchBytes(params, signal, this.ctx.requestTimeoutMs, "image");
      if (result.kind === "empty")
        throw new MapletError("source-error", `There is no image at ${url}`, { sourceId: this.id });
      const type = result.contentType.split(";")[0]?.trim() || "image/png";
      let bitmap = await createImageBitmap(new Blob([result.data], { type }), {
        premultiplyAlpha: "premultiply",
        colorSpaceConversion: "none",
      });
      const limit = this.ctx.gl.maxTextureSize;
      if (bitmap.width > limit || bitmap.height > limit) {
        const scale = limit / Math.max(bitmap.width, bitmap.height);
        const fitted = await createImageBitmap(bitmap, {
          resizeWidth: Math.max(1, Math.floor(bitmap.width * scale)),
          resizeHeight: Math.max(1, Math.floor(bitmap.height * scale)),
          resizeQuality: "high",
        });
        bitmap.close();
        bitmap = fitted;
      }
      if (signal.aborted) {
        bitmap.close();
        throw signal.reason;
      }
      this.picture?.close();
      this.picture = bitmap;
      this.refresh();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw this.failure(error);
    }
  }

  private async openVideo(spec: VideoSourceSpec, signal: AbortSignal): Promise<void> {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    const files = spec.urls.map((url) => {
      const file = document.createElement("source");
      file.src = resolveRequest(url, "image", this.ctx.transformRequest).url;
      video.appendChild(file);
      return file;
    });
    this.video = video;
    await new Promise<void>((resolve, reject) => {
      let failures = 0;
      const settle = (error?: unknown) => {
        video.removeEventListener("loadeddata", ready);
        video.removeEventListener("error", broken);
        for (const file of files) file.removeEventListener("error", missing);
        signal.removeEventListener("abort", aborted);
        if (error === undefined) resolve();
        else reject(error);
      };
      const fail = (message: string) => settle(new MapletError("source-error", message, { sourceId: this.id }));
      const ready = () => settle();
      const missing = () => {
        failures++;
        if (failures === files.length) fail(`Video source "${this.id}" could not play any of its files`);
      };
      const broken = () =>
        fail(`Video source "${this.id}" could not play: ${video.error?.message || "the video could not be decoded"}`);
      const aborted = () => settle(signal.reason);
      video.addEventListener("loadeddata", ready);
      video.addEventListener("error", broken);
      for (const file of files) file.addEventListener("error", missing);
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
      video.load();
    });
    video.addEventListener("play", this.refresh);
    video.addEventListener("seeked", this.refresh);
    if (typeof video.requestVideoFrameCallback === "function") {
      this.frameDriven = true;
      const next = () => {
        this.frameRequest = video.requestVideoFrameCallback(() => {
          this.refresh();
          next();
        });
      };
      next();
    }
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

export function overlayWraps(bounds: WorldRect, region: WorldRect, copies: boolean): number[] {
  const [x0, y0, x1, y1] = bounds;
  const [rx0, ry0, rx1, ry1] = region;
  if (y0 >= ry1 || y1 <= ry0) return [];
  if (!copies) return x0 < rx1 && x1 > rx0 ? [0] : [];
  const out: number[] = [];
  for (let wrap = Math.floor(rx0 - x1); wrap <= Math.ceil(rx1 - x0); wrap++) {
    if (wrap + x0 < rx1 && wrap + x1 > rx0) out.push(wrap);
  }
  return out;
}

export function projectiveWeights(points: readonly (readonly [number, number])[]): number[] {
  const [p0, p1, p2, p3] = points as [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  const ax = p2[0] - p0[0];
  const ay = p2[1] - p0[1];
  const bx = p3[0] - p1[0];
  const by = p3[1] - p1[1];
  const cross = ax * by - ay * bx;
  if (Math.abs(cross) < 1e-30) return [1, 1, 1, 1];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const t = (dx * by - dy * bx) / cross;
  const s = (dx * ay - dy * ax) / cross;
  if (!(t > 0 && t < 1 && s > 0 && s < 1)) return [1, 1, 1, 1];
  return [1 / (1 - t), 1 / (1 - s), 1 / t, 1 / s];
}

function pixelSize(pixels: TexImageSource): [number, number] {
  if (pixels instanceof HTMLVideoElement) return [pixels.videoWidth, pixels.videoHeight];
  return [(pixels as { width: number }).width, (pixels as { height: number }).height];
}

function worldRect(corners: Corners): WorldRect {
  const xs = corners.map((c) => mercatorX(c[0]));
  const ys = corners.map((c) => mercatorY(c[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function corners(value: readonly LngLatLike[] | undefined, id: string): Corners {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new MapletError(
      "invalid-option",
      `Source "${id}" needs four corner coordinates: top left, top right, bottom right, bottom left`,
      { sourceId: id },
    );
  }
  return value.map((c) => toLngLat(c)) as Corners;
}
