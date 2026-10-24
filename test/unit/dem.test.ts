import assert from "node:assert/strict";
import { test } from "node:test";
import type { DemGrid } from "../../src/terrain/dem.ts";
import {
  backfill,
  DEM_BORDER,
  decodeDem,
  gradients,
  NEIGHBORS,
  sampleElevation,
  unpackFor,
  writeFrame,
} from "../../src/terrain/dem.ts";
import { imageType } from "../../src/worker/dem-task.ts";

const TERRARIUM = unpackFor("terrarium");

function terrarium(elevation: number): [number, number, number] {
  const v = elevation + 32768;
  const whole = Math.floor(v);
  return [Math.floor(whole / 256), whole % 256, Math.floor((v - whole) * 256)];
}

function image(size: number, height: (x: number, y: number) => number | null): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = height(x, y);
      const o = (y * size + x) * 4;
      if (h === null) continue;
      const [r, g, b] = terrarium(h);
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
      pixels[o + 3] = 255;
    }
  }
  return pixels;
}

function at(grid: DemGrid, x: number, y: number): number {
  return grid.elevation[(y + DEM_BORDER) * grid.stride + x + DEM_BORDER]!;
}

test("terrarium, mapbox and custom encodings decode to meters", () => {
  const terr = decodeDem(image(2, (x, y) => [-428.5, 0, 1234.25, 8848][y * 2 + x]!), 2, TERRARIUM)!;
  assert.deepEqual([at(terr, 0, 0), at(terr, 1, 0), at(terr, 0, 1), at(terr, 1, 1)], [-428.5, 0, 1234.25, 8848]);
  assert.equal(terr.min, -428.5);
  assert.equal(terr.max, 8848);
  assert.equal(terr.mask, null);

  const mapbox = unpackFor("mapbox");
  const value = 1500.3;
  const code = Math.round((value + 10000) * 10);
  const px = Uint8Array.of(code >> 16, (code >> 8) & 255, code & 255, 255);
  const grid = decodeDem(px, 1, mapbox)!;
  assert.ok(Math.abs(at(grid, 0, 0) - value) < 1e-3);

  const custom = unpackFor({ red: 100, green: 1, blue: 0, offset: -50 });
  assert.equal(at(decodeDem(Uint8Array.of(3, 7, 99, 255), 1, custom)!, 0, 0), 257);
});

test("transparent pixels and impossible depths count as missing", () => {
  const size = 4;
  const grid = decodeDem(
    image(size, (x, y) => (x === 0 && y === 0 ? null : x === 3 && y === 3 ? -32768 : 100 + x)),
    size,
    TERRARIUM,
  )!;
  assert.ok(grid.mask);
  assert.equal(grid.mask[0], 0);
  assert.equal(grid.mask[15], 0);
  assert.equal(grid.mask[1], 255);
  assert.equal(grid.min, 100);
  assert.equal(grid.max, 103);
  assert.equal(at(grid, 0, 0), 101);
  assert.equal(at(grid, 3, 3), 103);
  assert.equal(sampleElevation(grid, 0.1, 0.1), null);
  assert.ok(sampleElevation(grid, 0.6, 0.1) !== null);
  assert.equal(decodeDem(image(2, () => null), 2, TERRARIUM), null);
});

test("the border repeats the edge until neighbors arrive", () => {
  const size = 3;
  const grid = decodeDem(image(size, (x, y) => x * 10 + y), size, TERRARIUM)!;
  const e = grid.elevation;
  const s = grid.stride;
  for (let k = 0; k < DEM_BORDER; k++) {
    assert.equal(e[(DEM_BORDER + 1) * s + k], at(grid, 0, 1));
    assert.equal(e[(DEM_BORDER + 1) * s + DEM_BORDER + size + k], at(grid, size - 1, 1));
    assert.equal(e[k * s + DEM_BORDER + 1], at(grid, 1, 0));
    assert.equal(e[(DEM_BORDER + size + k) * s + DEM_BORDER + 1], at(grid, 1, size - 1));
  }
  assert.equal(e[0], at(grid, 0, 0));
  assert.equal(e[s * s - 1], at(grid, size - 1, size - 1));
});

function surface(X: number, Y: number): number {
  return 50 * Math.sin(X / 3) + 0.25 * Y * Y - 2 * X + 30 * Math.cos((X + Y) / 5);
}

