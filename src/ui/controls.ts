import { MapkernError } from "../core/errors.ts";
import { Emitter } from "../core/events.ts";
import type { FitBoundsOptions, MapkernMap, UiText } from "../core/map.ts";
import type { Projection } from "../geo/globe.ts";
import { globeFitZoom } from "../geo/globe.ts";
import { distanceMeters, metersPerPixel } from "../geo/mercator.ts";
import type { DemSourceSpec, StyleSpec, StyleSpecV8 } from "../style/types.ts";
import { Marker } from "./marker.ts";
import { safeLinkFragment } from "./sanitize.ts";

export type ControlPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface Control {
  onAdd(map: MapkernMap): HTMLElement;
  onRemove(map: MapkernMap): void;
  readonly defaultPosition?: ControlPosition;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(doc: Document, paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function button(
  doc: Document,
  label: string,
  className: string,
  svg: SVGSVGElement,
  onClick: () => void,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.appendChild(svg);
  b.addEventListener("click", onClick);
  return b;
}

export interface NavigationOptions {
  showZoom?: boolean;
  showCompass?: boolean;
}

export class NavigationControl implements Control {
  readonly defaultPosition: ControlPosition = "top-right";
  private readonly options: Required<NavigationOptions>;
  private element: HTMLElement | null = null;
  private zoomIn: HTMLButtonElement | null = null;
  private zoomOut: HTMLButtonElement | null = null;
  private compass: HTMLButtonElement | null = null;
  private needle: SVGSVGElement | null = null;
  private readonly update = () => this.refresh();

  constructor(options: NavigationOptions = {}) {
    this.options = { showZoom: options.showZoom ?? true, showCompass: options.showCompass ?? true };
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-navigation";
    if (this.options.showZoom) {
      this.zoomIn = button(doc, map.text("zoomIn"), "mapkern-zoom-in", icon(doc, ["M12 6v12", "M6 12h12"]), () =>
        map.zoomIn(),
      );
      this.zoomOut = button(doc, map.text("zoomOut"), "mapkern-zoom-out", icon(doc, ["M6 12h12"]), () => map.zoomOut());
      el.append(this.zoomIn, this.zoomOut);
    }
    if (this.options.showCompass) {
      this.needle = icon(doc, ["M12 3l4 9h-8z", "M12 21l-4-9h8z"]);
      const north = this.needle.firstElementChild;
      if (north) north.setAttribute("fill", "#d9473f");
      this.compass = button(doc, map.text("resetNorth"), "mapkern-compass", this.needle, () =>
        map.easeTo({ bearing: 0, pitch: 0 }),
      );
      el.append(this.compass);
    }
    map.on("move", this.update);
    map.on("resize", this.update);
    this.element = el;
    this.refresh(map);
    return el;
  }

  onRemove(map: MapkernMap): void {
    map.off("move", this.update);
    map.off("resize", this.update);
    this.element?.remove();
    this.element = null;
  }

  private mapRef: MapkernMap | null = null;

  private refresh(map?: MapkernMap): void {
    if (map) this.mapRef = map;
    const m = this.mapRef;
    if (!m) return;
    const zoom = m.getZoom();
    const atMax = zoom >= m.getMaxZoom() - 1e-9;
    const atMin = zoom <= m.transform.lowestZoom + 1e-9;
    if (this.zoomIn && this.zoomIn.disabled !== atMax) this.zoomIn.disabled = atMax;
    if (this.zoomOut && this.zoomOut.disabled !== atMin) this.zoomOut.disabled = atMin;
    if (this.needle) {
      const scale = 1 / Math.cos((m.getPitch() * Math.PI) / 180);
      const transform = `scale(1, ${Math.min(scale, 3).toFixed(2)}) rotate(${(-m.getBearing()).toFixed(1)}deg)`;
      if (transform !== this.lastTransform) {
        this.lastTransform = transform;
        this.needle.style.transform = transform;
      }
    }
  }

  private lastTransform = "";
}

export interface AttributionOptions {
  custom?: string | string[];
}

export class AttributionControl implements Control {
  readonly defaultPosition: ControlPosition = "bottom-right";
  private readonly custom: string[];
  private element: HTMLElement | null = null;
  private last = "";
  private readonly update = () => this.refresh();
  private mapRef: MapkernMap | null = null;

  constructor(options: AttributionOptions = {}) {
    this.custom = options.custom === undefined ? [] : Array.isArray(options.custom) ? options.custom : [options.custom];
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    const el = doc.createElement("div");
    el.className = "mapkern-attribution";
    el.setAttribute("role", "contentinfo");
    this.element = el;
    this.mapRef = map;
    map.on("sourcedata", this.update);
    map.on("styleload", this.update);
    this.refresh();
    return el;
  }

  onRemove(map: MapkernMap): void {
    map.off("sourcedata", this.update);
    map.off("styleload", this.update);
    this.element?.remove();
    this.element = null;
    this.mapRef = null;
  }

  private refresh(): void {
    const el = this.element;
    const map = this.mapRef;
    if (!el || !map) return;
    const parts = [...this.custom, ...map.getAttributions()];
    const unique = [...new Set(parts.map((p) => p.trim()).filter((p) => p.length > 0))];
    const key = unique.join("\u0000");
    if (key === this.last) return;
    this.last = key;
    el.replaceChildren();
    const doc = el.ownerDocument;
    unique.forEach((part, i) => {
      if (i > 0) el.appendChild(doc.createTextNode(" | "));
      el.appendChild(safeLinkFragment(doc, part));
    });
    el.title = el.textContent ?? "";
  }
}

export type ScaleUnit = "metric" | "imperial" | "both";

export interface ScaleOptions {
  maxWidth?: number;
  unit?: ScaleUnit;
}

export class ScaleControl implements Control {
  readonly defaultPosition: ControlPosition = "bottom-left";
  private readonly maxWidth: number;
  private unit: ScaleUnit;
  private element: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private line: HTMLElement | null = null;
  private mapRef: MapkernMap | null = null;
  private lastVisibility = "";
  private lastWidth = "";
  private lastLabel = "";
  private readonly update = () => this.refresh();

  constructor(options: ScaleOptions = {}) {
    this.maxWidth = options.maxWidth ?? 100;
    this.unit = options.unit ?? "both";
  }

  setUnit(unit: ScaleUnit): void {
    this.unit = unit;
    this.build();
    this.refresh();
  }

  onAdd(map: MapkernMap): HTMLElement {
    const el = map.getContainer().ownerDocument.createElement("div");
    el.className = "mapkern-scale";
    this.element = el;
    this.mapRef = map;
    this.build();
    map.on("move", this.update);
    this.refresh();
    return el;
  }

  onRemove(map: MapkernMap): void {
    map.off("move", this.update);
    this.element?.remove();
    this.element = null;
    this.label = null;
    this.line = null;
    this.mapRef = null;
  }

  private build(): void {
    const el = this.element;
    if (!el) return;
    const doc = el.ownerDocument;
    el.classList.toggle("mapkern-scale-both", this.unit === "both");
    el.textContent = "";
    const label = doc.createElement("div");
    label.className = "mapkern-scale-label";
    el.appendChild(label);
    this.label = label;
    this.line = null;
    if (this.unit === "both") {
      const line = doc.createElement("div");
      line.className = "mapkern-scale-line";
      el.appendChild(line);
      this.line = line;
    }
    this.lastVisibility = "";
    this.lastWidth = "";
    this.lastLabel = "";
  }

  private refresh(): void {
    const el = this.element;
    const map = this.mapRef;
    if (!el || !map) return;
    const h = map.transform.height / 2;
    const a = map.unproject([0, h]);
    const b = map.unproject([this.maxWidth, h]);
    const meters = a && b ? distanceMeters(a, b) : 0;
    const visibility = meters > 0 ? "visible" : "hidden";
    if (visibility !== this.lastVisibility) {
      this.lastVisibility = visibility;
      el.style.visibility = visibility;
    }
    if (!(meters > 0)) return;
    const bar = scaleBar(meters, this.maxWidth, this.unit === "imperial" ? "imperial" : "metric");
    const width = `${bar.width}px`;
    const sized = this.line ?? this.label;
    if (sized && width !== this.lastWidth) {
      this.lastWidth = width;
      sized.style.width = width;
    }
    const text = this.unit === "both" ? `${bar.label} · ${imperialLabel(bar.meters)}` : bar.label;
    if (this.label && text !== this.lastLabel) {
      this.lastLabel = text;
      this.label.textContent = text;
    }
  }
}

export interface ScaleBar {
  label: string;
  meters: number;
  width: number;
}

export function scaleBar(meters: number, maxWidth: number, unit: "metric" | "imperial"): ScaleBar {
  let span: number;
  let name: string;
  let size: number;
  if (unit === "imperial") {
    const feet = meters * FEET_PER_METER;
    if (feet > FEET_PER_MILE) {
      span = feet / FEET_PER_MILE;
      name = "mi";
      size = FEET_PER_MILE / FEET_PER_METER;
    } else {
      span = feet;
      name = "ft";
      size = 1 / FEET_PER_METER;
    }
  } else if (meters >= 1000) {
    span = meters / 1000;
    name = "km";
    size = 1000;
  } else {
    span = meters;
    name = "m";
    size = 1;
  }
  const value = niceNumber(span);
  return { label: `${value} ${name}`, meters: value * size, width: Math.round((maxWidth * value) / span) };
}

export function imperialLabel(meters: number): string {
  const feet = meters * FEET_PER_METER;
  return feet < FEET_PER_MILE ? `${shortNumber(feet)} ft` : `${shortNumber(feet / FEET_PER_MILE)} mi`;
}

function shortNumber(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Number(n.toPrecision(3)));
}

const FEET_PER_METER = 3.28084;
const FEET_PER_MILE = 5280;

function niceNumber(n: number): number {
  if (!(n > 0)) return 0;
  const exponent = Math.floor(Math.log10(n));
  const d = n / 10 ** exponent;
  const nice = d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  return exponent >= 0 ? nice * 10 ** exponent : nice / 10 ** -exponent;
}

const EXPAND = ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"];
const COLLAPSE = ["M9 4v5H4", "M15 4v5h5", "M9 20v-5H4", "M15 20v-5h5"];

export interface FullscreenOptions {
  container?: HTMLElement;
}

export interface FullscreenEvent {
  readonly target: FullscreenControl;
  readonly type: "fullscreenstart" | "fullscreenend";
}

export interface FullscreenEvents {
  fullscreenstart: FullscreenEvent;
  fullscreenend: FullscreenEvent;
}

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void };

