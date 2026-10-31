import { bearing as edgeBearing, meters } from "./graph.ts";
import type { RouteStep } from "./guidance.ts";
import type { Route } from "./router.ts";

export interface NavigationFix {
  lng: number;
  lat: number;
  heading?: number | null;
  speed?: number | null;
  accuracy?: number | null;
  time?: number;
}

export interface NavigationState {
  position: [number, number];
  heading: number;
  along: number;
  offset: number;
  step: number;
  nextStep: RouteStep | null;
  distanceToManeuver: number;
  remainingDistance: number;
  remainingDuration: number;
  offRoute: boolean;
  arrived: boolean;
}

export interface NavigationAnnouncement {
  step: number;
  stage: "start" | "far" | "near" | "now";
  text: string;
}

export interface NavigatorOptions {
  offRouteMeters?: number;
  arriveMeters?: number;
  units?: "metric" | "imperial";
}

interface Flat {
  points: [number, number][];
  cumulative: number[];
  stepStart: number[];
  total: number;
}

export class Navigator {
  readonly route: Route;
  private readonly options: Required<NavigatorOptions>;
  private readonly flat: Flat;
  private readonly steps: RouteStep[];
  private segment = 0;
  private along = 0;
  private strikes = 0;
  private heard = new Set<string>();
  private arrived = false;

  constructor(route: Route, options: NavigatorOptions = {}) {
    this.route = route;
    this.options = {
      offRouteMeters: options.offRouteMeters ?? 40,
      arriveMeters: options.arriveMeters ?? 25,
      units: options.units ?? "metric",
    };
    this.steps = route.legs.flatMap((l) => l.steps);
    this.flat = flatten(route, this.steps);
  }

  get totalDistance(): number {
    return this.flat.total;
  }

  pointAt(along: number): [number, number] {
    const f = this.flat;
    const d = Math.max(0, Math.min(f.total, along));
    let i = upper(f.cumulative, d);
    i = Math.max(1, Math.min(f.points.length - 1, i));
    const span = f.cumulative[i]! - f.cumulative[i - 1]!;
    const t = span > 0 ? (d - f.cumulative[i - 1]!) / span : 0;
    const a = f.points[i - 1]!;
    const b = f.points[i]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  headingAt(along: number): number {
    const f = this.flat;
    let i = upper(f.cumulative, Math.max(0, Math.min(f.total, along)));
    i = Math.max(1, Math.min(f.points.length - 1, i));
    while (i < f.points.length - 1 && f.cumulative[i]! - f.cumulative[i - 1]! < 0.5) i++;
    const a = f.points[i - 1]!;
    const b = f.points[i]!;
    return edgeBearing(a[0] * 1e7, a[1] * 1e7, b[0] * 1e7, b[1] * 1e7);
  }

  update(fix: NavigationFix): NavigationState {
    const f = this.flat;
    const here: [number, number] = [fix.lng, fix.lat];
    const accuracy = Math.max(0, fix.accuracy ?? 0);
    const from = Math.max(0, upper(f.cumulative, this.along - 60) - 1);
    const reach = this.along + Math.max(400, (fix.speed ?? 0) * 20);
    let best = Infinity;
    let bestAlong = this.along;
    let bestSegment = this.segment;
    for (let i = from + 1; i < f.points.length; i++) {
      if (f.cumulative[i - 1]! > reach) break;
      const hit = project(here, f.points[i - 1]!, f.points[i]!);
      let d = hit.distance;
      if (fix.heading != null && Number.isFinite(fix.heading) && (fix.speed ?? 0) > 2) {
        const seg = edgeBearing(
          f.points[i - 1]![0] * 1e7,
          f.points[i - 1]![1] * 1e7,
          f.points[i]![0] * 1e7,
          f.points[i]![1] * 1e7,
        );
        if (angle(seg, fix.heading) > 100) d += 30;
      }
      if (d < best) {
        best = d;
        bestSegment = i - 1;
        bestAlong = f.cumulative[i - 1]! + hit.t * (f.cumulative[i]! - f.cumulative[i - 1]!);
      }
    }
    const limit = this.options.offRouteMeters + Math.min(accuracy, 60);
    if (best > limit) this.strikes++;
    else this.strikes = 0;
    if (best <= limit && bestAlong >= this.along - 60) {
      this.along = Math.max(this.along - 5, bestAlong);
      this.segment = bestSegment;
    }
    const offRoute = this.strikes >= 2;
    const remaining = Math.max(0, f.total - this.along);
    if (!this.arrived && remaining <= this.options.arriveMeters + Math.min(accuracy, 30)) this.arrived = true;
    const step = this.stepAt(this.along);
    const next = this.steps[step + 1] ?? null;
    const maneuverAt = f.stepStart[step + 1] ?? f.total;
    const heading = this.headingAt(this.along);
    return {
      position: this.pointAt(this.along),
      heading,
      along: this.along,
      offset: best,
      step,
      nextStep: next,
      distanceToManeuver: Math.max(0, maneuverAt - this.along),
      remainingDistance: remaining,
      remainingDuration: this.remainingDuration(this.along),
      offRoute,
      arrived: this.arrived,
    };
  }

  announcements(state: NavigationState, speed = 0): NavigationAnnouncement[] {
    const out: NavigationAnnouncement[] = [];
    const say = (step: number, stage: NavigationAnnouncement["stage"], text: string) => {
      const key = `${step}:${stage}`;
      if (this.heard.has(key)) return;
      this.heard.add(key);
      out.push({ step, stage, text });
    };
    if (state.arrived) {
      say(this.steps.length - 1, "now", this.steps[this.steps.length - 1]?.instruction ?? "You have arrived");
      return out;
    }
    const next = state.nextStep;
    if (!next) return out;
    const d = state.distanceToManeuver;
    const v = Math.max(speed, 8);
    const far = Math.max(400, v * 45);
    const near = Math.max(80, v * 10);
    const nowAt = Math.max(15, v * 3);
    const n = state.step + 1;
    if (state.along < 5 && state.step === 0) say(0, "start", this.steps[0]!.instruction);
    if (d <= nowAt) say(n, "now", next.instruction);
    else if (d <= near) say(n, "near", `In ${spokenDistance(d, this.options.units)}, ${lower(next.instruction)}`);
    else if (d <= far && this.stepLength(state.step) > far * 1.2) {
      say(n, "far", `In ${spokenDistance(d, this.options.units)}, ${lower(next.instruction)}`);
    }
    return out;
  }

  private stepLength(step: number): number {
    const f = this.flat;
    return (f.stepStart[step + 1] ?? f.total) - (f.stepStart[step] ?? 0);
  }

  private stepAt(along: number): number {
    const starts = this.flat.stepStart;
    let s = 0;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i]! <= along + 0.5 && i < this.steps.length - 1) s = i;
      else if (starts[i]! > along + 0.5) break;
    }
    return s;
  }

  private remainingDuration(along: number): number {
    const f = this.flat;
    let seconds = 0;
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i]!;
      const start = f.stepStart[i] ?? 0;
      const end = f.stepStart[i + 1] ?? f.total;
      if (end <= along) continue;
      const length = end - start;
      const left = Math.min(length, end - along);
      seconds += length > 0 ? s.duration * (left / length) : 0;
    }
    return seconds;
  }
}

