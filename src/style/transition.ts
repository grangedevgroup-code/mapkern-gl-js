import type { RGBA } from "./color.ts";
import type { Compiled, EvalContext } from "./expression.ts";

export interface TransitionSpec {
  duration?: number;
  delay?: number;
}

export interface Timing {
  duration: number;
  delay: number;
}

const NONE: ReadonlySet<string> = new Set();

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Transition implements Compiled<unknown> {
  readonly featureDependent = false;
  readonly stateDependent = false;
  readonly constant = false;
  readonly properties = NONE;
  readonly zoomDependent: boolean;
  readonly evaluate: (ctx: EvalContext) => unknown;
  readonly target: Compiled<unknown>;
  readonly end: number;
  private prior: Compiled<unknown>;

  constructor(
    kind: "number" | "color",
    prior: Compiled<unknown>,
    target: Compiled<unknown>,
    begin: number,
    end: number,
    clock: () => number,
  ) {
    this.prior = prior;
    this.target = target;
    this.end = end;
    this.zoomDependent = prior.zoomDependent || target.zoomDependent;
    this.evaluate = (ctx) => {
      const now = clock();
      if (now >= end) return target.evaluate(ctx);
      this.prior = settled(this.prior, now);
      const from = this.prior.evaluate(ctx);
      if (now <= begin) return from;
      return blend(kind, from, target.evaluate(ctx), ease((now - begin) / (end - begin)));
    };
  }
}

export function settled(value: Compiled<unknown>, now: number): Compiled<unknown> {
  let out = value;
  while (out instanceof Transition && now >= out.end) out = out.target;
  return out;
}

export function timing(spec: TransitionSpec | undefined): Timing | null {
  if (!spec) return null;
  const duration = spec.duration ?? 300;
  const delay = spec.delay ?? 0;
  return duration > 0 || delay > 0 ? { duration, delay } : null;
}

export function checkTransition(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be { duration, delay }";
  for (const [key, v] of Object.entries(value)) {
    if (key !== "duration" && key !== "delay") return `"${key}" is not part of a transition, use duration and delay`;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `${key} must be a number of milliseconds >= 0`;
  }
  return null;
}

export function blend(kind: "number" | "color", a: unknown, b: unknown, t: number): unknown {
  if (kind === "number") return typeof a === "number" && typeof b === "number" ? a + (b - a) * t : b;
  if (!isColor(a) || !isColor(b)) return b;
  const alpha = a[3] + (b[3] - a[3]) * t;
  if (alpha <= 0) return [0, 0, 0, 0];
  const out: RGBA = [0, 0, 0, alpha];
  for (let i = 0; i < 3; i++) {
    const from = a[i]! * a[3];
    out[i] = (from + (b[i]! * b[3] - from) * t) / alpha;
  }
  return out;
}

function isColor(v: unknown): v is RGBA {
  return Array.isArray(v) && v.length === 4;
}
