import assert from "node:assert/strict";
import { test } from "node:test";
import { cotToGeoJSON, cotTypeToSidc, geoJSONToCot, isCot, sidcToCotType } from "../../src/formats/cot.ts";
import { fromMgrs, fromUtm, toMgrs, toUtm, utmZone } from "../../src/geo/mgrs.ts";
import { drawSymbol, militarySymbols, parseSidc } from "../../src/military/symbol.ts";

test("letter and number symbol codes read the same way", () => {
  const letters = parseSidc("SFGPUCI----D---");
  assert.equal(letters?.affiliation, "friend");
  assert.equal(letters?.dimension, "ground");
  assert.equal(letters?.icon, "infantry");
  assert.equal(letters?.echelon, "platoon");
  const numbers = parseSidc("10061000161211000000");
  assert.equal(numbers?.affiliation, "hostile");
  assert.equal(numbers?.icon, "infantry");
  assert.equal(numbers?.echelon, "battalion");
  assert.equal(parseSidc("SHAPMF---------")?.dimension, "air");
  assert.equal(parseSidc("SFGAUCI--------")?.planned, true);
  assert.equal(parseSidc("SFGPUCI---A----")?.headquarters, true);
  assert.equal(parseSidc("SJGPUCI--------")?.letter, "J");
  assert.equal(parseSidc("not a code"), null);
});

