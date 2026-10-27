import assert from "node:assert/strict";
import { test } from "node:test";
import { StyleLayer } from "../../src/style/layer.ts";

const symbols = () => new StyleLayer({ id: "names", type: "symbol", source: "s", layout: { text: ["get", "name"] } });

test("hiding or showing a layer changes its revision so its labels are placed again", () => {
  const layer = symbols();
  const start = layer.revision;
  layer.setVisible(false);
  assert.notEqual(layer.revision, start);
  const hidden = layer.revision;
  layer.setVisible(false);
  assert.equal(layer.revision, hidden);
  layer.setVisible(true);
  assert.notEqual(layer.revision, hidden);
});

test("a new zoom range changes the revision and an unchanged one does not", () => {
  const layer = symbols();
  layer.setZoomRange(5, 12);
  const ranged = layer.revision;
  layer.setZoomRange(5, 12);
  assert.equal(layer.revision, ranged);
  layer.setZoomRange(6, 12);
  assert.notEqual(layer.revision, ranged);
});
