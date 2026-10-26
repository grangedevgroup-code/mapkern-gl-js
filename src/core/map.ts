import type { CameraMotion, CameraState, Easing } from "../camera/animation.ts";
import { easeInOutCubic, easeMotion, easeOutCubic, flyMotion, readState, samePadding } from "../camera/animation.ts";
import type { Padding, WorldBounds } from "../camera/transform.ts";
import { MIN_ZOOM, Transform } from "../camera/transform.ts";
import { featureKey } from "../formats/mvt.ts";
import type { LngLat, LngLatLike } from "../geo/mercator.ts";
import { latFromMercatorY, lngFromMercatorX, mercatorX, mercatorY, toLngLat, wrapLongitude } from "../geo/mercator.ts";
import { sunAltitude, sunAzimuth, sunPosition } from "../geo/sun.ts";
import type { InputOptions, TouchType } from "../input/handlers.ts";
import { InputHandlers } from "../input/handlers.ts";
import { GL } from "../render/gl.ts";
import type { SunLook } from "../render/night.ts";
import type { PickBox } from "../render/painter.ts";
import { Painter } from "../render/painter.ts";
import { DemSource } from "../sources/dem.ts";
import { GeoJSONSource } from "../sources/geojson.ts";
import { ImageSource } from "../sources/image.ts";
import { registerMbtilesProtocol } from "../sources/mbtiles.ts";
import { registerPmtilesProtocol } from "../sources/pmtiles.ts";
import { RasterSource } from "../sources/raster.ts";
import type { MapSource, SourceContext } from "../sources/source.ts";
import { VectorSource } from "../sources/vector.ts";
import { parseColor } from "../style/color.ts";
import type { Compiled } from "../style/expression.ts";
import { compile } from "../style/expression.ts";
import type { FeatureTarget, StateLookup } from "../style/feature-state.ts";
import { FeatureStates } from "../style/feature-state.ts";
import { importStyle, isStyleV8 } from "../style/import.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { StyleUpdate } from "../style/style.ts";
import { assertValid, Style } from "../style/style.ts";
import type { LayerSpec, SkySpec, SourceSpec, StyleSpec, StyleSpecV8, SunSpec, TerrainSpec } from "../style/types.ts";
import { sunTime, validateSky, validateSun } from "../style/validate.ts";
import { highestClearZoom, metersToWorld, Terrain } from "../terrain/terrain.ts";
import type { ResponseStore } from "../tiles/cache.ts";
import { sharedDiskCache } from "../tiles/cache.ts";
import type { TransformRequest } from "../tiles/fetch.ts";
import { fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileStats } from "../tiles/manager.ts";
import { RequestScheduler } from "../tiles/scheduler.ts";
import type { Control, ControlPosition } from "../ui/controls.ts";
import { AttributionControl } from "../ui/controls.ts";
import { injectStyles } from "../ui/css.ts";
import type { DebugTile } from "../ui/debug.ts";
import { DebugOverlay } from "../ui/debug.ts";
import { LogoControl } from "../ui/logo.ts";
import type { WorkerFactory } from "../worker/pool.ts";
import { WorkerPool } from "../worker/pool.ts";
import { deepClone } from "./clone.ts";
import { errorMessage, MapkernError } from "./errors.ts";
import type { Listener } from "./events.ts";
import { Emitter } from "./events.ts";
import { MapHash } from "./hash.ts";
import type { ImageInput, ImageOptions } from "./images.ts";
import { pixelsOf, spriteImages, spriteSheets, spriteUrl, styleImage } from "./images.ts";
import type { LayerEventType, PointerInput, PointerType } from "./layer-events.ts";
import { LAYER_EVENT_TYPES, LayerEvents } from "./layer-events.ts";
import type { QueriedFeature, SourceQueriedFeature, StateReader } from "./query.ts";
import { queryVectorSource, resolveFeatures } from "./query.ts";

export interface SetStyleOptions {
  diff?: boolean;
}

export interface MapOptions {
  container: HTMLElement | string;
  style?: StyleSpec | StyleSpecV8 | string | null;
  center?: LngLatLike;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  minZoom?: number;
  maxZoom?: number;
  minPitch?: number;
  maxPitch?: number;
  renderWorldCopies?: boolean;
  maxBounds?: BoundsLike;
  bounds?: BoundsLike;
  hash?: boolean | string;
  cooperativeGestures?: boolean;
  fitBoundsOptions?: FitBoundsOptions;
  padding?: PaddingOptions;
  interactive?: boolean;
  dragPan?: boolean;
  dragRotate?: boolean;
  scrollZoom?: boolean;
  doubleClickZoom?: boolean;
  touchZoomRotate?: boolean;
  touchPitch?: boolean;
  keyboard?: boolean;
  boxZoom?: boolean;
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
  logoControl?: boolean;
  diskCache?: boolean | { size?: number };
  workerCount?: number;
  workerUrl?: string;
  reducedMotion?: boolean;
  locale?: Partial<Record<UiText, string>>;
}

export type UiText =
  | "zoomIn"
  | "zoomOut"
  | "resetNorth"
  | "map"
  | "marker"
  | "popup"
  | "closePopup"
  | "fullscreen"
  | "exitFullscreen"
  | "geolocate"
  | "locationUnavailable"
  | "yourLocation"
  | "scrollZoomBlocker"
  | "scrollZoomBlockerMac"
  | "touchPanBlocker"
  | "basemaps"
  | "flatView"
  | "terrainView"
  | "tiltedView"
  | "search"
  | "searchPlaceholder"
  | "noResults"
  | "searchFailed";

const NEAR_SAMPLES = 8;
const PREFETCH_MARGIN = 1.4;

const DEFAULT_TEXT: Record<UiText, string> = {
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  resetNorth: "Reset bearing to north",
  map: "Map",
  marker: "Map marker",
  popup: "Map popup",
  closePopup: "Close popup",
  fullscreen: "Enter fullscreen",
  exitFullscreen: "Exit fullscreen",
  geolocate: "Find my location",
  locationUnavailable: "Your location is not available",
  yourLocation: "Your location",
  scrollZoomBlocker: "Use Ctrl + scroll to zoom the map",
  scrollZoomBlockerMac: "Use ⌘ + scroll to zoom the map",
  touchPanBlocker: "Use two fingers to move the map",
  basemaps: "Choose a basemap",
  flatView: "2D map",
  terrainView: "3D terrain from above",
  tiltedView: "Tilted 3D terrain",
  search: "Search",
  searchPlaceholder: "Search places and addresses",
  noResults: "Nothing found",
  searchFailed: "Search is not available",
};

export interface ScreenPosition {
  x: number;
  y: number;
  visible: boolean;
  occluded: boolean;
}

export type PaddingOptions = number | { top?: number; right?: number; bottom?: number; left?: number };

