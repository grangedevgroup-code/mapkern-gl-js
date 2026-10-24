import assert from "node:assert/strict";
import { test } from "node:test";
import { convexHull, polygonIntersectsRect, Transform } from "../../src/camera/transform.ts";
import { EARTH_CIRCUMFERENCE, mercatorX, mercatorY } from "../../src/geo/mercator.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function make(zoom: number, pitch = 0, bearing = 0, w = 800, h = 600): Transform {
  const t = new Transform();
  t.resize(w, h);
  t.setPitchRange(0, 85);
  t.setCenter(-122.33, 47.6);
  t.setZoom(zoom);
  t.setPitch(pitch);
  t.setBearing(bearing);
  return t;
}

test("center projects to the viewport middle", () => {
  for (const pitch of [0, 30, 60]) {
    for (const bearing of [0, 45, -120]) {
      const t = make(12, pitch, bearing);
      const p = t.project(mercatorX(-122.33), mercatorY(47.6));
      close(p.x, 400);
      close(p.y, 300);
    }
  }
});

test("one world pixel is one screen pixel at pitch 0", () => {
  const t = make(10);
  const [cx, cy] = t.centerWorld;
  const ws = t.worldSize;
  const a = t.project(cx, cy);
  const b = t.project(cx + 100 / ws, cy);
  close(b.x - a.x, 100);
  close(b.y - a.y, 0);
  const c = t.project(cx, cy + 100 / ws);
  close(c.y - a.y, 100);
});

test("north is up and east is right at bearing 0", () => {
  const t = make(8);
  const [cx, cy] = t.centerWorld;
  assert.ok(t.project(cx, cy - 0.001).y < 300);
  assert.ok(t.project(cx + 0.001, cy).x > 400);
});

test("bearing 90 puts east at the top", () => {
  const t = make(8, 0, 90);
  const [cx, cy] = t.centerWorld;
  const p = t.project(cx + 0.001, cy);
  close(p.x, 400, 1e-6);
  assert.ok(p.y < 300);
});

test("pitch moves the horizon side away from the camera", () => {
  const t = make(12, 50);
  const [cx, cy] = t.centerWorld;
  const ws = t.worldSize;
  const north = t.project(cx, cy - 100 / ws);
  const south = t.project(cx, cy + 100 / ws);
  assert.ok(300 - north.y < south.y - 300);
});

test("unproject inverts project", () => {
  for (const pitch of [0, 40, 60]) {
    const t = make(14, pitch, 33);
    for (const [px, py] of [
      [10, 590],
      [400, 300],
      [790, 300],
      [200, 450],
    ] as const) {
      const w = t.unproject(px, py);
      assert.ok(w, `ray miss at ${px},${py}`);
      const p = t.project(w[0], w[1]);
      close(p.x, px, 1e-5);
      close(p.y, py, 1e-5);
    }
  }
});

test("zoomAround keeps the anchor under the cursor", () => {
  const t = make(11, 45, 20);
  const before = t.unproject(650, 120)!;
  t.zoomAround(13.5, 650, 120);
  const p = t.project(before[0], before[1]);
  close(p.x, 650, 1e-4);
  close(p.y, 120, 1e-4);
  close(t.zoom, 13.5);
});

test("covering tiles at pitch 0 use one zoom and cover the view", () => {
  const t = make(11.3, 0, 0, 1024, 768);
  const tiles = t.coveringTiles({ tileSize: 512, minZoom: 0, maxZoom: 22, round: false });
  assert.ok(tiles.length > 0);
  for (const tile of tiles) assert.equal(tile.z, 11);
  const area = tiles.length * (512 * 2 ** 0.3) ** 2;
  assert.ok(area >= 1024 * 768, `tiles cover ${area}`);
  assert.ok(tiles.length <= 16, `too many tiles: ${tiles.length}`);
});

test("256 px raster tiles select one zoom level higher", () => {
  const t = make(11.3);
  const tiles = t.coveringTiles({ tileSize: 256, minZoom: 0, maxZoom: 22, round: true });
  for (const tile of tiles) assert.equal(tile.z, 12);
});

test("pitched coverage lowers detail with distance", () => {
  const t = make(14, 60, 0, 1024, 768);
  const tiles = t.coveringTiles({ tileSize: 512, minZoom: 0, maxZoom: 22, round: false });
  const zooms = new Set(tiles.map((tile) => tile.z));
  assert.ok(zooms.has(14));
  assert.ok(Math.min(...zooms) < 14);
  assert.ok(tiles.length < 200, String(tiles.length));
});

