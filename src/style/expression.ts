import type { RGBA } from "./color.ts";
import { isColor, mixColor, parseColor } from "./color.ts";

export type GeometryType = "Point" | "LineString" | "Polygon" | "Unknown";

export interface FeatureContext {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly id?: string | number | undefined;
  readonly geometryType?: GeometryType;
}

export interface EvalContext {
  zoom: number;
  feature?: FeatureContext | undefined;
  state?: Readonly<Record<string, unknown>> | undefined;
  images?: ((id: string) => boolean) | undefined;
  accumulated?: unknown;
}

export type OutputKind = "number" | "color" | "string" | "boolean" | "any";

export interface Compiled<T> {
  readonly evaluate: (ctx: EvalContext) => T;
  readonly zoomDependent: boolean;
  readonly featureDependent: boolean;
  readonly stateDependent: boolean;
  readonly constant: boolean;
  readonly properties: ReadonlySet<string>;
}

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

type Fn = (ctx: EvalContext) => unknown;

interface Node {
  fn: Fn;
  zoom: boolean;
  feature: boolean;
  state?: boolean;
}

interface Scope {
  properties: Set<string>;
  path: string;
  allowState: boolean;
  vars: Map<string, Node>;
}

const EMPTY_PROPS: Readonly<Record<string, unknown>> = Object.freeze({});

export function isExpression(value: unknown): value is readonly [string, ...unknown[]] {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === "string" && OPS.has(value[0]);
}

export function compile<T>(
  value: unknown,
  kind: OutputKind,
  fallback: T,
  path = "value",
  allowState = false,
): Compiled<T> {
  const scope: Scope = { properties: new Set(), path, allowState, vars: new Map() };
  const node = build(value, scope);
  const coerce = coercer(kind);
  const evaluate = (ctx: EvalContext): T => {
    let out: unknown;
    try {
      out = node.fn(ctx);
    } catch {
      return fallback;
    }
    const coerced = coerce(out);
    return (coerced === undefined ? fallback : coerced) as T;
  };
  const constant = !node.zoom && !node.feature;
  if (constant) {
    const v = evaluate({ zoom: 0 });
    return {
      evaluate: () => v,
      zoomDependent: false,
      featureDependent: false,
      stateDependent: false,
      constant: true,
      properties: scope.properties,
    };
  }
  return {
    evaluate,
    zoomDependent: node.zoom,
    featureDependent: node.feature,
    stateDependent: node.state === true,
    constant: false,
    properties: scope.properties,
  };
}

