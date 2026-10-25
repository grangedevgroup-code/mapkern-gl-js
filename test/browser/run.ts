import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "../../scripts/build.ts";
import { startServer } from "../../scripts/server.ts";
import { latFromMercatorY, mercatorX, mercatorY } from "../../src/geo/mercator.ts";
import type { Page } from "./cdp.ts";
import { Browser } from "./cdp.ts";
import { demHeight, fixtureRoute, HILL, square, writeMbtilesFixture } from "./fixtures.ts";
import { BORDER, zoomColor } from "./png.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = join(root, "test", "browser", "output");

interface Context {
  page: Page;
  base: string;
  shot(name: string): Promise<void>;
}

interface Spec {
  name: string;
  run(ctx: Context): Promise<void>;
}

type RGBA = [number, number, number, number];

function fail(message: string): never {
  throw new Error(message);
}

function near(actual: RGBA, expected: readonly number[], tolerance = 6): boolean {
  return expected.every((v, i) => Math.abs((actual[i] ?? 0) - v) <= tolerance);
}

function isZoomColor(actual: RGBA, z: number): boolean {
  const c = zoomColor(z);
  return (
    near(actual, c) ||
    near(
      actual,
      c.map((v) => Math.round(v * 0.9)),
    )
  );
}

function rasterStyle(base: string, path: string): string {
  return JSON.stringify({
    version: 1,
    sources: { fx: { type: "raster", tiles: [`${base}${path}/{z}/{x}/{y}.png`], tileSize: 256 } },
    layers: [
      { id: "bg", type: "background", paint: { color: "#ffffff" } },
      { id: "r", type: "raster", source: "fx", paint: { fadeDuration: 0 } },
    ],
  });
}

function geojsonStyle(data: unknown): string {
  return JSON.stringify({
    version: 1,
    sources: { g: { type: "geojson", data } },
    layers: [
      { id: "bg", type: "background", paint: { color: "#ffffff" } },
      {
        id: "fill",
        type: "fill",
        source: "g",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { color: ["coalesce", ["get", "color"], "#ff0000"] },
      },
      {
        id: "line",
        type: "line",
        source: "g",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { color: "#0000ff", width: 6 },
      },
      {
        id: "dots",
        type: "circle",
        source: "g",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { color: "#00ff00", radius: 10 },
      },
    ],
  });
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];
const WHITE = [255, 255, 255, 255];

async function framesDuring(page: Page, action: string, x: number, y: number, ms: number): Promise<RGBA[]> {
  return page.evaluate<RGBA[]>(`(async () => {
    const samples = [];
    const start = performance.now();
    ${action};
    await new Promise((resolve) => {
      const tick = () => {
        samples.push(window.pixel(${x}, ${y}));
        if (performance.now() - start > ${ms}) return resolve(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return samples;
  })()`);
}

async function createMap(page: Page, style: string, options: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(`(async () => {
    window.errors = [];
    window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [0, 0], zoom: 3, style: ${style}, ...${JSON.stringify(options)} });
    window.map.on("error", (e) => window.errors.push({ code: e.error.code, message: e.error.message }));
    await window.map.once("idle");
  })()`);
}

async function pixel(page: Page, x: number, y: number): Promise<RGBA> {
  return page.evaluate<RGBA>(`window.pixel(${x}, ${y})`);
}

function demStyle(base: string): string {
  return JSON.stringify({
    version: 1,
    sources: { dem: { type: "dem", tiles: [`${base}/fixture/dem/{z}/{x}/{y}.png`], tileSize: 256, maxZoom: 12 } },
    layers: [
      { id: "bg", type: "background", paint: { color: "#808080" } },
      { id: "hs", type: "hillshade", source: "dem", paint: { exaggeration: 1 } },
    ],
  });
}

const DOT: [number, number] = [3.3, 2.2];

function terrainStyle(base: string): string {
  return JSON.stringify({
    version: 1,
    sources: {
      dem: { type: "dem", tiles: [`${base}/fixture/dem/{z}/{x}/{y}.png`], tileSize: 256, maxZoom: 12 },
      g: {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: DOT } }],
        },
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { color: "#ffffff" } },
      { id: "hs", type: "hillshade", source: "dem", paint: { exaggeration: 0.3 } },
      { id: "dot", type: "circle", source: "g", paint: { radius: 5, color: "#ff0000" } },
    ],
    terrain: { source: "dem" },
  });
}

const RED_CENTROID = `(() => {
  const gl = window.map.getCanvas().getContext("webgl2");
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i] > 200 && px[i + 1] < 90 && px[i + 2] < 90) { sx += x; sy += y; n++; }
    }
  }
  return n ? [sx / n + 0.5, h - sy / n - 0.5, n] : null;
})()`;

async function brightness(page: Page, x: number, y: number): Promise<number> {
  const c = await pixel(page, x, y);
  return (c[0] + c[1] + c[2]) / 3;
}

async function idle(page: Page): Promise<void> {
  await page.evaluate(
    `new Promise((resolve) => { if (window.map.loaded() && !window.map.isMoving()) { window.map.triggerRepaint(); } window.map.once("idle", () => resolve(0)); window.map.triggerRepaint(); })`,
  );
}

