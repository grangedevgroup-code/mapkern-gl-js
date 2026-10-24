import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeLines } from "../../tools/tiles/tiler.ts";

const line = (...points: number[]) => Float64Array.from(points);

function sorted(chains: Float64Array[]): number[][] {
  return chains.map((c) => Array.from(c)).sort((a, b) => a.length - b.length || a[0]! - b[0]!);
}

test("pieces of one road join into a single line, whichever way they point", () => {
  const merged = mergeLines([line(1, 0, 2, 0), line(0, 0, 1, 0), line(3, 0, 2, 0)]);
  assert.equal(merged.length, 1);
  const points = Array.from(merged[0]!);
  const forward = [0, 0, 1, 0, 2, 0, 3, 0];
  const backward = [3, 0, 2, 0, 1, 0, 0, 0];
  assert.ok(
    JSON.stringify(points) === JSON.stringify(forward) || JSON.stringify(points) === JSON.stringify(backward),
    `got ${points}`,
  );
});

test("lines stay apart where three or more meet", () => {
  const merged = mergeLines([line(0, 0, 1, 0), line(1, 0, 2, 0), line(1, 0, 1, 1)]);
  assert.equal(merged.length, 3);
});

test("a loop made of two pieces closes on itself", () => {
  const merged = mergeLines([line(0, 0, 1, 0, 1, 1), line(1, 1, 0, 1, 0, 0)]);
  assert.equal(merged.length, 1);
  const points = Array.from(merged[0]!);
  assert.equal(points.length, 10);
  assert.deepEqual(points.slice(0, 2), points.slice(-2));
});

test("lines that do not touch are left alone", () => {
  const merged = mergeLines([line(0, 0, 1, 0), line(5, 5, 6, 6)]);
  assert.deepEqual(sorted(merged), [
    [0, 0, 1, 0],
    [5, 5, 6, 6],
  ]);
});