function coercer(kind: OutputKind): (v: unknown) => unknown {
  switch (kind) {
    case "number":
      return (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    case "color":
      return (v) => {
        if (isColor(v)) return v;
        if (typeof v === "string") return parseColor(v) ?? undefined;
        return undefined;
      };
    case "string":
      return (v) => {
        if (typeof v === "string") return v;
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        return undefined;
      };
    case "boolean":
      return (v) => (typeof v === "boolean" ? v : undefined);
    default:
      return (v) => v;
  }
}

const OPS = new Set([
  "literal",
  "get",
  "has",
  "id",
  "geometry-type",
  "zoom",
  "properties",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "all",
  "any",
  "!",
  "none",
  "in",
  "match",
  "case",
  "coalesce",
  "interpolate",
  "step",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "abs",
  "min",
  "max",
  "round",
  "floor",
  "ceil",
  "sqrt",
  "ln",
  "log10",
  "log2",
  "sin",
  "cos",
  "tan",
  "pi",
  "e",
  "concat",
  "upcase",
  "downcase",
  "length",
  "slice",
  "to-string",
  "to-number",
  "to-boolean",
  "to-color",
  "rgb",
  "rgba",
  "typeof",
  "feature-state",
  "let",
  "var",
  "at",
  "index-of",
  "split",
  "number",
  "string",
  "boolean",
  "object",
  "array",
  "number-format",
  "hsl",
  "hsla",
  "to-rgba",
  "to-hsla",
  "interpolate-hcl",
  "interpolate-lab",
  "acos",
  "asin",
  "atan",
  "ln2",
  "is-supported-script",
  "image",
  "accumulated",
]);

function constant(v: unknown): Node {
  return { fn: () => v, zoom: false, feature: false };
}

function build(value: unknown, scope: Scope): Node {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return constant(value);
  }
  if (!Array.isArray(value)) {
    if (typeof value === "object") return constant(value);
    throw new ExpressionError(`${scope.path}: unsupported value ${String(value)}`);
  }
  if (value.length === 0 || typeof value[0] !== "string" || !OPS.has(value[0])) {
    return constant(value);
  }
  const op = value[0] as string;
  const args = value.slice(1) as unknown[];
  const sub = (v: unknown) => build(v, scope);
  const many = (vs: unknown[]) => vs.map(sub);
  const combine = (nodes: Node[], fn: Fn): Node => ({
    fn,
    zoom: nodes.some((n) => n.zoom),
    feature: nodes.some((n) => n.feature),
    state: nodes.some((n) => n.state === true),
  });
  const need = (min: number, max = Number.POSITIVE_INFINITY) => {
    if (args.length < min || args.length > max) {
      throw new ExpressionError(`${scope.path}: "${op}" expects ${min === max ? min : `${min}+`} arguments`);
    }
  };
  switch (op) {
    case "literal":
      need(1, 1);
      return constant(args[0]);
    case "zoom":
      need(0, 0);
      return { fn: (ctx) => ctx.zoom, zoom: true, feature: false };
    case "id":
      return { fn: (ctx) => ctx.feature?.id ?? null, zoom: false, feature: true };
    case "geometry-type":
      return { fn: (ctx) => ctx.feature?.geometryType ?? "Unknown", zoom: false, feature: true };
    case "properties":
      return { fn: (ctx) => ctx.feature?.properties ?? EMPTY_PROPS, zoom: false, feature: true };
    case "get": {
      need(1, 2);
      if (args.length === 1 && typeof args[0] === "string") {
        const key = args[0];
        scope.properties.add(key);
        return { fn: (ctx) => ctx.feature?.properties[key] ?? null, zoom: false, feature: true };
      }
      const key = sub(args[0]);
      const obj = args.length > 1 ? sub(args[1]) : null;
      return {
        fn: (ctx) => {
          const k = key.fn(ctx);
          const source = obj ? obj.fn(ctx) : (ctx.feature?.properties ?? EMPTY_PROPS);
          if (typeof k !== "string" || typeof source !== "object" || source === null) return null;
          return (source as Record<string, unknown>)[k] ?? null;
        },
        zoom: key.zoom || (obj?.zoom ?? false),
        feature: true,
      };
    }
    case "has": {
      need(1, 2);
      if (typeof args[0] === "string" && args.length === 1) {
        const key = args[0];
        scope.properties.add(key);
        return { fn: (ctx) => ctx.feature?.properties[key] !== undefined, zoom: false, feature: true };
      }
      const key = sub(args[0]);
      return {
        fn: (ctx) => {
          const k = key.fn(ctx);
          return typeof k === "string" && ctx.feature?.properties[k] !== undefined;
        },
        zoom: key.zoom,
        feature: true,
      };
    }
    case "==":
    case "!=": {
      need(2, 2);
      const [a, b] = many(args) as [Node, Node];
      const eq = op === "==";
      return combine([a, b], (ctx) => (a.fn(ctx) === b.fn(ctx)) === eq);
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      need(2, 2);
      const [a, b] = many(args) as [Node, Node];
      const cmp = comparator(op);
      return combine([a, b], (ctx) => {
        const x = a.fn(ctx);
        const y = b.fn(ctx);
        if (typeof x !== typeof y || (typeof x !== "number" && typeof x !== "string")) return false;
        return cmp(x as number, y as number);
      });
    }
    case "all": {
      const nodes = many(args);
      return combine(nodes, (ctx) => nodes.every((n) => n.fn(ctx) === true));
    }
    case "any": {
      const nodes = many(args);
      return combine(nodes, (ctx) => nodes.some((n) => n.fn(ctx) === true));
    }
    case "none": {
      const nodes = many(args);
      return combine(nodes, (ctx) => !nodes.some((n) => n.fn(ctx) === true));
    }
    case "!": {
      need(1, 1);
      const a = sub(args[0]);
      return combine([a], (ctx) => a.fn(ctx) !== true);
    }
    case "in": {
      need(2, 2);
      const needle = sub(args[0]);
      const haystackArg = args[1];
      if (Array.isArray(haystackArg) && !isExpression(haystackArg)) {
        const set = new Set(haystackArg);
        return combine([needle], (ctx) => set.has(needle.fn(ctx)));
      }
      const haystack = sub(haystackArg);
      return combine([needle, haystack], (ctx) => {
        const n = needle.fn(ctx);
        const h = haystack.fn(ctx);
        if (Array.isArray(h)) return h.includes(n);
        if (typeof h === "string" && typeof n === "string") return h.includes(n);
        return false;
      });
    }
    case "match": {
      if (args.length < 4 || args.length % 2 !== 0) {
        throw new ExpressionError(`${scope.path}: "match" expects input, label/output pairs and a fallback`);
      }
      const input = sub(args[0]);
      const table = new Map<unknown, Node>();
      const outputs: Node[] = [];
      for (let i = 1; i < args.length - 1; i += 2) {
        const out = sub(args[i + 1]);
        outputs.push(out);
        const label = args[i];
        const labels = Array.isArray(label) ? label : [label];
        for (const l of labels) {
          if (typeof l !== "string" && typeof l !== "number" && typeof l !== "boolean") {
            throw new ExpressionError(`${scope.path}: "match" labels must be literals`);
          }
          if (!table.has(l)) table.set(l, out);
        }
      }
      const otherwise = sub(args[args.length - 1]);
      return combine([input, otherwise, ...outputs], (ctx) => (table.get(input.fn(ctx)) ?? otherwise).fn(ctx));
    }
    case "case": {
      if (args.length < 3 || args.length % 2 !== 1) {
        throw new ExpressionError(`${scope.path}: "case" expects condition/output pairs and a fallback`);
      }
      const pairs: [Node, Node][] = [];
      for (let i = 0; i < args.length - 1; i += 2) pairs.push([sub(args[i]), sub(args[i + 1])]);
      const otherwise = sub(args[args.length - 1]);
      return combine([otherwise, ...pairs.flat()], (ctx) => {
        for (const [cond, out] of pairs) if (cond.fn(ctx) === true) return out.fn(ctx);
        return otherwise.fn(ctx);
      });
    }
    case "coalesce": {
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        for (const n of nodes) {
          const v = n.fn(ctx);
          if (v !== null && v !== undefined) return v;
        }
        return null;
      });
    }
    case "step": {
      if (args.length < 2 || args.length % 2 !== 0) {
        throw new ExpressionError(`${scope.path}: "step" expects input, a base output and stop/output pairs`);
      }
      const input = sub(args[0]);
      const base = sub(args[1]);
      const stops: number[] = [];
      const outs: Node[] = [];
      for (let i = 2; i < args.length; i += 2) {
        const stop = args[i];
        if (typeof stop !== "number") throw new ExpressionError(`${scope.path}: "step" stops must be numbers`);
        stops.push(stop);
        outs.push(sub(args[i + 1]));
      }
      return combine([input, base, ...outs], (ctx) => {
        const x = input.fn(ctx);
        if (typeof x !== "number") return base.fn(ctx);
        let chosen = base;
        for (let i = 0; i < stops.length; i++) {
          if (x >= stops[i]!) chosen = outs[i]!;
          else break;
        }
        return chosen.fn(ctx);
      });
    }
    case "interpolate":
      return buildInterpolate(args, scope, combine, sub, "rgb");
    case "interpolate-hcl":
      return buildInterpolate(args, scope, combine, sub, "hcl");
    case "interpolate-lab":
      return buildInterpolate(args, scope, combine, sub, "lab");
    case "feature-state": {
      need(1, 1);
      if (!scope.allowState) {
        throw new ExpressionError(`${scope.path}: "feature-state" only works in paint properties`);
      }
      const key = sub(args[0]);
      return {
        fn: (ctx) => {
          const k = key.fn(ctx);
          return typeof k === "string" ? (ctx.state?.[k] ?? null) : null;
        },
        zoom: key.zoom,
        feature: true,
        state: true,
      };
    }
    case "let": {
      if (args.length < 3 || args.length % 2 !== 1) {
        throw new ExpressionError(`${scope.path}: "let" expects name/value pairs and then an expression`);
      }
      const saved = new Map(scope.vars);
      const bound: Node[] = [];
      for (let i = 0; i < args.length - 1; i += 2) {
        const name = args[i];
        if (typeof name !== "string") throw new ExpressionError(`${scope.path}: "let" names must be strings`);
        const value = sub(args[i + 1]);
        scope.vars.set(name, value);
        bound.push(value);
      }
      const body = sub(args[args.length - 1]);
      scope.vars = saved;
      return combine([body, ...bound], body.fn);
    }
    case "var": {
      need(1, 1);
      const name = args[0];
      const value = typeof name === "string" ? scope.vars.get(name) : undefined;
      if (!value) throw new ExpressionError(`${scope.path}: "var" refers to an unknown name ${JSON.stringify(name)}`);
      return value;
    }
    case "at": {
      need(2, 2);
      const [index, list] = many(args) as [Node, Node];
      return combine([index, list], (ctx) => {
        const i = index.fn(ctx);
        const a = list.fn(ctx);
        return Array.isArray(a) && typeof i === "number" && Number.isInteger(i) && i >= 0 && i < a.length ? a[i] : null;
      });
    }
    case "index-of": {
      need(2, 3);
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        const needle = nodes[0]!.fn(ctx);
        const haystack = nodes[1]!.fn(ctx);
        const from = nodes[2]?.fn(ctx);
        const start = typeof from === "number" ? from : 0;
        if (typeof haystack === "string" && typeof needle === "string") return haystack.indexOf(needle, start);
        if (Array.isArray(haystack)) return haystack.indexOf(needle, start);
        return -1;
      });
    }
    case "split": {
      need(2, 2);
      const [text, separator] = many(args) as [Node, Node];
      return combine([text, separator], (ctx) => {
        const t = text.fn(ctx);
        const s = separator.fn(ctx);
        return typeof t === "string" && typeof s === "string" ? t.split(s) : null;
      });
    }
    case "number":
    case "string":
    case "boolean":
    case "object": {
      need(1);
      const nodes = many(args);
      const test =
        op === "object"
          ? (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v)
          : (v: unknown) => typeof v === op;
      return combine(nodes, (ctx) => {
        for (const n of nodes) {
          const v = n.fn(ctx);
          if (test(v)) return v;
        }
        return null;
      });
    }
    case "array": {
      need(1, 3);
      const value = sub(args[args.length - 1]);
      const itemType = args.length >= 2 ? args[0] : undefined;
      const length = args.length === 3 ? args[1] : undefined;
      return combine([value], (ctx) => {
        const v = value.fn(ctx);
        if (!Array.isArray(v)) return null;
        if (typeof length === "number" && v.length !== length) return null;
        if (typeof itemType === "string" && itemType !== "value" && v.some((x) => typeof x !== itemType)) return null;
        return v;
      });
    }
    case "number-format": {
      need(2, 2);
      const value = sub(args[0]);
      const options = args[1];
      if (typeof options !== "object" || options === null || Array.isArray(options)) {
        throw new ExpressionError(`${scope.path}: "number-format" expects a number and an options object`);
      }
      const o = options as Record<string, unknown>;
      const digits = (key: string) => (typeof o[key] === "number" ? (o[key] as number) : undefined);
      const currency = typeof o.currency === "string" ? o.currency : undefined;
      const settings: Intl.NumberFormatOptions = { style: currency ? "currency" : "decimal" };
      if (currency) settings.currency = currency;
      const min = digits("min-fraction-digits");
      const max = digits("max-fraction-digits");
      if (min !== undefined) settings.minimumFractionDigits = min;
      if (max !== undefined) settings.maximumFractionDigits = Math.max(max, min ?? 0);
      let format: Intl.NumberFormat;
      try {
        format = new Intl.NumberFormat(typeof o.locale === "string" ? o.locale : undefined, settings);
      } catch {
        throw new ExpressionError(`${scope.path}: "number-format" options are not valid`);
      }
      return combine([value], (ctx) => {
        const v = value.fn(ctx);
        return typeof v === "number" ? format.format(v) : null;
      });
    }
    case "hsl":
    case "hsla": {
      need(op === "hsl" ? 3 : 4, op === "hsl" ? 3 : 4);
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        const v = nodes.map((n) => n.fn(ctx));
        if (v.some((c) => typeof c !== "number")) return null;
        const [h, s, l, a] = v as number[];
        return hslToRgba(h!, s! / 100, l! / 100, a ?? 1);
      });
    }
    case "to-rgba":
    case "to-hsla": {
      need(1, 1);
      const a = sub(args[0]);
      const hsla = op === "to-hsla";
      return combine([a], (ctx) => {
        const v = a.fn(ctx);
        const c = typeof v === "string" ? parseColor(v) : isColor(v) ? v : null;
        if (!c) return null;
        return hsla ? rgbaToHsla(c) : [c[0] * 255, c[1] * 255, c[2] * 255, c[3]];
      });
    }
    case "acos":
    case "asin":
    case "atan": {
      need(1, 1);
      const a = sub(args[0]);
      const f = op === "acos" ? Math.acos : op === "asin" ? Math.asin : Math.atan;
      return combine([a], (ctx) => {
        const x = a.fn(ctx);
        return typeof x === "number" ? f(x) : null;
      });
    }
    case "ln2":
      return constant(Math.LN2);
    case "is-supported-script": {
      need(1, 1);
      const a = sub(args[0]);
      return combine([a], () => true);
    }
    case "accumulated":
      need(0, 0);
      return { fn: (ctx) => ctx.accumulated ?? null, zoom: false, feature: true };
    case "image": {
      need(1, 1);
      const name = sub(args[0]);
      return combine([name], (ctx) => {
        const id = name.fn(ctx);
        if (typeof id !== "string" || id === "") return null;
        return !ctx.images || ctx.images(id) ? id : null;
      });
    }
    case "+":
    case "*":
    case "min":
    case "max": {
      const nodes = many(args);
      const reduce =
        op === "+"
          ? (a: number, b: number) => a + b
          : op === "*"
            ? (a: number, b: number) => a * b
            : op === "min"
              ? Math.min
              : Math.max;
      return combine(nodes, (ctx) => {
        let acc: number | undefined;
        for (const n of nodes) {
          const v = n.fn(ctx);
          if (typeof v !== "number") return null;
          acc = acc === undefined ? v : reduce(acc, v);
        }
        return acc ?? null;
      });
    }
    case "-": {
      need(1, 2);
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        const a = nodes[0]!.fn(ctx);
        if (typeof a !== "number") return null;
        if (nodes.length === 1) return -a;
        const b = nodes[1]!.fn(ctx);
        return typeof b === "number" ? a - b : null;
      });
    }
    case "/":
    case "%":
    case "^": {
      need(2, 2);
      const [a, b] = many(args) as [Node, Node];
      const f = op === "/" ? (x: number, y: number) => x / y : op === "%" ? (x: number, y: number) => x % y : Math.pow;
      return combine([a, b], (ctx) => {
        const x = a.fn(ctx);
        const y = b.fn(ctx);
        return typeof x === "number" && typeof y === "number" ? f(x, y) : null;
      });
    }
    case "abs":
    case "round":
    case "floor":
    case "ceil":
    case "sqrt":
    case "ln":
    case "log10":
    case "log2":
    case "sin":
    case "cos":
    case "tan": {
      need(1, 1);
      const a = sub(args[0]);
      const f = UNARY[op]!;
      return combine([a], (ctx) => {
        const x = a.fn(ctx);
        return typeof x === "number" ? f(x) : null;
      });
    }
    case "pi":
      return constant(Math.PI);
    case "e":
      return constant(Math.E);
    case "concat": {
      const nodes = many(args);
      return combine(nodes, (ctx) => nodes.map((n) => stringify(n.fn(ctx))).join(""));
    }
    case "upcase":
    case "downcase": {
      need(1, 1);
      const a = sub(args[0]);
      const up = op === "upcase";
      return combine([a], (ctx) => {
        const s = stringify(a.fn(ctx));
        return up ? s.toLocaleUpperCase() : s.toLocaleLowerCase();
      });
    }
    case "length": {
      need(1, 1);
      const a = sub(args[0]);
      return combine([a], (ctx) => {
        const v = a.fn(ctx);
        if (typeof v === "string") return [...v].length;
        if (Array.isArray(v)) return v.length;
        return null;
      });
    }
    case "slice": {
      need(2, 3);
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        const v = nodes[0]!.fn(ctx);
        const start = nodes[1]!.fn(ctx);
        const end = nodes[2]?.fn(ctx);
        if (typeof start !== "number") return null;
        const e = typeof end === "number" ? end : undefined;
        if (typeof v === "string") return [...v].slice(start, e).join("");
        if (Array.isArray(v)) return v.slice(start, e);
        return null;
      });
    }
    case "to-string": {
      need(1, 1);
      const a = sub(args[0]);
      return combine([a], (ctx) => stringify(a.fn(ctx)));
    }
    case "to-number": {
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        for (const n of nodes) {
          const v = n.fn(ctx);
          if (typeof v === "number") return v;
          if (typeof v === "boolean") return v ? 1 : 0;
          if (typeof v === "string" && v.trim() !== "") {
            const num = Number(v);
            if (Number.isFinite(num)) return num;
          }
        }
        return null;
      });
    }
    case "to-boolean": {
      need(1, 1);
      const a = sub(args[0]);
      return combine([a], (ctx) => {
        const v = a.fn(ctx);
        return v !== null && v !== undefined && v !== false && v !== 0 && v !== "" && !Number.isNaN(v);
      });
    }
    case "to-color": {
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        for (const n of nodes) {
          const v = n.fn(ctx);
          if (isColor(v)) return v;
          if (typeof v === "string") {
            const c = parseColor(v);
            if (c) return c;
          }
        }
        return null;
      });
    }
    case "rgb":
    case "rgba": {
      need(op === "rgb" ? 3 : 4, op === "rgb" ? 3 : 4);
      const nodes = many(args);
      return combine(nodes, (ctx) => {
        const v = nodes.map((n) => n.fn(ctx));
        if (v.some((c) => typeof c !== "number")) return null;
        const [r, g, b, a] = v as number[];
        return [r! / 255, g! / 255, b! / 255, a ?? 1] satisfies RGBA;
      });
    }
    case "typeof": {
      need(1, 1);
      const a = sub(args[0]);
      return combine([a], (ctx) => {
        const v = a.fn(ctx);
        if (v === null || v === undefined) return "null";
        if (Array.isArray(v)) return "array";
        return typeof v;
      });
    }
    default:
      throw new ExpressionError(`${scope.path}: unknown operator "${op}"`);
  }
}

