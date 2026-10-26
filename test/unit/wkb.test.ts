import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseGeoPackageGeometry, parseHexWkb, parseWkb, WkbError } from "../../src/formats/wkb.ts";

interface Vector {
  wkt: string;
  flavor: string;
  order: number;
  hex: string;
  expected: unknown;
}

const vectors = JSON.parse(readFileSync(new URL("./fixtures/wkb.json", import.meta.url), "utf8")) as Vector[];

test("WKB and EWKB in both byte orders read the same as GEOS wrote them", () => {
  assert.ok(vectors.length >= 50);
  for (const v of vectors) {
    assert.deepEqual(parseHexWkb(v.hex), v.expected, `${v.wkt} (${v.flavor}, ${v.order ? "little" : "big"} endian)`);
  }
});

function hex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

test("GeoPackage geometry blobs skip their header and envelope", () => {
  const point = vectors.find((v) => v.wkt === "POINT (30 10)" && v.flavor === "iso" && v.order === 1)!;
  const wkb = hex(point.hex);
  for (const envelope of [0, 1, 2, 3, 4]) {
    const size = [0, 32, 48, 48, 64][envelope]!;
    const blob = new Uint8Array(8 + size + wkb.length);
    blob.set([0x47, 0x50, 0, (envelope << 1) | 1], 0);
    new DataView(blob.buffer).setInt32(4, 4326, true);
    blob.set(wkb, 8 + size);
    assert.deepEqual(parseGeoPackageGeometry(blob), { type: "Point", coordinates: [30, 10] }, `envelope ${envelope}`);
  }
  const empty = new Uint8Array(8 + wkb.length);
  empty.set([0x47, 0x50, 0, 0x11], 0);
  empty.set(wkb, 8);
  assert.equal(parseGeoPackageGeometry(empty), null);
  assert.deepEqual(parseGeoPackageGeometry(wkb), { type: "Point", coordinates: [30, 10] });
});

test("broken WKB is reported instead of read past its end", () => {
  const line = vectors.find((v) => v.wkt.startsWith("LINESTRING (") && v.flavor === "iso" && v.order === 1)!;
  const bytes = hex(line.hex);
  assert.throws(() => parseWkb(bytes.subarray(0, bytes.length - 3)), WkbError);
  const huge = bytes.slice();
  new DataView(huge.buffer).setUint32(5, 0xffffff, true);
  assert.throws(() => parseWkb(huge), WkbError);
  assert.throws(() => parseHexWkb("01020"), WkbError);
  assert.throws(() => parseHexWkb("zz"), WkbError);
  const unknown = hex("0109000000");
  assert.throws(() => parseWkb(unknown), /type 9/);
});
