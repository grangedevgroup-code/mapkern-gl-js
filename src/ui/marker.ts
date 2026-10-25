import { Emitter } from "../core/events.ts";
import type { MapletMap } from "../core/map.ts";
import type { LngLat, LngLatLike } from "../geo/mercator.ts";
import { toLngLat } from "../geo/mercator.ts";
import type { Anchor, AnchorOffsets, Offset, OffsetLike } from "./anchor.ts";
import { anchorShift, bodyOffsets, isAnchor, toOffset } from "./anchor.ts";
import type { Popup } from "./popup.ts";

export type Alignment = "map" | "viewport" | "auto";

export interface MarkerOptions {
  element?: HTMLElement;
  anchor?: Anchor;
  offset?: OffsetLike;
  color?: string;
  scale?: number;
  draggable?: boolean;
  clickTolerance?: number;
  rotation?: number;
  rotationAlignment?: Alignment;
  pitchAlignment?: Alignment;
  occludedOpacity?: number;
  className?: string;
  label?: string;
}

export interface MarkerEvent {
  readonly target: Marker;
  readonly type: "dragstart" | "drag" | "dragend";
}

export interface MarkerEvents {
  dragstart: MarkerEvent;
  drag: MarkerEvent;
  dragend: MarkerEvent;
}

interface Drag {
  pointer: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  active: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const PIN_WIDTH = 28;
const PIN_HEIGHT = 40;
const PIN_PATH =
  "M14 1.5C7.1 1.5 1.5 7.1 1.5 14c0 8.5 8 16.5 12.5 25 4.5-8.5 12.5-16.5 12.5-25 0-6.9-5.6-12.5-12.5-12.5z";

export class Marker extends Emitter<MarkerEvents> {
  private readonly element: HTMLElement;
  private readonly pin: boolean;
  private readonly scale: number;
  private readonly clickTolerance: number;
  private readonly label: string | undefined;
  private readonly owned = new Set<string>();
  private anchor: Anchor;
  private offset: Offset;
  private lngLat: LngLat | null = null;
  private map: MapletMap | null = null;
  private popup: Popup | null = null;
  private draggable: boolean;
  private rotation: number;
  private rotationAlignment: Alignment;
  private pitchAlignment: Alignment;
  private occludedOpacity: number;
  private drag: Drag | null = null;
  private suppressClick = false;
  private lastTransform = "";
  private lastOpacity = "";
  private lastVisibility = "";

  constructor(options: MarkerOptions = {}) {
    super();
    if (options.anchor !== undefined && !isAnchor(options.anchor)) {
      throw new TypeError(`Unknown marker anchor "${String(options.anchor)}"`);
    }
    this.scale = positive(options.scale, "scale", 1);
    this.clickTolerance = positive(options.clickTolerance, "clickTolerance", 3);
    this.pin = options.element === undefined;
    this.element = options.element ?? pinElement(document, options.color ?? "#2f6fdb", this.scale);
    this.anchor = options.anchor ?? (this.pin ? "bottom" : "center");
    this.offset = options.offset === undefined ? [0, 0] : toOffset(options.offset, "offset");
    this.draggable = options.draggable === true;
    this.rotation = finite(options.rotation, "rotation", 0);
    this.rotationAlignment = options.rotationAlignment ?? "auto";
    this.pitchAlignment = options.pitchAlignment ?? "auto";
    this.occludedOpacity = Math.min(1, Math.max(0, finite(options.occludedOpacity, "occludedOpacity", 0.2)));
    this.label = options.label;
    this.element.classList.add("maplet-marker");
    for (const name of (options.className ?? "").split(/\s+/).filter(Boolean)) this.element.classList.add(name);
    this.element.classList.toggle("maplet-marker-draggable", this.draggable);
    this.applyOrigin();
    this.element.addEventListener("pointerdown", this.onPointerDown);
    this.element.addEventListener("click", this.onClick);
    this.element.addEventListener("keydown", this.onKeyDown);
  }

  addTo(map: MapletMap): this {
    if (this.map === map) return this;
    this.remove();
    this.map = map;
    map.getCanvasContainer().appendChild(this.element);
    map.on("render", this.update);
    map.on("resize", this.update);
    map.on("remove", this.onMapRemove);
    this.refreshAccessibility();
    this.update();
    return this;
  }

  remove(): this {
    const map = this.map;
    if (!map) return this;
    map.off("render", this.update);
    map.off("resize", this.update);
    map.off("remove", this.onMapRemove);
    this.endDrag(null);
    this.popup?.remove();
    this.element.remove();
    this.map = null;
    this.lastTransform = "";
    this.lastOpacity = "";
    this.lastVisibility = "";
    return this;
  }

