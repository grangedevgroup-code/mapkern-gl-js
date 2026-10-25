import assert from "node:assert/strict";
import { test } from "node:test";
import { fitAxis } from "../../src/text/labels.ts";

test("an icon without stretch zones stretches evenly to its target", () => {
  assert.deepEqual(fitAxis(20, 1, 1, [[0, 20]], 0, 20, 5, 105), { pos: [5, 105], tex: [0, 20], stretch: [true] });
  assert.deepEqual(fitAxis(20, 2, 1, [], 0, 20, 3, 0), { pos: [3, 13], tex: [0, 20], stretch: [false] });
});

test("only the stretch zones grow, so corners keep their size", () => {
  const { pos, tex, stretch } = fitAxis(30, 1, 1, [[10, 20]], 10, 20, 50, 150);
  assert.deepEqual(tex, [0, 10, 20, 30]);
  assert.deepEqual(stretch, [false, true, false]);
  assert.deepEqual(pos, [40, 50, 150, 160]);
});

test("fixed parts inside the content area count toward the target", () => {
  const { pos } = fitAxis(30, 1, 2, [[10, 20]], 5, 25, 0, 100);
  assert.equal(pos[0], -10);
  assert.equal(pos[1], 10);
  assert.equal(pos[2], 90);
  assert.equal(pos[3], 110);
});