function flatten(route: Route, steps: RouteStep[]): Flat {
  const points: [number, number][] = [];
  const cumulative: number[] = [];
  const stepStart: number[] = [];
  let total = 0;
  for (const step of steps) {
    stepStart.push(total);
    for (const p of step.geometry) {
      const last = points[points.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      if (last) total += meters(last, p);
      points.push(p);
      cumulative.push(total);
    }
  }
  if (points.length === 1) {
    points.push(points[0]!);
    cumulative.push(total);
  }
  if (points.length === 0) {
    const g = route.geometry[0] ?? [0, 0];
    points.push(g, g);
    cumulative.push(0, 0);
  }
  return { points, cumulative, stepStart, total };
}

function upper(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function project(p: [number, number], a: [number, number], b: [number, number]): { t: number; distance: number } {
  const k = Math.cos(p[1] * (Math.PI / 180));
  const ax = a[0] * k;
  const bx = b[0] * k;
  const px = p[0] * k;
  const dx = bx - ax;
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, distance: meters(p, q) };
}

function angle(a: number, b: number): number {
  const d = Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  return d;
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function spokenDistance(m: number, units: "metric" | "imperial" = "metric"): string {
  if (units === "imperial") {
    const feet = m * 3.28084;
    if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} feet`;
    const miles = m / 1609.344;
    if (miles < 0.4) return "a quarter mile";
    if (miles < 0.65) return "half a mile";
    if (miles < 1.1) return "1 mile";
    return `${Math.round(miles)} miles`;
  }
  if (m < 1000) return `${Math.max(10, Math.round(m / (m < 200 ? 10 : 50)) * (m < 200 ? 10 : 50))} meters`;
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1).replace(/\.0$/, "")} kilometers` : `${Math.round(km)} kilometers`;
}

export function simulateFixes(navigator: Navigator, speedOf: (along: number) => number, hz = 1): NavigationFix[] {
  const fixes: NavigationFix[] = [];
  let along = 0;
  let time = 0;
  const total = navigator.totalDistance;
  while (along < total) {
    const speed = speedOf(along);
    const p = navigator.pointAt(along);
    fixes.push({ lng: p[0], lat: p[1], heading: navigator.headingAt(along), speed, accuracy: 5, time });
    along += speed / hz;
    time += 1000 / hz;
  }
  const end = navigator.pointAt(total);
  fixes.push({ lng: end[0], lat: end[1], speed: 0, accuracy: 5, time });
  return fixes;
}
