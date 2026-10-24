import type { Ring } from "../../src/geo/clip.ts";
import { pointInRing, reverseRing, ringBounds, segmentDistanceSq, signedArea } from "../../src/geo/clip.ts";
import type { Rect } from "../../src/geo/tile.ts";

export {
  clipLine,
  clipRing,
  clipSegment,
  pointInRing,
  reverseRing,
  ringBounds,
  signedArea,
  simplify,
} from "../../src/geo/clip.ts";
export type { Rect, Ring };

export function worldX(lonFixed: number): number {
  return (lonFixed / 1e7 + 180) / 360;
}

export function worldY(latFixed: number): number {
  const lat = Math.max(-85.0511287798066, Math.min(85.0511287798066, latFixed / 1e7));
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export interface Chain {
  refs: number[];
}

export function joinWays(ways: ArrayLike<number>[]): { closed: number[][]; open: number[][] } {
  const used = new Uint8Array(ways.length);
  const byEnd = new Map<number, number[]>();
  const add = (ref: number, i: number) => {
    let list = byEnd.get(ref);
    if (!list) {
      list = [];
      byEnd.set(ref, list);
    }
    list.push(i);
  };
  for (let i = 0; i < ways.length; i++) {
    const w = ways[i]!;
    if (w.length < 2) {
      used[i] = 1;
      continue;
    }
    add(w[0]!, i);
    add(w[w.length - 1]!, i);
  }
  const closed: number[][] = [];
  const open: number[][] = [];
  const take = (ref: number): number => {
    const list = byEnd.get(ref);
    if (!list) return -1;
    for (const i of list) if (!used[i]) return i;
    return -1;
  };
  for (let start = 0; start < ways.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const chain = Array.from(ways[start]!);
    for (;;) {
      if (chain.length > 2 && chain[0] === chain[chain.length - 1]) break;
      const tail = chain[chain.length - 1]!;
      let next = take(tail);
      if (next >= 0) {
        used[next] = 1;
        const w = ways[next]!;
        if (w[0] === tail) for (let k = 1; k < w.length; k++) chain.push(w[k]!);
        else for (let k = w.length - 2; k >= 0; k--) chain.push(w[k]!);
        continue;
      }
      const head = chain[0]!;
      next = take(head);
      if (next >= 0) {
        used[next] = 1;
        const w = ways[next]!;
        const prefix: number[] = [];
        if (w[w.length - 1] === head) for (let k = 0; k < w.length - 1; k++) prefix.push(w[k]!);
        else for (let k = w.length - 1; k > 0; k--) prefix.push(w[k]!);
        chain.unshift(...prefix);
        continue;
      }
      break;
    }
    if (chain.length >= 4 && chain[0] === chain[chain.length - 1]) closed.push(chain);
    else open.push(chain);
  }
  return { closed, open };
}

export interface Polygon {
  outer: Ring;
  holes: Ring[];
}

export function buildPolygons(outerRings: Ring[], innerRings: Ring[]): Polygon[] {
  const polys: Polygon[] = outerRings
    .filter((r) => r.length >= 8)
    .map((r) => ({ outer: signedArea(r) < 0 ? reverseRing(r) : r, holes: [] as Ring[] }));
  const areas = polys.map((p) => Math.abs(signedArea(p.outer)));
  const bounds = polys.map((p) => ringBounds(p.outer));
  for (const inner of innerRings) {
    if (inner.length < 8) continue;
    const hole = signedArea(inner) > 0 ? reverseRing(inner) : inner;
    const x = (hole[0]! + hole[2]!) / 2;
    const y = (hole[1]! + hole[3]!) / 2;
    let best = -1;
    for (let i = 0; i < polys.length; i++) {
      const b = bounds[i]!;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (!pointInRing(x, y, polys[i]!.outer)) continue;
      if (best < 0 || areas[i]! < areas[best]!) best = i;
    }
    if (best >= 0) polys[best]!.holes.push(hole);
  }
  return polys;
}

export function splitRings(rings: Ring[]): { outer: Ring[]; inner: Ring[] } {
  const sorted = rings.filter((r) => r.length >= 8).sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  const outer: Ring[] = [];
  const inner: Ring[] = [];
  const depth = sorted.map(() => 0);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const x = (r[0]! + r[2]!) / 2;
    const y = (r[1]! + r[3]!) / 2;
    let d = 0;
    for (let j = 0; j < i; j++) if (pointInRing(x, y, sorted[j]!)) d = Math.max(d, depth[j]! + 1);
    depth[i] = d;
    if (d % 2 === 0) outer.push(r);
    else inner.push(r);
  }
  return { outer, inner };
}

export function labelPoint(poly: Polygon): [number, number] {
  const b = ringBounds(poly.outer);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (w <= 0 || h <= 0) return [poly.outer[0]!, poly.outer[1]!];
  const distance = (x: number, y: number): number => {
    let min = Infinity;
    const rings = [poly.outer, ...poly.holes];
    for (const ring of rings) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const d = segmentDistanceSq(x, y, ring[i]!, ring[i + 1]!, ring[i + 2]!, ring[i + 3]!);
        if (d < min) min = d;
      }
    }
    const inside = pointInRing(x, y, poly.outer) && !poly.holes.some((hole) => pointInRing(x, y, hole));
    return (inside ? 1 : -1) * Math.sqrt(min);
  };
  let bestX = (b.x0 + b.x1) / 2;
  let bestY = (b.y0 + b.y1) / 2;
  let best = distance(bestX, bestY);
  let cell = Math.max(w, h) / 8;
  let cx0 = b.x0;
  let cy0 = b.y0;
  let cx1 = b.x1;
  let cy1 = b.y1;
  for (let level = 0; level < 6; level++) {
    for (let x = cx0 + cell / 2; x < cx1; x += cell) {
      for (let y = cy0 + cell / 2; y < cy1; y += cell) {
        const d = distance(x, y);
        if (d > best) {
          best = d;
          bestX = x;
          bestY = y;
        }
      }
    }
    cx0 = bestX - cell;
    cy0 = bestY - cell;
    cx1 = bestX + cell;
    cy1 = bestY + cell;
    cell /= 4;
  }
  return [bestX, bestY];
}

export function polygonArea(poly: Polygon): number {
  let a = Math.abs(signedArea(poly.outer));
  for (const h of poly.holes) a -= Math.abs(signedArea(h));
  return Math.max(0, a);
}