export class FullscreenControl extends Emitter<FullscreenEvents> implements Control {
  readonly defaultPosition: ControlPosition = "top-right";
  private readonly options: FullscreenOptions;
  private map: MapkernMap | null = null;
  private target: FullscreenElement | null = null;
  private element: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private pseudo = false;
  private active = false;

  constructor(options: FullscreenOptions = {}) {
    super();
    this.options = { ...options };
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    this.target = (this.options.container ?? map.getContainer()) as FullscreenElement;
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-fullscreen";
    this.button = button(doc, map.text("fullscreen"), "mapkern-fullscreen-button", icon(doc, EXPAND), () =>
      this.toggle(),
    );
    el.appendChild(this.button);
    this.element = el;
    doc.addEventListener("fullscreenchange", this.onChange);
    doc.addEventListener("webkitfullscreenchange", this.onChange);
    return el;
  }

  onRemove(map: MapkernMap): void {
    const doc = map.getContainer().ownerDocument as FullscreenDocument;
    doc.removeEventListener("fullscreenchange", this.onChange);
    doc.removeEventListener("webkitfullscreenchange", this.onChange);
    if (this.pseudo) this.setPseudo(false);
    else if (this.active) this.exit(doc);
    this.element?.remove();
    this.element = null;
    this.map = null;
  }

