import type { MapkernMap } from "../core/map.ts";
import type { Control, ControlPosition, ScaleUnit } from "../ui/controls.ts";
import {
  AttributionControl as NativeAttributionControl,
  FullscreenControl as NativeFullscreenControl,
  GeolocateControl as NativeGeolocateControl,
  NavigationControl as NativeNavigationControl,
  ScaleControl as NativeScaleControl,
  TerrainControl as NativeTerrainControl,
} from "../ui/controls.ts";
import { LogoControl as NativeLogoControl } from "../ui/logo.ts";
import type { MarkerOptions as NativeMarkerOptions } from "../ui/marker.ts";
import { Marker as NativeMarker } from "../ui/marker.ts";
import type { PopupOptions as NativePopupOptions } from "../ui/popup.ts";
import { Popup as NativePopup } from "../ui/popup.ts";
import type { LngLatLike, PointLike } from "./geo.ts";
import { LngLat, lngLatTuple, Point } from "./geo.ts";

const PREFIXES = ["maplibregl", "mapboxgl"];

const ALIASES: Record<string, string[]> = {
  "mapkern-map": ["map"],
  "mapkern-canvas-container": ["canvas-container"],
  "mapkern-canvas": ["canvas"],
  "mapkern-top-left": ["ctrl-top-left"],
  "mapkern-top-right": ["ctrl-top-right"],
  "mapkern-bottom-left": ["ctrl-bottom-left"],
  "mapkern-bottom-right": ["ctrl-bottom-right"],
  "mapkern-control": ["ctrl", "ctrl-group"],
  "mapkern-zoom-in": ["ctrl-zoom-in"],
  "mapkern-zoom-out": ["ctrl-zoom-out"],
  "mapkern-compass": ["ctrl-compass"],
  "mapkern-geolocate-button": ["ctrl-geolocate"],
  "mapkern-terrain-button": ["ctrl-terrain"],
  "mapkern-attribution": ["ctrl", "ctrl-attrib"],
  "mapkern-scale": ["ctrl", "ctrl-scale"],
  "mapkern-logo": ["ctrl", "ctrl-logo"],
  "mapkern-marker": ["marker"],
  "mapkern-popup": ["popup"],
  "mapkern-popup-tip": ["popup-tip"],
  "mapkern-popup-content": ["popup-content"],
  "mapkern-popup-close": ["popup-close-button"],
  "mapkern-user-location": ["user-location-dot"],
  "mapkern-user-accuracy": ["user-location-accuracy-circle"],
  "mapkern-boxzoom": ["boxzoom"],
};

for (const anchor of [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]) {
  ALIASES[`mapkern-popup-anchor-${anchor}`] = [`popup-anchor-${anchor}`];
}

const added = new WeakMap<Element, Set<string>>();

function aliasElement(element: Element): void {
  const wanted = new Set<string>();
  for (const name of element.classList) {
    const aliases = ALIASES[name];
    if (aliases) for (const alias of aliases) for (const prefix of PREFIXES) wanted.add(`${prefix}-${alias}`);
  }
  const before = added.get(element);
  if (before) for (const name of before) if (!wanted.has(name)) element.classList.remove(name);
  for (const name of wanted) if (!element.classList.contains(name)) element.classList.add(name);
  if (wanted.size > 0) added.set(element, wanted);
  else added.delete(element);
}

function aliasTree(root: Element): void {
  aliasElement(root);
  for (const element of root.querySelectorAll("[class]")) aliasElement(element);
}

