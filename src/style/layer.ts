import { deepClone } from "../core/clone.ts";
import type { LayerUpdate } from "./diff.ts";
import type { Compiled, EvalContext, OutputKind } from "./expression.ts";
import { compile, isOperator } from "./expression.ts";
import { checkTransition, settled, Transition, timing } from "./transition.ts";
import type { LayerSpec, LayerType, TransitionSpec } from "./types.ts";

export interface PropertyDef {
  kind: OutputKind;
  default: unknown;
  expression: boolean;
  feature: boolean;
  transition?: false;
  check?: (value: unknown) => string | null;
}

const p = (kind: OutputKind, def: unknown, feature = true): PropertyDef => ({
  kind,
  default: def,
  expression: true,
  feature,
});

const checked = (
  kind: OutputKind,
  def: unknown,
  feature: boolean,
  check: (value: unknown) => string | null,
): PropertyDef => ({ ...p(kind, def, feature), check });

const fixed = (def: unknown, check: (value: unknown) => string | null): PropertyDef => ({
  kind: "any",
  default: def,
  expression: false,
  feature: false,
  check,
});

const oneOf =
  (...values: string[]) =>
  (v: unknown) =>
    typeof v === "string" && values.includes(v) ? null : `must be one of ${values.join(", ")}`;

const numberAtLeast = (min: number) => (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? null : `must be a number >= ${min}`;

const numberQuad = (v: unknown) =>
  Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n))
    ? null
    : "must be [top, right, bottom, left] in pixels";

const numberOrNull = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v)) ? null : "must be a number";

export function isPlainValue(value: unknown, def: { kind: string }): boolean {
  return !Array.isArray(value) || (def.kind === "any" && !isOperator(value[0]));
}

export function literalList(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string") && !isOperator(value[0])
    ? ["literal", value]
    : value;
}

const numberPair = (v: unknown) =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))
    ? null
    : "must be [number, number]";

const isBoolean = (v: unknown) => (typeof v === "boolean" ? null : "must be true or false");

const numberList = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every((n) => typeof n === "number" && n >= 0)
    ? null
    : "must be a list of up to 16 non-negative numbers";

