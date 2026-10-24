import assert from "node:assert/strict";
import { test } from "node:test";
import type { VectorFeature } from "../../src/formats/mvt.ts";
import { ringArea } from "../../src/formats/mvt.ts";
import { clipRing, rankVertices, signedArea, simplify } from "../../src/geo/clip.ts";
import { latFromMercatorY, lngFromMercatorX, mercatorX, mercatorY } from "../../src/geo/mercator.ts";
import type { GeoJSONOptions } from "../../src/worker/geojson.ts";
import { GeoJSONIndex } from "../../src/worker/geojson.ts";
import { buildGeoJSONTile, loadGeoJSON } from "../../src/worker/geojson-task.ts";
import type { LayerProgram } from "../../src/worker/vector-task.ts";
import { buildBuckets } from "../../src/worker/vector-task.ts";

const EXTENT = 4096;
const BUFFER = 64;
const PAD = (BUFFER / 512) * EXTENT;

function index(data: unknown, options: Partial<GeoJSONOptions> = {}): GeoJSONIndex {
  return new GeoJSONIndex(data, { maxZoom: 14, tolerance: 0.375, buffer: BUFFER, extent: EXTENT, ...options });
}

function features(idx: GeoJSONIndex, z: number, x: number, y: number): VectorFeature[] {
  const layer = idx.tile(z, x, y);
  const out: VectorFeature[] = [];
  for (let i = 0; i < layer.length; i++) out.push(layer.feature(i));
  return out;
}

function at(z: number, x: number, y: number, fx: number, fy: number): [number, number] {
  const n = 2 ** z;
  return [lngFromMercatorX((x + fx) / n), latFromMercatorY((y + fy) / n)];
}

function square(west: number, south: number, size: number): number[][] {
  return [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ];
}

function feature(geometry: unknown, properties: Record<string, unknown> = {}, id?: unknown) {
  return { type: "Feature", id, properties, geometry };
}

function collection(...items: unknown[]) {
  return { type: "FeatureCollection", features: items };
}

function vertexCount(f: VectorFeature): number {
  return f.geometry().reduce((sum, part) => sum + part.length / 2, 0);
}

test("reads every geometry type and skips invalid input", () => {
  const data = collection(
    feature(
      { type: "Point", coordinates: [10, 20] },
      { name: "a", n: 2, ok: true, nested: { a: 1 }, nothing: null },
      7,
    ),
    feature({
      type: "MultiPoint",
      coordinates: [
        [1, 1],
        [2, 2],
      ],
    }),
    feature({
      type: "LineString",
      coordinates: [
        [0, 0],
        [5, 5],
      ],
    }),
    feature({
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    }),
    feature({ type: "Polygon", coordinates: [square(0, 0, 10)] }),
    feature({ type: "MultiPolygon", coordinates: [[square(20, 0, 5)], [square(40, 0, 5)]] }),
    feature({
      type: "GeometryCollection",
      geometries: [
        { type: "Point", coordinates: [3, 3] },
        {
          type: "LineString",
          coordinates: [
            [3, 3],
            [4, 4],
          ],
        },
      ],
    }),
    feature(null),
    feature({ type: "Point", coordinates: [Number.NaN, 0] }),
    feature({ type: "LineString", coordinates: [[0, 0]] }),
    feature({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    }),
    feature({ type: "Bogus", coordinates: [] }),
    null,
    42,
    "text",
  );
  const idx = index(data);
  assert.equal(idx.summary.features, 7);
  const found = features(idx, 0, 0, 0);
  const types = found.map((f) => f.type).sort();
  assert.deepEqual(types, [1, 1, 1, 2, 2, 2, 3, 3]);
  const point = found.find((f) => f.id === 7)!;
  assert.deepEqual(point.properties(), { name: "a", n: 2, ok: true, nested: '{"a":1}' });
  assert.equal(point.property("nothing"), undefined);
  const bounds = idx.summary.bounds!;
  assert.ok(Math.abs(bounds[0] - 0) < 1e-9 && Math.abs(bounds[2] - 45) < 1e-9);
  assert.ok(Math.abs(bounds[1] - 0) < 1e-9 && Math.abs(bounds[3] - 20) < 1e-9);
});

test("bare geometries and empty input are accepted", () => {
  assert.equal(index({ type: "Point", coordinates: [1, 2] }).summary.features, 1);
  for (const empty of [null, {}, collection(), { type: "FeatureCollection" }, []]) {
    const idx = index(empty);
    assert.equal(idx.summary.features, 0);
    assert.equal(idx.summary.bounds, null);
    assert.equal(idx.tile(0, 0, 0).length, 0);
  }
});

test("ids come from numbers, digit strings or promoteId", () => {
  const data = collection(
    feature({ type: "Point", coordinates: [0, 0] }, {}, 5),
    feature({ type: "Point", coordinates: [1, 0] }, {}, "123"),
    feature({ type: "Point", coordinates: [2, 0] }, {}, "abc"),
    feature({ type: "Point", coordinates: [3, 0] }, { osm: 99 }, 1),
  );
  const plain = features(index(data), 0, 0, 0).map((f) => f.id);
  assert.deepEqual(plain, [5, 123, undefined, 1]);
  const promoted = features(index(data, { promoteId: "osm" }), 0, 0, 0).map((f) => f.id);
  assert.deepEqual(promoted, [5, 123, undefined, 99]);
});

