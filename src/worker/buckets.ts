import { triangulate } from "../render/tessellate.ts";

export const LINE_STRIDE = 20;
export const FILL_STRIDE = 8;
export const CIRCLE_STRIDE = 12;
export const EXTRUDE_SCALE = 2048;

export class Growable {
  bytes: Uint8Array;
  view: DataView;
  length = 0;

  constructor(initial = 1024) {
    this.bytes = new Uint8Array(initial);
    this.view = new DataView(this.bytes.buffer);
  }

  reserve(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  finish(): ArrayBuffer {
    return this.bytes.slice(0, this.length).buffer;
  }
}

export class IndexBuilder {
  data = new Uint32Array(1024);
  length = 0;

  push(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }

  finish(): ArrayBuffer {
    return this.data.slice(0, this.length).buffer;
  }
}

export class FillBuilder {
  readonly vertices = new Growable(4096);
  readonly indices = new IndexBuilder();
  vertexCount = 0;
  private readonly scratch: number[] = [];

  addPolygon(rings: Int32Array[], feature: number): void {
    const coords = this.scratch;
    coords.length = 0;
    const holes: number[] = [];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r]!;
      let n = ring.length / 2;
      if (n > 1 && ring[0] === ring[ring.length - 2] && ring[1] === ring[ring.length - 1]) n--;
      if (n < 3) {
        if (r === 0) return;
        continue;
      }
      if (r > 0) holes.push(coords.length / 2);
      for (let i = 0; i < n; i++) coords.push(ring[i * 2]!, ring[i * 2 + 1]!);
    }
    const base = this.vertexCount;
    const count = coords.length / 2;
    this.vertices.reserve(count * FILL_STRIDE);
    const v = this.vertices.view;
    let o = this.vertices.length;
    for (let i = 0; i < count; i++) {
      v.setInt16(o, clamp16(coords[i * 2]!), true);
      v.setInt16(o + 2, clamp16(coords[i * 2 + 1]!), true);
      v.setUint32(o + 4, feature, true);
      o += FILL_STRIDE;
    }
    this.vertices.length = o;
    this.vertexCount += count;
    const tris: number[] = [];
    triangulate(coords, holes, tris);
    for (let t = 0; t < tris.length; t += 3) this.indices.push(base + tris[t]!, base + tris[t + 1]!, base + tris[t + 2]!);
  }
}

export interface LineOptions {
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  miterLimit: number;
  roundLimit: number;
}

export class LineBuilder {
  readonly vertices = new Growable(8192);
  readonly indices = new IndexBuilder();
  vertexCount = 0;
  private readonly options: LineOptions;

  constructor(options: LineOptions) {
    this.options = options;
  }

  private vertex(x: number, y: number, ex: number, ey: number, sx: number, sy: number, square: boolean, dist: number, feature: number): number {
    this.vertices.reserve(LINE_STRIDE);
    const v = this.vertices.view;
    const o = this.vertices.length;
    v.setInt16(o, clamp16(x), true);
    v.setInt16(o + 2, clamp16(y), true);
    v.setInt16(o + 4, clamp16(Math.round(ex * EXTRUDE_SCALE)), true);
    v.setInt16(o + 6, clamp16(Math.round(ey * EXTRUDE_SCALE)), true);
    v.setInt8(o + 8, Math.round(sx * 127));
    v.setInt8(o + 9, Math.round(sy * 127));
    v.setInt8(o + 10, square ? 127 : 0);
    v.setInt8(o + 11, 0);
    v.setFloat32(o + 12, dist, true);
    v.setUint32(o + 16, feature, true);
    this.vertices.length = o + LINE_STRIDE;
    return this.vertexCount++;
  }