const UNARY: Record<string, (x: number) => number> = {
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

function comparator(op: string): (a: number, b: number) => boolean {
  switch (op) {
    case "<":
      return (a, b) => a < b;
    case "<=":
      return (a, b) => a <= b;
    case ">":
      return (a, b) => a > b;
    default:
      return (a, b) => a >= b;
  }
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

type ColorSpace = "rgb" | "lab" | "hcl";

function buildInterpolate(
  args: unknown[],
  scope: Scope,
  combine: (nodes: Node[], fn: Fn) => Node,
  sub: (v: unknown) => Node,
  space: ColorSpace,
): Node {
  if (args.length < 4 || args.length % 2 !== 0) {
    throw new ExpressionError(`${scope.path}: "interpolate" expects a type, an input and stop/output pairs`);
  }
  const type = args[0];
  if (!Array.isArray(type) || typeof type[0] !== "string") {
    throw new ExpressionError(
      `${scope.path}: "interpolate" type must be ["linear"], ["exponential", base] or ["cubic-bezier", x1, y1, x2, y2]`,
    );
  }
  let curve: (t: number, lo: number, hi: number, x: number) => number;
  if (type[0] === "linear") {
    curve = (t) => t;
  } else if (type[0] === "exponential") {
    const base = typeof type[1] === "number" ? type[1] : 1;
    curve = (_t, lo, hi, x) => exponentialT(x, base, lo, hi);
  } else if (type[0] === "cubic-bezier") {
    const [x1, y1, x2, y2] = type.slice(1) as number[];
    const bez = cubicBezier(x1 ?? 0, y1 ?? 0, x2 ?? 1, y2 ?? 1);
    curve = (t) => bez(t);
  } else {
    throw new ExpressionError(`${scope.path}: unknown interpolation "${String(type[0])}"`);
  }
  const input = sub(args[1]);
  const stops: number[] = [];
  const outs: Node[] = [];
  for (let i = 2; i < args.length; i += 2) {
    const stop = args[i];
    if (typeof stop !== "number") throw new ExpressionError(`${scope.path}: "interpolate" stops must be numbers`);
    if (stops.length > 0 && stop <= stops[stops.length - 1]!) {
      throw new ExpressionError(`${scope.path}: "interpolate" stops must increase`);
    }
    stops.push(stop);
    outs.push(sub(args[i + 1]));
  }
  return combine([input, ...outs], (ctx) => {
    const x = input.fn(ctx);
    if (typeof x !== "number") return null;
    const n = stops.length;
    if (x <= stops[0]!) return outs[0]!.fn(ctx);
    if (x >= stops[n - 1]!) return outs[n - 1]!.fn(ctx);
    let i = 0;
    while (i < n - 1 && x > stops[i + 1]!) i++;
    const lo = stops[i]!;
    const hi = stops[i + 1]!;
    const t = curve((x - lo) / (hi - lo), lo, hi, x);
    return mix(outs[i]!.fn(ctx), outs[i + 1]!.fn(ctx), t, space);
  });
}

function hslToRgba(h: number, s: number, l: number, a: number): RGBA {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.min(1, Math.max(0, s));
  const light = Math.min(1, Math.max(0, l));
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number) => {
    const k = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (k < 1 / 6) return p + (q - p) * 6 * k;
    if (k < 1 / 2) return q;
    if (k < 2 / 3) return p + (q - p) * (2 / 3 - k) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3), Math.min(1, Math.max(0, a))];
}

