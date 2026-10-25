import assert from "node:assert/strict";
import { test } from "node:test";
import { overlayWraps, projectiveWeights } from "../../src/sources/image.ts";

type Point = readonly [number, number];

function squareToQuad(quad: readonly Point[], u: number, v: number): Point {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad as [Point, Point, Point, Point];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  const w = g * u + h * v + 1;
  return [
    ((x1 - x0 + g * x1) * u + (x3 - x0 + h * x3) * v + x0) / w,
    ((y1 - y0 + g * y1) * u + (y3 - y0 + h * y3) * v + y0) / w,
  ];
}

function barycentric(p: Point, a: Point, b: Point, c: Point): [number, number, number] {
  const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  const beta = ((p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])) / det;
  const gamma = ((b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])) / det;
  return [1 - beta - gamma, beta, gamma];
}

function sample(quad: readonly Point[], p: Point): Point {
  const q = projectiveWeights(quad);
  const uv: Point[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (const [i, j, k] of [
    [0, 1, 2],
    [0, 2, 3],
  ] as const) {
    const [l0, l1, l2] = barycentric(p, quad[i]!, quad[j]!, quad[k]!);
    if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
    const mix = (n: 0 | 1) => l0 * uv[i]![n] * q[i]! + l1 * uv[j]![n] * q[j]! + l2 * uv[k]![n] * q[k]!;
    const weight = l0 * q[i]! + l1 * q[j]! + l2 * q[k]!;
    return [mix(0) / weight, mix(1) / weight];
  }
  throw new Error(`${p} is outside the quad`);
}

test("rectangles and parallelograms map without perspective", () => {
  assert.deepEqual(
    projectiveWeights([
      [0, 0],
      [2, 0],
      [2, 1],
      [0, 1],
    ]),
    [2, 2, 2, 2],
  );
  const skewed = projectiveWeights([
    [0, 0],
    [2, 0],
    [3, 1],
    [1, 1],
  ]);
  for (const w of skewed) assert.ok(Math.abs(w - 2) < 1e-12);
});

test("every point of a trapezoid samples the picture like a true perspective mapping", () => {
  const quads: Point[][] = [
    [
      [-10, 15],
      [10, 15],
      [25, -15],
      [-25, -15],
    ],
    [
      [0, 0],
      [4, 1],
      [5, 6],
      [-1, 3],
    ],
  ];
  for (const quad of quads) {
    for (let u = 0.05; u < 1; u += 0.15) {
      for (let v = 0.05; v < 1; v += 0.15) {
        const [su, sv] = sample(quad, squareToQuad(quad, u, v));
        assert.ok(Math.abs(su - u) < 1e-9 && Math.abs(sv - v) < 1e-9, `${quad} at ${u},${v} gave ${su},${sv}`);
      }
    }
  }
});

test("corners in the wrong order fall back to a plain mapping", () => {
  assert.deepEqual(
    projectiveWeights([
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ]),
    [1, 1, 1, 1],
  );
});

test("overlays are drawn once for every world copy they show up in", () => {
  const box = [0.2, 0.2, 0.4, 0.4] as const;
  assert.deepEqual(overlayWraps(box, [0, 0, 1, 1], true), [0]);
  assert.deepEqual(overlayWraps(box, [0.9, 0, 1.3, 1], true), [1]);
  assert.deepEqual(overlayWraps(box, [-2, 0, 2, 1], true), [-2, -1, 0, 1]);
  assert.deepEqual(overlayWraps(box, [-2, 0, 2, 1], false), [0]);
  assert.deepEqual(overlayWraps(box, [0.9, 0, 1.3, 1], false), []);
  assert.deepEqual(overlayWraps(box, [0, 0.5, 1, 1], true), []);
  assert.deepEqual(overlayWraps([0.97, 0.4, 1.03, 0.5], [0, 0, 0.1, 1], true), [-1]);
});
