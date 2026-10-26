import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bytesToGeoJSON } from "../../src/formats/convert.ts";
import { igcToGeoJSON, isIgc, isNmea, isTcx, nmeaToGeoJSON, tcxToGeoJSON } from "../../src/formats/tracks.ts";
import type { FeatureCollection, Position } from "../../src/geo/geojson.ts";

interface Point {
  lon: number;
  lat: number;
  alt?: number;
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tracks.json", import.meta.url), "utf8")) as {
  nmea: { text: string; expected: Point[] };
  igc: { text: string; expected: Point[]; header: Record<string, string> };
  tcx: { text: string; expected: Point[]; hr: [number, number]; distance: number };
};

function matches(line: Position[], want: Point[], what: string): void {
  assert.equal(line.length, want.length, `${what} points`);
  want.forEach((w, i) => {
    const p = line[i]!;
    assert.ok(
      Math.abs(p[0]! - w.lon) < 1e-9 && Math.abs(p[1]! - w.lat) < 1e-9,
      `${what} ${i}: ${p} vs ${w.lon},${w.lat}`,
    );
    if (w.alt !== undefined) assert.equal(p[2], w.alt, `${what} ${i} altitude`);
    else assert.equal(p.length, 2, `${what} ${i} has no altitude`);
  });
}

test("NMEA fixes read as pynmea2 reads them, skipping bad checksums, void fixes and no-fix sentences", () => {
  assert.ok(isNmea(fixture.nmea.text));
  const fc = nmeaToGeoJSON(fixture.nmea.text);
  assert.equal(fc.features.length, 1);
  const f = fc.features[0]!;
  assert.equal(f.geometry?.type, "LineString");
  matches((f.geometry as { coordinates: Position[] }).coordinates, fixture.nmea.expected, "nmea");
  assert.deepEqual(f.properties, { kind: "track", start: "2026-10-25T23:59:58Z", end: "2026-10-26T00:00:04Z" });
});

test("IGC flights read as aerofiles reads them, with the pilot and glider and a flight past midnight", () => {
  assert.ok(isIgc(fixture.igc.text));
  const fc = igcToGeoJSON(fixture.igc.text);
  const f = fc.features[0]!;
  matches((f.geometry as { coordinates: Position[] }).coordinates, fixture.igc.expected, "igc");
  const h = fixture.igc.header;
  assert.deepEqual(f.properties, {
    kind: "flight",
    pilot: h.pilot,
    glider: h.glider_model,
    gliderId: h.glider_registration,
    competitionId: h.competition_id,
    date: h.utc_date,
    start: "2026-10-25T23:59:58Z",
    end: "2026-10-26T00:00:01Z",
  });
});

test("TCX activities and courses read as tcxreader reads them", () => {
  assert.ok(isTcx(fixture.tcx.text));
  const fc = tcxToGeoJSON(fixture.tcx.text);
  const [activity, course, water] = fc.features;
  assert.equal(activity!.geometry?.type, "MultiLineString");
  const points = (activity!.geometry as { coordinates: Position[][] }).coordinates.flat();
  matches(points, fixture.tcx.expected, "tcx");
  assert.deepEqual(activity!.properties, {
    kind: "activity",
    sport: "Running",
    id: "2026-10-26T15:00:00Z",
    start: "2026-10-26T15:00:00Z",
    end: "2026-10-26T15:01:20Z",
    distance: fixture.tcx.distance,
    duration: 100,
    calories: 25,
    heartRate: Math.round(fixture.tcx.hr[0]),
    maxHeartRate: fixture.tcx.hr[1],
  });
  assert.deepEqual(course!.properties, { kind: "course", name: "Loop" });
  assert.deepEqual(water, {
    type: "Feature",
    properties: { kind: "coursepoint", name: "Water", type: "Water", time: "2026-10-26T15:05:00Z" },
    geometry: { type: "Point", coordinates: [-122.325, 47.625] },
  });
});

test("track files are recognized by their content", async () => {
  const enc = new TextEncoder();
  for (const [text, count] of [
    [fixture.nmea.text, 1],
    [fixture.igc.text, 1],
    [fixture.tcx.text, 3],
  ] as const) {
    const fc = (await bytesToGeoJSON(enc.encode(text), "upload")) as FeatureCollection;
    assert.equal(fc.features.length, count, text.slice(0, 20));
  }
  assert.ok(!isNmea("lat,lon\n1,2\n"));
  assert.ok(!isIgc("A,B\n"));
});

test("long runs of spaces in NMEA lines and digits in GML coordinate systems read in linear time", async () => {
  const { gmlToGeoJSON } = await import("../../src/formats/gml.ts");
  const started = performance.now();
  const line = `$GPRMC,${" ".repeat(200000)}x`;
  assert.ok(!isNmea(line));
  assert.equal(nmeaToGeoJSON(line).features.length, 0);
  const srs = `EPSG:${"1".repeat(200000)}x`;
  const fc = gmlToGeoJSON(
    `<gml:Point xmlns:gml="http://www.opengis.net/gml" srsName="${srs}"><gml:coordinates>1,2</gml:coordinates></gml:Point>`,
  );
  assert.deepEqual(fc.features[0]!.geometry, { type: "Point", coordinates: [1, 2] });
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
});
