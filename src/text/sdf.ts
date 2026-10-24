const INF = 1e20;

function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    d[q] = (q - r) * (q - r) + f[r]!;
  }
}

export function edt(grid: Float64Array, width: number, height: number): void {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]!;
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]!;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x]!;
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x]!;
  }
}

export const SDF_CUTOFF = 0.25;

export function signedDistanceField(
  alpha: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const size = width * height;
  const outer = new Float64Array(size);
  const inner = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = alpha[i]! / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const o = Math.max(0, 0.5 - a);
      const n = Math.max(0, a - 0.5);
      outer[i] = o * o;
      inner[i] = n * n;
    }
  }
  edt(outer, width, height);
  edt(inner, width, height);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const distance = Math.sqrt(outer[i]!) - Math.sqrt(inner[i]!);
    const value = Math.round(255 - 255 * (distance / radius + SDF_CUTOFF));
    out[i] = value < 0 ? 0 : value > 255 ? 255 : value;
  }
  return out;
}
