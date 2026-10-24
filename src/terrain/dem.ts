export type DemEncoding = "terrarium" | "mapbox" | { red: number; green: number; blue: number; offset: number };

export type Unpack = readonly [number, number, number, number];

export const DEM_BORDER = 2;

export const LOWEST_ELEVATION = -11000;

export interface DemGrid {
  readonly size: number;
  readonly stride: number;
  readonly elevation: Float32Array;
  readonly mask: Uint8Array | null;
  readonly min: number;
  readonly max: number;
}

export interface FrameStrip {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Float32Array;
}

export const NEIGHBORS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export function unpackFor(encoding: DemEncoding | undefined): Unpack {
  if (encoding === undefined || encoding === "terrarium") return [256, 1, 1 / 256, -32768];
  if (encoding === "mapbox") return [6553.6, 25.6, 0.1, -10000];
  return [encoding.red, encoding.green, encoding.blue, encoding.offset];
}

export function decodeDem(pixels: ArrayLike<number>, size: number, unpack: Unpack): DemGrid | null {
  const stride = size + 2 * DEM_BORDER;
  const elevation = new Float32Array(stride * stride);
  const [r, g, b, offset] = unpack;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let missing = 0;
  for (let y = 0; y < size; y++) {
    let o = (y + DEM_BORDER) * stride + DEM_BORDER;
    let p = y * size * 4;
    for (let x = 0; x < size; x++, o++, p += 4) {
      const value =
        pixels[p + 3] === 255 ? pixels[p]! * r + pixels[p + 1]! * g + pixels[p + 2]! * b + offset : Number.NaN;
      if (value >= LOWEST_ELEVATION) {
        elevation[o] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      } else {
        elevation[o] = Number.NaN;
        missing++;
      }
    }
  }
  if (missing === size * size) return null;
  let mask: Uint8Array | null = null;
  if (missing > 0) {
    mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      const row = (y + DEM_BORDER) * stride + DEM_BORDER;
      for (let x = 0; x < size; x++) mask[y * size + x] = Number.isNaN(elevation[row + x]!) ? 0 : 255;
    }
    fillMissing(elevation, size, stride);
  }
  clampBorder(elevation, size, stride);
  return { size, stride, elevation, mask, min, max };
}

function fillMissing(elevation: Float32Array, size: number, stride: number): void {
  const queue = new Int32Array(size * size);
  let tail = 0;
  for (let y = 0; y < size; y++) {
    const row = (y + DEM_BORDER) * stride + DEM_BORDER;
    for (let x = 0; x < size; x++) if (!Number.isNaN(elevation[row + x]!)) queue[tail++] = y * size + x;
  }
  for (let head = 0; head < tail; head++) {
    const cell = queue[head]!;
    const x = cell % size;
    const y = (cell - x) / size;
    const value = elevation[(y + DEM_BORDER) * stride + x + DEM_BORDER]!;
    if (x > 0) tail = spread(elevation, queue, tail, x - 1, y, size, stride, value);
    if (x < size - 1) tail = spread(elevation, queue, tail, x + 1, y, size, stride, value);
    if (y > 0) tail = spread(elevation, queue, tail, x, y - 1, size, stride, value);
    if (y < size - 1) tail = spread(elevation, queue, tail, x, y + 1, size, stride, value);
  }
}

function spread(
  elevation: Float32Array,
  queue: Int32Array,
  tail: number,
  x: number,
  y: number,
  size: number,
  stride: number,
  value: number,
): number {
  const o = (y + DEM_BORDER) * stride + x + DEM_BORDER;
  if (!Number.isNaN(elevation[o]!)) return tail;
  elevation[o] = value;
  queue[tail] = y * size + x;
  return tail + 1;
}

