import type { CameraMotion, CameraState, Easing } from "../camera/animation.ts";
import { easeInOutCubic, easeMotion, easeOutCubic, flyMotion, readState } from "../camera/animation.ts";
import { Transform } from "../camera/transform.ts";
import { featureKey } from "../formats/mvt.ts";
import type { LngLat, LngLatLike } from "../geo/mercator.ts";
import { latFromMercatorY, lngFromMercatorX, mercatorX, mercatorY, toLngLat, wrapLongitude } from "../geo/mercator.ts";
import type { InputOptions } from "../input/handlers.ts";
import { InputHandlers } from "../input/handlers.ts";
import { GL } from "../render/gl.ts";
import type { PickBox } from "../render/painter.ts";
import { Painter } from "../render/painter.ts";
import { DemSource } from "../sources/dem.ts";
import { GeoJSONSource } from "../sources/geojson.ts";
import { registerMbtilesProtocol } from "../sources/mbtiles.ts";
import { registerPmtilesProtocol } from "../sources/pmtiles.ts";
import { RasterSource } from "../sources/raster.ts";
import type { MapSource, SourceContext } from "../sources/source.ts";
import { VectorSource } from "../sources/vector.ts";
import type { FeatureTarget, StateLookup } from "../style/feature-state.ts";
import { FeatureStates } from "../style/feature-state.ts";
import type { StyleLayer } from "../style/layer.ts";
import { Style } from "../style/style.ts";
import type { LayerSpec, SourceSpec, StyleSpec, TerrainSpec } from "../style/types.ts";
import { metersToWorld, Terrain } from "../terrain/terrain.ts";
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
import type { QueriedFeature, StateReader } from "./query.ts";
import { resolveFeatures } from "./query.ts";

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
  bearingSnap?: number;
  clickTolerance?: number;
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

export interface HandlerSwitch {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
}

export interface TouchZoomRotateSwitch extends HandlerSwitch {
  enableRotation(): void;
  disableRotation(): void;
  isRotationEnabled(): boolean;
}

export type Source = RasterSource | VectorSource | GeoJSONSource | DemSource;

export type PointLike = [number, number] | { x: number; y: number };

export type QueryGeometry = PointLike | [PointLike, PointLike];

