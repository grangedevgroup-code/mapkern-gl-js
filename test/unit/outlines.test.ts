import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenOutlines, type Shape } from "../../src/worker/outlines.ts";

const square = (x0: number, y0: number, x1: number, y1: number) => new Int32Array([x0, y0, x1, y0, x1, y1, x0, y1]);
const shape = (rings: Int32Array[], base: number, height: number): Shape => ({ rings, base, height });
const hidden = (shapes: Shape[]) => [...hiddenOutlines(shapes, 4096)];

test("an outline around the parts of a building is left out and the parts stay", () => {
  const outline = shape([square(100, 100, 300, 300)], 0, 184);
  const legs = shape([square(100, 100, 300, 300)], 0, 20);
  const tower = shape([square(180, 180, 220, 220)], 0, 160);
  const top = shape([square(120, 120, 280, 280)], 150, 170);
  assert.deepEqual(hidden([outline, legs, tower, top]), [1, 0, 0, 0]);
});

test("parts side by side that cover the outline together hide it", () => {
  const outline = shape([square(0, 0, 300, 100)], 0, 40);
  const wings = [0, 100, 200].map((x) => shape([square(x, 0, x + 100, 100)], 0, 30 + x / 100));
  assert.deepEqual(hidden([outline, ...wings]), [1, 0, 0, 0]);
});

test("a podium stays when the tower on it is taller", () => {
  const podium = shape([square(0, 0, 200, 200)], 0, 15);
  const tower = shape([square(20, 20, 180, 180)], 0, 100);
  assert.deepEqual(hidden([podium, tower]), [0, 0]);
});

test("a small shape inside a large one is not enough to hide it", () => {
  const hall = shape([square(0, 0, 400, 400)], 0, 12);
  const kiosk = shape([square(10, 10, 60, 60)], 0, 4);
  assert.deepEqual(hidden([hall, kiosk]), [0, 0]);
});

test("a shape in a courtyard is not inside the building around it", () => {
  const block = shape([square(0, 0, 300, 300), square(50, 50, 250, 250)], 0, 20);
  const yard = shape([square(60, 60, 240, 240)], 0, 5);
  assert.deepEqual(hidden([block, yard]), [0, 0]);
});

test("copies at the same height both stay, since neither hides anything", () => {
  const a = shape([square(0, 0, 100, 100)], 0, 30);
  const b = shape([square(0, 0, 100, 100)], 0, 30);
  const inner = shape([square(10, 10, 90, 90)], 0, 30);
  assert.deepEqual(hidden([a, b, inner]), [0, 0, 0]);
});

test("an outline whose parts stop far below its top stays", () => {
  const outline = shape([square(0, 0, 100, 100)], 0, 22);
  const groundFloor = shape([square(0, 0, 100, 100)], 0, 5);
  assert.deepEqual(hidden([outline, groundFloor]), [0, 0]);
});

test("neighbours that share a wall stay", () => {
  const left = shape([square(0, 0, 100, 100)], 0, 30);
  const right = shape([square(100, 0, 200, 100)], 0, 20);
  assert.deepEqual(hidden([left, right]), [0, 0]);
});

test("outlines are hidden by default only on building tile layers", async () => {
  const { StyleLayer } = await import("../../src/style/layer.ts");
  const { layerProgram } = await import("../../src/sources/vector.ts");
  const outlines = (spec: Record<string, unknown>) =>
    layerProgram(new StyleLayer({ id: "b", type: "extrusion", source: "s", ...spec } as never))?.layout.outlines;
  const paint = { height: ["get", "render_height"], base: ["get", "render_min_height"] };
  assert.deepEqual(outlines({ sourceLayer: "building", paint }), paint);
  assert.deepEqual(outlines({ sourceLayer: "Buildings" }), { height: 0, base: 0 });
  assert.equal(outlines({ sourceLayer: "landuse", paint }), undefined);
  assert.equal(outlines({ paint }), undefined);
  assert.equal(outlines({ sourceLayer: "building", layout: { hideOutlines: false }, paint }), undefined);
  assert.deepEqual(outlines({ layout: { hideOutlines: true }, paint }), paint);
  assert.throws(() => outlines({ layout: { hideOutlines: "yes" } }), /true or false/);
});

test("changing a building's height paint reaches new tiles without rebuilding the old ones", async () => {
  const { StyleLayer } = await import("../../src/style/layer.ts");
  const { LayerPrograms } = await import("../../src/sources/vector.ts");
  const layer = new StyleLayer({
    id: "b",
    type: "extrusion",
    source: "s",
    sourceLayer: "building",
    paint: { height: ["get", "render_height"] },
  });
  const programs = new LayerPrograms();
  programs.update([layer]);
  layer.setPaint("height", ["*", 2, ["get", "render_height"]]);
  assert.equal(programs.update([layer]), false);
  const outlines = programs.programs[0]!.layout.outlines as { height: unknown };
  assert.deepEqual(outlines.height, ["*", 2, ["get", "render_height"]]);
  layer.setLayout("hideOutlines", false);
  assert.equal(programs.update([layer]), true);
});