  isFullscreen(): boolean {
    return this.active;
  }

  toggle(): void {
    const target = this.target;
    const map = this.map;
    if (!target || !map) return;
    const doc = map.getContainer().ownerDocument as FullscreenDocument;
    if (this.active) {
      if (this.pseudo) this.setPseudo(false);
      else this.exit(doc);
      return;
    }
    const request = target.requestFullscreen?.bind(target) ?? target.webkitRequestFullscreen?.bind(target);
    if (!request) {
      this.setPseudo(true);
      return;
    }
    const result = request() as Promise<void> | undefined;
    result?.catch(() => this.setPseudo(true));
  }

  private exit(doc: FullscreenDocument): void {
    if (doc.exitFullscreen) doc.exitFullscreen().catch(() => {});
    else doc.webkitExitFullscreen?.();
  }

  private setPseudo(on: boolean): void {
    this.pseudo = on;
    this.target?.classList.toggle("mapkern-pseudo-fullscreen", on);
    this.changed(on);
  }

  private readonly onChange = (): void => {
    const doc = this.map?.getContainer().ownerDocument as FullscreenDocument | undefined;
    if (!doc) return;
    const current = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    this.changed(current === this.target);
  };

  private changed(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    const b = this.button;
    const map = this.map;
    if (b && map) {
      const label = map.text(on ? "exitFullscreen" : "fullscreen");
      b.title = label;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(on));
      b.replaceChildren(icon(b.ownerDocument, on ? COLLAPSE : EXPAND));
    }
    map?.resize();
    this.emit(on ? "fullscreenstart" : "fullscreenend", {
      target: this,
      type: on ? "fullscreenstart" : "fullscreenend",
    });
  }
}