export interface QueryOptions {
  layers?: string[];
}

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
  terrain: { tiles: number; textureBytes: number; redrawn: number } | null;
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
  readonly dragPan: HandlerSwitch;
  readonly dragRotate: HandlerSwitch;
  readonly scrollZoom: HandlerSwitch;
  readonly doubleClickZoom: HandlerSwitch;
  readonly touchZoomRotate: TouchZoomRotateSwitch;
  readonly touchPitch: HandlerSwitch;
  readonly keyboard: HandlerSwitch;
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
  private terrain: Terrain | null = null;
  private featureStates = new FeatureStates();
  private elevationIntent: "zoom" | "camera" = "zoom";
  private elevationFrom = 0;
  private elevationTo: number | null = null;
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
        touchRotate: true,
        keyboard: options.keyboard ?? true,
        clickTolerance: checkNumber(options.clickTolerance, "clickTolerance", 4),
      };
      this.handlers = new InputHandlers(this.inputHost(), input);
    } else {
      this.handlers = null;
    }
    this.dragPan = this.handlerSwitch("dragPan");
    this.dragRotate = this.handlerSwitch("dragRotate");
    this.scrollZoom = this.handlerSwitch("scrollZoom");
    this.doubleClickZoom = this.handlerSwitch("doubleClickZoom");
    this.touchPitch = this.handlerSwitch("touchPitch");
    this.keyboard = this.handlerSwitch("keyboard");
    const rotation = this.handlerSwitch("touchRotate");
    this.touchZoomRotate = {
      ...this.handlerSwitch("touchZoomRotate"),
      enableRotation: rotation.enable,
      disableRotation: rotation.disable,
      isRotationEnabled: rotation.isEnabled,
    };

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

  private handlerSwitch(
    key:
      | "dragPan"
      | "dragRotate"
      | "scrollZoom"
      | "doubleClickZoom"
      | "touchZoomRotate"
      | "touchPitch"
      | "touchRotate"
      | "keyboard",
  ): HandlerSwitch {
    return {
      enable: () => {
        if (this.handlers) this.handlers.options[key] = true;
      },
      disable: () => {
        if (!this.handlers) return;
        this.handlers.options[key] = false;
        if (key !== "touchRotate") this.handlers.stopMomentum();
      },
      isEnabled: () => this.handlers?.options[key] === true,
    };
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

  setMinPitch(pitch: number): this {
    this.transform.setPitchRange(checkNumber(pitch, "minPitch", 0), this.transform.maxPitch);
    this.cameraChanged();
    return this;
  }

  getMinPitch(): number {
    return this.transform.minPitch;
  }

  getMaxPitch(): number {
    return this.transform.maxPitch;
  }

  getRenderWorldCopies(): boolean {
    return this.transform.renderWorldCopies;
  }

  setRenderWorldCopies(render: boolean): this {
    this.transform.renderWorldCopies = render !== false;
    const [x, y] = this.transform.centerWorld;
    this.transform.setCenterWorld(x, y);
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
    this.elevationIntent = "zoom";
    this.elevationTo = null;
    this.applyCamera(options);
    this.cameraChanged();
    return this;
  }

  setTerrain(terrain: TerrainSpec | null): this {
    const style = this.style;
    if (!style) throw new MapletError("invalid-option", "Set a style before turning on terrain");
    if (terrain === null) {
      delete style.meta.terrain;
    } else {
      const source = typeof terrain?.source === "string" ? style.sources.get(terrain.source) : undefined;
      if (source?.type !== "dem") {
        throw new MapletError("invalid-option", "terrain.source must name a dem source", { terrain });
      }
      const exaggeration = terrain.exaggeration ?? 1;
      if (typeof exaggeration !== "number" || !Number.isFinite(exaggeration) || exaggeration < 0) {
        throw new MapletError("invalid-option", "terrain.exaggeration must be a number of 0 or more", { terrain });
      }
      style.meta.terrain = { source: terrain.source, exaggeration };
    }
    this.cameraChanged();
    return this;
  }

  getTerrain(): TerrainSpec | null {
    const terrain = this.style?.meta.terrain;
    return terrain ? { ...terrain } : null;
  }

  easeTo(options: CameraOptions & AnimationOptions): this {
    this.stop();
    const from = readState(this.transform);
    const to = this.targetState(options);
    const reduced = this.prefersReducedMotion();
    const duration = options.animate === false || reduced ? 0 : checkNumber(options.duration, "duration", 500);
    let anchor: { world: [number, number]; screen: [number, number]; z: number } | undefined;
    if (options.around !== undefined && options.center === undefined) {
      const [lng, lat] = toLngLat(options.around);
      const world: [number, number] = [mercatorX(lng), mercatorY(lat)];
      const z = this.groundAt(world[0], world[1]);
      const p = this.transform.project(world[0], world[1], z * this.transform.worldSize);
      anchor = { world, screen: [p.x, p.y], z };
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

  resetNorthPitch(options: AnimationOptions = {}): this {
    return this.easeTo({ ...options, bearing: 0, pitch: 0 });
  }

  snapToNorth(options: AnimationOptions = {}): this {
    const snap = checkNumber(this.options.bearingSnap, "bearingSnap", 7);
    if (this.transform.bearing !== 0 && Math.abs(this.transform.bearing) < snap) return this.resetNorth(options);
    return this;
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

  isZooming(): boolean {
    return this.movingFlags.zoom;
  }

  isRotating(): boolean {
    return this.movingFlags.rotate;
  }

  project(lngLat: LngLatLike): { x: number; y: number } {
    const [lng, lat] = toLngLat(lngLat);
    const x = mercatorX(lng);
    const y = mercatorY(lat);
    const p = this.transform.project(x, y, this.groundAt(x, y) * this.transform.worldSize);
    return { x: p.x, y: p.y };
  }

  unproject(point: [number, number] | { x: number; y: number }): LngLat | null {
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    const w = this.pickWorld(x, y);
    if (!w) return null;
    return [wrapLongitude(lngFromMercatorX(w[0])), latFromMercatorY(w[1])];
  }

  private groundAt(x: number, y: number): number {
    const terrain = this.terrain;
    return terrain ? metersToWorld(terrain.surfaceAt(x, y), y) : 0;
  }

  private pickWorld(px: number, py: number): [number, number, number] | null {
    const t = this.transform;
    const terrain = this.terrain;
    if (terrain) {
      const ws = t.worldSize;
      const { origin, dir } = t.screenRay(px, py);
      const o = [origin[0] / ws, origin[1] / ws, origin[2] / ws];
      const d = [dir[0] / ws, dir[1] / ws, dir[2] / ws];
      const hit = terrain.raycast(o, d, Math.hypot(d[0]!, d[1]!, d[2]!));
      if (hit) return hit;
    }
    const w = t.unproject(px, py);
    return w ? [w[0], w[1], t.centerElevationPixels / t.worldSize] : null;
  }

  private updateTerrain(style: Style, progress: number | null): void {
    const spec = style.meta.terrain;
    const source = spec ? style.sources.get(spec.source) : undefined;
    const t = this.transform;
    if (!spec || !(source instanceof DemSource) || !source.manager) {
      if (this.terrain) {
        this.terrain = null;
        t.setGround(0);
        if (t.elevation !== 0) t.setElevationKeepCamera(0);
        if (t.elevation !== 0) t.setElevation(0);
        this.cameraVersion++;
      }
      return;
    }
    const exaggeration = Math.max(0, spec.exaggeration ?? 1);
    if (!this.terrain || this.terrain.source !== source) this.terrain = new Terrain(source, exaggeration);
    const terrain = this.terrain;
    terrain.exaggeration = exaggeration;
    const [cx, cy] = t.centerWorld;
    let target = terrain.elevationAt(cx, cy);
    if (progress !== null && this.elevationTo !== null) {
      target = this.elevationFrom + (this.elevationTo - this.elevationFrom) * progress;
    }
    if (target !== null) {
      const before = t.elevation;
      const zoom = t.zoom;
      if (this.elevationIntent === "camera" && progress === null && Math.abs(target - t.elevation) > 1e-3) {
        t.setElevationKeepCamera(target);
      }
      const floor = this.cameraFloor(terrain);
      const wanted = floor === null ? target : Math.max(target, floor);
      if (Math.abs(wanted - t.elevation) > 1e-3) t.setElevation(wanted);
      if (t.elevation !== before || t.zoom !== zoom) this.cameraVersion++;
    }
    terrain.update(t);
    t.setGround(Math.min(terrain.ground, t.elevation));
  }

  private cameraFloor(terrain: Terrain): number | null {
    const t = this.transform;
    const ws = t.worldSize;
    const camera = t.cameraPosition;
    const ground = terrain.elevationAt(camera[0] / ws, camera[1] / ws);
    if (ground === null) return null;
    const pixelsPerMeter = t.pixelsPerMeter;
    const above = (camera[2] - t.centerElevationPixels) / pixelsPerMeter;
    return ground + 50 * terrain.exaggeration + 2 / pixelsPerMeter - above;
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
    this.featureStates.dropSource(id);
    this.triggerRepaint();
    return this;
  }

  setFeatureState(feature: FeatureTarget, state: Record<string, unknown>): this {
    const target = this.stateTarget(feature, "setFeatureState");
    if (target.key === undefined) {
      throw new MapletError("invalid-option", "setFeatureState needs a feature id", { sourceId: target.source });
    }
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new MapletError("invalid-option", "setFeatureState needs a state object such as { hover: true }");
    }
    this.featureStates.set(target.source, target.sourceLayer, target.key, state);
    this.triggerRepaint();
    return this;
  }

  getFeatureState(feature: FeatureTarget): Record<string, unknown> {
    const target = this.stateTarget(feature, "getFeatureState");
    if (target.key === undefined) {
      throw new MapletError("invalid-option", "getFeatureState needs a feature id", { sourceId: target.source });
    }
    return this.featureStates.get(target.source, target.sourceLayer, target.key);
  }

  removeFeatureState(feature: FeatureTarget, key?: string): this {
    const target = this.stateTarget(feature, "removeFeatureState");
    if (key !== undefined && (typeof key !== "string" || target.key === undefined)) {
      throw new MapletError(
        "invalid-option",
        "removeFeatureState can remove one state key only from a feature with an id",
        { sourceId: target.source },
      );
    }
    this.featureStates.remove(target.source, target.sourceLayer, target.key, key);
    this.triggerRepaint();
    return this;
  }

  private stateTarget(
    feature: FeatureTarget,
    method: string,
  ): { source: string; sourceLayer: string | undefined; key: number | undefined } {
    if (typeof feature !== "object" || feature === null || typeof feature.source !== "string") {
      throw new MapletError("invalid-option", `${method} needs { source, sourceLayer, id }`);
    }
    const source = this.requireStyle().sources.get(feature.source);
    if (!source) {
      throw new MapletError("invalid-option", `There is no source with id "${feature.source}"`, {
        sourceId: feature.source,
      });
    }
    if (source.type !== "vector" && source.type !== "geojson") {
      throw new MapletError("invalid-option", `Feature state needs a vector or geojson source, not ${source.type}`, {
        sourceId: feature.source,
      });
    }
    let sourceLayer: string | undefined;
    if (source.type === "vector") {
      if (typeof feature.sourceLayer !== "string" || feature.sourceLayer === "") {
        throw new MapletError(
          "invalid-option",
          `${method} needs the sourceLayer of vector source "${feature.source}"`,
          {
            sourceId: feature.source,
          },
        );
      }
      sourceLayer = feature.sourceLayer;
    }
    let key: number | undefined;
    if (feature.id !== undefined) {
      key = featureKey(feature.id);
      if (key === undefined) {
        throw new MapletError("invalid-option", "Feature ids are finite numbers or non-empty strings", {
          sourceId: feature.source,
        });
      }
    }
    return { source: feature.source, sourceLayer, key };
  }

  private readonly stateScope = (layer: StyleLayer): StateLookup | null => {
    if (!layer.usesState || layer.source === undefined) return null;
    const source = this.style?.sources.get(layer.source);
    if (source?.type !== "vector" && source?.type !== "geojson") return null;
    return this.featureStates.scope(layer.source, source.type === "vector" ? layer.sourceLayer : undefined);
  };

  private readonly readState: StateReader = (source, sourceLayer, id) => {
    const key = featureKey(id);
    return key === undefined ? {} : this.featureStates.get(source, sourceLayer, key);
  };

  async queryRenderedFeatures(geometry?: QueryGeometry, options: QueryOptions = {}): Promise<QueriedFeature[]> {
    const style = this.style;
    if (!style || this.removed || this.contextLost) return [];
    const box = this.queryBox(geometry);
    let accept: (layer: StyleLayer) => boolean = () => true;
    if (options.layers !== undefined) {
      if (!Array.isArray(options.layers)) throw new MapletError("invalid-option", "layers must be a list of layer ids");
      for (const id of options.layers) {
        if (!style.getLayer(id))
          throw new MapletError("invalid-option", `There is no layer with id "${id}"`, { layer: id });
      }
      const wanted = new Set(options.layers);
      accept = (layer) => wanted.has(layer.id);
    }
    const frame = {
      transform: this.transform,
      view: this.transform,
      terrain: this.terrain,
      pixelRatio: this.pixelRatioValue,
      layers: style.layers,
      sources: style.sources,
      now: performance.now(),
      cameraVersion: this.cameraVersion,
      states: this.stateScope,
    };
    const ground = this.terrain ? this.groundQuery(box) : null;
    const picked = await this.painter.pick(
      frame,
      box,
      accept,
      ground
        ? { frame: { ...frame, transform: ground.transform, view: ground.transform, terrain: null }, box: ground.box }
        : undefined,
    );
    return resolveFeatures(picked, style.sources, this.readState);
  }

  private groundQuery(box: PickBox): { transform: Transform; box: PickBox } | null {
    const t = this.transform;
    const points: [number, number][] = [];
    const center = this.pickWorld((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
    if (center) points.push([center[0], center[1]]);
    const point = box.x1 - box.x0 <= 1.5 && box.y1 - box.y0 <= 1.5;
    if (!point) {
      for (const [x, y] of [
        [box.x0, box.y0],
        [box.x1, box.y0],
        [box.x1, box.y1],
        [box.x0, box.y1],
      ] as const) {
        const hit = this.pickWorld(x, y);
        if (hit) points.push([hit[0], hit[1]]);
      }
    }
    if (points.length === 0) return null;
    const flat = t.clone();
    flat.setPitchRange(0, 85);
    flat.setPitch(0);
    flat.setElevation(0);
    flat.setGround(0);
    if (point) {
      flat.setCenterWorld(points[0]![0], points[0]![1]);
      const x = flat.width / 2;
      const y = flat.height / 2;
      return { transform: flat, box: { x0: x - 0.5, y0: y - 0.5, x1: x + 0.5, y1: y + 0.5 } };
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of points) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    flat.setCenterWorld((x0 + x1) / 2, (y0 + y1) / 2);
    const extent = () => {
      let a = Infinity;
      let b = Infinity;
      let c = -Infinity;
      let d = -Infinity;
      for (const p of points) {
        const q = flat.project(p[0], p[1]);
        a = Math.min(a, q.x);
        b = Math.min(b, q.y);
        c = Math.max(c, q.x);
        d = Math.max(d, q.y);
      }
      return { x0: a, y0: b, x1: c, y1: d };
    };
    let found = extent();
    const fit = Math.max((found.x1 - found.x0) / flat.width, (found.y1 - found.y0) / flat.height);
    if (fit > 1) {
      flat.setZoom(flat.zoom - Math.log2(fit) - 0.01);
      found = extent();
    }
    return {
      transform: flat,
      box: {
        x0: Math.max(0, found.x0),
        y0: Math.max(0, found.y0),
        x1: Math.min(flat.width, Math.max(found.x0 + 1, found.x1)),
        y1: Math.min(flat.height, Math.max(found.y0 + 1, found.y1)),
      },
    };
  }

  private queryBox(geometry: QueryGeometry | undefined): PickBox {
    const width = this.transform.width;
    const height = this.transform.height;
    if (geometry === undefined) return { x0: 0, y0: 0, x1: width, y1: height };
    const point = (p: PointLike): [number, number] => {
      const x = Array.isArray(p) ? p[0] : p?.x;
      const y = Array.isArray(p) ? p[1] : p?.y;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new MapletError("invalid-option", "query points must be [x, y] or { x, y } in pixels");
      }
      return [x, y];
    };
    const pair = Array.isArray(geometry) && geometry.length === 2 && typeof geometry[0] === "object";
    if (pair) {
      const [ax, ay] = point((geometry as [PointLike, PointLike])[0]);
      const [bx, by] = point((geometry as [PointLike, PointLike])[1]);
      return {
        x0: Math.max(0, Math.min(ax, bx)),
        y0: Math.max(0, Math.min(ay, by)),
        x1: Math.min(width, Math.max(ax, bx)),
        y1: Math.min(height, Math.max(ay, by)),
      };
    }
    const [x, y] = point(geometry as PointLike);
    return { x0: x - 0.5, y0: y - 0.5, x1: x + 0.5, y1: y + 0.5 };
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

  getFilter(layerId: string): unknown {
    const filter = (this.layer(layerId).spec as { filter?: unknown }).filter;
    return filter === undefined ? undefined : structuredClone(filter);
  }

  getPaintProperty(layerId: string, name: string): unknown {
    const value = (this.layer(layerId).spec as { paint?: Record<string, unknown> }).paint?.[name];
    return value === undefined ? undefined : structuredClone(value);
  }

  getLayoutProperty(layerId: string, name: string): unknown {
    const value = (this.layer(layerId).spec as { layout?: Record<string, unknown> }).layout?.[name];
    return value === undefined ? undefined : structuredClone(value);
  }

  isSourceLoaded(id: string): boolean {
    const source = this.style?.sources.get(id);
    if (!source) throw new MapletError("invalid-option", `There is no source with id "${id}"`);
    return source.loaded && source.isIdle();
  }

  areTilesLoaded(): boolean {
    for (const source of this.style?.sources.values() ?? []) {
      if (source.loaded && !source.isIdle()) return false;
    }
    return true;
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
      terrain: this.terrain
        ? {
            tiles: this.terrain.slots.length,
            textureBytes: this.painter.drapeBytes,
            redrawn: this.painter.stats.drapes,
          }
        : null,
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
    this.featureStates = new FeatureStates();
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
      case "dem":
        return new DemSource(id, spec, ctx);
      default: {
        const type = (spec as { type: unknown }).type;
        throw new MapletError("invalid-style", `Source type "${String(type)}" is not supported`, { sourceId: id });
      }
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
        const x = mercatorX(lng);
        const y = mercatorY(lat);
        const z = this.groundAt(x, y);
        const p = t.project(x, y, z * t.worldSize);
        t.zoomAround(zoom, p.x, p.y, z);
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
    this.elevationIntent = "zoom";
    this.elevationFrom = this.transform.elevation;
    this.elevationTo = this.terrain ? this.terrain.elevationAt(to.x - Math.floor(to.x), to.y) : null;
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
    let progress: number | null = null;
    if (this.motion) {
      const m = this.motion;
      const t = (started - m.start) / m.motion.duration;
      m.motion.apply(this.transform, t);
      progress = Math.min(1, Math.max(0, t));
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
      this.updateTerrain(style, progress);
      if (moreUploads) animating = true;
      const labelsBusy = this.painter.render({
        transform: this.transform,
        view: this.transform,
        terrain: this.terrain,
        pixelRatio: this.pixelRatioValue,
        layers: style.layers,
        sources: style.sources,
        now,
        cameraVersion: this.cameraVersion,
        states: this.stateScope,
      });
      if (labelsBusy) animating = true;
      for (const source of style.sources.values()) {
        if (source.isFading()) animating = true;
      }
    } else {
      this.painter.render({
        transform: this.transform,
        view: this.transform,
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
      anchor: (px: number, py: number) => this.pickWorld(px, py),
      reducedMotion: () => this.prefersReducedMotion(),
      interrupt: () => {
        this.motion = null;
        this.elevationIntent = "camera";
      },
      changed: () => {
        this.elevationIntent = "camera";
        this.cameraChanged();
      },
      gesture: (active: boolean) => {
        this.gestureDepth = Math.max(0, this.gestureDepth + (active ? 1 : -1));
        this.triggerRepaint();
      },
      rotateEnded: () => {
        this.snapToNorth();
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
          const hit = this.pickWorld(around[0], around[1]);
          if (hit) options.around = [lngFromMercatorX(hit[0]), latFromMercatorY(hit[1])];
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
        const hit = this.pickWorld(point[0], point[1]);
        const ll: LngLat | null = hit ? [lngFromMercatorX(hit[0]), latFromMercatorY(hit[1])] : null;
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
