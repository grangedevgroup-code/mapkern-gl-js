import type { MapletMap } from "../core/map.ts";
import { distanceMeters } from "../geo/mercator.ts";
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
      value = niceNumber(span);
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
