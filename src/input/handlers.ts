import type { Transform } from "../camera/transform.ts";

type Point3 = [number, number, number];

export interface InputOptions {
  dragPan: boolean;
  dragRotate: boolean;
  scrollZoom: boolean;
  doubleClickZoom: boolean;
  touchZoomRotate: boolean;
  touchPitch: boolean;
  touchRotate: boolean;
  keyboard: boolean;
  clickTolerance: number;
}

export type GestureKind = "pan" | "zoom" | "rotate" | "pitch";

export interface InputHost {
  readonly transform: Transform;
  readonly element: HTMLElement;
  anchor(px: number, py: number): Point3 | null;
  reducedMotion(): boolean;
  interrupt(): void;
  changed(): void;
  gesture(active: boolean): void;
  rotateEnded(): void;
  ease(
    target: { zoom?: number; bearing?: number; pitch?: number; panBy?: [number, number] },
    around: [number, number] | null,
    duration: number,
  ): void;
  pointerEvent(
    type: "click" | "dblclick" | "contextmenu" | "mousemove" | "mousedown" | "mouseup" | "mouseout",
    event: MouseEvent,
    point: [number, number],
  ): Promise<boolean> | null;
}

interface Hold {
  waiting: boolean;
  prevented: boolean;
  moved: boolean;
}

interface Pointer {
  id: number;
  type: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
}

type Mode =
  | { kind: "idle" }
  | { kind: "press"; pointer: number; rotate: boolean; hold: Hold }
  | { kind: "pan"; pointer: number; anchor: Point3 }
  | { kind: "rotate"; pointer: number; lastX: number; lastY: number; moved: boolean }
  | {
      kind: "touch2";
      ids: [number, number];
      start: TwoFinger;
      zoom0: number;
      bearing0: number;
      pitch0: number;
      anchor: Point3 | null;
      sub: "undecided" | "pinch" | "pitch";
      rotating: boolean;
    };

interface TwoFinger {
  dist: number;
  angle: number;
  midX: number;
  midY: number;
  y0: number;
  y1: number;
}

interface Inertia {
  start: number;
  duration: number;
  from: [number, number];
  offset: [number, number];
  anchor: Point3;
}

interface WheelZoom {
  target: number;
  anchorScreen: [number, number];
  anchorWorld: Point3 | null;
  last: number;
}

const MAX_INERTIA_SPEED = 1.4;
const INERTIA_DECELERATION = 0.0025;
const DOUBLE_TAP_MS = 300;