export interface CameraOptions {
  center?: LngLatLike;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  around?: LngLatLike;
  padding?: PaddingOptions;
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
  padding?: PaddingOptions;
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

export type Source = RasterSource | VectorSource | GeoJSONSource | DemSource | ImageSource;

export type PointLike = [number, number] | { x: number; y: number };

export type QueryGeometry = PointLike | [PointLike, PointLike];

export interface QueryOptions {
  layers?: string[];
}

export interface MapEvent {
  readonly target: MapkernMap;
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

export interface MapLayerEvent extends MapPointerEvent {
  readonly type: LayerEventType;
  readonly features: QueriedFeature[];
}

export type MapLayerEvents = { [K in LayerEventType]: MapLayerEvent };

export interface StyleImageMissingEvent extends MapEvent {
  readonly id: string;
}

export interface MapStyleEvent extends MapEvent {
  readonly skipped: readonly string[];
}

export interface MapWheelEvent extends MapEvent {
  readonly point: { x: number; y: number };
  readonly lngLat: LngLat | null;
  readonly originalEvent: WheelEvent;
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

export interface MapTouchEvent extends MapEvent {
  readonly point: { x: number; y: number };
  readonly lngLat: LngLat | null;
  readonly points: { x: number; y: number }[];
  readonly lngLats: (LngLat | null)[];
  readonly originalEvent: TouchEvent;
}

export interface MapErrorEvent extends MapEvent {
  readonly error: MapkernError;
  readonly sourceId?: string | undefined;
}

export interface MapDataEvent extends MapEvent {
  readonly dataType: "style" | "source";
  readonly sourceId?: string | undefined;
}

export interface SourceDataEvent extends MapEvent {
  readonly sourceId: string;
  readonly kind: "metadata" | "content" | "error";
}

export interface MapEvents {
  load: MapEvent;
  styleload: MapStyleEvent;
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
  boxzoomstart: MapMoveEvent;
  boxzoomend: MapMoveEvent;
  boxzoomcancel: MapMoveEvent;
  error: MapErrorEvent;
  sourcedata: SourceDataEvent;
  styleimagemissing: StyleImageMissingEvent;
  click: MapPointerEvent;
  dblclick: MapPointerEvent;
  contextmenu: MapPointerEvent;
  mousemove: MapPointerEvent;
  mousedown: MapPointerEvent;
  mouseup: MapPointerEvent;
  mouseout: MapPointerEvent;
  wheel: MapWheelEvent;
  dragstart: MapMoveEvent;
  drag: MapMoveEvent;
  dragend: MapMoveEvent;
  touchstart: MapTouchEvent;
  touchmove: MapTouchEvent;
  touchend: MapTouchEvent;
  touchcancel: MapTouchEvent;
  styledata: MapEvent;
  data: MapDataEvent;
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

export class MapkernMap extends Emitter<MapEvents> {
  readonly transform: Transform;
  readonly dragPan: HandlerSwitch;
  readonly dragRotate: HandlerSwitch;
  readonly scrollZoom: HandlerSwitch;
  readonly doubleClickZoom: HandlerSwitch;
  readonly touchZoomRotate: TouchZoomRotateSwitch;
  readonly touchPitch: HandlerSwitch;
  readonly keyboard: HandlerSwitch;
  readonly boxZoom: HandlerSwitch;
  readonly cooperativeGestures: HandlerSwitch;
  private readonly container: HTMLElement;
  private readonly canvasContainer: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly controlCorners = new Map<ControlPosition, HTMLElement>();
  private readonly controls: { control: Control; element: HTMLElement }[] = [];
  private readonly glContext: GL;
  private readonly painter: Painter;
  private readonly scheduler: RequestScheduler;
  private readonly diskCache: ResponseStore | null;
  private readonly handlers: InputHandlers | null;
  private readonly options: MapOptions;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly strings: Record<UiText, string>;
  private readonly cleanup: (() => void)[] = [];
  private workers: WorkerPool | null = null;
  private style: Style | null = null;
  private styleRequest: AbortController | null = null;
  private spriteRequest: AbortController | null = null;
  private hash: MapHash | null = null;
  private debug: DebugOverlay | null = null;
  private readonly debugFlags = { tiles: false, boxes: false, padding: false };
  private hashPlaced = false;
  private spritesLoading = 0;
  private readonly reportedImages = new Set<string>();
  private reportedVersion = -1;
  private frameHandle = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeAtTime = Number.POSITIVE_INFINITY;
  private motion: { motion: CameraMotion; start: number; flags: CameraFlags } | null = null;
  private terrain: Terrain | null = null;
  private featureStates = new FeatureStates();
  private readonly layerEvents: LayerEvents<MapLayerEvent> = new LayerEvents<MapLayerEvent>({
    query: (point, layers) => this.queryLayersAt(point, layers),
    event: (type, input, features, prevent) => {
      let prevented = false;
      return {
        target: this,
        type,
        point: { x: input.point[0], y: input.point[1] },
        lngLat: input.lngLat,
        originalEvent: input.event,
        features,
        preventDefault: () => {
          prevented = true;
          prevent();
        },
        get defaultPrevented() {
          return prevented;
        },
      };
    },
    active: () => !this.removed,
  });
  private elevationIntent: "zoom" | "camera" = "zoom";
  private elevationFrom = 0;
  private elevationTo: number | null = null;
  private removed = false;
  private sunClock = 0;
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
  private lastInput: Event | undefined;
  private hostCall = false;
  private frameTimes: number[] = [];
  private frameCount = 0;
  private longFrames = 0;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = () => this.watchPixelRatio();

