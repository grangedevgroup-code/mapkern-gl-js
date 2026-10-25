import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { ByteSource, TiffImage } from "../../src/formats/tiff.ts";
import { blocksAcross, readBlock, readTiff } from "../../src/formats/tiff.ts";
import {
  EARTH_CIRCUMFERENCE,
  latFromMercatorY,
  lngFromMercatorX,
  mercatorX,
  mercatorY,
} from "../../src/geo/mercator.ts";
import type { Unproject } from "../../src/geo/projection.ts";
import { projectionFromEpsg } from "../../src/geo/projection.ts";
import { Compression, PMTilesWriter, TileType } from "./pmtiles-writer.ts";
import { encodePng } from "./png.ts";

export interface DemOptions {
  inputs: string[];
  output: string;
  minZoom?: number | undefined;
  maxZoom?: number | undefined;
  name?: string | undefined;
  log?: (line: string) => void;
}

export interface DemResult {
  tiles: number;
  bytes: number;
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
}

const SIZE = 512;
const STEP = 16;
const NODES = SIZE / STEP + 1;
const CACHE_BYTES = 384 * 1024 * 1024;

class FileSource implements ByteSource {
  readonly size: number;
  private readonly handle: FileHandle;

  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(Math.max(0, Math.min(length, this.size - offset)));
    let done = 0;
    while (done < out.length) {
      const { bytesRead } = await this.handle.read(out, done, out.length - done, offset + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return out;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

interface Input {
  name: string;
  source: FileSource;
  image: TiffImage;
  inverse: Unproject | null;
  affine: [number, number, number, number, number, number];
  bounds: [number, number, number, number];
  metersPerPixel: number;
  noData: number | null;
  unit: number;
  blocks: Map<number, Float32Array>;
}

export async function buildDem(options: DemOptions): Promise<DemResult> {
  const log = options.log ?? (() => {});
  if (options.inputs.length === 0) throw new Error("Give at least one elevation GeoTIFF");
  const inputs: Input[] = [];
  try {
    for (const path of options.inputs) inputs.push(await openInput(path));
    const bounds: [number, number, number, number] = [180, 85, -180, -85];
    let finest = Number.POSITIVE_INFINITY;
    for (const input of inputs) {
      const [w, s, e, n] = input.bounds;
      bounds[0] = Math.min(bounds[0], w);
      bounds[1] = Math.min(bounds[1], s);
      bounds[2] = Math.max(bounds[2], e);
      bounds[3] = Math.max(bounds[3], n);
      finest = Math.min(finest, input.metersPerPixel);
      log(
        `${input.name}: ${input.image.width} x ${input.image.height} pixels, about ${input.metersPerPixel.toFixed(1)} m each`,
      );
    }
    const middle = (bounds[1] + bounds[3]) / 2;
    const natural = Math.round(Math.log2((EARTH_CIRCUMFERENCE * Math.cos((middle * Math.PI) / 180)) / (SIZE * finest)));
    const maxZoom = Math.max(0, Math.min(18, options.maxZoom ?? natural));
    const minZoom = Math.max(0, Math.min(maxZoom, options.minZoom ?? 0));
    log(`building zoom ${minZoom} to ${maxZoom} for ${bounds.map((v) => v.toFixed(4)).join(", ")}`);
    const writer = new PMTilesWriter();
    let written = 0;
    const started = performance.now();
    const covers = (z: number, x: number, y: number) => {
      const [w, s, e, n] = tileBounds(z, x, y);
      return inputs.some((i) => w < i.bounds[2] && e > i.bounds[0] && s < i.bounds[3] && n > i.bounds[1]);
    };
    const build = async (z: number, x: number, y: number): Promise<Float32Array | null> => {
      if (!covers(z, x, y)) return null;
      let elevation: Float32Array | null;
      if (z === maxZoom) {
        elevation = await sampleTile(inputs, z, x, y);
      } else {
        const kids: (Float32Array | null)[] = [];
        for (let k = 0; k < 4; k++) kids.push(await build(z + 1, x * 2 + (k & 1), y * 2 + (k >> 1)));
        elevation = downsample(kids);
      }
      if (elevation && z >= minZoom) {
        writer.add(z, x, y, terrariumPng(elevation));
        written++;
        if (written % 200 === 0)
          log(`  ${written} tiles, at ${z}/${x}/${y}, ${Math.round((performance.now() - started) / 1000)} s`);
      }
      return elevation;
    };
    const n = 2 ** minZoom;
    const x0 = Math.max(0, Math.floor(mercatorX(bounds[0]) * n));
    const x1 = Math.min(n - 1, Math.floor(mercatorX(bounds[2]) * n));
    const y0 = Math.max(0, Math.floor(mercatorY(bounds[3]) * n));
    const y1 = Math.min(n - 1, Math.floor(mercatorY(bounds[1]) * n));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) await build(minZoom, x, y);
    if (written === 0) throw new Error("The elevation files did not produce any tiles");
    const center: [number, number, number] = [(bounds[0] + bounds[2]) / 2, middle, Math.max(minZoom, maxZoom - 4)];
    const result = writer.write(options.output, {
      tileType: TileType.png,
      tileCompression: Compression.none,
      minZoom,
      maxZoom,
      bounds,
      center,
      metadata: {
        name: options.name ?? basename(options.output).replace(/\.pmtiles$/i, ""),
        format: "png",
        encoding: "terrarium",
        description: "Elevation in meters above sea level, Terrarium encoded",
      },
    });
    log(`wrote ${options.output}: ${written} tiles, ${(result.bytes / 1048576).toFixed(1)} MB`);
    return { tiles: written, bytes: result.bytes, minZoom, maxZoom, bounds };
  } finally {
    for (const input of inputs) await input.source.close();
  }
}

async function openInput(path: string): Promise<Input> {
  const handle = await open(path, "r");
  const { size } = await handle.stat();
  const source = new FileSource(handle, size);
  try {
    const [image] = await readTiff(source);
    if (!image) throw new Error(`${path} has no image`);
    const geo = image.geo;
    if (!geo) throw new Error(`${path} has no georeferencing. Use a GeoTIFF`);
    const inverse = geo.geographic ? null : projectionFromEpsg(geo.epsg ?? -1);
    if (!geo.geographic && geo.epsg === null) {
      throw new Error(`${path} uses a custom projection. Save it with an EPSG code or in longitude and latitude`);
    }
    const affine = geo.transform;
    const toLngLat = (col: number, row: number): [number, number] => {
      const x = affine[0] + affine[1] * col + affine[2] * row;
      const y = affine[3] + affine[4] * col + affine[5] * row;
      return inverse ? inverse(x, y) : [x, y];
    };
    let w = 180;
    let s = 90;
    let e = -180;
    let n = -90;
    for (let k = 0; k <= 16; k++) {
      for (const [col, row] of [
        [(image.width * k) / 16, 0],
        [(image.width * k) / 16, image.height],
        [0, (image.height * k) / 16],
        [image.width, (image.height * k) / 16],
      ] as const) {
        const [lng, lat] = toLngLat(col, row);
        w = Math.min(w, lng);
        e = Math.max(e, lng);
        s = Math.min(s, lat);
        n = Math.max(n, lat);
      }
    }
    const [cl, cp] = toLngLat(image.width / 2, image.height / 2);
    const [rl, rp] = toLngLat(image.width / 2 + 1, image.height / 2);
    const metersPerDegree = EARTH_CIRCUMFERENCE / 360;
    const metersPerPixel = Math.hypot(
      (rl - cl) * metersPerDegree * Math.cos((cp * Math.PI) / 180),
      (rp - cp) * metersPerDegree,
    );
    return {
      name: basename(path),
      source,
      image,
      inverse,
      affine,
      bounds: [w, Math.max(-85, s), e, Math.min(85, n)],
      metersPerPixel,
      noData: image.noData,
      unit: geo.verticalUnit,
      blocks: new Map(),
    };
  } catch (error) {
    await source.close();
    throw error;
  }
}

function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  return [
    lngFromMercatorX(x / n),
    latFromMercatorY((y + 1) / n),
    lngFromMercatorX((x + 1) / n),
    latFromMercatorY(y / n),
  ];
}

function solve(inverse: Unproject, lng: number, lat: number, guess: [number, number]): [number, number] | null {
  let [x, y] = guess;
  for (let i = 0; i < 25; i++) {
    const [l0, p0] = inverse(x, y);
    const dl = lng - l0;
    const dp = lat - p0;
    if (Math.abs(dl) < 1e-12 && Math.abs(dp) < 1e-12) return [x, y];
    const [l1, p1] = inverse(x + 1, y);
    const [l2, p2] = inverse(x, y + 1);
    const a = l1 - l0;
    const b = l2 - l0;
    const c = p1 - p0;
    const d = p2 - p0;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || det === 0) return null;
    x += (dl * d - dp * b) / det;
    y += (a * dp - c * dl) / det;
  }
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function pixelOf(input: Input, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = input.affine;
  const det = b * f - c * e;
  const dx = x - a;
  const dy = y - d;
  return [(dx * f - c * dy) / det, (b * dy - e * dx) / det];
}

async function sampleTile(inputs: Input[], z: number, x: number, y: number): Promise<Float32Array | null> {
  const out = new Float32Array(SIZE * SIZE).fill(Number.NaN);
  const n = 2 ** z;
  const [tw, ts, te, tn] = tileBounds(z, x, y);
  let any = false;
  for (const input of inputs) {
    const [w, s, e, nn] = input.bounds;
    if (tw >= e || te <= w || ts >= nn || tn <= s) continue;
    const nodes = new Float64Array(NODES * NODES * 2).fill(Number.NaN);
    let guess: [number, number] | null = null;
    let u0 = Number.POSITIVE_INFINITY;
    let v0 = Number.POSITIVE_INFINITY;
    let u1 = Number.NEGATIVE_INFINITY;
    let v1 = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < NODES; j++) {
      for (let i = 0; i < NODES; i++) {
        const lng = lngFromMercatorX((x + (i * STEP + 0.5) / SIZE) / n);
        const lat = latFromMercatorY((y + (j * STEP + 0.5) / SIZE) / n);
        let crs: [number, number] | null;
        if (input.inverse) {
          const start = guess ?? pixelToCrs(input, input.image.width / 2, input.image.height / 2);
          crs = solve(input.inverse, lng, lat, start);
          if (crs) guess = crs;
        } else {
          crs = [lng, lat];
        }
        if (!crs) continue;
        const [u, v] = pixelOf(input, crs[0], crs[1]);
        nodes[(j * NODES + i) * 2] = u;
        nodes[(j * NODES + i) * 2 + 1] = v;
        u0 = Math.min(u0, u);
        v0 = Math.min(v0, v);
        u1 = Math.max(u1, u);
        v1 = Math.max(v1, v);
      }
    }
    const image = input.image;
    if (!(u1 > -1 && v1 > -1 && u0 < image.width + 1 && v0 < image.height + 1)) continue;
    await loadBlocks(input, u0 - 2, v0 - 2, u1 + 2, v1 + 2);
    for (let j = 0; j < SIZE; j++) {
      const gj = Math.min(NODES - 2, Math.floor(j / STEP));
      const tj = (j - gj * STEP) / STEP;
      for (let i = 0; i < SIZE; i++) {
        const at = j * SIZE + i;
        if (!Number.isNaN(out[at]!)) continue;
        const gi = Math.min(NODES - 2, Math.floor(i / STEP));
        const ti = (i - gi * STEP) / STEP;
        const k00 = (gj * NODES + gi) * 2;
        const k10 = k00 + 2;
        const k01 = k00 + NODES * 2;
        const k11 = k01 + 2;
        const u =
          (nodes[k00]! * (1 - ti) + nodes[k10]! * ti) * (1 - tj) + (nodes[k01]! * (1 - ti) + nodes[k11]! * ti) * tj;
        const v =
          (nodes[k00 + 1]! * (1 - ti) + nodes[k10 + 1]! * ti) * (1 - tj) +
          (nodes[k01 + 1]! * (1 - ti) + nodes[k11 + 1]! * ti) * tj;
        if (Number.isNaN(u) || Number.isNaN(v)) continue;
        const value = sample(input, u, v);
        if (value === null) continue;
        out[at] = value * input.unit;
        any = true;
      }
    }
  }
  return any ? out : null;
}