function hornAt(X: number, Y: number): [number, number] {
  const f = (dx: number, dy: number) => Math.fround(surface(X + dx, Y + dy));
  return [
    (f(1, -1) + 2 * f(1, 0) + f(1, 1) - (f(-1, -1) + 2 * f(-1, 0) + f(-1, 1))) / 8,
    (f(-1, 1) + 2 * f(0, 1) + f(1, 1) - (f(-1, -1) + 2 * f(0, -1) + f(1, -1))) / 8,
  ];
}

test("stitched neighbors give the same slopes as one seamless grid", () => {
  const size = 8;
  const tiles: DemGrid[][] = [];
  for (let ty = 0; ty < 3; ty++) {
    const row: DemGrid[] = [];
    for (let tx = 0; tx < 3; tx++) {
      const grid = decodeDem(
        image(size, () => 0),
        size,
        TERRARIUM,
      )!;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          grid.elevation[(y + DEM_BORDER) * grid.stride + x + DEM_BORDER] = surface(tx * size + x, ty * size + y);
        }
      }
      row.push(grid);
    }
    tiles.push(row);
  }
  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      for (const [dx, dy] of NEIGHBORS) {
        const other = tiles[ty + dy]?.[tx + dx];
        if (other) assert.ok(backfill(tiles[ty]![tx]!, other, dx, dy));
      }
    }
  }
  const center = tiles[1]![1]!;
  const g = gradients(center);
  const n = size + 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [ex, ey] = hornAt(size + i - 1, size + j - 1);
      const k = (j * n + i) * 2;
      assert.ok(Math.abs(g[k]! - ex) < 1e-3, `x slope at ${i},${j}: ${g[k]} vs ${ex}`);
      assert.ok(Math.abs(g[k + 1]! - ey) < 1e-3, `y slope at ${i},${j}: ${g[k + 1]} vs ${ey}`);
    }
  }
  const east = gradients(tiles[1]![2]!);
  for (let j = 1; j < n - 1; j++) {
    const ours = (j * n + n - 1) * 2;
    const theirs = (j * n + 1) * 2;
    assert.ok(Math.abs(g[ours]! - east[theirs]!) < 1e-4, `seam slope differs at row ${j}`);
  }
});

test("refreshing the frame matches a full recompute", () => {
  const size = 6;
  const a = decodeDem(image(size, (x, y) => x * x + 3 * y), size, TERRARIUM)!;
  const b = decodeDem(image(size, (x, y) => (x + size) * (x + size) + 3 * y), size, TERRARIUM)!;
  const before = gradients(a);
  backfill(a, b, 1, 0);
  writeFrame(a, before);
  assert.deepEqual(before, gradients(a));
});

test("backfill refuses tiles of different sizes", () => {
  const a = decodeDem(image(4, () => 1), 4, TERRARIUM)!;
  const b = decodeDem(image(2, () => 1), 2, TERRARIUM)!;
  assert.equal(backfill(a, b, 1, 0), false);
  assert.equal(backfill(a, a, 0, 0), false);
});

test("sampling interpolates between pixel centers and reaches across a stitched seam", () => {
  const size = 4;
  const plane = (X: number, Y: number) => 10 * X + Y;
  const a = decodeDem(image(size, plane), size, TERRARIUM)!;
  const b = decodeDem(
    image(size, (x, y) => plane(x + size, y)),
    size,
    TERRARIUM,
  )!;
  assert.equal(sampleElevation(a, 0.5 / size, 0.5 / size), 0);
  assert.ok(Math.abs(sampleElevation(a, 0.5, 0.5)! - plane(1.5, 1.5)) < 1e-4);
  assert.ok(Math.abs(sampleElevation(a, 1, 0.5)! - plane(3, 1.5)) < 1e-4);
  backfill(a, b, 1, 0);
  assert.ok(Math.abs(sampleElevation(a, 1, 0.5)! - plane(3.5, 1.5)) < 1e-4);
});

test("image type is sniffed from the bytes", () => {
  assert.equal(imageType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0)), "image/png");
  assert.equal(
    imageType(Uint8Array.of(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)),
    "image/webp",
  );
  assert.equal(imageType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
});