const TARGET = ["M12 3v3", "M12 18v3", "M3 12h3", "M18 12h3", "M12 7a5 5 0 1 0 0.01 0z"];

export type GeolocateState = "off" | "waiting" | "active" | "background" | "error";

export interface GeolocateOptions {
  positionOptions?: PositionOptions;
  fitBoundsOptions?: FitBoundsOptions;
  trackUserLocation?: boolean;
  showUserLocation?: boolean;
  showAccuracyCircle?: boolean;
}

export interface GeolocateEvent {
  readonly target: GeolocateControl;
  readonly type: "geolocate";
  readonly position: GeolocationPosition;
}

export interface GeolocateErrorEvent {
  readonly target: GeolocateControl;
  readonly type: "error";
  readonly error: GeolocationPositionError;
}

export interface GeolocateTrackEvent {
  readonly target: GeolocateControl;
  readonly type: "trackuserlocationstart" | "trackuserlocationend";
}

export interface GeolocateEvents {
  geolocate: GeolocateEvent;
  error: GeolocateErrorEvent;
  trackuserlocationstart: GeolocateTrackEvent;
  trackuserlocationend: GeolocateTrackEvent;
}

export class GeolocateControl extends Emitter<GeolocateEvents> implements Control {
  readonly defaultPosition: ControlPosition = "top-right";
  private readonly options: Required<Omit<GeolocateOptions, "fitBoundsOptions">> & {
    fitBoundsOptions: FitBoundsOptions;
  };
  private map: MapkernMap | null = null;
  private element: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private watch: number | null = null;
  private state: GeolocateState = "off";
  private position: GeolocationPosition | null = null;
  private dot: Marker | null = null;
  private ring: Marker | null = null;
  private ringElement: HTMLElement | null = null;

