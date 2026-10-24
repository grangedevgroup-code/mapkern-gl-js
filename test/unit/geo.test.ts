import assert from "node:assert/strict";
import { test } from "node:test";
import * as mat4 from "../../src/geo/mat4.ts";
import {
  distanceMeters,
  latFromMercatorY,
  lngFromMercatorX,
  MAX_LATITUDE,
  mercatorX,
  mercatorY,
  metersPerPixel,
  toLngLat,
  wrapLongitude,
} from "../../src/geo/mercator.ts";
import {
  childTiles,
  isAncestor,
  parentTile,
  quadkey,
  subRect,
  tileBounds,
  tileFromKey,
  tileKey,
  tmsY,
} from "../../src/geo/tile.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("mercator round trips", () => {
  for (const lng of [-180, -122.33, 0, 45.5, 179.999]) close(lngFromMercatorX(mercatorX(lng)), lng);
  for (const lat of [-85, -47.6, 0, 47.6, 85]) close(latFromMercatorY(mercatorY(lat)), lat, 1e-9);
});

test("mercator reference points", () => {
  close(mercatorX(0), 0.5);
  close(mercatorY(0), 0.5);
  close(mercatorY(MAX_LATITUDE), 0, 1e-12);
  close(mercatorY(-MAX_LATITUDE), 1, 1e-12);
  close(mercatorY(90), 0, 1e-12);
});

test("longitude wrapping", () => {
  close(wrapLongitude(190), -170);
  close(wrapLongitude(-190), 170);
  close(wrapLongitude(180), 180);
  close(wrapLongitude(540), 180);
  close(wrapLongitude(-180), -180);
});

test("lng lat parsing", () => {
  assert.deepEqual(toLngLat([1, 2]), [1, 2]);
  assert.deepEqual(toLngLat({ lng: 3, lat: 4 }), [3, 4]);
  assert.throws(() => toLngLat([Number.NaN, 0]));
  assert.throws(() => toLngLat({ lng: 1 } as never));
});

test("meters per pixel matches the equator scale", () => {
  close(metersPerPixel(0, 0), 40075016.68557849 / 512, 1e-6);
  close(metersPerPixel(60, 1), 40075016.68557849 / 1024 / 2, 1e-6);
});

test("great circle distance", () => {
  const d = distanceMeters([-122.3321, 47.6062], [-122.9007, 47.0379]);
  assert.ok(Math.abs(d - 76900) < 1500, String(d));
});

test("tile keys round trip at every zoom", () => {
  for (const [z, x, y] of [
    [0, 0, 0],
    [1, 1, 0],
    [14, 2627, 5721],
    [24, 16777215, 16777215],
  ] as const) {
    assert.deepEqual(tileFromKey(tileKey(z, x, y)), { z, x, y });
  }
  assert.notEqual(tileKey(1, 0, 1), tileKey(2, 0, 1));
});

test("tile tree helpers", () => {
  assert.deepEqual(parentTile({ z: 3, x: 5, y: 6 }), { z: 2, x: 2, y: 3 });
  assert.deepEqual(parentTile({ z: 3, x: 5, y: 6 }, 3), { z: 0, x: 0, y: 0 });
  assert.equal(childTiles({ z: 1, x: 1, y: 0 }).length, 4);
  assert.ok(isAncestor({ z: 1, x: 1, y: 0 }, { z: 3, x: 5, y: 2 }));
  assert.ok(!isAncestor({ z: 1, x: 0, y: 0 }, { z: 3, x: 5, y: 2 }));
  assert.deepEqual(subRect({ z: 1, x: 1, y: 0 }, { z: 2, x: 3, y: 1 }), { x0: 0.5, y0: 0.5, x1: 1, y1: 1 });
  assert.deepEqual(tileBounds(1, 1, 0, 2), { x0: 2.5, y0: 0, x1: 3, y1: 0.5 });
  assert.equal(tmsY(3, 0), 7);
  assert.equal(quadkey(3, 3, 5), "213");
});

test("matrix inverse", () => {
  const m = mat4.create();
  mat4.perspective(m, 0.7, 1.5, 0.1, 1000);
  mat4.rotateX(m, m, 0.3);
  mat4.rotateZ(m, m, 1.1);
  mat4.translate(m, m, 10, -20, 3);
  const inv = mat4.invert(mat4.create(), m);
  assert.ok(inv);
  const id = mat4.multiply(mat4.create(), m, inv);
  for (let i = 0; i < 16; i++) close(id[i]!, i % 5 === 0 ? 1 : 0, 1e-9);
});