function pixelToCrs(input: Input, col: number, row: number): [number, number] {
  const [a, b, c, d, e, f] = input.affine;
  return [a + b * col + c * row, d + e * col + f * row];
}

async function loadBlocks(input: Input, u0: number, v0: number, u1: number, v1: number): Promise<void> {
  const image = input.image;
  const bw = image.blockWidth;
  const bh = image.blockHeight;
  const across = blocksAcross(image);
  const down = Math.ceil(image.height / bh);
  const c0 = Math.max(0, Math.floor(u0 / bw));
  const c1 = Math.min(across - 1, Math.floor(u1 / bw));
  const r0 = Math.max(0, Math.floor(v0 / bh));
  const r1 = Math.min(down - 1, Math.floor(v1 / bh));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const index = r * across + c;
      const cached = input.blocks.get(index);
      if (cached) {
        input.blocks.delete(index);
        input.blocks.set(index, cached);
        continue;
      }
      input.blocks.set(index, await readBlock(input.source, image, index));
    }
  }
  const limit = Math.max(4, Math.floor(CACHE_BYTES / (bw * bh * 4)));
  while (input.blocks.size > limit) {
    const oldest = input.blocks.keys().next().value;
    if (oldest === undefined) break;
    input.blocks.delete(oldest);
  }
}

