import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorOffsets, anchorShift, bodyOffsets, chooseAnchor, isAnchor, toOffset } from "../../src/ui/anchor.ts";

test("anchors shift the element so the anchor point sits on the location", () => {
  assert.deepEqual(anchorShift("center"), [-0.5, -0.5]);
  assert.deepEqual(anchorShift("bottom"), [-0.5, -1]);
  assert.deepEqual(anchorShift("top-left"), [0, 0]);
  assert.deepEqual(anchorShift("bottom-right"), [-1, -1]);
  assert.equal(isAnchor("left"), true);
  assert.equal(isAnchor("middle"), false);
});

test("a number offset pushes away from the anchor point", () => {
  const o = anchorOffsets(10);
  assert.deepEqual(o.top, [0, 10]);
  assert.deepEqual(o.bottom, [0, -10]);
  assert.deepEqual(o.left, [10, 0]);
  assert.deepEqual(o.right, [-10, 0]);
  assert.deepEqual(o.center, [0, 0]);
  assert.ok(Math.abs(o["bottom-left"][0] - 10 / Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(o["bottom-left"][1] + 10 / Math.SQRT2) < 1e-12);
});

test("point offsets apply to every anchor and per-anchor offsets fill the rest with zero", () => {
  assert.deepEqual(anchorOffsets([3, -4]).top, [3, -4]);
  assert.deepEqual(anchorOffsets({ x: 1, y: 2 })["bottom-right"], [1, 2]);
  const some = anchorOffsets({ bottom: [0, -30], left: 5 });
  assert.deepEqual(some.bottom, [0, -30]);
  assert.deepEqual(some.left, [5, 0]);
  assert.deepEqual(some.top, [0, 0]);
  assert.throws(() => toOffset("3px", "offset"), /offset must be/);
  assert.throws(() => anchorOffsets(Number.NaN), /finite/);
});

test("popups open above the point unless there is no room", () => {
  const offsets = anchorOffsets(0);
  const view: [number, number] = [800, 600];
  const size: [number, number] = [200, 100];
  assert.equal(chooseAnchor([400, 300], size, view, offsets), "bottom");
  assert.equal(chooseAnchor([400, 40], size, view, offsets), "top");
  assert.equal(chooseAnchor([40, 300], size, view, offsets), "bottom-left");
  assert.equal(chooseAnchor([780, 40], size, view, offsets), "top-right");
  assert.equal(chooseAnchor([400, 40], size, [800, 120], offsets), "bottom");
});

test("offsets around a marker body point at its edges", () => {
  const round = bodyOffsets({ cx: 0, cy: -26, rx: 12, ry: 12, round: true });
  assert.deepEqual(round.bottom, [0, -38]);
  assert.deepEqual(round.top, [0, -14]);
  assert.deepEqual(round.left, [12, -26]);
  assert.ok(Math.abs(round["bottom-left"][0] - 12 / Math.SQRT2) < 1e-12);
  const box = bodyOffsets({ cx: 0, cy: 0, rx: 10, ry: 5, round: false });
  assert.deepEqual(box["top-right"], [-10, 5]);
});
