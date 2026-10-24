import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeParts } from "../../src/worker/symbols.ts";

const line = (...points: number[]) => Int32Array.from(points);

test("street pieces that touch end to start join into one line", () => {
  const merged = mergeParts([line(0, 0, 10, 0), line(10, 0, 20, 0), line(20, 0, 30, 5)]);
  assert.equal(merged.length, 1);
  assert.deepEqual(Array.from(merged[0]!), [0, 0, 10, 0, 20, 0, 30, 5]);
});

test("pieces drawn in opposite directions still join", () => {
  const merged = mergeParts([line(10, 0, 20, 0), line(10, 0, 0, 0), line(30, 0, 20, 0)]);
  assert.equal(merged.length, 1);
  const points = Array.from(merged[0]!);
  assert.equal(points.length, 8);
  const xs = points.filter((_, i) => i % 2 === 0);
  assert.ok(
    JSON.stringify(xs) === JSON.stringify([0, 10, 20, 30]) || JSON.stringify(xs) === JSON.stringify([30, 20, 10, 0]),
    `unexpected order ${points}`,
  );
});

test("pieces that do not touch stay apart and nothing is lost", () => {
  const parts = [line(0, 0, 5, 0), line(100, 100, 110, 100), line(5, 0, 5, 9), line(200, 0, 210, 0)];
  const merged = mergeParts(parts);
  assert.equal(merged.length, 3);
  const count = (list: Int32Array[]) => list.reduce((n, p) => n + p.length / 2, 0);
  assert.equal(count(merged), count(parts) - 1);
});

test("a loop of pieces closes without repeating forever", () => {
  const merged = mergeParts([line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 0)]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.length / 2, 4);
});

test("a very long chain joins without overflowing the call stack", () => {
  const parts: Int32Array[] = [];
  for (let i = 0; i < 40000; i++) parts.push(line(i, 0, i + 1, 0));
  parts.reverse();
  const merged = mergeParts(parts);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.length / 2, 40001);
});
