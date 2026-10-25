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
  const area = new Float64Array(n);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const rings = shapes[i]!.rings;
    const outer = rings[0];
    if (!outer || outer.length < 6) {
      box.set([Infinity, Infinity, -Infinity, -Infinity], i * 4);
      continue;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < outer.length; k += 2) {
      const x = outer[k]!;
      const y = outer[k + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    box.set([x0, y0, x1, y1], i * 4);
    let a = Math.abs(ringArea(outer));
    for (let r = 1; r < rings.length; r++) a -= Math.abs(ringArea(rings[r]!));
    area[i] = a;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  if (!(maxX >= minX && maxY >= minY)) return [];
  const cellWidth = (maxX - minX) / CELLS || 1;
  const cellHeight = (maxY - minY) / CELLS || 1;
  const column = (x: number) => Math.min(CELLS - 1, Math.max(0, Math.floor((x - minX) / cellWidth)));
  const row = (y: number) => Math.min(CELLS - 1, Math.max(0, Math.floor((y - minY) / cellHeight)));
  const cells: number[][] = Array.from({ length: CELLS * CELLS }, () => []);
  for (let i = 0; i < n; i++) {
    if (!(box[i * 4 + 2]! >= box[i * 4]!)) continue;
    const c0 = column(box[i * 4]!);
    const c1 = column(box[i * 4 + 2]!);
    for (let r = row(box[i * 4 + 1]!); r <= row(box[i * 4 + 3]!); r++) {
      for (let c = c0; c <= c1; c++) cells[r * CELLS + c]!.push(i);
    }
  }
  const slack = extent / 1024;
  const encloses = (p: number, q: number) => {
    if (
      box[p * 4]! - slack > box[q * 4]! ||
      box[p * 4 + 1]! - slack > box[q * 4 + 1]! ||
      box[p * 4 + 2]! + slack < box[q * 4 + 2]! ||
      box[p * 4 + 3]! + slack < box[q * 4 + 3]!
    )
      return false;
    const outer = shapes[p]!;
    const inner = shapes[q]!;
    if (outer.base > inner.base || outer.height < inner.height) return false;
    if (area[p] !== area[q]) return area[p]! > area[q]!;
    const tallOuter = outer.height - outer.base;
    const tallInner = inner.height - inner.base;
    return tallOuter !== tallInner ? tallOuter > tallInner : p < q;
  };
  const parts = new Map<number, number[]>();
  for (let q = 0; q < n; q++) {
    if (!(box[q * 4 + 2]! >= box[q * 4]!)) continue;
    const cx = (box[q * 4]! + box[q * 4 + 2]!) / 2;
    const cy = (box[q * 4 + 1]! + box[q * 4 + 3]!) / 2;
    for (const p of cells[row(cy) * CELLS + column(cx)]!) {
      if (p === q || !encloses(p, q)) continue;
      if (!within(shapes[q]!.rings[0]!, shapes[p]!.rings, slack)) continue;
      const list = parts.get(p);
      if (list) list.push(q);
      else parts.set(p, [q]);
    }
  }
  const found: Outline[] = [];
  for (const [p, list] of parts) {
    const outer = shapes[p]!;
    let differs = false;
    let top = -Infinity;
    let sum = 0;
    for (const q of list) {
      const inner = shapes[q]!;
      if (inner.base > outer.base || inner.height < outer.height) differs = true;
      if (inner.height > top) top = inner.height;
      sum += area[q]!;
    }
    if (!differs) continue;
    const tall = outer.height - outer.base;
    const reach = tall > 0 ? (top - outer.base) / tall : 1;
    const bound = Math.min(1, sum / (area[p]! || 1));
    const covered = bound < OUTLINE_COVERED || reach < OUTLINE_REACH ? bound : coverage(p, list, shapes, box, bound);
    found.push({ shape: p, parts: list, covered, reach });
  }
  return found;
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
