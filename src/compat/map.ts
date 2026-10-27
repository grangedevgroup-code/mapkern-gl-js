import type { MapInternals } from "../core/internal.ts";
import { internalsOf } from "../core/internal.ts";
import type {
  CameraOptions,
  FitBoundsOptions,
  FlyToOptions,
  HandlerSwitch,
  MapOptions as NativeMapOptions,
  PaddingOptions,
  SetStyleOptions,
  TouchZoomRotateSwitch,
  UiText,
} from "../core/map.ts";
import { MapkernMap } from "../core/map.ts";
import type { QueriedFeature } from "../core/query.ts";
import type { GeoJSONSource } from "../sources/geojson.ts";
import type { ImageSource } from "../sources/image.ts";
import type { MapSource } from "../sources/source.ts";
import { compile } from "../style/expression.ts";
import { convertFilter, importLayer, importSky, importSource, serverGlyphs } from "../style/import.ts";
import type { LayerSpec, SourceSpec, StyleSpec, StyleSpecV8 } from "../style/types.ts";
import type { RequestParameters as NativeRequest } from "../tiles/fetch.ts";
import type { Control, ControlPosition } from "../ui/controls.ts";
import type { LngLatBoundsLike, LngLatLike, PointLike } from "./geo.ts";
import {
  boundsTuple,
  LngLat,
  LngLatBounds,
  latFromMercatorY,
  lngFromMercatorX,
  lngLatTuple,
  mercatorXFromLng,
  mercatorYFromLat,
  Point,
} from "./geo.ts";
import type { RequestParameters, ResourceType } from "./protocol.ts";
import { resourceType } from "./protocol.ts";
import type { CustomLayerInterface, Json, ShadowLayer } from "./style.ts";
import { cloneSource, isCustomLayer, isJson, layerView, ShadowStyle } from "./style.ts";
import type { IControl } from "./ui.ts";
import { aliasClasses, hostControl, injectCompatStyles, isNativeControl } from "./ui.ts";

export const MAPLIBRE_FOV = 36.86989764584402;

type Listener = (event: never) => void;

export interface CompatMapOptions {
  container: HTMLElement | string;
  style?: unknown;
  center?: LngLatLike;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  minZoom?: number | null;
  maxZoom?: number | null;
  minPitch?: number | null;
  maxPitch?: number | null;
  maxBounds?: LngLatBoundsLike | null;
  bounds?: LngLatBoundsLike;
  fitBoundsOptions?: Json;
  hash?: boolean | string;
  interactive?: boolean;
  attributionControl?: false | { compact?: boolean; customAttribution?: string | string[] };
  customAttribution?: string | string[];
  maplibreLogo?: boolean;
  logoControl?: boolean;
  transformRequest?: (url: string, resourceType?: ResourceType) => RequestParameters | undefined | null;
  locale?: Record<string, string>;
  dragPan?: boolean | Json;
  dragRotate?: boolean;
  scrollZoom?: boolean | Json;
  boxZoom?: boolean;
  doubleClickZoom?: boolean;
  keyboard?: boolean;
  touchZoomRotate?: boolean | Json;
  touchPitch?: boolean | Json;
  cooperativeGestures?: boolean | Json;
  bearingSnap?: number;
  clickTolerance?: number;
  pixelRatio?: number;
  antialias?: boolean;
  preserveDrawingBuffer?: boolean;
  canvasContextAttributes?: { antialias?: boolean; preserveDrawingBuffer?: boolean };
  fadeDuration?: number;
  renderWorldCopies?: boolean;
  respectPrefersReducedMotion?: boolean;
  fov?: number;
  projection?: unknown;
  [option: string]: unknown;
}

interface Registration {
  type: string;
  layers: string[] | undefined;
  listener: Listener;
  once: boolean;
  nativeType: string | null;
  wrapper: ((event: unknown) => void) | null;
}

export interface Subscription {
  unsubscribe(): void;
}

const NATIVE_EVENTS = new Set([
  "load",
  "idle",
  "render",
  "resize",
  "remove",
  "movestart",
  "move",
  "moveend",
  "zoomstart",
  "zoom",
  "zoomend",
  "rotatestart",
  "rotate",
  "rotateend",
  "pitchstart",
  "pitch",
  "pitchend",
  "boxzoomstart",
  "boxzoomend",
  "boxzoomcancel",
  "error",
  "sourcedata",
  "styleimagemissing",
  "click",
  "dblclick",
  "contextmenu",
  "mousemove",
  "mousedown",
  "mouseup",
  "mouseout",
  "wheel",
  "dragstart",
  "drag",
  "dragend",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "styledata",
  "data",
]);

const RENAMED: Record<string, string> = {
  "style.load": "styleload",
  webglcontextlost: "contextlost",
  webglcontextrestored: "contextrestored",
};

const LAYER_EVENTS = new Set([
  "click",
  "dblclick",
  "contextmenu",
  "mousemove",
  "mousedown",
  "mouseup",
  "mouseenter",
  "mouseleave",
  "mouseover",
  "mouseout",
]);

const TOUCH_LAYER_EVENTS = new Set(["touchstart", "touchend", "touchcancel"]);

const LOCALE: Record<string, UiText> = {
  "NavigationControl.ZoomIn": "zoomIn",
  "NavigationControl.ZoomOut": "zoomOut",
  "NavigationControl.ResetBearing": "resetNorth",
  "FullscreenControl.Enter": "fullscreen",
  "FullscreenControl.Exit": "exitFullscreen",
  "GeolocateControl.FindMyLocation": "geolocate",
  "GeolocateControl.LocationNotAvailable": "locationUnavailable",
  "Map.Title": "map",
  "Marker.Title": "marker",
  "Popup.Close": "closePopup",
  "ScrollZoomBlocker.CtrlMessage": "scrollZoomBlocker",
  "ScrollZoomBlocker.CmdMessage": "scrollZoomBlockerMac",
  "TouchPanBlocker.Message": "touchPanBlocker",
};

const EMPTY_STYLE = { version: 8, sources: {}, layers: [] };

export const defaults = { workerCount: 0, maxParallelImageRequests: 0 };

let globeWarned = false;

function warnGlobe(): void {
  if (globeWarned) return;
  globeWarned = true;
  console.warn("Mapkern draws Web Mercator only, so the globe projection is shown as a flat map");
}

function enabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return value !== false;
}

function headersRecord(headers: unknown): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return Object.fromEntries(headers.entries());
  return headers as Record<string, string>;
}

function nativeTransform(
  transform: CompatMapOptions["transformRequest"],
): NativeMapOptions["transformRequest"] | undefined {
  if (typeof transform !== "function") return undefined;
  return (url, kind) => {
    const result = transform(url, resourceType(kind, url));
    if (!result) return undefined;
    const out: NativeRequest = { url: result.url ?? url };
    const headers = headersRecord(result.headers);
    if (headers) out.headers = headers;
    if (result.credentials) out.credentials = result.credentials;
    return out;
  };
}

