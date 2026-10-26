import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bytesToGeoJSON } from "../../src/formats/convert.ts";
import { esriJsonToGeoJSON, isEsriJson } from "../../src/formats/esrijson.ts";
import type { FeatureCollection, Position } from "../../src/geo/geojson.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/esri.json", import.meta.url), "utf8")) as {
  inputs: Record<string, unknown>;
  expected: Record<string, { type: string; coordinates: unknown }[]>;
};

function ring(r: Position[]): string {
  const open = r.slice(0, -1).map((p) => p.map((v) => v.toFixed(7)).join(" "));
  const variants: string[] = [];
  for (const seq of [open, [...open].reverse()]) {
    for (let i = 0; i < seq.length; i++) variants.push([...seq.slice(i), ...seq.slice(0, i)].join(","));
  }
  return variants.sort()[0]!;
}

function normal(type: string, coordinates: unknown): unknown {
  const round = (p: Position) => p.map((v) => Number(v.toFixed(7)));
  switch (type) {
    case "Point":
      return round(coordinates as Position);
    case "MultiPoint":
    case "LineString":
      return (coordinates as Position[]).map(round);
    case "MultiLineString":
      return (coordinates as Position[][]).map((l) => l.map(round));
    case "Polygon":
      return (coordinates as Position[][]).map(ring);
    case "MultiPolygon":
      return (coordinates as Position[][][]).map((p) => p.map(ring)).sort();
    default:
      return coordinates;
  }
}

test("Esri JSON feature sets read the same shapes GDAL reads, in longitude and latitude", () => {
  for (const [name, input] of Object.entries(fixture.inputs)) {
    assert.ok(isEsriJson(input), name);
    const fc = esriJsonToGeoJSON(input);
    const want = fixture.expected[name]!;
    assert.equal(fc.features.length, want.length, name);
    fc.features.forEach((f, i) => {
      const g = f.geometry as { type: string; coordinates: unknown };
      assert.equal(g.type, want[i]!.type, `${name} ${i}`);
      assert.deepEqual(normal(g.type, g.coordinates), normal(want[i]!.type, want[i]!.coordinates), `${name} ${i}`);
    });
  }
});

test("Esri attributes keep their object ids, and dates become ISO text", () => {
  const points = esriJsonToGeoJSON(fixture.inputs.points);
  assert.deepEqual(
    points.features.map((f) => [f.id, f.properties]),
    [
      [1, { OBJECTID: 1, name: "Needle", seen: "2023-11-14T22:13:20.000Z" }],
      [2, { OBJECTID: 2, name: "Dock", seen: null }],
    ],
  );
  const lines = esriJsonToGeoJSON(fixture.inputs.lines);
  assert.deepEqual(
    lines.features.map((f) => f.id),
    [10, 11],
  );
});

test("Esri JSON is recognized inside JSON files, and envelopes and empty shapes are handled", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(fixture.inputs.polygons));
  const fc = (await bytesToGeoJSON(bytes, "layer.json")) as FeatureCollection;
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0]!.geometry?.type, "MultiPolygon");
  const odd = esriJsonToGeoJSON({
    features: [
      { attributes: { a: 1 }, geometry: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 } },
      { attributes: { a: 2 }, geometry: { x: "NaN", y: null } },
      { attributes: { a: 3 }, geometry: null },
      { attributes: { a: 4 }, geometry: { points: [[5, 6]] } },
    ],
  });
  assert.deepEqual(
    odd.features.map((f) => f.geometry),
    [
      {
        type: "Polygon",
        coordinates: [
          [
            [1, 2],
            [3, 2],
            [3, 4],
            [1, 4],
            [1, 2],
          ],
        ],
      },
      null,
      null,
      { type: "Point", coordinates: [5, 6] },
    ],
  );
  assert.ok(!isEsriJson({ type: "FeatureCollection", features: [{ type: "Feature", properties: {} }] }));
  assert.ok(!isEsriJson([1, 2]));
});
