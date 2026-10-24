import type { CameraMotion, CameraState, Easing } from "../camera/animation.ts";
import { easeInOutCubic, easeMotion, easeOutCubic, flyMotion, readState } from "../camera/animation.ts";
import { Transform } from "../camera/transform.ts";
import type { LngLat, LngLatLike } from "../geo/mercator.ts";
import { latFromMercatorY, lngFromMercatorX, mercatorX, mercatorY, toLngLat, wrapLongitude } from "../geo/mercator.ts";
import type { InputOptions } from "../input/handlers.ts";
import { InputHandlers } from "../input/handlers.ts";
import { GL } from "../render/gl.ts";
import { Painter } from "../render/painter.ts";
import { GeoJSONSource } from "../sources/geojson.ts";
import { registerMbtilesProtocol } from "../sources/mbtiles.ts";
import { registerPmtilesProtocol } from "../sources/pmtiles.ts";
import { RasterSource } from "../sources/raster.ts";
import type { MapSource, SourceContext } from "../sources/source.ts";
import { VectorSource } from "../sources/vector.ts";
import type { StyleLayer } from "../style/layer.ts";
import { Style } from "../style/style.ts";
import type { LayerSpec, SourceSpec, StyleSpec } from "../style/types.ts";
import type { TransformRequest } from "../tiles/fetch.ts";
import { fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileStats } from "../tiles/manager.ts";
import { RequestScheduler } from "../tiles/scheduler.ts";
import type { Control, ControlPosition } from "../ui/controls.ts";
import { AttributionControl } from "../ui/controls.ts";
import { injectStyles } from "../ui/css.ts";
import type { WorkerFactory } from "../worker/pool.ts";
import { WorkerPool } from "../worker/pool.ts";
import { errorMessage, MapletError } from "./errors.ts";
import { Emitter } from "./events.ts";

export interface MapOptions {
  container: HTMLElement | string;
  style?: StyleSpec | string;
  center?: LngLatLike;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  minZoom?: number;
  maxZoom?: number;
  minPitch?: number;
  maxPitch?: number;
  renderWorldCopies?: boolean;
  interactive?: boolean;
  dragPan?: boolean;
  dragRotate?: boolean;
  scrollZoom?: boolean;
  doubleClickZoom?: boolean;
  touchZoomRotate?: boolean;
  touchPitch?: boolean;
  keyboard?: boolean;
  pixelRatio?: number;
  maxPixelRatio?: number;
  antialias?: boolean;
  preserveDrawingBuffer?: boolean;
  fadeDuration?: number;
  tileCacheSize?: number;
  maxParallelRequests?: number;
  requestTimeout?: number;
  prefetch?: boolean;
  transformRequest?: TransformRequest;
  attributionControl?: boolean | { custom?: string | string[] };
  workerCount?: number;
  workerUrl?: string;
  reducedMotion?: boolean;
  locale?: Partial<Record<UiText, string>>;
}

export type UiText = "zoomIn" | "zoomOut" | "resetNorth" | "map";

const DEFAULT_TEXT: Record<UiText, string> = {
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  resetNorth: "Reset bearing to north",
  map: "Map",
};

export interface CameraOptions {
  center?: LngLatLike;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  around?: LngLatLike;
}

export interface AnimationOptions {
  duration?: number;
  easing?: Easing;
  animate?: boolean;
}

export interface FlyToOptions extends CameraOptions, AnimationOptions {
  curve?: number;
  speed?: number;
  screenSpeed?: number;
  maxDuration?: number;
}

export interface FitBoundsOptions extends AnimationOptions {
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  maxZoom?: number;
  bearing?: number;
  pitch?: number;
  linear?: boolean;
}

export type BoundsLike = [[number, number], [number, number]] | [number, number, number, number];

export type Source = RasterSource | VectorSource | GeoJSONSource;

export interface MapEvent {
  readonly target: MapletMap;
  readonly type: string;
}

export interface MapMoveEvent extends MapEvent {
  readonly originalEvent?: Event | undefined;
}