  constructor(options: MapOptions) {
    super();
    if (typeof options !== "object" || options === null) {
      throw new MapkernError("invalid-option", "new Map(options) needs an options object");
    }
    this.options = { ...options };
    this.strings = { ...DEFAULT_TEXT, ...(options.locale ?? {}) };
    const container =
      typeof options.container === "string" ? document.getElementById(options.container) : options.container;
    if (!container || !(container instanceof HTMLElement)) {
      throw new MapkernError("invalid-option", `Map container ${String(options.container)} was not found`);
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
      checkNumber(options.minZoom, "minZoom", MIN_ZOOM),
      checkNumber(options.maxZoom, "maxZoom", 22),
    );
    const world = worldView(container);
    this.transform.setZoom(checkNumber(options.zoom, "zoom", world.zoom));
    this.transform.setBearing(checkNumber(options.bearing, "bearing", 0));
    this.transform.setPitch(checkNumber(options.pitch, "pitch", 0));
    if (options.padding !== undefined) this.transform.setPadding(normalizePadding(options.padding));
    if (options.center !== undefined) {
      const [lng, lat] = toLngLat(options.center);
      this.transform.setCenter(lng, lat);
    } else if (options.zoom === undefined) {
      this.transform.setCenter(world.center[0], world.center[1]);
    }
    if (options.maxBounds !== undefined) this.transform.setMaxBounds(worldBounds(options.maxBounds));
    this.lastState = readState(this.transform);

    container.classList.add("mapkern-map");
    this.canvasContainer = doc.createElement("div");
    this.canvasContainer.className = "mapkern-canvas-container";
    this.canvasContainer.tabIndex = options.interactive === false ? -1 : 0;
    this.canvasContainer.setAttribute("role", "region");
    this.canvasContainer.setAttribute("aria-label", this.strings.map);
    this.canvas = doc.createElement("canvas");
    this.canvas.className = "mapkern-canvas";
    this.canvasContainer.appendChild(this.canvas);
    container.appendChild(this.canvasContainer);
    for (const pos of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      const corner = doc.createElement("div");
      corner.className = `mapkern-corner mapkern-${pos}`;
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
    this.diskCache = openDiskCache(options.diskCache);
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
        boxZoom: options.boxZoom ?? true,
        cooperative: options.cooperativeGestures === true,
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
    this.boxZoom = this.handlerSwitch("boxZoom");
    const cooperative = this.handlerSwitch("cooperative");
    this.cooperativeGestures = {
      enable: () => {
        cooperative.enable();
        this.canvasContainer.style.touchAction = "pan-x pan-y";
      },
      disable: () => {
        cooperative.disable();
        this.canvasContainer.style.touchAction = "";
      },
      isEnabled: cooperative.isEnabled,
    };
    if (options.cooperativeGestures === true) this.canvasContainer.style.touchAction = "pan-x pan-y";
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
    if (options.logoControl !== false) this.addControl(new LogoControl());

    if (options.bounds !== undefined) {
      const camera = this.cameraForBounds(options.bounds, options.fitBoundsOptions ?? {});
      if (camera) this.applyCamera(camera);
      this.lastState = readState(this.transform);
    }
    if (options.hash !== undefined && options.hash !== false) {
      this.hash = new MapHash(this, typeof options.hash === "string" ? options.hash : null);
      const position = this.hash.read();
      if (position) {
        this.applyCamera(position);
        this.lastState = readState(this.transform);
        this.hashPlaced = true;
      }
    }
    const style = options.style === undefined ? DEFAULT_STYLE : options.style;
    if (style !== null) this.setStyle(style);
    this.triggerRepaint();
  }

  text(key: UiText): string {
    return this.strings[key];
  }

  override on<K extends keyof MapEvents>(type: K, listener: Listener<MapEvents[K]>): this;
  override on<K extends keyof MapLayerEvents>(
    type: K,
    layers: string | readonly string[],
    listener: Listener<MapLayerEvents[K]>,
  ): this;
  override on(type: keyof MapEvents, layersOrListener: unknown, listener?: unknown): this {
    if (typeof layersOrListener === "function")
      return super.on(type, layersOrListener as Listener<MapEvents[keyof MapEvents]>);
    this.layerEvents.add(layerEventType(type), layerList(layersOrListener), checkListener(listener));
    return this;
  }

  override off<K extends keyof MapEvents>(type: K, listener: Listener<MapEvents[K]>): this;
  override off<K extends keyof MapLayerEvents>(
    type: K,
    layers: string | readonly string[],
    listener: Listener<MapLayerEvents[K]>,
  ): this;
  override off(type: keyof MapEvents, layersOrListener: unknown, listener?: unknown): this {
    if (typeof layersOrListener === "function")
      return super.off(type, layersOrListener as Listener<MapEvents[keyof MapEvents]>);
    this.layerEvents.remove(layerEventType(type), layerList(layersOrListener), checkListener(listener));
    return this;
  }

  override once<K extends keyof MapEvents>(type: K, listener?: Listener<MapEvents[K]>): Promise<MapEvents[K]>;
  override once<K extends keyof MapLayerEvents>(
    type: K,
    layers: string | readonly string[],
    listener?: Listener<MapLayerEvents[K]>,
  ): Promise<MapLayerEvents[K]>;
  override once(type: keyof MapEvents, layersOrListener?: unknown, listener?: unknown): Promise<unknown> {
    if (layersOrListener === undefined || typeof layersOrListener === "function") {
      return super.once(type, layersOrListener as Listener<MapEvents[keyof MapEvents]> | undefined);
    }
    const kind = layerEventType(type);
    const layers = layerList(layersOrListener);
    const callback = listener === undefined ? undefined : checkListener(listener);
    return new Promise((resolve) => {
      const wrapper: Listener<MapLayerEvent> = (event) => {
        this.layerEvents.remove(kind, layers, wrapper);
        callback?.(event);
        resolve(event);
      };
      this.layerEvents.add(kind, layers, wrapper);
    });
  }

  private async queryLayersAt(point: [number, number], layers: readonly string[]): Promise<QueriedFeature[]> {
    const style = this.style;
    if (!style || this.removed) return [];
    const existing = layers.filter((id) => style.getLayer(id) !== undefined);
    if (existing.length === 0) return [];
    return this.queryRenderedFeatures(point, { layers: existing });
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
      | "keyboard"
      | "boxZoom"
      | "cooperative",
  ): HandlerSwitch {
    return {
      enable: () => {
        if (this.handlers) this.handlers.options[key] = true;
      },
      disable: () => {
        if (!this.handlers) return;
        this.handlers.options[key] = false;
        if (key !== "touchRotate" && key !== "cooperative") this.handlers.stopMomentum();
      },
      isEnabled: () => this.handlers?.options[key] === true,
    };
  }

  get showTileBoundaries(): boolean {
    return this.debugFlags.tiles;
  }

  set showTileBoundaries(on: boolean) {
    this.debugFlags.tiles = on === true;
    this.triggerRepaint();
  }

  get showCollisionBoxes(): boolean {
    return this.debugFlags.boxes;
  }

  set showCollisionBoxes(on: boolean) {
    this.debugFlags.boxes = on === true;
    this.triggerRepaint();
  }

  get showPadding(): boolean {
    return this.debugFlags.padding;
  }

  set showPadding(on: boolean) {
    this.debugFlags.padding = on === true;
    this.triggerRepaint();
  }

  private drawDebug(): void {
    const f = this.debugFlags;
    if (!f.tiles && !f.boxes && !f.padding) {
      this.debug?.destroy();
      this.debug = null;
      return;
    }
    this.debug ??= new DebugOverlay(this.canvasContainer);
    const t = this.transform;
    const tiles: DebugTile[] = [];
    if (f.tiles) {
      for (const source of this.style?.sources.values() ?? []) {
        const pieces = (
          source as {
            manager?: { pieces: readonly { tile: { z: number; x: number; y: number }; wrap: number }[] } | null;
          }
        ).manager?.pieces;
        if (!pieces) continue;
        for (const piece of pieces) {
          const { z, x, y } = piece.tile;
          const n = 2 ** z;
          const corners = [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
          ].map(([cx, cy]) => {
            const p = t.project(piece.wrap + cx! / n, cy! / n);
            return [p.x, p.y] as const;
          });
          tiles.push({ corners, label: `${z}/${x}/${y}` });
        }
        break;
      }
    }
    this.debug.draw({
      width: t.width,
      height: t.height,
      pixelRatio: this.pixelRatioValue,
      tiles,
      boxes: f.boxes ? this.painter.labels.debugBoxes() : [],
      padding: f.padding ? t.padding : null,
      center: f.padding ? t.centerPoint : null,
    });
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
    this.transform.setZoomRange(checkNumber(zoom, "minZoom", MIN_ZOOM), this.transform.maxZoom);
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

  getMaxBounds(): [[number, number], [number, number]] | null {
    const b = this.transform.maxBounds;
    if (!b) return null;
    return [
      [lngFromMercatorX(b.x0), latFromMercatorY(b.y1)],
      [lngFromMercatorX(b.x1), latFromMercatorY(b.y0)],
    ];
  }

  setMaxBounds(bounds: BoundsLike | null): this {
    this.transform.setMaxBounds(bounds === null || bounds === undefined ? null : worldBounds(bounds));
    this.cameraChanged();
    return this;
  }

  getPadding(): Padding {
    return this.transform.padding;
  }

  setPadding(padding: PaddingOptions): this {
    this.transform.setPadding(normalizePadding(padding));
    this.cameraChanged();
    return this;
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
    if (!this.hostCall) this.gestureEvent = undefined;
    this.stop();
    this.elevationIntent = "zoom";
    this.elevationTo = null;
    this.applyCamera(options);
    this.cameraChanged();
    return this;
  }

  setTerrain(terrain: TerrainSpec | null): this {
    const style = this.style;
    if (!style) throw new MapkernError("invalid-option", "Set a style before turning on terrain");
    if (terrain === null) {
      delete style.meta.terrain;
    } else {
      const source = typeof terrain?.source === "string" ? style.sources.get(terrain.source) : undefined;
      if (source?.type !== "dem") {
        throw new MapkernError("invalid-option", "terrain.source must name a dem source", { terrain });
      }
      const exaggeration = terrain.exaggeration ?? 1;
      if (typeof exaggeration !== "number" || !Number.isFinite(exaggeration) || exaggeration < 0) {
        throw new MapkernError("invalid-option", "terrain.exaggeration must be a number of 0 or more", { terrain });
      }
      const relief = terrain.relief ?? 0;
      if (typeof relief !== "number" || !(relief >= 0 && relief <= 1)) {
        throw new MapkernError("invalid-option", "terrain.relief must be a number from 0 to 1", { terrain });
      }
      style.meta.terrain =
        relief > 0 ? { source: terrain.source, exaggeration, relief } : { source: terrain.source, exaggeration };
    }
    this.cameraChanged();
    return this;
  }

  getTerrain(): TerrainSpec | null {
    const terrain = this.style?.meta.terrain;
    return terrain ? { ...terrain } : null;
  }

  setSky(sky: SkySpec | null): this {
    const style = this.style;
    if (!style) throw new MapkernError("invalid-option", "Set a style before changing the sky");
    if (sky === null) {
      delete style.meta.sky;
    } else {
      const issues = validateSky(sky);
      if (issues.length > 0) {
        throw new MapkernError("invalid-option", `${issues[0]!.path} ${issues[0]!.message}`, { sky });
      }
      style.meta.sky = deepClone(sky);
    }
    this.triggerRepaint();
    return this;
  }

  getSky(): SkySpec | null {
    const sky = this.style?.meta.sky;
    return sky ? deepClone(sky) : null;
  }

  setSun(sun: (Omit<SunSpec, "time"> & { time?: SunSpec["time"] | Date }) | null): this {
    const style = this.style;
    if (!style) throw new MapkernError("invalid-option", "Set a style before turning on day and night");
    if (sun === null) {
      delete style.meta.sun;
    } else {
      const spec: SunSpec = sun.time instanceof Date ? { ...sun, time: sun.time.getTime() } : (sun as SunSpec);
      const issues = validateSun(spec);
      if (issues.length > 0) {
        throw new MapkernError("invalid-option", `${issues[0]!.path} ${issues[0]!.message}`, { sun });
      }
      style.meta.sun = deepClone(spec);
    }
    this.triggerRepaint();
    return this;
  }

  getSun(): SunSpec | null {
    const sun = this.style?.meta.sun;
    return sun ? deepClone(sun) : null;
  }

  private sunLook(sun: SunSpec | undefined): SunLook | null {
    if (!sun) {
      if (this.sunClock) clearInterval(this.sunClock);
      this.sunClock = 0;
      return null;
    }
    const live = sun.time === undefined || sun.time === "now";
    if (live && !this.sunClock) this.sunClock = setInterval(() => this.triggerRepaint(), 60000) as unknown as number;
    if (!live && this.sunClock) {
      clearInterval(this.sunClock);
      this.sunClock = 0;
    }
    const time = sunTime(sun.time) ?? Date.now();
    const night = parseColor(sun.night ?? NIGHT) ?? [0.16, 0.2, 0.36, 1];
    const position = sunPosition(time);
    let light: [number, number, number] | null = null;
    if (sun.shade !== false) {
      const [lng, lat] = this.transform.center;
      const azimuth = (sunAzimuth(position, lng, lat) * Math.PI) / 180;
      const altitude = (Math.min(75, Math.max(4, sunAltitude(position, lng, lat))) * Math.PI) / 180;
      light = [Math.sin(azimuth) * Math.cos(altitude), -Math.cos(azimuth) * Math.cos(altitude), Math.sin(altitude)];
    }
    return { sun: position, night: [night[0], night[1], night[2]], twilight: sun.twilight ?? 12, light };
  }

  easeTo(options: CameraOptions & AnimationOptions): this {
    if (!this.hostCall) this.gestureEvent = undefined;
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
    if (!this.hostCall) this.gestureEvent = undefined;
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
    const [cx, cy] = t.centerPoint;
    const target = t.unprojectClamped(cx + offset[0], cy + offset[1]);
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
    return this.moveTo(camera, options);
  }

  cameraForBounds(bounds: BoundsLike, options: FitBoundsOptions = {}): CameraOptions | null {
    const b = worldBounds(bounds);
    return this.cameraForWorld(
      [
        [b.x0, b.y0],
        [b.x1, b.y0],
        [b.x1, b.y1],
        [b.x0, b.y1],
      ],
      options,
    );
  }

  fitScreenCoordinates(p0: PointLike, p1: PointLike, bearing: number, options: FitBoundsOptions = {}): this {
    const [ax, ay] = screenPoint(p0);
    const [bx, by] = screenPoint(p1);
    const points: [number, number][] = [];
    for (const [x, y] of [
      [ax, ay],
      [bx, ay],
      [bx, by],
      [ax, by],
    ] as const) {
      const hit = this.pickWorld(x, y);
      if (hit) points.push([hit[0], hit[1]]);
    }
    if (points.length === 0) return this;
    const camera = this.cameraForWorld(points, { ...options, bearing: checkNumber(bearing, "bearing", 0) });
    if (!camera) return this;
    return this.moveTo(camera, options);
  }

  private cameraForWorld(
    points: readonly (readonly [number, number])[],
    options: FitBoundsOptions,
  ): CameraOptions | null {
    const pad = normalizePadding(options.padding);
    const t = this.transform;
    const own = t.padding;
    const width = t.width - pad.left - pad.right - own.left - own.right;
    const height = t.height - pad.top - pad.bottom - own.top - own.bottom;
    if (width <= 0 || height <= 0) return null;
    const bearing = ((options.bearing ?? t.bearing) * Math.PI) / 180;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, y] of points) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const scale = Math.min(width / Math.max((u1 - u0) * 512, 1e-12), height / Math.max((v1 - v0) * 512, 1e-12));
    const zoom = Math.min(Math.log2(scale), options.maxZoom ?? t.maxZoom);
    const ws = 512 * 2 ** zoom;
    const uc = (u0 + u1) / 2 - (pad.left - pad.right) / 2 / ws;
    const vc = (v0 + v1) / 2 - (pad.top - pad.bottom) / 2 / ws;
    const x = uc * cos - vc * sin;
    const y = uc * sin + vc * cos;
    return {
      center: [lngFromMercatorX(x), latFromMercatorY(y)],
      zoom,
      bearing: options.bearing ?? t.bearing,
      pitch: options.pitch ?? t.pitch,
    };
  }