test("rings are wound outer positive and holes negative whatever the input winding", () => {
  const outer = square(-20, -20, 40);
  const hole = square(-5, -5, 10);
  for (const [o, h] of [
    [outer, hole],
    [[...outer].reverse(), [...hole].reverse()],
    [[...outer].reverse(), hole],
  ] as const) {
    const [f] = features(index(feature({ type: "Polygon", coordinates: [o, h] })), 0, 0, 0);
    const rings = f!.geometry();
    assert.equal(rings.length, 2);
    assert.ok(ringArea(rings[0]!) > 0);
    assert.ok(ringArea(rings[1]!) < 0);
  }
});

test("a tile inside a polygon is one square over the buffered tile", () => {
  const idx = index(feature({ type: "Polygon", coordinates: [square(-30, -30, 60)] }));
  const [f] = features(idx, 8, 128, 128);
  assert.ok(f);
  const rings = f.geometry();
  assert.equal(rings.length, 1);
  const ring = rings[0]!;
  const xs = [...ring.filter((_, i) => i % 2 === 0)];
  const ys = [...ring.filter((_, i) => i % 2 === 1)];
  assert.equal(Math.min(...xs), -PAD);
  assert.equal(Math.max(...xs), EXTENT + PAD);
  assert.equal(Math.min(...ys), -PAD);
  assert.equal(Math.max(...ys), EXTENT + PAD);
  assert.equal(ringArea(ring), (EXTENT + 2 * PAD) ** 2);
});

test("a tile inside a hole draws nothing", () => {
  const idx = index(feature({ type: "Polygon", coordinates: [square(-40, -40, 80), square(-20, -20, 40)] }));
  assert.equal(features(idx, 8, 128, 128).length, 0);
  assert.equal(features(idx, 1, 0, 0).length, 1);
});

test("points in the tile buffer are kept so circles join across tiles", () => {
  const z = 6,
    x = 20,
    y = 25;
  const idx = index(
    feature({
      type: "MultiPoint",
      coordinates: [at(z, x, y, 0.5, 0.5), at(z, x, y, 1.05, 0.5), at(z, x, y, 1.5, 0.5), at(z, x, y, 0.5, -0.4)],
    }),
  );
  const [f] = features(idx, z, x, y);
  const points = f!.geometry()[0]!;
  assert.equal(points.length, 4);
  assert.deepEqual([points[0], points[1]], [2048, 2048]);
  assert.ok(points[2]! > EXTENT && points[2]! < EXTENT + PAD);
});

test("lines are cut at the buffered tile edge", () => {
  const z = 5,
    x = 9,
    y = 11;
  const idx = index(feature({ type: "LineString", coordinates: [at(z, x, y, -2, 0.5), at(z, x, y, 3, 0.5)] }));
  const [f] = features(idx, z, x, y);
  const parts = f!.geometry();
  assert.equal(parts.length, 1);
  const line = parts[0]!;
  assert.equal(line[0], -PAD);
  assert.equal(line[line.length - 2], EXTENT + PAD);
  assert.ok(Math.abs(line[1]! - 2048) <= 1);
});

test("features across the antimeridian appear on both sides", () => {
  const idx = index(
    feature({
      type: "LineString",
      coordinates: [
        [170, 10],
        [190, 10],
      ],
    }),
  );
  assert.equal(features(idx, 1, 1, 0).length, 1);
  assert.equal(features(idx, 1, 0, 0).length, 1);
  const [west] = features(idx, 1, 0, 0);
  const line = west!.geometry()[0]!;
  assert.equal(line[0], Math.round((mercatorX(170) - 1) * 2 * EXTENT));
  assert.equal(line[line.length - 2], Math.round((mercatorX(190) - 1) * 2 * EXTENT));
});

test("simplification thins lines when zoomed out and keeps detail at max zoom", () => {
  const coordinates: number[][] = [];
  for (let i = 0; i <= 2000; i++) coordinates.push([i / 2000, 0.01 * Math.sin(i / 7)]);
  const idx = index(feature({ type: "LineString", coordinates }));
  const zoomedOut = features(idx, 4, 8, 7).concat(features(idx, 4, 8, 8));
  const z = 14;
  const n = 2 ** z;
  const tx = Math.floor(mercatorX(0.5) * n);
  const ty = Math.floor(mercatorY(0) * n);
  const detailed = features(idx, z, tx, ty).concat(features(idx, z, tx, ty - 1));
  const coarse = zoomedOut.reduce((s, f) => s + vertexCount(f), 0);
  const fine = detailed.reduce((s, f) => s + vertexCount(f), 0);
  assert.ok(coarse > 0 && coarse < 200, `zoomed out keeps ${coarse} vertices`);
  assert.ok(fine > 20, `max zoom keeps ${fine} vertices`);
});