export function aliasClasses(container: HTMLElement): () => void {
  aliasTree(container);
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") aliasElement(record.target as Element);
      else for (const node of record.addedNodes) if (node.nodeType === 1) aliasTree(node as Element);
    }
  });
  observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const CSS = `
.maplibregl-ctrl:not(.mapkern-control):not(.mapkern-attribution):not(.mapkern-scale):not(.mapkern-logo),
.mapboxgl-ctrl:not(.mapkern-control):not(.mapkern-attribution):not(.mapkern-scale):not(.mapkern-logo) {
  clear: both;
  pointer-events: auto;
  transform: translate(0, 0);
}
.maplibregl-ctrl-group:not(.mapkern-control), .mapboxgl-ctrl-group:not(.mapkern-control) {
  background: #ffffff;
  border-radius: 4px;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.1);
}
.maplibregl-ctrl-group:not(.mapkern-control) button, .mapboxgl-ctrl-group:not(.mapkern-control) button {
  display: block;
  width: 29px;
  height: 29px;
  padding: 0;
  border: 0;
  box-sizing: border-box;
  background-color: transparent;
  cursor: pointer;
  outline: none;
}
.maplibregl-ctrl-group:not(.mapkern-control) button + button, .mapboxgl-ctrl-group:not(.mapkern-control) button + button {
  border-top: 1px solid #dddddd;
}
.maplibregl-ctrl-group:not(.mapkern-control) button:not(:disabled):hover,
.mapboxgl-ctrl-group:not(.mapkern-control) button:not(:disabled):hover {
  background-color: rgba(0, 0, 0, 0.05);
}
.maplibregl-ctrl-group:not(.mapkern-control) button:focus-visible,
.mapboxgl-ctrl-group:not(.mapkern-control) button:focus-visible {
  box-shadow: 0 0 2px 2px #0096ff;
}
.maplibregl-ctrl-icon, .mapboxgl-ctrl-icon {
  display: block;
  width: 100%;
  height: 100%;
  background-repeat: no-repeat;
  background-position: center;
}
`;

let injected = false;