function layerList(layers: unknown): string[] {
  return (Array.isArray(layers) ? layers : [layers]).map(String);
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function pointTuple(point: PointLike): [number, number] {
  const p = Point.convert(point);
  return [p.x, p.y];
}

function isPointLike(value: unknown): boolean {
  if (value instanceof Point) return true;
  if (Array.isArray(value)) return value.length === 2 && value.every((v) => typeof v === "number");
  return isJson(value) && typeof value.x === "number" && typeof value.y === "number";
}

function queryGeometry(value: unknown): [number, number] | [[number, number], [number, number]] | undefined {
  if (value === undefined || value === null) return undefined;
  if (isPointLike(value)) return pointTuple(value as PointLike);
  if (Array.isArray(value) && value.length === 2 && value.every(isPointLike)) {
    return [pointTuple(value[0] as PointLike), pointTuple(value[1] as PointLike)];
  }
  throw new Error("queryRenderedFeatures needs a point or a pair of points");
}

function geometryType(geometry: { type?: string } | null): "Point" | "LineString" | "Polygon" | "Unknown" {
  const type = geometry?.type ?? "";
  if (type.endsWith("Point")) return "Point";
  if (type.endsWith("LineString")) return "LineString";
  if (type.endsWith("Polygon")) return "Polygon";
  return "Unknown";
}

function cameraOptions(options: Json, map: MapkernMap): CameraOptions & FlyToOptions {
  const out: Json = {};
  for (const key of [
    "zoom",
    "bearing",
    "pitch",
    "duration",
    "easing",
    "animate",
    "curve",
    "speed",
    "screenSpeed",
    "maxDuration",
    "padding",
  ]) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  if (options.center !== undefined) out.center = lngLatTuple(options.center as LngLatLike);
  if (options.around !== undefined) out.around = lngLatTuple(options.around as LngLatLike);
  if (options.offset !== undefined) {
    const offset = Point.convert(options.offset as PointLike);
    if (offset.x !== 0 || offset.y !== 0) {
      const center = (out.center as [number, number] | undefined) ?? map.getCenter();
      const zoom = (out.zoom as number | undefined) ?? map.getZoom();
      const bearing = (((out.bearing as number | undefined) ?? map.getBearing()) * Math.PI) / 180;
      const size = 512 * 2 ** zoom;
      const shift = offset.rotate(-bearing);
      const x = mercatorXFromLng(center[0]) - shift.x / size;
      const y = mercatorYFromLat(center[1]) - shift.y / size;
      out.center = [lngFromMercatorX(x), latFromMercatorY(Math.max(0, Math.min(1, y)))];
    }
  }
  return out as CameraOptions & FlyToOptions;
}

function fitOptions(options: Json | undefined): FitBoundsOptions {
  const out: Json = {};
  if (!options) return out as FitBoundsOptions;
  for (const key of ["padding", "maxZoom", "bearing", "pitch", "linear", "duration", "easing", "animate"]) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out as FitBoundsOptions;
}

class CompatSource {
  readonly id: string;
  private readonly map: CompatMap;

  constructor(map: CompatMap, id: string) {
    this.map = map;
    this.id = id;
  }

  private get spec(): Json {
    return this.map.shadowSource(this.id) ?? {};
  }

  private get nativeSource(): MapSource | undefined {
    return this.map.nativeSource(this.id);
  }

  get type(): string {
    return String(this.spec.type);
  }

  get tiles(): unknown {
    return this.spec.tiles;
  }

  get url(): unknown {
    return this.spec.url;
  }

  get minzoom(): number {
    return (this.spec.minzoom as number | undefined) ?? 0;
  }

  get maxzoom(): number {
    return (this.spec.maxzoom as number | undefined) ?? (this.type === "geojson" ? 18 : 22);
  }

  get tileSize(): number {
    return (this.spec.tileSize as number | undefined) ?? 512;
  }

  get attribution(): unknown {
    return this.spec.attribution;
  }

  get bounds(): unknown {
    return this.spec.bounds;
  }

  get promoteId(): unknown {
    return this.spec.promoteId;
  }

  get _data(): unknown {
    return this.spec.data;
  }

  get _options(): Json {
    return this.spec;
  }

  loaded(): boolean {
    return this.map.isSourceLoaded(this.id);
  }

  serialize(): Json {
    return cloneSource(this.spec);
  }

  setData(data: unknown, waitForCompletion?: boolean): this | Promise<void> {
    const spec = this.map.shadowSource(this.id);
    if (spec) spec.data = data;
    (this.nativeSource as GeoJSONSource | undefined)?.setData(data as never);
    return waitForCompletion ? this.map.whenSourceSettles(this.id) : this;
  }

  async getData(): Promise<unknown> {
    const data = this.spec.data;
    if (typeof data !== "string") return data;
    const response = await fetch(data);
    if (!response.ok) throw new Error(`Could not read ${data} (HTTP ${response.status})`);
    return response.json();
  }

  updateData(diff: Json, waitForCompletion?: boolean): this | Promise<void> {
    const data = this.spec.data;
    if (!isJson(data)) throw new Error("updateData needs the source's data to be a GeoJSON object");
    const promote = typeof this.spec.promoteId === "string" ? this.spec.promoteId : null;
    const idOf = (feature: Json): unknown =>
      promote ? (isJson(feature.properties) ? feature.properties[promote] : undefined) : feature.id;
    const original =
      data.type === "FeatureCollection" && Array.isArray(data.features)
        ? (data.features as Json[])
        : data.type === "Feature"
          ? [data]
          : [];
    let features = diff.removeAll ? [] : [...original];
    if (Array.isArray(diff.remove) && diff.remove.length > 0) {
      const gone = new Set(diff.remove);
      features = features.filter((f) => !gone.has(idOf(f)));
    }
    if (Array.isArray(diff.add)) {
      for (const feature of diff.add as Json[]) {
        const id = idOf(feature);
        const at = id === undefined ? -1 : features.findIndex((f) => idOf(f) === id);
        if (at >= 0) features[at] = feature;
        else features.push(feature);
      }
    }
    if (Array.isArray(diff.update)) {
      for (const change of diff.update as Json[]) {
        const at = features.findIndex((f) => idOf(f) === change.id);
        if (at < 0) continue;
        const current = features[at]!;
        const properties: Json = change.removeAllProperties
          ? {}
          : { ...((current.properties as Json | null | undefined) ?? {}) };
        if (Array.isArray(change.removeProperties)) for (const key of change.removeProperties) delete properties[key];
        if (Array.isArray(change.addOrUpdateProperties)) {
          for (const entry of change.addOrUpdateProperties as Json[]) properties[String(entry.key)] = entry.value;
        }
        features[at] = {
          ...current,
          properties,
          ...(change.newGeometry !== undefined ? { geometry: change.newGeometry } : {}),
        };
      }
    }
    return this.setData({ type: "FeatureCollection", features }, waitForCompletion);
  }

  getClusterExpansionZoom(clusterId: number, callback?: (error: unknown, zoom?: number) => void): Promise<number> {
    return this.answer((this.nativeSource as GeoJSONSource).getClusterExpansionZoom(clusterId), callback);
  }

  getClusterChildren(clusterId: number, callback?: (error: unknown, features?: unknown[]) => void): Promise<unknown[]> {
    return this.answer((this.nativeSource as GeoJSONSource).getClusterChildren(clusterId), callback);
  }

  getClusterLeaves(
    clusterId: number,
    limit = 10,
    offset = 0,
    callback?: (error: unknown, features?: unknown[]) => void,
  ): Promise<unknown[]> {
    return this.answer((this.nativeSource as GeoJSONSource).getClusterLeaves(clusterId, limit, offset), callback);
  }

  setTiles(tiles: string[]): this {
    const spec = this.map.shadowSource(this.id);
    if (spec) {
      spec.tiles = [...tiles];
      delete spec.url;
    }
    (this.nativeSource as { setTiles?(tiles: string[]): unknown } | undefined)?.setTiles?.(tiles);
    return this;
  }

  setUrl(url: string): this {
    const spec = this.map.shadowSource(this.id);
    if (spec) {
      spec.url = url;
      delete spec.tiles;
    }
    (this.nativeSource as { setUrl?(url: string): unknown } | undefined)?.setUrl?.(url);
    return this;
  }

  updateImage(options: { url?: string; coordinates?: LngLatLike[] }): this {
    const spec = this.map.shadowSource(this.id);
    if (spec && options.url) spec.url = options.url;
    if (spec && options.coordinates) spec.coordinates = options.coordinates.map(lngLatTuple);
    (this.nativeSource as ImageSource | undefined)?.updateImage({
      ...(options.url ? { url: options.url } : {}),
      ...(options.coordinates ? { coordinates: options.coordinates.map(lngLatTuple) } : {}),
    });
    return this;
  }

  setCoordinates(coordinates: LngLatLike[]): this {
    return this.updateImage({ coordinates });
  }

  getVideo(): HTMLVideoElement | null {
    return (this.nativeSource as ImageSource | undefined)?.getVideo() ?? null;
  }

  getCanvas(): HTMLCanvasElement | null {
    return (this.nativeSource as ImageSource | undefined)?.getCanvas() ?? null;
  }

  play(): void {
    (this.nativeSource as ImageSource | undefined)?.play();
  }

  pause(): void {
    (this.nativeSource as ImageSource | undefined)?.pause();
  }

  private answer<T>(promise: Promise<T>, callback?: (error: unknown, value?: T) => void): Promise<T> {
    if (typeof callback === "function") {
      promise.then(
        (value) => callback(null, value),
        (error: unknown) => callback(error),
      );
    }
    return promise;
  }
}

function handlerSwitch(native: HandlerSwitch, map: MapkernMap, extra: Json = {}): Json {
  return {
    enable: () => native.enable(),
    disable: () => native.disable(),
    isEnabled: () => native.isEnabled(),
    isActive: () => native.isEnabled() && map.isMoving(),
    ...extra,
  };
}

interface AnimatedImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  render?(): boolean;
  onAdd?(map: unknown, id: string): void;
  onRemove?(): void;
}