  constructor(options: GeolocateOptions = {}) {
    super();
    this.options = {
      positionOptions: options.positionOptions ?? { enableHighAccuracy: false, timeout: 6000 },
      fitBoundsOptions: options.fitBoundsOptions ?? { maxZoom: 15 },
      trackUserLocation: options.trackUserLocation === true,
      showUserLocation: options.showUserLocation !== false,
      showAccuracyCircle: options.showAccuracyCircle !== false,
    };
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-geolocate";
    this.button = button(doc, map.text("geolocate"), "mapkern-geolocate-button", icon(doc, TARGET), () =>
      this.trigger(),
    );
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      this.button.disabled = true;
      this.button.title = map.text("locationUnavailable");
      this.button.setAttribute("aria-label", map.text("locationUnavailable"));
    }
    el.appendChild(this.button);
    this.element = el;
    map.on("movestart", this.onMoveStart);
    map.on("zoom", this.onZoom);
    return el;
  }

  onRemove(map: MapkernMap): void {
    map.off("movestart", this.onMoveStart);
    map.off("zoom", this.onZoom);
    this.stopWatch();
    this.dot?.remove();
    this.ring?.remove();
    this.dot = null;
    this.ring = null;
    this.element?.remove();
    this.element = null;
    this.map = null;
  }

  getState(): GeolocateState {
    return this.state;
  }

  trigger(): boolean {
    const map = this.map;
    if (!map || !this.button || this.button.disabled) return false;
    const geo = navigator.geolocation;
    if (!this.options.trackUserLocation) {
      this.setState("waiting");
      geo.getCurrentPosition(
        (p) => {
          this.found(p, true);
          this.setState("off");
        },
        (e) => this.failed(e),
        this.options.positionOptions,
      );
      return true;
    }
    if (this.state === "active" || this.state === "waiting") {
      this.stopWatch();
      this.setState("off");
      this.dot?.remove();
      this.ring?.remove();
      this.emit("trackuserlocationend", { target: this, type: "trackuserlocationend" });
      return true;
    }
    if (this.state === "background" && this.position) {
      this.setState("active");
      this.found(this.position, true);
      this.emit("trackuserlocationstart", { target: this, type: "trackuserlocationstart" });
      return true;
    }
    this.setState("waiting");
    this.emit("trackuserlocationstart", { target: this, type: "trackuserlocationstart" });
    this.watch = geo.watchPosition(
      (p) => {
        const first = this.state === "waiting";
        if (first) this.setState("active");
        this.found(p, this.state === "active");
      },
      (e) => this.failed(e),
      this.options.positionOptions,
    );
    return true;
  }

  private found(p: GeolocationPosition, move: boolean): void {
    const map = this.map;
    if (!map) return;
    this.position = p;
    const lngLat: [number, number] = [p.coords.longitude, p.coords.latitude];
    if (this.options.showUserLocation) {
      if (!this.dot) {
        const el = map.getContainer().ownerDocument.createElement("div");
        el.className = "mapkern-user-location";
        this.dot = new Marker({ element: el, label: map.text("yourLocation") });
      }
      if (this.options.showAccuracyCircle && !this.ring) {
        const ring = map.getContainer().ownerDocument.createElement("div");
        ring.className = "mapkern-user-accuracy";
        this.ringElement = ring;
        this.ring = new Marker({ element: ring, label: map.text("yourLocation") });
      }
      this.ring?.setLngLat(lngLat).addTo(map);
      this.dot.setLngLat(lngLat).addTo(map);
      this.sizeRing();
    }
    if (move) {
      const lat = p.coords.latitude;
      const meters = Math.max(10, p.coords.accuracy || 10);
      const dLat = (meters / 111320) * 1.5;
      const dLng = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
      this.moving = true;
      map.fitBounds(
        [
          [lngLat[0] - dLng, lat - dLat],
          [lngLat[0] + dLng, lat + dLat],
        ],
        { ...this.options.fitBoundsOptions, maxZoom: this.options.fitBoundsOptions.maxZoom ?? 15 },
      );
      this.moving = false;
    }
    this.emit("geolocate", { target: this, type: "geolocate", position: p });
  }

  private moving = false;

  private failed(error: GeolocationPositionError): void {
    if (error.code === error.PERMISSION_DENIED) {
      this.stopWatch();
      if (this.button) this.button.disabled = true;
    }
    this.setState("error");
    this.emit("error", { target: this, type: "error", error });
  }

  private stopWatch(): void {
    if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }

  private setState(state: GeolocateState): void {
    this.state = state;
    const b = this.button;
    if (!b) return;
    for (const s of ["waiting", "active", "background", "error"]) b.classList.toggle(`mapkern-${s}`, s === state);
    b.setAttribute("aria-pressed", String(state === "active" || state === "background"));
  }

  private sizeRing(): void {
    const map = this.map;
    const ring = this.ringElement;
    const p = this.position;
    if (!map || !ring || !p) return;
    const size = Math.max(0, (2 * (p.coords.accuracy || 0)) / metersPerPixel(p.coords.latitude, map.getZoom()));
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;
  }

  private readonly onZoom = (): void => {
    this.sizeRing();
  };

  private readonly onMoveStart = (event: { originalEvent?: Event | undefined }): void => {
    if (this.moving || !event.originalEvent) return;
    if (this.state === "active") this.setState("background");
  };
}

