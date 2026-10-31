import type { RouteData } from "./format.ts";
import {
  BIKE_BACKWARD,
  BIKE_FORWARD,
  CAR_BACKWARD,
  CAR_FORWARD,
  DESTINATION_ONLY,
  FOOT,
  MINOR_SERVICE,
  MODE_BIKE,
  MODE_CAR,
  MODE_FOOT,
  RESTRICT_ONLY,
  ROAD_CLASSES,
} from "./format.ts";

export type RouteProfile = "car" | "bike" | "foot";

const RAD = Math.PI / 180;
const EARTH = 6371008.8;
const CELL = 0.004;

const CAR_SPEED: Record<string, number> = {
  motorway: 100,
  motorway_link: 60,
  trunk: 85,
  trunk_link: 50,
  primary: 65,
  primary_link: 45,
  secondary: 55,
  secondary_link: 40,
  tertiary: 45,
  tertiary_link: 35,
  unclassified: 40,
  residential: 35,
  living_street: 15,
  service: 20,
  road: 30,
};

const BIKE_SPEED: Record<string, number> = {
  trunk: 16,
  trunk_link: 16,
  primary: 17,
  primary_link: 17,
  secondary: 18,
  secondary_link: 18,
  tertiary: 18,
  tertiary_link: 18,
  unclassified: 17,
  residential: 17,
  living_street: 14,
  service: 14,
  road: 15,
  track: 12,
  pedestrian: 8,
  footway: 8,
  path: 13,
  cycleway: 19,
  bridleway: 8,
  steps: 3,
};

export const PROFILE_MODE: Record<RouteProfile, number> = { car: MODE_CAR, bike: MODE_BIKE, foot: MODE_FOOT };

export interface Snap {
  edge: number;
  fraction: number;
  point: [number, number];
  distance: number;
}

interface Restriction {
  to: number;
  only: boolean;
  modes: number;
}

export class RouteGraph {
  readonly data: RouteData;
  readonly nodes: number;
  readonly edges: number;
  readonly outStart: Uint32Array;
  readonly outList: Uint32Array;
  readonly startBearing: Float32Array;
  readonly endBearing: Float32Array;
  readonly classes: string[];
  private readonly restrictions = new Map<number, Restriction[]>();
  private readonly costs = new Map<RouteProfile, Float32Array>();
  private grid: {
    minX: number;
    minY: number;
    cols: number;
    rows: number;
    start: Uint32Array;
    list: Uint32Array;
  } | null = null;

