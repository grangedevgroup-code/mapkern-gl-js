import assert from "node:assert/strict";
import { test } from "node:test";
import { LngLat, LngLatBounds, MercatorCoordinate, Point, wrap } from "../../src/compat/geo.ts";
import { addProtocol, resourceType, toBytes } from "../../src/compat/protocol.ts";
import { layerView, ShadowStyle } from "../../src/compat/style.ts";
import { importLayer, importSource } from "../../src/style/import.ts";
import { protocolFor } from "../../src/tiles/protocols.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

test("LngLat converts every MapLibre form and wraps like MapLibre", () => {
  assert.deepEqual(LngLat.convert([10, 20]).toArray(), [10, 20]);
  assert.deepEqual(LngLat.convert({ lng: 10, lat: 20 }).toArray(), [10, 20]);
  assert.deepEqual(LngLat.convert({ lon: 10, lat: 20 }).toArray(), [10, 20]);
  const ll = new LngLat(286.0251, 40.7736);
  assert.equal(LngLat.convert(ll), ll);
  close(ll.wrap().lng, -73.9749, 1e-9);
  assert.equal(new LngLat(-180, 0).wrap().lng, 180);
  assert.equal(wrap(540, -180, 180), 180);
  assert.equal(new LngLat(1, 2).toString(), "LngLat(1, 2)");
  assert.throws(() => new LngLat(0, 91));
  assert.throws(() => LngLat.convert("nope" as never));
});

test("LngLat.distanceTo uses the mean earth radius", () => {
  const paris = new LngLat(2.3522, 48.8566);
  const london = new LngLat(-0.1276, 51.5072);
  const d = paris.distanceTo(london);
  assert.ok(d > 343000 && d < 344500, `${d}`);
  assert.equal(paris.distanceTo(paris), 0);
});

test("LngLatBounds builds, extends and answers like MapLibre's", () => {
  const a = new LngLatBounds([-10, -5], [10, 5]);
  const b = new LngLatBounds([-10, -5, 10, 5]);
  const c = new LngLatBounds([
    [-10, -5],
    [10, 5],
  ]);
  for (const x of [a, b, c])
    assert.deepEqual(x.toArray(), [
      [-10, -5],
      [10, 5],
    ]);
  assert.equal(a._sw.lng, -10);
  assert.equal(a._ne.lat, 5);
  const empty = new LngLatBounds();
  assert.ok(empty.isEmpty());
  empty
    .extend([1, 2])
    .extend(new LngLat(-3, 4))
    .extend([
      [0, -1],
      [2, 0],
    ]);
  assert.deepEqual(empty.toArray(), [
    [-3, -1],
    [2, 4],
  ]);
  assert.deepEqual(a.getCenter().toArray(), [0, 0]);
  assert.deepEqual(a.getNorthWest().toArray(), [-10, 5]);
  assert.deepEqual(a.getSouthEast().toArray(), [10, -5]);
  assert.ok(a.contains([0, 0]));
  assert.ok(!a.contains([11, 0]));
  const across = new LngLatBounds([170, -10], [-170, 10]);
  assert.ok(across.contains([175, 0]));
  assert.ok(across.contains([-175, 0]));
  assert.ok(!across.contains([0, 0]));
  assert.ok(a.intersects([5, 0, 20, 20]));
  assert.ok(!a.intersects([11, 0, 20, 20]));
  assert.deepEqual(across.adjustAntiMeridian().toArray(), [
    [170, -10],
    [190, 10],
  ]);
  const around = LngLatBounds.fromLngLat([0, 0], 1000);
  close(around.getNorth(), (360 * 1000) / (2 * Math.PI * 6371008.8), 1e-12);
  assert.equal(LngLatBounds.convert(a), a);
});

test("Point does the point-geometry math", () => {
  const p = new Point(3, 4);
  assert.equal(p.mag(), 5);
  assert.deepEqual(p.add(new Point(1, 1)), new Point(4, 5));
  assert.deepEqual(p.sub(new Point(1, 1)), new Point(2, 3));
  assert.deepEqual(p.mult(2), new Point(6, 8));
  assert.deepEqual(p.perp(), new Point(-4, 3));
  const r = new Point(1, 0).rotate(Math.PI / 2);
  close(r.x, 0);
  close(r.y, 1);
  assert.deepEqual(p.matMult([0, 1, 1, 0]), new Point(4, 3));
  assert.equal(p.dist(new Point(0, 0)), 5);
  close(new Point(1, 0).angleWith(new Point(0, 1)), -Math.PI / 2);
  assert.deepEqual(Point.convert([1, 2]), new Point(1, 2));
  assert.deepEqual(Point.convert({ x: 1, y: 2 }), new Point(1, 2));
  const q = new Point(1, 2);
  assert.equal(q._add(new Point(1, 1)), q);
  assert.deepEqual(q, new Point(2, 3));
});

test("MercatorCoordinate matches MapLibre's units", () => {
  const c = MercatorCoordinate.fromLngLat([0, 0], 0);
  assert.deepEqual([c.x, c.y, c.z], [0.5, 0.5, 0]);
  const p = MercatorCoordinate.fromLngLat([-122.3, 47.6], 120);
  const back = p.toLngLat();
  close(back.lng, -122.3, 1e-9);
  close(back.lat, 47.6, 1e-9);
  close(p.toAltitude(), 120, 1e-6);
  close(MercatorCoordinate.fromLngLat([0, 0]).meterInMercatorCoordinateUnits(), 1 / (2 * Math.PI * 6371008.8), 1e-18);
});

