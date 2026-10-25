import { ringArea } from "../formats/mvt.ts";

export interface Shape {
  readonly rings: readonly Int32Array[];
  readonly base: number;
  readonly height: number;
}

export interface Outline {
  readonly shape: number;
  readonly parts: readonly number[];
  readonly covered: number;
  readonly reach: number;
}

const CELLS = 32;
const SAMPLES = 12;
export const OUTLINE_COVERED = 0.5;
export const OUTLINE_REACH = 0.75;

export function hiddenOutlines(shapes: readonly Shape[], extent: number): Uint8Array {
  const hidden = new Uint8Array(shapes.length);
  for (const outline of findOutlines(shapes, extent)) {
    if (outline.covered >= OUTLINE_COVERED && outline.reach >= OUTLINE_REACH) hidden[outline.shape] = 1;
  }
  return hidden;
}

export function findOutlines(shapes: readonly Shape[], extent: number): Outline[] {
  const n = shapes.length;
  if (n < 2) return [];
  const box = new Float64Array(n * 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const outer = shapes[i]!.rings[0];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    if (outer && outer.length >= 6) {
      for (let k = 0; k < outer.length; k += 2) {
        const x = outer[k]!;
        const y = outer[k + 1]!;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }
    box[i * 4] = x0;
    box[i * 4 + 1] = y0;
    box[i * 4 + 2] = x1;
    box[i * 4 + 3] = y1;
  }
  if (!(maxX >= minX && maxY >= minY)) return [];
  const area = new Float64Array(n).fill(Number.NaN);
  const areaOf = (i: number) => {
    let a = area[i]!;
    if (Number.isNaN(a)) {
      const rings = shapes[i]!.rings;
      a = Math.abs(ringArea(rings[0]!));
      for (let r = 1; r < rings.length; r++) a -= Math.abs(ringArea(rings[r]!));
      area[i] = a;
    }
    return a;
  };
  const scaleX = CELLS / (maxX - minX || 1);
  const scaleY = CELLS / (maxY - minY || 1);
  const span = new Int32Array(n * 4);
  const start = new Int32Array(CELLS * CELLS + 1);
  for (let i = 0; i < n; i++) {
    if (!(box[i * 4 + 2]! >= box[i * 4]!)) {
      span[i * 4] = -1;
      continue;
    }
    const c0 = cellOf((box[i * 4]! - minX) * scaleX);
    const r0 = cellOf((box[i * 4 + 1]! - minY) * scaleY);
    const c1 = cellOf((box[i * 4 + 2]! - minX) * scaleX);
    const r1 = cellOf((box[i * 4 + 3]! - minY) * scaleY);
    span[i * 4] = c0;
    span[i * 4 + 1] = r0;
    span[i * 4 + 2] = c1;
    span[i * 4 + 3] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * CELLS + c + 1]!++;
  }
  for (let c = 0; c < CELLS * CELLS; c++) start[c + 1]! += start[c]!;
  const members = new Int32Array(start[CELLS * CELLS]!);
  const cursor = start.slice(0, CELLS * CELLS);
  for (let i = 0; i < n; i++) {
    if (span[i * 4]! < 0) continue;
    for (let r = span[i * 4 + 1]!; r <= span[i * 4 + 3]!; r++) {
      for (let c = span[i * 4]!; c <= span[i * 4 + 2]!; c++) members[cursor[r * CELLS + c]!++] = i;
    }
  }
  const home = (q: number) =>
    cellOf(((box[q * 4 + 1]! + box[q * 4 + 3]!) / 2 - minY) * scaleY) * CELLS +
    cellOf(((box[q * 4]! + box[q * 4 + 2]!) / 2 - minX) * scaleX);
  const slack = extent / 2048;
  return decide(shapes, box, areaOf, collect(shapes, box, areaOf, start, members, home, slack), slack);
}

function cellOf(v: number): number {
  const c = Math.floor(v);
  return c < 0 ? 0 : c >= CELLS ? CELLS - 1 : c;
}

function collect(
  shapes: readonly Shape[],
  box: Float64Array,
  areaOf: (i: number) => number,
  start: Int32Array,
  members: Int32Array,
  home: (q: number) => number,
  slack: number,
): Map<number, number[]> {
  const candidates = new Map<number, number[]>();
  for (let q = 0; q < shapes.length; q++) {
    const qx0 = box[q * 4]!;
    const qy0 = box[q * 4 + 1]!;
    const qx1 = box[q * 4 + 2]!;
    const qy1 = box[q * 4 + 3]!;
    if (!(qx1 >= qx0)) continue;
    const inner = shapes[q]!;
    const cell = home(q);
    for (let m = start[cell]!; m < start[cell + 1]!; m++) {
      const p = members[m]!;
      if (
        p === q ||
        box[p * 4]! - slack > qx0 ||
        box[p * 4 + 1]! - slack > qy0 ||
        box[p * 4 + 2]! + slack < qx1 ||
        box[p * 4 + 3]! + slack < qy1
      )
        continue;
      const outer = shapes[p]!;
      if (outer.base > inner.base || outer.height < inner.height) continue;
      const larger = areaOf(p) - areaOf(q);
      if (larger < 0) continue;
      if (larger === 0) {
        const taller = outer.height - outer.base - (inner.height - inner.base);
        if (taller < 0 || (taller === 0 && p > q)) continue;
      }
      const list = candidates.get(p);
      if (list) list.push(q);
      else candidates.set(p, [q]);
    }
  }
  return candidates;
}

