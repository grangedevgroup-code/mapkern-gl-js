import type { Rect } from "./tile.ts";

export type Ring = Float64Array;
export type Stride = 2 | 3;

export const ALWAYS_KEEP = Number.POSITIVE_INFINITY;

export function signedArea(ring: ArrayLike<number>, stride: Stride = 2): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - stride; i < n; j = i, i += stride) {
    sum += (ring[j]! - ring[i]!) * (ring[i + 1]! + ring[j + 1]!);
  }
  return sum / 2;
}

export function ringBounds(ring: ArrayLike<number>, stride: Stride = 2): Rect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < ring.length; i += stride) {
    const x = ring[i]!;
    const y = ring[i + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function pointInRing(x: number, y: number, ring: ArrayLike<number>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i]!,
      yi = ring[i + 1]!,
      xj = ring[j]!,
      yj = ring[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function reverseRing(ring: Ring, stride: Stride = 2): Ring {
  const out = new Float64Array(ring.length);
  for (let i = 0, j = ring.length - stride; i < ring.length; i += stride, j -= stride) {
    for (let k = 0; k < stride; k++) out[i + k] = ring[j + k]!;
  }
  return out;
}

export function clipRing(ring: ArrayLike<number>, r: Rect, stride: Stride = 2): Float64Array | null {
  let pts: number[] = Array.from(ring);
  const last = pts.length - stride;
  if (pts.length >= 2 * stride && pts[0] === pts[last] && pts[1] === pts[last + 1]) pts.length = last;
  for (let edge = 0; edge < 4; edge++) {
    if (pts.length < 3 * stride) return null;
    const out: number[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i += stride) {
      const a = (i - stride + n) % n;
      const ax = pts[a]!,
        ay = pts[a + 1]!;
      const bx = pts[i]!,
        by = pts[i + 1]!;
      const ina = inside(edge, ax, ay, r);
      const inb = inside(edge, bx, by, r);
      if (inb) {
        if (!ina) intersect(edge, ax, ay, bx, by, r, out, stride);
        for (let k = 0; k < stride; k++) out.push(pts[i + k]!);
      } else if (ina) {
        intersect(edge, ax, ay, bx, by, r, out, stride);
      }
    }
    pts = out;
  }
  if (pts.length < 3 * stride) return null;
  for (let k = 0; k < stride; k++) pts.push(pts[k]!);
  return Float64Array.from(pts);
}

function inside(edge: number, x: number, y: number, r: Rect): boolean {
  switch (edge) {
    case 0:
      return x >= r.x0;
    case 1:
      return x <= r.x1;
    case 2:
      return y >= r.y0;
    default:
      return y <= r.y1;
  }
}

function intersect(
  edge: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: Rect,
  out: number[],
  stride: Stride,
): void {
  let t: number;
  switch (edge) {
    case 0:
      t = (r.x0 - ax) / (bx - ax);
      out.push(r.x0, ay + (by - ay) * t);
      break;
    case 1:
      t = (r.x1 - ax) / (bx - ax);
      out.push(r.x1, ay + (by - ay) * t);
      break;
    case 2:
      t = (r.y0 - ay) / (by - ay);
      out.push(ax + (bx - ax) * t, r.y0);
      break;
    default:
      t = (r.y1 - ay) / (by - ay);
      out.push(ax + (bx - ax) * t, r.y1);
      break;
  }
  if (stride === 3) out.push(ALWAYS_KEEP);
}

export function clipLine(line: ArrayLike<number>, r: Rect, stride: Stride = 2): Float64Array[] {
  const out: Float64Array[] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length >= 2 * stride) out.push(Float64Array.from(current));
    current = [];
  };
  for (let i = 0; i + 2 * stride - 1 < line.length; i += stride) {
    const j = i + stride;
    const seg = clipSegment(line[i]!, line[i + 1]!, line[j]!, line[j + 1]!, r);
    if (!seg) {
      flush();
      continue;
    }
    const [ax, ay, bx, by, enteredClipped, exitedClipped] = seg;
    if (
      current.length === 0 ||
      enteredClipped ||
      current[current.length - stride] !== ax ||
      current[current.length - stride + 1] !== ay
    ) {
      flush();
      current.push(ax, ay);
      if (stride === 3) current.push(enteredClipped ? ALWAYS_KEEP : line[i + 2]!);
    }
    current.push(bx, by);
    if (stride === 3) current.push(exitedClipped ? ALWAYS_KEEP : line[j + 2]!);
    if (exitedClipped) flush();
  }
  flush();
  return out;
}

export function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: Rect,
): [number, number, number, number, boolean, boolean] | null {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return null;
    } else {
      const t = qi / pi;
      if (pi < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1, t0 > 0, t1 < 1];
}

export function simplify(points: ArrayLike<number>, tolerance: number, closed: boolean): Float64Array {
  const n = points.length / 2;
  if (n <= 2 || tolerance <= 0) return Float64Array.from(points);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const sq = tolerance * tolerance;
  const stack: number[] = [0, n - 1];
  if (closed && n > 3) {
    let far = 1;
    let best = -1;
    const x0 = points[0]!,
      y0 = points[1]!;
    for (let i = 1; i < n - 1; i++) {
      const d = (points[i * 2]! - x0) ** 2 + (points[i * 2 + 1]! - y0) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    keep[far] = 1;
    stack.length = 0;
    stack.push(0, far, far, n - 1);
  }
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    let maxD = -1;
    let index = -1;
    const ax = points[first * 2]!,
      ay = points[first * 2 + 1]!;
    const bx = points[last * 2]!,
      by = points[last * 2 + 1]!;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(points[i * 2]!, points[i * 2 + 1]!, ax, ay, bx, by);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > sq && index > 0) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) if (keep[i]) count++;
  const out = new Float64Array(count * 2);
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out[o++] = points[i * 2]!;
    out[o++] = points[i * 2 + 1]!;
  }
  return out;
}

export function rankVertices(points: Float64Array): void {
  const n = points.length / 3;
  if (n === 0) return;
  for (let i = 0; i < n; i++) points[i * 3 + 2] = 0;
  points[2] = ALWAYS_KEEP;
  points[(n - 1) * 3 + 2] = ALWAYS_KEEP;
  const stack: number[] = [0, n - 1, ALWAYS_KEEP];
  while (stack.length > 0) {
    const limit = stack.pop()!;
    const last = stack.pop()!;
    const first = stack.pop()!;
    if (last - first < 2) continue;
    const ax = points[first * 3]!,
      ay = points[first * 3 + 1]!;
    const bx = points[last * 3]!,
      by = points[last * 3 + 1]!;
    const middle = (first + last) / 2;
    let best = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(points[i * 3]!, points[i * 3 + 1]!, ax, ay, bx, by);
      if (d > best || (d === best && index >= 0 && Math.abs(i - middle) < Math.abs(index - middle))) {
        best = d;
        index = i;
      }
    }
    if (index < 0) continue;
    const rank = Math.min(best, limit);
    points[index * 3 + 2] = rank;
    stack.push(first, index, rank, index, last, rank);
  }
}

export function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  let x = ax;
  let y = ay;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = bx;
      y = by;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  return (px - x) ** 2 + (py - y) ** 2;
}