export interface MapPointerEvent extends MapEvent {
  readonly point: { x: number; y: number };
  readonly lngLat: LngLat | null;
  readonly originalEvent: MouseEvent;
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

export interface MapErrorEvent extends MapEvent {
  readonly error: MapletError;
  readonly sourceId?: string | undefined;
}

export interface SourceDataEvent extends MapEvent {
  readonly sourceId: string;
  readonly kind: "metadata" | "content" | "error";
}

export interface MapEvents {
  load: MapEvent;
  styleload: MapEvent;
  idle: MapEvent;
  render: MapEvent;
  resize: MapEvent;
  remove: MapEvent;
  movestart: MapMoveEvent;
  move: MapMoveEvent;
  moveend: MapMoveEvent;
  zoomstart: MapMoveEvent;
  zoom: MapMoveEvent;
  zoomend: MapMoveEvent;
  rotatestart: MapMoveEvent;
  rotate: MapMoveEvent;
  rotateend: MapMoveEvent;
  pitchstart: MapMoveEvent;
  pitch: MapMoveEvent;
  pitchend: MapMoveEvent;
  error: MapErrorEvent;
  sourcedata: SourceDataEvent;
  click: MapPointerEvent;
  dblclick: MapPointerEvent;
  contextmenu: MapPointerEvent;
  mousemove: MapPointerEvent;
  mousedown: MapPointerEvent;
  mouseup: MapPointerEvent;
  mouseout: MapPointerEvent;
  contextlost: MapEvent;
  contextrestored: MapEvent;
}

export interface Diagnostics {
  frames: number;
  frameTime: { p50: number; p95: number; p99: number; max: number };
  longFrames: number;
  drawCalls: number;
  renderedPieces: number;
  requests: { active: number; queued: number };
  workers: { size: number; queued: number };
  sources: Record<string, TileStats | null>;
  blankRatio: number;
  canvas: { width: number; height: number; pixelRatio: number };
  contextLost: boolean;
}

interface CameraFlags {
  zoom: boolean;
  rotate: boolean;
  pitch: boolean;
}

const FRAME_SAMPLES = 240;

export class MapletMap extends Emitter<MapEvents> {
  readonly transform: Transform;
  private readonly container: HTMLElement;
  private readonly canvasContainer: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly controlCorners = new Map<ControlPosition, HTMLElement>();
  private readonly controls: { control: Control; element: HTMLElement }[] = [];
  private readonly glContext: GL;
  private readonly painter: Painter;
  private readonly scheduler: RequestScheduler;
  private readonly handlers: InputHandlers | null;
  private readonly options: MapOptions;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly strings: Record<UiText, string>;
  private readonly cleanup: (() => void)[] = [];
  private workers: WorkerPool | null = null;
  private style: Style | null = null;
  private styleRequest: AbortController | null = null;
  private frameHandle = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeAtTime = Number.POSITIVE_INFINITY;
  private motion: { motion: CameraMotion; start: number; flags: CameraFlags } | null = null;
  private removed = false;
  private loadedFired = false;
  private idleFired = false;
  private contextLost = false;
  private pixelRatioValue: number;
  private cameraVersion = 0;
  private renderedVersion = -1;
  private lastState: CameraState;
  private moving = false;
  private movingFlags: CameraFlags = { zoom: false, rotate: false, pitch: false };
  private gestureDepth = 0;
  private gestureEvent: Event | undefined;
  private frameTimes: number[] = [];
  private frameCount = 0;
  private longFrames = 0;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = () => this.watchPixelRatio();

  constructor(options: MapOptions) {
    super();
    if (typeof options !== "object" || options === null) {
      throw new MapletError("invalid-option", "new Map(options) needs an options object");
    }
    this.options = { ...options };
    this.strings = { ...DEFAULT_TEXT, ...(options.locale ?? {}) };
    const container =
      typeof options.container === "string" ? document.getElementById(options.container) : options.container;
    if (!container || !(container instanceof HTMLElement)) {
      throw new MapletError("invalid-option", `Map container ${String(options.container)} was not found`);
    }
    this.container = container;
    const doc = container.ownerDocument;
    injectStyles(doc);
    registerPmtilesProtocol();
    registerMbtilesProtocol();
    this.transform = new Transform();
    this.transform.renderWorldCopies = options.renderWorldCopies ?? true;
    this.transform.setPitchRange(
      checkNumber(options.minPitch, "minPitch", 0),
      checkNumber(options.maxPitch, "maxPitch", 60),
    );
    this.transform.setZoomRange(
      checkNumber(options.minZoom, "minZoom", 0),
      checkNumber(options.maxZoom, "maxZoom", 22),
    );
    if (options.center !== undefined) {
      const [lng, lat] = toLngLat(options.center);
      this.transform.setCenter(lng, lat);
    }
    this.transform.setZoom(checkNumber(options.zoom, "zoom", 0));
    this.transform.setBearing(checkNumber(options.bearing, "bearing", 0));
    this.transform.setPitch(checkNumber(options.pitch, "pitch", 0));
    this.lastState = readState(this.transform);

    container.classList.add("maplet-map");
    this.canvasContainer = doc.createElement("div");
    this.canvasContainer.className = "maplet-canvas-container";
    this.canvasContainer.tabIndex = options.interactive === false ? -1 : 0;
    this.canvasContainer.setAttribute("role", "region");
    this.canvasContainer.setAttribute("aria-label", this.strings.map);
    this.canvas = doc.createElement("canvas");
    this.canvas.className = "maplet-canvas";
    this.canvasContainer.appendChild(this.canvas);
    container.appendChild(this.canvasContainer);
    for (const pos of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      const corner = doc.createElement("div");
      corner.className = `maplet-corner maplet-${pos}`;
      container.appendChild(corner);
      this.controlCorners.set(pos, corner);
    }

    try {
      this.glContext = GL.create(this.canvas, {
        alpha: true,
        antialias: options.antialias ?? false,
        depth: true,
        stencil: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
        powerPreference: "default",
        failIfMajorPerformanceCaveat: false,
      });
    } catch (error) {
      this.teardownDom();
      throw error;
    }
    this.painter = new Painter(this.glContext);
    this.scheduler = new RequestScheduler(checkNumber(options.maxParallelRequests, "maxParallelRequests", 24));
    this.pixelRatioValue = this.computePixelRatio();

    this.canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
    this.cleanup.push(() => {
      this.canvas.removeEventListener("webglcontextlost", this.onContextLost, false);
      this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored, false);
    });

    this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(container);
    this.watchPixelRatio();
    this.resize();

