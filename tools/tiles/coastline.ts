import type { Polygon, Rect, Ring } from "./geometry.ts";
import { clipLine, pointInRing, ringBounds, signedArea } from "./geometry.ts";

interface Piece {
  points: number[];
  entry: number;
  exit: number;
  used: boolean;
}

export interface CoastlineResult {
  water: Polygon[];
  droppedPieces: number;
  invertedRings?: number;
}

const EPS = 1e-12;

function perimeter(x: number, y: number, r: Rect): number {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (Math.abs(y - r.y0) <= EPS * 4 && x < r.x1 - EPS) return (x - r.x0) / w;
  if (Math.abs(x - r.x1) <= EPS * 4 && y < r.y1 - EPS) return 1 + (y - r.y0) / h;
  if (Math.abs(y - r.y1) <= EPS * 4 && x > r.x0 + EPS) return 2 + (r.x1 - x) / w;
  if (Math.abs(x - r.x0) <= EPS * 4) return 3 + (r.y1 - y) / h;
  return Number.NaN;
}

function onBoundary(x: number, y: number, r: Rect): boolean {
  return (
    Math.abs(x - r.x0) <= EPS * 4 ||
    Math.abs(x - r.x1) <= EPS * 4 ||
    Math.abs(y - r.y0) <= EPS * 4 ||
    Math.abs(y - r.y1) <= EPS * 4
  );
}

const CORNERS: [number, (r: Rect) => [number, number]][] = [
  [1, (r) => [r.x1, r.y0]],
  [2, (r) => [r.x1, r.y1]],
  [3, (r) => [r.x0, r.y1]],
  [4, (r) => [r.x0, r.y0]],
];

function forward(from: number, to: number): number {
  let d = to - from;
  while (d < 0) d += 4;
  while (d >= 4) d -= 4;
  return d;
}

export function coastlineWater(chains: { coords: Float64Array; closed: boolean }[], r: Rect): CoastlineResult {
  const pieces: Piece[] = [];
  const islands: Ring[] = [];
  const lakes: Ring[] = [];
  let dropped = 0;
  let inverted = 0;
  for (const chain of chains) {
    let coords = chain.coords;
    if (chain.closed) {
      const b = ringBounds(coords);
      if (b.x0 > r.x0 && b.x1 < r.x1 && b.y0 > r.y0 && b.y1 < r.y1) {
        if (signedArea(coords) < 0) islands.push(coords);
        else lakes.push(coords);
        continue;
      }
      if (b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1) continue;
      coords = rotateToOutside(coords, r);
    }
    for (const part of clipLine(coords, r)) {
      const n = part.length;
      const sx = part[0]!,
        sy = part[1]!,
        ex = part[n - 2]!,
        ey = part[n - 1]!;
      if (!onBoundary(sx, sy, r) || !onBoundary(ex, ey, r)) {
        dropped++;
        continue;
      }
      const entry = perimeter(sx, sy, r);
      const exit = perimeter(ex, ey, r);
      if (Number.isNaN(entry) || Number.isNaN(exit)) {
        dropped++;
        continue;
      }
      pieces.push({ points: Array.from(part), entry, exit, used: false });
    }
  }
  const water: Polygon[] = [];
  if (pieces.length === 0) {
    if (islands.length > 0) {
      const outer = Float64Array.from([r.x0, r.y0, r.x1, r.y0, r.x1, r.y1, r.x0, r.y1, r.x0, r.y0]);
      water.push({ outer, holes: islands.slice() });
    }
    for (const lake of lakes) water.push({ outer: lake, holes: [] });
    return { water, droppedPieces: dropped };
  }
  for (const start of pieces) {
    if (start.used) continue;
    start.used = true;
    const ring: number[] = start.points.slice();
    let current = start;
    for (let guard = 0; guard <= pieces.length; guard++) {
      let best: Piece | null = null;
      let bestD = Infinity;
      for (const p of pieces) {
        if (p.used && p !== start) continue;
        const d = forward(current.exit, p.entry);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best) break;
      const t = current.exit;
      const end = t + bestD;
      const corners: [number, number, number][] = [];
      for (const [corner, at] of CORNERS) {
        for (const c of [corner - 4, corner, corner + 4]) {
          if (c > t + EPS && c < end - EPS) {
            const [cx, cy] = at(r);
            corners.push([c, cx, cy]);
          }
        }
      }
      corners.sort((a, b) => a[0] - b[0]);
      for (const [, cx, cy] of corners) ring.push(cx, cy);
      if (best === start) break;
      best.used = true;
      for (let i = 0; i < best.points.length; i++) ring.push(best.points[i]!);
      current = best;
    }
    ring.push(ring[0]!, ring[1]!);
    const outer = Float64Array.from(ring);
    const area = signedArea(outer);
    if (area > 0) water.push({ outer, holes: [] });
    else if (area < 0) inverted++;
  }
  for (const island of islands) {
    const x = island[0]!;
    const y = island[1]!;
    for (const poly of water) {
      if (pointInRing(x, y, poly.outer)) {
        poly.holes.push(island);
        break;
      }
    }
  }
  for (const lake of lakes) water.push({ outer: lake, holes: [] });
  return { water, droppedPieces: dropped, invertedRings: inverted };
}

function rotateToOutside(ring: Float64Array, r: Rect): Float64Array {
  const n = ring.length / 2 - 1;
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2]!;
    const y = ring[i * 2 + 1]!;
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) {
      const out = new Float64Array(ring.length);
      for (let k = 0; k < n; k++) {
        const src = (i + k) % n;
        out[k * 2] = ring[src * 2]!;
        out[k * 2 + 1] = ring[src * 2 + 1]!;
      }
      out[n * 2] = out[0]!;
      out[n * 2 + 1] = out[1]!;
      return out;
    }
  }
  return ring;
}
