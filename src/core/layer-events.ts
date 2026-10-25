import type { LngLat } from "../geo/mercator.ts";
import type { Listener } from "./events.ts";
import type { QueriedFeature } from "./query.ts";

export type PointerType = "click" | "dblclick" | "contextmenu" | "mousemove" | "mousedown" | "mouseup" | "mouseout";

export type LayerEventType = Exclude<PointerType, "mouseout"> | "mouseenter" | "mouseleave" | "mouseover" | "mouseout";

export const LAYER_EVENT_TYPES: ReadonlySet<string> = new Set<LayerEventType>([
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

export interface PointerInput {
  readonly type: PointerType;
  readonly event: MouseEvent;
  readonly point: [number, number];
  readonly lngLat: LngLat | null;
}

export interface LayerEventsHost<E> {
  query(point: [number, number], layers: readonly string[]): Promise<QueriedFeature[]>;
  event(type: LayerEventType, input: PointerInput, features: QueriedFeature[], prevent: () => void): E;
  active(): boolean;
}

interface Binding<E> {
  readonly type: LayerEventType;
  readonly layers: readonly string[];
  readonly listener: Listener<E>;
  inside: boolean;
}

interface Queued {
  input: PointerInput;
  readonly done: Promise<boolean>;
  readonly resolve: (prevented: boolean) => void;
}

const ENTERING: ReadonlySet<LayerEventType> = new Set(["mouseenter", "mouseover"]);
const LEAVING: ReadonlySet<LayerEventType> = new Set(["mouseleave", "mouseout"]);

function handles(binding: LayerEventType, pointer: PointerType): boolean {
  if (pointer === "mouseout") return ENTERING.has(binding) || LEAVING.has(binding);
  if (pointer === "mousemove") return binding === "mousemove" || ENTERING.has(binding) || LEAVING.has(binding);
  return binding === pointer;
}

export class LayerEvents<E> {
  private readonly host: LayerEventsHost<E>;
  private readonly bindings: Binding<E>[] = [];
  private readonly queue: Queued[] = [];
  private running = false;

  constructor(host: LayerEventsHost<E>) {
    this.host = host;
  }

  add(type: LayerEventType, layers: readonly string[], listener: Listener<E>): void {
    this.bindings.push({ type, layers, listener, inside: false });
  }

  remove(type: LayerEventType, layers: readonly string[], listener: Listener<E>): void {
    const index = this.bindings.findIndex(
      (b) => b.type === type && b.listener === listener && sameLayers(b.layers, layers),
    );
    if (index >= 0) this.bindings.splice(index, 1);
  }

  clear(): void {
    this.bindings.length = 0;
    for (const item of this.queue.splice(0)) item.resolve(false);
  }

  wants(type: PointerType): boolean {
    return this.bindings.some((b) => handles(b.type, type));
  }

  dispatch(input: PointerInput): Promise<boolean> | null {
    if (!this.wants(input.type)) return null;
    const last = this.queue[this.queue.length - 1];
    if (input.type === "mousemove" && last?.input.type === "mousemove") {
      last.input = input;
      return last.done;
    }
    let resolve: (prevented: boolean) => void = () => {};
    const done = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.queue.push({ input, done, resolve });
    void this.run();
    return done;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && this.host.active()) {
        const item = this.queue.shift()!;
        let prevented = false;
        try {
          await this.deliver(item.input, () => {
            prevented = true;
          });
        } catch (error) {
          report(error);
        }
        item.resolve(prevented);
      }
    } finally {
      this.running = false;
      if (!this.host.active()) for (const item of this.queue.splice(0)) item.resolve(false);
    }
  }

  private async deliver(input: PointerInput, prevent: () => void): Promise<void> {
    const targets = this.bindings.filter((b) => handles(b.type, input.type));
    if (targets.length === 0) return;
    let features: QueriedFeature[] = [];
    if (input.type !== "mouseout") {
      const layers = [...new Set(targets.flatMap((b) => b.layers))];
      features = await this.host.query(input.point, layers);
    }
    for (const binding of targets) {
      if (!this.bindings.includes(binding)) continue;
      const mine = features.filter((f) => binding.layers.includes(f.layer));
      if (ENTERING.has(binding.type)) {
        if (mine.length === 0) {
          binding.inside = false;
        } else if (!binding.inside) {
          binding.inside = true;
          this.call(binding, input, mine, prevent);
        }
      } else if (LEAVING.has(binding.type)) {
        if (mine.length > 0) {
          binding.inside = true;
        } else if (binding.inside) {
          binding.inside = false;
          this.call(binding, input, [], prevent);
        }
      } else if (mine.length > 0) {
        this.call(binding, input, mine, prevent);
      }
    }
  }

  private call(binding: Binding<E>, input: PointerInput, features: QueriedFeature[], prevent: () => void): void {
    try {
      binding.listener(this.host.event(binding.type, input, features, prevent));
    } catch (error) {
      report(error);
    }
  }
}

function sameLayers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function report(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}
