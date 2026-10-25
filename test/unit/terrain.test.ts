import assert from "node:assert/strict";
import { test } from "node:test";
import type { DemSource } from "../../src/sources/dem.ts";
import { decodeDem, unpackFor } from "../../src/terrain/dem.ts";
import { terrainMesh } from "../../src/terrain/mesh.ts";
import { metersToWorld, Terrain } from "../../src/terrain/terrain.ts";

test("the terrain mesh covers the tile and hangs a skirt on every edge", () => {
  const n = 8;
  const { vertices, indices } = terrainMesh(n);
  const count = vertices.length / 4;
  assert.equal(count, (n + 1) ** 2 + 4 * (n + 1));
  assert.equal(indices.length, n * n * 6 + 4 * n * 6);
  for (const i of indices) assert.ok(i < count);
  const surface = new Set<string>();
  const skirts = new Set<string>();
  for (let v = 0; v < count; v++) {
    const key = `${vertices[v * 4]},${vertices[v * 4 + 1]}`;
    if (vertices[v * 4 + 2] === 1) skirts.add(key);
    else surface.add(key);
  }
  assert.equal(surface.size, (n + 1) ** 2);
  for (let k = 0; k <= n; k++) {
    for (const key of [`${k},0`, `${k},${n}`, `0,${k}`, `${n},${k}`])
      assert.ok(skirts.has(key), `no skirt under ${key}`);
  }
});

function terrainOver(height: (x: number, y: number) => number): Terrain {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const v = height((i + 0.5) / size, (j + 0.5) / size) + 32768;
      const whole = Math.floor(v);
      const o = (j * size + i) * 4;
      pixels[o] = whole >> 8;
      pixels[o + 1] = whole & 255;
      pixels[o + 2] = Math.round((v - whole) * 255);
      pixels[o + 3] = 255;
    }
  }
  const grid = decodeDem(pixels, size, unpackFor("terrarium"))!;
  const tile = { isReady: true, data: { grid } };
  const source = {
    manager: { tiling: { minZoom: 0, maxZoom: 0 }, getTile: () => tile },
  } as unknown as DemSource;
  return new Terrain(source, 1);
}

test("elevation and rays follow the loaded elevation tiles", () => {
  const ramp = (x: number) => 1000 + 4000 * x;
  const terrain = terrainOver((x) => ramp(x));
  const at = terrain.elevationAt(0.5, 0.5)!;
  assert.ok(Math.abs(at - ramp(0.5)) < 1, `elevation ${at}`);
  const y = 0.5;
  const origin = [0.3, y, metersToWorld(60000, y)];
  const dir = [0.02, 0, -metersToWorld(60000, y)];
  const hit = terrain.raycast(origin, dir, Math.hypot(dir[0]!, dir[2]!) * 2);
  assert.ok(hit, "the ray should hit the ground");
  const ground = metersToWorld(ramp(hit[0]), hit[1]);
  assert.ok(Math.abs(hit[2] - ground) < metersToWorld(1, y), `hit ${hit[2]} vs ground ${ground}`);
  const up = terrain.raycast(origin, [0.01, 0, metersToWorld(1000, y)], 1);
  assert.equal(up, null);
});

test("a ridge between the camera and a point hides it", () => {
  const ridge = (x: number) => (Math.abs(x - 0.5) < 0.02 ? 30000 : 0);
  const terrain = terrainOver((x) => ridge(x));
  const y = 0.5;
  const camera = [0.4, y, metersToWorld(5000, y)];
  assert.equal(terrain.hidden(camera, 0.6, y, 0), true);
  assert.equal(terrain.hidden(camera, 0.45, y, 0), false);
});