  constructor(data: RouteData) {
    this.data = data;
    this.nodes = data.meta.nodes;
    this.edges = data.meta.edges;
    this.classes = ROAD_CLASSES.slice();
    const counts = new Uint32Array(this.nodes + 1);
    for (let e = 0; e < this.edges; e++) {
      counts[data.edgeFrom[e]!]!++;
      counts[data.edgeTo[e]!]!++;
    }
    const start = new Uint32Array(this.nodes + 1);
    for (let n = 0; n < this.nodes; n++) start[n + 1] = start[n]! + counts[n]!;
    const fill = start.slice(0, this.nodes);
    const list = new Uint32Array(this.edges * 2);
    for (let e = 0; e < this.edges; e++) {
      list[fill[data.edgeFrom[e]!]!++] = e * 2;
      list[fill[data.edgeTo[e]!]!++] = e * 2 + 1;
    }
    this.outStart = start;
    this.outList = list;
    this.startBearing = new Float32Array(this.edges * 2);
    this.endBearing = new Float32Array(this.edges * 2);
    for (let e = 0; e < this.edges; e++) {
      const s = data.shapeStart[e]!;
      const t = data.shapeStart[e + 1]!;
      const ax = data.nodeLon[data.edgeFrom[e]!]!;
      const ay = data.nodeLat[data.edgeFrom[e]!]!;
      const bx = data.nodeLon[data.edgeTo[e]!]!;
      const by = data.nodeLat[data.edgeTo[e]!]!;
      const fx = t > s ? data.shapeLon[s]! : bx;
      const fy = t > s ? data.shapeLat[s]! : by;
      const lx = t > s ? data.shapeLon[t - 1]! : ax;
      const ly = t > s ? data.shapeLat[t - 1]! : ay;
      const forwardStart = bearing(ax, ay, fx, fy);
      const forwardEnd = bearing(lx, ly, bx, by);
      this.startBearing[e * 2] = forwardStart;
      this.endBearing[e * 2] = forwardEnd;
      this.startBearing[e * 2 + 1] = (forwardEnd + 180) % 360;
      this.endBearing[e * 2 + 1] = (forwardStart + 180) % 360;
    }
    for (let r = 0; r < data.meta.restrictions; r++) {
      const via = data.resVia[r]!;
      const f = data.resFrom[r]!;
      const t = data.resTo[r]!;
      const froms: number[] = [];
      if (data.edgeTo[f] === via) froms.push(f * 2);
      if (data.edgeFrom[f] === via) froms.push(f * 2 + 1);
      const tos: number[] = [];
      if (data.edgeFrom[t] === via) tos.push(t * 2);
      if (data.edgeTo[t] === via) tos.push(t * 2 + 1);
      for (const from of froms) {
        let list = this.restrictions.get(from);
        if (!list) {
          list = [];
          this.restrictions.set(from, list);
        }
        for (const to of tos) list.push({ to, only: data.resKind[r] === RESTRICT_ONLY, modes: data.resModes[r]! });
      }
    }
  }

  tail(d: number): number {
    const e = d >> 1;
    return d & 1 ? this.data.edgeTo[e]! : this.data.edgeFrom[e]!;
  }

  head(d: number): number {
    const e = d >> 1;
    return d & 1 ? this.data.edgeFrom[e]! : this.data.edgeTo[e]!;
  }

  degree(node: number): number {
    return this.outStart[node + 1]! - this.outStart[node]!;
  }

  allowed(d: number, profile: RouteProfile): boolean {
    const flags = this.data.edgeFlags[d >> 1]!;
    if (profile === "foot") return (flags & FOOT) !== 0;
    if (profile === "bike") return (flags & (d & 1 ? BIKE_BACKWARD : BIKE_FORWARD)) !== 0;
    return (flags & (d & 1 ? CAR_BACKWARD : CAR_FORWARD)) !== 0;
  }

  usable(e: number, profile: RouteProfile): boolean {
    return this.allowed(e * 2, profile) || this.allowed(e * 2 + 1, profile);
  }

  turnAllowed(from: number, to: number, profile: RouteProfile): boolean {
    const list = this.restrictions.get(from);
    if (!list) return true;
    const mode = PROFILE_MODE[profile];
    let only = false;
    let onlyMatch = false;
    for (const r of list) {
      if ((r.modes & mode) === 0) continue;
      if (r.only) {
        only = true;
        if (r.to === to) onlyMatch = true;
      } else if (r.to === to) {
        return false;
      }
    }
    return !only || onlyMatch;
  }

  edgeCosts(profile: RouteProfile): Float32Array {
    let costs = this.costs.get(profile);
    if (costs) return costs;
    const d = this.data;
    costs = new Float32Array(this.edges);
    for (let e = 0; e < this.edges; e++) {
      const cls = this.classes[d.edgeClass[e]!]!;
      const flags = d.edgeFlags[e]!;
      let kmh: number;
      if (profile === "car") {
        const fallback = CAR_SPEED[cls] ?? 25;
        const posted = d.edgeSpeed[e]!;
        kmh = posted > 0 ? posted * (cls.startsWith("motorway") || cls.startsWith("trunk") ? 0.95 : 0.85) : fallback;
        if (flags & MINOR_SERVICE) kmh *= 0.5;
      } else if (profile === "bike") {
        kmh = BIKE_SPEED[cls] ?? 12;
      } else {
        kmh = cls === "steps" ? 3 : 5;
      }
      let seconds = d.edgeLength[e]! / Math.max(1, (kmh * 1000) / 3600);
      if (profile === "car" && flags & DESTINATION_ONLY) seconds *= 3;
      costs[e] = seconds;
    }
    this.costs.set(profile, costs);
    return costs;
  }

