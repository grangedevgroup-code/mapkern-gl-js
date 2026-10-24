import assert from "node:assert/strict";
import { test } from "node:test";
import { triangleArea, triangulate } from "../../src/render/tessellate.ts";

function ringArea(coords: number[], start: number, end: number): number {
  let sum = 0;
  for (let i = start, j = end - 1; i < end; j = i++)
    sum += (coords[j * 2]! - coords[i * 2]!) * (coords[i * 2 + 1]! + coords[j * 2 + 1]!);
  return Math.abs(sum / 2);
}

function check(rings: number[][], label: string): number[] {
  const coords: number[] = [];
  const holes: number[] = [];
  rings.forEach((r, i) => {
    if (i > 0) holes.push(coords.length / 2);
    coords.push(...r);
  });
  const out: number[] = [];
  triangulate(coords, holes, out);
  assert.equal(out.length % 3, 0, label);
  let expected = 0;
  const starts = [0, ...holes, coords.length / 2];
  for (let i = 0; i < starts.length - 1; i++) {
    const a = ringArea(coords, starts[i]!, starts[i + 1]!);
    expected += i === 0 ? a : -a;
  }
  const got = triangleArea(coords, out);
  assert.ok(
    Math.abs(got - expected) <= Math.max(1e-6, expected * 1e-9),
    `${label}: triangles cover ${got}, polygon is ${expected}`,
  );
  for (const i of out) assert.ok(i >= 0 && i < coords.length / 2, `${label}: index ${i} out of range`);
  return out;
}

test("square in either winding", () => {
  assert.equal(check([[0, 0, 10, 0, 10, 10, 0, 10]], "ccw").length, 6);
  assert.equal(check([[0, 0, 0, 10, 10, 10, 10, 0]], "cw").length, 6);
});

test("concave shapes", () => {
  check([[0, 0, 10, 0, 10, 10, 5, 3, 0, 10]], "arrow");
  check([[0, 0, 30, 0, 30, 10, 20, 10, 20, 2, 10, 2, 10, 10, 0, 10]], "U shape");
  const star: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = i % 2 === 0 ? 100 : 40;
    const a = (i / 20) * Math.PI * 2;
    star.push(Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r));
  }
  check([star], "star");
});

test("holes", () => {
  check(
    [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [20, 20, 40, 20, 40, 40, 20, 40],
    ],
    "one hole",
  );
  check(
    [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [10, 10, 20, 10, 20, 20, 10, 20],
      [60, 60, 80, 60, 80, 80, 60, 80],
      [10, 60, 30, 60, 30, 90, 10, 90],
      [60, 10, 90, 10, 90, 30, 60, 30],
    ],
    "four holes",
  );
  check(
    [
      [0, 0, 100, 0, 100, 100, 0, 100],
      [50, 0, 70, 20, 50, 40, 30, 20],
    ],
    "hole touching the outer edge",
  );
});

test("degenerate input does not hang or throw", () => {
  check([[0, 0, 10, 0, 20, 0, 20, 10, 10, 10, 0, 10]], "collinear points");
  check([[0, 0, 10, 0, 10, 0, 10, 10, 0, 10]], "duplicate point");
  const out: number[] = [];
  triangulate([0, 0, 1, 1], [], out);
  assert.equal(out.length, 0);
  triangulate([0, 0, 1, 1, 2, 2], [], out);
  assert.equal(out.length, 0);
});

test("large ring uses the spatial index and still covers the area", () => {
  const ring: number[] = [];
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 1000 + (i % 7) * 37 - (i % 3) * 20;
    ring.push(Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r));
  }
  const hole: number[] = [];
  for (let i = 0; i < 300; i++) {
    const a = -(i / 300) * Math.PI * 2;
    hole.push(Math.round(Math.cos(a) * 300 + 100), Math.round(Math.sin(a) * 200));
  }
  const started = performance.now();
  check([ring, hole], "big ring with hole");
  assert.ok(performance.now() - started < 2000);
});

test("random simple polygons triangulate to their exact area", () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 200; trial++) {
    const n = 3 + Math.floor(rand() * 40);
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 20 + rand() * 80;
      pts.push(Math.round(Math.cos(a) * r * 10), Math.round(Math.sin(a) * r * 10));
    }
    check([pts], `random ${trial}`);
  }
});