  getLngLat(): LngLat | null {
    return this.lngLat ? [this.lngLat[0], this.lngLat[1]] : null;
  }

  setLngLat(lngLat: LngLatLike): this {
    this.lngLat = toLngLat(lngLat);
    if (this.popup?.isOpen()) this.popup.setLngLat(this.lngLat);
    this.update();
    return this;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  getPopup(): Popup | null {
    return this.popup;
  }

  setPopup(popup?: Popup | null): this {
    if (this.popup) {
      this.popup.off("open", this.onPopupChange);
      this.popup.off("close", this.onPopupChange);
      this.popup.remove();
      this.popup.attachedOffsets(null, null);
    }
    this.popup = popup ?? null;
    if (this.popup) {
      this.popup.on("open", this.onPopupChange);
      this.popup.on("close", this.onPopupChange);
    }
    this.refreshAccessibility();
    return this;
  }

  togglePopup(): this {
    const popup = this.popup;
    const map = this.map;
    if (!popup || !map) return this;
    if (popup.isOpen()) {
      popup.remove();
      return this;
    }
    popup.attachedOffsets(this.popupOffsets(), this.element);
    if (this.lngLat) popup.setLngLat(this.lngLat);
    popup.addTo(map);
    return this;
  }

  getOffset(): [number, number] {
    return [this.offset[0], this.offset[1]];
  }

  setOffset(offset: OffsetLike): this {
    this.offset = toOffset(offset, "offset");
    this.update();
    return this;
  }

  isDraggable(): boolean {
    return this.draggable;
  }

  setDraggable(draggable: boolean): this {
    this.draggable = draggable === true;
    this.element.classList.toggle("maplet-marker-draggable", this.draggable);
    if (!this.draggable) this.endDrag(null);
    return this;
  }

  getRotation(): number {
    return this.rotation;
  }

  setRotation(rotation: number): this {
    this.rotation = finite(rotation, "rotation", 0);
    this.update();
    return this;
  }

  getRotationAlignment(): Alignment {
    return this.rotationAlignment;
  }

  setRotationAlignment(alignment: Alignment): this {
    this.rotationAlignment = alignment;
    this.update();
    return this;
  }

  getPitchAlignment(): Alignment {
    return this.pitchAlignment;
  }

  setPitchAlignment(alignment: Alignment): this {
    this.pitchAlignment = alignment;
    this.update();
    return this;
  }

  getOccludedOpacity(): number {
    return this.occludedOpacity;
  }

  setOccludedOpacity(opacity: number): this {
    this.occludedOpacity = Math.min(1, Math.max(0, finite(opacity, "occludedOpacity", 0.2)));
    this.update();
    return this;
  }

  addClassName(name: string): this {
    this.element.classList.add(name);
    return this;
  }

  removeClassName(name: string): this {
    this.element.classList.remove(name);
    return this;
  }

  toggleClassName(name: string): boolean {
    return this.element.classList.toggle(name);
  }

  private readonly update = (): void => {
    const map = this.map;
    if (!map) return;
    const el = this.element;
    if (!this.lngLat) {
      this.setStyle("visibility", "hidden");
      return;
    }
    const p = map.screenPosition(this.lngLat);
    this.setStyle("visibility", p.visible ? "" : "hidden");
    if (!p.visible) return;
    this.setStyle("opacity", p.occluded ? String(this.occludedOpacity) : "");
    const ratio = map.getPixelRatio();
    const x = Math.round((p.x + this.offset[0]) * ratio) / ratio;
    const y = Math.round((p.y + this.offset[1]) * ratio) / ratio;
    const [sx, sy] = anchorShift(this.anchor);
    const turn = this.rotationAlignment === "map" ? this.rotation - map.getBearing() : this.rotation;
    const flat = (this.pitchAlignment === "auto" ? this.rotationAlignment : this.pitchAlignment) === "map";
    const tilt = flat ? ` rotateX(${map.getPitch()}deg)` : "";
    const spin = turn !== 0 ? ` rotateZ(${turn}deg)` : "";
    const transform = `translate(${x}px, ${y}px) translate(${sx * 100}%, ${sy * 100}%)${tilt}${spin}`;
    if (transform !== this.lastTransform) {
      this.lastTransform = transform;
      el.style.transform = transform;
    }
  };

  private setStyle(name: "opacity" | "visibility", value: string): void {
    if (name === "opacity") {
      if (value === this.lastOpacity) return;
      this.lastOpacity = value;
    } else {
      if (value === this.lastVisibility) return;
      this.lastVisibility = value;
    }
    this.element.style[name] = value;
  }

  private applyOrigin(): void {
    const [sx, sy] = anchorShift(this.anchor);
    this.element.style.transformOrigin = `${-sx * 100}% ${-sy * 100}%`;
  }

  private popupOffsets(): AnchorOffsets {
    const [sx, sy] = anchorShift(this.anchor);
    const [ox, oy] = this.offset;
    if (this.pin) {
      const w = PIN_WIDTH * this.scale;
      const h = PIN_HEIGHT * this.scale;
      const r = 12.5 * this.scale;
      return bodyOffsets({ cx: sx * w + w / 2 + ox, cy: sy * h + 14 * this.scale + oy, rx: r, ry: r, round: true });
    }
    const w = this.element.offsetWidth;
    const h = this.element.offsetHeight;
    return bodyOffsets({ cx: sx * w + w / 2 + ox, cy: sy * h + h / 2 + oy, rx: w / 2, ry: h / 2, round: false });
  }

  private refreshAccessibility(): void {
    const el = this.element;
    const label = this.label ?? this.map?.text("marker");
    if (label !== undefined) this.ownAttribute("aria-label", label);
    if (this.popup) {
      this.ownAttribute("role", "button");
      this.ownAttribute("tabindex", "0");
      this.ownAttribute("aria-expanded", String(this.popup.isOpen()));
    } else {
      for (const name of ["role", "tabindex", "aria-expanded"]) {
        if (this.owned.delete(name)) el.removeAttribute(name);
      }
    }
  }

  private ownAttribute(name: string, value: string): void {
    const el = this.element;
    if (!this.owned.has(name) && el.hasAttribute(name)) return;
    this.owned.add(name);
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  private point(event: PointerEvent): [number, number] {
    const container = this.map?.getCanvasContainer();
    const rect = container?.getBoundingClientRect();
    return rect ? [event.clientX - rect.left, event.clientY - rect.top] : [event.clientX, event.clientY];
  }

  private endDrag(event: PointerEvent | null): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const el = this.element;
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerUp);
    el.removeEventListener("lostpointercapture", this.onPointerUp);
    try {
      if (el.hasPointerCapture(drag.pointer)) el.releasePointerCapture(drag.pointer);
    } catch {}
    if (!drag.active) return;
    el.classList.remove("maplet-marker-dragging");
    this.suppressClick = event !== null && event.type === "pointerup";
    this.emit("dragend", { target: this, type: "dragend" });
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.suppressClick = false;
    const map = this.map;
    if (!this.draggable || !map || !this.lngLat) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    const [x, y] = this.point(event);
    const p = map.screenPosition(this.lngLat);
    this.drag = { pointer: event.pointerId, startX: x, startY: y, dx: x - p.x, dy: y - p.y, active: false };
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {}
    const el = this.element;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("lostpointercapture", this.onPointerUp);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    const map = this.map;
    if (!drag || !map || event.pointerId !== drag.pointer) return;
    const [x, y] = this.point(event);
    if (!drag.active) {
      if (Math.hypot(x - drag.startX, y - drag.startY) < this.clickTolerance) return;
      drag.active = true;
      this.element.classList.add("maplet-marker-dragging");
      this.emit("dragstart", { target: this, type: "dragstart" });
    }
    const lngLat = map.unproject([x - drag.dx, y - drag.dy]);
    if (!lngLat) return;
    this.lngLat = lngLat;
    if (this.popup?.isOpen()) this.popup.setLngLat(lngLat);
    this.update();
    this.emit("drag", { target: this, type: "drag" });
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drag && event.pointerId === this.drag.pointer) this.endDrag(event);
  };