  turnCost(from: number, to: number, profile: RouteProfile): number {
    if (profile === "foot") return 0;
    const node = this.head(from);
    if (to === (from ^ 1)) return profile === "car" ? 20 : 8;
    let delta = this.startBearing[to]! - this.endBearing[from]!;
    delta = ((delta + 540) % 360) - 180;
    const angle = Math.abs(delta);
    const known = this.data.nodeBusy?.[node];
    const busy = known === 0 || known === 1 ? known === 1 : this.degree(node) >= 3;
    if (profile === "bike") return angle > 45 ? 2 : 0;
    let cost = busy ? 1 : 0;
    if (angle > 25) cost += 7.5 * Math.min(1, ((angle - 25) / 65) ** 1.3) * (delta < 0 ? 1.4 : 1);
    return cost;
  }

  uTurnAllowed(from: number, profile: RouteProfile): boolean {
    if (profile !== "car") return true;
    const node = this.head(from);
    let ways = 0;
    for (let i = this.outStart[node]!; i < this.outStart[node + 1]!; i++) {
      if (this.allowed(this.outList[i]!, profile)) ways++;
    }
    return ways <= 1;
  }

  coords(d: number): [number, number][] {
    const data = this.data;
    const e = d >> 1;
    const out: [number, number][] = [
      [data.nodeLon[data.edgeFrom[e]!]! * 1e-7, data.nodeLat[data.edgeFrom[e]!]! * 1e-7],
    ];
    for (let i = data.shapeStart[e]!; i < data.shapeStart[e + 1]!; i++) {
      out.push([data.shapeLon[i]! * 1e-7, data.shapeLat[i]! * 1e-7]);
    }
    out.push([data.nodeLon[data.edgeTo[e]!]! * 1e-7, data.nodeLat[data.edgeTo[e]!]! * 1e-7]);
    if (d & 1) out.reverse();
    return out;
  }

  name(e: number): string {
    const id = this.data.edgeName[e]!;
    return id >= 0 ? (this.data.meta.names[id] ?? "") : "";
  }

  ref(e: number): string {
    const id = this.data.edgeRef[e]!;
    return id >= 0 ? (this.data.meta.names[id] ?? "") : "";
  }

  className(e: number): string {
    return this.classes[this.data.edgeClass[e]!] ?? "road";
  }

