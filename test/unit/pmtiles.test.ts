import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "../../src/formats/pmtiles.ts";
import {
  decodeDirectory,
  encodeDirectory,
  findEntry,
  readHeader,
  tileCoord,
  tileId,
  writeHeader,
} from "../../src/formats/pmtiles.ts";

test("tile ids follow the published examples", () => {
  assert.equal(tileId(0, 0, 0), 0);
  assert.equal(tileId(1, 0, 0), 1);
  assert.equal(tileId(1, 0, 1), 2);
  assert.equal(tileId(1, 1, 1), 3);
  assert.equal(tileId(1, 1, 0), 4);
  assert.equal(tileId(2, 0, 0), 5);
  assert.equal(tileId(12, 3423, 1763), 19078479);
});

test("tile ids round trip at every zoom", () => {
  for (let z = 0; z <= 26; z += z < 6 ? 1 : 5) {
    const n = 2 ** z;
    for (const [x, y] of [
      [0, 0],
      [n - 1, 0],
      [0, n - 1],
      [n - 1, n - 1],
      [Math.floor(n / 3), Math.floor(n / 7)],
    ] as const) {
      assert.deepEqual(tileCoord(tileId(z, x, y)), { z, x, y });
    }
  }
});

test("directories round trip with contiguous offsets and run lengths", () => {
  const entries: Entry[] = [
    { tileId: 0, offset: 0, length: 100, runLength: 1 },
    { tileId: 1, offset: 100, length: 50, runLength: 3 },
    { tileId: 9, offset: 150, length: 20, runLength: 1 },
    { tileId: 10, offset: 5, length: 20, runLength: 1 },
    { tileId: 200, offset: 4000, length: 999, runLength: 0 },
  ];
  assert.deepEqual(decodeDirectory(encodeDirectory(entries)), entries);
});

test("entry lookup honours run lengths and leaf pointers", () => {
  const entries: Entry[] = [
    { tileId: 5, offset: 0, length: 10, runLength: 3 },
    { tileId: 20, offset: 10, length: 10, runLength: 1 },
    { tileId: 100, offset: 0, length: 500, runLength: 0 },
  ];
  assert.equal(findEntry(entries, 4), null);
  assert.equal(findEntry(entries, 7)?.tileId, 5);
  assert.equal(findEntry(entries, 8), null);
  assert.equal(findEntry(entries, 20)?.tileId, 20);
  assert.equal(findEntry(entries, 150)?.runLength, 0);
});

test("headers round trip", () => {
  const h = {
    rootOffset: 127,
    rootLength: 300,
    metadataOffset: 427,
    metadataLength: 80,
    leafOffset: 507,
    leafLength: 0,
    dataOffset: 507,
    dataLength: 2 ** 40,
    addressedTiles: 1234,
    tileEntries: 1000,
    tileContents: 900,
    clustered: true,
    internalCompression: 2,
    tileCompression: 2,
    tileType: 1,
    minZoom: 0,
    maxZoom: 14,
    minLon: -123.3,
    minLat: 46.75,
    maxLon: -121.8,
    maxLat: 48.05,
    centerZoom: 10,
    centerLon: -122.33,
    centerLat: 47.6,
  };
  const back = readHeader(writeHeader(h));
  for (const [k, v] of Object.entries(h)) {
    const got = (back as unknown as Record<string, unknown>)[k];
    if (typeof v === "number" && !Number.isInteger(v)) assert.ok(Math.abs((got as number) - v) < 1e-6, k);
    else assert.equal(got, v, k);
  }
  assert.throws(() => readHeader(new Uint8Array(127)));
});