export class CompatMap {
  readonly native: MapkernMap;
  readonly dragPan: Json;
  readonly dragRotate: Json;
  readonly scrollZoom: Json;
  readonly boxZoom: Json;
  readonly doubleClickZoom: Json;
  readonly keyboard: Json;
  readonly touchZoomRotate: Json;
  readonly touchPitch: Json;
  readonly cooperativeGestures: Json;
  private readonly internals: MapInternals;
  private shadow: ShadowStyle | null = null;
  private styleToken: Json | null = null;
  private readonly registrations: Registration[] = [];
  private readonly sources = new Map<string, CompatSource>();
  private readonly hosted = new Map<IControl, Control>();
  private readonly animated = new Map<string, AnimatedImage>();
  private animationFrame = 0;
  private readonly unalias: () => void;
  private readonly noted = new Set<string>();

  constructor(options: CompatMapOptions) {
    if (!isJson(options)) throw new Error("new Map(options) needs an options object");
    const o = options;
    const native: NativeMapOptions = {
      container: o.container,
      style: null,
      fov: typeof o.fov === "number" ? o.fov : MAPLIBRE_FOV,
      logoControl: o.maplibreLogo === true || o.logoControl === true,
    };
    const n = native as unknown as Json;
    for (const key of [
      "zoom",
      "bearing",
      "pitch",
      "hash",
      "interactive",
      "bearingSnap",
      "clickTolerance",
      "pixelRatio",
      "fadeDuration",
      "renderWorldCopies",
    ]) {
      if (o[key] !== undefined && o[key] !== null) n[key] = o[key];
    }
    for (const key of ["minZoom", "maxZoom", "minPitch", "maxPitch"]) {
      if (typeof o[key] === "number") n[key] = o[key];
    }
    if (o.center !== undefined) native.center = lngLatTuple(o.center);
    if (o.maxBounds) native.maxBounds = boundsTuple(o.maxBounds);
    if (o.bounds) native.bounds = boundsTuple(o.bounds);
    if (o.fitBoundsOptions) native.fitBoundsOptions = fitOptions(o.fitBoundsOptions);
    const antialias = o.canvasContextAttributes?.antialias ?? o.antialias;
    if (antialias !== undefined) native.antialias = antialias;
    const preserve = o.canvasContextAttributes?.preserveDrawingBuffer ?? o.preserveDrawingBuffer;
    if (preserve !== undefined) native.preserveDrawingBuffer = preserve;
    for (const key of [
      "dragPan",
      "dragRotate",
      "scrollZoom",
      "boxZoom",
      "doubleClickZoom",
      "keyboard",
      "touchZoomRotate",
      "touchPitch",
      "cooperativeGestures",
    ]) {
      const on = enabled(o[key]);
      if (on !== undefined) n[key] = on;
    }
    const transform = nativeTransform(o.transformRequest);
    if (transform) native.transformRequest = transform;
    if (o.attributionControl === false) native.attributionControl = false;
    else {
      const custom =
        (isJson(o.attributionControl) ? o.attributionControl.customAttribution : undefined) ?? o.customAttribution;
      if (custom !== undefined) native.attributionControl = { custom };
    }
    if (isJson(o.locale)) {
      const locale: Partial<Record<UiText, string>> = {};
      for (const [key, value] of Object.entries(o.locale)) {
        const name = LOCALE[key] ?? (key as UiText);
        if (typeof value === "string") locale[name] = value;
      }
      native.locale = locale;
    }
    if (o.respectPrefersReducedMotion === false) native.reducedMotion = false;
    if (defaults.workerCount > 0) native.workerCount = defaults.workerCount;
    if (defaults.maxParallelImageRequests > 0) native.maxParallelRequests = defaults.maxParallelImageRequests;
    if (o.projection !== undefined && this.projectionType(o.projection) === "globe") warnGlobe();
    this.native = new MapkernMap(native);
    this.internals = internalsOf(this.native);
    this.internals.enableSyncQueries();
    const container = this.native.getContainer();
    injectCompatStyles(container.ownerDocument);
    this.unalias = aliasClasses(container);
    const m = this.native;
    this.dragPan = handlerSwitch(m.dragPan, m);
    this.dragRotate = handlerSwitch(m.dragRotate, m);
    this.scrollZoom = handlerSwitch(m.scrollZoom, m, { setWheelZoomRate: () => {}, setZoomRate: () => {} });
    this.boxZoom = handlerSwitch(m.boxZoom, m);
    this.doubleClickZoom = handlerSwitch(m.doubleClickZoom, m);
    this.keyboard = handlerSwitch(m.keyboard, m, { disableRotation: () => {}, enableRotation: () => {} });
    const touch: TouchZoomRotateSwitch = m.touchZoomRotate;
    this.touchZoomRotate = handlerSwitch(touch, m, {
      enableRotation: () => touch.enableRotation(),
      disableRotation: () => touch.disableRotation(),
      isRotationEnabled: () => touch.isRotationEnabled(),
    });
    this.touchPitch = handlerSwitch(m.touchPitch, m);
    this.cooperativeGestures = handlerSwitch(m.cooperativeGestures, m);
    m.on("styleload", (event) => this.noteSkipped(event.skipped));
    this.setStyle(o.style === undefined || o.style === null ? EMPTY_STYLE : o.style, { diff: false });
  }