export function injectCompatStyles(doc: Document): void {
  if (injected || doc.querySelector("style[data-mapkern-compat]")) return;
  injected = true;
  const style = doc.createElement("style");
  style.setAttribute("data-mapkern-compat", "");
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export interface IControl {
  onAdd(map: unknown): HTMLElement;
  onRemove?(map: unknown): void;
  getDefaultPosition?(): ControlPosition;
}

export interface CompatHost {
  readonly native: MapkernMap;
}

export function nativeMap(map: unknown): MapkernMap {
  const host = map as Partial<CompatHost> | null;
  if (host && typeof host === "object" && host.native) return host.native;
  return map as MapkernMap;
}

export function hostControl(control: IControl, facade: unknown): Control {
  const position = typeof control.getDefaultPosition === "function" ? control.getDefaultPosition() : undefined;
  return {
    onAdd: () => control.onAdd(facade),
    onRemove: () => control.onRemove?.(facade),
    ...(position ? { defaultPosition: position } : {}),
  };
}

export function isNativeControl(control: unknown): control is Control {
  return (
    control instanceof NativeNavigationControl ||
    control instanceof NativeAttributionControl ||
    control instanceof NativeScaleControl ||
    control instanceof NativeFullscreenControl ||
    control instanceof NativeGeolocateControl ||
    control instanceof NativeTerrainControl ||
    control instanceof NativeLogoControl ||
    control instanceof GlobeControl
  );
}

type Offset = PointLike | number;

function offsetTuple(offset: Offset | undefined): [number, number] | number | undefined {
  if (offset === undefined || typeof offset === "number") return offset;
  const p = Point.convert(offset);
  return [p.x, p.y];
}

export interface MarkerOptions {
  element?: HTMLElement;
  className?: string;
  offset?: PointLike;
  anchor?: NativeMarkerOptions["anchor"];
  color?: string;
  scale?: number;
  draggable?: boolean;
  clickTolerance?: number;
  rotation?: number;
  rotationAlignment?: "map" | "viewport" | "auto";
  pitchAlignment?: "map" | "viewport" | "auto";
  opacity?: string | number;
  opacityWhenCovered?: string | number;
  occludedOpacity?: number;
  subpixelPositioning?: boolean;
}

function markerOptions(first?: HTMLElement | MarkerOptions, second?: MarkerOptions): NativeMarkerOptions {
  const o: MarkerOptions =
    typeof HTMLElement !== "undefined" && first instanceof HTMLElement
      ? { ...(second ?? {}), element: first }
      : { ...((first as MarkerOptions | undefined) ?? {}) };
  const out: NativeMarkerOptions = {};
  if (o.element) out.element = o.element;
  if (o.className) out.className = o.className;
  if (o.anchor) out.anchor = o.anchor;
  if (o.color) out.color = o.color;
  if (o.scale !== undefined) out.scale = o.scale;
  if (o.draggable !== undefined) out.draggable = o.draggable;
  if (o.clickTolerance !== undefined) out.clickTolerance = o.clickTolerance;
  if (o.rotation !== undefined) out.rotation = o.rotation;
  if (o.rotationAlignment) out.rotationAlignment = o.rotationAlignment;
  if (o.pitchAlignment) out.pitchAlignment = o.pitchAlignment;
  const covered = o.occludedOpacity ?? o.opacityWhenCovered;
  if (covered !== undefined && Number.isFinite(Number(covered))) out.occludedOpacity = Number(covered);
  const offset = offsetTuple(o.offset);
  if (offset !== undefined) out.offset = offset;
  return out;
}

type MarkerBase = Omit<
  NativeMarker,
  | "addTo"
  | "getLngLat"
  | "setLngLat"
  | "getOffset"
  | "setOffset"
  | "getPopup"
  | "remove"
  | "setPopup"
  | "togglePopup"
  | "setDraggable"
  | "setRotation"
  | "setRotationAlignment"
  | "setPitchAlignment"
  | "setOccludedOpacity"
  | "addClassName"
  | "removeClassName"
>;
const MarkerBase = NativeMarker as unknown as new (options: NativeMarkerOptions) => MarkerBase;
const nativeMarker = NativeMarker.prototype;

export class Marker extends MarkerBase {
  private opacityValue: string | undefined;

  constructor(first?: HTMLElement | MarkerOptions, second?: MarkerOptions) {
    super(markerOptions(first, second));
    const o =
      typeof HTMLElement !== "undefined" && first instanceof HTMLElement
        ? second
        : (first as MarkerOptions | undefined);
    if (o?.opacity !== undefined) this.setOpacity(o.opacity);
  }

  addTo(map: unknown): this {
    nativeMarker.addTo.call(this as unknown as NativeMarker, nativeMap(map));
    return this;
  }

  getLngLat(): LngLat {
    const ll = nativeMarker.getLngLat.call(this as unknown as NativeMarker);
    return ll ? new LngLat(ll[0], ll[1]) : (undefined as unknown as LngLat);
  }

  setLngLat(lngLat: LngLatLike): this {
    nativeMarker.setLngLat.call(this as unknown as NativeMarker, lngLatTuple(lngLat));
    return this;
  }

  getOffset(): Point {
    const [x, y] = nativeMarker.getOffset.call(this as unknown as NativeMarker);
    return new Point(x, y);
  }

  setOffset(offset: Offset): this {
    nativeMarker.setOffset.call(this as unknown as NativeMarker, offsetTuple(offset) as [number, number] | number);
    return this;
  }

  setOpacity(opacity?: string | number, opacityWhenCovered?: string | number): this {
    this.opacityValue = opacity === undefined ? undefined : String(opacity);
    this.getElement().style.opacity = this.opacityValue ?? "";
    if (opacityWhenCovered !== undefined && Number.isFinite(Number(opacityWhenCovered))) {
      this.setOccludedOpacity(Number(opacityWhenCovered));
    }
    return this;
  }

  getPopup(): Popup | null {
    return nativeMarker.getPopup.call(this as unknown as NativeMarker) as unknown as Popup | null;
  }

  remove(): this {
    nativeMarker.remove.call(this as unknown as NativeMarker);
    return this;
  }

  setPopup(popup?: Popup | null): this {
    nativeMarker.setPopup.call(this as unknown as NativeMarker, popup as never);
    return this;
  }

  togglePopup(): this {
    nativeMarker.togglePopup.call(this as unknown as NativeMarker);
    return this;
  }

  setDraggable(draggable: boolean): this {
    nativeMarker.setDraggable.call(this as unknown as NativeMarker, draggable);
    return this;
  }

  setRotation(rotation: number): this {
    nativeMarker.setRotation.call(this as unknown as NativeMarker, rotation);
    return this;
  }

  setRotationAlignment(alignment: "map" | "viewport" | "auto"): this {
    nativeMarker.setRotationAlignment.call(this as unknown as NativeMarker, alignment);
    return this;
  }

  setPitchAlignment(alignment: "map" | "viewport" | "auto"): this {
    nativeMarker.setPitchAlignment.call(this as unknown as NativeMarker, alignment);
    return this;
  }

  setOccludedOpacity(opacity: number): this {
    nativeMarker.setOccludedOpacity.call(this as unknown as NativeMarker, opacity);
    return this;
  }

  addClassName(name: string): this {
    nativeMarker.addClassName.call(this as unknown as NativeMarker, name);
    return this;
  }

  removeClassName(name: string): this {
    nativeMarker.removeClassName.call(this as unknown as NativeMarker, name);
    return this;
  }

  setSubpixelPositioning(_value: boolean): this {
    return this;
  }
}

export interface PopupOptions {
  closeButton?: boolean;
  closeOnClick?: boolean;
  closeOnMove?: boolean;
  focusAfterOpen?: boolean;
  anchor?: NativePopupOptions["anchor"];
  offset?: Offset | Partial<Record<NonNullable<NativePopupOptions["anchor"]>, PointLike>>;
  className?: string;
  maxWidth?: string;
  subpixelPositioning?: boolean;
  locationOccludedOpacity?: number | string;
}

function popupOffset(offset: PopupOptions["offset"]): NativePopupOptions["offset"] {
  if (offset === undefined || typeof offset === "number") return offset;
  if (Array.isArray(offset) || offset instanceof Point || ("x" in offset && "y" in offset)) {
    return offsetTuple(offset as PointLike);
  }
  const out: Record<string, [number, number]> = {};
  for (const [anchor, value] of Object.entries(offset)) {
    if (value !== undefined) out[anchor] = offsetTuple(value as PointLike) as [number, number];
  }
  return out as NativePopupOptions["offset"];
}

type PopupBase = Omit<
  NativePopup,
  | "addTo"
  | "getLngLat"
  | "setLngLat"
  | "setOffset"
  | "setHTML"
  | "remove"
  | "trackPointer"
  | "setText"
  | "setDOMContent"
  | "setMaxWidth"
  | "addClassName"
  | "removeClassName"
>;
const PopupBase = NativePopup as unknown as new (options: NativePopupOptions) => PopupBase;
const nativePopup = NativePopup.prototype;

export class Popup extends PopupBase {
  constructor(options: PopupOptions = {}) {
    const native: NativePopupOptions = {};
    if (options.closeButton !== undefined) native.closeButton = options.closeButton;
    if (options.closeOnClick !== undefined) native.closeOnClick = options.closeOnClick;
    if (options.closeOnMove !== undefined) native.closeOnMove = options.closeOnMove;
    if (options.focusAfterOpen !== undefined) native.focusAfterOpen = options.focusAfterOpen;
    if (options.anchor) native.anchor = options.anchor;
    if (options.className) native.className = options.className;
    if (options.maxWidth) native.maxWidth = options.maxWidth;
    const offset = popupOffset(options.offset);
    if (offset !== undefined) native.offset = offset;
    super(native);
  }

  addTo(map: unknown): this {
    nativePopup.addTo.call(this as unknown as NativePopup, nativeMap(map));
    return this;
  }

  getLngLat(): LngLat {
    const ll = nativePopup.getLngLat.call(this as unknown as NativePopup);
    return ll ? new LngLat(ll[0], ll[1]) : (undefined as unknown as LngLat);
  }

  setLngLat(lngLat: LngLatLike): this {
    nativePopup.setLngLat.call(this as unknown as NativePopup, lngLatTuple(lngLat));
    return this;
  }

  setHTML(html: string): this {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc) {
      nativePopup.setHTML.call(this as unknown as NativePopup, html);
      return this;
    }
    const template = doc.createElement("template");
    template.innerHTML = html;
    return this.setDOMContent(template.content);
  }

  remove(): this {
    nativePopup.remove.call(this as unknown as NativePopup);
    return this;
  }

  trackPointer(): this {
    nativePopup.trackPointer.call(this as unknown as NativePopup);
    return this;
  }

  setText(text: string): this {
    nativePopup.setText.call(this as unknown as NativePopup, text);
    return this;
  }

  setDOMContent(node: Node): this {
    nativePopup.setDOMContent.call(this as unknown as NativePopup, node);
    return this;
  }

  setMaxWidth(width: string): this {
    nativePopup.setMaxWidth.call(this as unknown as NativePopup, width);
    return this;
  }

  addClassName(name: string): this {
    nativePopup.addClassName.call(this as unknown as NativePopup, name);
    return this;
  }

  removeClassName(name: string): this {
    nativePopup.removeClassName.call(this as unknown as NativePopup, name);
    return this;
  }

  setOffset(offset?: PopupOptions["offset"]): this {
    nativePopup.setOffset.call(this as unknown as NativePopup, popupOffset(offset));
    return this;
  }

  setSubpixelPositioning(_value: boolean): this {
    return this;
  }
}