  private moveTo(camera: CameraOptions, options: FitBoundsOptions): this {
    const anim: AnimationOptions = {};
    if (options.duration !== undefined) anim.duration = options.duration;
    if (options.easing !== undefined) anim.easing = options.easing;
    if (options.animate !== undefined) anim.animate = options.animate;
    return options.linear === false ? this.flyTo({ ...camera, ...anim }) : this.easeTo({ ...camera, ...anim });
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

  screenPosition(lngLat: LngLatLike): ScreenPosition {
    const [lng, lat] = toLngLat(lngLat);
    const t = this.transform;
    let x = mercatorX(lng);
    const y = mercatorY(lat);
    if (t.renderWorldCopies) x += Math.round(t.centerWorld[0] - x);
    const z = this.groundAt(x, y);
    const ws = t.worldSize;
    const p = t.project(x, y, z * ws);
    const visible = p.w > 0 && p.w <= t.far;
    let occluded = false;
    if (visible && this.terrain) {
      const c = t.cameraPosition;
      occluded = this.terrain.hidden([c[0] / ws, c[1] / ws, c[2] / ws], x, y, z);
    }
    return { x: p.x, y: p.y, visible, occluded };
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
    terrain.relief = Math.min(1, Math.max(0, spec.relief ?? 0));
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
      if (this.elevationIntent === "camera" && progress === null && floor !== null && floor > t.elevation + 1e-3) {
        this.backOff(terrain);
      } else {
        const wanted = floor === null ? target : Math.max(target, floor);
        if (Math.abs(wanted - t.elevation) > 1e-3) t.setElevation(wanted);
      }
      if (t.elevation !== before || t.zoom !== zoom) this.cameraVersion++;
    }
    t.setPeak(this.nearPeak(terrain));
    terrain.update(t);
    t.setGround(Math.min(terrain.ground, t.elevation));
  }

  private backOff(terrain: Terrain): void {
    const t = this.transform;
    const clear = (zoom: number) => {
      t.setZoom(zoom);
      const floor = this.cameraFloor(terrain);
      return floor === null || floor <= t.elevation + 1e-3;
    };
    const requested = t.zoom;
    const zoom = highestClearZoom(requested, Math.max(t.minZoom, requested - 8), clear);
    if (zoom === null) {
      t.setZoom(requested);
      const floor = this.cameraFloor(terrain);
      if (floor !== null) t.setElevation(floor);
      return;
    }
    t.setZoom(zoom);
  }

