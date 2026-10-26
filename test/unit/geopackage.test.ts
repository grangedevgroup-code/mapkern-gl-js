import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { bytesToGeoJSON } from "../../src/formats/convert.ts";
import { GeoPackageError, geopackageToGeoJSON, isGeoPackage, tableColumns } from "../../src/formats/geopackage.ts";
import type { FeatureCollection } from "../../src/geo/geojson.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const gpkg = new Uint8Array(gunzipSync(readFileSync(fixture("layers.gpkg.gz"))));
const expected = JSON.parse(readFileSync(fixture("layers.gpkg.json"), "utf8")) as Record<
  string,
  { type: string; coordinates: unknown; properties: Record<string, unknown> }[]
>;

function same(actual: unknown, wanted: unknown, eps: number, where: string): void {
  if (typeof wanted === "number") {
    assert.equal(typeof actual, "number", where);
    assert.ok(Math.abs((actual as number) - wanted) <= eps, `${where}: ${actual} is not within ${eps} of ${wanted}`);
    return;
  }
  assert.ok(Array.isArray(actual) && Array.isArray(wanted), where);
  assert.equal((actual as unknown[]).length, (wanted as unknown[]).length, `${where} length`);
  (wanted as unknown[]).forEach((w, i) => same((actual as unknown[])[i], w, eps, `${where}[${i}]`));
}

test("a GeoPackage written by GDAL reads back layer by layer in longitude and latitude", async () => {
  assert.ok(isGeoPackage(gpkg));
  const fc = await geopackageToGeoJSON(gpkg);
  for (const [layer, features] of Object.entries(expected)) {
    const got = fc.features.filter((f) => f.properties?.layer === layer);
    assert.equal(got.length, features.length, layer);
    features.forEach((want, i) => {
      const f = got[i]!;
      assert.equal(f.geometry?.type, want.type, `${layer} ${i}`);
      same((f.geometry as { coordinates: unknown }).coordinates, want.coordinates, 1e-7, `${layer} ${i}`);
      const { layer: _, ...properties } = f.properties ?? {};
      assert.deepEqual(properties, want.properties, `${layer} ${i}`);
      assert.equal(f.id, i + 1);
    });
  }
  assert.equal(fc.features.length, 9);
});

test("GeoPackages are recognized from their content, apart from MBTiles", async () => {
  const fc = (await bytesToGeoJSON(gpkg, "upload.bin")) as FeatureCollection;
  assert.equal(fc.features.length, 9);
  const notGpkg = gpkg.slice(0, 100);
  notGpkg.set([0x4d, 0x50, 0x42, 0x58], 68);
  assert.ok(!isGeoPackage(notGpkg));
});

test("column names come from the table definition, with the integer key as the row id", () => {
  assert.deepEqual(
    tableColumns(
      'CREATE TABLE "a b" ( "fid" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "geom" GEOMETRY, "say ""hi""" TEXT)',
    ),
    { names: ["fid", "geom", 'say "hi"'], types: ["INTEGER", "GEOMETRY", "TEXT"], rowid: 0 },
  );
  assert.deepEqual(
    tableColumns("CREATE TABLE t (id INTEGER, [name] TEXT DEFAULT 'a,b', `n` REAL CHECK (n > 0), PRIMARY KEY (id))"),
    { names: ["id", "name", "n"], types: ["INTEGER", "TEXT", "REAL"], rowid: 0 },
  );
  assert.equal(tableColumns("CREATE TABLE t (id INT PRIMARY KEY, x TEXT)").rowid, -1);
  assert.equal(tableColumns("CREATE TABLE t (id INTEGER PRIMARY KEY DESC, x TEXT)").rowid, -1);
  assert.deepEqual(tableColumns("CREATE TABLE t (a TEXT, -- note, here\n b /* c, d */ TEXT)").names, ["a", "b"]);
});

test("an SQLite file that is not a GeoPackage is refused with a clear message", async () => {
  const plain = gpkg.slice();
  plain.set([0, 0, 0, 0], 68);
  assert.ok(!isGeoPackage(plain));
  await assert.rejects(
    geopackageToGeoJSON(
      (() => {
        const copy = gpkg.slice();
        const text = new TextDecoder("latin1").decode(copy);
        const at = text.indexOf("gpkg_contents");
        copy.set(new TextEncoder().encode("xxxx_contents"), at);
        return copy;
      })(),
    ),
    GeoPackageError,
  );
});