    if (options.interactive !== false) {
      const input: InputOptions = {
        dragPan: options.dragPan ?? true,
        dragRotate: options.dragRotate ?? true,
        scrollZoom: options.scrollZoom ?? true,
        doubleClickZoom: options.doubleClickZoom ?? true,
        touchZoomRotate: options.touchZoomRotate ?? true,
        touchPitch: options.touchPitch ?? true,
        keyboard: options.keyboard ?? true,
      };
      this.handlers = new InputHandlers(this.inputHost(), input);
    } else {
      this.handlers = null;
    }

    if (options.attributionControl !== false) {
      const custom = typeof options.attributionControl === "object" ? options.attributionControl.custom : undefined;
      this.addControl(new AttributionControl(custom === undefined ? {} : { custom }));
    }

    if (options.style !== undefined) this.setStyle(options.style);
    this.triggerRepaint();
  }

  text(key: UiText): string {
    return this.strings[key];
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCanvasContainer(): HTMLElement {
    return this.canvasContainer;
  }

  getCenter(): LngLat {
    const [lng, lat] = this.transform.center;
    return [wrapLongitude(lng), lat];
  }

  getZoom(): number {
    return this.transform.zoom;
  }

  getBearing(): number {
    return this.transform.bearing;
  }

  getPitch(): number {
    return this.transform.pitch;
  }

  getMinZoom(): number {
    return this.transform.minZoom;
  }

  getMaxZoom(): number {
    return this.transform.maxZoom;
  }

  setMinZoom(zoom: number): this {
    this.transform.setZoomRange(checkNumber(zoom, "minZoom", 0), this.transform.maxZoom);
    this.cameraChanged();
    return this;
  }

  setMaxZoom(zoom: number): this {
    this.transform.setZoomRange(this.transform.minZoom, checkNumber(zoom, "maxZoom", 22));
    this.cameraChanged();
    return this;
  }

  setMaxPitch(pitch: number): this {
    this.transform.setPitchRange(this.transform.minPitch, checkNumber(pitch, "maxPitch", 60));
    this.cameraChanged();
    return this;
  }

  getBounds(): [[number, number], [number, number]] {
    const pts = this.transform.footprint();
    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    for (const [x, y] of pts) {
      const lng = lngFromMercatorX(x);
      const lat = latFromMercatorY(y);
      w = Math.min(w, lng);
      e = Math.max(e, lng);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
    return [
      [w, s],
      [e, n],
    ];
  }

  setCenter(center: LngLatLike): this {
    return this.jumpTo({ center });
  }

  setZoom(zoom: number): this {
    return this.jumpTo({ zoom });
  }

  setBearing(bearing: number): this {
    return this.jumpTo({ bearing });
  }

  setPitch(pitch: number): this {
    return this.jumpTo({ pitch });
  }

  jumpTo(options: CameraOptions): this {
    this.stop();
    this.applyCamera(options);
    this.cameraChanged();
    return this;
  }

  easeTo(options: CameraOptions & AnimationOptions): this {
    this.stop();
    const from = readState(this.transform);
    const to = this.targetState(options);
    const reduced = this.prefersReducedMotion();
    const duration = options.animate === false || reduced ? 0 : checkNumber(options.duration, "duration", 500);
    let anchor: { world: [number, number]; screen: [number, number] } | undefined;
    if (options.around !== undefined && options.center === undefined) {
      const [lng, lat] = toLngLat(options.around);
      const world: [number, number] = [mercatorX(lng), mercatorY(lat)];
      const p = this.transform.project(world[0], world[1]);
      anchor = { world, screen: [p.x, p.y] };
    }
    this.startMotion(easeMotion(from, to, duration, options.easing ?? easeOutCubic, anchor), from, to);
    return this;
  }

  flyTo(options: FlyToOptions): this {
    this.stop();
    const from = readState(this.transform);
    const to = this.targetState(options);
    if (options.animate === false || this.prefersReducedMotion()) {
      this.startMotion(easeMotion(from, to, 0, easeOutCubic), from, to);
      return this;
    }
    const viewport = Math.max(this.transform.width, this.transform.height);
    const fly: Parameters<typeof flyMotion>[3] = {
      curve: checkNumber(options.curve, "curve", 1.42),
      speed: checkNumber(options.speed, "speed", 1.2),
      easing: options.easing ?? easeInOutCubic,
    };
    if (options.screenSpeed !== undefined) fly.screenSpeed = checkNumber(options.screenSpeed, "screenSpeed", 1);
    if (options.maxDuration !== undefined) fly.maxDuration = checkNumber(options.maxDuration, "maxDuration", 0);
    if (options.duration !== undefined) fly.duration = checkNumber(options.duration, "duration", 0);
    this.startMotion(flyMotion(from, to, viewport, fly), from, to);
    return this;
  }

  panBy(offset: [number, number], options: AnimationOptions = {}): this {
    const t = this.transform;
    const target = t.unprojectClamped(t.width / 2 + offset[0], t.height / 2 + offset[1]);
    return this.easeTo({ ...options, center: [lngFromMercatorX(target[0]), latFromMercatorY(target[1])] });
  }

  panTo(center: LngLatLike, options: AnimationOptions = {}): this {
    return this.easeTo({ ...options, center });
  }

  zoomTo(zoom: number, options: AnimationOptions & { around?: LngLatLike } = {}): this {
    return this.easeTo({ ...options, zoom });
  }

  zoomIn(options: AnimationOptions = {}): this {
    return this.easeTo({ duration: 250, ...options, zoom: this.transform.zoom + 1 });
  }

  zoomOut(options: AnimationOptions = {}): this {
    return this.easeTo({ duration: 250, ...options, zoom: this.transform.zoom - 1 });
  }

  rotateTo(bearing: number, options: AnimationOptions = {}): this {
    return this.easeTo({ ...options, bearing });
  }

  resetNorth(options: AnimationOptions = {}): this {
    return this.easeTo({ ...options, bearing: 0 });
  }

  fitBounds(bounds: BoundsLike, options: FitBoundsOptions = {}): this {
    const camera = this.cameraForBounds(bounds, options);
    if (!camera) return this;
    const anim: AnimationOptions = {};
    if (options.duration !== undefined) anim.duration = options.duration;
    if (options.easing !== undefined) anim.easing = options.easing;
    if (options.animate !== undefined) anim.animate = options.animate;
    return options.linear === false ? this.flyTo({ ...camera, ...anim }) : this.easeTo({ ...camera, ...anim });
  }

  cameraForBounds(bounds: BoundsLike, options: FitBoundsOptions = {}): CameraOptions | null {
    const [[w, s], [e, n]] = normalizeBounds(bounds);
    const pad = normalizePadding(options.padding);
    const t = this.transform;
    const width = t.width - pad.left - pad.right;
    const height = t.height - pad.top - pad.bottom;
    if (width <= 0 || height <= 0) return null;
    const x0 = mercatorX(w);
    let x1 = mercatorX(e);
    if (x1 < x0) x1 += 1;
    const y0 = mercatorY(n);
    const y1 = mercatorY(s);
    const bearing = ((options.bearing ?? t.bearing) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(bearing));
    const sin = Math.abs(Math.sin(bearing));
    const bw = (x1 - x0) * cos + (y1 - y0) * sin;
    const bh = (x1 - x0) * sin + (y1 - y0) * cos;
    const scale = Math.min(width / Math.max(bw * 512, 1e-12), height / Math.max(bh * 512, 1e-12));
    let zoom = Math.log2(scale);
    zoom = Math.min(zoom, options.maxZoom ?? t.maxZoom);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const offX = (pad.left - pad.right) / 2;
    const offY = (pad.top - pad.bottom) / 2;
    const ws = 512 * 2 ** zoom;
    const rx = offY * Math.sin(bearing) - offX * Math.cos(bearing);
    const ry = -offX * Math.sin(bearing) - offY * Math.cos(bearing);
    const center: [number, number] = [lngFromMercatorX(cx + rx / ws), latFromMercatorY(cy + ry / ws)];
    return { center, zoom, bearing: options.bearing ?? t.bearing, pitch: options.pitch ?? t.pitch };
  }

  stop(): this {
    if (this.motion) {
      this.motion = null;
      this.triggerRepaint();
    }
    this.handlers?.stopMomentum();
    return this;
  }

  isMoving(): boolean {
    return this.moving || this.motion !== null || this.gestureDepth > 0;
  }

  project(lngLat: LngLatLike): { x: number; y: number } {
    const [lng, lat] = toLngLat(lngLat);
    return this.transform.projectLngLat(lng, lat);
  }

  unproject(point: [number, number] | { x: number; y: number }): LngLat | null {
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    const w = this.transform.unproject(x, y);
    if (!w) return null;
    return [wrapLongitude(lngFromMercatorX(w[0])), latFromMercatorY(w[1])];
  }

  setStyle(style: StyleSpec | string): this {
    this.styleRequest?.abort();
    this.styleRequest = null;
    if (typeof style === "string") {
      const controller = new AbortController();
      this.styleRequest = controller;
      const params = resolveRequest(style, "style", this.options.transformRequest);
      fetchBytes(params, controller.signal, this.requestTimeout(), "style")
        .then((result) => {
          if (controller.signal.aborted || this.removed) return;
          if (result.kind === "empty") throw new MapletError("invalid-style", `Style not found at ${style}`);
          let spec: unknown;
          try {
            spec = JSON.parse(new TextDecoder().decode(result.data));
          } catch (error) {
            throw new MapletError("invalid-style", `Style at ${style} is not valid JSON`, {}, error);
          }
          this.applyStyle(spec as StyleSpec);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || this.removed) return;
          this.fail(
            error instanceof MapletError
              ? error
              : new MapletError("invalid-style", `Could not load the style: ${errorMessage(error)}`, {}, error),
          );
        });
    } else {
      this.applyStyle(style);
    }
    return this;
  }

  getStyle(): StyleSpec | null {
    return this.style?.serialize() ?? null;
  }

  isStyleLoaded(): boolean {
    return this.style?.loaded ?? false;
  }

  addSource(id: string, spec: SourceSpec): this {
    this.requireStyle().addSource(id, spec);
    return this;
  }

  removeSource(id: string): this {
    this.requireStyle().removeSource(id);
    this.triggerRepaint();
    return this;
  }

  getSource(id: string): Source | undefined {
    return this.style?.sources.get(id) as Source | undefined;
  }

  addLayer(layer: LayerSpec, beforeId?: string): this {
    this.requireStyle().addLayer(layer, beforeId);
    return this;
  }

  removeLayer(id: string): this {
    this.requireStyle().removeLayer(id);
    return this;
  }

  moveLayer(id: string, beforeId?: string): this {
    this.requireStyle().moveLayer(id, beforeId);
    return this;
  }

  getLayer(id: string): LayerSpec | undefined {
    return this.style?.getLayer(id)?.serialize();
  }

  getLayerIds(): string[] {
    return this.style?.layers.map((l) => l.id) ?? [];
  }

  setPaintProperty(layerId: string, name: string, value: unknown): this {
    this.layer(layerId).setPaint(name, value);
    this.triggerRepaint();
    return this;
  }

  setLayoutProperty(layerId: string, name: string, value: unknown): this {
    this.layer(layerId).setLayout(name, value);
    this.triggerRepaint();
    return this;
  }

  setFilter(layerId: string, filter: unknown): this {
    this.layer(layerId).setFilter(filter);
    this.triggerRepaint();
    return this;
  }

  setLayerVisibility(layerId: string, visible: boolean): this {
    this.layer(layerId).setVisible(visible);
    this.triggerRepaint();
    return this;
  }

  setLayerZoomRange(layerId: string, minZoom: number, maxZoom: number): this {
    this.layer(layerId).setZoomRange(minZoom, maxZoom);
    this.triggerRepaint();
    return this;
  }

  getAttributions(): string[] {
    const out: string[] = [];
    if (!this.style) return out;
    for (const source of this.style.sources.values()) {
      const used = this.style.layers.some((l) => l.source === source.id && l.visible);
      if (used && source.attribution) out.push(source.attribution);
    }
    return out;
  }

  addControl(control: Control, position?: ControlPosition): this {
    const pos = position ?? control.defaultPosition ?? "top-right";
    const corner = this.controlCorners.get(pos);
    if (!corner) throw new MapletError("invalid-option", `Unknown control position "${String(pos)}"`);
    const element = control.onAdd(this);
    if (pos.startsWith("bottom")) corner.insertBefore(element, corner.firstChild);
    else corner.appendChild(element);
    this.controls.push({ control, element });
    return this;
  }

  removeControl(control: Control): this {
    const index = this.controls.findIndex((c) => c.control === control);
    if (index < 0) return this;
    const [entry] = this.controls.splice(index, 1);
    entry?.control.onRemove(this);
    entry?.element.remove();
    return this;
  }

  resize(): this {
    if (this.removed) return this;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.pixelRatioValue = this.computePixelRatio();
    const ratio = this.pixelRatioValue;
    const max = this.glContext.maxTextureSize;
    const bw = Math.min(max, Math.max(1, Math.round(width * ratio)));
    const bh = Math.min(max, Math.max(1, Math.round(height * ratio)));
    const changed =
      this.canvas.width !== bw ||
      this.canvas.height !== bh ||
      this.transform.width !== width ||
      this.transform.height !== height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.transform.resize(width, height);
    if (changed) {
      this.cameraVersion++;
      this.emit("resize", this.event("resize"));
      this.triggerRepaint();
    }
    return this;
  }

  getPixelRatio(): number {
    return this.pixelRatioValue;
  }

  setPixelRatio(ratio: number | undefined): this {
    if (ratio === undefined) delete this.options.pixelRatio;
    else this.options.pixelRatio = checkNumber(ratio, "pixelRatio", 1);
    return this.resize();
  }

  triggerRepaint(): void {
    if (this.removed || this.contextLost) return;
    this.idleFired = false;
    if (this.frameHandle) return;
    this.frameHandle = requestAnimationFrame((t) => this.frame(t));
  }

  loaded(): boolean {
    return this.isStyleLoaded() && !this.motion && this.sourcesIdle();
  }

  getDiagnostics(): Diagnostics {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const pick = (q: number) =>
      sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    const sources: Record<string, TileStats | null> = {};
    let blank = 0;
    for (const source of this.style?.sources.values() ?? []) {
      const stats = source.stats();
      sources[source.id] = stats;
      if (stats) blank = Math.max(blank, stats.blankPending + stats.blankFailed);
    }
    return {
      frames: this.frameCount,
      frameTime: { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: sorted[sorted.length - 1] ?? 0 },
      longFrames: this.longFrames,
      drawCalls: this.painter.stats.drawCalls,
      renderedPieces: this.painter.stats.pieces,
      requests: { active: this.scheduler.activeCount, queued: this.scheduler.queuedCount },
      workers: { size: this.workers?.size ?? 0, queued: this.workers?.queueDepth ?? 0 },
      sources,
      blankRatio: blank,
      canvas: { width: this.canvas.width, height: this.canvas.height, pixelRatio: this.pixelRatioValue },
      contextLost: this.contextLost,
    };
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.styleRequest?.abort();
    this.resizeObserver?.disconnect();
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.handlers?.destroy();
    for (const { control, element } of [...this.controls]) {
      control.onRemove(this);
      element.remove();
    }
    this.controls.length = 0;
    this.style?.destroy();
    this.style = null;
    this.scheduler.destroy();
    this.workers?.destroy();
    this.workers = null;
    this.painter.destroy();
    this.glContext.destroy();
    for (const fn of this.cleanup) fn();
    this.glContext.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.teardownDom();
    this.emit("remove", this.event("remove"));
    this.removeAllListeners();
  }

  private teardownDom(): void {
    this.canvasContainer.remove();
    for (const corner of this.controlCorners.values()) corner.remove();
    this.container.classList.remove("maplet-map");
  }

  private layer(id: string): StyleLayer {
    const layer = this.requireStyle().getLayer(id);
    if (!layer) throw new MapletError("invalid-option", `There is no layer with id "${id}"`);
    return layer;
  }

  private requireStyle(): Style {
    if (!this.style)
      throw new MapletError("invalid-style", "The map has no style yet; call setStyle first or wait for styleload");
    return this.style;
  }

  private applyStyle(spec: StyleSpec): void {
    let style: Style;
    try {
      style = new Style(spec, (id, source) => this.createSource(id, source), {
        sourceLoaded: (source) => {
          this.emit("sourcedata", { ...this.event("sourcedata"), sourceId: source.id, kind: "metadata" });
          this.triggerRepaint();
        },
        sourceFailed: (source, error) => {
          this.emit("sourcedata", { ...this.event("sourcedata"), sourceId: source.id, kind: "error" });
          this.fail(error, source.id);
        },
        changed: () => this.triggerRepaint(),
      });
    } catch (error) {
      this.fail(
        error instanceof MapletError ? error : new MapletError("invalid-style", errorMessage(error), {}, error),
      );
      return;
    }
    const first = this.style === null;
    this.style?.destroy();
    this.style = style;
    if (first) {
      const o = this.options;
      const t = this.transform;
      if (o.center === undefined && spec.center) t.setCenter(spec.center[0], spec.center[1]);
      if (o.zoom === undefined && spec.zoom !== undefined) t.setZoom(spec.zoom);
      if (o.bearing === undefined && spec.bearing !== undefined) t.setBearing(spec.bearing);
      if (o.pitch === undefined && spec.pitch !== undefined) t.setPitch(spec.pitch);
      this.cameraVersion++;
    }
    queueMicrotask(() => {
      if (this.style === style && !this.removed) this.emit("styleload", this.event("styleload"));
    });
    this.triggerRepaint();
  }

  private createSource(id: string, spec: SourceSpec): MapSource {
    const ctx = this.sourceContext();
    switch (spec.type) {
      case "raster":
        return new RasterSource(id, spec, ctx);
      case "vector":
        return new VectorSource(id, spec, ctx);
      case "geojson":
        return new GeoJSONSource(id, spec, ctx);
      default:
        throw new MapletError("invalid-style", `Source type "${spec.type}" is not supported yet`, { sourceId: id });
    }
  }

  private sourceContext(): SourceContext {
    return {
      gl: this.glContext,
      scheduler: this.scheduler,
      workers: () => this.workerPool(),
      transformRequest: this.options.transformRequest,
      requestTimeoutMs: this.requestTimeout(),
      cacheBytes: Math.max(16, checkNumber(this.options.tileCacheSize, "tileCacheSize", 192)) * 1024 * 1024,
      fadeDuration: checkNumber(this.options.fadeDuration, "fadeDuration", 200),
      prefetchLimit: this.options.prefetch === false ? 0 : 48,
      pixelRatio: () => this.pixelRatioValue,
      error: (error) => this.fail(error, typeof error.detail.sourceId === "string" ? error.detail.sourceId : undefined),
      content: (sourceId) => {
        this.emit("sourcedata", { ...this.event("sourcedata"), sourceId, kind: "content" });
        this.triggerRepaint();
      },
      changed: () => this.triggerRepaint(),
      wakeAt: (time) => this.wakeAt(time),
    };
  }

  private workerPool(): WorkerPool {
    if (!this.workers) {
      const hardware = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
      const count = checkNumber(this.options.workerCount, "workerCount", Math.max(1, Math.min(4, hardware - 1)));
      this.workers = new WorkerPool(count, workerFactory(this.options.workerUrl));
    }
    return this.workers;
  }

  private requestTimeout(): number {
    return checkNumber(this.options.requestTimeout, "requestTimeout", 30000);
  }

  private fail(error: MapletError, sourceId?: string): void {
    queueMicrotask(() => {
      if (this.removed) return;
      if (this.listens("error")) {
        this.emit("error", { ...this.event("error"), error, sourceId });
      } else {
        console.error(error);
      }
    });
  }

  private event(type: string): MapEvent {
    return { target: this, type };
  }

  private wakeAt(time: number): void {
    if (this.removed || time >= this.wakeAtTime) return;
    this.wakeAtTime = time;
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    const delay = Math.max(0, time - performance.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.wakeAtTime = Number.POSITIVE_INFINITY;
      this.triggerRepaint();
    }, delay + 5);
  }