test("MapLibre layers convert to Mapkern layers with the same importer setStyle uses", () => {
  const sources = { roads: { type: "vector", tiles: ["https://x/{z}/{x}/{y}"] } } as never;
  const { layer, skipped } = importLayer(
    {
      id: "r",
      type: "line",
      source: "roads",
      "source-layer": "transportation",
      filter: ["==", "class", "motorway"],
      layout: { visibility: "none", "line-cap": "round" },
      paint: { "line-color": "#f80", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 12, 4] },
    },
    sources,
    false,
  );
  assert.deepEqual(skipped, []);
  assert.equal(layer?.type, "line");
  assert.equal((layer as { sourceLayer?: string }).sourceLayer, "transportation");
  assert.equal(layer?.visible, false);
  assert.equal((layer as { paint: Record<string, unknown> }).paint.color, "#f80");
  assert.deepEqual((layer as { filter: unknown }).filter, ["==", ["get", "class"], "motorway"]);
  const dem = importSource("dem", { type: "raster-dem", url: "https://x/dem.json", encoding: "terrarium" });
  assert.equal(dem.source?.type, "dem");
  assert.equal((dem.source as { encoding?: string }).encoding, "terrarium");
  const missing = importLayer({ id: "m", type: "fill", source: "nowhere" }, sources, false);
  assert.equal(missing.layer, null);
  assert.ok(missing.skipped.length > 0);
});

test("the shadow style keeps what the app gave it, in order, data by reference", () => {
  const data = { type: "FeatureCollection", features: [] };
  const shadow = new ShadowStyle({
    version: 8,
    glyphs: "https://x/{fontstack}/{range}.pbf",
    sources: { g: { type: "geojson", data } },
    layers: [
      { id: "a", type: "background", paint: { "background-color": "#fff" } },
      { id: "b", type: "circle", source: "g" },
    ],
  });
  shadow.insert({ id: "c", type: "line", source: "g" }, "b");
  shadow.insert({ id: "custom", type: "custom", render() {} } as never);
  assert.ok(shadow.move("a", "c"));
  const out = shadow.serialize() as { layers: { id: string }[]; sources: { g: { data: unknown } } };
  assert.deepEqual(
    out.layers.map((l) => l.id),
    ["a", "c", "b"],
  );
  assert.equal(out.sources.g.data, data);
  const view = layerView(shadow.layer("b")!);
  assert.equal(view.visibility, "visible");
  assert.deepEqual((view.serialize as () => unknown)(), { id: "b", type: "circle", source: "g" });
  assert.equal(layerView(shadow.layer("custom")!).type, "custom");
});

test("protocol results become bytes whatever the handler returned", async () => {
  const buffer = new Uint8Array([1, 2, 3]).buffer;
  assert.equal(await toBytes(buffer), buffer);
  assert.deepEqual(new Uint8Array((await toBytes("hi")) as Uint8Array), new TextEncoder().encode("hi"));
  const json = (await toBytes({ tiles: ["a"] })) as { data: Uint8Array; contentType: string };
  assert.equal(json.contentType, "application/json");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(json.data)), { tiles: ["a"] });
  const blob = (await toBytes(new Blob([new Uint8Array([9])], { type: "image/png" }))) as {
    data: ArrayBuffer;
    contentType: string;
  };
  assert.equal(blob.contentType, "image/png");
  assert.deepEqual([...new Uint8Array(blob.data)], [9]);
  assert.equal(await toBytes(undefined), null);
});

test("MapLibre protocol handlers run in both the promise and the callback style", async () => {
  let seen: { url: string; type?: string; aborted: boolean } | null = null;
  addProtocol("compat-promise", async (params, controller) => {
    seen = { url: params.url, type: params.type, aborted: controller.signal.aborted };
    return { data: new Uint8Array([7, 7]).buffer };
  });
  addProtocol("compat-callback", (_params, callback) => {
    setTimeout(() => callback(null, new Uint8Array([5]).buffer), 1);
    return { cancel() {} };
  });
  const signal = new AbortController().signal;
  const a = await protocolFor("compat-promise://x")!({ url: "compat-promise://x", kind: "tile" }, signal);
  assert.deepEqual([...new Uint8Array(a as ArrayBuffer)], [7, 7]);
  assert.deepEqual(seen, { url: "compat-promise://x", type: "arrayBuffer", aborted: false });
  const b = await protocolFor("compat-callback://y")!({ url: "compat-callback://y", kind: "tile" }, signal);
  assert.deepEqual([...new Uint8Array(b as ArrayBuffer)], [5]);
  let cancelled = false;
  addProtocol("compat-slow", (_params, controller) => {
    controller.signal.addEventListener("abort", () => {
      cancelled = true;
    });
    return new Promise(() => {});
  });
  const abort = new AbortController();
  void protocolFor("compat-slow://z")!({ url: "compat-slow://z", kind: "tile" }, abort.signal).catch(() => {});
  abort.abort();
  assert.ok(cancelled);
  assert.equal(resourceType("sprite", "https://x/sprite@2x.json"), "SpriteJSON");
  assert.equal(resourceType("sprite", "https://x/sprite@2x.png"), "SpriteImage");
  assert.equal(resourceType("source", "https://x/tiles.json"), "Source");
});
