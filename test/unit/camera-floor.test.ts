import assert from "node:assert/strict";
import { test } from "node:test";
import { highestClearZoom } from "../../src/terrain/terrain.ts";

test("the camera backs off to the nearest zoom that clears the ground", () => {
  const zoom = highestClearZoom(18, 10, (z) => z <= 16.5);
  assert.ok(zoom !== null && Math.abs(zoom - 16.5) < 1e-3, String(zoom));
});

test("over uneven ground nearby requests settle on the same zoom instead of hopping", () => {
  const clear = (z: number) => z <= 16.81 && !(z > 16.4 && z < 16.6);
  const results = [17.01, 17.04, 17.085, 17.2, 17.5].map((requested) => highestClearZoom(requested, 9, clear));
  for (const zoom of results) assert.ok(zoom !== null && Math.abs(zoom - 16.81) < 1e-3, JSON.stringify(results));
});

test("nothing clear within reach gives null", () => {
  assert.equal(
    highestClearZoom(18, 10, () => false),
    null,
  );
});
