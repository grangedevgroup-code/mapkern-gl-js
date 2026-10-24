import type { Compiled, EvalContext, OutputKind } from "./expression.ts";
import { compile } from "./expression.ts";
import type { LayerSpec, LayerType } from "./types.ts";

export interface PropertyDef {
  kind: OutputKind;
  default: unknown;
  expression: boolean;
  feature: boolean;
  check?: (value: unknown) => string | null;
}

const p = (kind: OutputKind, def: unknown, feature = true): PropertyDef => ({
  kind,
  default: def,
  expression: true,
  feature,
});

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

const numberPair = (v: unknown) =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))
    ? null
    : "must be [number, number]";

const isBoolean = (v: unknown) => (typeof v === "boolean" ? null : "must be true or false");

const numberList = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every((n) => typeof n === "number" && n >= 0)
    ? null
    : "must be a list of up to 16 non-negative numbers";

const stringList = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string") ? null : "must be a list of strings";

export const PAINT: Record<LayerType, Record<string, PropertyDef>> = {
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
    translate: fixed([0, 0], numberPair),
  },
  line: {
    color: p("color", "#000000"),
    width: p("number", 1),
    opacity: p("number", 1),
    blur: p("number", 0),
    offset: p("number", 0),
    dash: fixed(null, numberList),
  },
  circle: {
    radius: p("number", 5),
    color: p("color", "#000000"),
    opacity: p("number", 1),
    strokeColor: p("color", "#000000"),
    strokeWidth: p("number", 0),
    blur: p("number", 0),
  },
  symbol: {
    color: p("color", "#000000"),
    haloColor: p("color", "rgba(0, 0, 0, 0)"),
    haloWidth: p("number", 0),
    opacity: p("number", 1),
  },
  extrusion: {
    color: p("color", "#000000"),
    height: p("number", 0),
    base: p("number", 0),
    opacity: p("number", 1, false),
  },
  hillshade: {
    exaggeration: p("number", 0.5, false),
    shadowColor: p("color", "#000000", false),
    highlightColor: p("color", "#ffffff", false),
    accentColor: p("color", "#000000", false),
    illuminationDirection: fixed(335, numberAtLeast(0)),
  },
};

export const LAYOUT: Record<LayerType, Record<string, PropertyDef>> = {
  background: {},
  raster: {},
  fill: {},
  line: {
    cap: fixed("butt", oneOf("butt", "round", "square")),
    join: fixed("miter", oneOf("miter", "round", "bevel")),
    miterLimit: fixed(2, numberAtLeast(1)),
  },
  circle: {},
  symbol: {
    text: p("string", ""),
    font: fixed(["sans-serif"], stringList),
    size: p("number", 14),
    weight: fixed("normal", oneOf("normal", "bold")),
    italic: fixed(false, isBoolean),
    placement: fixed("point", oneOf("point", "line")),
    anchor: fixed("center", oneOf("center", "top", "bottom", "left", "right")),
    offset: fixed([0, 0], numberPair),
    maxWidth: fixed(10, numberAtLeast(1)),
    letterSpacing: fixed(0, numberAtLeast(-1)),
    padding: fixed(2, numberAtLeast(0)),
    spacing: fixed(250, numberAtLeast(16)),
    allowOverlap: fixed(false, isBoolean),
    transform: fixed("none", oneOf("none", "uppercase", "lowercase")),
    priority: p("number", 0),
  },
  extrusion: {},
  hillshade: {},
};

export class StyleLayer {
  readonly id: string;
  readonly type: LayerType;
  spec: LayerSpec;
  source: string | undefined;
  sourceLayer: string | undefined;
  minZoom: number;
  maxZoom: number;
  visible: boolean;
  filter: Compiled<boolean> | null = null;
  private readonly paint = new Map<string, Compiled<unknown>>();
  private readonly layout = new Map<string, Compiled<unknown>>();
  private readonly fixedValues = new Map<string, unknown>();
  revision = 0;

  constructor(spec: LayerSpec) {
    this.id = spec.id;
    this.type = spec.type;
    this.spec = structuredClone(spec);
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
    if (filter !== undefined) this.filter = compile<boolean>(filter, "boolean", false, `${this.id}.filter`);
  }

  isVisible(zoom: number): boolean {
    return this.visible && zoom >= this.minZoom && zoom < this.maxZoom;
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

  setPaint(name: string, value: unknown): void {
    const def = PAINT[this.type][name];
    if (!def) throw new Error(`"${name}" is not a paint property of ${this.type} layers`);
    this.setProperty(this.paint, "paint", name, def, value);
    const paint = ((this.spec as { paint?: Record<string, unknown> }).paint ??= {});
    if (value === undefined) delete paint[name];
    else paint[name] = structuredClone(value);
    this.revision++;
  }

  setLayout(name: string, value: unknown): void {
    const def = LAYOUT[this.type][name];
    if (!def) throw new Error(`"${name}" is not a layout property of ${this.type} layers`);
    this.setProperty(this.layout, "layout", name, def, value);
    const layout = ((this.spec as { layout?: Record<string, unknown> }).layout ??= {});
    if (value === undefined) delete layout[name];
    else layout[name] = structuredClone(value);
    this.revision++;
  }

  setFilter(filter: unknown): void {
    this.filter =
      filter === undefined || filter === null ? null : compile<boolean>(filter, "boolean", false, `${this.id}.filter`);
    const spec = this.spec as { filter?: unknown };
    if (filter === undefined || filter === null) delete spec.filter;
    else spec.filter = structuredClone(filter);
    this.revision++;
  }

  setZoomRange(minZoom: number, maxZoom: number): void {
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.spec.minZoom = minZoom;
    this.spec.maxZoom = maxZoom;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.spec.visible = visible;
  }

  serialize(): LayerSpec {
    return structuredClone(this.spec);
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
      this.fixedValues.set(name, structuredClone(v));
      return;
    }
    target.set(
      name,
      compile(value === undefined ? def.default : value, def.kind, def.default, `${this.id}.${group}.${name}`),
    );
  }
}