  private computePixelRatio(): number {
    if (this.options.pixelRatio !== undefined) return Math.max(0.25, this.options.pixelRatio);
    const device = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const cap = checkNumber(this.options.maxPixelRatio, "maxPixelRatio", 2);
    return Math.min(device, cap);
  }

  private watchPixelRatio(): void {
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    if (typeof matchMedia !== "function") return;
    this.dprQuery = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener("change", this.onDprChange);
    if (this.dprQuery && !this.removed && this.transform.width > 1) this.resize();
  }

  private prefersReducedMotion(): boolean {
    if (this.options.reducedMotion !== undefined) return this.options.reducedMotion;
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private targetState(options: CameraOptions): CameraState {
    const t = this.transform.clone();
    if (options.center !== undefined) {
      const [lng, lat] = toLngLat(options.center);
      t.setCenter(lng, lat);
    }
    if (options.zoom !== undefined) t.setZoom(checkNumber(options.zoom, "zoom", t.zoom));
    if (options.bearing !== undefined) t.setBearing(checkNumber(options.bearing, "bearing", t.bearing));
    if (options.pitch !== undefined) t.setPitch(checkNumber(options.pitch, "pitch", t.pitch));
    const state = readState(t);
    if (options.center !== undefined) {
      const [lng] = toLngLat(options.center);
      state.x = mercatorX(lng);
    }
    return state;
  }

  private applyCamera(options: CameraOptions): void {
    const t = this.transform;
    if (options.zoom !== undefined) {
      const zoom = checkNumber(options.zoom, "zoom", t.zoom);
      if (options.around !== undefined && options.center === undefined) {
        const [lng, lat] = toLngLat(options.around);
        const p = t.projectLngLat(lng, lat);
        t.zoomAround(zoom, p.x, p.y);
      } else {
        t.setZoom(zoom);
      }
    }
    if (options.bearing !== undefined) t.setBearing(checkNumber(options.bearing, "bearing", t.bearing));
    if (options.pitch !== undefined) t.setPitch(checkNumber(options.pitch, "pitch", t.pitch));
    if (options.center !== undefined) {
      const [lng, lat] = toLngLat(options.center);
      t.setCenter(lng, lat);
    }
  }

  private startMotion(motion: CameraMotion, from: CameraState, to: CameraState): void {
    const flags: CameraFlags = {
      zoom: Math.abs(from.zoom - to.zoom) > 1e-9 || motion.duration > 0,
      rotate: Math.abs(from.bearing - to.bearing) > 1e-9,
      pitch: Math.abs(from.pitch - to.pitch) > 1e-9,
    };
    if (motion.duration <= 0) {
      motion.apply(this.transform, 1);
      this.cameraChanged();
      return;
    }
    this.motion = { motion, start: performance.now(), flags };
    this.cameraChanged();
  }

  private cameraChanged(): void {
    this.cameraVersion++;
    this.triggerRepaint();
  }

  private sourcesIdle(): boolean {
    if (!this.style) return false;
    for (const source of this.style.sources.values()) {
      if (!source.loaded || !source.isIdle()) return false;
    }
    return this.style.loaded;
  }

  private predicted(): Transform[] {
    const out: Transform[] = [];
    if (this.motion) {
      const { motion, start } = this.motion;
      const now = performance.now();
      for (const ahead of [250, 500, 900]) {
        const t = (now + ahead - start) / Math.max(1, motion.duration);
        if (t >= 1) break;
        const future = this.transform.clone();
        motion.apply(future, t);
        out.push(future);
      }
      const end = this.transform.clone();
      motion.apply(end, 1);
      out.push(end);
    }
    const wheelTarget = this.handlers?.wheelTarget;
    if (wheelTarget) {
      const future = this.transform.clone();
      future.zoomAround(wheelTarget.zoom, wheelTarget.point[0], wheelTarget.point[1]);
      out.push(future);
    }
    return out;
  }

  private frame(now: number): void {
    this.frameHandle = 0;
    if (this.removed || this.contextLost) return;
    const started = performance.now();
    let animating = false;
    if (this.motion) {
      const m = this.motion;
      const t = (started - m.start) / m.motion.duration;
      m.motion.apply(this.transform, t);
      this.cameraVersion++;
      if (t >= 1) this.motion = null;
      else animating = true;
    }
    if (this.handlers?.step(started)) animating = true;
    const style = this.style;
    if (style) {
      const deadline = started + 6;
      let moreUploads = false;
      for (const source of style.sources.values()) {
        if (source.uploadPending(deadline, now)) moreUploads = true;
      }
      const predicted = this.predicted();
      for (const source of style.sources.values()) {
        if (source.setLayers) source.setLayers(style.layers.filter((l) => l.source === source.id));
        source.update(this.transform, now, predicted);
      }
      if (moreUploads) animating = true;
      const labelsBusy = this.painter.render({
        transform: this.transform,
        pixelRatio: this.pixelRatioValue,
        layers: style.layers,
        sources: style.sources,
        now,
        cameraVersion: this.cameraVersion,
      });
      if (labelsBusy) animating = true;
      for (const source of style.sources.values()) {
        if (source.isFading()) animating = true;
      }
    } else {
      this.painter.render({
        transform: this.transform,
        pixelRatio: this.pixelRatioValue,
        layers: [],
        sources: new Map(),
        now,
        cameraVersion: this.cameraVersion,
      });
    }
    this.emitCameraEvents();
    this.emit("render", this.event("render"));
    if (!this.loadedFired && style?.loaded) {
      this.loadedFired = true;
      this.emit("load", this.event("load"));
    }
    const elapsed = performance.now() - started;
    this.frameCount++;
    if (elapsed > 50) this.longFrames++;
    this.frameTimes.push(elapsed);
    if (this.frameTimes.length > FRAME_SAMPLES) this.frameTimes.shift();
    if (animating || this.moving || this.gestureDepth > 0) {
      this.triggerRepaint();
    } else if (!this.idleFired && this.loadedFired && this.sourcesIdle()) {
      this.idleFired = true;
      this.emit("idle", this.event("idle"));
    }
  }

  private emitCameraEvents(): void {
    const changed = this.cameraVersion !== this.renderedVersion;
    this.renderedVersion = this.cameraVersion;
    const state = readState(this.transform);
    const last = this.lastState;
    const zoomed = Math.abs(state.zoom - last.zoom) > 1e-12;
    const rotated = Math.abs(state.bearing - last.bearing) > 1e-12;
    const pitched = Math.abs(state.pitch - last.pitch) > 1e-12;
    const moved = changed && (zoomed || rotated || pitched || state.x !== last.x || state.y !== last.y);
    this.lastState = state;
    const original = this.gestureEvent;
    const ev = (type: string): MapMoveEvent => ({ target: this, type, originalEvent: original });
    const active = this.motion !== null || this.gestureDepth > 0 || (this.handlers?.animating ?? false);
    if (moved) {
      if (!this.moving) {
        this.moving = true;
        this.emit("movestart", ev("movestart"));
      }
      if (zoomed && !this.movingFlags.zoom) {
        this.movingFlags.zoom = true;
        this.emit("zoomstart", ev("zoomstart"));
      }
      if (rotated && !this.movingFlags.rotate) {
        this.movingFlags.rotate = true;
        this.emit("rotatestart", ev("rotatestart"));
      }
      if (pitched && !this.movingFlags.pitch) {
        this.movingFlags.pitch = true;
        this.emit("pitchstart", ev("pitchstart"));
      }
      this.emit("move", ev("move"));
      if (zoomed) this.emit("zoom", ev("zoom"));
      if (rotated) this.emit("rotate", ev("rotate"));
      if (pitched) this.emit("pitch", ev("pitch"));
    } else if (this.moving && !active) {
      this.moving = false;
      if (this.movingFlags.zoom) this.emit("zoomend", ev("zoomend"));
      if (this.movingFlags.rotate) this.emit("rotateend", ev("rotateend"));
      if (this.movingFlags.pitch) this.emit("pitchend", ev("pitchend"));
      this.movingFlags = { zoom: false, rotate: false, pitch: false };
      this.emit("moveend", ev("moveend"));
      this.gestureEvent = undefined;
    }
  }

  private inputHost() {
    return {
      transform: this.transform,
      element: this.canvasContainer,
      reducedMotion: () => this.prefersReducedMotion(),
      interrupt: () => {
        this.motion = null;
      },
      changed: () => this.cameraChanged(),
      gesture: (active: boolean) => {
        this.gestureDepth = Math.max(0, this.gestureDepth + (active ? 1 : -1));
        this.triggerRepaint();
      },
      ease: (
        target: { zoom?: number; bearing?: number; pitch?: number; panBy?: [number, number] },
        around: [number, number] | null,
        duration: number,
      ) => {
        if (target.panBy) {
          this.panBy(target.panBy, { duration });
          return;
        }
        const options: CameraOptions & AnimationOptions = { duration };
        if (target.zoom !== undefined) options.zoom = target.zoom;
        if (target.bearing !== undefined) options.bearing = target.bearing;
        if (target.pitch !== undefined) options.pitch = target.pitch;
        if (around) {
          const ll = this.transform.unprojectLngLat(around[0], around[1]);
          if (ll) options.around = ll;
        }
        this.easeTo(options);
      },
      pointerEvent: (
        type: "click" | "dblclick" | "contextmenu" | "mousemove" | "mousedown" | "mouseup" | "mouseout",
        event: MouseEvent,
        point: [number, number],
      ) => {
        this.gestureEvent = event;
        if (!this.listens(type)) return;
        let prevented = false;
        const ll = this.transform.unprojectLngLat(point[0], point[1]);
        const e: MapPointerEvent = {
          target: this,
          type,
          point: { x: point[0], y: point[1] },
          lngLat: ll ? [wrapLongitude(ll[0]), ll[1]] : null,
          originalEvent: event,
          preventDefault: () => {
            prevented = true;
            event.preventDefault();
          },
          get defaultPrevented() {
            return prevented;
          },
        };
        this.emit(type, e);
      },
    };
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.glContext.markLost();
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.emit("contextlost", this.event("contextlost"));
  };

  private readonly onContextRestored = () => {
    this.contextLost = false;
    this.glContext.markRestored();
    this.painter.init();
    for (const source of this.style?.sources.values() ?? []) source.reload();
    this.emit("contextrestored", this.event("contextrestored"));
    this.triggerRepaint();
  };
}

function checkNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MapletError("invalid-option", `${name} must be a finite number`, { option: name });
  }
  return value;
}

function normalizeBounds(bounds: BoundsLike): [[number, number], [number, number]] {
  if (bounds.length === 4) {
    const [w, s, e, n] = bounds as [number, number, number, number];
    return [
      [w, s],
      [e, n],
    ];
  }
  const [[a, b], [c, d]] = bounds as [[number, number], [number, number]];
  return [
    [Math.min(a, c), Math.min(b, d)],
    [Math.max(a, c), Math.max(b, d)],
  ];
}

function normalizePadding(padding: FitBoundsOptions["padding"]): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === "number") return { top: padding, right: padding, bottom: padding, left: padding };
  return { top: padding.top ?? 0, right: padding.right ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0 };
}

declare const MAPLET_WORKER_SOURCE: string | undefined;

function workerFactory(url: string | undefined): WorkerFactory | null {
  if (typeof Worker === "undefined") return null;
  if (url) return () => new Worker(url);
  const source = typeof MAPLET_WORKER_SOURCE === "string" ? MAPLET_WORKER_SOURCE : undefined;
  if (!source) return null;
  let blobUrl: string | null = null;
  return () => {
    blobUrl ??= URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return new Worker(blobUrl);
  };
}
