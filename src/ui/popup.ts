import { MapkernError } from "../core/errors.ts";
import { Emitter } from "../core/events.ts";
import type { MapkernMap, MapPointerEvent } from "../core/map.ts";
import type { LngLat, LngLatLike } from "../geo/mercator.ts";
import { toLngLat } from "../geo/mercator.ts";
import type { Anchor, AnchorOffsets, OffsetLike } from "./anchor.ts";
import { anchorOffsets, anchorShift, chooseAnchor, isAnchor } from "./anchor.ts";
import { safeHtmlFragment } from "./sanitize.ts";

export interface PopupOptions {
  closeButton?: boolean;
  closeOnClick?: boolean;
  closeOnMove?: boolean;
  closeOnEscape?: boolean;
  focusAfterOpen?: boolean;
  anchor?: Anchor;
  offset?: OffsetLike | Partial<Record<Anchor, OffsetLike>>;
  className?: string;
  maxWidth?: string;
  label?: string;
}

export interface PopupEvent {
  readonly target: Popup;
  readonly type: "open" | "close";
}

export interface PopupEvents {
  open: PopupEvent;
  close: PopupEvent;
}

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])";

export class Popup extends Emitter<PopupEvents> {
  private readonly options: PopupOptions;
  private map: MapkernMap | null = null;
  private lngLat: LngLat | null = null;
  private pointer: [number, number] | null = null;
  private tracking = false;
  private content: Node | null = null;
  private container: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private offsets: AnchorOffsets;
  private fallbackOffsets: AnchorOffsets | null = null;
  private classes: Set<string>;
  private maxWidth: string;
  private anchorShown: Anchor | null = null;
  private lastTransform = "";
  private owner: HTMLElement | null = null;

  constructor(options: PopupOptions = {}) {
    super();
    if (options.anchor !== undefined && !isAnchor(options.anchor)) {
      throw new MapkernError("invalid-option", `Unknown popup anchor "${String(options.anchor)}"`);
    }
    this.options = { ...options };
    this.offsets = anchorOffsets(options.offset);
    this.classes = new Set((options.className ?? "").split(/\s+/).filter(Boolean));
    this.maxWidth = options.maxWidth ?? "240px";
  }

  addTo(map: MapkernMap): this {
    if (this.map === map) return this;
    if (this.map) this.remove();
    this.map = map;
    const doc = map.getContainer().ownerDocument;
    const container = doc.createElement("div");
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-label", this.options.label ?? map.text("popup"));
    const tip = doc.createElement("div");
    tip.className = "mapkern-popup-tip";
    const body = doc.createElement("div");
    body.className = "mapkern-popup-content";
    container.append(tip, body);
    container.addEventListener("keydown", this.onKeyDown);
    this.container = container;
    this.body = body;
    this.renderContent();
    this.applyClasses();
    map.getContainer().appendChild(container);
    map.on("render", this.update);
    map.on("resize", this.update);
    map.on("remove", this.onMapRemove);
    if (this.options.closeOnClick !== false) map.on("click", this.onMapClick);
    if (this.options.closeOnMove === true) map.on("movestart", this.onMapMove);
    if (this.tracking) this.listenPointer(map, true);
    this.update();
    if (this.options.focusAfterOpen !== false) this.focusFirst();
    this.emit("open", { target: this, type: "open" });
    return this;
  }

  remove(): this {
    const map = this.map;
    if (!map) return this;
    map.off("render", this.update);
    map.off("resize", this.update);
    map.off("remove", this.onMapRemove);
    map.off("click", this.onMapClick);
    map.off("movestart", this.onMapMove);
    this.listenPointer(map, false);
    const hadFocus = this.container?.contains(this.container.ownerDocument.activeElement) ?? false;
    this.container?.removeEventListener("keydown", this.onKeyDown);
    this.container?.remove();
    this.container = null;
    this.body = null;
    this.anchorShown = null;
    this.lastTransform = "";
    this.map = null;
    if (hadFocus) this.owner?.focus({ preventScroll: true });
    this.emit("close", { target: this, type: "close" });
    return this;
  }

  isOpen(): boolean {
    return this.map !== null;
  }

  getLngLat(): LngLat | null {
    return this.lngLat ? [this.lngLat[0], this.lngLat[1]] : null;
  }

  setLngLat(lngLat: LngLatLike): this {
    this.lngLat = toLngLat(lngLat);
    this.pointer = null;
    if (this.tracking && this.map) this.listenPointer(this.map, false);
    this.tracking = false;
    this.update();
    return this;
  }

  trackPointer(): this {
    this.tracking = true;
    this.lngLat = null;
    if (this.map) this.listenPointer(this.map, true);
    this.update();
    return this;
  }

  setText(text: string): this {
    const doc = this.map?.getContainer().ownerDocument ?? document;
    return this.setDOMContent(doc.createTextNode(String(text)));
  }

  setHTML(html: string): this {
    const doc = this.map?.getContainer().ownerDocument ?? document;
    return this.setDOMContent(safeHtmlFragment(doc, String(html)));
  }

