export type Ring = Float64Array;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function worldX(lonFixed: number): number {
  return (lonFixed / 1e7 + 180) / 360;
}

export function worldY(latFixed: number): number {
  const lat = Math.max(-85.0511287798066, Math.min(85.0511287798066, latFixed / 1e7));
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function signedArea(ring: ArrayLike<number>): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    sum += (ring[j]! - ring[i]!) * (ring[i + 1]! + ring[j + 1]!);
  }
  return sum / 2;
}

export function ringBounds(ring: ArrayLike<number>): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
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
    const xi = ring[i]!, yi = ring[i + 1]!, xj = ring[j]!, yj = ring[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function reverseRing(ring: Ring): Ring {
  const out = new Float64Array(ring.length);
  for (let i = 0, j = ring.length - 2; i < ring.length; i += 2, j -= 2) {
    out[i] = ring[j]!;
    out[i + 1] = ring[j + 1]!;
  }
  return out;
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

export function clipRing(ring: ArrayLike<number>, r: Rect): Float64Array | null {
  let pts: number[] = Array.from(ring);
  if (pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
  for (let edge = 0; edge < 4; edge++) {
    if (pts.length < 6) return null;
    const out: number[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i += 2) {
      const ax = pts[(i - 2 + n) % n]!, ay = pts[(i - 1 + n) % n]!;
      const bx = pts[i]!, by = pts[i + 1]!;
      const ina = inside(edge, ax, ay, r);
      const inb = inside(edge, bx, by, r);
      if (inb) {
        if (!ina) intersect(edge, ax, ay, bx, by, r, out);
        out.push(bx, by);
      } else if (ina) {
        intersect(edge, ax, ay, bx, by, r, out);
      }
    }
    pts = out;
  }
  if (pts.length < 6) return null;
  pts.push(pts[0]!, pts[1]!);
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

function intersect(edge: number, ax: number, ay: number, bx: number, by: number, r: Rect, out: number[]): void {
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
}

export function clipLine(line: ArrayLike<number>, r: Rect): Float64Array[] {
  const out: Float64Array[] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length >= 4) out.push(Float64Array.from(current));
    current = [];
  };
  for (let i = 0; i + 3 < line.length; i += 2) {
    const seg = clipSegment(line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!, r);
    if (!seg) {
      flush();
      continue;
    }
    const [ax, ay, bx, by, enteredClipped, exitedClipped] = seg;
    if (current.length === 0 || enteredClipped || current[current.length - 2] !== ax || current[current.length - 1] !== ay) {
      flush();
      current.push(ax, ay);
    }
    current.push(bx, by);
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
    const x0 = points[0]!, y0 = points[1]!;
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
    const ax = points[first * 2]!, ay = points[first * 2 + 1]!;
    const bx = points[last * 2]!, by = points[last * 2 + 1]!;
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

function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
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