function decide(
  shapes: readonly Shape[],
  box: Float64Array,
  areaOf: (i: number) => number,
  candidates: Map<number, number[]>,
  slack: number,
): Outline[] {
  const found: Outline[] = [];
  for (const [p, list] of candidates) {
    const loose = measure(p, list, shapes, areaOf);
    if (!loose.differs) continue;
    if (loose.covered < OUTLINE_COVERED || loose.reach < OUTLINE_REACH) {
      found.push({ shape: p, parts: list, covered: loose.covered, reach: loose.reach });
      continue;
    }
    const parts = list.filter((q) => within(shapes[q]!.rings[0]!, shapes[p]!.rings, slack));
    const exact = measure(p, parts, shapes, areaOf);
    if (!exact.differs) continue;
    let largest = 0;
    for (const q of parts) largest = Math.max(largest, areaOf(q) - perimeter(shapes[q]!.rings[0]!) * slack);
    const single = Math.min(1, largest / (areaOf(p) || 1));
    const covered =
      exact.covered < OUTLINE_COVERED || exact.reach < OUTLINE_REACH
        ? exact.covered
        : single >= OUTLINE_COVERED
          ? single
          : coverage(p, parts, shapes, box, exact.covered);
    found.push({ shape: p, parts, covered, reach: exact.reach });
  }
  return found;
}

function measure(
  p: number,
  parts: readonly number[],
  shapes: readonly Shape[],
  areaOf: (i: number) => number,
): { differs: boolean; covered: number; reach: number } {
  const outer = shapes[p]!;
  let differs = false;
  let top = -Infinity;
  let sum = 0;
  for (const q of parts) {
    const inner = shapes[q]!;
    if (inner.base > outer.base || inner.height < outer.height) differs = true;
    if (inner.height > top) top = inner.height;
    sum += areaOf(q);
  }
  const tall = outer.height - outer.base;
  return {
    differs,
    covered: Math.min(1, sum / (areaOf(p) || 1)),
    reach: tall > 0 ? (top - outer.base) / tall : 1,
  };
}

function coverage(
  p: number,
  list: readonly number[],
  shapes: readonly Shape[],
  box: Float64Array,
  fallback: number,
): number {
  const rings = shapes[p]!.rings;
  const x0 = box[p * 4]!;
  const y0 = box[p * 4 + 1]!;
  const width = box[p * 4 + 2]! - x0;
  const height = box[p * 4 + 3]! - y0;
  let total = 0;
  let covered = 0;
  for (let j = 0; j < SAMPLES; j++) {
    const y = y0 + ((j + 0.5) / SAMPLES) * height;
    for (let i = 0; i < SAMPLES; i++) {
      const x = x0 + ((i + 0.5) / SAMPLES) * width;
      if (!inside(rings, x, y)) continue;
      total++;
      for (const q of list) {
        if (x < box[q * 4]! || x > box[q * 4 + 2]! || y < box[q * 4 + 1]! || y > box[q * 4 + 3]!) continue;
        if (inside(shapes[q]!.rings, x, y)) {
          covered++;
          break;
        }
      }
    }
  }
  return total > 0 ? covered / total : fallback;
}

function perimeter(ring: Int32Array): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    sum += Math.hypot(ring[i]! - ring[j]!, ring[i + 1]! - ring[j + 1]!);
  }
  return sum;
}

function within(ring: Int32Array, rings: readonly Int32Array[], slack: number): boolean {
  for (let k = 0; k < ring.length; k += 2) {
    const x = ring[k]!;
    const y = ring[k + 1]!;
    if (!inside(rings, x, y) && !near(rings, x, y, slack)) return false;
  }
  return true;
}

function inside(rings: readonly Int32Array[], x: number, y: number): boolean {
  let odd = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const xi = ring[i]!;
      const yi = ring[i + 1]!;
      const xj = ring[j]!;
      const yj = ring[j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

function near(rings: readonly Int32Array[], x: number, y: number, slack: number): boolean {
  const limit = slack * slack;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const ax = ring[j]!;
      const ay = ring[j + 1]!;
      const dx = ring[i]! - ax;
      const dy = ring[i + 1]! - ay;
      const length = dx * dx + dy * dy;
      const t = length > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      if (ex * ex + ey * ey <= limit) return true;
    }
  }
  return false;
}