function pixel(input: Input, col: number, row: number): number | null {
  const image = input.image;
  if (col < 0 || row < 0 || col >= image.width || row >= image.height) return null;
  const bw = image.blockWidth;
  const bh = image.blockHeight;
  const block = input.blocks.get(Math.floor(row / bh) * blocksAcross(image) + Math.floor(col / bw));
  if (!block) return null;
  const value = block[(row % bh) * bw + (col % bw)]!;
  if (Number.isNaN(value) || (input.noData !== null && value === input.noData)) return null;
  const meters = value * input.unit;
  return meters < -11000 || meters > 9000 ? null : value;
}

function sample(input: Input, u: number, v: number): number | null {
  const fx = u - 0.5;
  const fy = v - 0.5;
  const image = input.image;
  if (fx < -0.5 || fy < -0.5 || fx > image.width - 0.5 || fy > image.height - 0.5) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let sum = 0;
  let weight = 0;
  for (const [dx, dy, w] of [
    [0, 0, (1 - tx) * (1 - ty)],
    [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty],
    [1, 1, tx * ty],
  ] as const) {
    if (w <= 0) continue;
    const value = pixel(input, x0 + dx, y0 + dy);
    if (value === null) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

function downsample(kids: (Float32Array | null)[]): Float32Array | null {
  const out = new Float32Array(SIZE * SIZE).fill(Number.NaN);
  const half = SIZE / 2;
  let any = false;
  for (let q = 0; q < 4; q++) {
    const kid = kids[q];
    if (!kid) continue;
    const ox = (q & 1) * half;
    const oy = (q >> 1) * half;
    for (let j = 0; j < half; j++) {
      for (let i = 0; i < half; i++) {
        const k = j * 2 * SIZE + i * 2;
        let sum = 0;
        let count = 0;
        for (const v of [kid[k]!, kid[k + 1]!, kid[k + SIZE]!, kid[k + SIZE + 1]!]) {
          if (Number.isNaN(v)) continue;
          sum += v;
          count++;
        }
        if (count === 0) continue;
        out[(oy + j) * SIZE + ox + i] = sum / count;
        any = true;
      }
    }
  }
  return any ? out : null;
}

export function terrariumPng(elevation: Float32Array): Uint8Array {
  let missing = false;
  for (const v of elevation) {
    if (Number.isNaN(v)) {
      missing = true;
      break;
    }
  }
  const channels = missing ? 4 : 3;
  const pixels = new Uint8Array(SIZE * SIZE * channels);
  for (let i = 0; i < elevation.length; i++) {
    const v = elevation[i]!;
    const o = i * channels;
    if (Number.isNaN(v)) continue;
    const shifted = Math.min(65535.99, Math.max(0, v + 32768));
    let whole = Math.floor(shifted);
    let fraction = Math.round((shifted - whole) * 256);
    if (fraction === 256) {
      whole = Math.min(65535, whole + 1);
      fraction = 0;
    }
    pixels[o] = whole >> 8;
    pixels[o + 1] = whole & 255;
    pixels[o + 2] = fraction;
    if (channels === 4) pixels[o + 3] = 255;
  }
  return encodePng(SIZE, SIZE, channels, pixels);
}
