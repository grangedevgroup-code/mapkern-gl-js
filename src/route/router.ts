import type { RouteProfile, Snap } from "./graph.ts";
import { meters, RouteGraph } from "./graph.ts";
import { buildSteps, type RouteStep } from "./guidance.ts";

export type { RouteProfile } from "./graph.ts";
export type { RouteManeuver, RouteStep } from "./guidance.ts";

export type LngLatLike = [number, number] | { lng: number; lat: number };

export interface RouteOptions {
  profile?: RouteProfile;
  snapRadius?: number;
}

export interface RouteLeg {
  distance: number;
  duration: number;
  steps: RouteStep[];
}

export interface Route {
  distance: number;
  duration: number;
  geometry: [number, number][];
  legs: RouteLeg[];
  waypoints: { location: [number, number]; distance: number; name: string }[];
}

export interface PathPiece {
  edge: number;
  coords: [number, number][];
  length: number;
  seconds: number;
}

const MAX_SPEED: Record<RouteProfile, number> = { car: 130 / 3.6, bike: 25 / 3.6, foot: 6 / 3.6 };

class Heap {
  keys = new Float64Array(1024);
  vals = new Int32Array(1024);
  size = 0;

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.keys[i] = this.keys[p]!;
      this.vals[i] = this.vals[p]!;
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  pop(): number {
    const top = this.vals[0]!;
    const n = --this.size;
    const key = this.keys[n]!;
    const val = this.vals[n]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.keys[c + 1]! < this.keys[c]!) c++;
      if (this.keys[c]! >= key) break;
      this.keys[i] = this.keys[c]!;
      this.vals[i] = this.vals[c]!;
      i = c;
    }
    this.keys[i] = key;
    this.vals[i] = val;
    return top;
  }

  get minKey(): number {
    return this.keys[0]!;
  }
}

export class Router {
  readonly graph: RouteGraph;
  private readonly dist: Float64Array;
  private readonly prev: Int32Array;
  private readonly touched: Int32Array;
  private touchedCount = 0;
  lastSettled = 0;

  constructor(graph: RouteGraph) {
    this.graph = graph;
    const states = graph.edges * 2;
    this.dist = new Float64Array(states).fill(Infinity);
    this.prev = new Int32Array(states).fill(-1);
    this.touched = new Int32Array(states);
  }

  route(points: readonly LngLatLike[], options: RouteOptions = {}): Route | null {
    const profile = options.profile ?? "car";
    if (points.length < 2) throw new Error("A route needs at least two points");
    const snaps: Snap[] = [];
    for (const p of points) {
      const [lng, lat] = Array.isArray(p) ? p : [p.lng, p.lat];
      const snap = this.graph.snap(lng, lat, profile, options.snapRadius ?? 2000);
      if (!snap) return null;
      snaps.push(snap);
    }
    const legs: RouteLeg[] = [];
    const geometry: [number, number][] = [];
    let distance = 0;
    let duration = 0;
    for (let i = 0; i + 1 < snaps.length; i++) {
      const pieces = this.leg(snaps[i]!, snaps[i + 1]!, profile);
      if (!pieces) return null;
      const steps = buildSteps(this.graph, pieces, profile, i + 2 === snaps.length);
      const legDistance = pieces.reduce((s, p) => s + p.length, 0);
      const legDuration = pieces.reduce((s, p) => s + p.seconds, 0);
      legs.push({ distance: legDistance, duration: legDuration, steps });
      distance += legDistance;
      duration += legDuration;
      for (const piece of pieces) {
        for (const c of piece.coords) {
          const last = geometry[geometry.length - 1];
          if (!last || last[0] !== c[0] || last[1] !== c[1]) geometry.push(c);
        }
      }
    }
    return {
      distance,
      duration,
      geometry,
      legs,
      waypoints: snaps.map((s) => ({
        location: s.point,
        distance: s.distance,
        name: this.graph.name(s.edge),
      })),
    };
  }