test("source max zoom caps covering tiles", () => {
  const t = make(17);
  const tiles = t.coveringTiles({ tileSize: 512, minZoom: 0, maxZoom: 14, round: false });
  for (const tile of tiles) assert.equal(tile.z, 14);
  assert.ok(tiles.length >= 1 && tiles.length <= 4);
});

test("world copies appear across the antimeridian", () => {
  const t = new Transform();
  t.resize(800, 600);
  t.setCenter(179.9, 0);
  t.setZoom(4);
  const tiles = t.coveringTiles({ tileSize: 512, minZoom: 0, maxZoom: 22, round: false });
  const wraps = new Set(tiles.map((tile) => tile.wrap));
  assert.ok(wraps.has(0) && wraps.has(1));
});

test("zoom and pitch limits are enforced", () => {
  const t = make(3);
  t.setZoomRange(2, 10);
  t.setZoom(30);
  assert.equal(t.zoom, 10);
  t.setPitchRange(0, 60);
  t.setPitch(80);
  assert.equal(t.pitch, 60);
  t.setBearing(270);
  assert.equal(t.bearing, -90);
  t.setZoom(Number.NaN);
  assert.equal(t.zoom, 10);
});

test("polygon rect intersection", () => {
  const poly = convexHull([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0.5, 0.5],
  ]);
  assert.equal(poly.length, 4);
  assert.ok(polygonIntersectsRect(poly, 0.5, 0.5, 2, 2));
  assert.ok(!polygonIntersectsRect(poly, 1.1, 0, 2, 1));
  const tri: [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 1],
  ];
  assert.ok(!polygonIntersectsRect(tri, 0.8, 0.8, 1, 1));
});

const worldHeight = (meters: number, y: number) => (meters * Math.cosh(Math.PI * (1 - 2 * y))) / EARTH_CIRCUMFERENCE;

test("an elevated center still projects to the viewport middle", () => {
  for (const pitch of [0, 45, 70]) {
    const t = make(13, pitch, 30);
    t.setElevation(2500);
    const y = mercatorY(47.6);
    const p = t.project(mercatorX(-122.33), y, worldHeight(2500, y) * t.worldSize);
    close(p.x, 400, 1e-6);
    close(p.y, 300, 1e-6);
  }
});

test("changing the center elevation can keep the camera where it is", () => {
  for (const pitch of [0, 35, 65]) {
    const t = make(12.5, pitch, -40);
    t.setElevation(300);
    const points = [
      [-122.3, 47.62, 0],
      [-122.35, 47.58, 1800],
      [-122.33, 47.6, 300],
      [-122.31, 47.65, 4000],
    ].map(([lng, lat, m]) => [mercatorX(lng!), mercatorY(lat!), m!] as const);
    const view = () =>
      points.map(([x, y, m]) => {
        const p = t.project(x, y, worldHeight(m, y) * t.worldSize);
        return [p.x, p.y];
      });
    const before = view();
    t.setElevationKeepCamera(1500);
    assert.equal(t.elevation, 1500);
    assert.ok(t.zoom > 12.5, `zoom should grow as the center rises toward the camera, got ${t.zoom}`);
    const after = view();
    for (let i = 0; i < points.length; i++) {
      close(after[i]![0]!, before[i]![0]!, 1e-6);
      close(after[i]![1]!, before[i]![1]!, 1e-6);
    }
  }
});

test("a ground plane below the center widens the coverage", () => {
  const t = make(13, 60, 20);
  t.setElevation(2000);
  t.setGround(2000);
  const area = (poly: [number, number][]) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  };
  const level = area(t.footprint());
  t.setGround(0);
  const lower = area(t.footprint());
  assert.ok(lower > level * 1.05, `${lower} should exceed ${level}`);
});

test("zoomAround keeps an elevated anchor under the cursor", () => {
  const t = make(11, 45, 20);
  t.setElevation(1000);
  const z = worldHeight(1000, t.centerWorld[1]);
  const anchor = t.unproject(650, 120)!;
  t.zoomAround(13.5, 650, 120, z);
  const p = t.project(anchor[0], anchor[1], z * t.worldSize);
  close(p.x, 650, 1e-4);
  close(p.y, 120, 1e-4);
});
