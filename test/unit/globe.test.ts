import assert from "node:assert/strict";
import { test } from "node:test";
import { Transform } from "../../src/camera/transform.ts";
import { globeness, mercatorFromUnit, nearestInBox, unitFromMercator } from "../../src/geo/globe.ts";
import { mercatorX, mercatorY } from "../../src/geo/mercator.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function globe(zoom: number, pitch = 0, bearing = 0, lng = -122.33, lat = 47.6): Transform {
  const t = new Transform();
  t.resize(800, 600);
  t.setPitchRange(0, 85);
  t.setZoomRange(-2, 22);
  t.setProjection("globe");
  t.setZoom(zoom);
  t.setPitch(pitch);
  t.setBearing(bearing);
  t.setCenter(lng, lat);
  return t;
}

test("globeness is 1 up to zoom 10, 0 from zoom 12, and smooth between", () => {
  assert.equal(globeness(3), 1);
  assert.equal(globeness(10), 1);
  assert.equal(globeness(12), 0);
  assert.equal(globeness(15), 0);
  close(globeness(11), 0.5);
  assert.ok(globeness(10.5) > globeness(11.5));
});

test("unit vectors round trip through mercator", () => {
  const u = [0, 0, 0];
  for (const [x, y] of [
    [0.1, 0.2],
    [0.5, 0.5],
    [0.9, 0.95],
    [0.01, 0.001],
  ] as const) {
    unitFromMercator(x, y, u);
    close(Math.hypot(u[0]!, u[1]!, u[2]!), 1, 1e-12);
    const [bx, by] = mercatorFromUnit(u[0]!, u[1]!, u[2]!);
    close(bx, x, 1e-12);
    close(by, y, 1e-9);
  }
});

test("nearest point of a lat/lng box is exact", () => {
  const out = [0, 0];
  const rad = Math.PI / 180;
  const inside = nearestInBox(0, 10 * rad, 0, 10 * rad, 5 * rad, 5 * rad, out);
  close(inside, 1);
  const beside = nearestInBox(0, 10 * rad, 0, 10 * rad, 5 * rad, 20 * rad, out);
  let best = -2;
  for (let i = 0; i <= 1000; i++) {
    const lat = (i / 1000) * 10 * rad;
    for (const lng of [0, 10 * rad]) {
      const dot = Math.cos(lat) * Math.cos(5 * rad) * Math.cos(lng - 20 * rad) + Math.sin(lat) * Math.sin(5 * rad);
      best = Math.max(best, dot);
    }
  }
  close(beside, best, 1e-6);
  close(out[1]!, 10 * rad);
});

test("the center projects to the viewport middle on the globe", () => {
  for (const zoom of [0.5, 3, 7, 11]) {
    for (const pitch of [0, 40, 70]) {
      for (const bearing of [0, 60, -150]) {
        const t = globe(zoom, pitch, bearing);
        const p = t.project(mercatorX(-122.33), mercatorY(47.6));
        close(p.x, 400, 1e-6);
        close(p.y, 300, 1e-6);
        assert.ok(p.w > 0);
      }
    }
  }
});

test("near the center the globe matches the flat map scale", () => {
  const t = globe(6);
  const flat = globe(6);
  flat.setProjection("mercator");
  const [cx, cy] = t.centerWorld;
  const ws = t.worldSize;
  for (const [dx, dy] of [
    [3, 0],
    [0, 3],
    [-2, 2],
  ] as const) {
    const a = t.project(cx + dx / ws, cy + dy / ws);
    const b = flat.project(cx + dx / ws, cy + dy / ws);
    close(a.x, b.x, 1e-3);
    close(a.y, b.y, 1e-3);
  }
});

test("unproject and project round trip on the globe and in the morph band", () => {
  for (const zoom of [1.5, 4, 9, 10.6, 11.4]) {
    for (const pitch of [0, 50]) {
      const t = globe(zoom, pitch, 30);
      for (const [sx, sy] of [
        [400, 300],
        [100, 500],
        [700, 450],
        [420, 200],
      ] as const) {
        const hit = t.unproject(sx, sy);
        if (!hit) continue;
        const p = t.project(hit[0], hit[1]);
        close(p.x, sx, 1e-3);
        close(p.y, sy, 1e-3);
      }
    }
  }
});

test("rays that miss the globe unproject to null, clamped to the limb", () => {
  const t = globe(1);
  assert.equal(t.unproject(2, 2), null);
  const edge = t.unprojectClamped(2, 2);
  assert.ok(Number.isFinite(edge[0]) && Number.isFinite(edge[1]));
});