const ANCHOR_NAMES = [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const anchorList = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string" && ANCHOR_NAMES.includes(a))
    ? null
    : `must be a list of anchors: ${ANCHOR_NAMES.join(", ")}`;

const stringList = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string") ? null : "must be a list of strings";

const DEFAULT_HEAT = [
  "interpolate",
  ["linear"],
  ["heatmap-density"],
  0,
  "rgba(47, 111, 219, 0)",
  0.15,
  "#2f6fdb",
  0.35,
  "#2db3c4",
  0.55,
  "#7ccf6b",
  0.75,
  "#f2d544",
  1,
  "#e4572e",
];

export const PAINT: Record<LayerType, Record<string, PropertyDef>> = {
  custom: {},
  background: { color: p("color", "#000000", false), opacity: p("number", 1, false) },
  raster: {
    opacity: p("number", 1, false),
    brightnessMin: p("number", 0, false),
    brightnessMax: p("number", 1, false),
    contrast: p("number", 0, false),
    saturation: p("number", 0, false),
    hueRotate: p("number", 0, false),
    fadeDuration: fixed(200, numberAtLeast(0)),
    resampling: fixed("linear", oneOf("linear", "nearest")),
  },
  fill: {
    color: p("color", "#000000"),
    opacity: p("number", 1),
    outlineColor: p("color", null),
    pattern: p("string", "", false),
    translate: checked("any", [0, 0], false, numberPair),
    translateAnchor: fixed("map", oneOf("map", "viewport")),
    antialias: checked("boolean", true, false, isBoolean),
  },
  line: {
    offset: p("number", 0),
    gapWidth: p("number", 0),
    color: p("color", "#000000"),
    width: p("number", 1),
    opacity: p("number", 1),
    blur: p("number", 0),
    dash: checked("any", null, false, numberList),
  },
  circle: {
    radius: p("number", 5),
    color: p("color", "#000000"),
    opacity: p("number", 1),
    strokeColor: p("color", "#000000"),
    strokeWidth: p("number", 0),
    strokeOpacity: p("number", 1),
    blur: p("number", 0),
    translate: checked("any", [0, 0], false, numberPair),
    translateAnchor: fixed("map", oneOf("map", "viewport")),
    pitchScale: fixed("viewport", oneOf("map", "viewport")),
    pitchAlignment: fixed("viewport", oneOf("map", "viewport")),
  },
  symbol: {
    color: p("color", "#000000"),
    haloColor: p("color", "rgba(0, 0, 0, 0)"),
    haloWidth: p("number", 0),
    haloBlur: p("number", 0),
    opacity: p("number", 1),
    translate: checked("any", [0, 0], false, numberPair),
    translateAnchor: fixed("map", oneOf("map", "viewport")),
    iconTranslate: checked("any", [0, 0], false, numberPair),
    iconTranslateAnchor: fixed("map", oneOf("map", "viewport")),
    iconColor: p("color", "#000000"),
    iconHaloColor: p("color", "rgba(0, 0, 0, 0)"),
    iconHaloWidth: p("number", 0),
    iconOpacity: p("number", 1),
  },
  extrusion: {
    color: p("color", "#000000"),
    height: p("number", 0),
    base: p("number", 0),
    opacity: p("number", 1, false),
  },
  heatmap: {
    radius: p("number", 30),
    weight: p("number", 1),
    intensity: p("number", 1, false),
    color: { ...p("color", DEFAULT_HEAT, false), transition: false },
    opacity: p("number", 1, false),
  },
  hillshade: {
    exaggeration: p("number", 0.5, false),
    shadowColor: p("color", "#000000", false),
    highlightColor: p("color", "#ffffff", false),
    accentColor: p("color", "#000000", false),
    illuminationDirection: fixed(335, numberAtLeast(0)),
    illuminationAnchor: fixed("viewport", oneOf("viewport", "map")),
    method: fixed("lambert", oneOf("lambert", "standard")),
  },
};

export const LAYOUT: Record<LayerType, Record<string, PropertyDef>> = {
  custom: {},
  background: {},
  raster: {},
  fill: {},
  line: {
    cap: fixed("butt", oneOf("butt", "round", "square")),
    join: fixed("miter", oneOf("miter", "round", "bevel")),
    miterLimit: fixed(2, numberAtLeast(1)),
  },
  circle: {},
  heatmap: {},
  symbol: {
    text: p("string", ""),
    font: checked("any", ["sans-serif"], true, stringList),
    size: p("number", 14),
    weight: checked("string", "normal", true, oneOf("normal", "bold")),
    italic: checked("boolean", false, true, isBoolean),
    placement: checked("string", "point", false, oneOf("point", "line", "line-center")),
    anchor: checked("string", "center", true, oneOf(...ANCHOR_NAMES)),
    variableAnchor: fixed(null, anchorList),
    radialOffset: checked("any", null, true, numberOrNull),
    justify: checked("string", "center", true, oneOf("auto", "left", "center", "right")),
    lineHeight: checked("number", 1.2, false, numberAtLeast(0)),
    rotate: p("number", 0),
    rotationAlignment: checked("string", "auto", false, oneOf("auto", "map", "viewport")),
    pitchAlignment: checked("string", "auto", false, oneOf("auto", "map", "viewport")),
    ignorePlacement: checked("boolean", false, false, isBoolean),
    iconIgnorePlacement: checked("boolean", false, false, isBoolean),
    maxAngle: checked("number", 45, false, numberAtLeast(0)),
    keepUpright: checked("boolean", true, false, isBoolean),
    offset: checked("any", [0, 0], true, numberPair),
    maxWidth: checked("number", 10, true, numberAtLeast(0)),
    letterSpacing: checked("number", 0, true, numberAtLeast(-1)),
    padding: checked("number", 2, false, numberAtLeast(0)),
    spacing: checked("number", 250, false, numberAtLeast(1)),
    allowOverlap: checked("boolean", false, false, isBoolean),
    transform: checked("string", "none", true, oneOf("none", "uppercase", "lowercase")),
    priority: p("number", 0),
    optional: checked("boolean", false, false, isBoolean),
    icon: p("string", ""),
    iconSize: p("number", 1),
    iconRotate: p("number", 0),
    iconAnchor: checked("string", "center", true, oneOf(...ANCHOR_NAMES)),
    iconOffset: checked("any", [0, 0], true, numberPair),
    iconPadding: checked("number", 2, false, numberAtLeast(0)),
    iconAllowOverlap: checked("boolean", false, false, isBoolean),
    iconOptional: checked("boolean", false, false, isBoolean),
    iconRotationAlignment: checked("string", "auto", false, oneOf("auto", "map", "viewport")),
    iconTextFit: checked("string", "none", false, oneOf("none", "width", "height", "both")),
    iconTextFitPadding: checked("any", [0, 0, 0, 0], false, numberQuad),
  },
  extrusion: {
    hideOutlines: fixed(null, isBoolean),
  },
  hillshade: {},
};

let nextUid = 1;

export interface CustomLayerInput {
  readonly matrix: Float64Array;
  readonly projection: Float64Array;
  readonly fov: number;
  readonly nearZ: number;
  readonly farZ: number;
}

export interface CustomLayer {
  readonly id: string;
  readonly type: "custom";
  readonly renderingMode?: "2d" | "3d";
  onAdd?(map: unknown, gl: WebGL2RenderingContext): void;
  onRemove?(map: unknown, gl: WebGL2RenderingContext): void;
  prerender?(gl: WebGL2RenderingContext, matrix: Float64Array & CustomLayerInput): void;
  render(gl: WebGL2RenderingContext, matrix: Float64Array & CustomLayerInput): void;
}

export class StyleLayer {
  readonly uid = nextUid++;
  readonly id: string;
  readonly type: LayerType;
  spec: LayerSpec;
  custom: CustomLayer | null = null;
  source: string | undefined;
  sourceLayer: string | undefined;
  minZoom: number;
  maxZoom: number;
  visible: boolean;
  filter: Compiled<boolean> | null = null;
  private readonly paint = new Map<string, Compiled<unknown>>();
  private readonly layout = new Map<string, Compiled<unknown>>();
  private readonly fixedValues = new Map<string, unknown>();
  private stateRevision = -1;
  private stateUse = false;
  private zoomRevision = -1;
  private zoomUse = false;
  revision = 0;
  motion = 0;
  private clock = 0;
  private readonly moving = new Set<string>();

  constructor(spec: LayerSpec) {
    this.id = spec.id;
    this.type = spec.type;
    this.spec = deepClone(spec);
    this.source = "source" in spec ? spec.source : undefined;
    this.sourceLayer = "sourceLayer" in spec ? spec.sourceLayer : undefined;
    this.minZoom = spec.minZoom ?? 0;
    this.maxZoom = spec.maxZoom ?? 24;
    this.visible = spec.visible !== false;
    const paint = (spec as { paint?: Record<string, unknown> }).paint ?? {};
    const layout = (spec as { layout?: Record<string, unknown> }).layout ?? {};
    for (const [name, def] of Object.entries(PAINT[this.type]))
      this.setProperty(this.paint, "paint", name, def, paint[name]);
    for (const [name, def] of Object.entries(LAYOUT[this.type]))
      this.setProperty(this.layout, "layout", name, def, layout[name]);
    const filter = (spec as { filter?: unknown }).filter;
    if (filter !== undefined) {
      this.filter = compile<boolean>(filter, "boolean", false, `${this.id}.filter`, { geometry: true });
    }
  }

  get usesState(): boolean {
    if (this.stateRevision !== this.revision) {
      this.stateRevision = this.revision;
      this.stateUse = [...this.paint.values()].some((c) => c.stateDependent);
    }
    return this.stateUse;
  }

  get usesZoom(): boolean {
    if (this.zoomRevision !== this.revision) {
      this.zoomRevision = this.revision;
      this.zoomUse = [...this.paint.values()].some((c) => c.zoomDependent);
    }
    return this.zoomUse;
  }

  isVisible(zoom: number): boolean {
    return this.visible && (this.minZoom <= 0 || zoom >= this.minZoom) && zoom < this.maxZoom;
  }

  paintProperty<T>(name: string): Compiled<T> {
    const c = this.paint.get(name);
    if (!c) throw new Error(`Unknown paint property ${name} on ${this.type} layer`);
    return c as Compiled<T>;
  }

  layoutProperty<T>(name: string): Compiled<T> {
    const c = this.layout.get(name);
    if (!c) throw new Error(`Unknown layout property ${name} on ${this.type} layer`);
    return c as Compiled<T>;
  }

  paintValue<T>(name: string, ctx: EvalContext): T {
    return this.paintProperty<T>(name).evaluate(ctx);
  }

  layoutValue<T>(name: string, ctx: EvalContext): T {
    return this.layoutProperty<T>(name).evaluate(ctx);
  }

  fixed<T>(name: string): T {
    return this.fixedValues.get(name) as T;
  }

  setPaint(name: string, value: unknown, fallback?: TransitionSpec): void {
    const holder = this.spec as { paint?: Record<string, unknown> };
    const timed = transitionOf(this.type, name);
    if (timed !== null) {
      const problem = value === undefined ? null : checkTransition(value);
      if (problem) throw new Error(`${name} ${problem}`);
      holder.paint ??= {};
      if (value === undefined) delete holder.paint[name];
      else holder.paint[name] = deepClone(value);
      return;
    }
    const def = PAINT[this.type][name];
    if (!def) throw new Error(`"${name}" is not a paint property of ${this.type} layers`);
    const before = this.paint.get(name);
    this.setProperty(this.paint, "paint", name, def, value);
    holder.paint ??= {};
    const paint = holder.paint;
    if (value === undefined) delete paint[name];
    else paint[name] = deepClone(value);
    this.startTransition(name, def, before, fallback);
    this.revision++;
  }

  get animating(): boolean {
    return this.moving.size > 0;
  }

  settle(now: number): boolean {
    this.clock = now;
    if (this.moving.size === 0) return false;
    for (const name of this.moving) {
      const current = this.paint.get(name)!;
      const next = settled(current, now);
      if (next !== current) this.paint.set(name, next);
      if (!(next instanceof Transition)) this.moving.delete(name);
    }
    this.motion++;
    return this.moving.size > 0;
  }

  private startTransition(
    name: string,
    def: PropertyDef,
    before: Compiled<unknown> | undefined,
    fallback: TransitionSpec | undefined,
  ): void {
    const after = this.paint.get(name);
    if (!before || !after || !isTransitionable(def)) return;
    if (isNull(before) || isNull(after)) return;
    const own = (this.spec as { paint?: Record<string, unknown> }).paint?.[`${name}Transition`];
    const time = timing((own as TransitionSpec | undefined) ?? fallback);
    if (!time) return;
    const begin = performance.now() + time.delay;
    const clock = () => this.clock;
    this.paint.set(
      name,
      new Transition(def.kind as "number" | "color", before, after, begin, begin + time.duration, clock),
    );
    this.moving.add(name);
  }

  setLayout(name: string, value: unknown): void {
    const def = LAYOUT[this.type][name];
    if (!def) throw new Error(`"${name}" is not a layout property of ${this.type} layers`);
    this.setProperty(this.layout, "layout", name, def, value);
    const holder = this.spec as { layout?: Record<string, unknown> };
    holder.layout ??= {};
    const layout = holder.layout;
    if (value === undefined) delete layout[name];
    else layout[name] = deepClone(value);
    this.revision++;
  }

  setFilter(filter: unknown): void {
    this.filter =
      filter === undefined || filter === null
        ? null
        : compile<boolean>(filter, "boolean", false, `${this.id}.filter`, { geometry: true });
    const spec = this.spec as { filter?: unknown };
    if (filter === undefined || filter === null) delete spec.filter;
    else spec.filter = deepClone(filter);
    this.revision++;
  }

  restyle(spec: LayerSpec, update: LayerUpdate, fallback?: TransitionSpec): void {
    const timings = update.paint.filter(([name]) => transitionOf(this.type, name) !== null);
    const values = update.paint.filter(([name]) => transitionOf(this.type, name) === null);
    for (const [name, value] of [...timings, ...values]) this.setPaint(name, value, fallback);
    for (const [name, value] of update.layout) this.setLayout(name, value);
    if (update.filter) this.setFilter((spec as { filter?: unknown }).filter);
    if (update.zoom) this.setZoomRange(spec.minZoom ?? 0, spec.maxZoom ?? 24);
    if (update.visible) this.setVisible(spec.visible !== false);
    this.spec = deepClone(spec);
  }

  setZoomRange(minZoom: number, maxZoom: number): void {
    if (minZoom !== this.minZoom || maxZoom !== this.maxZoom) this.revision++;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.spec.minZoom = minZoom;
    this.spec.maxZoom = maxZoom;
  }

  setVisible(visible: boolean): void {
    if (visible !== this.visible) this.revision++;
    this.visible = visible;
    this.spec.visible = visible;
  }

  serialize(): LayerSpec {
    return deepClone(this.spec);
  }

  private setProperty(
    target: Map<string, Compiled<unknown>>,
    group: string,
    name: string,
    def: PropertyDef,
    value: unknown,
  ): void {
    if (!def.expression) {
      const v = value === undefined ? def.default : value;
      if (value !== undefined && def.check) {
        const problem = def.check(value);
        if (problem) throw new Error(`${this.id}.${group}.${name} ${problem}`);
      }
      this.fixedValues.set(name, deepClone(v));
      return;
    }
    if (value !== undefined && def.check && isPlainValue(value, def)) {
      const problem = def.check(value);
      if (problem) throw new Error(`${this.id}.${group}.${name} ${problem}`);
    }
    target.set(
      name,
      compile(
        literalList(value === undefined ? def.default : value),
        def.kind,
        def.default,
        `${this.id}.${group}.${name}`,
        group === "paint",
      ),
    );
  }
}

export function isTransitionable(def: PropertyDef): boolean {
  return def.expression && (def.kind === "number" || def.kind === "color") && def.transition !== false;
}

export function transitionOf(type: LayerType, name: string): PropertyDef | null {
  if (!name.endsWith("Transition")) return null;
  const def = PAINT[type][name.slice(0, -"Transition".length)];
  return def && isTransitionable(def) ? def : null;
}

function isNull(value: Compiled<unknown>): boolean {
  return value.constant && value.evaluate({ zoom: 0 }) === null;
}