function rgbaToHsla(c: RGBA): [number, number, number, number] {
  const [r, g, b, a] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100, a];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100, a];
}

const LAB_WHITE = [0.95047, 1, 1.08883] as const;

function toLab(c: RGBA): [number, number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const r = lin(c[0]);
  const g = lin(c[1]);
  const b = lin(c[2]);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / LAB_WHITE[0]);
  const y = f((0.2126729 * r + 0.7151522 * g + 0.072175 * b) / LAB_WHITE[1]);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / LAB_WHITE[2]);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z), c[3]];
}

function fromLab(l: number, a: number, b: number, alpha: number): RGBA {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (t - 16 / 116) / (24389 / 27 / 116));
  const x = inv(fx) * LAB_WHITE[0];
  const y = inv(fy) * LAB_WHITE[1];
  const z = inv(fz) * LAB_WHITE[2];
  const gamma = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  return [
    gamma(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    gamma(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    gamma(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
    alpha,
  ];
}

function mixInSpace(a: RGBA, b: RGBA, t: number, space: ColorSpace): RGBA {
  const la = toLab(a);
  const lb = toLab(b);
  const alpha = a[3] + (b[3] - a[3]) * t;
  if (space === "lab") {
    return fromLab(la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t, alpha);
  }
  const ca = Math.hypot(la[1], la[2]);
  const cb = Math.hypot(lb[1], lb[2]);
  let ha = Math.atan2(la[2], la[1]);
  let hb = Math.atan2(lb[2], lb[1]);
  if (ca < 1e-6) ha = hb;
  if (cb < 1e-6) hb = ha;
  let dh = hb - ha;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  const h = ha + dh * t;
  const c = ca + (cb - ca) * t;
  return fromLab(la[0] + (lb[0] - la[0]) * t, c * Math.cos(h), c * Math.sin(h), alpha);
}

function exponentialT(x: number, base: number, lo: number, hi: number): number {
  const range = hi - lo;
  const progress = x - lo;
  if (range === 0) return 0;
  if (base === 1) return progress / range;
  return (base ** progress - 1) / (base ** range - 1);
}

function mix(a: unknown, b: unknown, t: number, space: ColorSpace): unknown {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
  const ca = typeof a === "string" ? parseColor(a) : isColor(a) ? a : null;
  const cb = typeof b === "string" ? parseColor(b) : isColor(b) ? b : null;
  if (ca && cb) return space === "rgb" ? mixColor(ca, cb, t) : mixInSpace(ca, cb, t, space);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.map((v, i) => (typeof v === "number" && typeof b[i] === "number" ? v + ((b[i] as number) - v) * t : v));
  }
  return t < 0.5 ? a : b;
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) break;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    if (t < 0 || t > 1 || Math.abs(sampleX(t) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        const v = sampleX(t);
        if (Math.abs(v - x) < 1e-6) break;
        if (v < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sampleY(t);
  };
}