export interface Basemap {
  name: string;
  style: StyleSpec | StyleSpecV8 | string;
}

export interface BasemapOptions {
  basemaps: Basemap[];
  selected?: number;
}

export interface BasemapChangeEvent {
  type: "change";
  index: number;
  basemap: Basemap;
}

export interface BasemapEvents {
  change: BasemapChangeEvent;
}

const LAYERS = ["M12 3l9 5-9 5-9-5z", "M3 12.5l9 5 9-5", "M3 17l9 5 9-5"];

export class BasemapControl extends Emitter<BasemapEvents> implements Control {
  readonly defaultPosition: ControlPosition = "bottom-right";
  private readonly basemaps: Basemap[];
  private index: number;
  private map: MapkernMap | null = null;
  private element: HTMLElement | null = null;
  private toggle: HTMLButtonElement | null = null;
  private items: HTMLButtonElement[] = [];

  constructor(options: BasemapOptions) {
    super();
    const list = options?.basemaps;
    if (!Array.isArray(list) || list.length === 0) {
      throw new MapkernError("invalid-option", "BasemapControl needs a list of basemaps");
    }
    for (const b of list) {
      if (typeof b?.name !== "string" || b.name === "" || b.style === undefined || b.style === null) {
        throw new MapkernError("invalid-option", "Each basemap needs a name and a style");
      }
    }
    this.basemaps = list.map((b) => ({ name: b.name, style: b.style }));
    const selected = options.selected ?? 0;
    this.index = Number.isInteger(selected) && selected >= 0 && selected < list.length ? selected : 0;
  }

  get selected(): number {
    return this.index;
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-basemaps";
    this.toggle = button(doc, map.text("basemaps"), "mapkern-basemaps-button", icon(doc, LAYERS), () =>
      this.open(!el.classList.contains("mapkern-open")),
    );
    this.toggle.setAttribute("aria-haspopup", "menu");
    this.toggle.setAttribute("aria-expanded", "false");
    const menu = doc.createElement("div");
    menu.className = "mapkern-basemaps-menu";
    menu.setAttribute("role", "menu");
    this.items = this.basemaps.map((b, i) => {
      const item = doc.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      item.textContent = b.name;
      item.addEventListener("click", () => this.select(i));
      menu.appendChild(item);
      return item;
    });
    el.append(menu, this.toggle);
    this.element = el;
    this.mark();
    doc.addEventListener("pointerdown", this.outside, true);
    doc.addEventListener("keydown", this.escape);
    return el;
  }

  onRemove(map: MapkernMap): void {
    const doc = map.getContainer().ownerDocument;
    doc.removeEventListener("pointerdown", this.outside, true);
    doc.removeEventListener("keydown", this.escape);
    this.element?.remove();
    this.element = null;
    this.toggle = null;
    this.items = [];
    this.map = null;
  }

  select(index: number): this {
    const basemap = this.basemaps[index];
    if (!Number.isInteger(index) || !basemap) {
      throw new MapkernError("invalid-option", `There is no basemap number ${String(index)}`);
    }
    this.open(false);
    if (index === this.index) return this;
    this.index = index;
    this.mark();
    this.map?.setStyle(basemap.style);
    this.emit("change", { type: "change", index, basemap: { ...basemap } });
    return this;
  }

  private open(open: boolean): void {
    const el = this.element;
    if (!el) return;
    el.classList.toggle("mapkern-open", open);
    this.toggle?.setAttribute("aria-expanded", String(open));
  }

  private mark(): void {
    this.items.forEach((item, i) => {
      item.setAttribute("aria-checked", String(i === this.index));
    });
  }

  private readonly outside = (e: Event) => {
    const el = this.element;
    if (el?.classList.contains("mapkern-open") && !el.contains(e.target as Node)) this.open(false);
  };

  private readonly escape = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.open(false);
  };
}

export type TerrainView = "flat" | "terrain" | "tilted" | "globe";

export interface TerrainControlOptions {
  source: string | DemSourceSpec;
  exaggeration?: number;
  relief?: number;
  pitch?: number;
  views?: readonly TerrainView[];
}

