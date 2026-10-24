interface Vertex {
  i: number;
  x: number;
  y: number;
  prev: Vertex;
  next: Vertex;
  z: number;
  prevZ: Vertex | null;
  nextZ: Vertex | null;
  steiner: boolean;
}

export function triangulate(coords: ArrayLike<number>, holeStarts: readonly number[], out: number[]): void {
  const vertexCount = coords.length / 2;
  const outerEnd = holeStarts.length > 0 ? holeStarts[0]! : vertexCount;
  let outer = ring(coords, 0, outerEnd, true);
  if (!outer || outer.next === outer.prev) return;
  if (holeStarts.length > 0) outer = attachHoles(coords, holeStarts, vertexCount, outer);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  if (vertexCount > 80) {
    for (let i = 0; i < outerEnd; i++) {
      const x = coords[i * 2]!;
      const y = coords[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const size = Math.max(maxX - minX, maxY - minY);
    const inv = size > 0 ? 32767 / size : 0;
    clip(outer, out, { minX, minY, inv }, 0);
  } else {
    clip(outer, out, null, 0);
  }
}

interface Grid {
  minX: number;
  minY: number;
  inv: number;
}

function ring(coords: ArrayLike<number>, start: number, end: number, positive: boolean): Vertex | null {
  let area = 0;
  for (let i = start, j = end - 1; i < end; j = i++) {
    area += (coords[j * 2]! - coords[i * 2]!) * (coords[i * 2 + 1]! + coords[j * 2 + 1]!);
  }
  let last: Vertex | null = null;
  if (positive === area > 0) {
    for (let i = start; i < end; i++) last = insert(i, coords[i * 2]!, coords[i * 2 + 1]!, last);
  } else {
    for (let i = end - 1; i >= start; i--) last = insert(i, coords[i * 2]!, coords[i * 2 + 1]!, last);
  }
  if (last && same(last, last.next)) {
    remove(last);
    last = last.next;
  }
  return last;
}

function insert(i: number, x: number, y: number, last: Vertex | null): Vertex {
  const v = { i, x, y, z: 0, prevZ: null, nextZ: null, steiner: false } as unknown as Vertex;
  if (!last) {
    v.prev = v;
    v.next = v;
  } else {
    v.next = last.next;
    v.prev = last;
    last.next.prev = v;
    last.next = v;
  }
  return v;
}

function remove(v: Vertex): void {
  v.next.prev = v.prev;
  v.prev.next = v.next;
  if (v.prevZ) v.prevZ.nextZ = v.nextZ;
  if (v.nextZ) v.nextZ.prevZ = v.prevZ;
}

function same(a: Vertex, b: Vertex): boolean {
  return a.x === b.x && a.y === b.y;
}

function cross(a: Vertex, b: Vertex, c: Vertex): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function inTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
    (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
    (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0
  );
}

function filterDegenerate(start: Vertex, end?: Vertex): Vertex {
  let stop = end ?? start;
  let p = start;
  let again: boolean;
  do {
    again = false;
    if (!p.steiner && (same(p, p.next) || cross(p.prev, p, p.next) === 0)) {
      remove(p);
      p = stop = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== stop);
  return stop;
}

function clip(start: Vertex, out: number[], grid: Grid | null, pass: number): void {
  let ear: Vertex = start;
  if (grid && pass === 0) index(ear, grid);
  let stop = ear;
  while (ear.prev !== ear.next) {
    const prev = ear.prev;
    const next = ear.next;
    if (grid ? isEarIndexed(ear, grid) : isEar(ear)) {
      out.push(prev.i, ear.i, next.i);
      remove(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (pass === 0) {
        clip(filterDegenerate(ear), out, grid, 1);
      } else if (pass === 1) {
        const cured = cureIntersections(filterDegenerate(ear), out);
        clip(cured, out, grid, 2);
      } else if (pass === 2) {
        if (!splitAndClip(ear, out, grid)) fan(ear, out);
      }
      break;
    }
  }
}

function isEar(ear: Vertex): boolean {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  if (cross(a, b, c) <= 0) return false;
  let p = c.next;
  while (p !== a) {
    if (
      !(p.x === a.x && p.y === a.y) &&
      !(p.x === b.x && p.y === b.y) &&
      !(p.x === c.x && p.y === c.y) &&
      inTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
      cross(p.prev, p, p.next) <= 0
    ) {
      return false;
    }
    p = p.next;
  }
  return true;
}

function isEarIndexed(ear: Vertex, grid: Grid): boolean {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  if (cross(a, b, c) <= 0) return false;
  const minX = Math.min(a.x, b.x, c.x);
  const minY = Math.min(a.y, b.y, c.y);
  const maxX = Math.max(a.x, b.x, c.x);
  const maxY = Math.max(a.y, b.y, c.y);
  const minZ = morton(minX, minY, grid);
  const maxZ = morton(maxX, maxY, grid);
  const blocks = (p: Vertex): boolean =>
    p !== a &&
    p !== c &&
    p !== b &&
    !(p.x === a.x && p.y === a.y) &&
    !(p.x === b.x && p.y === b.y) &&
    !(p.x === c.x && p.y === c.y) &&
    p.x >= minX &&
    p.x <= maxX &&
    p.y >= minY &&
    p.y <= maxY &&
    inTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
    cross(p.prev, p, p.next) <= 0;
  let p = ear.prevZ;
  while (p && p.z >= minZ) {
    if (blocks(p)) return false;
    p = p.prevZ;
  }
  p = ear.nextZ;
  while (p && p.z <= maxZ) {
    if (blocks(p)) return false;
    p = p.nextZ;
  }
  return true;
}

function morton(x: number, y: number, grid: Grid): number {
  let ix = Math.floor((x - grid.minX) * grid.inv) & 0xffff;
  let iy = Math.floor((y - grid.minY) * grid.inv) & 0xffff;
  ix = (ix | (ix << 8)) & 0x00ff00ff;
  ix = (ix | (ix << 4)) & 0x0f0f0f0f;
  ix = (ix | (ix << 2)) & 0x33333333;
  ix = (ix | (ix << 1)) & 0x55555555;
  iy = (iy | (iy << 8)) & 0x00ff00ff;
  iy = (iy | (iy << 4)) & 0x0f0f0f0f;
  iy = (iy | (iy << 2)) & 0x33333333;
  iy = (iy | (iy << 1)) & 0x55555555;
  return ix | (iy << 1);
}

function index(start: Vertex, grid: Grid): void {
  const list: Vertex[] = [];
  let p = start;
  do {
    p.z = morton(p.x, p.y, grid);
    list.push(p);
    p = p.next;
  } while (p !== start);
  list.sort((u, v) => u.z - v.z);
  for (let i = 0; i < list.length; i++) {
    const v = list[i]!;
    v.prevZ = list[i - 1] ?? null;
    v.nextZ = list[i + 1] ?? null;
  }
}

function segmentsCross(p1: Vertex, q1: Vertex, p2: Vertex, q2: Vertex): boolean {
  const o1 = Math.sign(cross(p1, q1, p2));
  const o2 = Math.sign(cross(p1, q1, q2));
  const o3 = Math.sign(cross(p2, q2, p1));
  const o4 = Math.sign(cross(p2, q2, q1));
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

function cureIntersections(start: Vertex, out: number[]): Vertex {
  let p = start;
  let guard = 0;
  do {
    const a = p.prev;
    const b = p.next.next;
    if (!same(a, b) && segmentsCross(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      out.push(a.i, p.i, b.i);
      remove(p);
      remove(p.next);
      p = start = b;
    }
    p = p.next;
    if (++guard > 1e7) break;
  } while (p !== start);
  return filterDegenerate(p);
}

function locallyInside(a: Vertex, b: Vertex): boolean {
  return cross(a.prev, a, a.next) > 0
    ? cross(a, a.next, b) >= 0 && cross(a, a.prev, b) <= 0
    : cross(a, a.next, b) >= 0 || cross(a, a.prev, b) <= 0;
}

function intersectsPolygon(a: Vertex, b: Vertex): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && segmentsCross(p, p.next, a, b))
      return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function middleInside(a: Vertex, b: Vertex): boolean {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) / 2;
  const py = (a.y + b.y) / 2;
  do {
    if (
      p.y > py !== p.next.y > py &&
      p.next.y !== p.y &&
      px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x
    ) {
      inside = !inside;
    }
    p = p.next;
  } while (p !== a);
  return inside;
}

function validDiagonal(a: Vertex, b: Vertex): boolean {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !intersectsPolygon(a, b) &&
    locallyInside(a, b) &&
    locallyInside(b, a) &&
    middleInside(a, b)
  );
}

function splitAndClip(start: Vertex, out: number[], grid: Grid | null): boolean {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && validDiagonal(a, b)) {
        let c = split(a, b);
        a = filterDegenerate(a, a.next);
        c = filterDegenerate(c, c.next);
        clip(a, out, grid, 0);
        clip(c, out, grid, 0);
        return true;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
  return false;
}

function split(a: Vertex, b: Vertex): Vertex {
  const a2 = clone(a);
  const b2 = clone(b);
  const an = a.next;
  const bp = b.prev;
  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;
  return b2;
}

function clone(v: Vertex): Vertex {
  return { i: v.i, x: v.x, y: v.y, z: v.z, prevZ: null, nextZ: null, steiner: v.steiner, prev: v, next: v };
}

function fan(start: Vertex, out: number[]): void {
  let p = start.next;
  while (p.next !== start) {
    out.push(start.i, p.i, p.next.i);
    p = p.next;
  }
}

function attachHoles(
  coords: ArrayLike<number>,
  holeStarts: readonly number[],
  vertexCount: number,
  outer: Vertex,
): Vertex {
  const holes: Vertex[] = [];
  for (let h = 0; h < holeStarts.length; h++) {
    const start = holeStarts[h]!;
    const end = h + 1 < holeStarts.length ? holeStarts[h + 1]! : vertexCount;
    const list = ring(coords, start, end, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    holes.push(rightmost(list));
  }
  holes.sort((a, b) => b.x - a.x);
  let result = outer;
  for (const hole of holes) result = bridgeHole(hole, result);
  return result;
}

function rightmost(start: Vertex): Vertex {
  let p = start;
  let best = start;
  do {
    if (p.x > best.x || (p.x === best.x && p.y < best.y)) best = p;
    p = p.next;
  } while (p !== start);
  return best;
}

function bridgeHole(hole: Vertex, outer: Vertex): Vertex {
  const target = findBridge(hole, outer);
  if (!target) return outer;
  const joined = split(target, hole);
  filterDegenerate(joined, joined.next);
  return filterDegenerate(target, target.next);
}

function findBridge(hole: Vertex, outer: Vertex): Vertex | null {
  let p = outer;
  const hx = hole.x;
  const hy = hole.y;
  let qx = Infinity;
  let m: Vertex | null = null;
  do {
    if (hy >= p.y && hy <= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x >= hx && x < qx) {
        qx = x;
        m = p.x > p.next.x ? p : p.next;
        if (x === hx) return hy === p.y ? p : hy === p.next.y ? p.next : m;
      }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;
  if (m.x === qx && m.y === hy) return m;
  const stop = m;
  const mx = m.x;
  const my = m.y;
  const above = my > hy;
  let bestTan = Infinity;
  let bestDist = Infinity;
  p = m;
  do {
    if (p.x > hx && p.x <= mx && p !== stop) {
      const inside = above
        ? inTriangle(hx, hy, qx, hy, mx, my, p.x, p.y)
        : inTriangle(qx, hy, hx, hy, mx, my, p.x, p.y);
      if (inside && locallyInside(p, hole)) {
        const tan = Math.abs(p.y - hy) / (p.x - hx);
        const dist = p.x - hx;
        if (tan < bestTan || (tan === bestTan && dist < bestDist)) {
          m = p;
          bestTan = tan;
          bestDist = dist;
        }
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

export function triangleArea(coords: ArrayLike<number>, indices: ArrayLike<number>): number {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 2;
    const b = indices[t + 1]! * 2;
    const c = indices[t + 2]! * 2;
    sum +=
      Math.abs(
        (coords[b]! - coords[a]!) * (coords[c + 1]! - coords[a + 1]!) -
          (coords[c]! - coords[a]!) * (coords[b + 1]! - coords[a + 1]!),
      ) / 2;
  }
  return sum;
}
