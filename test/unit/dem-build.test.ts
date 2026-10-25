import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { latFromMercatorY, lngFromMercatorX, mercatorX, mercatorY } from "../../src/geo/mercator.ts";
import { projectionFromEpsg } from "../../src/geo/projection.ts";
import type { RangeSource } from "../../src/sources/pmtiles.ts";
import { PMTilesArchive } from "../../src/sources/pmtiles.ts";
import { buildDem } from "../../tools/tiles/dem.ts";
import { writeTiff } from "./tiff-writer.ts";

const surface = (lng: number, lat: number) =>
  600 + 400 * Math.sin((lng + 122) * 20) * Math.cos((lat - 47) * 25) + 30 * (lng + 122);

function decodePng(bytes: Uint8Array): { width: number; height: number; channels: number; pixels: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      pixels[y * stride + i] = (value + predicted) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function fileSource(bytes: Uint8Array): RangeSource {
  return { key: "test", read: async (offset, length) => ({ data: bytes.subarray(offset, offset + length) }) };
}

async function heights(archive: PMTilesArchive, z: number, x: number, y: number) {
  const data = await archive.tile(z, x, y, new AbortController().signal);
  assert.ok(data, `tile ${z}/${x}/${y} is missing`);
  const png = decodePng(data);
  assert.equal(png.width, 512);
  return (i: number, j: number): number | null => {
    const o = (j * 512 + i) * png.channels;
    if (png.channels === 4 && png.pixels[o + 3] === 0) return null;
    return png.pixels[o]! * 256 + png.pixels[o + 1]! + png.pixels[o + 2]! / 256 - 32768;
  };
}

function pixelCenter(z: number, x: number, y: number, i: number, j: number): [number, number] {
  const n = 2 ** z;
  return [lngFromMercatorX((x + (i + 0.5) / 512) / n), latFromMercatorY((y + (j + 0.5) / 512) / n)];
}

async function build(tiff: Uint8Array, maxZoom: number, minZoom: number) {
  const dir = mkdtempSync(join(tmpdir(), "maplet-dem-"));
  try {
    writeFileSync(join(dir, "dem.tif"), tiff);
    const result = await buildDem({
      inputs: [join(dir, "dem.tif")],
      output: join(dir, "dem.pmtiles"),
      maxZoom,
      minZoom,
    });
    const archive = new PMTilesArchive(fileSource(new Uint8Array(readFileSync(join(dir, "dem.pmtiles")))));
    return { result, archive };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a GeoTIFF in longitude and latitude becomes Terrarium tiles with the same heights", async () => {
  const west = -122.1;
  const north = 47.1;
  const step = 0.0004;
  const tiff = writeTiff({
    little: true,
    big: false,
    width: 500,
    height: 400,
    tile: 128,
    type: "f32",
    deflate: true,
    value: (c, r) => surface(west + (c + 0.5) * step, north - (r + 0.5) * step),
    tags: [
      [33550, 12, [step, step, 0]],
      [33922, 12, [0, 0, 0, west, north, 0]],
      [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
    ],
  });
  const { result, archive } = await build(tiff, 12, 10);
  assert.equal(result.minZoom, 10);
  assert.equal(result.maxZoom, 12);
  const header = await archive.header();
  assert.equal(header.tileType, 2);
  const z = 12;
  const x = Math.floor(mercatorX(-122.0) * 2 ** z);
  const y = Math.floor(mercatorY(47.02) * 2 ** z);
  const read = await heights(archive, z, x, y);
  let checked = 0;
  for (let j = 8; j < 512; j += 37) {
    for (let i = 8; i < 512; i += 37) {
      const [lng, lat] = pixelCenter(z, x, y, i, j);
      const inside = lng > west + step && lng < west + 499 * step && lat < north - step && lat > north - 399 * step;
      const value = read(i, j);
      if (!inside) continue;
      assert.ok(value !== null, `no height at ${lng},${lat}`);
      assert.ok(
        Math.abs(value - surface(lng, lat)) < 0.05,
        `height at ${lng},${lat}: ${value} vs ${surface(lng, lat)}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 50, `only ${checked} pixels were inside the data`);
  const zx = Math.floor(mercatorX(-122.0) * 2 ** 10);
  const zy = Math.floor(mercatorY(47.02) * 2 ** 10);
  const coarse = await heights(archive, 10, zx, zy);
  const [lng, lat] = pixelCenter(10, zx, zy, 300, 300);
  const value = coarse(300, 300);
  if (lng > west && lng < west + 500 * step && lat < north && lat > north - 400 * step) {
    assert.ok(
      value !== null && Math.abs(value - surface(lng, lat)) < 0.5,
      `z10 height ${value} vs ${surface(lng, lat)}`,
    );
  }
});

test("a UTM GeoTIFF is reprojected onto the tile grid", async () => {
  const toLngLat = projectionFromEpsg(32610)!;
  const x0 = 575000;
  const y0 = 5210000;
  const size = 25;
  const tiff = writeTiff({
    little: true,
    big: false,
    width: 300,
    height: 250,
    tile: null,
    type: "f32",
    deflate: true,
    value: (c, r) => {
      const [lng, lat] = toLngLat(x0 + (c + 0.5) * size, y0 - (r + 0.5) * size);
      return surface(lng, lat);
    },
    tags: [
      [33550, 12, [size, size, 0]],
      [33922, 12, [0, 0, 0, x0, y0, 0]],
      [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32610]],
    ],
  });
  const { archive } = await build(tiff, 12, 12);
  const [cl, cp] = toLngLat(x0 + 150 * size, y0 - 125 * size);
  const z = 12;
  const x = Math.floor(mercatorX(cl) * 2 ** z);
  const y = Math.floor(mercatorY(cp) * 2 ** z);
  const read = await heights(archive, z, x, y);
  let checked = 0;
  for (let j = 16; j < 512; j += 61) {
    for (let i = 16; i < 512; i += 61) {
      const [lng, lat] = pixelCenter(z, x, y, i, j);
      const value = read(i, j);
      if (value === null) continue;
      assert.ok(Math.abs(value - surface(lng, lat)) < 0.1, `height at ${lng},${lat}: ${value} vs ${surface(lng, lat)}`);
      checked++;
    }
  }
  assert.ok(checked > 20, `only ${checked} pixels had data`);
});