export interface TerrainViewEvent {
  type: "viewchange";
  view: TerrainView;
}

export interface TerrainEvents {
  viewchange: TerrainViewEvent;
}

const TERRAIN_SOURCE = "mapkern-terrain";
const VIEWS: readonly TerrainView[] = ["flat", "terrain", "tilted", "globe"];

function demSource(source: string | DemSourceSpec | undefined): string | DemSourceSpec {
  if (typeof source === "string" && source !== "") return source;
  if (typeof source === "object" && source !== null && source.type === "dem") return { ...source };
  throw new MapkernError("invalid-option", "TerrainControl needs a dem source or the id of one");
}
const VIEW_TEXT: Record<TerrainView, UiText> = {
  flat: "flatView",
  terrain: "terrainView",
  tilted: "tiltedView",
  globe: "globeTerrainView",
};

const GLOBE_ICON = [
  "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z",
  "M12 3c-3.2 3-3.2 15 0 18",
  "M12 3c3.2 3 3.2 15 0 18",
  "M3.5 9h17",
  "M3.5 15h17",
];

export class GlobeControl implements Control {
  readonly defaultPosition: ControlPosition = "bottom-right";
  private map: MapkernMap | null = null;
  private element: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-globe";
    this.button = button(doc, map.text("globeView"), "mapkern-globe-button", icon(doc, GLOBE_ICON), () => {
      const next: Projection = map.getProjection() === "globe" ? "mercator" : "globe";
      map.setProjection(next);
    });
    el.appendChild(this.button);
    this.element = el;
    map.on("projection", this.render);
    this.render();
    return el;
  }

  onRemove(map: MapkernMap): void {
    map.off("projection", this.render);
    this.element?.remove();
    this.element = null;
    this.button = null;
    this.map = null;
  }

  private readonly render = () => {
    const map = this.map;
    const b = this.button;
    if (!map || !b) return;
    const globe = map.getProjection() === "globe";
    const name = map.text(globe ? "mercatorView" : "globeView");
    b.title = name;
    b.setAttribute("aria-label", name);
    b.setAttribute("aria-pressed", globe ? "true" : "false");
    b.classList.toggle("mapkern-active", globe);
  };
}
const TILTED = 5;

export class TerrainControl extends Emitter<TerrainEvents> implements Control {
  readonly defaultPosition: ControlPosition = "bottom-right";
  private source: string | DemSourceSpec;
  private readonly exaggeration: number;
  private readonly relief: number;
  private readonly pitch: number;
  private map: MapkernMap | null = null;
  private element: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private label: HTMLElement | null = null;
  private globeIcon: SVGSVGElement | null = null;
  private readonly views: readonly TerrainView[];
  private wanted = false;
  private target: TerrainView | null = null;
  private shown: TerrainView | null = null;

  constructor(options: TerrainControlOptions) {
    super();
    this.source = demSource(options?.source);
    this.exaggeration = options.exaggeration ?? 1;
    this.relief = options.relief ?? 0.5;
    this.pitch = Math.max(TILTED * 2, options.pitch ?? 60);
    const views = (options.views ?? VIEWS).filter((v, i, all) => VIEWS.includes(v) && all.indexOf(v) === i);
    if (views.length === 0) throw new MapkernError("invalid-option", "TerrainControl needs at least one view");
    this.views = views;
  }

  get view(): TerrainView {
    const map = this.map;
    if (map?.getProjection() === "globe") return "globe";
    if (!map?.getTerrain()) return "flat";
    return map.getPitch() > TILTED ? "tilted" : "terrain";
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    this.wanted = this.wanted || map.getTerrain() !== null || !this.views.includes("flat");
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-terrain";
    const label = doc.createElement("span");
    label.className = "mapkern-terrain-label";
    label.setAttribute("aria-hidden", "true");
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "mapkern-terrain-button";
    b.appendChild(label);
    const globeIcon = icon(doc, GLOBE_ICON);
    b.appendChild(globeIcon);
    this.globeIcon = globeIcon;
    b.addEventListener("click", () => {
      const views = this.views;
      const now = this.target ?? this.view;
      const current = views.indexOf(now === "flat" && !views.includes("flat") ? "terrain" : now);
      this.setView(views[(current + 1) % views.length]!);
    });
    el.appendChild(b);
    this.element = el;
    this.button = b;
    this.label = label;
    map.on("pitch", this.render);
    map.on("projection", this.render);
    map.on("moveend", this.settle);
    map.on("styleload", this.restyle);
    if (this.wanted && !map.getTerrain()) this.apply();
    this.render();
    return el;
  }