  addLine(points: Int32Array, feature: number, closedHint = false): void {
    const pts: number[] = [];
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i]!;
      const y = points[i + 1]!;
      const n = pts.length;
      if (n >= 2 && pts[n - 2] === x && pts[n - 1] === y) continue;
      pts.push(x, y);
    }
    let count = pts.length / 2;
    if (count < 2) return;
    let closed = closedHint || (count > 2 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]);
    if (closed && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) {
      pts.length -= 2;
      count--;
    }
    if (count < 2) return;
    if (closed && count < 3) closed = false;
    const segments = closed ? count : count - 1;
    const dirs = new Float64Array(segments * 2);
    const lens = new Float64Array(segments);
    for (let s = 0; s < segments; s++) {
      const a = s;
      const b = (s + 1) % count;
      const dx = pts[b * 2]! - pts[a * 2]!;
      const dy = pts[b * 2 + 1]! - pts[a * 2 + 1]!;
      const len = Math.hypot(dx, dy);
      lens[s] = len;
      dirs[s * 2] = len > 0 ? dx / len : 1;
      dirs[s * 2 + 1] = len > 0 ? dy / len : 0;
    }
    let dist = 0;
    for (let s = 0; s < segments; s++) {
      const a = s;
      const b = (s + 1) % count;
      const ax = pts[a * 2]!, ay = pts[a * 2 + 1]!;
      const bx = pts[b * 2]!, by = pts[b * 2 + 1]!;
      const dx = dirs[s * 2]!, dy = dirs[s * 2 + 1]!;
      const nx = -dy, ny = dx;
      const d0 = dist;
      const d1 = dist + lens[s]!;
      const v0 = this.vertex(ax, ay, nx, ny, 0, 1, false, d0, feature);
      const v1 = this.vertex(ax, ay, -nx, -ny, 0, -1, false, d0, feature);
      const v2 = this.vertex(bx, by, nx, ny, 0, 1, false, d1, feature);
      const v3 = this.vertex(bx, by, -nx, -ny, 0, -1, false, d1, feature);
      this.indices.push(v0, v1, v2);
      this.indices.push(v1, v3, v2);
      if (s === 0 && !closed) this.cap(ax, ay, -dx, -dy, d0, feature);
      if (s === segments - 1 && !closed) this.cap(bx, by, dx, dy, d1, feature);
      if (closed || s < segments - 1) {
        const t = (s + 1) % segments;
        this.join(bx, by, dx, dy, dirs[t * 2]!, dirs[t * 2 + 1]!, d1, feature);
      }
      dist = d1;
    }
  }

  private cap(x: number, y: number, dx: number, dy: number, dist: number, feature: number): void {
    const cap = this.options.cap;
    if (cap === "butt") return;
    const nx = -dy, ny = dx;
    if (cap === "square") {
      const a = this.vertex(x, y, nx, ny, 0, 1, true, dist, feature);
      const b = this.vertex(x, y, -nx, -ny, 0, -1, true, dist, feature);
      const c = this.vertex(x, y, nx + dx, ny + dy, 1, 1, true, dist, feature);
      const d = this.vertex(x, y, -nx + dx, -ny + dy, 1, -1, true, dist, feature);
      this.indices.push(a, b, c);
      this.indices.push(b, d, c);
      return;
    }
    const center = this.vertex(x, y, 0, 0, 0, 0, false, dist, feature);
    const steps = 8;
    let prev = this.vertex(x, y, nx, ny, nx, ny, false, dist, feature);
    for (let i = 1; i <= steps; i++) {
      const a = (Math.PI * i) / steps;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const ex = nx * c + dx * s;
      const ey = ny * c + dy * s;
      const cur = this.vertex(x, y, ex, ey, ex, ey, false, dist, feature);
      this.indices.push(center, prev, cur);
      prev = cur;
    }
  }

  private join(x: number, y: number, d0x: number, d0y: number, d1x: number, d1y: number, dist: number, feature: number): void {
    const turn = d0x * d1y - d0y * d1x;
    const dot = d0x * d1x + d0y * d1y;
    if (Math.abs(turn) < 1e-9 && dot > 0) return;
    const side = turn > 0 ? -1 : 1;
    const o0x = -d0y * side, o0y = d0x * side;
    const o1x = -d1y * side, o1y = d1x * side;
    let join = this.options.join;
    const mx = o0x + o1x, my = o0y + o1y;
    const mlen = Math.hypot(mx, my);
    let miter = 0;
    if (mlen > 1e-9) {
      const cosHalf = mlen / 2;
      miter = 1 / Math.max(cosHalf, 1e-6);
    }
    if (join === "miter" && (mlen < 1e-9 || miter > this.options.miterLimit)) join = "bevel";
    if (join === "round" && dot > this.options.roundLimit) join = "miter";
    if (join === "miter" && miter > this.options.miterLimit) join = "bevel";
    const center = this.vertex(x, y, 0, 0, 0, 0, false, dist, feature);
    const a = this.vertex(x, y, o0x, o0y, 0, 1, false, dist, feature);
    const b = this.vertex(x, y, o1x, o1y, 0, 1, false, dist, feature);
    if (join === "bevel") {
      this.indices.push(center, a, b);
      return;
    }
    if (join === "miter") {
      const m = this.vertex(x, y, (mx / mlen) * miter, (my / mlen) * miter, 0, 1, false, dist, feature);
      this.indices.push(center, a, m);
      this.indices.push(center, m, b);
      return;
    }
    const start = Math.atan2(o0y, o0x);
    let sweep = Math.atan2(o1y, o1x) - start;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil((Math.abs(sweep) / Math.PI) * 8));
    let prev = a;
    for (let i = 1; i < steps; i++) {
      const ang = start + (sweep * i) / steps;
      const ex = Math.cos(ang);
      const ey = Math.sin(ang);
      const cur = this.vertex(x, y, ex, ey, ex, ey, false, dist, feature);
      this.indices.push(center, prev, cur);
      prev = cur;
    }
    this.indices.push(center, prev, b);
  }
}

export class CircleBuilder {
  readonly vertices = new Growable(2048);
  readonly indices = new IndexBuilder();
  vertexCount = 0;

  addPoint(x: number, y: number, feature: number): void {
    this.vertices.reserve(CIRCLE_STRIDE * 4);
    const v = this.vertices.view;
    const base = this.vertexCount;
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const o = this.vertices.length;
      v.setInt16(o, clamp16(x), true);
      v.setInt16(o + 2, clamp16(y), true);
      v.setInt8(o + 4, cx * 127);
      v.setInt8(o + 5, cy * 127);
      v.setInt8(o + 6, 0);
      v.setInt8(o + 7, 0);
      v.setUint32(o + 8, feature, true);
      this.vertices.length = o + CIRCLE_STRIDE;
    }
    this.vertexCount += 4;
    this.indices.push(base, base + 1, base + 2);
    this.indices.push(base, base + 2, base + 3);
  }
}

function clamp16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}
