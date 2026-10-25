import assert from "node:assert/strict";
import { test } from "node:test";
import { changedKeys, layerUpdate, sameValue } from "../../src/style/diff.ts";
import type { LayerSpec } from "../../src/style/types.ts";

test("values compare by content, and objects that aren't plain data by identity", () => {
  assert.ok(sameValue(1, 1));
  assert.ok(sameValue(Number.NaN, Number.NaN));
  assert.ok(!sameValue(0, "0"));
  assert.ok(sameValue(["get", "name"], ["get", "name"]));
  assert.ok(!sameValue(["get", "name"], ["get", "ref"]));
  assert.ok(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(sameValue({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!sameValue({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!sameValue([1, 2], { 0: 1, 1: 2 }));
  const element = new Map();
  assert.ok(sameValue({ canvas: element }, { canvas: element }));
  assert.ok(!sameValue({ canvas: element }, { canvas: new Map() }));
});

test("changed keys name every difference on either side", () => {
  assert.deepEqual(changedKeys({ type: "geojson", data: { a: 1 } }, { type: "geojson", data: { a: 2 } }), ["data"]);
  assert.deepEqual(changedKeys({ a: 1, b: 2 }, { b: 2, c: 3 }), ["a", "c"]);
  assert.deepEqual(changedKeys({ a: 1 }, { a: 1 }), []);
});

test("a layer is updated in place unless its type, source or sort key changes", () => {
  const before: LayerSpec = {
    id: "roads",
    type: "line",
    source: "osm",
    sourceLayer: "roads",
    minZoom: 5,
    filter: ["==", ["get", "kind"], "major"],
    paint: { color: "#ffffff", width: 2 },
    layout: { cap: "round" },
  };
  assert.equal(layerUpdate(before, { ...before, type: "fill" } as LayerSpec), null);
  assert.equal(layerUpdate(before, { ...before, source: "other" }), null);
  assert.equal(layerUpdate(before, { ...before, sourceLayer: "streets" }), null);
  const same = layerUpdate(before, structuredClone(before));
  assert.deepEqual(same, { paint: [], layout: [], filter: false, zoom: false, visible: false });
  const changed = layerUpdate(before, {
    id: "roads",
    type: "line",
    source: "osm",
    sourceLayer: "roads",
    maxZoom: 24,
    visible: true,
    filter: ["==", ["get", "kind"], "minor"],
    paint: { color: "#000000", opacity: 0.5 },
  });
  assert.deepEqual(changed, {
    paint: [
      ["color", "#000000"],
      ["width", undefined],
      ["opacity", 0.5],
    ],
    layout: [["cap", undefined]],
    filter: true,
    zoom: true,
    visible: false,
  });
});
