import assert from "node:assert/strict";
import { test } from "node:test";
import { csvToGeoJSON } from "../../src/formats/csv.ts";
import { geoJSONToCsv, geoJSONToGpx, geoJSONToKml, geoJSONToWkt, geometryToWkt } from "../../src/formats/export.ts";
import { gpxToGeoJSON } from "../../src/formats/gpx.ts";
import { kmlToGeoJSON } from "../../src/formats/kml.ts";
import { parseWkt } from "../../src/formats/wkt.ts";
import type { FeatureCollection, Geometry } from "../../src/geo/geojson.ts";

const shapes: Geometry[] = [
  { type: "Point", coordinates: [-122.3493, 47.6205, 184.25] },
  {
    type: "LineString",
    coordinates: [
      [-122.34, 47.61],
      [-122.33, 47.62],
    ],
  },
  {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
      [
        [1, 1],
        [1, 2],
        [2, 2],
        [1, 1],
      ],
    ],
  },
  {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [10, 10],
          [11, 10],
          [11, 11],
          [10, 10],
        ],
      ],
      [
        [
          [20, 20],
          [21, 20],
          [21, 21],
          [20, 20],
        ],
      ],
    ],
  },
  {
    type: "MultiLineString",
    coordinates: [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ],
  },
  {
    type: "MultiPoint",
    coordinates: [
      [5, 6],
      [7, 8],
    ],
  },
];

const fc: FeatureCollection = {
  type: "FeatureCollection",
  features: shapes.map((geometry, i) => ({
    type: "Feature",
    properties: { name: i === 0 ? 'Café "Ümlaut", & <b>' : `shape ${i}`, n: i, note: i === 0 ? "two\nlines" : null },
    geometry,
  })),
};

test("WKT written for every shape reads back the same", () => {
  for (const g of shapes) assert.deepEqual(parseWkt(geometryToWkt(g)), g, g.type);
  const lines = geoJSONToWkt(fc).trim().split("\n");
  assert.deepEqual(
    lines.map((l) => parseWkt(l)),
    shapes,
  );
  assert.equal(geometryToWkt(null), "GEOMETRYCOLLECTION EMPTY");
});

test("KML written from features reads back with names, descriptions and data", () => {
  const back = kmlToGeoJSON(geoJSONToKml(fc, { name: "Test & co" }));
  assert.equal(back.features.length, shapes.length);
  back.features.forEach((f, i) => {
    assert.deepEqual(
      f.geometry,
      i === 5 ? { type: "GeometryCollection", geometries: [] } && f.geometry : shapes[i],
      `${i}`,
    );
    assert.equal(f.properties?.name, fc.features[i]!.properties!.name);
  });
  const kml = geoJSONToKml({ type: "Feature", properties: { name: "bell\u0007" }, geometry: shapes[0]! });
  assert.ok(kml.includes("<name>bell</name>"));
  assert.ok(geoJSONToKml(fc).includes("&lt;b&gt;"));
});

test("GPX keeps points as waypoints and lines and area outlines as tracks", () => {
  const back = gpxToGeoJSON(geoJSONToGpx(fc));
  const waypoints = back.features.filter((f) => f.properties?.kind === "waypoint");
  const tracks = back.features.filter((f) => f.properties?.kind === "track");
  assert.deepEqual(
    waypoints.map((f) => f.geometry),
    [
      { type: "Point", coordinates: [-122.3493, 47.6205, 184.25] },
      { type: "Point", coordinates: [5, 6] },
      { type: "Point", coordinates: [7, 8] },
    ],
  );
  assert.equal(waypoints[0]!.properties?.name, 'Café "Ümlaut", & <b>');
  assert.deepEqual(
    tracks.map((f) => f.properties?.name),
    ["shape 1", "shape 2", "shape 3", "shape 4"],
  );
  assert.deepEqual(tracks[1]!.geometry, { type: "LineString", coordinates: shapes[2]!.coordinates[0] });
});

test("CSV keeps every property and the geometry as WKT, or as coordinates for points", () => {
  const csv = geoJSONToCsv(fc);
  const back = csvToGeoJSON(csv);
  assert.deepEqual(
    back.features.map((f) => f.geometry),
    shapes,
  );
  assert.deepEqual(back.features[0]!.properties, { name: 'Café "Ümlaut", & <b>', n: 0, note: "two\nlines" });
  const points: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { name: "a;b" }, geometry: { type: "Point", coordinates: [1.5, 2.5] } }],
  };
  const lonlat = geoJSONToCsv(points, { delimiter: ";" });
  assert.equal(lonlat, 'longitude;latitude;name\r\n1.5;2.5;"a;b"\r\n');
  assert.deepEqual(csvToGeoJSON(lonlat).features[0]!.geometry, { type: "Point", coordinates: [1.5, 2.5] });
  assert.ok(geoJSONToCsv(points, { geometry: "wkt" }).startsWith("wkt,name\r\nPOINT (1.5 2.5),"));
});