export class NavigationControl extends NativeNavigationControl {
  constructor(options: { showCompass?: boolean; showZoom?: boolean; visualizePitch?: boolean } = {}) {
    super({
      ...(options.showCompass !== undefined ? { showCompass: options.showCompass } : {}),
      ...(options.showZoom !== undefined ? { showZoom: options.showZoom } : {}),
    });
  }
}

export class AttributionControl extends NativeAttributionControl {
  constructor(options: { compact?: boolean; customAttribution?: string | string[] } = {}) {
    super(options.customAttribution !== undefined ? { custom: options.customAttribution } : {});
  }
}

function scaleUnit(unit: string | undefined): ScaleUnit | undefined {
  if (unit === "imperial" || unit === "metric" || unit === "both") return unit;
  if (unit === "nautical") return "metric";
  return undefined;
}

export class ScaleControl extends NativeScaleControl {
  constructor(options: { maxWidth?: number; unit?: "imperial" | "metric" | "nautical" | "both" } = {}) {
    const unit = scaleUnit(options.unit);
    super({ ...(options.maxWidth !== undefined ? { maxWidth: options.maxWidth } : {}), ...(unit ? { unit } : {}) });
  }

  override setUnit(unit: ScaleUnit | "nautical"): void {
    super.setUnit(scaleUnit(unit) ?? "metric");
  }
}