export class InputHandlers {
  options: InputOptions;
  private readonly host: InputHost;
  private readonly pointers = new Map<number, Pointer>();
  private mode: Mode = { kind: "idle" };
  private samples: { t: number; x: number; y: number }[] = [];
  private inertia: Inertia | null = null;
  private wheel: WheelZoom | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private suppressContextMenu = false;
  private destroyed = false;
  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];

  constructor(host: InputHost, options: InputOptions) {
    this.host = host;
    this.options = options;
    const el = host.element;
    this.listen(el, "pointerdown", (e) => this.onPointerDown(e as PointerEvent));
    this.listen(el, "pointermove", (e) => this.onPointerMove(e as PointerEvent));
    this.listen(el, "pointerup", (e) => this.onPointerUp(e as PointerEvent));
    this.listen(el, "pointercancel", (e) => this.onPointerUp(e as PointerEvent, true));
    this.listen(el, "lostpointercapture", (e) => this.onPointerUp(e as PointerEvent, true));
    this.listen(el, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(el, "dblclick", (e) => this.onDoubleClick(e as MouseEvent));
    this.listen(el, "contextmenu", (e) => this.onContextMenu(e as MouseEvent));
    this.listen(el, "keydown", (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(el, "mouseout", (e) => {
      const related = (e as MouseEvent).relatedTarget;
      if (related && el.contains(related as Node)) return;
      this.host.pointerEvent("mouseout", e as MouseEvent, this.point(e as MouseEvent));
    });
    this.listen(window, "blur", () => this.cancel());
  }

  get active(): boolean {
    return this.mode.kind !== "idle" && this.mode.kind !== "press";
  }

  get animating(): boolean {
    return this.inertia !== null || this.wheel !== null;
  }

  get wheelTarget(): { zoom: number; point: [number, number] } | null {
    return this.wheel ? { zoom: this.wheel.target, point: this.wheel.anchorScreen } : null;
  }

  step(now: number): boolean {
    let busy = false;
    if (this.inertia) {
      const i = this.inertia;
      const t = Math.min(1, (now - i.start) / i.duration);
      const k = 1 - (1 - t) * (1 - t);
      this.host.transform.setLocationAtPoint(
        i.anchor,
        i.from[0] + i.offset[0] * k,
        i.from[1] + i.offset[1] * k,
        i.anchor[2],
      );
      this.host.changed();
      if (t >= 1) this.inertia = null;
      else busy = true;
    }
    if (this.wheel) {
      const w = this.wheel;
      const transform = this.host.transform;
      const dt = Math.min(100, Math.max(1, now - w.last));
      w.last = now;
      const current = transform.zoom;
      const diff = w.target - current;
      const reduced = this.host.reducedMotion();
      const next = reduced || Math.abs(diff) < 0.001 ? w.target : current + diff * (1 - Math.exp(-dt / 70));
      transform.setZoom(next);
      if (w.anchorWorld)
        transform.setLocationAtPoint(w.anchorWorld, w.anchorScreen[0], w.anchorScreen[1], w.anchorWorld[2]);
      this.host.changed();
      if (next === w.target || transform.zoom !== next) {
        this.wheel = null;
        this.host.gesture(false);
      } else {
        busy = true;
      }
    }
    return busy;
  }

  stopMomentum(): void {
    if (this.inertia) this.inertia = null;
    if (this.wheel) {
      this.wheel = null;
      this.host.gesture(false);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.cancel();
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
  }

  private listen(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private point(e: MouseEvent): [number, number] {
    const rect = this.host.element.getBoundingClientRect();
    return [e.clientX - rect.left - this.host.element.clientLeft, e.clientY - rect.top - this.host.element.clientTop];
  }

  private cancel(): void {
    if (this.mode.kind !== "idle" && this.mode.kind !== "press") this.host.gesture(false);
    this.mode = { kind: "idle" };
    this.pointers.clear();
    this.samples = [];
  }

  private onPointerDown(e: PointerEvent): void {
    const [x, y] = this.point(e);
    const pending = this.host.pointerEvent("mousedown", e, [x, y]);
    const hold: Hold = { waiting: pending !== null, prevented: e.defaultPrevented, moved: false };
    pending?.then((prevented) => {
      hold.waiting = false;
      if (prevented) hold.prevented = true;
    });
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2) return;
    this.host.interrupt();
    this.stopMomentum();
    const pointer: Pointer = {
      id: e.pointerId,
      type: e.pointerType,
      x,
      y,
      startX: x,
      startY: y,
      startTime: e.timeStamp,
    };
    this.pointers.set(e.pointerId, pointer);
    try {
      this.host.element.setPointerCapture(e.pointerId);
    } catch {
      this.pointers.delete(e.pointerId);
      return;
    }
    if (e.pointerType !== "mouse") e.preventDefault();
    const touches = [...this.pointers.values()].filter((p) => p.type !== "mouse");
    if (touches.length === 2 && this.options.touchZoomRotate) {
      this.beginTwoFinger(touches[0]!, touches[1]!);
      return;
    }
    if (this.pointers.size > 1) return;
    const rotate = e.pointerType === "mouse" && (e.button === 2 || e.ctrlKey);
    this.mode = { kind: "press", pointer: e.pointerId, rotate, hold };
    this.samples = [{ t: e.timeStamp, x, y }];
  }

  private onPointerMove(e: PointerEvent): void {
    const [x, y] = this.point(e);
    const pointer = this.pointers.get(e.pointerId);
    if (!pointer) {
      if (e.pointerType === "mouse") this.host.pointerEvent("mousemove", e, [x, y]);
      return;
    }
    pointer.x = x;
    pointer.y = y;
    const mode = this.mode;
    const transform = this.host.transform;
    if (mode.kind === "press" && mode.pointer === e.pointerId) {
      if (Math.hypot(x - pointer.startX, y - pointer.startY) < this.options.clickTolerance) return;
      mode.hold.moved = true;
      if (mode.hold.waiting || mode.hold.prevented) return;
      if (mode.rotate) {
        if (!this.options.dragRotate) return;
        this.mode = {
          kind: "rotate",
          pointer: e.pointerId,
          lastX: pointer.startX,
          lastY: pointer.startY,
          moved: false,
        };
        this.host.gesture(true);
      } else {
        if (!this.options.dragPan) return;
        const anchor = this.host.anchor(pointer.startX, pointer.startY);
        if (!anchor) return;
        this.mode = { kind: "pan", pointer: e.pointerId, anchor };
        this.host.gesture(true);
      }
    }
    const current = this.mode;
    if (current.kind === "pan" && current.pointer === e.pointerId) {
      transform.setLocationAtPoint(current.anchor, x, y, current.anchor[2]);
      this.samples.push({ t: e.timeStamp, x, y });
      while (this.samples.length > 2 && e.timeStamp - this.samples[0]!.t > 100) this.samples.shift();
      this.host.changed();
    } else if (current.kind === "rotate" && current.pointer === e.pointerId) {
      const dx = x - current.lastX;
      const dy = y - current.lastY;
      current.lastX = x;
      current.lastY = y;
      current.moved = true;
      this.suppressContextMenu = true;
      transform.setBearing(transform.bearing - dx * 0.8);
      transform.setPitch(transform.pitch + dy * 0.5);
      this.host.changed();
    } else if (current.kind === "touch2") {
      this.moveTwoFinger(current);
    }
  }

  private onPointerUp(e: PointerEvent, cancelled = false): void {
    const pointer = this.pointers.get(e.pointerId);
    if (!pointer) return;
    this.pointers.delete(e.pointerId);
    try {
      if (this.host.element.hasPointerCapture(e.pointerId)) this.host.element.releasePointerCapture(e.pointerId);
    } catch {
      this.cancel();
    }
    const [x, y] = this.point(e);
    if (!cancelled) this.host.pointerEvent("mouseup", e, [x, y]);
    const mode = this.mode;
    if (mode.kind === "press" && mode.pointer === e.pointerId) {
      this.mode = { kind: "idle" };
      if (cancelled || mode.hold.moved) return;
      if (e.pointerType === "mouse" && e.button === 2) return;
      this.host.pointerEvent("click", e, [x, y]);
      if (e.pointerType !== "mouse") this.detectDoubleTap(e, x, y);
      return;
    }
    if (mode.kind === "pan" && mode.pointer === e.pointerId) {
      this.mode = { kind: "idle" };
      if (!cancelled) this.startInertia(mode.anchor, x, y, e.timeStamp);
      this.host.gesture(false);
      return;
    }
    if (mode.kind === "rotate" && mode.pointer === e.pointerId) {
      this.mode = { kind: "idle" };
      this.host.gesture(false);
      if (mode.moved) this.host.rotateEnded();
      return;
    }
    if (mode.kind === "touch2" && mode.ids.includes(e.pointerId)) {
      this.host.gesture(false);
      const rest = [...this.pointers.values()].find((p) => p.type !== "mouse");
      if (rest && this.options.dragPan) {
        const anchor = this.host.anchor(rest.x, rest.y);
        if (anchor) {
          this.mode = { kind: "pan", pointer: rest.id, anchor };
          this.samples = [{ t: e.timeStamp, x: rest.x, y: rest.y }];
          this.host.gesture(true);
          return;
        }
      }
      this.mode = { kind: "idle" };
    }
  }

  private startInertia(anchor: Point3, x: number, y: number, time: number): void {
    if (this.host.reducedMotion()) return;
    const first = this.samples[0];
    this.samples = [];
    if (!first) return;
    const dt = time - first.t;
    if (dt <= 0 || dt > 150) return;
    let vx = (x - first.x) / dt;
    let vy = (y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed < 0.15) return;
    if (speed > MAX_INERTIA_SPEED) {
      vx *= MAX_INERTIA_SPEED / speed;
      vy *= MAX_INERTIA_SPEED / speed;
    }
    const v = Math.hypot(vx, vy);
    const duration = v / INERTIA_DECELERATION;
    const distance = (v * v) / (2 * INERTIA_DECELERATION);
    this.inertia = {
      start: performance.now(),
      duration,
      from: [x, y],
      offset: [(vx / v) * distance, (vy / v) * distance],
      anchor,
    };
    this.host.changed();
  }

  private twoFinger(a: Pointer, b: Pointer): TwoFinger {
    return {
      dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      y0: a.y,
      y1: b.y,
    };
  }

  private beginTwoFinger(a: Pointer, b: Pointer): void {
    const prior = this.mode;
    if (prior.kind === "pan" || prior.kind === "rotate") this.host.gesture(false);
    const transform = this.host.transform;
    const start = this.twoFinger(a, b);
    this.mode = {
      kind: "touch2",
      ids: [a.id, b.id],
      start,
      zoom0: transform.zoom,
      bearing0: transform.bearing,
      pitch0: transform.pitch,
      anchor: this.host.anchor(start.midX, start.midY),
      sub: "undecided",
      rotating: false,
    };
    this.host.gesture(true);
  }

  private moveTwoFinger(mode: Extract<Mode, { kind: "touch2" }>): void {
    const a = this.pointers.get(mode.ids[0]);
    const b = this.pointers.get(mode.ids[1]);
    if (!a || !b) return;
    const now = this.twoFinger(a, b);
    const s = mode.start;
    const transform = this.host.transform;
    if (mode.sub === "undecided") {
      const d0 = now.y0 - s.y0;
      const d1 = now.y1 - s.y1;
      const scaleChange = Math.abs(Math.log(now.dist / s.dist));
      const flat = Math.abs(Math.sin(s.angle)) < 0.5;
      if (
        this.options.touchPitch &&
        flat &&
        Math.sign(d0) === Math.sign(d1) &&
        Math.abs(d0) > 8 &&
        Math.abs(d1) > 8 &&
        scaleChange < 0.08
      ) {
        mode.sub = "pitch";
      } else if (
        scaleChange > 0.04 ||
        Math.hypot(now.midX - s.midX, now.midY - s.midY) > 6 ||
        Math.abs(angleDelta(now.angle, s.angle)) > 0.1
      ) {
        mode.sub = "pinch";
      } else {
        return;
      }
    }
    if (mode.sub === "pitch") {
      transform.setPitch(mode.pitch0 - (now.midY - s.midY) * 0.4);
      this.host.changed();
      return;
    }
    transform.setZoom(mode.zoom0 + Math.log2(now.dist / s.dist));
    const turn = angleDelta(now.angle, s.angle);
    if (!mode.rotating && this.options.touchRotate && Math.abs(turn) > (12 * Math.PI) / 180) mode.rotating = true;
    if (mode.rotating) transform.setBearing(mode.bearing0 - (turn * 180) / Math.PI);
    if (mode.anchor) transform.setLocationAtPoint(mode.anchor, now.midX, now.midY, mode.anchor[2]);
    this.host.changed();
  }

  private detectDoubleTap(e: PointerEvent, x: number, y: number): void {
    const last = this.lastTap;
    if (last && e.timeStamp - last.t < DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) < 30) {
      this.lastTap = null;
      const pending = this.host.pointerEvent("dblclick", e, [x, y]);
      if (this.options.doubleClickZoom && !e.defaultPrevented) this.zoomUnlessPrevented(pending, 1, [x, y]);
      return;
    }
    this.lastTap = { t: e.timeStamp, x, y };
  }

  private onDoubleClick(e: MouseEvent): void {
    const point = this.point(e);
    const pending = this.host.pointerEvent("dblclick", e, point);
    if (!this.options.doubleClickZoom || e.defaultPrevented) return;
    e.preventDefault();
    this.zoomUnlessPrevented(pending, e.shiftKey ? -1 : 1, point);
  }

  private zoomUnlessPrevented(pending: Promise<boolean> | null, delta: number, around: [number, number]): void {
    if (!pending) {
      this.zoomBy(delta, around);
      return;
    }
    pending.then((prevented) => {
      if (!prevented && !this.destroyed && this.options.doubleClickZoom) this.zoomBy(delta, around);
    });
  }

  private zoomBy(delta: number, around: [number, number]): void {
    const transform = this.host.transform;
    const target = Math.round((transform.zoom + delta) * 1000) / 1000;
    this.host.ease({ zoom: target }, around, this.host.reducedMotion() ? 0 : 300);
  }

  private onContextMenu(e: MouseEvent): void {
    if (this.suppressContextMenu) {
      e.preventDefault();
      this.suppressContextMenu = false;
      return;
    }
    this.host.pointerEvent("contextmenu", e, this.point(e));
  }

  private onWheel(e: WheelEvent): void {
    if (!this.options.scrollZoom) return;
    e.preventDefault();
    this.host.interrupt();
    this.inertia = null;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 40;
    else if (e.deltaMode === 2) delta *= 800;
    if (delta === 0) return;
    const pinch = e.ctrlKey;
    const notch = e.deltaMode !== 0 || (Math.abs(delta) >= 50 && Number.isInteger(delta) && !pinch);
    let dz: number;
    if (pinch) dz = -delta / 100;
    else if (notch) dz = -Math.sign(delta) * Math.min(2, Math.abs(delta) / 100) * 0.5;
    else dz = -delta / 220;
    const transform = this.host.transform;
    const point = this.point(e);
    const now = performance.now();
    if (!this.wheel) {
      this.wheel = {
        target: transform.zoom,
        anchorScreen: point,
        anchorWorld: this.host.anchor(point[0], point[1]),
        last: now,
      };
      this.host.gesture(true);
    } else if (Math.hypot(point[0] - this.wheel.anchorScreen[0], point[1] - this.wheel.anchorScreen[1]) > 2) {
      this.wheel.anchorScreen = point;
      this.wheel.anchorWorld = this.host.anchor(point[0], point[1]);
    }
    this.wheel.target = Math.max(transform.minZoom, Math.min(transform.maxZoom, this.wheel.target + dz));
    this.wheel.last = Math.min(this.wheel.last, now);
    this.host.changed();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.options.keyboard || e.altKey || e.ctrlKey || e.metaKey) return;
    const transform = this.host.transform;
    const duration = this.host.reducedMotion() ? 0 : 300;
    const step = 100;
    let handled = true;
    switch (e.key) {
      case "ArrowLeft":
        if (e.shiftKey) this.host.ease({ bearing: transform.bearing - 15 }, null, duration);
        else this.host.ease({ panBy: [-step, 0] }, null, duration);
        break;
      case "ArrowRight":
        if (e.shiftKey) this.host.ease({ bearing: transform.bearing + 15 }, null, duration);
        else this.host.ease({ panBy: [step, 0] }, null, duration);
        break;
      case "ArrowUp":
        if (e.shiftKey) this.host.ease({ pitch: transform.pitch + 10 }, null, duration);
        else this.host.ease({ panBy: [0, -step] }, null, duration);
        break;
      case "ArrowDown":
        if (e.shiftKey) this.host.ease({ pitch: transform.pitch - 10 }, null, duration);
        else this.host.ease({ panBy: [0, step] }, null, duration);
        break;
      case "+":
      case "=":
        this.host.ease({ zoom: transform.zoom + 1 }, null, duration);
        break;
      case "-":
      case "_":
        this.host.ease({ zoom: transform.zoom - 1 }, null, duration);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }
}

function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