  onRemove(map: MapkernMap): void {
    map.off("pitch", this.render);
    map.off("projection", this.render);
    map.off("moveend", this.settle);
    map.off("styleload", this.restyle);
    this.element?.remove();
    this.element = null;
    this.button = null;
    this.label = null;
    this.globeIcon = null;
    this.shown = null;
    this.map = null;
  }

  setView(view: TerrainView): this {
    if (!VIEWS.includes(view)) throw new MapkernError("invalid-option", `Unknown terrain view "${String(view)}"`);
    this.wanted = view !== "flat";
    const map = this.map;
    if (!map) return this;
    if (view === "flat") {
      if (map.getTerrain()) map.setTerrain(null);
    } else {
      this.apply();
    }
    map.setProjection(view === "globe" ? "globe" : "mercator");
    const pitch = view === "tilted" ? Math.min(this.pitch, map.getMaxPitch()) : 0;
    const container = map.getContainer();
    const fit =
      view === "globe"
        ? globeFitZoom(container.clientWidth, container.clientHeight, map.transform.fov, map.getCenter()[1])
        : Number.POSITIVE_INFINITY;
    const zoom = Math.min(map.getZoom(), fit);
    if (Math.abs(map.getPitch() - pitch) > 0.5 || zoom < map.getZoom() - 0.01) {
      this.target = view;
      map.easeTo({ pitch, zoom, duration: zoom < map.getZoom() - 1 ? 1200 : 500 });
    } else {
      this.target = null;
    }
    this.render();
    return this;
  }

  setSource(source: string | DemSourceSpec): this {
    const next = demSource(source);
    const map = this.map;
    if (map) {
      const active = map.getTerrain() !== null;
      if (active) map.setTerrain(null);
      if (typeof this.source !== "string" && map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE);
      this.source = next;
      if (active || this.wanted) this.apply();
      this.render();
    } else {
      this.source = next;
    }
    return this;
  }

  private apply(): boolean {
    const map = this.map;
    if (!map) return false;
    const id = typeof this.source === "string" ? this.source : TERRAIN_SOURCE;
    try {
      if (typeof this.source !== "string" && !map.getSource(id)) map.addSource(id, this.source);
    } catch (error) {
      if (error instanceof MapkernError && error.code === "invalid-style") return false;
      throw error;
    }
    if (map.getSource(id)?.type !== "dem") return false;
    map.setTerrain({ source: id, exaggeration: this.exaggeration, relief: this.relief });
    return true;
  }

  private readonly restyle = () => {
    const map = this.map;
    if (!map) return;
    if (this.wanted && !map.getTerrain()) this.apply();
    else if (!this.wanted && map.getTerrain()) this.wanted = true;
    this.render();
  };

  private readonly settle = () => {
    this.target = null;
    this.render();
  };

  private readonly render = () => {
    const map = this.map;
    const button = this.button;
    const label = this.label;
    if (!map || !button || !label) return;
    const view = this.target ?? this.view;
    if (view === this.shown) return;
    const first = this.shown === null;
    this.shown = view;
    const flatLabel = view === "flat" || (view === "terrain" && !this.views.includes("flat"));
    label.textContent = flatLabel ? "2D" : "3D";
    label.style.display = view === "globe" ? "none" : "";
    if (this.globeIcon) this.globeIcon.style.display = view === "globe" ? "" : "none";
    button.classList.toggle("mapkern-tilted", view === "tilted");
    const name = map.text(flatLabel && view === "terrain" ? "flatView" : VIEW_TEXT[view]);
    button.title = name;
    button.setAttribute("aria-label", name);
    if (!first) this.emit("viewchange", { type: "viewchange", view });
  };
}
