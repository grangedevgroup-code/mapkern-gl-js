import { Emitter } from "../core/events.ts";
import type { FitBoundsOptions, MapletMap } from "../core/map.ts";
import { distanceMeters, metersPerPixel } from "../geo/mercator.ts";
import { Marker } from "./marker.ts";
import { safeLinkFragment } from "./sanitize.ts";

export type ControlPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface Control {
  onAdd(map: MapletMap): HTMLElement;
  onRemove(map: MapletMap): void;
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

  onAdd(map: MapletMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    const el = doc.createElement("div");
    el.className = "maplet-control maplet-navigation";
    if (this.options.showZoom) {
      this.zoomIn = button(doc, map.text("zoomIn"), "maplet-zoom-in", icon(doc, ["M12 6v12", "M6 12h12"]), () =>
        map.zoomIn(),
      );
      this.zoomOut = button(doc, map.text("zoomOut"), "maplet-zoom-out", icon(doc, ["M6 12h12"]), () => map.zoomOut());
      el.append(this.zoomIn, this.zoomOut);
    }
    if (this.options.showCompass) {
      this.needle = icon(doc, ["M12 3l4 9h-8z", "M12 21l-4-9h8z"]);
      const north = this.needle.firstElementChild;
      if (north) north.setAttribute("fill", "#d9473f");
      this.compass = button(doc, map.text("resetNorth"), "maplet-compass", this.needle, () =>
        map.easeTo({ bearing: 0, pitch: 0 }),
      );
      el.append(this.compass);
    }
    map.on("move", this.update);
    this.element = el;
    this.refresh(map);
    return el;
  }

  onRemove(map: MapletMap): void {
    map.off("move", this.update);
    this.element?.remove();
    this.element = null;
  }

  private mapRef: MapletMap | null = null;

  private refresh(map?: MapletMap): void {
    if (map) this.mapRef = map;
    const m = this.mapRef;
    if (!m) return;
    const zoom = m.getZoom();
    const atMax = zoom >= m.getMaxZoom() - 1e-9;
    const atMin = zoom <= m.getMinZoom() + 1e-9;
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
  private mapRef: MapletMap | null = null;

  constructor(options: AttributionOptions = {}) {
    this.custom = options.custom === undefined ? [] : Array.isArray(options.custom) ? options.custom : [options.custom];
  }

  onAdd(map: MapletMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    const el = doc.createElement("div");
    el.className = "maplet-attribution";
    el.setAttribute("role", "contentinfo");
    this.element = el;
    this.mapRef = map;
    map.on("sourcedata", this.update);
    map.on("styleload", this.update);
    this.refresh();
    return el;
  }

  onRemove(map: MapletMap): void {
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

export interface ScaleOptions {
  maxWidth?: number;
  unit?: "metric" | "imperial";
}

export class ScaleControl implements Control {
  readonly defaultPosition: ControlPosition = "bottom-left";
  private readonly maxWidth: number;
  private unit: "metric" | "imperial";
  private element: HTMLElement | null = null;
  private mapRef: MapletMap | null = null;
  private readonly update = () => this.refresh();

  constructor(options: ScaleOptions = {}) {
    this.maxWidth = options.maxWidth ?? 100;
    this.unit = options.unit ?? "metric";
  }

  setUnit(unit: "metric" | "imperial"): void {
    this.unit = unit;
    this.refresh();
  }

  onAdd(map: MapletMap): HTMLElement {
    const el = map.getContainer().ownerDocument.createElement("div");
    el.className = "maplet-scale";
    this.element = el;
    this.mapRef = map;
    map.on("move", this.update);
    this.refresh();
    return el;
  }

  onRemove(map: MapletMap): void {
    map.off("move", this.update);
    this.element?.remove();
    this.element = null;
    this.mapRef = null;
  }

  private refresh(): void {
    const el = this.element;
    const map = this.mapRef;
    if (!el || !map) return;
    const h = map.transform.height / 2;
    const a = map.unproject([0, h]);
    const b = map.unproject([this.maxWidth, h]);
    let label = "";
    let width = "";
    if (a && b) {
      const meters = distanceMeters(a, b);
      let span: number;
      let unit: string;
      if (this.unit === "imperial") {
        const feet = meters * 3.28084;
        if (feet > 5280) {
          span = feet / 5280;
          unit = "mi";
        } else {
          span = feet;
          unit = "ft";
        }
      } else if (meters >= 1000) {
        span = meters / 1000;
        unit = "km";
      } else {
        span = meters;
        unit = "m";
      }
      const value = niceNumber(span);
      label = `${value} ${unit}`;
      width = `${Math.round((this.maxWidth * value) / span)}px`;
    }
    const visibility = label ? "visible" : "hidden";
    if (visibility !== this.lastVisibility) {
      this.lastVisibility = visibility;
      el.style.visibility = visibility;
    }
    if (!label) return;
    if (width !== this.lastWidth) {
      this.lastWidth = width;
      el.style.width = width;
    }
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      el.textContent = label;
    }
  }

  private lastLabel = "";
  private lastWidth = "";
  private lastVisibility = "";
}

function niceNumber(n: number): number {
  if (!(n > 0)) return 0;
  const pow = 10 ** Math.floor(Math.log10(n));
  const d = n / pow;
  const nice = d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  return nice * pow;
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
  private map: MapletMap | null = null;
  private target: FullscreenElement | null = null;
  private element: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private pseudo = false;
  private active = false;

  constructor(options: FullscreenOptions = {}) {
    super();
    this.options = { ...options };
  }

  onAdd(map: MapletMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    this.target = (this.options.container ?? map.getContainer()) as FullscreenElement;
    const el = doc.createElement("div");
    el.className = "maplet-control maplet-fullscreen";
    this.button = button(doc, map.text("fullscreen"), "maplet-fullscreen-button", icon(doc, EXPAND), () =>
      this.toggle(),
    );
    el.appendChild(this.button);
    this.element = el;
    doc.addEventListener("fullscreenchange", this.onChange);
    doc.addEventListener("webkitfullscreenchange", this.onChange);
    return el;
  }

  onRemove(map: MapletMap): void {
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
    this.target?.classList.toggle("maplet-pseudo-fullscreen", on);
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
  private map: MapletMap | null = null;
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

  onAdd(map: MapletMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    const el = doc.createElement("div");
    el.className = "maplet-control maplet-geolocate";
    this.button = button(doc, map.text("geolocate"), "maplet-geolocate-button", icon(doc, TARGET), () =>
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

  onRemove(map: MapletMap): void {
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
        el.className = "maplet-user-location";
        this.dot = new Marker({ element: el, label: map.text("yourLocation") });
      }
      if (this.options.showAccuracyCircle && !this.ring) {
        const ring = map.getContainer().ownerDocument.createElement("div");
        ring.className = "maplet-user-accuracy";
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
    for (const s of ["waiting", "active", "background", "error"]) b.classList.toggle(`maplet-${s}`, s === state);
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