  leg(from: Snap, to: Snap, profile: RouteProfile): PathPiece[] | null {
    const g = this.graph;
    const costs = g.edgeCosts(profile);
    const dist = this.dist;
    const prev = this.prev;
    this.reset();
    const heap = new Heap();
    const target = to.point;
    const speed = MAX_SPEED[profile];
    const kLat = Math.cos(target[1] * (Math.PI / 180));
    const nodeLon = g.data.nodeLon;
    const nodeLat = g.data.nodeLat;
    const heuristic = (d: number) => {
      const node = g.head(d);
      const dx = (nodeLon[node]! * 1e-7 - target[0]) * kLat;
      const dy = nodeLat[node]! * 1e-7 - target[1];
      return (Math.hypot(dx, dy) * 111195) / speed;
    };
    const fromCost = costs[from.edge]!;
    const toCost = costs[to.edge]!;
    let best = Infinity;
    let bestState = -2;
    let bestDirect = false;
    const fwd = from.edge * 2;
    const bwd = fwd + 1;
    if (from.edge === to.edge) {
      if (to.fraction >= from.fraction && g.allowed(fwd, profile)) {
        best = (to.fraction - from.fraction) * fromCost;
        bestDirect = true;
        bestState = fwd;
      }
      if (to.fraction <= from.fraction && g.allowed(bwd, profile)) {
        const c = (from.fraction - to.fraction) * fromCost;
        if (c < best) {
          best = c;
          bestDirect = true;
          bestState = bwd;
        }
      }
    }
    const seed = (d: number, cost: number) => {
      if (!g.allowed(d, profile)) return;
      this.touch(d);
      dist[d] = cost;
      prev[d] = -1;
      heap.push(cost + heuristic(d), d);
    };
    seed(fwd, (1 - from.fraction) * fromCost);
    seed(bwd, from.fraction * fromCost);
    const toFwd = to.edge * 2;
    const toBwd = toFwd + 1;
    let settled = 0;
    while (heap.size > 0) {
      if (heap.minKey >= best) break;
      const d = heap.pop();
      const base = dist[d]!;
      settled++;
      const node = g.head(d);
      const end = g.outStart[node + 1]!;
      for (let i = g.outStart[node]!; i < end; i++) {
        const next = g.outList[i]!;
        if (!g.allowed(next, profile)) continue;
        if (next === (d ^ 1) && !g.uTurnAllowed(d, profile)) continue;
        if (!g.turnAllowed(d, next, profile)) continue;
        const turn = g.turnCost(d, next, profile);
        if (next === toFwd || next === toBwd) {
          const partial = next === toFwd ? to.fraction * toCost : (1 - to.fraction) * toCost;
          const total = base + turn + partial;
          if (total < best) {
            best = total;
            bestState = d;
            bestDirect = false;
            this.endState = next;
          }
        }
        const cost = base + turn + costs[next >> 1]!;
        if (cost < dist[next]!) {
          if (dist[next] === Infinity) this.touch(next);
          dist[next] = cost;
          prev[next] = d;
          heap.push(cost + heuristic(next), next);
        }
      }
    }
    this.lastSettled = settled;
    if (bestState === -2) return null;
    if (bestDirect) {
      const forward = bestState === fwd;
      const a = forward ? from.fraction : 1 - from.fraction;
      const b = forward ? to.fraction : 1 - to.fraction;
      return [this.piece(bestState, a, b, best)];
    }
    const chain: number[] = [];
    for (let d = bestState; d !== -1; d = prev[d]!) chain.push(d);
    chain.reverse();
    const pieces: PathPiece[] = [];
    const first = chain[0]!;
    const startAt = first & 1 ? 1 - from.fraction : from.fraction;
    for (let i = 0; i < chain.length; i++) {
      const d = chain[i]!;
      const cost = costs[d >> 1]!;
      const a = i === 0 ? startAt : 0;
      pieces.push(this.piece(d, a, 1, cost * (1 - a)));
    }
    const last = this.endState;
    const stop = last & 1 ? 1 - to.fraction : to.fraction;
    pieces.push(this.piece(last, 0, stop, toCost * stop));
    for (let i = 1; i < pieces.length; i++) {
      pieces[i]!.seconds += g.turnCost(chain[i - 1] ?? -1, i < chain.length ? chain[i]! : last, profile);
    }
    return pieces.filter((p) => p.coords.length >= 2);
  }

  private endState = -1;

  private piece(d: number, a: number, b: number, seconds: number): PathPiece {
    const coords = slice(this.graph.coords(d), a, b);
    let length = 0;
    for (let i = 1; i < coords.length; i++) length += meters(coords[i - 1]!, coords[i]!);
    return { edge: d, coords, length, seconds };
  }

  private touch(d: number): void {
    this.touched[this.touchedCount++] = d;
  }

  private reset(): void {
    for (let i = 0; i < this.touchedCount; i++) {
      const d = this.touched[i]!;
      this.dist[d] = Infinity;
      this.prev[d] = -1;
    }
    this.touchedCount = 0;
  }
}

export function slice(pts: [number, number][], a: number, b: number): [number, number][] {
  if (pts.length < 2) return pts.slice();
  const kx = Math.cos(pts[0]![1] * (Math.PI / 180));
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) {
    lengths.push(lengths[i - 1]! + Math.hypot((pts[i]![0] - pts[i - 1]![0]) * kx, pts[i]![1] - pts[i - 1]![1]));
  }
  const total = lengths[lengths.length - 1]!;
  if (!(total > 0)) return [pts[0]!, pts[pts.length - 1]!];
  const at = (f: number): [number, number] => {
    const target = f * total;
    for (let i = 1; i < pts.length; i++) {
      if (lengths[i]! >= target) {
        const span = lengths[i]! - lengths[i - 1]!;
        const t = span > 0 ? (target - lengths[i - 1]!) / span : 0;
        const p = pts[i - 1]!;
        const q = pts[i]!;
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      }
    }
    return pts[pts.length - 1]!;
  };
  const out: [number, number][] = [at(a)];
  for (let i = 1; i < pts.length - 1; i++) {
    const f = lengths[i]! / total;
    if (f > a && f < b) out.push(pts[i]!);
  }
  out.push(at(b));
  return out;
}

export async function loadRouter(url: string, init?: RequestInit): Promise<Router> {
  const response = await fetch(url, init);
  if (!response.ok || !response.body) throw new Error(`Could not load the route graph (${response.status})`);
  const bytes = new Uint8Array(await new Response(gunzipIfNeeded(response.body)).arrayBuffer());
  const { decodeRoute } = await import("./format.ts");
  return new Router(new RouteGraph(decodeRoute(bytes)));
}

function gunzipIfNeeded(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let first: Uint8Array | null = null;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const head = await reader.read();
      first = head.value ?? new Uint8Array(0);
      const gz = first.length >= 2 && first[0] === 0x1f && first[1] === 0x8b;
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          if (first && first.length > 0) c.enqueue(first);
          if (head.done) c.close();
        },
        async pull(c) {
          const { done, value } = await reader.read();
          if (done) c.close();
          else c.enqueue(value);
        },
      });
      const out = gz
        ? source.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>)
        : source;
      const r = out.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}