  private readonly onClick = (): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.togglePopup();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.popup || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    this.togglePopup();
  };

  private readonly onPopupChange = (): void => {
    this.refreshAccessibility();
  };

  private readonly onMapRemove = (): void => {
    this.remove();
  };
}

function pinElement(doc: Document, color: string, scale: number): HTMLElement {
  const el = doc.createElement("div");
  el.className = "maplet-marker-pin";
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${PIN_WIDTH} ${PIN_HEIGHT}`);
  svg.setAttribute("width", String(PIN_WIDTH * scale));
  svg.setAttribute("height", String(PIN_HEIGHT * scale));
  svg.setAttribute("aria-hidden", "true");
  const body = doc.createElementNS(SVG_NS, "path");
  body.setAttribute("d", PIN_PATH);
  body.setAttribute("fill", color);
  body.setAttribute("stroke", "rgba(16, 25, 29, 0.25)");
  body.setAttribute("stroke-width", "1");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", "14");
  dot.setAttribute("cy", "14");
  dot.setAttribute("r", "5");
  dot.setAttribute("fill", "#ffffff");
  svg.append(body, dot);
  el.appendChild(svg);
  return el;
}

function finite(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}

function positive(value: unknown, name: string, fallback: number): number {
  const n = finite(value, name, fallback);
  if (n <= 0) throw new TypeError(`${name} must be greater than 0`);
  return n;
}
