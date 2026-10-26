import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { gridBounds, readDted, readElevationFile, readHgt, sampleGrid } from "../../src/formats/elevation.ts";
import { elevationSet, renderElevationTile } from "../../src/sources/elevation.ts";
import { decodeDemTile, encodeRawElevation, isRawElevation } from "../../src/worker/dem-task.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const dted = new Uint8Array(gunzipSync(fixture("w123_n47.dt0.gz")));
const gdal = JSON.parse(fixture("w123_n47.dt0.json").toString("utf8")) as {
  info: { width: number; height: number; bounds: number[] };
  picks: Record<string, number | null>;
  sum: number;
};

const surface = (lon: number, lat: number) => 1000 + (lon + 123) * 400 + (lat - 47) * 250;

function hgt(): Uint8Array {
  const n = 1201;
  const bytes = new Uint8Array(n * n * 2);
  const view = new DataView(bytes.buffer);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const value = r === 600 && c === 600 ? -32768 : Math.round(surface(-123 + c / (n - 1), 48 - r / (n - 1)));
      view.setInt16((r * n + c) * 2, value, false);
    }
  }
  return bytes;
}

test("a DTED cell written by GDAL reads back with the same heights, voids and extent", () => {
  const grid = readDted(dted);
  assert.equal(grid.columns, gdal.info.width);
  assert.equal(grid.rows, gdal.info.height);
  gridBounds(grid).forEach((v, i) => {
    assert.ok(Math.abs(v - gdal.info.bounds[i]!) < 1e-9, `bound ${i}: ${v} vs ${gdal.info.bounds[i]}`);
  });
  for (const [rc, want] of Object.entries(gdal.picks)) {
    const [r, c] = rc.split(",").map(Number) as [number, number];
    const v = grid.values[r * grid.columns + c]!;
    if (want === null) assert.ok(Number.isNaN(v), `${rc} should be a void`);
    else assert.equal(v, want, rc);
  }
  let sum = 0;
  for (const v of grid.values) if (!Number.isNaN(v)) sum += v;
  assert.equal(sum, gdal.sum);
  const broken = dted.slice();
  broken[3428] = 0;
  assert.throws(() => readDted(broken), /damaged/);
});

test("an SRTM .hgt tile is placed from its name and sampled smoothly between posts", async () => {
  const bytes = hgt();
  const grid = readHgt(bytes, "srtm/N47W123.hgt");
  assert.deepEqual(
    gridBounds(grid).map((v) => Number(v.toFixed(6))),
    [-123.000416, 46.999584, -121.999584, 48.000416],
  );
  for (const [lon, lat] of [
    [-122.5, 47.5],
    [-122.123456, 47.987654],
    [-122.9999, 47.0001],
  ] as const) {
    assert.ok(Math.abs(sampleGrid(grid, lon, lat) - surface(lon, lat)) < 0.51, `${lon},${lat}`);
  }
  assert.ok(Math.abs(sampleGrid(grid, -122.5, 47.5) - surface(-122.5, 47.5)) < 0.51);
  assert.ok(Number.isNaN(sampleGrid(grid, -121.5, 47.5)));
  assert.throws(() => readHgt(bytes, "terrain.hgt"), /does not say where it is/);
  const [fromName] = await readElevationFile(bytes, "N47W123.hgt");
  assert.equal(fromName!.columns, 1201);
});

test("elevation tiles are cut from the grids and travel as raw heights into the terrain pipeline", async () => {
  const set = elevationSet([readHgt(hgt(), "N47W123.hgt"), readDted(dted)]);
  assert.equal(set.maxZoom, 11);
  const z = 9;
  const n = 2 ** z;
  const x = Math.floor(((-122.5 + 180) / 360) * n);
  const latRad = (47.5 * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const tile = renderElevationTile(set, z, x, y)!;
  const lon = ((x + 10.5 / 256) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 20.5 / 256)) / n))) * 180) / Math.PI;
  assert.ok(Math.abs(tile[20 * 256 + 10]! - surface(lon, lat)) < 0.51);
  assert.equal(renderElevationTile(set, z, 0, 0), null);
  const raw = encodeRawElevation(tile, 256);
  assert.ok(isRawElevation(raw));
  const { result } = await decodeDemTile({ raw, unpack: [0, 0, 0, 0] }, new AbortController().signal);
  const grid = result!.grid;
  assert.equal(grid.size, 256);
  assert.equal(grid.elevation[(20 + 2) * grid.stride + 10 + 2], tile[20 * 256 + 10]);
});