  private nearPeak(terrain: Terrain): number {
    const t = this.transform;
    const ws = t.worldSize;
    const camera = t.cameraPosition;
    const ground = t.ground * t.pixelsPerMeter;
    let peak = Number.NEGATIVE_INFINITY;
    const sample = (x: number, y: number) => {
      const meters = terrain.elevationAt(x, y);
      if (meters !== null && meters > peak) peak = meters;
    };
    const cx = camera[0] / ws;
    const cy = camera[1] / ws;
    sample(cx, cy);
    for (const px of [0, t.width / 2, t.width]) {
      const [hx, hy] = t.unprojectClamped(px, t.height, ground);
      for (let i = 1; i <= NEAR_SAMPLES; i++) {
        const f = i / NEAR_SAMPLES;
        sample(cx + (hx - cx) * f, cy + (hy - cy) * f);
      }
    }
    return peak;
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

  setStyle(style: StyleSpec | StyleSpecV8 | string, options: SetStyleOptions = {}): this {
    const diff = options.diff !== false;
    this.styleRequest?.abort();
    this.styleRequest = null;
    if (typeof style === "string") {
      const controller = new AbortController();
      this.styleRequest = controller;
      const params = resolveRequest(style, "style", this.options.transformRequest);
      fetchBytes(params, controller.signal, this.requestTimeout(), "style", this.diskCache)
        .then((result) => {
          if (controller.signal.aborted || this.removed) return;
          if (result.kind === "empty") throw new MapkernError("invalid-style", `Style not found at ${style}`);
          let spec: unknown;
          try {
            spec = JSON.parse(new TextDecoder().decode(result.data));
          } catch (error) {
            throw new MapkernError("invalid-style", `Style at ${style} is not valid JSON`, {}, error);
          }
          this.applyStyle(spec as StyleSpec, diff, absoluteUrl(params.url));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || this.removed) return;
          this.fail(
            error instanceof MapkernError
              ? error
              : new MapkernError("invalid-style", `Could not load the style: ${errorMessage(error)}`, {}, error),
          );
        });
    } else {
      this.applyStyle(style, diff);
    }
    return this;
  }

  getStyle(): StyleSpec | null {
    return this.style?.serialize() ?? null;
  }

  addImage(id: string, image: ImageInput, options: ImageOptions = {}): this {
    if (this.painter.images.has(id)) {
      throw new MapkernError(
        "invalid-option",
        `There is already an image named "${id}"; use updateImage to change it`,
        {
          image: id,
        },
      );
    }
    this.painter.images.add(styleImage(id, image, options, false));
    this.triggerRepaint();
    return this;
  }

  updateImage(id: string, image: ImageInput): this {
    const current = this.painter.images.image(id);
    if (!current) throw new MapkernError("invalid-option", `There is no image named "${id}"`, { image: id });
    this.painter.images.add(
      styleImage(id, image, { pixelRatio: current.pixelRatio, sdf: current.sdf }, current.sprite),
    );
    this.triggerRepaint();
    return this;
  }

  hasImage(id: string): boolean {
    return this.painter.images.has(id);
  }

  removeImage(id: string): this {
    if (this.painter.images.remove(id)) this.triggerRepaint();
    return this;
  }

  listImages(): string[] {
    return this.painter.images.list();
  }

  async loadImage(url: string): Promise<ImageBitmap> {
    const params = resolveRequest(url, "image", this.options.transformRequest);
    const result = await fetchBytes(
      params,
      new AbortController().signal,
      this.requestTimeout(),
      "image",
      this.diskCache,
    ).catch((error: unknown) => {
      throw resourceError(error, `Could not load the image ${url}`);
    });
    if (result.kind === "empty") throw new MapkernError("http", `There is no image at ${url}`, { url });
    try {
      return await createImageBitmap(new Blob([result.data], { type: result.contentType || "image/png" }));
    } catch (error) {
      throw new MapkernError("decode", `The file at ${url} is not an image the browser can read`, { url }, error);
    }
  }

  isStyleLoaded(): boolean {
    return this.style?.loaded ?? false;
  }

  addSource(id: string, spec: SourceSpec): this {
    this.requireStyle().addSource(id, spec);
    this.styleChanged();
    return this;
  }

  removeSource(id: string): this {
    this.requireStyle().removeSource(id);
    this.featureStates.dropSource(id);
    this.styleChanged();
    this.triggerRepaint();
    return this;
  }

  setFeatureState(feature: FeatureTarget, state: Record<string, unknown>): this {
    const target = this.stateTarget(feature, "setFeatureState");
    if (target.key === undefined) {
      throw new MapkernError("invalid-option", "setFeatureState needs a feature id", { sourceId: target.source });
    }
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new MapkernError("invalid-option", "setFeatureState needs a state object such as { hover: true }");
    }
    this.featureStates.set(target.source, target.sourceLayer, target.key, state);
    this.triggerRepaint();
    return this;
  }

  getFeatureState(feature: FeatureTarget): Record<string, unknown> {
    const target = this.stateTarget(feature, "getFeatureState");
    if (target.key === undefined) {
      throw new MapkernError("invalid-option", "getFeatureState needs a feature id", { sourceId: target.source });
    }
    return this.featureStates.get(target.source, target.sourceLayer, target.key);
  }