  get style(): Json | undefined {
    return this.styleToken ?? undefined;
  }

  get terrain(): Json | null {
    const terrain = this.native.getTerrain();
    return terrain ? { ...terrain } : null;
  }

  get loadedFlag(): boolean {
    return this.native.loaded();
  }

  get showTileBoundaries(): boolean {
    return this.native.showTileBoundaries;
  }

  set showTileBoundaries(on: boolean) {
    this.native.showTileBoundaries = on;
  }

  get showCollisionBoxes(): boolean {
    return this.native.showCollisionBoxes;
  }

  set showCollisionBoxes(on: boolean) {
    this.native.showCollisionBoxes = on;
  }

  get showPadding(): boolean {
    return this.native.showPadding;
  }

  set showPadding(on: boolean) {
    this.native.showPadding = on;
  }

  shadowSource(id: string): Json | undefined {
    return this.shadow?.sources.get(id);
  }

  nativeSource(id: string): MapSource | undefined {
    return this.internals.style()?.sources.get(id);
  }

  whenSourceSettles(id: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        let settled: boolean;
        try {
          settled = this.native.isSourceLoaded(id);
        } catch {
          settled = true;
        }
        if (settled) {
          this.native.off("idle", check);
          resolve();
        }
      };
      this.native.on("idle", check);
      this.native.triggerRepaint();
    });
  }

  getContainer(): HTMLElement {
    return this.native.getContainer();
  }

  getCanvas(): HTMLCanvasElement {
    return this.native.getCanvas();
  }

  getCanvasContainer(): HTMLElement {
    return this.native.getCanvasContainer();
  }

  getCenter(): LngLat {
    const [lng, lat] = this.native.getCenter();
    return new LngLat(lng, lat);
  }

  setCenter(center: LngLatLike, _eventData?: unknown): this {
    this.native.setCenter(lngLatTuple(center));
    return this;
  }

  getZoom(): number {
    return this.native.getZoom();
  }

  setZoom(zoom: number, _eventData?: unknown): this {
    this.native.setZoom(zoom);
    return this;
  }

  getBearing(): number {
    return this.native.getBearing();
  }

  setBearing(bearing: number, _eventData?: unknown): this {
    this.native.setBearing(bearing);
    return this;
  }

  getPitch(): number {
    return this.native.getPitch();
  }

  setPitch(pitch: number, _eventData?: unknown): this {
    this.native.setPitch(pitch);
    return this;
  }

  getRoll(): number {
    return 0;
  }

  setRoll(_roll: number): this {
    return this;
  }

  getVerticalFieldOfView(): number {
    return this.native.getVerticalFieldOfView();
  }

  setVerticalFieldOfView(fov: number): this {
    this.native.setVerticalFieldOfView(fov);
    return this;
  }

  getMinZoom(): number {
    return this.native.getMinZoom();
  }

  setMinZoom(zoom?: number | null): this {
    this.native.setMinZoom(zoom ?? -2);
    return this;
  }

  getMaxZoom(): number {
    return this.native.getMaxZoom();
  }

  setMaxZoom(zoom?: number | null): this {
    this.native.setMaxZoom(zoom ?? 22);
    return this;
  }

  getMinPitch(): number {
    return this.native.getMinPitch();
  }

  setMinPitch(pitch?: number | null): this {
    this.native.setMinPitch(pitch ?? 0);
    return this;
  }

  getMaxPitch(): number {
    return this.native.getMaxPitch();
  }

  setMaxPitch(pitch?: number | null): this {
    this.native.setMaxPitch(pitch ?? 60);
    return this;
  }

  getMaxBounds(): LngLatBounds | null {
    const bounds = this.native.getMaxBounds();
    return bounds ? new LngLatBounds(bounds[0], bounds[1]) : null;
  }

  setMaxBounds(bounds?: LngLatBoundsLike | null): this {
    this.native.setMaxBounds(bounds ? boundsTuple(bounds) : null);
    return this;
  }

  getBounds(): LngLatBounds {
    const [sw, ne] = this.native.getBounds();
    return new LngLatBounds(sw, ne);
  }

  getPadding(): { top: number; right: number; bottom: number; left: number } {
    return { ...this.native.getPadding() };
  }

  setPadding(padding: PaddingOptions, _eventData?: unknown): this {
    this.native.setPadding(padding);
    return this;
  }

  getRenderWorldCopies(): boolean {
    return this.native.getRenderWorldCopies();
  }

  setRenderWorldCopies(render?: boolean | null): this {
    this.native.setRenderWorldCopies(render !== false);
    return this;
  }

  getPixelRatio(): number {
    return this.native.getPixelRatio();
  }

  setPixelRatio(ratio: number): this {
    this.native.setPixelRatio(ratio);
    return this;
  }

  getCenterElevation(): number {
    return this.native.getCenterElevation();
  }

  getCameraTargetElevation(): number {
    return this.native.getCenterElevation();
  }

  queryTerrainElevation(lngLat: LngLatLike): number | null {
    return this.native.queryTerrainElevation(lngLatTuple(lngLat));
  }

  jumpTo(options: Json, _eventData?: unknown): this {
    this.native.jumpTo(cameraOptions(options, this.native));
    return this;
  }

  easeTo(options: Json, _eventData?: unknown): this {
    this.native.easeTo(cameraOptions(options, this.native));
    return this;
  }

  flyTo(options: Json, _eventData?: unknown): this {
    this.native.flyTo(cameraOptions(options, this.native));
    return this;
  }

  panBy(offset: PointLike, options: Json = {}, _eventData?: unknown): this {
    this.native.panBy(pointTuple(offset), cameraOptions(options, this.native));
    return this;
  }

  panTo(center: LngLatLike, options: Json = {}, _eventData?: unknown): this {
    return this.easeTo({ ...options, center });
  }

  zoomTo(zoom: number, options: Json = {}, _eventData?: unknown): this {
    return this.easeTo({ ...options, zoom });
  }

  zoomIn(options: Json = {}, _eventData?: unknown): this {
    return this.zoomTo(this.getZoom() + 1, options);
  }

  zoomOut(options: Json = {}, _eventData?: unknown): this {
    return this.zoomTo(this.getZoom() - 1, options);
  }

  rotateTo(bearing: number, options: Json = {}, _eventData?: unknown): this {
    return this.easeTo({ ...options, bearing });
  }

  resetNorth(options: Json = {}, _eventData?: unknown): this {
    return this.rotateTo(0, { duration: 1000, ...options });
  }

  resetNorthPitch(options: Json = {}, _eventData?: unknown): this {
    return this.easeTo({ duration: 1000, ...options, bearing: 0, pitch: 0 });
  }

  snapToNorth(options: Json = {}, _eventData?: unknown): this {
    if (Math.abs(this.getBearing()) < 7) return this.resetNorth(options);
    return this;
  }

  fitBounds(bounds: LngLatBoundsLike, options?: Json, _eventData?: unknown): this {
    const camera = this.cameraForBounds(bounds, options);
    if (!camera) return this;
    const animate = options?.animate !== false;
    if (!animate) return this.jumpTo(camera);
    if (options?.linear) return this.easeTo({ ...options, ...camera });
    return this.flyTo({ ...options, ...camera });
  }

  fitScreenCoordinates(p0: PointLike, p1: PointLike, bearing: number, options?: Json, _eventData?: unknown): this {
    this.native.fitScreenCoordinates(pointTuple(p0), pointTuple(p1), bearing, fitOptions(options));
    return this;
  }

  cameraForBounds(bounds: LngLatBoundsLike, options?: Json): Json | undefined {
    const camera = this.native.cameraForBounds(boundsTuple(bounds), fitOptions(options));
    if (!camera) return undefined;
    const out: Json = { ...camera };
    if (camera.center) out.center = new LngLat(...(lngLatTuple(camera.center) as [number, number]));
    return out;
  }

  stop(): this {
    this.native.stop();
    return this;
  }

  isMoving(): boolean {
    return this.native.isMoving();
  }

  isZooming(): boolean {
    return this.native.isZooming();
  }

  isRotating(): boolean {
    return this.native.isRotating();
  }

  isEasing(): boolean {
    return this.native.isEasing();
  }

  project(lngLat: LngLatLike): Point {
    const p = this.native.project(lngLatTuple(lngLat));
    return new Point(p.x, p.y);
  }

  unproject(point: PointLike): LngLat {
    const [x, y] = pointTuple(point);
    let found = this.native.unproject([x, y]);
    if (!found) {
      const height = this.native.getCanvasContainer().clientHeight || y + 1;
      let low = y;
      let high = height;
      for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2;
        const hit = this.native.unproject([x, mid]);
        if (hit) {
          found = hit;
          high = mid;
        } else {
          low = mid;
        }
      }
    }
    if (!found) return this.getCenter();
    return new LngLat(found[0], Math.max(-90, Math.min(90, found[1])));
  }

  setStyle(style: unknown, options: Json = {}): this {
    const user =
      typeof options.transformStyle === "function"
        ? (options.transformStyle as (a: unknown, b: unknown) => unknown)
        : null;
    const nativeOptions: SetStyleOptions = {
      diff: options.diff !== false,
      transformStyle: (_previous, next) => this.adoptStyle(next, user),
    };
    const input = style === null || style === undefined ? EMPTY_STYLE : style;
    this.native.setStyle(input as StyleSpec | StyleSpecV8 | string, nativeOptions);
    return this;
  }

  getStyle(): Json | undefined {
    if (this.shadow) return this.shadow.serialize();
    return (this.native.getStyle() as unknown as Json | null) ?? undefined;
  }

  isStyleLoaded(): boolean {
    return this.native.isStyleLoaded();
  }

  loaded(): boolean {
    return this.native.loaded();
  }

  areTilesLoaded(): boolean {
    return this.native.areTilesLoaded();
  }

  isSourceLoaded(id: string): boolean {
    return this.native.isSourceLoaded(id);
  }

  addSource(id: string, source: Json): this {
    const shadow = this.requireShadow();
    if (shadow.sources.has(id)) {
      this.error(new Error(`There is already a source with ID "${id}".`));
      return this;
    }
    if (!isJson(source) || typeof source.type !== "string") {
      this.error(new Error(`The source "${id}" needs a type.`));
      return this;
    }
    shadow.sources.set(id, { ...source });
    const imported = importSource(id, source);
    this.noteSkipped(imported.skipped);
    if (imported.source) {
      try {
        this.native.addSource(id, imported.source);
      } catch (error) {
        shadow.sources.delete(id);
        this.error(error);
        return this;
      }
    }
    this.resyncLayersOf(id);
    return this;
  }

  removeSource(id: string): this {
    const shadow = this.requireShadow();
    if (!shadow.sources.has(id)) throw new Error(`There is no source with ID "${id}"`);
    const user = shadow.layers.find((l) => !isCustomLayer(l) && l.source === id);
    if (user) {
      this.error(new Error(`Source "${id}" cannot be removed while layer "${user.id}" is using it.`));
      return this;
    }
    shadow.sources.delete(id);
    this.sources.delete(id);
    if (this.nativeSource(id)) {
      try {
        this.native.removeSource(id);
      } catch (error) {
        this.error(error);
      }
    }
    return this;
  }

  getSource(id: string): CompatSource | undefined {
    if (!this.shadow?.sources.has(id)) return undefined;
    let source = this.sources.get(id);
    if (!source) {
      source = new CompatSource(this, id);
      this.sources.set(id, source);
    }
    return source;
  }

  addLayer(layer: Json | CustomLayerInterface, beforeId?: string): this {
    const shadow = this.requireShadow();
    if (!isJson(layer) || typeof layer.id !== "string") {
      this.error(new Error("A layer needs an id."));
      return this;
    }
    if (shadow.layer(layer.id)) {
      this.error(new Error(`Layer "${layer.id}" already exists on this map.`));
      return this;
    }
    if (beforeId !== undefined && !shadow.layer(beforeId)) {
      this.error(new Error(`Cannot add layer "${layer.id}" before non-existing layer "${beforeId}".`));
      return this;
    }
    if (isCustomLayer(layer)) {
      shadow.insert(layer as unknown as ShadowLayer, beforeId);
      this.noteSkipped([`custom layers aren't drawn yet (${layer.id})`]);
      return this;
    }
    let spec = layer as ShadowLayer;
    if (isJson(spec.source)) {
      this.addSource(spec.id, spec.source);
      spec = { ...spec, source: spec.id };
    }
    shadow.insert(cloneLayerSpec(spec), beforeId);
    this.syncLayer(spec.id);
    return this;
  }

  removeLayer(id: string): this {
    const shadow = this.requireShadow();
    const layer = shadow.remove(id);
    if (!layer) {
      this.error(new Error(`Cannot remove non-existing layer "${id}".`));
      return this;
    }
    if (isCustomLayer(layer)) return this;
    if (this.nativeHasLayer(id)) this.native.removeLayer(id);
    return this;
  }

  moveLayer(id: string, beforeId?: string): this {
    const shadow = this.requireShadow();
    if (!shadow.layer(id)) {
      this.error(new Error(`The layer "${id}" does not exist in the map's style and cannot be moved.`));
      return this;
    }
    if (beforeId !== undefined && !shadow.layer(beforeId)) {
      this.error(new Error(`Cannot move layer "${id}" before non-existing layer "${beforeId}".`));
      return this;
    }
    if (!shadow.move(id, beforeId)) return this;
    if (this.nativeHasLayer(id)) this.native.moveLayer(id, this.nativeBefore(shadow.indexOf(id)));
    return this;
  }

  getLayer(id: string): Json | undefined {
    const layer = this.shadow?.layer(id);
    return layer ? layerView(layer) : undefined;
  }

  getLayersOrder(): string[] {
    return this.shadow?.layers.map((l) => l.id) ?? [];
  }

  setPaintProperty(id: string, name: string, value: unknown, _options?: unknown): this {
    return this.editLayer(id, "paint", (group) => {
      if (value === null || value === undefined) delete group[name];
      else group[name] = value;
    });
  }

  setLayoutProperty(id: string, name: string, value: unknown, _options?: unknown): this {
    return this.editLayer(id, "layout", (group) => {
      if (value === null || value === undefined) delete group[name];
      else group[name] = value;
    });
  }

  getPaintProperty(id: string, name: string): unknown {
    const layer = this.shadow?.layer(id);
    return isJson(layer?.paint) ? layer.paint[name] : undefined;
  }

  getLayoutProperty(id: string, name: string): unknown {
    const layer = this.shadow?.layer(id);
    return isJson(layer?.layout) ? layer.layout[name] : undefined;
  }

  setFilter(id: string, filter: unknown, _options?: unknown): this {
    const layer = this.shadow?.layer(id);
    if (!layer) {
      this.error(new Error(`The layer "${id}" does not exist in the map's style and cannot be filtered.`));
      return this;
    }
    if (filter === null || filter === undefined) delete layer.filter;
    else layer.filter = filter;
    this.syncLayer(id);
    return this;
  }

  getFilter(id: string): unknown {
    return this.shadow?.layer(id)?.filter;
  }

  setLayerZoomRange(id: string, minzoom: number, maxzoom: number): this {
    const layer = this.shadow?.layer(id);
    if (!layer) {
      this.error(new Error(`The layer "${id}" does not exist in the map's style and cannot have its zoom range set.`));
      return this;
    }
    layer.minzoom = minzoom;
    layer.maxzoom = maxzoom;
    this.syncLayer(id);
    return this;
  }

  setTerrain(terrain: Json | null | undefined): this {
    const shadow = this.requireShadow();
    if (!terrain) {
      delete shadow.root.terrain;
      this.native.setTerrain(null);
    } else {
      try {
        this.native.setTerrain({
          source: String(terrain.source),
          exaggeration: typeof terrain.exaggeration === "number" ? terrain.exaggeration : 1,
        });
        shadow.root.terrain = { ...terrain };
      } catch (error) {
        this.error(error);
        return this;
      }
    }
    this.fire({ type: "terrain", terrain: terrain ?? null });
    return this;
  }

  getTerrain(): Json | null {
    const terrain = this.shadow?.root.terrain;
    return isJson(terrain) ? { ...terrain } : null;
  }

  setSky(sky: Json | null | undefined): this {
    const shadow = this.requireShadow();
    if (!sky) delete shadow.root.sky;
    else shadow.root.sky = { ...sky };
    this.applySky();
    return this;
  }

  getSky(): Json | undefined {
    const sky = this.shadow?.root.sky;
    return isJson(sky) ? { ...sky } : undefined;
  }

  setFog(fog: Json | null | undefined): this {
    const shadow = this.requireShadow();
    if (!fog) delete shadow.root.fog;
    else shadow.root.fog = { ...fog };
    this.applySky();
    return this;
  }

  getFog(): Json | null {
    const fog = this.shadow?.root.fog;
    return isJson(fog) ? { ...fog } : null;
  }

  setLight(light: Json, _options?: unknown): this {
    const shadow = this.requireShadow();
    shadow.root.light = { ...light };
    return this;
  }

  getLight(): Json | undefined {
    const light = this.shadow?.root.light;
    return isJson(light) ? { ...light } : undefined;
  }

  setProjection(projection: unknown): this {
    const type = this.projectionType(projection);
    if (type === "globe") warnGlobe();
    const shadow = this.shadow;
    if (shadow) shadow.root.projection = { type: "mercator" };
    this.fire({ type: "projectiontransition", newProjection: "mercator" });
    return this;
  }

  getProjection(): Json {
    return { type: "mercator" };
  }

  setGlyphs(url: string | null): this {
    return this.editStyleRoot("glyphs", url);
  }

  getGlyphs(): unknown {
    return this.shadow?.root.glyphs ?? null;
  }

  setSprite(url: unknown): this {
    return this.editStyleRoot("sprite", url);
  }

  getSprite(): unknown[] {
    const sprite = this.shadow?.root.sprite;
    if (sprite === undefined) return [];
    if (typeof sprite === "string") return [{ id: "default", url: sprite }];
    return Array.isArray(sprite) ? sprite : [];
  }

  addImage(id: string, image: unknown, options: Json = {}): this {
    const input = image as AnimatedImage;
    const native = this.native as unknown as { addImage(id: string, image: unknown, options: Json): unknown };
    try {
      native.addImage(id, image, options);
    } catch (error) {
      this.error(error);
      return this;
    }
    if (typeof input.render === "function") {
      this.animated.set(id, input);
      input.onAdd?.(this, id);
      this.animate();
    }
    return this;
  }

  updateImage(id: string, image: unknown): this {
    (this.native as unknown as { updateImage(id: string, image: unknown): unknown }).updateImage(id, image);
    return this;
  }

  hasImage(id: string): boolean {
    return this.native.hasImage(id);
  }

  removeImage(id: string): this {
    const animated = this.animated.get(id);
    if (animated) {
      this.animated.delete(id);
      animated.onRemove?.();
    }
    if (this.native.hasImage(id)) this.native.removeImage(id);
    return this;
  }

  listImages(): string[] {
    return this.native.listImages();
  }

  loadImage(url: string, callback?: (error: unknown, image?: ImageBitmap) => void): Promise<{ data: ImageBitmap }> {
    const promise = this.native.loadImage(url);
    if (typeof callback === "function") {
      promise.then(
        (image) => callback(null, image),
        (error: unknown) => callback(error),
      );
    }
    return promise.then((data) => ({ data }));
  }

  setFeatureState(feature: Json, state: Json): this {
    this.native.setFeatureState(feature as never, state);
    return this;
  }

  getFeatureState(feature: Json): Json {
    return this.native.getFeatureState(feature as never);
  }

  removeFeatureState(feature: Json, key?: string): this {
    this.native.removeFeatureState(feature as never, key);
    return this;
  }

  queryRenderedFeatures(geometryOrOptions?: unknown, options?: Json): Json[] {
    let geometry: unknown = geometryOrOptions;
    let opts: Json = options ?? {};
    if (options === undefined && geometryOrOptions !== undefined && !isPointLike(geometryOrOptions)) {
      if (isJson(geometryOrOptions)) {
        geometry = undefined;
        opts = geometryOrOptions;
      }
    }
    let layers: string[] | undefined;
    if (Array.isArray(opts.layers)) {
      layers = (opts.layers as unknown[]).map(String).filter((id) => this.nativeHasLayer(id));
      if (layers.length === 0) return [];
    }
    const found = this.internals.queryRenderedFeaturesSync(queryGeometry(geometry) as never, layers ? { layers } : {});
    const filter = opts.filter !== undefined && opts.filter !== null ? this.compileFilter(opts.filter) : null;
    const views = new Map<string, Json>();
    const out: Json[] = [];
    for (const f of found) {
      if (filter && !filter(f)) continue;
      out.push(this.feature(f, views));
    }
    return out;
  }

  querySourceFeatures(sourceId: string, parameters: Json = {}): Json[] {
    const style = this.internals.style();
    const source = style?.sources.get(sourceId);
    if (!source) return [];
    const filter =
      parameters.filter !== undefined && parameters.filter !== null ? this.compileFilter(parameters.filter) : null;
    const sourceLayer = typeof parameters.sourceLayer === "string" ? parameters.sourceLayer : undefined;
    const out: Json[] = [];
    for (const f of this.internals.querySourceFeaturesSync(sourceId, sourceLayer)) {
      if (filter && !filter(f as QueriedFeature)) continue;
      out.push({ ...f });
    }
    return out;
  }

  addControl(control: IControl | Control, position?: ControlPosition): this {
    if (isNativeControl(control)) {
      this.native.addControl(control, position);
      return this;
    }
    const host = hostControl(control as IControl, this);
    this.hosted.set(control as IControl, host);
    this.native.addControl(host, position);
    return this;
  }

  removeControl(control: IControl | Control): this {
    const host = this.hosted.get(control as IControl);
    if (host) {
      this.hosted.delete(control as IControl);
      this.native.removeControl(host);
    } else {
      this.native.removeControl(control as Control);
    }
    return this;
  }

  hasControl(control: IControl | Control): boolean {
    if (this.hosted.has(control as IControl)) return true;
    return this.native.hasControl(control as Control);
  }

  setTransformRequest(transform: CompatMapOptions["transformRequest"] | null): this {
    this.native.setTransformRequest(transform ? (nativeTransform(transform) ?? null) : null);
    return this;
  }

  refreshTiles(sourceId: string, tileIds?: { z: number; x: number; y: number }[]): void {
    this.native.refreshTiles(sourceId, tileIds);
  }

  resize(_eventData?: unknown): this {
    this.native.resize();
    return this;
  }

  triggerRepaint(): void {
    this.native.triggerRepaint();
  }

  redraw(): this {
    this.native.triggerRepaint();
    return this;
  }

  remove(): void {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.unalias();
    this.native.remove();
  }

  on(type: string, layerOrListener: unknown, listener?: unknown): Subscription & this {
    const layered = typeof layerOrListener !== "function";
    const fn = (layered ? listener : layerOrListener) as Listener;
    if (typeof fn !== "function") throw new TypeError(`map.on("${type}") needs a listener function`);
    const registration = this.register(type, layered ? layerList(layerOrListener) : undefined, fn, false);
    return this.subscription(() => this.unregister(registration));
  }

  once(type: string, layerOrListener?: unknown, listener?: unknown): this | Promise<unknown> {
    const layered = layerOrListener !== undefined && typeof layerOrListener !== "function";
    const fn = (layered ? listener : layerOrListener) as Listener | undefined;
    const layers = layered ? layerList(layerOrListener) : undefined;
    if (typeof fn === "function") {
      this.register(type, layers, fn, true);
      return this;
    }
    return new Promise((resolve) => this.register(type, layers, resolve as Listener, true));
  }

  off(type: string, layerOrListener: unknown, listener?: unknown): this {
    const layered = typeof layerOrListener !== "function";
    const fn = (layered ? listener : layerOrListener) as Listener;
    const layers = layered ? layerList(layerOrListener) : undefined;
    const found = this.registrations.find((r) => r.type === type && r.listener === fn && sameList(r.layers, layers));
    if (found) this.unregister(found);
    return this;
  }

  listens(type: string): boolean {
    return this.registrations.some((r) => r.type === type);
  }

  fire(event: string | Json, properties?: Json): this {
    const e: Json = typeof event === "string" ? { ...(properties ?? {}), type: event } : { ...event };
    e.target = this;
    const type = String(e.type);
    for (const registration of [...this.registrations]) {
      if (registration.type !== type || registration.layers) continue;
      if (registration.once) this.unregister(registration);
      try {
        registration.listener.call(this, e as never);
      } catch (error) {
        setTimeout(() => {
          throw error;
        }, 0);
      }
    }
    return this;
  }

  private register(type: string, layers: string[] | undefined, listener: Listener, once: boolean): Registration {
    const registration: Registration = { type, layers, listener, once, nativeType: null, wrapper: null };
    if (layers) {
      if (LAYER_EVENTS.has(type)) {
        registration.nativeType = type;
        registration.wrapper = (event) => this.deliver(registration, event);
        this.native.on(type as never, layers, registration.wrapper as never);
      } else if (TOUCH_LAYER_EVENTS.has(type)) {
        registration.nativeType = type;
        registration.wrapper = (event) => {
          const point = (event as { point?: { x: number; y: number } }).point;
          if (!point) return;
          const features = this.queryRenderedFeatures([point.x, point.y], { layers });
          if (features.length === 0) return;
          this.deliver(registration, event, features);
        };
        this.native.on(type as never, registration.wrapper as never);
      }
    } else {
      const nativeType = RENAMED[type] ?? (NATIVE_EVENTS.has(type) ? type : null);
      if (nativeType) {
        registration.nativeType = nativeType;
        registration.wrapper = (event) => this.deliver(registration, event);
        this.native.on(nativeType as never, registration.wrapper as never);
      }
    }
    this.registrations.push(registration);
    return registration;
  }

  private unregister(registration: Registration): void {
    const index = this.registrations.indexOf(registration);
    if (index < 0) return;
    this.registrations.splice(index, 1);
    if (!registration.nativeType || !registration.wrapper) return;
    if (registration.layers && LAYER_EVENTS.has(registration.type)) {
      this.native.off(registration.nativeType as never, registration.layers, registration.wrapper as never);
    } else {
      this.native.off(registration.nativeType as never, registration.wrapper as never);
    }
  }

  private deliver(registration: Registration, event: unknown, features?: Json[]): void {
    const converted = this.convertEvent(registration.type, event as Json);
    if (!converted) return;
    if (features) converted.features = features;
    if (registration.once) this.unregister(registration);
    registration.listener.call(this, converted as never);
  }

  private subscription(unsubscribe: () => void): Subscription & this {
    return new Proxy(this, {
      get(target, property, receiver) {
        if (property === "unsubscribe") return unsubscribe;
        return Reflect.get(target, property, receiver);
      },
    }) as Subscription & this;
  }

  private convertEvent(type: string, e: Json): Json | null {
    const out: Json = { type, target: this };
    if (e.originalEvent !== undefined) out.originalEvent = e.originalEvent;
    const point = e.point as { x: number; y: number } | undefined;
    if (point) out.point = new Point(point.x, point.y);
    if ("lngLat" in e) {
      const ll = e.lngLat as [number, number] | null;
      out.lngLat = ll ? new LngLat(ll[0], Math.max(-90, Math.min(90, ll[1]))) : this.unproject(out.point as Point);
    }
    if (Array.isArray(e.points)) {
      const points = (e.points as { x: number; y: number }[]).map((p) => new Point(p.x, p.y));
      out.points = points;
      const lngLats = Array.isArray(e.lngLats) ? (e.lngLats as ([number, number] | null)[]) : [];
      out.lngLats = points.map((p, i) => {
        const ll = lngLats[i];
        return ll ? new LngLat(ll[0], Math.max(-90, Math.min(90, ll[1]))) : this.unproject(p);
      });
    }
    if (typeof e.preventDefault === "function") {
      const prevent = e.preventDefault as () => void;
      out.preventDefault = () => prevent.call(e);
      Object.defineProperty(out, "defaultPrevented", { get: () => e.defaultPrevented === true, enumerable: true });
    }
    if (Array.isArray(e.features)) {
      const views = new Map<string, Json>();
      out.features = (e.features as QueriedFeature[]).map((f) => this.feature(f, views));
    }
    switch (type) {
      case "error":
        out.error = e.error;
        if (e.sourceId !== undefined) out.sourceId = e.sourceId;
        break;
      case "sourcedata":
      case "data": {
        if (type === "sourcedata" && e.kind === "error") return null;
        out.dataType = type === "sourcedata" ? "source" : e.dataType;
        if (typeof e.sourceId === "string") {
          out.sourceId = e.sourceId;
          out.source = this.shadow?.sources.get(e.sourceId);
          out.sourceDataType = e.kind === "metadata" ? "metadata" : "content";
          let loaded = false;
          try {
            loaded = this.native.isSourceLoaded(e.sourceId);
          } catch {
            loaded = false;
          }
          out.isSourceLoaded = loaded;
        }
        break;
      }
      case "styledata":
        out.dataType = "style";
        break;
      case "styleimagemissing":
        out.id = e.id;
        break;
    }
    return out;
  }

  private feature(f: QueriedFeature, views: Map<string, Json>): Json {
    let view = views.get(f.layer);
    if (!view) {
      const layer = this.shadow?.layer(f.layer);
      view = layer ? layerView(layer) : { id: f.layer };
      views.set(f.layer, view);
    }
    const out: Json = {
      type: "Feature",
      id: f.id,
      properties: f.properties,
      geometry: f.geometry,
      layer: view,
      source: f.source,
      sourceLayer: f.sourceLayer,
      state: f.state,
    };
    Object.defineProperty(out, "toJSON", {
      value: () => ({ type: "Feature", id: f.id, properties: f.properties, geometry: f.geometry }),
      enumerable: false,
    });
    return out;
  }

  private compileFilter(filter: unknown): (f: QueriedFeature) => boolean {
    const compiled = compile<boolean>(convertFilter(filter), "boolean", false, "filter", { geometry: true });
    const zoom = () => this.getZoom();
    return (f) =>
      compiled.evaluate({
        zoom: zoom(),
        feature: { properties: f.properties as never, id: f.id, geometryType: geometryType(f.geometry) },
      } as never) === true;
  }

  private adoptStyle(
    next: unknown,
    user: ((previous: unknown, next: unknown) => unknown) | null,
  ): StyleSpec | StyleSpecV8 {
    let style = next;
    if (user) style = user(this.shadow ? this.shadow.serialize() : undefined, next);
    if (isJson(style) && style.version === 8) {
      this.shadow = new ShadowStyle(style);
      this.styleToken = { loaded: () => this.native.isStyleLoaded(), stylesheet: style };
      this.sources.clear();
      this.noted.clear();
      const root = this.shadow.root;
      if (root.projection !== undefined && this.projectionType(root.projection) === "globe") warnGlobe();
    } else if (isJson(style)) {
      this.shadow = new ShadowStyle(EMPTY_STYLE);
      this.styleToken = { loaded: () => this.native.isStyleLoaded(), stylesheet: style };
      this.sources.clear();
    }
    return style as StyleSpec | StyleSpecV8;
  }

  private requireShadow(): ShadowStyle {
    if (!this.shadow) throw new Error("Style is not done loading.");
    return this.shadow;
  }

  private nativeHasLayer(id: string): boolean {
    return this.internals.style()?.getLayer(id) !== undefined;
  }

  private nativeBefore(index: number): string | undefined {
    const layers = this.shadow?.layers ?? [];
    for (let i = index + 1; i < layers.length; i++) {
      const id = layers[i]!.id;
      if (this.nativeHasLayer(id)) return id;
    }
    return undefined;
  }

  private nativeSourceSpecs(): Record<string, SourceSpec> {
    const out: Record<string, SourceSpec> = {};
    for (const [id, source] of this.internals.style()?.sources ?? []) out[id] = source.spec;
    return out;
  }

  private serverFonts(): boolean {
    return serverGlyphs(this.shadow?.root.glyphs) !== null;
  }

  private syncLayer(id: string): void {
    const shadow = this.shadow;
    if (!shadow) return;
    const index = shadow.indexOf(id);
    const spec = shadow.layers[index];
    const present = this.nativeHasLayer(id);
    if (!spec || isCustomLayer(spec)) {
      if (present) this.native.removeLayer(id);
      return;
    }
    let imported: { layer: LayerSpec | null; skipped: string[] };
    try {
      imported = importLayer(spec, this.nativeSourceSpecs(), this.serverFonts());
    } catch (error) {
      this.error(error);
      return;
    }
    this.noteSkipped(imported.skipped);
    if (!imported.layer) {
      if (present) this.native.removeLayer(id);
      return;
    }
    try {
      if (present) this.internals.restyleLayer(imported.layer);
      else this.native.addLayer(imported.layer, this.nativeBefore(index));
    } catch (error) {
      this.error(error);
    }
  }

  private resyncLayersOf(sourceId: string): void {
    for (const layer of this.shadow?.layers ?? []) {
      if (!isCustomLayer(layer) && layer.source === sourceId && !this.nativeHasLayer(layer.id))
        this.syncLayer(layer.id);
    }
  }

  private editLayer(id: string, group: "paint" | "layout", edit: (values: Json) => void): this {
    const layer = this.shadow?.layer(id);
    if (!layer || isCustomLayer(layer)) {
      this.error(new Error(`The layer "${id}" does not exist in the map's style and cannot be styled.`));
      return this;
    }
    const values = isJson(layer[group]) ? (layer[group] as Json) : {};
    edit(values);
    layer[group] = values;
    this.syncLayer(id);
    return this;
  }

  private editStyleRoot(key: string, value: unknown): this {
    const shadow = this.requireShadow();
    if (value === null || value === undefined) delete shadow.root[key];
    else shadow.root[key] = value;
    this.native.setStyle(shadow.serialize() as unknown as StyleSpecV8, {
      diff: true,
      transformStyle: (_previous, next) => next,
    });
    return this;
  }

  private applySky(): void {
    const root = this.shadow?.root ?? {};
    const { sky, skipped } = importSky({ sky: root.sky, fog: root.fog });
    this.noteSkipped(skipped);
    try {
      this.native.setSky(sky);
    } catch (error) {
      this.error(error);
    }
  }

  private projectionType(projection: unknown): string {
    if (typeof projection === "string") return projection;
    if (isJson(projection)) {
      const type = projection.type ?? projection.name;
      if (typeof type === "string") return type;
      if (Array.isArray(type) && type.includes("globe")) return "globe";
    }
    return "mercator";
  }

  private animate(): void {
    if (this.animationFrame || this.animated.size === 0) return;
    const step = () => {
      this.animationFrame = 0;
      if (this.animated.size === 0) return;
      let changed = false;
      for (const [id, image] of this.animated) {
        if (image.render?.()) {
          this.native.updateImage(id, { width: image.width, height: image.height, data: image.data });
          changed = true;
        }
      }
      if (changed) this.native.triggerRepaint();
      this.animationFrame = requestAnimationFrame(step);
    };
    this.animationFrame = requestAnimationFrame(step);
  }

  private error(error: unknown): void {
    const e = error instanceof Error ? error : new Error(String(error));
    if (this.listens("error")) this.fire({ type: "error", error: e });
    else console.error(e);
  }

  private noteSkipped(skipped: readonly string[]): void {
    for (const reason of skipped) {
      if (this.noted.has(reason)) continue;
      this.noted.add(reason);
      console.warn(`Mapkern left out: ${reason}`);
    }
  }
}

function cloneLayerSpec(layer: ShadowLayer): ShadowLayer {
  const out: ShadowLayer = { ...layer };
  for (const key of ["paint", "layout", "metadata"]) {
    const value = out[key];
    if (isJson(value)) out[key] = { ...value };
  }
  return out;
}