test("the far side of the globe is hidden", () => {
  const t = globe(2, 0, 0, 0, 0);
  assert.ok(t.project(0.5, 0.5).w > 0);
  assert.ok(t.project(0.0, 0.5).w < 0);
  assert.ok(t.project(0.5 + 0.2, 0.5).w > 0);
  assert.ok(t.project(0.5 + 0.3, 0.5).w < 0);
});

test("setLocationAtPoint drags the grabbed point under the pointer", () => {
  for (const zoom of [2, 6, 10.8]) {
    const t = globe(zoom, 20, 10);
    const grabbed = t.unproject(380, 280)!;
    t.setLocationAtPoint(grabbed, 470, 350);
    const p = t.project(grabbed[0], grabbed[1]);
    close(p.x, 470, 1e-4);
    close(p.y, 350, 1e-4);
  }
});

test("panning toward a pole keeps the globe the same size", () => {
  const t = globe(3, 0, 0, 10, 0);
  const radius = t.globeRadius;
  for (let i = 0; i < 20; i++) {
    const grabbed = t.unproject(400, 300)!;
    t.setLocationAtPoint(grabbed, 400, 330, undefined, true);
  }
  assert.ok(t.center[1] > 30, `lat ${t.center[1]}`);
  close(t.globeRadius, radius, radius * 1e-9);
});

test("globe covering skips the far side and keeps a sane tile count", () => {
  const t = globe(2, 0, 0, 0, 0);
  const tiles = t.coveringTiles({ tileSize: 512, minZoom: 0, maxZoom: 22, round: true });
  assert.ok(tiles.length > 0 && tiles.length < 40, `${tiles.length} tiles`);
  for (const tile of tiles) {
    const n = 2 ** tile.z;
    const lngWest = (tile.x / n) * 360 - 180;
    const lngEast = ((tile.x + 1) / n) * 360 - 180;
    assert.ok(!(lngWest >= 100 || lngEast <= -100), `back tile ${tile.z}/${tile.x}/${tile.y}`);
  }
  const deep = globe(5, 60, 30);
  const many = deep.coveringTiles({ tileSize: 512, minZoom: 0, maxZoom: 22, round: true });
  assert.ok(many.length > 0 && many.length < 200, `${many.length} tiles`);
  assert.ok(Math.max(...many.map((m) => m.z)) <= 6);
});

test("polar tiles get less detail than tiles at the center latitude", () => {
  const t = globe(4, 0, 0, 0, 60);
  const tiles = t.coveringTiles({ tileSize: 512, minZoom: 0, maxZoom: 22, round: true });
  const north = tiles.filter((x) => x.y === 0);
  const center = tiles.filter((x) => {
    const n = 2 ** x.z;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (x.y + 0.5)) / n))) * 180) / Math.PI;
    return Math.abs(lat - 60) < 5;
  });
  if (north.length > 0 && center.length > 0) {
    assert.ok(Math.max(...north.map((x) => x.z)) <= Math.min(...center.map((x) => x.z)));
  }
});

test("from zoom 12 the globe projection is the flat map", () => {
  const t = globe(12.5, 45, 20);
  const flat = globe(12.5, 45, 20);
  flat.setProjection("mercator");
  assert.equal(t.globeness, 0);
  assert.deepEqual([...t.pixelMatrix], [...flat.pixelMatrix]);
  const a = t.project(0.17, 0.35);
  const b = flat.project(0.17, 0.35);
  assert.equal(a.x, b.x);
  assert.equal(a.y, b.y);
});

test("the morph into the flat map is continuous at zoom 12", () => {
  const before = globe(11.9999, 30, 10);
  const after = globe(12, 30, 10);
  const [cx, cy] = after.centerWorld;
  for (const [dx, dy] of [
    [0.0002, 0.0001],
    [-0.0003, -0.0002],
  ] as const) {
    const a = before.project(cx + dx, cy + dy);
    const b = after.project(cx + dx, cy + dy);
    close(a.x, b.x, 0.5);
    close(a.y, b.y, 0.5);
  }
});

test("the whole globe has the area of its disc", () => {
  const t = globe(0, 0, 0, 0, 0);
  const area = t.tileArea(0, 0, 0, 0);
  const r = t.globeRadius;
  assert.ok(area > Math.PI * r * r * 0.85 && area < Math.PI * r * r * 1.5, `${area} vs ${Math.PI * r * r}`);
});

test("ground frame matches finite differences of project", () => {
  const t = globe(5, 30, 20);
  const [cx, cy] = t.centerWorld;
  const out = new Float64Array(6);
  const w = t.groundFrame(cx + 0.001, cy, 0, out);
  assert.ok(w > 0);
  const e = 1e-7;
  const a = t.project(cx + 0.001 + e, cy);
  const b = t.project(cx + 0.001 - e, cy);
  close(out[2]!, (a.x - b.x) / (2 * e), Math.abs(out[2]!) * 1e-3);
});