test("symbols are drawn with the affiliation's frame and colour", () => {
  const friend = drawSymbol("SFGPUCI--------");
  const hostile = drawSymbol("SHGPUCI--------");
  assert.ok(friend && hostile);
  assert.match(friend.svg, /fill="#80E0FF"/);
  assert.match(hostile.svg, /fill="#FF8080"/);
  assert.match(drawSymbol("SFGAUCI--------")!.svg, /stroke-dasharray/);
  assert.doesNotMatch(friend.svg, /stroke-dasharray/);
  assert.ok(friend.width > 0 && friend.height > 0);
  assert.match(drawSymbol("SFGPUCI--------", { label: "A<1>" })!.svg, /A&#60;1&#62;/);
});

test("the map helper draws symbols for sidc: images on demand", () => {
  const added: string[] = [];
  let listener: ((e: { id: string }) => void) | undefined;
  const map = {
    on: (_: string, fn: (e: { id: string }) => void) => {
      listener = fn;
    },
    off: () => {
      listener = undefined;
    },
    hasImage: (id: string) => added.includes(id),
    addImage: (id: string) => {
      added.push(id);
    },
    getPixelRatio: () => 2,
  };
  const stop = militarySymbols(map);
  listener?.({ id: "sidc:SFGPUCI--------" });
  listener?.({ id: "something-else" });
  if (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined") {
    assert.deepEqual(added, ["sidc:SFGPUCI--------"]);
  }
  stop();
  assert.equal(listener, undefined);
});

test("CoT types and symbol codes map both ways", () => {
  assert.equal(cotTypeToSidc("a-f-G-U-C-I"), "SFGPUCI---------".slice(0, 15));
  assert.equal(cotTypeToSidc("a-h-A-M-F"), "SHAPMF---------");
  assert.equal(cotTypeToSidc("b-m-p-s-p-i"), null);
  assert.equal(sidcToCotType("SFGPUCI--------"), "a-f-G-U-C-I");
  assert.equal(sidcToCotType("SHAPMF---------"), "a-h-A-M-F");
});

const COT = `<?xml version="1.0" standalone="yes"?>
<events>
<event version="2.0" uid="ANDROID-1" type="a-f-G-U-C-I" how="m-g" time="2026-10-26T10:00:00Z" start="2026-10-26T10:00:00Z" stale="2026-10-26T10:10:00Z">
  <point lat="47.6062" lon="-122.3321" hae="56" ce="9.9" le="9999999"/>
  <detail><contact callsign="ALPHA 1"/><__group name="Cyan" role="Team Lead"/><track course="90" speed="2.5"/><remarks>Holding at the bridge</remarks></detail>
</event>
<event version="2.0" uid="route-1" type="u-d-f" how="h-e" time="2026-10-26T10:00:00Z" start="2026-10-26T10:00:00Z" stale="2026-10-27T10:00:00Z">
  <point lat="47.6" lon="-122.3" hae="9999999" ce="9999999" le="9999999"/>
  <detail><link point="47.6,-122.3"/><link point="47.61,-122.31"/><link point="47.62,-122.3"/><strokeColor value="-65536"/><strokeWeight value="3"/></detail>
</event>
<event version="2.0" uid="circle-1" type="u-d-c-c" how="h-e" time="2026-10-26T10:00:00Z" start="2026-10-26T10:00:00Z" stale="2026-10-27T10:00:00Z">
  <point lat="47.5" lon="-122.2" hae="0" ce="9999999" le="9999999"/>
  <detail><shape><ellipse major="500" minor="500" angle="0"/></shape><fillColor value="1442775040"/></detail>
</event>
</events>`;

test("CoT events become features with their details", () => {
  assert.ok(isCot(COT));
  const fc = cotToGeoJSON(COT);
  assert.equal(fc.features.length, 3);
  const [unit, route, circle] = fc.features;
  assert.equal(unit!.id, "ANDROID-1");
  assert.deepEqual(unit!.geometry, { type: "Point", coordinates: [-122.3321, 47.6062, 56] });
  assert.equal(unit!.properties!.callsign, "ALPHA 1");
  assert.equal(unit!.properties!.team, "Cyan");
  assert.equal(unit!.properties!.course, 90);
  assert.equal(unit!.properties!.remarks, "Holding at the bridge");
  assert.equal(unit!.properties!.sidc, "SFGPUCI--------");
  assert.equal(unit!.properties!.ce, 9.9);
  assert.equal(route!.geometry!.type, "LineString");
  assert.equal(route!.properties!.stroke, "#ff0000");
  assert.equal(route!.properties!["stroke-width"], 3);
  assert.equal(circle!.geometry!.type, "Polygon");
  const ring = (circle!.geometry as { coordinates: number[][][] }).coordinates[0]!;
  const north = Math.max(...ring.map((p) => p[1]!));
  assert.ok(Math.abs((north - 47.5) * 111320 - 500) < 5, String(north));
});

test("features written as CoT read back the same", () => {
  const fc = cotToGeoJSON(COT);
  const xml = geoJSONToCot(fc, { now: new Date("2026-10-26T12:00:00Z"), staleMinutes: 5 });
  assert.match(xml, /stale="2026-10-26T12:05:00.000Z"/);
  const back = cotToGeoJSON(`<events>${xml}</events>`);
  assert.equal(back.features.length, 3);
  assert.deepEqual(back.features[0]!.geometry, fc.features[0]!.geometry);
  assert.equal(back.features[0]!.properties!.callsign, "ALPHA 1");
  assert.equal(back.features[1]!.geometry!.type, "LineString");
  const written = geoJSONToCot({
    type: "Feature",
    properties: { name: 'Tom & "Jerry"', sidc: "SHGPUCA--------" },
    geometry: { type: "Point", coordinates: [10, 20] },
  });
  assert.match(written, /type="a-h-G-U-C-A"/);
  assert.match(written, /callsign="Tom &#38; &#34;Jerry&#34;"/);
});

const VECTORS: [number, number, string, number, number][] = [
  [-122.335, 47.608, "10TET4998072946", 549980.532, 5272946.767],
  [-77.0352, 38.8895, "18SUJ2348606483", 323486.737, 4306483.048],
  [2.2945, 48.8584, "31UDQ4825211954", 448252.001, 5411954.91],
  [151.2153, -33.8568, "56HLH3490052288", 334900.57, 6252288.753],
  [-43.2105, -22.9519, "23KPQ8347660687", 683476.509, 7460687.308],
  [139.6917, 35.6895, "54SUE8162250298", 381622.23, 3950298.908],
];

test("UTM and MGRS match a reference implementation", () => {
  for (const [lng, lat, grid, easting, northing] of VECTORS) {
    const utm = toUtm([lng, lat]);
    assert.ok(utm);
    assert.ok(Math.abs(utm.easting - easting) < 0.002 && Math.abs(utm.northing - northing) < 0.002, `${lng},${lat}`);
    assert.equal(toMgrs([lng, lat]), grid);
    const back = fromMgrs(grid);
    assert.ok(back && Math.abs(back.lngLat[0] - lng) < 2e-5 && Math.abs(back.lngLat[1] - lat) < 2e-5, grid);
    const round = fromUtm(utm);
    assert.ok(round && Math.abs(round[0] - lng) < 1e-9 && Math.abs(round[1] - lat) < 1e-9);
  }
});

test("MGRS handles zone exceptions, precision and bad input", () => {
  assert.equal(utmZone(5.3, 60.4), 32);
  assert.equal(utmZone(15.6, 78.2), 33);
  assert.equal(toMgrs([-122.335, 47.608], 1), "10TET47");
  assert.equal(fromMgrs("10T ET 4 7")?.precision, 1);
  assert.equal(toMgrs([0, 85]), null);
  assert.equal(fromMgrs("99ZZZ"), null);
  assert.equal(fromMgrs("10TET123"), null);
});
