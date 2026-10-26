import assert from "node:assert/strict";
import { test } from "node:test";
import { Placeholders } from "../../src/sources/raster.ts";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

test("the same picture on two different tiles is a placeholder, and the first copy is dropped", () => {
  const forgotten: string[] = [];
  const found = new Placeholders((z, x, y) => forgotten.push(`${z}/${x}/${y}`));
  const blank = bytes(9, 9, 9, 9);
  const first = found.note({ z: 3, x: 1, y: 1 }, blank);
  assert.notEqual(first, null);
  assert.equal(found.suspect({ z: 3, x: 1, y: 1 }, first!), false);
  const second = found.note({ z: 3, x: 5, y: 2 }, blank);
  assert.equal(second, first);
  assert.equal(found.suspect({ z: 3, x: 5, y: 2 }, second!), true);
  found.confirm(second!, { z: 3, x: 5, y: 2 });
  assert.deepEqual(forgotten, ["3/1/1"]);
  assert.equal(found.note({ z: 4, x: 2, y: 2 }, blank), null);
});

test("a picture that matches its parent is a plain area, not missing data", () => {
  const found = new Placeholders(() => {});
  const sea = bytes(7, 7);
  found.note({ z: 2, x: 0, y: 0 }, sea);
  found.note({ z: 3, x: 0, y: 0 }, sea);
  const hash = found.note({ z: 3, x: 1, y: 0 }, sea);
  assert.equal(found.suspect({ z: 3, x: 1, y: 0 }, hash!), false);
});

test("different pictures are never suspected and the world tile is left alone", () => {
  const found = new Placeholders(() => {});
  const a = found.note({ z: 5, x: 1, y: 1 }, bytes(1, 2, 3));
  const b = found.note({ z: 5, x: 2, y: 1 }, bytes(1, 2, 4));
  assert.notEqual(a, b);
  assert.equal(found.suspect({ z: 5, x: 2, y: 1 }, b!), false);
  const world = found.note({ z: 0, x: 0, y: 0 }, bytes(1, 2, 3));
  assert.equal(found.suspect({ z: 0, x: 0, y: 0 }, world!), false);
});