const specs: Spec[] = [
  {
    name: "raster tiles render at the right zoom and position",
    async run({ page, base, shot }) {
      await createMap(page, rasterStyle(base, "/fixture/raster"));
      await shot("raster-z3");
      const inside = await pixel(page, 464, 364);
      if (!isZoomColor(inside, 4)) fail(`expected z4 colour inside tile, got ${inside}`);
      const seam = await pixel(page, 400, 364);
      if (!near(seam, BORDER, 12)) fail(`expected the tile border on the x=0 meridian, got ${seam}`);
      const right = await pixel(page, 400 + 256, 364);
      if (!near(right, BORDER, 12)) fail(`expected the next tile border 256 px to the right, got ${right}`);
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`map reported errors: ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "parent tiles cover the view while children are slow",
    async run({ page, base, shot }) {
      await createMap(page, rasterStyle(base, "/fixture/slow/2500/5"));
      await page.evaluate("void window.map.jumpTo({ zoom: 4 })");
      await new Promise((r) => setTimeout(r, 400));
      await shot("fallback-pending");
      for (const [x, y] of [
        [100, 100],
        [700, 100],
        [400, 300],
        [100, 500],
        [700, 500],
      ] as const) {
        const c = await pixel(page, x, y);
        if (near(c, [255, 255, 255], 3)) fail(`blank pixel at ${x},${y} while children load`);
        if (!isZoomColor(c, 4) && !near(c, BORDER, 12)) fail(`expected parent (z4) colour at ${x},${y}, got ${c}`);
      }
      const blank = await page.evaluate<number>("window.map.getDiagnostics().blankRatio");
      if (blank > 0) fail(`blank ratio ${blank} while a parent is available`);
      await idle(page);
      await shot("fallback-done");
      const done = await pixel(page, 464, 364);
      if (!isZoomColor(done, 5)) fail(`expected z5 colour after load, got ${done}`);
    },
  },
  {
    name: "failed children keep the parent and are not retried on 403",
    async run({ page, base, shot }) {
      await fetch(`${base}/fixture/reset`);
      await createMap(page, rasterStyle(base, "/fixture/fail/403/5"));
      await page.evaluate("void window.map.jumpTo({ zoom: 4 })");
      await idle(page);
      await shot("failed-children");
      const c = await pixel(page, 464, 364);
      if (!isZoomColor(c, 4)) fail(`expected parent colour over failed children, got ${c}`);
      const errors = await page.evaluate<{ code: string }[]>("window.errors");
      if (!errors.some((e) => e.code === "auth")) fail(`expected an auth error event, got ${JSON.stringify(errors)}`);
      const hits = (await (await fetch(`${base}/fixture/stats`)).json()) as Record<string, number>;
      const failing = Object.entries(hits).filter(([k]) => k.startsWith("fail/403/5:5/"));
      if (failing.length === 0) fail("no z5 requests were made");
      const retried = failing.filter(([, n]) => n > 1);
      if (retried.length > 0) fail(`403 tiles were retried: ${JSON.stringify(retried)}`);
    },
  },
  {
    name: "an idle map stops rendering",
    async run({ page, base }) {
      await createMap(page, rasterStyle(base, "/fixture/raster"));
      const before = await page.evaluate<number>("window.map.getDiagnostics().frames");
      await new Promise((r) => setTimeout(r, 700));
      const after = await page.evaluate<number>("window.map.getDiagnostics().frames");
      if (after !== before) fail(`map drew ${after - before} frames while idle`);
    },
  },
  {
    name: "drag pans and the wheel zooms around the cursor",
    async run({ page, base, shot }) {
      await createMap(page, rasterStyle(base, "/fixture/raster"));
      await page.mouse("mouseMoved", 400, 300);
      await page.mouse("mousePressed", 400, 300, { buttons: 1 });
      for (let i = 1; i <= 10; i++) {
        await page.mouse("mouseMoved", 400 + i * 10, 300, { buttons: 1 });
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 250));
      await page.mouse("mouseReleased", 500, 300, { buttons: 0 });
      await idle(page);
      const [lng, lat] = await page.evaluate<[number, number]>("window.map.getCenter()");
      const expected = (-100 / 4096) * 360;
      if (Math.abs(lng - expected) > 0.3 || Math.abs(lat) > 0.3)
        fail(`expected centre near ${expected},0 after drag, got ${lng},${lat}`);
      const anchor = await page.evaluate<[number, number]>("window.map.unproject([600, 200])");
      await page.mouse("mouseWheel", 600, 200, { deltaX: 0, deltaY: -100 });
      await idle(page);
      await shot("after-wheel");
      const zoom = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(zoom - 3.5) > 0.05) fail(`expected zoom 3.5 after one wheel notch, got ${zoom}`);
      const moved = await page.evaluate<{ x: number; y: number }>(`window.map.project(${JSON.stringify(anchor)})`);
      if (Math.hypot(moved.x - 600, moved.y - 200) > 1)
        fail(`wheel zoom moved the point under the cursor to ${moved.x},${moved.y}`);
    },
  },
  {
    name: "pitch and bearing keep the view covered",
    async run({ page, base, shot }) {
      await createMap(page, rasterStyle(base, "/fixture/raster"), { zoom: 4 });
      await page.evaluate("void window.map.jumpTo({ pitch: 60, bearing: 30 })");
      await idle(page);
      await shot("pitched");
      const d = await page.evaluate<{ blankRatio: number }>("window.map.getDiagnostics()");
      if (d.blankRatio > 0) fail(`blank ratio ${d.blankRatio} after load at pitch 60`);
      for (const [x, y] of [
        [20, 20],
        [780, 20],
        [400, 300],
        [20, 580],
        [780, 580],
      ] as const) {
        const c = await pixel(page, x, y);
        if (near(c, [255, 255, 255], 3)) fail(`blank pixel at ${x},${y} at pitch 60`);
      }
    },
  },
  {
    name: "GeoJSON polygons, holes, lines and circles render in place",
    async run({ page, shot }) {
      const outer = [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
        [-10, -10],
      ];
      const hole = [
        [-3, -3],
        [3, -3],
        [3, 3],
        [-3, 3],
        [-3, -3],
      ];
      const data = {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, hole] } },
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [-15, -12],
                [15, -12],
              ],
            },
          },
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [14, 0] } },
        ],
      };
      await createMap(page, geojsonStyle(data), { zoom: 4 });
      await shot("geojson");
      const checks: [number, number, readonly number[], string][] = [
        [500, 300, RED, "polygon fill"],
        [400, 300, WHITE, "inside the hole"],
        [300, 200, RED, "polygon fill north-west"],
        [400, 575, BLUE, "line"],
        [719, 300, GREEN, "circle centre"],
        [740, 300, WHITE, "outside the circle"],
        [100, 300, WHITE, "outside everything"],
      ];
      for (const [x, y, colour, what] of checks) {
        const c = await pixel(page, x, y);
        if (!near(c, colour, 8)) fail(`${what} at ${x},${y}: expected ${colour}, got ${c}`);
      }
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`map reported errors: ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "GeoJSON loads from a URL and setData swaps it without a blank frame",
    async run({ page, base, shot }) {
      await createMap(page, geojsonStyle(`${base}/fixture/geojson/square.json`), { zoom: 4 });
      const first = await pixel(page, 500, 300);
      if (!near(first, BLUE, 8)) fail(`expected the URL data (blue) at 500,300, got ${first}`);
      const update = JSON.stringify(square(10, "#ff0000"));
      const samples = await framesDuring(page, `window.map.getSource("g").setData(${update})`, 500, 300, 1200);
      await idle(page);
      await shot("after-set-data");
      const blank = samples.filter((c) => near(c, WHITE, 8));
      if (blank.length > 0) fail(`${blank.length} of ${samples.length} frames were blank during setData`);
      const last = await pixel(page, 500, 300);
      if (!near(last, RED, 8)) fail(`expected the new data (red) after setData, got ${last}`);
      const smaller = JSON.stringify(square(4, "#ff0000"));
      await page.evaluate(`void window.map.getSource("g").setData(${smaller})`);
      await idle(page);
      const outside = await pixel(page, 500, 300);
      if (!near(outside, WHITE, 8)) fail(`expected the smaller square to leave 500,300 blank, got ${outside}`);
      const count = await page.evaluate<number>("window.map.getSource('g').featureCount");
      if (count !== 1) fail(`expected one feature after setData, got ${count}`);
    },
  },
  {
    name: "filter edits keep vector features on screen while tiles rebuild",
    async run({ page }) {
      await createMap(page, geojsonStyle(square(10, "#ff0000")), { zoom: 4 });
      const samples = await framesDuring(
        page,
        `window.map.setFilter("fill", ["all", ["==", ["geometry-type"], "Polygon"], ["has", "color"]])`,
        500,
        300,
        800,
      );
      await idle(page);
      const blank = samples.filter((c) => near(c, WHITE, 8));
      if (blank.length > 0) fail(`${blank.length} of ${samples.length} frames were blank after setFilter`);
      const c = await pixel(page, 500, 300);
      if (!near(c, RED, 8)) fail(`expected the fill after setFilter, got ${c}`);
    },
  },
  {
    name: "a missing GeoJSON URL reports a source error",
    async run({ page, base }) {
      const style = geojsonStyle(`${base}/fixture/geojson/none.json`);
      await page.evaluate(`(async () => {
        window.errors = [];
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, center: [0, 0], zoom: 3, style: ${style} });
        window.map.on("error", (e) => window.errors.push({ code: e.error.code, message: e.error.message }));
        await new Promise((r) => setTimeout(r, 500));
      })()`);
      const errors = await page.evaluate<{ code: string; message: string }[]>("window.errors");
      if (!errors.some((e) => e.code === "source-error" && e.message.includes("none.json")))
        fail(`expected a source-error naming the URL, got ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "MBTiles work over HTTP and as a file the user picks",
    async run({ page, base, shot }) {
      const style = (url: string) =>
        JSON.stringify({
          version: 1,
          sources: { fx: { type: "raster", url, tileSize: 256 } },
          layers: [
            { id: "bg", type: "background", paint: { color: "#ffffff" } },
            { id: "r", type: "raster", source: "fx", paint: { fadeDuration: 0 } },
          ],
        });
      await createMap(page, style(`${base}/test/browser/output/fixture.mbtiles`));
      await shot("mbtiles-http");
      const remote = await pixel(page, 464, 364);
      if (!isZoomColor(remote, 4)) fail(`expected z4 colour from the MBTiles file over HTTP, got ${remote}`);
      const url = await page.evaluate<string>(`(async () => {
        const bytes = await (await fetch("${base}/test/browser/output/fixture.mbtiles")).arrayBuffer();
        return maplet.openTileFile(new File([bytes], "picked.mbtiles"));
      })()`);
      if (!url.startsWith("mbtiles://")) fail(`openTileFile returned ${url}`);
      await page.evaluate(`void window.map.setStyle(${style(url)})`);
      await idle(page);
      const local = await pixel(page, 464, 364);
      if (!isZoomColor(local, 4)) fail(`expected z4 colour from the picked file, got ${local}`);
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`map reported errors: ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "KML from a URL and CSV from a file both turn into map features",
    async run({ page, base, shot }) {
      const style = JSON.stringify({
        version: 1,
        sources: { g: { type: "geojson", data: `${base}/fixture/formats/places.kml` } },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "dots", type: "circle", source: "g", paint: { color: "#00ff00", radius: 12 } },
        ],
      });
      await createMap(page, style, { zoom: 4 });
      const west = 400 - (10 / 360) * 8192;
      const kml = await pixel(page, west, 300);
      if (!near(kml, GREEN, 8)) fail(`expected the KML point at ${west},300, got ${kml}`);
      await page.evaluate(
        `void window.map.getSource("g").setData(new File(["name;lat;lon\\nEast;0;10\\n"], "east.csv", { type: "text/csv" }))`,
      );
      await idle(page);
      await shot("csv");
      const east = 400 + (10 / 360) * 8192;
      const csv = await pixel(page, east, 300);
      if (!near(csv, GREEN, 8)) fail(`expected the CSV point at ${east},300, got ${csv}`);
      const gone = await pixel(page, west, 300);
      if (!near(gone, WHITE, 8)) fail(`expected the KML point to be replaced, got ${gone}`);
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`map reported errors: ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "extruded buildings show a lit roof above a shaded wall",
    async run({ page, shot }) {
      const block = square(0.001, "#3366cc");
      const style = JSON.stringify({
        version: 1,
        sources: { g: { type: "geojson", data: block } },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "box", type: "extrusion", source: "g", paint: { color: ["get", "color"], height: 300 } },
        ],
      });
      await createMap(page, style, { zoom: 16, pitch: 60 });
      await shot("extrusion");
      const column: RGBA[] = [];
      for (let y = 0; y < 600; y += 4) column.push(await pixel(page, 400, y));
      const roof = column.findIndex((c) => near(c, [51, 102, 204, 255], 10));
      const wall = column.findIndex((c, i) => i > roof && c[2]! > 90 && c[2]! < 170 && c[0]! < 45);
      if (roof < 0) fail("no roof pixels in the center column");
      if (wall < 0) fail("no shaded wall pixels below the roof");
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`map reported errors: ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "queryRenderedFeatures finds what is drawn under the pointer",
    async run({ page }) {
      const data = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 1,
            properties: { name: "square" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-10, -10],
                  [10, -10],
                  [10, 10],
                  [-10, 10],
                  [-10, -10],
                ],
              ],
            },
          },
          {
            type: "Feature",
            id: 2,
            properties: { name: "road" },
            geometry: {
              type: "LineString",
              coordinates: [
                [-15, -12],
                [15, -12],
              ],
            },
          },
          { type: "Feature", id: 3, properties: { name: "dot" }, geometry: { type: "Point", coordinates: [14, 0] } },
        ],
      };
      const style = JSON.stringify({
        version: 1,
        sources: { g: { type: "geojson", data } },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "fill",
            type: "fill",
            source: "g",
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { color: "#ff0000" },
          },
          {
            id: "line",
            type: "line",
            source: "g",
            filter: ["==", ["geometry-type"], "LineString"],
            paint: { color: "#0000ff", width: 6 },
          },
          {
            id: "dots",
            type: "circle",
            source: "g",
            filter: ["==", ["geometry-type"], "Point"],
            paint: { radius: 10 },
          },
          {
            id: "names",
            type: "symbol",
            source: "g",
            filter: ["==", ["geometry-type"], "Point"],
            layout: { text: ["get", "name"] },
          },
        ],
      });
      await createMap(page, style, { zoom: 4 });
      const query = (args: string) =>
        page.evaluate<{ layer: string; name: unknown; geometry: string | undefined; id: unknown }[]>(
          `window.map.queryRenderedFeatures(${args}).then((fs) => fs.map((f) => ({ layer: f.layer, name: f.properties.name, geometry: f.geometry?.type, id: f.id })))`,
        );
      const fill = await query("[500, 300]");
      if (
        fill.length !== 1 ||
        fill[0]!.layer !== "fill" ||
        fill[0]!.name !== "square" ||
        fill[0]!.geometry !== "Polygon" ||
        fill[0]!.id !== 1
      )
        fail(`expected the square under 500,300, got ${JSON.stringify(fill)}`);
      const line = await query("[400, 575]");
      if (line.length !== 1 || line[0]!.name !== "road" || line[0]!.geometry !== "LineString")
        fail(`expected the road under 400,575, got ${JSON.stringify(line)}`);
      const dot = await query("[719, 300]");
      const layers = dot.map((f) => f.layer);
      if (layers[0] !== "names" || layers[1] !== "dots" || dot.some((f) => f.name !== "dot"))
        fail(`expected the label then the circle under 719,300, got ${JSON.stringify(dot)}`);
      const empty = await query("[100, 300]");
      if (empty.length !== 0) fail(`expected nothing under 100,300, got ${JSON.stringify(empty)}`);
      const only = await query('[719, 300], { layers: ["fill"] }');
      if (only.length !== 0) fail(`expected no fill under the dot, got ${JSON.stringify(only)}`);
      const all = await query("[[0, 0], [800, 600]]");
      const names = new Set(all.map((f) => `${f.layer}:${f.name}`));
      for (const want of ["fill:square", "line:road", "dots:dot", "names:dot"]) {
        if (!names.has(want)) fail(`box query is missing ${want}: ${JSON.stringify([...names])}`);
      }
      const bad = await page.evaluate<string>(
        `window.map.queryRenderedFeatures([1, 1], { layers: ["nope"] }).then(() => "no error", (e) => e.code)`,
      );
      if (bad !== "invalid-option") fail(`expected an invalid-option error for an unknown layer, got ${bad}`);
    },
  },
  {
    name: "queryRenderedFeatures returns vector tile features and 3D buildings",
    async run({ page, base }) {
      const style = JSON.stringify({
        version: 1,
        sources: {
          v: { type: "vector", tiles: [`${base}/fixture/vector/{z}/{x}/{y}.pbf`], maxZoom: 6 },
          b: { type: "geojson", data: square(0.001, "#3366cc") },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "areas", type: "fill", source: "v", sourceLayer: "areas", paint: { color: "#dddddd" } },
          { id: "box", type: "extrusion", source: "b", paint: { color: ["get", "color"], height: 300 } },
        ],
      });
      await createMap(page, style, { zoom: 3, center: [20, 20] });
      const found = await page.evaluate<{ layer: string; name: unknown; id: unknown; ring: number[][] }[]>(
        `window.map.queryRenderedFeatures([400, 300], { layers: ["areas"] }).then((fs) => fs.map((f) => ({ layer: f.layer, name: f.properties.name, id: f.id, ring: f.geometry.coordinates[0] })))`,
      );
      if (found.length !== 1 || found[0]!.name !== "tile 3/4/3" || found[0]!.id !== 1003)
        fail(`expected the 3/4/3 tile polygon, got ${JSON.stringify(found)}`);
      const lngs = found[0]!.ring.map((p) => p[0]!);
      if (Math.abs(Math.min(...lngs) - 0) > 1e-6 || Math.abs(Math.max(...lngs) - 45) > 1e-6)
        fail(`expected the tile edges at 0 and 45 degrees east, got ${JSON.stringify(lngs)}`);
      await page.evaluate("void window.map.jumpTo({ center: [0, 0], zoom: 16, pitch: 60 })");
      await idle(page);
      const wall = await page.evaluate<string[]>(
        `window.map.queryRenderedFeatures([400, 200]).then((fs) => fs.map((f) => f.layer))`,
      );
      if (wall[0] !== "box") fail(`expected the 3D box first at 400,200, got ${JSON.stringify(wall)}`);
    },
  },
  {
    name: "feature state recolours features without reloading tiles",
    async run({ page, base, shot }) {
      const box = (west: number, east: number) => ({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, -10],
              [east, -10],
              [east, 10],
              [west, 10],
              [west, -10],
            ],
          ],
        },
      });
      const hover = ["case", ["boolean", ["feature-state", "hover"], false], "#ff0000", "#0000ff"];
      const style = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            generateId: true,
            data: { type: "FeatureCollection", features: [box(-20, -5), box(5, 20)] },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "boxes", type: "fill", source: "g", paint: { color: hover } },
        ],
      });
      await createMap(page, style);
      if (!near(await pixel(page, 263, 300), BLUE) || !near(await pixel(page, 537, 300), BLUE))
        fail("expected both boxes blue before any state is set");
      const requests = await page.evaluate<number>("window.map.getDiagnostics().sources.g.requested");
      await page.evaluate(`void window.map.setFeatureState({ source: "g", id: 1 }, { hover: true })`);
      await idle(page);
      await shot("feature-state-hover");
      const left = await pixel(page, 263, 300);
      const right = await pixel(page, 537, 300);
      if (!near(left, BLUE) || !near(right, RED)) fail(`expected only the second box red, got ${left} and ${right}`);
      const after = await page.evaluate<number>("window.map.getDiagnostics().sources.g.requested");
      if (after !== requests) fail(`setting state reloaded tiles (${requests} -> ${after} requests)`);
      const state = await page.evaluate<unknown>(`window.map.getFeatureState({ source: "g", id: 1 })`);
      if (JSON.stringify(state) !== JSON.stringify({ hover: true }))
        fail(`getFeatureState returned ${JSON.stringify(state)}`);
      const found = await page.evaluate<{ id: unknown; state: unknown }[]>(
        `window.map.queryRenderedFeatures([537, 300]).then((fs) => fs.map((f) => ({ id: f.id, state: f.state })))`,
      );
      if (
        found.length !== 1 ||
        found[0]!.id !== 1 ||
        JSON.stringify(found[0]!.state) !== JSON.stringify({ hover: true })
      )
        fail(`expected the hovered box with its state from the query, got ${JSON.stringify(found)}`);
      await page.evaluate(`void window.map.removeFeatureState({ source: "g", id: 1 }, "hover")`);
      await idle(page);
      if (!near(await pixel(page, 537, 300), BLUE)) fail("removing the hover key did not restore the colour");

      const vector = JSON.stringify({
        version: 1,
        sources: {
          v: { type: "vector", tiles: [`${base}/fixture/vector/{z}/{x}/{y}.pbf`], maxZoom: 6, promoteId: "name" },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "areas",
            type: "fill",
            source: "v",
            sourceLayer: "areas",
            paint: { color: ["case", ["boolean", ["feature-state", "picked"], false], "#ff0000", "#0000ff"] },
          },
        ],
      });
      await page.evaluate("window.map.remove()");
      await createMap(page, vector, { zoom: 3, center: [20, 20] });
      await page.evaluate(
        `void window.map.setFeatureState({ source: "v", sourceLayer: "areas", id: "tile 3/4/3" }, { picked: true })`,
      );
      await idle(page);
      const picked = await pixel(page, 400, 300);
      const other = await pixel(page, 60, 300);
      if (!near(picked, RED) || !near(other, BLUE))
        fail(`expected only tile 3/4/3 red with a string id, got ${picked} and ${other}`);
      const ids = await page.evaluate<unknown[]>(
        `window.map.queryRenderedFeatures([400, 300]).then((fs) => fs.map((f) => [f.id, f.state.picked]))`,
      );
      if (JSON.stringify(ids) !== JSON.stringify([["tile 3/4/3", true]]))
        fail(`expected the promoted string id in the query, got ${JSON.stringify(ids)}`);
      const missingLayer = await page.evaluate<string>(
        `(() => { try { window.map.setFeatureState({ source: "v", id: 1 }, { picked: true }); return "no error"; } catch (e) { return e.code; } })()`,
      );
      if (missingLayer !== "invalid-option") fail(`expected invalid-option without sourceLayer, got ${missingLayer}`);
      const issues = await page.evaluate<unknown[]>(
        `maplet.validateStyle({ version: 1, sources: {}, layers: [{ id: "x", type: "background", paint: { color: "#fff" } }, { id: "y", type: "circle", source: "s", filter: ["feature-state", "a"] }] })`,
      );
      if (!JSON.stringify(issues).includes("only works in paint properties"))
        fail(`expected feature-state in a filter to be rejected, got ${JSON.stringify(issues)}`);
    },
  },
  {
    name: "layer events report the features under the pointer",
    async run({ page }) {
      const box = (west: number, east: number) => ({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, -10],
              [east, -10],
              [east, 10],
              [west, 10],
              [west, -10],
            ],
          ],
        },
      });
      const style = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            generateId: true,
            data: { type: "FeatureCollection", features: [box(-20, -5), box(5, 20)] },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "boxes", type: "fill", source: "g", paint: { color: "#3366cc" } },
        ],
      });
      await createMap(page, style);
      await page.evaluate(`(() => {
        window.log = [];
        const map = window.map;
        map.on("click", "boxes", (e) => window.log.push("click " + e.features.map((f) => f.id).join(",")));
        map.on("mouseenter", "boxes", (e) => window.log.push("enter " + e.features[0].id));
        map.on("mouseleave", "boxes", (e) => window.log.push("leave " + e.features.length));
        map.on("click", "nothing-yet", () => window.log.push("missing layer"));
      })()`);
      const settle = () => page.evaluate("new Promise((r) => setTimeout(r, 150))");
      const click = async (x: number, y: number) => {
        await page.mouse("mouseMoved", x, y);
        await page.mouse("mousePressed", x, y, { buttons: 1 });
        await page.mouse("mouseReleased", x, y, { buttons: 0 });
      };
      await page.mouse("mouseMoved", 400, 100);
      await settle();
      await page.mouse("mouseMoved", 263, 300);
      await settle();
      await page.mouse("mouseMoved", 537, 300);
      await settle();
      await click(537, 300);
      await settle();
      await click(400, 100);
      await settle();
      await page.mouse("mouseMoved", 537, 300);
      await settle();
      const log = await page.evaluate<string[]>("window.log");
      const expected = ["enter 0", "click 1", "leave 0", "enter 1"];
      if (JSON.stringify(log) !== JSON.stringify(expected))
        fail(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(log)}`);

      await page.evaluate(`void window.map.on("mousedown", "boxes", (e) => e.preventDefault())`);
      const before = await page.evaluate<[number, number]>("window.map.getCenter()");
      await page.mouse("mouseMoved", 263, 300);
      await page.mouse("mousePressed", 263, 300, { buttons: 1 });
      for (let i = 1; i <= 8; i++) {
        await page.mouse("mouseMoved", 263 + i * 12, 300 + i * 4, { buttons: 1 });
        await new Promise((r) => setTimeout(r, 20));
      }
      await page.mouse("mouseReleased", 359, 332, { buttons: 0 });
      await idle(page);
      const held = await page.evaluate<[number, number]>("window.map.getCenter()");
      if (Math.hypot(held[0] - before[0], held[1] - before[1]) > 1e-9)
        fail(`preventDefault on a layer mousedown still panned the map to ${held}`);
      await page.mouse("mouseMoved", 400, 100);
      await page.mouse("mousePressed", 400, 100, { buttons: 1 });
      for (let i = 1; i <= 8; i++) {
        await page.mouse("mouseMoved", 400 + i * 12, 100, { buttons: 1 });
        await new Promise((r) => setTimeout(r, 20));
      }
      await page.mouse("mouseReleased", 496, 100, { buttons: 0 });
      await idle(page);
      const panned = await page.evaluate<[number, number]>("window.map.getCenter()");
      if (Math.abs(panned[0] - before[0]) < 1) fail("dragging the empty map no longer pans");

      await page.evaluate(`void window.map.jumpTo({ center: [0, 0], zoom: 3 })`);
      await idle(page);
      await page.evaluate(`void window.map.on("dblclick", "boxes", (e) => e.preventDefault())`);
      await page.mouse("mouseMoved", 263, 300);
      await page.mouse("mousePressed", 263, 300, { buttons: 1, clickCount: 1 });
      await page.mouse("mouseReleased", 263, 300, { buttons: 0, clickCount: 1 });
      await page.mouse("mousePressed", 263, 300, { buttons: 1, clickCount: 2 });
      await page.mouse("mouseReleased", 263, 300, { buttons: 0, clickCount: 2 });
      await settle();
      await idle(page);
      const zoomOnBox = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(zoomOnBox - 3) > 1e-9) fail(`a prevented dblclick on a layer still zoomed to ${zoomOnBox}`);
      await page.mouse("mouseMoved", 400, 100);
      await page.mouse("mousePressed", 400, 100, { buttons: 1, clickCount: 1 });
      await page.mouse("mouseReleased", 400, 100, { buttons: 0, clickCount: 1 });
      await page.mouse("mousePressed", 400, 100, { buttons: 1, clickCount: 2 });
      await page.mouse("mouseReleased", 400, 100, { buttons: 0, clickCount: 2 });
      await settle();
      await idle(page);
      const zoomed = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(zoomed - 4) > 0.01) fail(`a dblclick on empty map should zoom to 4, got ${zoomed}`);

      const once = await page.evaluate<string>(`(async () => {
        const wait = window.map.once("click", "boxes");
        return typeof wait.then;
      })()`);
      if (once !== "function") fail("once with a layer should return a promise");
      const bad = await page.evaluate<string>(
        `(() => { try { window.map.on("zoom", "boxes", () => {}); return "no error"; } catch (e) { return e.code; } })()`,
      );
      if (bad !== "invalid-option") fail(`expected invalid-option for a camera event on a layer, got ${bad}`);
    },
  },
  {
    name: "markers follow the map and open their popups",
    async run({ page, shot }) {
      await createMap(page, geojsonStyle({ type: "FeatureCollection", features: [] }));
      await page.evaluate(`(() => {
        window.popupLog = [];
        const html = '<b>Hello</b> <img src="x" onerror="window.hacked = 1"><script>window.hacked = 2</script>' +
          '<a href="javascript:window.hacked = 3">bad</a> <a href="https://example.com/" target="_blank">good</a>';
        const popup = new maplet.Popup().setHTML(html);
        popup.on("open", () => window.popupLog.push("open"));
        popup.on("close", () => window.popupLog.push("close"));
        window.popup = popup;
        window.marker = new maplet.Marker().setLngLat([10, 0]).setPopup(popup).addTo(window.map);
      })()`);
      await idle(page);
      const tipAt = () =>
        page.evaluate<[number, number]>(`(() => {
          const r = window.marker.getElement().getBoundingClientRect();
          const c = window.map.getContainer().getBoundingClientRect();
          return [r.left + r.width / 2 - c.left, r.bottom - c.top];
        })()`);
      const where = await page.evaluate<{ x: number; y: number }>("window.map.project([10, 0])");
      let tip = await tipAt();
      if (Math.hypot(tip[0] - where.x, tip[1] - where.y) > 1)
        fail(`expected the pin tip at ${where.x},${where.y}, got ${tip}`);
      await page.evaluate("void window.map.jumpTo({ center: [5, 0] })");
      await idle(page);
      const moved = await page.evaluate<{ x: number; y: number }>("window.map.project([10, 0])");
      tip = await tipAt();
      if (Math.hypot(tip[0] - moved.x, tip[1] - moved.y) > 1 || Math.abs(moved.x - where.x + 56.9) > 1)
        fail(`the marker did not follow the map: tip ${tip}, expected ${moved.x},${moved.y}`);

      const clickAt = async (x: number, y: number) => {
        await page.mouse("mouseMoved", x, y);
        await page.mouse("mousePressed", x, y, { buttons: 1 });
        await page.mouse("mouseReleased", x, y, { buttons: 0 });
      };
      await clickAt(tip[0], tip[1] - 26);
      await page.waitFor("document.querySelector('.maplet-popup') !== null", 3000);
      await idle(page);
      await shot("marker-popup");
      const popup = await page.evaluate<{
        anchor: boolean;
        above: boolean;
        bold: number;
        scripts: number;
        handlers: number;
        bad: string | null;
        good: string | null;
        rel: string | null;
        expanded: string | null;
        focused: boolean;
      }>(`(() => {
        const el = document.querySelector(".maplet-popup");
        const content = el.querySelector(".maplet-popup-content");
        const pin = window.marker.getElement().getBoundingClientRect();
        const links = content.querySelectorAll("a");
        return {
          anchor: el.classList.contains("maplet-popup-anchor-bottom"),
          above: el.getBoundingClientRect().bottom <= pin.top + 2,
          bold: content.querySelectorAll("b").length,
          scripts: content.querySelectorAll("script").length,
          handlers: [...content.querySelectorAll("*")].filter((n) => [...n.attributes].some((a) => a.name.startsWith("on"))).length,
          bad: links[0].getAttribute("href"),
          good: links[1].getAttribute("href"),
          rel: links[1].getAttribute("rel"),
          expanded: window.marker.getElement().getAttribute("aria-expanded"),
          focused: el.contains(document.activeElement),
        };
      })()`);
      if (!popup.anchor || !popup.above) fail(`expected the popup above the pin, got ${JSON.stringify(popup)}`);
      if (popup.bold !== 1 || popup.scripts !== 0 || popup.handlers !== 0 || popup.bad !== null)
        fail(`setHTML let unsafe markup through: ${JSON.stringify(popup)}`);
      if (popup.good !== "https://example.com/" || popup.rel !== "noopener noreferrer")
        fail(`setHTML should keep safe links: ${JSON.stringify(popup)}`);
      if (popup.expanded !== "true") fail(`the marker should report its popup as expanded, got ${popup.expanded}`);
      if (!popup.focused) fail("expected focus to move into the popup when it opens");
      const hacked = await page.evaluate<unknown>("window.hacked ?? null");
      if (hacked !== null) fail(`popup markup ran code: ${hacked}`);

      await clickAt(tip[0], tip[1] - 26);
      await page.waitFor("document.querySelector('.maplet-popup') === null", 3000);
      await clickAt(tip[0], tip[1] - 26);
      await page.waitFor("document.querySelector('.maplet-popup') !== null", 3000);
      await clickAt(150, 500);
      await page.waitFor("document.querySelector('.maplet-popup') === null", 3000);
      await clickAt(tip[0], tip[1] - 26);
      await page.waitFor("document.querySelector('.maplet-popup') !== null", 3000);
      await page.evaluate(
        `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
      );
      await page.waitFor("document.querySelector('.maplet-popup') === null", 3000);
      const log = await page.evaluate<string[]>("window.popupLog");
      if (JSON.stringify(log) !== JSON.stringify(["open", "close", "open", "close", "open", "close"]))
        fail(`unexpected popup events ${JSON.stringify(log)}`);
      const focusBack = await page.evaluate<boolean>("document.activeElement === window.marker.getElement()");
      if (!focusBack) fail("closing the popup with Escape should return focus to the marker");

      await page.evaluate(`(() => {
        window.dragLog = [];
        window.dragged = new maplet.Marker({ draggable: true, color: "#d33" }).setLngLat([-10, 0]).addTo(window.map);
        for (const type of ["dragstart", "drag", "dragend"]) window.dragged.on(type, () => window.dragLog.push(type));
      })()`);
      await idle(page);
      const before = await page.evaluate<[number, number]>("window.map.getCenter()");
      const start = await page.evaluate<{ x: number; y: number }>("window.map.project([-10, 0])");
      await page.mouse("mouseMoved", start.x, start.y - 26);
      await page.mouse("mousePressed", start.x, start.y - 26, { buttons: 1 });
      for (let i = 1; i <= 10; i++) {
        await page.mouse("mouseMoved", start.x + i * 5, start.y - 26, { buttons: 1 });
        await new Promise((r) => setTimeout(r, 15));
      }
      await page.mouse("mouseReleased", start.x + 50, start.y - 26, { buttons: 0 });
      await idle(page);
      const after = await page.evaluate<[number, number]>("window.dragged.getLngLat()");
      const center = await page.evaluate<[number, number]>("window.map.getCenter()");
      if (Math.abs(after[0] - (-10 + 50 / 11.378)) > 0.1 || Math.abs(after[1]) > 0.1)
        fail(`expected the dragged marker near ${-10 + 50 / 11.378},0, got ${after}`);
      if (Math.hypot(center[0] - before[0], center[1] - before[1]) > 1e-9) fail("dragging a marker moved the map");
      const drags = await page.evaluate<string[]>("window.dragLog");
      if (drags[0] !== "dragstart" || drags[drags.length - 1] !== "dragend" || !drags.includes("drag"))
        fail(`unexpected drag events ${JSON.stringify(drags)}`);
      await page.evaluate("window.marker.remove(); window.dragged.remove()");
      const left = await page.evaluate<number>("document.querySelectorAll('.maplet-marker').length");
      if (left !== 0) fail(`remove() left ${left} marker elements`);
    },
  },
  {
    name: "hillshade lights the slopes that face the light",
    async run({ page, base, shot }) {
      await createMap(page, demStyle(base), { center: HILL, zoom: 6 });
      await shot("north-up");
      const flat = await brightness(page, 30, 30);
      if (Math.abs(flat - 128) > 2) fail(`flat ground should stay uncovered, got ${flat}`);
      const check = async (litX: number, litY: number, darkX: number, darkY: number, what: string) => {
        const lit = await brightness(page, litX, litY);
        const dark = await brightness(page, darkX, darkY);
        if (!(lit > 138 && dark < 118)) fail(`${what}: expected ${lit} > 138 and ${dark} < 118`);
      };
      await check(340, 240, 460, 360, "north-up");
      await page.evaluate("void window.map.setBearing(180)");
      await idle(page);
      await check(340, 240, 460, 360, "rotated with the light fixed to the screen");
      await page.evaluate(`void window.map.setPaintProperty("hs", "illuminationAnchor", "map")`);
      await idle(page);
      await shot("map-anchor");
      await check(460, 360, 340, 240, "rotated with the light fixed to the map");
      await page.evaluate(`void window.map.setPaintProperty("hs", "exaggeration", 0)`);
      await idle(page);
      const off = await brightness(page, 460, 360);
      if (Math.abs(off - 128) > 2) fail(`exaggeration 0 should hide the shading, got ${off}`);
    },
  },
  {
    name: "hillshade tiles join without visible seams",
    async run({ page, base, shot }) {
      await createMap(page, demStyle(base), { center: HILL, zoom: 6 });
      await shot("seams");
      const seamX = await page.evaluate<number>("window.map.project([2.8125, 2]).x");
      const seamY = await page.evaluate<number>(`window.map.project([3, ${latFromMercatorY(63 / 128)}]).y`);
      const roughness = (values: number[]) => {
        let worst = 0;
        for (let i = 1; i < values.length - 1; i++) {
          worst = Math.max(worst, Math.abs(values[i + 1]! - 2 * values[i]! + values[i - 1]!));
        }
        return worst;
      };
      for (const y of [260, 300, 340]) {
        const row: number[] = [];
        for (let x = Math.round(seamX) - 10; x <= Math.round(seamX) + 10; x++) row.push(await brightness(page, x, y));
        if (roughness(row) > 4) fail(`seam at x=${seamX.toFixed(1)}, row ${y}: ${row.map(Math.round).join(" ")}`);
      }
      for (const x of [360, 400, 440]) {
        const column: number[] = [];
        for (let y = Math.round(seamY) - 10; y <= Math.round(seamY) + 10; y++)
          column.push(await brightness(page, x, y));
        if (roughness(column) > 4)
          fail(`seam at y=${seamY.toFixed(1)}, column ${x}: ${column.map(Math.round).join(" ")}`);
      }
    },
  },
  {
    name: "elevationAt reads heights from loaded elevation tiles",
    async run({ page, base }) {
      await createMap(page, demStyle(base), { center: HILL, zoom: 6 });
      const read = (lng: number, lat: number) =>
        page.evaluate<number | null>(`window.map.getSource("dem").elevationAt([${lng}, ${lat}])`);
      for (const [lng, lat] of [HILL, [3.5, 2.3], [2.2, 1.4], [4.1, 2.9]] as const) {
        const got = await read(lng, lat);
        const want = demHeight(mercatorX(lng), mercatorY(lat))!;
        if (got === null || Math.abs(got - want) > 0.5) fail(`elevation at ${lng},${lat}: got ${got}, want ${want}`);
      }
      await page.evaluate("void window.map.jumpTo({ center: [20, -20] })");
      await idle(page);
      const hole = await read(20, -20);
      if (hole !== null) fail(`transparent pixels should have no elevation, got ${hole}`);
      await page.evaluate("void window.map.jumpTo({ center: [100, 0] })");
      await idle(page);
      const missing = await read(100, 0);
      if (missing !== null) fail(`missing tiles should have no elevation, got ${missing}`);
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`missing elevation tiles should not raise errors: ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "terrain keeps the requested zoom over the ground",
    async run({ page, base }) {
      await createMap(page, terrainStyle(base), { center: HILL, zoom: 6 });
      const state = await page.evaluate<{ zoom: number; tiles: number; center: { x: number; y: number } }>(
        `({ zoom: window.map.getZoom(), tiles: window.map.getDiagnostics().terrain?.tiles ?? 0, center: window.map.project(${JSON.stringify(HILL)}) })`,
      );
      if (Math.abs(state.zoom - 6) > 1e-6) fail(`zoom should stay 6 when terrain loads, got ${state.zoom}`);
      if (state.tiles === 0) fail("no terrain tiles were drawn");
      if (Math.hypot(state.center.x - 400, state.center.y - 300) > 0.5)
        fail(`the hilltop should stay in the middle, got ${JSON.stringify(state.center)}`);
      await page.evaluate(`void window.map.flyTo({ center: [3.2, 2.1], zoom: 7.5, duration: 300 })`);
      await idle(page);
      const zoom = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(zoom - 7.5) > 1e-6) fail(`flyTo should end at zoom 7.5 over the hill, got ${zoom}`);
    },
  },
  {
    name: "drawn terrain matches project and unproject",
    async run({ page, base, shot }) {
      await createMap(page, terrainStyle(base), { center: [3.22, 2.12], zoom: 10, pitch: 55, bearing: 25 });
      await shot("pitched");
      const red = await page.evaluate<[number, number, number] | null>(RED_CENTROID);
      if (!red || red[2] < 20) fail(`the draped dot is missing: ${JSON.stringify(red)}`);
      const p = await page.evaluate<{ x: number; y: number }>(`window.map.project(${JSON.stringify(DOT)})`);
      if (Math.hypot(p.x - red[0], p.y - red[1]) > 2)
        fail(
          `project puts the dot at ${p.x.toFixed(1)},${p.y.toFixed(1)} but it is drawn at ${red[0].toFixed(1)},${red[1].toFixed(1)}`,
        );
      const back = await page.evaluate<[number, number]>(`window.map.unproject([${red[0]}, ${red[1]}])`);
      if (Math.hypot(back[0] - DOT[0], back[1] - DOT[1]) > 0.015)
        fail(`unproject of the drawn dot gave ${back}, want ${DOT}`);
      const layersAt = (geometry: string) =>
        page.evaluate<string[]>(`window.map.queryRenderedFeatures(${geometry}).then((fs) => fs.map((f) => f.layer))`);
      const onDot = await layersAt(`[${red[0]}, ${red[1]}]`);
      if (!onDot.includes("dot")) fail(`a query on the drawn dot found ${JSON.stringify(onDot)}`);
      const around = await layersAt(`[[${red[0] - 20}, ${red[1] - 20}], [${red[0] + 20}, ${red[1] + 20}]]`);
      if (!around.includes("dot")) fail(`a box around the drawn dot found ${JSON.stringify(around)}`);
      const beside = await layersAt(`[${red[0] + 60}, ${red[1]}]`);
      if (beside.includes("dot")) fail("a query 60 px beside the dot still found it");
      await page.evaluate("void window.map.setTerrain(null)");
      await idle(page);
      const flat = await page.evaluate<{ x: number; y: number }>(`window.map.project(${JSON.stringify(DOT)})`);
      if (Math.hypot(flat.x - p.x, flat.y - p.y) < 20)
        fail(
          `turning terrain off should move the dot on screen, it moved ${Math.hypot(flat.x - p.x, flat.y - p.y)} px`,
        );
      const after = await page.evaluate<{ terrain: unknown; red: number[] | null }>(
        `({ terrain: window.map.getDiagnostics().terrain, red: ${RED_CENTROID} })`,
      );
      if (after.terrain !== null)
        fail(`terrain diagnostics should be empty after setTerrain(null): ${JSON.stringify(after.terrain)}`);
      if (!after.red || Math.hypot(after.red[0]! - flat.x, after.red[1]! - flat.y) > 2)
        fail(`flat map dot at ${JSON.stringify(after.red)} but project says ${JSON.stringify(flat)}`);
    },
  },
  {
    name: "dragging on terrain keeps the grabbed ground under the pointer",
    async run({ page, base }) {
      await createMap(page, terrainStyle(base), { center: HILL, zoom: 7, pitch: 50 });
      const grabbed = await page.evaluate<[number, number]>("window.map.unproject([450, 330])");
      await page.mouse("mouseMoved", 450, 330);
      await page.mouse("mousePressed", 450, 330, { buttons: 1 });
      for (let i = 1; i <= 10; i++) {
        await page.mouse("mouseMoved", 450 - i * 10, 330 - i * 5, { buttons: 1 });
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 250));
      await page.mouse("mouseReleased", 350, 280, { buttons: 0 });
      await idle(page);
      const p = await page.evaluate<{ x: number; y: number }>(`window.map.project(${JSON.stringify(grabbed)})`);
      if (Math.hypot(p.x - 350, p.y - 280) > 2)
        fail(`the grabbed point ended at ${p.x.toFixed(1)},${p.y.toFixed(1)} instead of under the pointer at 350,280`);
    },
  },
  {
    name: "terrain without elevation data stays flat and quiet",
    async run({ page, base }) {
      await createMap(page, terrainStyle(base), { center: [100, 0], zoom: 6, pitch: 45 });
      const result = await page.evaluate<{ errors: unknown[]; tiles: number; center: { x: number; y: number } }>(
        `({ errors: window.errors, tiles: window.map.getDiagnostics().terrain?.tiles ?? 0, center: window.map.project([100, 0]) })`,
      );
      if (result.errors.length > 0) fail(`missing elevation tiles raised errors: ${JSON.stringify(result.errors)}`);
      if (result.tiles === 0) fail("terrain should still draw flat tiles where there is no data");
      if (Math.hypot(result.center.x - 400, result.center.y - 300) > 0.5)
        fail(`the center should stay in the middle, got ${JSON.stringify(result.center)}`);
    },
  },
  {
    name: "events from the constructor reach listeners added right after it",
    async run({ page }) {
      const result = await page.evaluate<{ styleload: number; errors: string[] }>(`(async () => {
        const out = { styleload: 0, errors: [] };
        const a = new maplet.Map({ container: "map", style: { version: 1, sources: {}, layers: [] } });
        a.on("styleload", () => out.styleload++);
        const box = document.createElement("div");
        box.style.cssText = "position: absolute; inset: 0";
        document.body.appendChild(box);
        const b = new maplet.Map({ container: box, style: { version: 1, sources: {}, layers: [{ id: "x", type: "nope" }] } });
        b.on("error", (e) => out.errors.push(e.error.code));
        await new Promise((r) => setTimeout(r, 50));
        a.remove();
        b.remove();
        box.remove();
        return out;
      })()`);
      if (result.styleload !== 1) fail(`expected one styleload event, got ${result.styleload}`);
      if (!result.errors.includes("invalid-style"))
        fail(`expected an invalid-style error, got ${JSON.stringify(result.errors)}`);
    },
  },
  {
    name: "remove releases the canvas and listeners",
    async run({ page, base }) {
      await createMap(page, rasterStyle(base, "/fixture/raster"));
      const result = await page.evaluate<{ canvas: number; classes: string }>(`(() => {
        window.map.remove();
        const el = document.getElementById("map");
        return { canvas: el.querySelectorAll("canvas").length, classes: el.className };
      })()`);
      if (result.canvas !== 0) fail("canvas still attached after remove()");
      if (result.classes.includes("maplet")) fail(`container still has map classes: ${result.classes}`);
    },
  },
  {
    name: "an invalid style reports every problem",
    async run({ page }) {
      const errors = await page.evaluate<{ code: string; message: string }[]>(`(async () => {
        const errors = [];
        const map = new maplet.Map({ container: "map" });
        map.on("error", (e) => errors.push({ code: e.error.code, message: e.error.message }));
        map.setStyle({ version: 1, sources: { a: { type: "raster" } }, layers: [{ id: "x", type: "line", source: "missing", paint: { colour: "red" } }] });
        await new Promise((r) => setTimeout(r, 50));
        map.remove();
        return errors;
      })()`);
      const first = errors[0];
      if (first?.code !== "invalid-style") fail(`expected invalid-style error, got ${JSON.stringify(errors)}`);
      for (const needle of ["sources.a", "missing", "colour"]) {
        if (!first.message.includes(needle)) fail(`error message does not mention ${needle}: ${first.message}`);
      }
    },
  },
];

async function main(): Promise<void> {
  const filter = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const software = process.argv.includes("--software") || process.env.CI === "true";
  if (!process.argv.includes("--no-build")) await buildAll({ types: false, quiet: true });
  mkdirSync(output, { recursive: true });
  writeMbtilesFixture(join(output, "fixture.mbtiles"));
  const { server, url } = await startServer({ root, routes: [fixtureRoute], quiet: true });
  const browser = await Browser.launch({ software });
  let failed = 0;
  try {
    for (const spec of specs) {
      if (filter && !spec.name.includes(filter)) continue;
      const page = await browser.newPage(800, 600);
      const started = performance.now();
      const slug = spec.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      try {
        await page.goto(`${url}/test/browser/harness.html`);
        await page.waitFor("window.ready");
        await Promise.race([
          spec.run({ page, base: url, shot: (name) => page.screenshot(join(output, `${slug}--${name}.png`)) }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("spec timed out after 45 s")), 45000)),
        ]);
        if (page.errors.length > 0) fail(`page errors: ${page.errors.join("\n")}`);
        console.log(`ok   ${spec.name} (${Math.round(performance.now() - started)} ms)`);
      } catch (error) {
        failed++;
        console.log(`FAIL ${spec.name}\n     ${error instanceof Error ? error.message : String(error)}`);
        for (const entry of page.console.filter((c) => c.type === "error" || c.type === "warning"))
          console.log(`     console.${entry.type}: ${entry.text}`);
        await page.screenshot(join(output, `${slug}--failure.png`)).catch(() => undefined);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed === 0 ? "all browser specs passed" : `${failed} browser spec(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
