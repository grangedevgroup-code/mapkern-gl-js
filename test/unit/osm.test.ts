import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bytesToGeoJSON } from "../../src/formats/convert.ts";
import { isOsmPbf, osmPbfToGeoJSON, osmXmlToGeoJSON } from "../../src/formats/osm.ts";
import type { Feature, FeatureCollection, Position } from "../../src/geo/geojson.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const xml = fixture("sample.osm").toString("utf8");
const pbf = new Uint8Array(fixture("sample.osm.pbf"));
const gdal = JSON.parse(fixture("sample.osm.json").toString("utf8")) as Record<
  string,
  { type: string; coordinates: unknown }
>;

function ring(r: Position[]): string {
  const open = r.slice(0, -1).map((p) => p.map((v) => v.toFixed(7)).join(" "));
  const variants: string[] = [];
  for (const seq of [open, [...open].reverse()]) {
    for (let i = 0; i < seq.length; i++) variants.push([...seq.slice(i), ...seq.slice(0, i)].join(","));
  }
  return variants.sort()[0]!;
}

function canonical(type: string, coordinates: unknown): unknown {
  const round = (p: Position) => p.map((v) => Number(v.toFixed(7)));
  switch (type) {
    case "Point":
      return ["point", round(coordinates as Position)];
    case "LineString":
      return ["lines", [(coordinates as Position[]).map(round)]];
    case "MultiLineString":
      return ["lines", (coordinates as Position[][]).map((l) => l.map(round))];
    case "Polygon":
      return ["areas", [(coordinates as Position[][]).map(ring)]];
    case "MultiPolygon":
      return ["areas", (coordinates as Position[][][]).map((p) => p.map(ring)).sort()];
    default:
      return [type, coordinates];
  }
}

test("OSM XML becomes points, lines, areas, multipolygons with holes and routes, as GDAL reads it", () => {
  const fc = osmXmlToGeoJSON(xml);
  const ids = fc.features.map((f) => String(f.id)).sort();
  assert.deepEqual(ids, Object.keys(gdal).sort());
  for (const f of fc.features) {
    const want = gdal[String(f.id)]!;
    const g = f.geometry as { type: string; coordinates: unknown };
    assert.deepEqual(canonical(g.type, g.coordinates), canonical(want.type, want.coordinates), String(f.id));
  }
  const byId = new Map(fc.features.map((f) => [String(f.id), f]));
  assert.deepEqual(byId.get("node/12345678901")!.properties, { amenity: "cafe", name: "Cafe Ümlaut" });
  assert.equal(byId.get("way/102")!.geometry?.type, "LineString");
  assert.equal(byId.get("way/103")!.geometry?.type, "Polygon");
  const woods = byId.get("relation/300")!;
  assert.deepEqual(woods.properties, { type: "multipolygon", landuse: "forest", name: "Woods" });
  assert.equal((woods.geometry as { coordinates: unknown[] }).coordinates.length, 2);
});

test("OSM PBF from osmium decodes to exactly what the XML gives", async () => {
  assert.ok(isOsmPbf(pbf));
  assert.ok(!isOsmPbf(new TextEncoder().encode(xml)));
  const fromPbf = await osmPbfToGeoJSON(pbf);
  const fromXml = osmXmlToGeoJSON(xml);
  const key = (f: Feature) => String(f.id);
  const sort = (fc: FeatureCollection) => [...fc.features].sort((a, b) => key(a).localeCompare(key(b)));
  const round = (fc: FeatureCollection) =>
    JSON.parse(JSON.stringify(sort(fc), (_k, v) => (typeof v === "number" ? Number(v.toFixed(7)) : v)));
  assert.deepEqual(round(fromPbf), round(fromXml));
});

test("OSM files are recognized by content", async () => {
  const a = (await bytesToGeoJSON(new TextEncoder().encode(xml), "export")) as FeatureCollection;
  const b = (await bytesToGeoJSON(pbf, "seattle.osm.pbf")) as FeatureCollection;
  assert.equal(a.features.length, 9);
  assert.equal(b.features.length, 9);
});