  setDOMContent(node: Node): this {
    this.content = node;
    this.renderContent();
    this.update();
    return this;
  }

  getElement(): HTMLElement | null {
    return this.container;
  }

  getMaxWidth(): string {
    return this.maxWidth;
  }

  setMaxWidth(width: string): this {
    this.maxWidth = width;
    if (this.body) this.body.style.maxWidth = width;
    this.update();
    return this;
  }

  setOffset(offset?: OffsetLike | Partial<Record<Anchor, OffsetLike>>): this {
    this.offsets = anchorOffsets(offset);
    if (offset === undefined) delete this.options.offset;
    else this.options.offset = offset;
    this.update();
    return this;
  }

  addClassName(name: string): this {
    this.classes.add(name);
    this.applyClasses();
    return this;
  }

  removeClassName(name: string): this {
    this.classes.delete(name);
    this.applyClasses();
    return this;
  }

  toggleClassName(name: string): boolean {
    const on = !this.classes.has(name);
    if (on) this.classes.add(name);
    else this.classes.delete(name);
    this.applyClasses();
    return on;
  }

  attachedOffsets(offsets: AnchorOffsets | null, owner: HTMLElement | null): void {
    this.fallbackOffsets = offsets;
    this.owner = owner;
  }

  private currentOffsets(): AnchorOffsets {
    return this.options.offset === undefined && this.fallbackOffsets ? this.fallbackOffsets : this.offsets;
  }

  private renderContent(): void {
    const body = this.body;
    if (!body || !this.map) return;
    body.replaceChildren();
    body.style.maxWidth = this.maxWidth;
    if (this.content) body.appendChild(this.content.cloneNode(true));
    body.classList.toggle("mapkern-popup-closable", this.options.closeButton !== false);
    if (this.options.closeButton !== false) {
      const doc = body.ownerDocument;
      const close = doc.createElement("button");
      close.type = "button";
      close.className = "mapkern-popup-close";
      close.setAttribute("aria-label", this.map.text("closePopup"));
      close.textContent = "×";
      close.addEventListener("click", () => this.remove());
      body.appendChild(close);
    }
  }

  private applyClasses(): void {
    const container = this.container;
    if (!container) return;
    const anchor = this.anchorShown ? ` mapkern-popup-anchor-${this.anchorShown}` : "";
    const extra = this.classes.size > 0 ? ` ${[...this.classes].join(" ")}` : "";
    container.className = `mapkern-popup${anchor}${extra}`;
  }

  private readonly update = (): void => {
    const map = this.map;
    const container = this.container;
    if (!map || !container) return;
    let x: number;
    let y: number;
    let visible = true;
    if (this.lngLat) {
      const p = map.screenPosition(this.lngLat);
      x = p.x;
      y = p.y;
      visible = p.visible;
    } else if (this.pointer) {
      [x, y] = this.pointer;
    } else {
      visible = false;
      x = 0;
      y = 0;
    }
    const visibility = visible ? "" : "hidden";
    if (container.style.visibility !== visibility) container.style.visibility = visibility;
    if (!visible) return;
    const offsets = this.currentOffsets();
    const anchor =
      this.options.anchor ??
      chooseAnchor(
        [x, y],
        [container.offsetWidth, container.offsetHeight],
        [map.transform.width, map.transform.height],
        offsets,
      );
    if (anchor !== this.anchorShown) {
      this.anchorShown = anchor;
      this.applyClasses();
    }
    const [ox, oy] = offsets[anchor];
    const [sx, sy] = anchorShift(anchor);
    const ratio = map.getPixelRatio();
    const px = Math.round((x + ox) * ratio) / ratio;
    const py = Math.round((y + oy) * ratio) / ratio;
    const transform = `translate(${px}px, ${py}px) translate(${sx * 100}%, ${sy * 100}%)`;
    if (transform !== this.lastTransform) {
      this.lastTransform = transform;
      container.style.transform = transform;
    }
  };

  private listenPointer(map: MapkernMap, on: boolean): void {
    if (on) {
      map.on("mousemove", this.onPointerMove);
      map.on("mouseout", this.onPointerOut);
    } else {
      map.off("mousemove", this.onPointerMove);
      map.off("mouseout", this.onPointerOut);
    }
  }

  private focusFirst(): void {
    const target = this.body?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
  }

  private readonly onPointerMove = (event: MapPointerEvent): void => {
    this.pointer = [event.point.x, event.point.y];
    this.update();
  };

  private readonly onPointerOut = (): void => {
    this.pointer = null;
    this.update();
  };

  private readonly onMapClick = (event: MapPointerEvent): void => {
    const target = event.originalEvent.target;
    if (this.owner && target instanceof Node && this.owner.contains(target)) return;
    this.remove();
  };

  private readonly onMapMove = (): void => {
    this.remove();
  };

  private readonly onMapRemove = (): void => {
    this.remove();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.options.closeOnEscape !== false) {
      event.stopPropagation();
      this.remove();
    }
  };
}
