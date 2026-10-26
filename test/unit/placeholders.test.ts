import assert from "node:assert/strict";
import { test } from "node:test";
import { Placeholders } from "../../src/sources/raster.ts";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

test("the same picture at two zoom levels is a placeholder, and the earlier copy is dropped", () => {
  const forgotten: string[] = [];
  const found = new Placeholders((z, x, y) => forgotten.push(`${z}/${x}/${y}`));
  const blank = bytes(9, 9, 9, 9);
  const first = found.note({ z: 17, x: 1, y: 1 }, blank);
  assert.notEqual(first, null);
  assert.equal(found.suspect({ z: 17, x: 1, y: 1 }, first!), false);
  const second = found.note({ z: 19, x: 5, y: 2 }, blank);
  assert.equal(second, first);
  assert.equal(found.suspect({ z: 19, x: 5, y: 2 }, second!), true);
  found.confirm(second!, { z: 19, x: 5, y: 2 });
  assert.deepEqual(forgotten, ["17/1/1"]);
  assert.equal(found.note({ z: 18, x: 2, y: 2 }, blank), null);
});

test("a picture that repeats across one zoom level is a pattern, not missing data", () => {
  const found = new Placeholders(() => {});
  const checker = bytes(7, 7);
  found.note({ z: 4, x: 0, y: 0 }, checker);
  found.note({ z: 4, x: 2, y: 0 }, checker);
  const hash = found.note({ z: 4, x: 1, y: 1 }, checker);
  assert.equal(found.suspect({ z: 4, x: 1, y: 1 }, hash!), false);
});

test("different pictures are never suspected and the world tile is left alone", () => {
  const found = new Placeholders(() => {});
  const a = found.note({ z: 5, x: 1, y: 1 }, bytes(1, 2, 3));
  const b = found.note({ z: 6, x: 2, y: 1 }, bytes(1, 2, 4));
  assert.notEqual(a, b);
  assert.equal(found.suspect({ z: 6, x: 2, y: 1 }, b!), false);
  found.note({ z: 1, x: 0, y: 0 }, bytes(1, 2, 3));
  const world = found.note({ z: 0, x: 0, y: 0 }, bytes(1, 2, 3));
  assert.equal(found.suspect({ z: 0, x: 0, y: 0 }, world!), false);
});