function clampBorder(elevation: Float32Array, size: number, stride: number): void {
  const first = DEM_BORDER;
  const last = DEM_BORDER + size - 1;
  for (let y = first; y <= last; y++) {
    const row = y * stride;
    for (let k = 0; k < DEM_BORDER; k++) {
      elevation[row + k] = elevation[row + first]!;
      elevation[row + last + 1 + k] = elevation[row + last]!;
    }
  }
  for (let k = 0; k < DEM_BORDER; k++) {
    elevation.copyWithin(k * stride, first * stride, (first + 1) * stride);
    elevation.copyWithin((last + 1 + k) * stride, last * stride, (last + 1) * stride);
  }
}

export function backfill(target: DemGrid, source: DemGrid, dx: number, dy: number): boolean {
  if (target.size !== source.size || (dx === 0 && dy === 0)) return false;
  const { size, stride } = target;
  const x0 = dx < 0 ? 0 : dx > 0 ? DEM_BORDER + size : DEM_BORDER;
  const x1 = dx < 0 ? DEM_BORDER : dx > 0 ? stride : DEM_BORDER + size;
  const y0 = dy < 0 ? 0 : dy > 0 ? DEM_BORDER + size : DEM_BORDER;
  const y1 = dy < 0 ? DEM_BORDER : dy > 0 ? stride : DEM_BORDER + size;
  const shift = -dy * size * stride - dx * size;
  const t = target.elevation;
  const s = source.elevation;
  for (let y = y0; y < y1; y++) {
    const row = y * stride;
    for (let x = x0; x < x1; x++) t[row + x] = s[row + x + shift]!;
  }
  return true;
}

export function gradients(grid: DemGrid): Float32Array {
  const n = grid.size + 2;
  const out = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) horn(grid, i, j, out, (j * n + i) * 2);
  return out;
}

export function frameStrips(grid: DemGrid): FrameStrip[] {
  const n = grid.size + 2;
  const strip = (x: number, y: number, width: number, height: number): FrameStrip => {
    const data = new Float32Array(width * height * 2);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) horn(grid, x + i, y + j, data, (j * width + i) * 2);
    return { x, y, width, height, data };
  };
  return [strip(0, 0, n, 2), strip(0, n - 2, n, 2), strip(0, 2, 2, n - 4), strip(n - 2, 2, 2, n - 4)];
}

export function writeFrame(grid: DemGrid, out: Float32Array): void {
  const n = grid.size + 2;
  for (const s of frameStrips(grid)) {
    for (let j = 0; j < s.height; j++) {
      out.set(s.data.subarray(j * s.width * 2, (j + 1) * s.width * 2), ((s.y + j) * n + s.x) * 2);
    }
  }
}

function horn(grid: DemGrid, i: number, j: number, out: Float32Array, k: number): void {
  const e = grid.elevation;
  const stride = grid.stride;
  const c = (j + DEM_BORDER - 1) * stride + i + DEM_BORDER - 1;
  const n = c - stride;
  const s = c + stride;
  const nw = e[n - 1]!;
  const ne = e[n + 1]!;
  const sw = e[s - 1]!;
  const se = e[s + 1]!;
  out[k] = (ne + 2 * e[c + 1]! + se - (nw + 2 * e[c - 1]! + sw)) / 8;
  out[k + 1] = (sw + 2 * e[s]! + se - (nw + 2 * e[n]! + ne)) / 8;
}

export function sampleElevation(grid: DemGrid, u: number, v: number): number | null {
  const { size, stride, elevation, mask } = grid;
  if (mask) {
    const mx = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
    const my = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
    if (mask[my * size + mx] === 0) return null;
  }
  const fx = Math.min(stride - 1, Math.max(0, u * size - 0.5 + DEM_BORDER));
  const fy = Math.min(stride - 1, Math.max(0, v * size - 0.5 + DEM_BORDER));
  const x0 = Math.min(stride - 2, Math.floor(fx));
  const y0 = Math.min(stride - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const o = y0 * stride + x0;
  const top = elevation[o]! + (elevation[o + 1]! - elevation[o]!) * tx;
  const bottom = elevation[o + stride]! + (elevation[o + stride + 1]! - elevation[o + stride]!) * tx;
  return top + (bottom - top) * ty;
}