test("tiny polygons are dropped when zoomed out and kept when zoomed in", () => {
  const idx = index(feature({ type: "Polygon", coordinates: [square(10, 10, 0.0005)] }));
  const z = 14;
  const n = 2 ** z;
  const tx = Math.floor(mercatorX(10.00025) * n);
  const ty = Math.floor(mercatorY(10.00025) * n);
  assert.equal(features(idx, 3, 4, 3).length, 0);
  assert.equal(features(idx, z, tx, ty).length, 1);
});

test("ranked simplification matches Douglas-Peucker at every tolerance", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const flat: number[] = [];
  const ranked: number[] = [];
  let px = 0,
    py = 0;
  for (let i = 0; i < 600; i++) {
    px += random();
    py += random() - 0.5;
    flat.push(px, py);
    ranked.push(px, py, 0);
  }
  const points = Float64Array.from(ranked);
  rankVertices(points);
  for (const tolerance of [0.05, 0.2, 1, 3, 10]) {
    const expected = Array.from(simplify(flat, tolerance, false));
    const kept: number[] = [];
    for (let i = 0; i < points.length; i += 3) {
      if (points[i + 2]! > tolerance * tolerance) kept.push(points[i]!, points[i + 1]!);
    }
    assert.deepEqual(kept, expected, `tolerance ${tolerance}`);
  }
});

test("large data is split level by level and still clips exactly", () => {
  const ring: number[][] = [];
  const steps = 40000;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([20 * Math.cos(a), 20 * Math.sin(a)]);
  }
  ring[steps] = ring[0]!;
  const z = 9;
  const idx = index(feature({ type: "Polygon", coordinates: [ring] }), { maxZoom: z });
  const n = 2 ** z;
  const world = Float64Array.from(ring.flatMap(([lng, lat]) => [mercatorX(lng!), mercatorY(lat!)]));
  const ty = Math.floor(mercatorY(0) * n);
  for (const tx of [Math.floor(mercatorX(20) * n) - 1, Math.floor(mercatorX(20) * n), Math.floor(mercatorX(0) * n)]) {
    const pad = BUFFER / 512 / n;
    const rect = { x0: tx / n - pad, y0: ty / n - pad, x1: (tx + 1) / n + pad, y1: (ty + 1) / n + pad };
    const clipped = clipRing(world, rect);
    const expected = clipped ? Math.abs(signedArea(clipped)) * (n * EXTENT) ** 2 : 0;
    const got = features(idx, z, tx, ty).reduce((s, f) => s + f.geometry().reduce((a, r) => a + ringArea(r), 0), 0);
    assert.ok(Math.abs(got - expected) <= Math.max(1, expected * 1e-3), `tile ${tx}: ${got} vs ${expected}`);
  }
});

test("GeoJSON tiles feed the same bucket builder as vector tiles", () => {
  const program = (id: string, type: LayerProgram["type"], layout: Record<string, unknown> = {}): LayerProgram => ({
    id,
    type,
    sourceLayer: null,
    filter: null,
    minZoom: 0,
    maxZoom: 24,
    keys: [],
    layout,
    sortKey: null,
  });
  const idx = index(
    collection(
      feature({ type: "Polygon", coordinates: [square(-10, -10, 20)] }),
      feature({
        type: "LineString",
        coordinates: [
          [-10, 0],
          [10, 0],
        ],
      }),
      feature({ type: "Point", coordinates: [1, 1] }),
    ),
  );
  const layer = idx.tile(2, 2, 1);
  const { result } = buildBuckets(
    new Map([[layer.name, layer]]),
    2,
    [
      program("fill", "fill"),
      program("line", "line", { cap: "round", join: "round", miterLimit: 2 }),
      program("circle", "circle"),
    ],
    false,
  );
  assert.deepEqual(result.buckets.map((b) => b.layerId).sort(), ["circle", "fill", "line"]);
  for (const bucket of result.buckets) assert.ok(bucket.main && bucket.main.indexCount > 0);
});

test("worker tasks load JSON bytes, build tiles and report unknown sources", async () => {
  const text = JSON.stringify(collection(feature({ type: "Point", coordinates: [0, 0] })));
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
  const options: GeoJSONOptions = { maxZoom: 14, tolerance: 0.375, buffer: BUFFER, extent: EXTENT };
  const loaded = await loadGeoJSON({ source: "test#1", bytes, options });
  assert.equal(loaded.result.features, 1);
  const tile = await buildGeoJSONTile({ source: "test#1", z: 0, x: 0, y: 0, layers: [], overzoom: false });
  assert.equal(tile.result.missing, false);
  const missing = await buildGeoJSONTile({ source: "nope", z: 0, x: 0, y: 0, layers: [], overzoom: false });
  assert.equal(missing.result.missing, true);
  const broken = new TextEncoder().encode("{ not json").buffer as ArrayBuffer;
  await assert.rejects(loadGeoJSON({ source: "test#2", bytes: broken, options }), /not valid JSON/);
});
