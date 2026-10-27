import assert from "node:assert/strict";
import { test } from "node:test";
import { standardSlopeScale } from "../../src/render/painter.ts";

const maplibreScale = (size: number, z: number) => {
  const factor = z < 2 ? 0.4 : z < 4.5 ? 0.35 : 0.3;
  const exaggeration = z < 15 ? (z - 15) * factor : 0;
  return (8 * size) / 2 ** (exaggeration + (28.2562 - z));
};

test("standard hillshade scales slope like the MapLibre prepare pass at every zoom", () => {
  for (const size of [256, 512]) {
    for (let z = 0; z <= 18; z++) {
      const ours = standardSlopeScale(size, z);
      const theirs = maplibreScale(size, z);
      assert.ok(Math.abs(ours / theirs - 1) < 0.002, `size ${size} z ${z}: ${ours} vs ${theirs}`);
    }
  }
});

test("standard hillshade boosts low zooms and stops boosting at z15", () => {
  const perPixel = (z: number) => standardSlopeScale(512, z) / ((512 * 2 ** z) / 40030173.6);
  assert.ok(Math.abs(perPixel(9) - 2 ** 1.8) < 1e-3);
  assert.ok(Math.abs(perPixel(15) - 1) < 1e-3);
  assert.ok(Math.abs(perPixel(17) - 1) < 1e-3);
});