  snap(lng: number, lat: number, profile: RouteProfile, maxMeters = 2000): Snap | null {
    const grid = this.index();
    const cx = Math.floor((lng - grid.minX) / CELL);
    const cy = Math.floor((lat - grid.minY) / CELL);
    const kx = Math.cos(lat * RAD);
    let best = null as Snap | null;
    const seen = new Set<number>();
    const maxRing = Math.ceil(maxMeters / (CELL * 111320 * Math.max(0.2, kx))) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        for (let x = cx - ring; x <= cx + ring; x++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
          if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue;
          const cell = y * grid.cols + x;
          for (let i = grid.start[cell]!; i < grid.start[cell + 1]!; i++) {
            const e = grid.list[i]!;
            if (seen.has(e)) continue;
            seen.add(e);
            if (!this.usable(e, profile)) continue;
            const hit = this.project(e, lng, lat, kx);
            if (hit.distance <= maxMeters && (!best || hit.distance < best.distance)) best = hit;
          }
        }
      }
      if (best && best.distance < ring * CELL * 111320 * kx) break;
    }
    return best;
  }

  private project(e: number, lng: number, lat: number, kx: number): Snap {
    const pts = this.coords(e * 2);
    let total = 0;
    const lengths: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot((pts[i]![0] - pts[i - 1]![0]) * kx, pts[i]![1] - pts[i - 1]![1]);
      lengths.push(total);
    }
    let best = Infinity;
    let along = 0;
    let point: [number, number] = pts[0]!;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1]![0];
      const ay = pts[i - 1]![1];
      const dx = (pts[i]![0] - ax) * kx;
      const dy = pts[i]![1] - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((lng - ax) * kx * dx + (lat - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + (dx / kx) * t;
      const py = ay + dy * t;
      const d = Math.hypot((lng - px) * kx, lat - py);
      if (d < best) {
        best = d;
        along = lengths[i - 1]! + Math.sqrt(len2) * t;
        point = [px, py];
      }
    }
    return { edge: e, fraction: total > 0 ? along / total : 0, point, distance: best * RAD * EARTH };
  }

  private index() {
    if (this.grid) return this.grid;
    const d = this.data;
    let w = Infinity;
    let s = Infinity;
    let east = -Infinity;
    let n = -Infinity;
    for (let i = 0; i < this.nodes; i++) {
      const x = d.nodeLon[i]! * 1e-7;
      const y = d.nodeLat[i]! * 1e-7;
      if (x < w) w = x;
      if (x > east) east = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    for (let i = 0; i < d.shapeLon.length; i++) {
      const x = d.shapeLon[i]! * 1e-7;
      const y = d.shapeLat[i]! * 1e-7;
      if (x < w) w = x;
      if (x > east) east = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    if (!(w <= east)) [w, s, east, n] = d.meta.bbox;
    const minX = w - CELL;
    const minY = s - CELL;
    const cols = Math.max(1, Math.ceil((east - minX) / CELL) + 2);
    const rows = Math.max(1, Math.ceil((n - minY) / CELL) + 2);
    const cellsOf = (e: number, visit: (cell: number) => void) => {
      const pts = this.coords(e * 2);
      let last = -1;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[Math.min(i + 1, pts.length - 1)]!;
        const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - minX) / CELL));
        const x1 = Math.min(cols - 1, Math.floor((Math.max(a[0], b[0]) - minX) / CELL));
        const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - minY) / CELL));
        const y1 = Math.min(rows - 1, Math.floor((Math.max(a[1], b[1]) - minY) / CELL));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const cell = y * cols + x;
            if (cell !== last) visit(cell);
            last = cell;
          }
        }
      }
    };
    const counts = new Uint32Array(cols * rows + 1);
    const marks = new Int32Array(cols * rows).fill(-1);
    for (let e = 0; e < this.edges; e++) {
      cellsOf(e, (c) => {
        if (marks[c] === e) return;
        marks[c] = e;
        counts[c]!++;
      });
    }
    const start = new Uint32Array(cols * rows + 1);
    for (let c = 0; c < cols * rows; c++) start[c + 1] = start[c]! + counts[c]!;
    const fill = start.slice(0, cols * rows);
    const list = new Uint32Array(start[cols * rows]!);
    marks.fill(-1);
    for (let e = 0; e < this.edges; e++) {
      cellsOf(e, (c) => {
        if (marks[c] === e) return;
        marks[c] = e;
        list[fill[c]!++] = e;
      });
    }
    this.grid = { minX, minY, cols, rows, start, list };
    return this.grid;
  }
}

export function bearing(ax: number, ay: number, bx: number, by: number): number {
  const p1 = ay * 1e-7 * RAD;
  const p2 = by * 1e-7 * RAD;
  const dl = (bx - ax) * 1e-7 * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export function meters(a: readonly number[], b: readonly number[]): number {
  const p1 = a[1]! * RAD;
  const p2 = b[1]! * RAD;
  const dp = p2 - p1;
  const dl = (b[0]! - a[0]!) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