export class FullscreenControl extends NativeFullscreenControl {}

export class TerrainControl extends NativeTerrainControl {}

export class LogoControl extends NativeLogoControl {
  constructor(_options: { compact?: boolean } = {}) {
    super();
  }
}

export class GeolocateControl extends NativeGeolocateControl {
  protected override emit(type: never, event: never): void {
    const e = event as { type: string; target: unknown; position?: GeolocationPosition; error?: unknown };
    if (type === ("geolocate" as never) && e.position) {
      super.emit(type, {
        type: "geolocate",
        target: this,
        coords: e.position.coords,
        timestamp: e.position.timestamp,
        position: e.position,
      } as never);
      return;
    }
    if (type === ("error" as never) && e.error && typeof e.error === "object") {
      const error = e.error as { code?: number; message?: string };
      super.emit(type, { ...e, code: error.code, message: error.message, target: this } as never);
      return;
    }
    super.emit(type, event);
  }
}

let globeWarned = false;

export class GlobeControl implements Control {
  readonly defaultPosition: ControlPosition = "top-right";

  onAdd(map: MapkernMap): HTMLElement {
    if (!globeWarned) {
      globeWarned = true;
      console.warn("Mapkern draws Web Mercator only, so the globe control is left out");
    }
    const el = map.getContainer().ownerDocument.createElement("div");
    el.hidden = true;
    return el;
  }

  onRemove(): void {}
}