  removeFeatureState(feature: FeatureTarget, key?: string): this {
    const target = this.stateTarget(feature, "removeFeatureState");
    if (key !== undefined && (typeof key !== "string" || target.key === undefined)) {
      throw new MapkernError(
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
      throw new MapkernError("invalid-option", `${method} needs { source, sourceLayer, id }`);
    }
    const source = this.requireStyle().sources.get(feature.source);
    if (!source) {
      throw new MapkernError("invalid-option", `There is no source with id "${feature.source}"`, {
        sourceId: feature.source,
      });
    }
    if (source.type !== "vector" && source.type !== "geojson") {
      throw new MapkernError("invalid-option", `Feature state needs a vector or geojson source, not ${source.type}`, {
        sourceId: feature.source,
      });
    }
    let sourceLayer: string | undefined;
    if (source.type === "vector") {
      if (typeof feature.sourceLayer !== "string" || feature.sourceLayer === "") {
        throw new MapkernError(
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
        throw new MapkernError("invalid-option", "Feature ids are finite numbers or non-empty strings", {
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

  private readonly stateOf: StateReader = (source, sourceLayer, id) => {
    const key = featureKey(id);
    return key === undefined ? {} : this.featureStates.get(source, sourceLayer, key);
  };

  async queryRenderedFeatures(geometry?: QueryGeometry, options: QueryOptions = {}): Promise<QueriedFeature[]> {
    const style = this.style;
    if (!style || this.removed || this.contextLost) return [];
    const box = this.queryBox(geometry);
    let accept: (layer: StyleLayer) => boolean = () => true;
    if (options.layers !== undefined) {
      if (!Array.isArray(options.layers))
        throw new MapkernError("invalid-option", "layers must be a list of layer ids");
      for (const id of options.layers) {
        if (!style.getLayer(id))
          throw new MapkernError("invalid-option", `There is no layer with id "${id}"`, { layer: id });
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
    return resolveFeatures(picked, style.sources, this.stateOf);
  }

  async querySourceFeatures(
    sourceId: string,
    options: { sourceLayer?: string; filter?: unknown } = {},
  ): Promise<SourceQueriedFeature[]> {
    const style = this.style;
    if (!style || this.removed) return [];
    const source = style.sources.get(sourceId);
    if (!source) {
      throw new MapkernError("invalid-option", `There is no source with id "${sourceId}"`, { sourceId });
    }
    if (source.type !== "vector" && source.type !== "geojson") {
      throw new MapkernError(
        "invalid-option",
        `querySourceFeatures needs a vector or geojson source, not ${source.type}`,
        {
          sourceId,
        },
      );
    }
    if (options.sourceLayer !== undefined && typeof options.sourceLayer !== "string") {
      throw new MapkernError("invalid-option", "sourceLayer must be the name of a layer in the tiles", { sourceId });
    }
    let filter: Compiled<boolean> | null = null;
    if (options.filter !== undefined && options.filter !== null) {
      try {
        filter = compile<boolean>(options.filter, "boolean", false, "filter", { geometry: true });
      } catch (error) {
        throw new MapkernError("invalid-option", errorMessage(error), { sourceId }, error);
      }
    }
    if (source.type === "vector") {
      return queryVectorSource(source as VectorSource, options.sourceLayer, filter, this.stateOf);
    }
    const found = await (source as GeoJSONSource).sourceFeatures(options.filter ?? null);
    return found.map((f) => ({
      type: "Feature",
      id: f.id,
      properties: { ...f.properties },
      geometry: f.geometry,
      source: sourceId,
      sourceLayer: undefined,
      state: this.stateOf(sourceId, undefined, f.id),
    }));
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
    flat.keepInWorld = false;
    flat.setMaxBounds(null);
    flat.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });
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
        throw new MapkernError("invalid-option", "query points must be [x, y] or { x, y } in pixels");
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
    this.styleChanged();
    return this;
  }

  removeLayer(id: string): this {
    this.requireStyle().removeLayer(id);
    this.styleChanged();
    return this;
  }

  moveLayer(id: string, beforeId?: string): this {
    this.requireStyle().moveLayer(id, beforeId);
    this.styleChanged();
    return this;
  }

  getLayer(id: string): LayerSpec | undefined {
    return this.style?.getLayer(id)?.serialize();
  }

  getLayerIds(): string[] {
    return this.style?.layers.map((l) => l.id) ?? [];
  }

  setPaintProperty(layerId: string, name: string, value: unknown): this {
    this.layer(layerId).setPaint(name, value, this.style?.meta.transition);
    this.styleChanged();
    this.triggerRepaint();
    return this;
  }

  setLayoutProperty(layerId: string, name: string, value: unknown): this {
    this.layer(layerId).setLayout(name, value);
    this.styleChanged();
    this.triggerRepaint();
    return this;
  }

  getFilter(layerId: string): unknown {
    const filter = (this.layer(layerId).spec as { filter?: unknown }).filter;
    return filter === undefined ? undefined : deepClone(filter);
  }

  getPaintProperty(layerId: string, name: string): unknown {
    const value = (this.layer(layerId).spec as { paint?: Record<string, unknown> }).paint?.[name];
    return value === undefined ? undefined : deepClone(value);
  }

  getLayoutProperty(layerId: string, name: string): unknown {
    const value = (this.layer(layerId).spec as { layout?: Record<string, unknown> }).layout?.[name];
    return value === undefined ? undefined : deepClone(value);
  }

  isSourceLoaded(id: string): boolean {
    const source = this.style?.sources.get(id);
    if (!source) throw new MapkernError("invalid-option", `There is no source with id "${id}"`);
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
    this.styleChanged();
    this.triggerRepaint();
    return this;
  }

  setLayerVisibility(layerId: string, visible: boolean): this {
    this.layer(layerId).setVisible(visible);
    this.styleChanged();
    this.triggerRepaint();
    return this;
  }

  setLayerZoomRange(layerId: string, minZoom: number, maxZoom: number): this {
    this.layer(layerId).setZoomRange(minZoom, maxZoom);
    this.styleChanged();
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
    if (!corner) throw new MapkernError("invalid-option", `Unknown control position "${String(pos)}"`);
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
    if (this.sunClock) clearInterval(this.sunClock);
    this.sunClock = 0;
    this.styleRequest?.abort();
    this.spriteRequest?.abort();
    this.hash?.destroy();
    this.debug?.destroy();
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
    this.layerEvents.clear();
  }

  private teardownDom(): void {
    this.canvasContainer.remove();
    for (const corner of this.controlCorners.values()) corner.remove();
    this.container.classList.remove("mapkern-map");
  }

  private layer(id: string): StyleLayer {
    const layer = this.requireStyle().getLayer(id);
    if (!layer) throw new MapkernError("invalid-option", `There is no layer with id "${id}"`);
    return layer;
  }

  private requireStyle(): Style {
    if (!this.style)
      throw new MapkernError("invalid-style", "The map has no style yet; call setStyle first or wait for styleload");
    return this.style;
  }

  private applyStyle(input: StyleSpec | StyleSpecV8, diff = false, base?: string): void {
    let spec = input as StyleSpec;
    let skipped: string[] = [];
    if (isStyleV8(input)) {
      try {
        const imported = importStyle(input, base);
        spec = imported.style;
        skipped = imported.skipped;
      } catch (error) {
        this.fail(
          error instanceof MapkernError ? error : new MapkernError("invalid-style", errorMessage(error), {}, error),
        );
        return;
      }
    }
    const current = this.style;
    if (diff && current) {
      try {
        assertValid(spec);
      } catch (error) {
        this.fail(
          error instanceof MapkernError ? error : new MapkernError("invalid-style", errorMessage(error), {}, error),
        );
        return;
      }
      let update: StyleUpdate | null = null;
      try {
        update = current.apply(spec);
      } catch {
        update = null;
      }
      if (update) {
        for (const id of update.dropped) this.featureStates.dropSource(id);
        if (update.sprite) this.loadSprites(spec.sprite);
        this.updateGlyphs(spec.glyphs);
        queueMicrotask(() => {
          if (this.style !== current || this.removed) return;
          this.emit("styleload", { ...this.event("styleload"), skipped });
          this.styleChanged();
        });
        this.triggerRepaint();
        return;
      }
    }
    let style: Style;
    try {
      style = new Style(spec, (id, source) => this.createSource(id, source), {
        sourceLoaded: (source) => {
          this.emit("sourcedata", { ...this.event("sourcedata"), sourceId: source.id, kind: "metadata" });
          this.emit("data", { ...this.event("data"), dataType: "source", sourceId: source.id });
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
        error instanceof MapkernError ? error : new MapkernError("invalid-style", errorMessage(error), {}, error),
      );
      return;
    }
    const first = this.style === null;
    this.style?.destroy();
    this.style = style;
    this.featureStates = new FeatureStates();
    this.loadSprites(spec.sprite);
    this.updateGlyphs(spec.glyphs);
    if (first && !this.hashPlaced) {
      const o = this.options;
      const t = this.transform;
      if (o.center === undefined && spec.center) t.setCenter(spec.center[0], spec.center[1]);
      if (o.zoom === undefined && spec.zoom !== undefined) t.setZoom(spec.zoom);
      if (o.bearing === undefined && spec.bearing !== undefined) t.setBearing(spec.bearing);
      if (o.pitch === undefined && spec.pitch !== undefined) t.setPitch(spec.pitch);
      this.cameraVersion++;
    }
    queueMicrotask(() => {
      if (this.style !== style || this.removed) return;
      this.emit("styleload", { ...this.event("styleload"), skipped });
      this.styleChanged();
    });
    this.triggerRepaint();
  }

  private updateGlyphs(template: string | undefined): void {
    this.painter.labels.setGlyphs(
      template ?? null,
      (url, signal) => this.loadGlyphs(url, signal),
      () => this.triggerRepaint(),
    );
  }

  private async loadGlyphs(url: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const params = resolveRequest(url, "glyphs", this.options.transformRequest);
    const result = await fetchBytes(params, signal, this.requestTimeout(), "glyphs", this.diskCache);
    if (result.kind === "empty") return null;
    const bytes = new Uint8Array(result.data);
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  private loadSprites(sprite: unknown): void {
    this.spriteRequest?.abort();
    this.spriteRequest = null;
    this.spritesLoading = 0;
    this.painter.images.clearSprites();
    const sheets = spriteSheets(sprite);
    if (sheets.length === 0) return;
    const controller = new AbortController();
    this.spriteRequest = controller;
    const ratio = this.pixelRatioValue > 1 ? 2 : 1;
    for (const sheet of sheets) {
      this.spritesLoading++;
      this.loadSprite(sheet.id, sheet.url, ratio, controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted && !this.removed)
            this.fail(resourceError(error, `Could not load the sprite ${sheet.url}`));
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          this.spritesLoading--;
          this.triggerRepaint();
        });
    }
  }

  private async loadSprite(prefix: string, url: string, ratio: number, signal: AbortSignal): Promise<void> {
    const get = async (suffix: string, extension: string) => {
      const params = resolveRequest(spriteUrl(url, suffix, extension), "image", this.options.transformRequest);
      return fetchBytes(params, signal, this.requestTimeout(), "image", this.diskCache);
    };
    let suffix = ratio > 1 ? "@2x" : "";
    let [index, sheet] = await Promise.all([get(suffix, ".json"), get(suffix, ".png")]);
    if (suffix && (index.kind === "empty" || sheet.kind === "empty")) {
      suffix = "";
      [index, sheet] = await Promise.all([get("", ".json"), get("", ".png")]);
    }
    if (index.kind === "empty" || sheet.kind === "empty") {
      throw new MapkernError("http", `The sprite ${url} is missing its .json or .png file`, { url });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(index.data));
    } catch (error) {
      throw new MapkernError(
        "decode",
        `The sprite index ${spriteUrl(url, suffix, ".json")} is not valid JSON`,
        {},
        error,
      );
    }
    const bitmap = await createImageBitmap(new Blob([sheet.data], { type: "image/png" }));
    const pixels = pixelsOf(bitmap, url);
    bitmap.close();
    if (signal.aborted) return;
    for (const image of spriteImages(prefix, parsed, pixels)) this.painter.images.add(image);
  }

  private reportMissingImages(): void {
    const missing = this.painter.labels.takeMissing();
    if (this.spritesLoading > 0) return;
    const images = this.painter.images;
    if (images.version !== this.reportedVersion) {
      this.reportedVersion = images.version;
      this.reportedImages.clear();
    }
    for (const id of missing) {
      if (this.reportedImages.has(id) || images.has(id)) continue;
      this.reportedImages.add(id);
      this.emit("styleimagemissing", { target: this, type: "styleimagemissing", id });
    }
  }

  private styleQueued = false;

  private styleChanged(): void {
    if (this.styleQueued) return;
    this.styleQueued = true;
    queueMicrotask(() => {
      this.styleQueued = false;
      if (this.removed) return;
      this.emit("styledata", this.event("styledata"));
      this.emit("data", { ...this.event("data"), dataType: "style" });
    });
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
      case "image":
      case "video":
      case "canvas":
        return new ImageSource(id, spec, ctx);
      default: {
        const type = (spec as { type: unknown }).type;
        throw new MapkernError("invalid-style", `Source type "${String(type)}" is not supported`, { sourceId: id });
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
      diskCache: this.diskCache,
      cacheBytes: Math.max(16, checkNumber(this.options.tileCacheSize, "tileCacheSize", 192)) * 1024 * 1024,
      fadeDuration: checkNumber(this.options.fadeDuration, "fadeDuration", 200),
      prefetchLimit: this.options.prefetch === false ? 0 : 48,
      pixelRatio: () => this.pixelRatioValue,
      error: (error) => this.fail(error, typeof error.detail.sourceId === "string" ? error.detail.sourceId : undefined),
      content: (sourceId) => {
        this.emit("sourcedata", { ...this.event("sourcedata"), sourceId, kind: "content" });
        this.emit("data", { ...this.event("data"), dataType: "source", sourceId });
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

  private fail(error: MapkernError, sourceId?: string): void {
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
    if (options.padding !== undefined) t.setPadding(normalizePadding(options.padding));
    if (options.zoom !== undefined) t.setZoom(checkNumber(options.zoom, "zoom", t.zoom));
    if (options.bearing !== undefined) t.setBearing(checkNumber(options.bearing, "bearing", t.bearing));
    if (options.pitch !== undefined) t.setPitch(checkNumber(options.pitch, "pitch", t.pitch));
    if (options.center !== undefined) {
      const [lng, lat] = toLngLat(options.center);
      t.setCenter(lng, lat);
    }
    const state = readState(t);
    if (options.center !== undefined) {
      const [lng] = toLngLat(options.center);
      state.x += Math.round(mercatorX(lng) - state.x);
    }
    return state;
  }

  private applyCamera(options: CameraOptions): void {
    const t = this.transform;
    if (options.padding !== undefined) t.setPadding(normalizePadding(options.padding));
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
    const around = this.transform.clone();
    around.resize(this.transform.width * PREFETCH_MARGIN, this.transform.height * PREFETCH_MARGIN);
    out.push(around);
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
      this.updateTerrain(style, progress);
      const predicted = this.predicted();
      for (const source of style.sources.values()) {
        if (source.setLayers) source.setLayers(style.layers.filter((l) => l.source === source.id));
        source.update(this.transform, now, predicted);
      }
      if (moreUploads) animating = true;
      for (const layer of style.layers) if (layer.settle(now)) animating = true;
      const labelsBusy = this.painter.render({
        transform: this.transform,
        view: this.transform,
        terrain: this.terrain,
        pixelRatio: this.pixelRatioValue,
        layers: style.layers,
        sources: style.sources,
        sky: style.meta.sky ?? null,
        sun: this.sunLook(style.meta.sun),
        now,
        cameraVersion: this.cameraVersion,
        states: this.stateScope,
        moving: this.isMoving(),
      });
      if (labelsBusy) animating = true;
      this.reportMissingImages();
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
    this.drawDebug();
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
    } else if (
      !this.idleFired &&
      this.frameHandle === 0 &&
      this.loadedFired &&
      this.sourcesIdle() &&
      !this.painter.labels.glyphsLoading
    ) {
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
    const padded = !samePadding(state.padding, last.padding);
    const moved = changed && (zoomed || rotated || pitched || padded || state.x !== last.x || state.y !== last.y);
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
        this.gestureEvent = this.lastInput;
        this.cameraChanged();
      },
      input: (event: Event) => {
        this.lastInput = event;
      },
      wheel: (event: WheelEvent) => this.wheelEvent(event),
      drag: (stage: "start" | "move" | "end", event: Event) => {
        const type = stage === "start" ? "dragstart" : stage === "end" ? "dragend" : "drag";
        if (this.listens(type)) this.emit(type, { target: this, type, originalEvent: event });
      },
      touch: (type: TouchType, event: TouchEvent) => this.touchEvent(type, event),
      notice: (kind: "wheel" | "touch") => this.showNotice(kind),
      gesture: (active: boolean) => {
        this.gestureDepth = Math.max(0, this.gestureDepth + (active ? 1 : -1));
        this.triggerRepaint();
      },
      rotateEnded: () => {
        this.snapToNorth();
      },
      boxZoom: (stage: "start" | "end" | "cancel", from: [number, number], to: [number, number], event: Event) => {
        const type = stage === "start" ? "boxzoomstart" : stage === "end" ? "boxzoomend" : "boxzoomcancel";
        if (stage === "end") {
          this.hostCall = true;
          this.gestureEvent = event;
          try {
            this.fitScreenCoordinates(from, to, this.transform.bearing, { linear: true });
          } finally {
            this.hostCall = false;
          }
        }
        this.emit(type, { target: this, type, originalEvent: event });
      },
      ease: (
        target: { zoom?: number; bearing?: number; pitch?: number; panBy?: [number, number] },
        around: [number, number] | null,
        duration: number,
      ) => {
        this.hostCall = true;
        this.gestureEvent = this.lastInput;
        try {
          this.hostEase(target, around, duration);
        } finally {
          this.hostCall = false;
        }
      },
      pointerEvent: (type: PointerType, event: MouseEvent, point: [number, number]): Promise<boolean> | null => {
        this.lastInput = event;
        return this.pointerEvent(type, event, point);
      },
    };
  }

  private wheelEvent(event: WheelEvent): boolean {
    if (!this.listens("wheel")) return false;
    const rect = this.canvasContainer.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let prevented = false;
    this.emit("wheel", {
      target: this,
      type: "wheel",
      point: { x, y },
      lngLat: this.unproject([x, y]),
      originalEvent: event,
      preventDefault: () => {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      },
    });
    return prevented;
  }

  private touchEvent(type: TouchType, event: TouchEvent): void {
    if (!this.listens(type)) return;
    const rect = this.canvasContainer.getBoundingClientRect();
    const list = type === "touchend" || type === "touchcancel" ? event.changedTouches : event.touches;
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      points.push({ x: t.clientX - rect.left, y: t.clientY - rect.top });
    }
    const point = points.length
      ? {
          x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        }
      : { x: 0, y: 0 };
    this.emit(type, {
      target: this,
      type,
      point,
      lngLat: points.length ? this.unproject([point.x, point.y]) : null,
      points,
      lngLats: points.map((p) => this.unproject([p.x, p.y])),
      originalEvent: event,
    });
  }

  private noticeElement: HTMLElement | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private showNotice(kind: "wheel" | "touch"): void {
    const doc = this.container.ownerDocument;
    if (!this.noticeElement) {
      const el = doc.createElement("div");
      el.className = "mapkern-cooperative";
      el.setAttribute("aria-live", "polite");
      this.container.appendChild(el);
      this.noticeElement = el;
      this.cleanup.push(() => el.remove());
    }
    const el = this.noticeElement;
    const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
    el.textContent = this.text(
      kind === "touch" ? "touchPanBlocker" : mac ? "scrollZoomBlockerMac" : "scrollZoomBlocker",
    );
    el.classList.add("mapkern-visible");
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      el.classList.remove("mapkern-visible");
    }, 1500);
  }

  private hostEase(
    target: { zoom?: number; bearing?: number; pitch?: number; panBy?: [number, number] },
    around: [number, number] | null,
    duration: number,
  ): void {
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
  }

  private pointerEvent(type: PointerType, event: MouseEvent, point: [number, number]): Promise<boolean> | null {
    const mapListeners = this.listens(type);
    const layerListeners = this.layerEvents.wants(type);
    if (!mapListeners && !layerListeners) return null;
    const hit = this.pickWorld(point[0], point[1]);
    const lngLat: LngLat | null = hit ? [wrapLongitude(lngFromMercatorX(hit[0])), latFromMercatorY(hit[1])] : null;
    if (mapListeners) {
      let prevented = false;
      const e: MapPointerEvent = {
        target: this,
        type,
        point: { x: point[0], y: point[1] },
        lngLat,
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
    }
    if (!layerListeners) return null;
    const input: PointerInput = { type, event, point, lngLat };
    return this.layerEvents.dispatch(input);
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

function resourceError(error: unknown, message: string): MapkernError {
  if (error instanceof MapkernError) return error;
  const failure = (error as { failure?: { kind?: string; message?: string } })?.failure;
  if (failure) {
    const code = failure.kind === "auth" ? "auth" : failure.kind === "network" ? "network" : "http";
    return new MapkernError(code, `${message}: ${failure.message ?? "request failed"}`, { failure }, error);
  }
  return new MapkernError("network", `${message}: ${errorMessage(error)}`, {}, error);
}

function layerEventType(type: string): LayerEventType {
  if (!LAYER_EVENT_TYPES.has(type)) {
    throw new MapkernError("invalid-option", `"${type}" events can't be bound to layers`, { event: type });
  }
  return type as LayerEventType;
}

function layerList(layers: unknown): string[] {
  const list = typeof layers === "string" ? [layers] : Array.isArray(layers) ? [...layers] : null;
  if (!list || list.length === 0 || list.some((id) => typeof id !== "string" || id === "")) {
    throw new MapkernError("invalid-option", "Layer events need a layer id or a list of layer ids");
  }
  return list as string[];
}

function checkListener<E>(listener: unknown): Listener<E> {
  if (typeof listener !== "function") throw new MapkernError("invalid-option", "The listener must be a function");
  return listener as Listener<E>;
}

function checkNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MapkernError("invalid-option", `${name} must be a finite number`, { option: name });
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

function normalizePadding(padding: PaddingOptions | undefined): Padding {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  const side = (value: unknown, name: string): number => {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new MapkernError("invalid-option", `padding ${name} must be a number of pixels, 0 or more`);
    }
    return value;
  };
  if (typeof padding === "number") {
    const all = side(padding, "");
    return { top: all, right: all, bottom: all, left: all };
  }
  if (typeof padding !== "object" || padding === null) {
    throw new MapkernError("invalid-option", "padding must be a number or { top, right, bottom, left }");
  }
  return {
    top: side(padding.top, "top"),
    right: side(padding.right, "right"),
    bottom: side(padding.bottom, "bottom"),
    left: side(padding.left, "left"),
  };
}

function worldBounds(bounds: BoundsLike): WorldBounds {
  if (!Array.isArray(bounds) || (bounds.length !== 2 && bounds.length !== 4)) {
    throw new MapkernError(
      "invalid-option",
      "bounds must be [[west, south], [east, north]] or [west, south, east, north]",
    );
  }
  const [[w, s], [e, n]] = normalizeBounds(bounds);
  if (![w, s, e, n].every(Number.isFinite)) {
    throw new MapkernError(
      "invalid-option",
      "bounds must be [[west, south], [east, north]] or [west, south, east, north]",
    );
  }
  const x0 = mercatorX(w);
  let x1 = mercatorX(e);
  if (x1 < x0) x1 += 1;
  return { x0, y0: mercatorY(Math.min(85.051129, n)), x1, y1: mercatorY(Math.max(-85.051129, s)) };
}

function screenPoint(p: PointLike): [number, number] {
  const x = Array.isArray(p) ? p[0] : p?.x;
  const y = Array.isArray(p) ? p[1] : p?.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new MapkernError("invalid-option", "points must be [x, y] or { x, y } in pixels");
  }
  return [x, y];
}

declare const MAPKERN_WORKER_SOURCE: string | undefined;

function workerFactory(url: string | undefined): WorkerFactory | null {
  if (typeof Worker === "undefined") return null;
  if (url) return () => new Worker(url);
  const source = typeof MAPKERN_WORKER_SOURCE === "string" ? MAPKERN_WORKER_SOURCE : undefined;
  if (!source) return null;
  let blobUrl: string | null = null;
  return () => {
    blobUrl ??= URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return new Worker(blobUrl);
  };
}

export const DEFAULT_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const NIGHT = "#29335c";

function worldView(container: HTMLElement): { zoom: number; center: [number, number] } {
  const top = mercatorY(75);
  const bottom = mercatorY(-55);
  const width = container.clientWidth;
  const height = container.clientHeight;
  const zoom = width > 0 && height > 0 ? Math.log2(Math.min(width / 512, height / (512 * (bottom - top)))) : 0;
  return { zoom, center: [0, latFromMercatorY((top + bottom) / 2)] };
}

function absoluteUrl(url: string): string | undefined {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return undefined;
  }
}

const DISK_CACHE_MB = 100;

function openDiskCache(option: MapOptions["diskCache"]): ResponseStore | null {
  if (option === false) return null;
  const size = typeof option === "object" && option !== null ? option.size : undefined;
  const mb = checkNumber(size, "diskCache.size", DISK_CACHE_MB);
  return mb > 0 ? sharedDiskCache(mb * 1024 * 1024) : null;
}
