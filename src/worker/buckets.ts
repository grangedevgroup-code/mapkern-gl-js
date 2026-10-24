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

  pair(a: number, b: number): void {
    if (this.length + 2 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }

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
  readonly edges = new IndexBuilder();
  vertexCount = 0;
  private readonly scratch: number[] = [];

  addPolygon(rings: Int32Array[], feature: number): void {
    const coords = this.scratch;
    coords.length = 0;
    const holes: number[] = [];
    const ringStarts: number[] = [];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r]!;
      let n = ring.length / 2;
      if (n > 1 && ring[0] === ring[ring.length - 2] && ring[1] === ring[ring.length - 1]) n--;
      if (n < 3) {
        if (r === 0) return;
        continue;
      }
      if (r > 0) holes.push(coords.length / 2);
      ringStarts.push(coords.length / 2);
      for (let i = 0; i < n; i++) coords.push(ring[i * 2]!, ring[i * 2 + 1]!);
    }
    const base = this.vertexCount;
    ringStarts.push(coords.length / 2);
    for (let r = 0; r + 1 < ringStarts.length; r++) {
      const start = ringStarts[r]!;
      const end = ringStarts[r + 1]!;
      for (let i = start; i < end; i++) this.edges.pair(base + i, base + (i + 1 < end ? i + 1 : start));
    }
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
    for (let t = 0; t < tris.length; t += 3)
      this.indices.push(base + tris[t]!, base + tris[t + 1]!, base + tris[t + 2]!);
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
  private pts = new Float64Array(512);
  private dirs = new Float64Array(512);
  private lens = new Float64Array(256);
  private pairLeft = -1;
  private pairRight = -1;

  constructor(options: LineOptions) {
    this.options = options;
  }

  private vertex(
    x: number,
    y: number,
    ex: number,
    ey: number,
    sx: number,
    sy: number,
    square: boolean,
    dist: number,
    feature: number,
  ): number {
    this.vertices.reserve(LINE_STRIDE);
    const v = this.vertices.view;
    const o = this.vertices.length;
    v.setInt16(o, clamp16(x), true);
    v.setInt16(o + 2, clamp16(y), true);
    v.setInt16(o + 4, clamp16(Math.round(ex * EXTRUDE_SCALE)), true);
    v.setInt16(o + 6, clamp16(Math.round(ey * EXTRUDE_SCALE)), true);
    v.setInt8(o + 8, clamp8(Math.round(sx * 63.5)));
    v.setInt8(o + 9, clamp8(Math.round(sy * 63.5)));
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
    const simple = (s0: number, s1: number) => {
      const dot = dirs[s0 * 2]! * dirs[s1 * 2]! + dirs[s0 * 2 + 1]! * dirs[s1 * 2 + 1]!;
      if (this.options.join === "miter") {
        const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2));
        return cosHalf > 1e-6 && 1 / cosHalf <= this.options.miterLimit;
      }
      return dot >= this.options.roundLimit;
    };
    let pairL = -1;
    let pairR = -1;
    let firstL = -1;
    let firstR = -1;
    let dist = 0;
    if (closed && simple(segments - 1, 0)) {
      [pairL, pairR] = this.miterPair(pts[0]!, pts[1]!, segments - 1, 0, dirs, 0, feature);
      firstL = pairL;
      firstR = pairR;
    }
    for (let s = 0; s < segments; s++) {
      const a = s;
      const b = (s + 1) % count;
      const ax = pts[a * 2]!;
      const ay = pts[a * 2 + 1]!;
      const bx = pts[b * 2]!;
      const by = pts[b * 2 + 1]!;
      const dx = dirs[s * 2]!;
      const dy = dirs[s * 2 + 1]!;
      const nx = -dy;
      const ny = dx;
      const d0 = dist;
      const d1 = dist + lens[s]!;
      let startL = pairL;
      let startR = pairR;
      if (startL < 0) {
        startL = this.vertex(ax, ay, nx, ny, 0, 1, false, d0, feature);
        startR = this.vertex(ax, ay, -nx, -ny, 0, -1, false, d0, feature);
        if (s === 0 && !closed) this.cap(ax, ay, -dx, -dy, d0, feature);
      }
      const last = s === segments - 1;
      const hasJoin = closed || !last;
      const next = (s + 1) % segments;
      let endL: number;
      let endR: number;
      if (hasJoin && last && closed && firstL >= 0) {
        endL = firstL;
        endR = firstR;
        pairL = -1;
        pairR = -1;
      } else if (hasJoin && simple(s, next)) {
        [endL, endR] = this.miterPair(bx, by, s, next, dirs, d1, feature);
        pairL = endL;
        pairR = endR;
      } else {
        endL = this.vertex(bx, by, nx, ny, 0, 1, false, d1, feature);
        endR = this.vertex(bx, by, -nx, -ny, 0, -1, false, d1, feature);
        pairL = -1;
        pairR = -1;
        if (hasJoin) this.join(bx, by, dx, dy, dirs[next * 2]!, dirs[next * 2 + 1]!, d1, feature);
        else if (!closed) this.cap(bx, by, dx, dy, d1, feature);
      }
      this.indices.push(startL, startR, endL);
      this.indices.push(startR, endR, endL);
      dist = d1;
    }
  }

  private miterPair(
    x: number,
    y: number,
    s0: number,
    s1: number,
    dirs: Float64Array,
    dist: number,
    feature: number,
  ): [number, number] {
    const n0x = -dirs[s0 * 2 + 1]!;
    const n0y = dirs[s0 * 2]!;
    const n1x = -dirs[s1 * 2 + 1]!;
    const n1y = dirs[s1 * 2]!;
    let mx = n0x + n1x;
    let my = n0y + n1y;
    const len = Math.hypot(mx, my);
    if (len < 1e-9) {
      mx = n0x;
      my = n0y;
    } else {
      const scale = 1 / Math.max(len / 2, 1e-6) / len;
      mx *= scale;
      my *= scale;
    }
    const l = this.vertex(x, y, mx, my, 0, 1, false, dist, feature);
    const r = this.vertex(x, y, -mx, -my, 0, -1, false, dist, feature);
    return [l, r];
  }

  private cap(x: number, y: number, dx: number, dy: number, dist: number, feature: number): void {
    const cap = this.options.cap;
    if (cap === "butt") return;
    const nx = -dy;
    const ny = dx;
    const square = cap === "square";
    const a = this.vertex(x, y, nx, ny, 0, 1, square, dist, feature);
    const b = this.vertex(x, y, -nx, -ny, 0, -1, square, dist, feature);
    const c = this.vertex(x, y, nx + dx, ny + dy, 1, 1, square, dist, feature);
    const d = this.vertex(x, y, -nx + dx, -ny + dy, 1, -1, square, dist, feature);
    this.indices.push(a, b, c);
    this.indices.push(b, d, c);
  }

  private join(
    x: number,
    y: number,
    d0x: number,
    d0y: number,
    d1x: number,
    d1y: number,
    dist: number,
    feature: number,
  ): void {
    const turn = d0x * d1y - d0y * d1x;
    const dot = d0x * d1x + d0y * d1y;
    if (Math.abs(turn) < 1e-9 && dot > 0) return;
    const side = turn > 0 ? -1 : 1;
    const o0x = -d0y * side;
    const o0y = d0x * side;
    const o1x = -d1y * side;
    const o1y = d1x * side;
    let join = this.options.join;
    const mx = o0x + o1x;
    const my = o0y + o1y;
    const mlen = Math.hypot(mx, my);
    const miter = mlen > 1e-9 ? 1 / Math.max(mlen / 2, 1e-6) : Number.POSITIVE_INFINITY;
    if (join === "miter" && miter > this.options.miterLimit) join = "bevel";
    const center = this.vertex(x, y, 0, 0, 0, 0, false, dist, feature);
    if (join === "bevel") {
      const a = this.vertex(x, y, o0x, o0y, 0, 1, false, dist, feature);
      const b = this.vertex(x, y, o1x, o1y, 0, 1, false, dist, feature);
      this.indices.push(center, a, b);
      return;
    }
    if (join === "miter") {
      const a = this.vertex(x, y, o0x, o0y, 0, 1, false, dist, feature);
      const b = this.vertex(x, y, o1x, o1y, 0, 1, false, dist, feature);
      const m = this.vertex(x, y, (mx / mlen) * miter, (my / mlen) * miter, 0, 1, false, dist, feature);
      this.indices.push(center, a, m);
      this.indices.push(center, m, b);
      return;
    }
    const start = Math.atan2(o0y, o0x);
    let sweep = Math.atan2(o1y, o1x) - start;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = sweep / steps;
    const radius = 1 / Math.cos(Math.abs(step) / 2);
    let prev = this.vertex(x, y, o0x, o0y, o0x, o0y, false, dist, feature);
    for (let i = 0; i < steps; i++) {
      const angle = start + step * (i + 0.5);
      const ex = Math.cos(angle) * radius;
      const ey = Math.sin(angle) * radius;
      const cur = this.vertex(x, y, ex, ey, ex, ey, false, dist, feature);
      this.indices.push(center, prev, cur);
      prev = cur;
    }
    const end = this.vertex(x, y, o1x, o1y, o1x, o1y, false, dist, feature);
    this.indices.push(center, prev, end);
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

function clamp8(v: number): number {
  return v < -127 ? -127 : v > 127 ? 127 : v;
}

function clamp16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}
