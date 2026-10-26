import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bytesToGeoJSON } from "../../src/formats/convert.ts";
import { gmlToGeoJSON } from "../../src/formats/gml.ts";
import type { FeatureCollection, Position } from "../../src/geo/geojson.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/gml.json", import.meta.url), "utf8")) as {
  sources: Record<string, string>;
  expected: Record<string, { type: string; coordinates: unknown; name: string }[]>;
};

function ring(r: Position[]): string {
  const open = r.slice(0, -1).map((p) => p.map((v) => v.toFixed(6)).join(" "));
  const variants: string[] = [];
  for (const seq of [open, [...open].reverse()]) {
    for (let i = 0; i < seq.length; i++) variants.push([...seq.slice(i), ...seq.slice(0, i)].join(","));
  }
  return variants.sort()[0]!;
}

function normal(type: string, coordinates: unknown): unknown {
  const round = (p: Position) => p.map((v) => Number(v.toFixed(6)));
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

test("GML 2, 3 and 3.2 written by GDAL read back in longitude and latitude", () => {
  for (const [name, source] of Object.entries(fixture.sources)) {
    const fc = gmlToGeoJSON(source);
    const want = fixture.expected[name]!;
    assert.equal(fc.features.length, want.length, name);
    fc.features.forEach((f, i) => {
      const g = f.geometry as { type: string; coordinates: unknown };
      assert.equal(g.type, want[i]!.type, `${name} ${i}`);
      assert.deepEqual(normal(g.type, g.coordinates), normal(want[i]!.type, want[i]!.coordinates), `${name} ${i}`);
      assert.equal(f.properties?.name, want[i]!.name, `${name} ${i}`);
    });
    assert.deepEqual(
      fc.features.map((f) => [f.properties?.count, f.properties?.value]),
      [
        [1, 1.5],
        [2, 2.25],
        [3, 3],
        [4, 4.75],
        [5, 5.5],
        [6, 6.125],
      ],
      name,
    );
  }
});

test("a WFS 2.0 response with curves, surfaces, envelopes, 3D points and empty values", () => {
  const wfs = `<?xml version="1.0"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:app="urn:x">
  <wfs:member><app:Road gml:id="r1"><app:name>Main</app:name><app:note xsi:nil="true"/>
    <app:shape><gml:Curve srsName="http://www.opengis.net/def/crs/EPSG/0/4326"><gml:segments>
      <gml:LineStringSegment><gml:posList>47.6 -122.3 47.61 -122.31</gml:posList></gml:LineStringSegment>
      <gml:LineStringSegment><gml:posList srsDimension="2">47.61 -122.31 47.62 -122.3</gml:posList></gml:LineStringSegment>
    </gml:segments></gml:Curve></app:shape>
    <app:extent><gml:Envelope srsName="EPSG:4326"><gml:lowerCorner>1 2</gml:lowerCorner><gml:upperCorner>3 4</gml:upperCorner></gml:Envelope></app:extent>
  </app:Road></wfs:member>
  <wfs:member><app:Lot gml:id="l1"><app:where><gml:Surface srsName="EPSG:4326"><gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing>
    <gml:posList>0 0 1 0 1 1 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches></gml:Surface></app:where></app:Lot></wfs:member>
  <wfs:member><app:Peak gml:id="p1"><app:at><gml:Point srsName="urn:ogc:def:crs:EPSG::4979"><gml:pos srsDimension="3">46.85 -121.76 4392</gml:pos></gml:Point></app:at></app:Peak></wfs:member>
</wfs:FeatureCollection>`;
  const fc = gmlToGeoJSON(wfs);
  assert.deepEqual(
    fc.features.map((f) => [f.id, f.geometry]),
    [
      [
        "r1",
        {
          type: "LineString",
          coordinates: [
            [-122.3, 47.6],
            [-122.31, 47.61],
            [-122.3, 47.62],
          ],
        },
      ],
      [
        "l1",
        {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      ],
      ["p1", { type: "Point", coordinates: [-121.76, 46.85, 4392] }],
    ],
  );
  assert.deepEqual(fc.features[0]!.properties, {
    name: "Main",
    note: null,
    extent: {
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
  });
});

test("GML is recognized from its namespace, and a bare geometry document reads as one feature", async () => {
  const fc = (await bytesToGeoJSON(
    new TextEncoder().encode(fixture.sources["gml2-4326"]!),
    "x.xml",
  )) as FeatureCollection;
  assert.equal(fc.features.length, 6);
  const single = gmlToGeoJSON(
    '<gml:LineString xmlns:gml="http://www.opengis.net/gml"><gml:coordinates decimal="," cs=";" ts=" ">1,5;2 3;4,25</gml:coordinates></gml:LineString>',
  );
  assert.deepEqual(single.features[0]!.geometry, {
    type: "LineString",
    coordinates: [
      [1.5, 2],
      [3, 4.25],
    ],
  });
});
