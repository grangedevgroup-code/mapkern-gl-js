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
    name: "box zoom, max bounds and padding steer the camera",
    async run({ page, base, shot }) {
      await createMap(page, rasterStyle(base, "/fixture/raster"));
      const target = await page.evaluate<[number, number]>("window.map.unproject([200, 150])");
      await page.evaluate(`(() => {
        window.boxLog = [];
        for (const type of ["boxzoomstart", "boxzoomend", "boxzoomcancel"]) window.map.on(type, () => window.boxLog.push(type));
      })()`);
      await page.mouse("mouseMoved", 100, 100);
      await page.mouse("mousePressed", 100, 100, { buttons: 1, modifiers: 8 });
      for (let i = 1; i <= 8; i++) {
        await page.mouse("mouseMoved", 100 + i * 25, 100 + i * 12.5, { buttons: 1, modifiers: 8 });
        await new Promise((r) => setTimeout(r, 15));
      }
      const drawn = await page.evaluate<number>("document.querySelectorAll('.maplet-boxzoom').length");
      await page.mouse("mouseReleased", 300, 200, { buttons: 0, modifiers: 8 });
      await idle(page);
      const zoom = await page.evaluate<number>("window.map.getZoom()");
      const center = await page.evaluate<[number, number]>("window.map.getCenter()");
      if (drawn !== 1) fail(`expected the box outline while dragging, found ${drawn}`);
      if (Math.abs(zoom - 5) > 0.02) fail(`expected box zoom to land on zoom 5, got ${zoom}`);
      if (Math.hypot(center[0] - target[0], center[1] - target[1]) > 0.05)
        fail(`expected the box centre ${target} in the middle, got ${center}`);
      const boxLog = await page.evaluate<string[]>("window.boxLog");
      if (JSON.stringify(boxLog) !== JSON.stringify(["boxzoomstart", "boxzoomend"]))
        fail(`unexpected box zoom events ${JSON.stringify(boxLog)}`);
      const left = await page.evaluate<number>("document.querySelectorAll('.maplet-boxzoom').length");
      if (left !== 0) fail("the box outline stayed after the zoom");

      await page.evaluate(`void window.map.jumpTo({ center: [0, 0], zoom: 6 }).setMaxBounds([[-10, -10], [10, 10]])`);
      await page.evaluate("void window.map.setZoom(1)");
      await idle(page);
      const bounded = await page.evaluate<{ zoom: number; bounds: number[][]; max: number[][] }>(
        "({ zoom: window.map.getZoom(), bounds: window.map.getBounds(), max: window.map.getMaxBounds() })",
      );
      const [[w, s], [e, n]] = bounded.bounds as [[number, number], [number, number]];
      if (w < -10.001 || e > 10.001 || s < -10.001 || n > 10.001)
        fail(`the view ${JSON.stringify(bounded.bounds)} left the max bounds at zoom ${bounded.zoom}`);
      if (Math.abs(bounded.max[0]![0]! + 10) > 1e-6 || Math.abs(bounded.max[1]![1]! - 10) > 1e-6)
        fail(`getMaxBounds returned ${JSON.stringify(bounded.max)}`);
      await page.mouse("mouseMoved", 400, 300);
      await page.mouse("mousePressed", 400, 300, { buttons: 1 });
      for (let i = 1; i <= 10; i++) {
        await page.mouse("mouseMoved", 400 + i * 40, 300, { buttons: 1 });
        await new Promise((r) => setTimeout(r, 15));
      }
      await page.mouse("mouseReleased", 800, 300, { buttons: 0 });
      await idle(page);
      const dragged = await page.evaluate<number[][]>("window.map.getBounds()");
      if (dragged[0]![0]! < -10.001) fail(`dragging pulled the view past the west edge: ${JSON.stringify(dragged)}`);
      await page.evaluate("void window.map.setMaxBounds(null).setZoom(1)");
      await idle(page);
      const free = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(free - 1) > 1e-9) fail(`removing max bounds should allow zoom 1, got ${free}`);

      await page.evaluate("void window.map.jumpTo({ center: [0, 0], zoom: 4 }).setPadding({ left: 300 })");
      await idle(page);
      await shot("padding-left-300");
      const padded = await page.evaluate<{ x: number; y: number; center: number[]; padding: unknown }>(
        "({ ...window.map.project(window.map.getCenter()), center: window.map.getCenter(), padding: window.map.getPadding() })",
      );
      if (Math.abs(padded.x - 550) > 0.5 || Math.abs(padded.y - 300) > 0.5)
        fail(`with 300 px left padding the centre should sit at 550,300, got ${padded.x},${padded.y}`);
      if (JSON.stringify(padded.padding) !== JSON.stringify({ top: 0, right: 0, bottom: 0, left: 300 }))
        fail(`getPadding returned ${JSON.stringify(padded.padding)}`);
      const onLine = await brightness(page, 550, 200);
      const offLine = await brightness(page, 400, 200);
      if (onLine > 60 || offLine < 80)
        fail(`the tile edge at longitude 0 should be drawn at x=550, brightness ${onLine} there and ${offLine} at 400`);
      await page.evaluate("void window.map.fitBounds([[-10, -10], [10, 10]], { animate: false })");
      await idle(page);
      const fitted = await page.evaluate<{ x: number; y: number }>("window.map.project([0, 0])");
      if (Math.abs(fitted.x - 550) > 1 || Math.abs(fitted.y - 300) > 1)
        fail(`fitBounds should centre the bounds in the free area at 550,300, got ${fitted.x},${fitted.y}`);
      await page.evaluate("void window.map.easeTo({ padding: 0, duration: 0 })");
      await idle(page);
      const reset = await page.evaluate<{ x: number; y: number }>("window.map.project(window.map.getCenter())");
      if (Math.abs(reset.x - 400) > 0.5)
        fail(`easeTo({ padding: 0 }) should move the centre back to 400, got ${reset.x}`);

      await page.evaluate("window.map.remove()");
      await createMap(page, rasterStyle(base, "/fixture/raster"), {
        bounds: [
          [-20, -10],
          [20, 10],
        ],
      });
      const start = await page.evaluate<{ center: number[]; zoom: number }>(
        "({ center: window.map.getCenter(), zoom: window.map.getZoom() })",
      );
      const expectedZoom = Math.log2(Math.min(800 / ((40 / 360) * 512), 600 / (0.0558398 * 512)));
      if (Math.abs(start.zoom - expectedZoom) > 0.05 || Math.hypot(start.center[0]!, start.center[1]!) > 1e-6)
        fail(`the bounds option should start at zoom ${expectedZoom} over 0,0, got ${JSON.stringify(start)}`);
    },
  },
  {
    name: "icons from addImage and sprites sit on their points",
    async run({ page, base, shot }) {
      const point = (lng: number, lat: number, properties: Record<string, unknown>) => ({
        type: "Feature",
        properties,
        geometry: { type: "Point", coordinates: [lng, lat] },
      });
      const style = JSON.stringify({
        version: 1,
        sprite: `${base}/fixture/sprite`,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                point(-10, 0, { kind: "square" }),
                point(10, 0, { kind: "green", name: "Green" }),
                point(0, 8, { kind: "late" }),
                point(0, -8, { kind: "sdf" }),
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "icons",
            type: "symbol",
            source: "g",
            layout: {
              icon: ["get", "kind"],
              text: ["coalesce", ["get", "name"], ""],
              anchor: "top",
              offset: [0, 1],
              allowOverlap: true,
              iconAllowOverlap: true,
            },
            paint: { iconColor: "#0000ff" },
          },
        ],
      });
      await page.evaluate(`(async () => {
        const solid = (r, g, b) => {
          const data = new Uint8Array(16 * 16 * 4);
          for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
          return { width: 16, height: 16, data };
        };
        window.missing = [];
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [0, 0], zoom: 3, style: ${style} });
        window.map.addImage("square", solid(255, 0, 0));
        window.map.addImage("sdf", solid(255, 255, 255), { sdf: true });
        window.map.on("styleimagemissing", (e) => {
          window.missing.push(e.id);
          if (e.id === "late") window.map.addImage("late", solid(255, 220, 0));
        });
        await window.map.once("idle");
      })()`);
      await page.waitFor("window.missing.includes('late')", 5000);
      await idle(page);
      await shot("icons");
      const at = async (lng: number, lat: number, dx = 0) => {
        const p = await page.evaluate<{ x: number; y: number }>(`window.map.project([${lng}, ${lat}])`);
        return pixel(page, Math.round(p.x + dx), Math.round(p.y));
      };
      const red = await at(-10, 0);
      const green = await at(10, 0);
      const late = await at(0, 8);
      const sdf = await at(0, -8);
      if (!near(red, RED, 10)) fail(`expected the red square icon at -10,0, got ${red}`);
      if (!near(green, GREEN, 10)) fail(`expected the green sprite icon at 10,0, got ${green}`);
      if (!near(late, [255, 220, 0, 255], 10)) fail(`expected the icon added from styleimagemissing, got ${late}`);
      if (!near(sdf, BLUE, 12)) fail(`expected the SDF icon tinted blue by iconColor, got ${sdf}`);
      const missing = await page.evaluate<string[]>("window.missing");
      if (JSON.stringify(missing) !== JSON.stringify(["late"]))
        fail(`unexpected missing images ${JSON.stringify(missing)}`);
      const listed = await page.evaluate<string[]>("window.map.listImages().sort()");
      if (JSON.stringify(listed) !== JSON.stringify(["green", "late", "magenta", "sdf", "square"]))
        fail(`listImages returned ${JSON.stringify(listed)}`);
      const outside = await at(-10, 0, 12);
      if (!near(outside, WHITE, 10)) fail(`a 16 px icon should not reach 12 px from its point, got ${outside}`);
      await page.evaluate(`void window.map.setLayoutProperty("icons", "iconSize", 2)`);
      await idle(page);
      const grown = await at(-10, 0, 12);
      if (!near(grown, RED, 10)) fail(`iconSize 2 should reach 12 px from the point, got ${grown}`);
      const found = await page.evaluate<string[]>(`(async () => {
        const p = window.map.project([-10, 0]);
        const fs = await window.map.queryRenderedFeatures([p.x + 10, p.y]);
        return fs.map((f) => f.properties.kind);
      })()`);
      if (JSON.stringify(found) !== JSON.stringify(["square"]))
        fail(`query on the icon returned ${JSON.stringify(found)}`);
      await page.evaluate(`void window.map.removeImage("square")`);
      await idle(page);
      const gone = await at(-10, 0);
      if (!near(gone, WHITE, 10)) fail(`removeImage should take the icon away, got ${gone}`);
      const duplicate = await page.evaluate<string>(
        `(() => { try { window.map.addImage("green", { width: 1, height: 1, data: new Uint8Array(4) }); return "no error"; } catch (e) { return e.code; } })()`,
      );
      if (duplicate !== "invalid-option") fail(`adding an existing image name should fail, got ${duplicate}`);
    },
  },
  {
    name: "icons along a line turn with the line",
    async run({ page, shot }) {
      const style = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: {
                    type: "LineString",
                    coordinates: [
                      [5, 2],
                      [5, 30],
                    ],
                  },
                },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "arrows",
            type: "symbol",
            source: "g",
            layout: { placement: "line", spacing: 1000, icon: "arrow", iconAllowOverlap: true },
          },
        ],
      });
      await page.evaluate(`(async () => {
        const data = new Uint8Array(24 * 12 * 4);
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 24; x++) data.set(x < 12 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 24 + x) * 4);
        }
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [5, 16], zoom: 3, style: ${style} });
        window.map.addImage("arrow", { width: 24, height: 12, data });
        await window.map.once("idle");
      })()`);
      await idle(page);
      await shot("line-icons");
      const middle = latFromMercatorY((mercatorY(2) + mercatorY(30)) / 2);
      const at = await page.evaluate<{ x: number; y: number }>(`window.map.project([5, ${middle}])`);
      const above = await pixel(page, Math.round(at.x), Math.round(at.y - 6));
      const below = await pixel(page, Math.round(at.x), Math.round(at.y + 6));
      if (!near(above, BLUE, 12) || !near(below, RED, 12))
        fail(`an icon on a line heading north should point its right side up, got ${above} above and ${below} below`);
      await page.evaluate("void window.map.setBearing(90)");
      await idle(page);
      const turned = await page.evaluate<{ x: number; y: number }>(`window.map.project([5, ${middle}])`);
      const left = await pixel(page, Math.round(turned.x - 6), Math.round(turned.y));
      const right = await pixel(page, Math.round(turned.x + 6), Math.round(turned.y));
      if (!near(left, BLUE, 12) || !near(right, RED, 12))
        fail(`with east up the line heads left, so the icon should too: got ${left} left and ${right} right`);
    },
  },
  {
    name: "GeoJSON points cluster and come apart as you zoom in",
    async run({ page, shot }) {
      const features = [];
      for (let i = 0; i < 200; i++) {
        features.push({
          type: "Feature",
          properties: { value: i % 10, name: `p${i}` },
          geometry: { type: "Point", coordinates: [-1 + (i % 20) * 0.1, -0.5 + Math.floor(i / 20) * 0.1] },
        });
      }
      features.push({
        type: "Feature",
        properties: { value: 5, name: "far" },
        geometry: { type: "Point", coordinates: [20, 10] },
      });
      const style = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: { type: "FeatureCollection", features },
            cluster: true,
            clusterMaxZoom: 12,
            clusterRadius: 50,
            clusterProperties: { total: ["+", ["get", "value"]] },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "clusters",
            type: "circle",
            source: "g",
            filter: ["has", "point_count"],
            paint: { radius: 20, color: "#ff0000" },
          },
          {
            id: "count",
            type: "symbol",
            source: "g",
            filter: ["has", "point_count"],
            layout: { text: ["get", "point_count_abbreviated"], allowOverlap: true },
            paint: { color: "#ffffff" },
          },
          {
            id: "points",
            type: "circle",
            source: "g",
            filter: ["!", ["has", "point_count"]],
            paint: { radius: 5, color: "#0000ff" },
          },
        ],
      });
      await createMap(page, style, { zoom: 3, center: [0, 0] });
      await shot("clusters-z3");
      const centerPixel = await pixel(page, 412, 300);
      if (!near(centerPixel, RED, 10)) fail(`expected one cluster circle over the points, got ${centerPixel}`);
      const far = await page.evaluate<{ x: number; y: number }>("window.map.project([20, 10])");
      const farPixel = await pixel(page, Math.round(far.x), Math.round(far.y));
      if (!near(farPixel, BLUE, 10)) fail(`the lone far point should stay a point, got ${farPixel}`);
      const found = await page.evaluate<Record<string, unknown>[]>(
        `window.map.queryRenderedFeatures([412, 300], { layers: ["clusters"] }).then((fs) => fs.map((f) => ({ id: f.id, ...f.properties })))`,
      );
      const cluster = found[0];
      if (cluster?.cluster !== true || cluster.point_count !== 200 || cluster.total !== 900)
        fail(`expected a cluster of 200 points with total 900, got ${JSON.stringify(found)}`);
      const id = cluster.cluster_id as number;
      if (cluster.id !== id) fail(`the cluster feature id should be its cluster_id, got ${cluster.id} and ${id}`);
      const answers = await page.evaluate<{
        zoom: number;
        children: number;
        leaves: string[];
        all: number;
      }>(`(async () => {
        const source = window.map.getSource("g");
        const zoom = await source.getClusterExpansionZoom(${id});
        const children = await source.getClusterChildren(${id});
        const leaves = await source.getClusterLeaves(${id}, 3, 2);
        const all = await source.getClusterLeaves(${id}, Infinity);
        return {
          zoom,
          children: children.reduce((sum, f) => sum + (f.properties.point_count ?? 1), 0),
          leaves: leaves.map((f) => f.properties.name),
          all: all.length,
        };
      })()`);
      if (!(answers.zoom > 3 && answers.zoom <= 13)) fail(`unexpected expansion zoom ${answers.zoom}`);
      if (answers.children !== 200) fail(`the children should hold all 200 points, got ${answers.children}`);
      if (answers.leaves.length !== 3 || answers.all !== 200)
        fail(`getClusterLeaves gave ${JSON.stringify(answers.leaves)} and ${answers.all} in all`);
      const bad = await page.evaluate<string>(
        `window.map.getSource("g").getClusterExpansionZoom(999999).then(() => "no error", (e) => e.code)`,
      );
      if (bad !== "invalid-option") fail(`an unknown cluster id should fail, got ${bad}`);
      await page.evaluate(`void window.map.jumpTo({ center: [-0.05, -0.05], zoom: ${answers.zoom} })`);
      await idle(page);
      const split = await page.evaluate<number[]>(
        `window.map.queryRenderedFeatures(undefined, { layers: ["clusters", "points"] }).then((fs) => fs.map((f) => f.properties.point_count ?? 1))`,
      );
      if (split.length < 2 || split.some((count) => count >= 200))
        fail(`at the expansion zoom the cluster should come apart, got ${JSON.stringify(split)}`);
      await page.evaluate("void window.map.jumpTo({ center: [-1, -0.5], zoom: 13 })");
      await idle(page);
      await shot("clusters-z13");
      const single = await pixel(page, 400, 300);
      if (!near(single, BLUE, 10)) fail(`past clusterMaxZoom the points should be drawn one by one, got ${single}`);
      const leaf = await page.evaluate<unknown[]>(
        `window.map.queryRenderedFeatures([400, 300]).then((fs) => fs.map((f) => f.properties.name))`,
      );
      if (JSON.stringify(leaf) !== JSON.stringify(["p0"]))
        fail(`expected the original point p0, got ${JSON.stringify(leaf)}`);
    },
  },
  {
    name: "heatmaps glow where points crowd together",
    async run({ page, base, shot }) {
      const features = [];
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2;
        const r = 0.3 * ((i % 5) / 5);
        features.push({
          type: "Feature",
          properties: { weight: 1 },
          geometry: { type: "Point", coordinates: [Math.cos(a) * r, Math.sin(a) * r] },
        });
      }
      features.push({ type: "Feature", properties: { weight: 1 }, geometry: { type: "Point", coordinates: [12, 0] } });
      const layers = [
        { id: "bg", type: "background", paint: { color: "#ffffff" } },
        { id: "heat", type: "heatmap", source: "g", paint: { radius: 40, weight: ["get", "weight"] } },
      ];
      const style = JSON.stringify({
        version: 1,
        sources: { g: { type: "geojson", data: { type: "FeatureCollection", features } } },
        layers,
      });
      await createMap(page, style, { zoom: 4, center: [0, 0] });
      await shot("heatmap");
      const hot = await pixel(page, 400, 300);
      const lone = await page.evaluate<{ x: number; y: number }>("window.map.project([12, 0])");
      const cool = await pixel(page, Math.round(lone.x), Math.round(lone.y));
      const empty = await pixel(page, 400, 80);
      const redness = (c: RGBA) => c[0] - c[2];
      if (redness(hot) < 120) fail(`the crowded centre should glow warm, got ${hot}`);
      if (redness(cool) > 0 || near(cool, WHITE, 10)) fail(`a lone point should be a cool faint spot, got ${cool}`);
      if (!near(empty, WHITE, 6)) fail(`away from the points the map should be untouched, got ${empty}`);
      await page.evaluate(`void window.map.setPaintProperty("heat", "opacity", 0.4)`);
      await idle(page);
      const faded = await pixel(page, 400, 300);
      if (!(faded[1] > hot[1] + 40)) fail(`opacity 0.4 should let the white show through, got ${faded} from ${hot}`);
      await page.evaluate(`void window.map.setPaintProperty("heat", "opacity", 1)`);
      await page.evaluate(
        `void window.map.setPaintProperty("heat", "color", ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0, 0, 255, 0)", 0.2, "#00ff00", 1, "#00ff00"])`,
      );
      await idle(page);
      const green = await pixel(page, 400, 300);
      if (!near(green, GREEN, 12)) fail(`a custom color ramp should paint the centre green, got ${green}`);
      const query = await page.evaluate<number>("window.map.queryRenderedFeatures([400, 300]).then((fs) => fs.length)");
      if (query !== 0) fail(`heatmap layers are not queryable, got ${query} features`);

      await page.evaluate("window.map.remove()");
      const terrain = JSON.stringify({
        version: 1,
        sources: {
          dem: { type: "dem", tiles: [`${base}/fixture/dem/{z}/{x}/{y}.png`], tileSize: 256, maxZoom: 12 },
          g: { type: "geojson", data: { type: "FeatureCollection", features } },
        },
        layers,
        terrain: { source: "dem" },
      });
      await createMap(page, terrain, { zoom: 4, center: [0, 0], pitch: 30 });
      await shot("heatmap-terrain");
      const draped = await pixel(page, 400, 300);
      if (redness(draped) < 100) fail(`with terrain on the heatmap should still glow, got ${draped}`);
      const seam = await page.evaluate<{ x: number; y: number }>("window.map.project([12, 0])");
      const above = await pixel(page, Math.round(seam.x), Math.round(seam.y - 6));
      const below = await pixel(page, Math.round(seam.x), Math.round(seam.y + 6));
      if (near(above, WHITE, 10) || near(below, WHITE, 10))
        fail(
          `a point on a tile edge should glow on both sides of it on terrain, got ${above} above and ${below} below`,
        );

      await page.evaluate("window.map.remove()");
      const dots = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
                { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [5, 5] } },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "dots", type: "circle", source: "g", paint: { radius: 10, color: "#000000", opacity: 0.5 } },
        ],
      });
      await createMap(page, dots, { zoom: 4, center: [2.5, 2.5] });
      const corner = await page.evaluate<{ x: number; y: number }>("window.map.project([0, 0])");
      const open = await page.evaluate<{ x: number; y: number }>("window.map.project([5, 5])");
      const onCorner = await pixel(page, Math.round(corner.x) + 2, Math.round(corner.y) + 2);
      const inside = await pixel(page, Math.round(open.x) + 2, Math.round(open.y) + 2);
      if (Math.abs(onCorner[0] - inside[0]) > 4)
        fail(`a see-through circle on a tile corner was drawn more than once: ${onCorner} against ${inside}`);
    },
  },
  {
    name: "querySourceFeatures reads every loaded feature of a source",
    async run({ page, base }) {
      const points = [];
      for (let i = 0; i < 40; i++) {
        points.push({
          type: "Feature",
          properties: { kind: i % 2 === 0 ? "even" : "odd", n: i },
          geometry: { type: "Point", coordinates: [-30 + i * 1.5, i % 2 === 0 ? 1 : -1] },
        });
      }
      const style = JSON.stringify({
        version: 1,
        sources: {
          v: { type: "vector", tiles: [`${base}/fixture/vector/{z}/{x}/{y}.pbf`], maxZoom: 6 },
          g: { type: "geojson", data: { type: "FeatureCollection", features: points } },
          c: {
            type: "geojson",
            data: { type: "FeatureCollection", features: points },
            cluster: true,
            clusterRadius: 80,
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "areas", type: "fill", source: "v", sourceLayer: "areas", paint: { color: "#dddddd" } },
          { id: "dots", type: "circle", source: "g", paint: { radius: 3, color: "#000000" } },
          { id: "clusters", type: "circle", source: "c", paint: { radius: 3, color: "#ff0000" } },
        ],
      });
      await createMap(page, style, { zoom: 3, center: [0, 0] });
      const result = await page.evaluate<{
        tiles: string[];
        one: { name: unknown; type: string | undefined; layer: string | undefined }[];
        even: number[];
        all: number;
        types: string[];
        clusters: number;
        clustered: number;
      }>(`(async () => {
        const map = window.map;
        const tiles = await map.querySourceFeatures("v", { sourceLayer: "areas" });
        const one = await map.querySourceFeatures("v", { sourceLayer: "areas", filter: ["==", ["get", "name"], "tile 3/4/3"] });
        const even = await map.querySourceFeatures("g", { filter: ["==", ["get", "kind"], "even"] });
        const all = await map.querySourceFeatures("g");
        const clusters = await map.querySourceFeatures("c");
        return {
          tiles: tiles.map((f) => f.properties.name).sort(),
          one: one.map((f) => ({ name: f.properties.name, type: f.geometry?.type, layer: f.sourceLayer })),
          even: even.map((f) => f.properties.n).sort((a, b) => a - b),
          all: all.length,
          types: [...new Set(all.map((f) => f.geometry.type))],
          clusters: clusters.filter((f) => f.properties.cluster).length,
          clustered: clusters.reduce((sum, f) => sum + (f.properties.point_count ?? 1), 0),
        };
      })()`);
      if (result.tiles.length < 4 || new Set(result.tiles).size !== result.tiles.length)
        fail(`expected one polygon per visible tile, got ${JSON.stringify(result.tiles)}`);
      if (JSON.stringify(result.one) !== JSON.stringify([{ name: "tile 3/4/3", type: "Polygon", layer: "areas" }]))
        fail(`the filter should pick out tile 3/4/3, got ${JSON.stringify(result.one)}`);
      const expectedEven = [...Array(20).keys()].map((i) => i * 2);
      if (JSON.stringify(result.even) !== JSON.stringify(expectedEven))
        fail(`expected the 20 even points once each, got ${JSON.stringify(result.even)}`);
      if (result.all !== 40 || JSON.stringify(result.types) !== JSON.stringify(["Point"]))
        fail(`expected all 40 points as whole points, got ${result.all} of ${JSON.stringify(result.types)}`);
      if (result.clusters === 0 || result.clustered !== 40)
        fail(
          `a clustered source should give clusters covering all 40 points, got ${result.clusters} and ${result.clustered}`,
        );
      const errors = await page.evaluate<string[]>(`(async () => {
        const out = [];
        for (const call of [
          () => window.map.querySourceFeatures("nope"),
          () => window.map.querySourceFeatures("g", { filter: ["nonsense", 1] }),
        ]) {
          try { await call(); out.push("no error"); } catch (e) { out.push(e.code); }
        }
        return out;
      })()`);
      if (JSON.stringify(errors) !== JSON.stringify(["invalid-option", "invalid-option"]))
        fail(`bad sources and filters should fail with invalid-option, got ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "circle stroke opacity, translate and pitch options",
    async run({ page, shot }) {
      const style = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "dot",
            type: "circle",
            source: "g",
            paint: { radius: 20, color: "#ff0000", strokeColor: "#0000ff", strokeWidth: 6, strokeOpacity: 0 },
          },
        ],
      });
      await createMap(page, style, { zoom: 5, center: [0, 0] });
      const ring = await pixel(page, 423, 300);
      if (!near(ring, WHITE, 10)) fail(`strokeOpacity 0 should hide the stroke, got ${ring}`);
      await page.evaluate(
        `void window.map.setPaintProperty("dot", "strokeOpacity", 1).setPaintProperty("dot", "opacity", 0.5)`,
      );
      await idle(page);
      const stroke = await pixel(page, 423, 300);
      const fill = await pixel(page, 400, 300);
      if (!near(stroke, BLUE, 10)) fail(`a circle's opacity should not fade its stroke, got ${stroke}`);
      if (!near(fill, [255, 128, 128, 255], 10)) fail(`opacity 0.5 should fade the fill, got ${fill}`);
      const extent = (row: number) =>
        page.evaluate<number>(`(() => {
          let count = 0;
          for (let x = 0; x < 800; x++) {
            const c = window.pixel(x, ${row});
            if (c[0] > 200 && c[1] < 180 && c[2] < 180) count++;
          }
          return count;
        })()`);
      await page.evaluate(
        `void window.map.setPaintProperty("dot", "opacity", 1).setPaintProperty("dot", "translate", [30, 0])`,
      );
      await idle(page);
      const moved = await pixel(page, 430, 300);
      const left = await pixel(page, 385, 300);
      if (!near(moved, RED, 10) || near(left, RED, 10))
        fail(`translate [30, 0] should move the circle right, got ${moved} and ${left}`);
      await page.evaluate("void window.map.setBearing(90)");
      await idle(page);
      const mapAnchored = await pixel(page, 400, 270);
      if (!near(mapAnchored, RED, 10))
        fail(`a map-anchored translate turns with the map, got ${mapAnchored} at 400,270`);
      await page.evaluate(`void window.map.setPaintProperty("dot", "translateAnchor", "viewport")`);
      await idle(page);
      const screenAnchored = await pixel(page, 430, 300);
      if (!near(screenAnchored, RED, 10))
        fail(`a viewport-anchored translate stays screen right, got ${screenAnchored} at 430,300`);
      await page.evaluate(
        `void window.map.setPaintProperty("dot", "translate", [0, 0]).jumpTo({ bearing: 0, pitch: 60, center: [0, -5] })`,
      );
      await idle(page);
      const far = await page.evaluate<{ x: number; y: number }>("window.map.project([0, 0])");
      const row = Math.round(far.y);
      const plain = await extent(row);
      await page.evaluate(`void window.map.setPaintProperty("dot", "pitchScale", "map")`);
      await idle(page);
      const scaled = await extent(row);
      const ratio = await page.evaluate<number>(
        "(() => { const t = window.map.transform; return t.cameraToCenterDistance / t.project(0.5, 0.5, 0).w; })()",
      );
      if (!(ratio < 0.95) || Math.abs(scaled - plain * ratio) > 2.5)
        fail(`pitchScale map should shrink a distant circle to ${plain * ratio} px, got ${scaled} px from ${plain} px`);
      await page.evaluate(`void window.map.setPaintProperty("dot", "pitchAlignment", "map")`);
      await idle(page);
      await shot("circle-pitch-map");
      const tall = await page.evaluate<number>(`(() => {
        let count = 0;
        for (let y = 0; y < 600; y++) {
          const c = window.pixel(${Math.round(far.x)}, y);
          if (c[0] > 200 && c[1] < 180 && c[2] < 180) count++;
        }
        return count;
      })()`);
      const wide = await extent(row);
      if (!(tall < wide * 0.75))
        fail(`a circle lying flat on a tilted map should look squashed, got ${tall} tall and ${wide} wide`);
    },
  },
  {
    name: "line offset and gap width move and split lines",
    async run({ page, shot }) {
      const line = (coordinates: number[][], kind: string) => ({
        type: "Feature",
        properties: { kind },
        geometry: { type: "LineString", coordinates },
      });
      const style = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                line(
                  [
                    [-20, 1],
                    [20, 1],
                  ],
                  "straight",
                ),
                line(
                  [
                    [-12, -6],
                    [-4, -6],
                    [-4, -14],
                  ],
                  "corner",
                ),
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "lines", type: "line", source: "g", paint: { color: "#0000ff", width: 4 } },
        ],
      });
      await createMap(page, style, { zoom: 4, center: [0, -4] });
      const y = await page.evaluate<number>("Math.round(window.map.project([0, 1]).y)");
      const column = (x: number) =>
        page.evaluate<number[]>(`(() => {
          const out = [];
          for (let yy = ${y} - 20; yy <= ${y} + 20; yy++) {
            const c = window.pixel(${x}, yy);
            if (c[2] > 200 && c[0] < 120) out.push(yy - ${y});
          }
          return out;
        })()`);
      const centre = (rows: number[]) => (rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.NaN);
      const plain = await column(500);
      if (Math.abs(centre(plain)) > 0.6) fail(`the plain line should sit on its path, got rows ${plain}`);
      await page.evaluate(`void window.map.setPaintProperty("lines", "offset", 10)`);
      await idle(page);
      const right = await column(500);
      if (Math.abs(centre(right) - 10) > 0.6)
        fail(`offset 10 should move an eastward line 10 px south, got rows ${right}`);
      await page.evaluate(`void window.map.setPaintProperty("lines", "offset", -10)`);
      await idle(page);
      const left = await column(500);
      if (Math.abs(centre(left) + 10) > 0.6) fail(`offset -10 should move it 10 px north, got rows ${left}`);
      await page.evaluate(
        `void window.map.setPaintProperty("lines", "offset", 0).setPaintProperty("lines", "gapWidth", 10)`,
      );
      await idle(page);
      const split = await column(500);
      const above = split.filter((r) => r < 0);
      const below = split.filter((r) => r > 0);
      if (split.some((r) => Math.abs(r) < 4) || Math.abs(centre(above) + 7) > 0.8 || Math.abs(centre(below) - 7) > 0.8)
        fail(`gapWidth 10 with width 4 should leave two bands around a 10 px gap, got rows ${split}`);
      await page.evaluate(
        `void window.map.setPaintProperty("lines", "gapWidth", 0).setPaintProperty("lines", "offset", 8).setLayoutProperty("lines", "join", "round")`,
      );
      await idle(page);
      await shot("offset-corner");
      const corner = await page.evaluate<{ x: number; y: number }>("window.map.project([-4, -6])");
      const probe = await page.evaluate<number>(`(() => {
        let blue = 0;
        for (let k = -24; k <= 24; k++) {
          const c = window.pixel(Math.round(${corner.x} - 8 + (k < 0 ? k : 0)), Math.round(${corner.y} + 8 + (k > 0 ? k : 0)));
          if (c[2] > 200 && c[0] < 120) blue++;
        }
        return blue;
      })()`);
      if (probe < 46)
        fail(`the offset line should run unbroken around the corner, only ${probe} of 49 probes were blue`);
    },
  },
  {
    name: "label anchors, justification, rotation and spacing options",
    async run({ page, shot }) {
      const point = (lng: number, lat: number, properties: Record<string, unknown>) => ({
        type: "Feature",
        properties,
        geometry: { type: "Point", coordinates: [lng, lat] },
      });
      const base = (layers: unknown[], features: unknown[]) =>
        JSON.stringify({
          version: 1,
          sources: { g: { type: "geojson", data: { type: "FeatureCollection", features } } },
          layers: [{ id: "bg", type: "background", paint: { color: "#ffffff" } }, ...layers],
        });
      const scan = (x0: number, y0: number, x1: number, y1: number, test: string) =>
        page.evaluate<{ box: number[] | null; count: number }>(`(() => {
          const gl = window.map.getCanvas().getContext("webgl2");
          const w = ${x1} - ${x0};
          const h = ${y1} - ${y0};
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(${x0}, gl.drawingBufferHeight - ${y1}, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, count = 0;
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const i = (row * w + col) * 4;
              const r = px[i], g = px[i + 1], bl = px[i + 2];
              if (!(${test})) continue;
              const x = ${x0} + col;
              const y = ${y1} - 1 - row;
              a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); count++;
            }
          }
          return { box: a === Infinity ? null : [a, b, c, d], count };
        })()`);
      const DARK = "r < 110 && g < 110 && bl < 110";
      const RED_TEXT = "r > 200 && g < 90 && bl < 90";
      const darkBox = async (x0: number, y0: number, x1: number, y1: number) => (await scan(x0, y0, x1, y1, DARK)).box;
      await createMap(
        page,
        base(
          [
            {
              id: "main",
              type: "symbol",
              source: "g",
              filter: ["==", ["get", "role"], "main"],
              layout: { text: ["get", "name"], size: 16, variableAnchor: ["top", "bottom"] },
            },
            {
              id: "blocker",
              type: "symbol",
              source: "g",
              filter: ["==", ["get", "role"], "blocker"],
              layout: { text: ["get", "name"], size: 24 },
              paint: { color: "#ff0000" },
            },
          ],
          [point(0, 0, { role: "main", name: "Hello" }), point(0, -0.8, { role: "blocker", name: "BLOCKING" })],
        ),
        { zoom: 5, center: [0, 0] },
      );
      await shot("variable-anchor");
      const above = await darkBox(340, 250, 460, 300);
      const below = await darkBox(340, 301, 460, 330);
      if (!above || below)
        fail(`with the space below taken the label should move above its point, got ${above} and ${below}`);
      await page.evaluate("window.map.remove()");

      const lines = (justify: string, extra: Record<string, unknown> = {}) =>
        base(
          [
            {
              id: "t",
              type: "symbol",
              source: "g",
              layout: { text: ["get", "name"], size: 16, maxWidth: 6, justify, ...extra },
            },
          ],
          [point(0, 0, { name: "Wide first line here x" })],
        );
      const measure = async (justify: string, extra: Record<string, unknown> = {}) => {
        await createMap(page, lines(justify, extra), { zoom: 5, center: [0, 0] });
        const box = await darkBox(250, 230, 550, 370);
        const lastRow = box ? await darkBox(250, box[3]! - 8, 550, box[3]! + 1) : null;
        await page.evaluate("window.map.remove()");
        return { box, lastRow };
      };
      const left = await measure("left");
      const right = await measure("right");
      if (!left.box || !left.lastRow || !right.box || !right.lastRow) fail("multi-line labels did not draw");
      if (Math.abs(left.lastRow[0]! - left.box[0]!) > 2)
        fail(`left justify should line the rows up on the left, got ${left.lastRow} in ${left.box}`);
      if (Math.abs(right.lastRow[2]! - right.box[2]!) > 2)
        fail(`right justify should line the rows up on the right, got ${right.lastRow} in ${right.box}`);
      const tall = await measure("center", { lineHeight: 2.4 });
      const normal = await measure("center");
      if (!tall.box || !normal.box || !(tall.box[3]! - tall.box[1]! > normal.box[3]! - normal.box[1]! + 10))
        fail(`lineHeight 2.4 should spread the rows, got ${tall.box} against ${normal.box}`);
      const rotated = await measure("center", { rotate: 90, maxWidth: 30 });
      if (!rotated.box || !(rotated.box[3]! - rotated.box[1]! > (rotated.box[2]! - rotated.box[0]!) * 2))
        fail(`rotate 90 should stand the label on end, got ${rotated.box}`);

      await createMap(
        page,
        base(
          [
            {
              id: "low",
              type: "symbol",
              source: "g",
              filter: ["==", ["get", "role"], "low"],
              layout: { text: "Under", size: 18 },
            },
            {
              id: "high",
              type: "symbol",
              source: "g",
              filter: ["==", ["get", "role"], "high"],
              layout: { text: "Over", size: 18, ignorePlacement: true },
              paint: { color: "#ff0000", translate: [0, 0] },
            },
          ],
          [point(0, 0, { role: "low" }), point(0.1, 0, { role: "high" })],
        ),
        { zoom: 5, center: [0, 0] },
      );
      const underneath = (await scan(340, 285, 470, 315, DARK)).count;
      if (underneath === 0) fail("a label with ignorePlacement should not push away the label under it");
      await page.evaluate(`void window.map.setPaintProperty("high", "translate", [0, 60])`);
      await idle(page);
      const shifted = (await scan(340, 345, 480, 375, RED_TEXT)).count;
      if (shifted === 0) fail("translate [0, 60] should move the red label 60 px down");
      await page.evaluate("window.map.remove()");

      const road = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: { name: "Long Road" },
                  geometry: {
                    type: "LineString",
                    coordinates: [
                      [-10, 1],
                      [10, 1],
                    ],
                  },
                },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "name",
            type: "symbol",
            source: "g",
            layout: { text: ["get", "name"], placement: "line-center", size: 14, spacing: 60 },
          },
        ],
      });
      await createMap(page, road, { zoom: 5, center: [0, 1] });
      const count = await page.evaluate<number>(
        "window.map.queryRenderedFeatures(undefined, { layers: ['name'] }).then((fs) => fs.length)",
      );
      const onLine = await darkBox(0, 285, 800, 315);
      const elsewhere = await darkBox(0, 0, 800, 270);
      if (count !== 1 || !onLine || elsewhere)
        fail(`line-center should draw a single label on the line, got ${count}, ${onLine} and ${elsewhere}`);
    },
  },
  {
    name: "within filters keep only features inside an area",
    async run({ page }) {
      const area = {
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
      };
      const points = [
        [0, 0],
        [5, 5],
        [-15, 0],
        [15, 3],
      ].map(([lng, lat], i) => ({
        type: "Feature",
        properties: { n: i },
        geometry: { type: "Point", coordinates: [lng, lat] },
      }));
      const style = JSON.stringify({
        version: 1,
        sources: { g: { type: "geojson", data: { type: "FeatureCollection", features: points } } },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "inside",
            type: "circle",
            source: "g",
            filter: ["within", area],
            paint: { radius: 6, color: "#ff0000" },
          },
        ],
      });
      await createMap(page, style, { zoom: 3, center: [0, 0] });
      const at = async (lng: number, lat: number) => {
        const p = await page.evaluate<{ x: number; y: number }>(`window.map.project([${lng}, ${lat}])`);
        return pixel(page, Math.round(p.x), Math.round(p.y));
      };
      if (!near(await at(0, 0), RED, 10) || !near(await at(5, 5), RED, 10))
        fail("points inside the area should be drawn");
      if (!near(await at(-15, 0), WHITE, 10) || !near(await at(15, 3), WHITE, 10))
        fail("points outside the area should be left out");
      const found = await page.evaluate<number[]>(
        `window.map.querySourceFeatures("g", { filter: ["within", ${JSON.stringify(area)}] }).then((fs) => fs.map((f) => f.properties.n).sort())`,
      );
      if (JSON.stringify(found) !== JSON.stringify([0, 1]))
        fail(`querySourceFeatures with within gave ${JSON.stringify(found)}`);
      const issues = await page.evaluate<unknown[]>(
        `maplet.validateStyle({ version: 1, sources: { g: { type: "geojson", data: { type: "FeatureCollection", features: [] } } }, layers: [{ id: "c", type: "circle", source: "g", paint: { radius: ["case", ["within", ${JSON.stringify(area)}], 4, 2] } }] })`,
      );
      if (!JSON.stringify(issues).includes("only works in layer filters"))
        fail(`within outside a filter should be reported, got ${JSON.stringify(issues)}`);
    },
  },
  {
    name: "fullscreen and geolocate controls, and who moved the map",
    async run({ page, base, shot }) {
      await page.evaluate(`(() => {
        window.watchers = [];
        Object.defineProperty(navigator, "geolocation", {
          configurable: true,
          value: {
            getCurrentPosition(ok) { setTimeout(() => ok({ coords: { latitude: 47.6, longitude: -122.33, accuracy: 60 }, timestamp: Date.now() }), 10); },
            watchPosition(ok) { window.watchers.push(ok); setTimeout(() => ok({ coords: { latitude: 47.6, longitude: -122.33, accuracy: 60 }, timestamp: Date.now() }), 10); return 7; },
            clearWatch(id) { window.cleared = id; },
          },
        });
      })()`);
      await createMap(page, rasterStyle(base, "/fixture/raster"), { zoom: 3, center: [0, 0] });
      const sources = await page.evaluate<(string | null)[]>(`(async () => {
        const seen = [];
        const map = window.map;
        const record = (e) => seen.push(e.originalEvent ? e.originalEvent.type : null);
        map.on("movestart", record);
        map.getCanvasContainer().dispatchEvent(new PointerEvent("pointermove", { clientX: 100, clientY: 100, bubbles: true, pointerType: "mouse" }));
        map.easeTo({ center: [10, 0], duration: 0 });
        await map.once("moveend");
        map.off("movestart", record);
        return seen;
      })()`);
      if (JSON.stringify(sources) !== JSON.stringify([null]))
        fail(`a move made in code should have no originalEvent, got ${JSON.stringify(sources)}`);
      await page.evaluate(`(() => {
        window.dragStart = new Promise((resolve) => {
          window.map.once("movestart", (e) => resolve(e.originalEvent ? e.originalEvent.type : null));
        });
      })()`);
      await page.mouse("mouseMoved", 400, 300);
      await page.mouse("mousePressed", 400, 300, { buttons: 1 });
      for (let i = 1; i <= 5; i++) await page.mouse("mouseMoved", 400 + i * 10, 300, { buttons: 1 });
      await page.mouse("mouseReleased", 450, 300, { buttons: 0 });
      const dragType = await page.evaluate<string | null>("window.dragStart");
      if (!dragType?.startsWith("pointer")) fail(`a drag should carry its pointer event, got ${dragType}`);
      await idle(page);

      await page.evaluate(`(() => {
        window.fullscreen = new maplet.FullscreenControl();
        window.geolocate = new maplet.GeolocateControl({ trackUserLocation: true });
        window.geoLog = [];
        for (const type of ["geolocate", "trackuserlocationstart", "trackuserlocationend"]) window.geolocate.on(type, () => window.geoLog.push(type));
        window.map.addControl(window.fullscreen).addControl(window.geolocate);
      })()`);
      await page.evaluate("document.querySelector('.maplet-fullscreen-button').click()");
      await page.waitFor("window.fullscreen.isFullscreen()", 3000);
      const label = await page.evaluate<string | null>(
        "document.querySelector('.maplet-fullscreen-button').getAttribute('aria-label')",
      );
      if (label !== "Exit fullscreen") fail(`the fullscreen button should offer to exit, got ${label}`);
      await page.evaluate("document.querySelector('.maplet-fullscreen-button').click()");
      await page.waitFor("!window.fullscreen.isFullscreen()", 3000);

      await page.evaluate("document.querySelector('.maplet-geolocate-button').click()");
      await page.waitFor("window.geolocate.getState() === 'active'", 3000);
      await idle(page);
      await shot("geolocate");
      const located = await page.evaluate<{
        center: number[];
        zoom: number;
        dot: boolean;
        ring: number;
        state: string;
      }>(`(() => {
        const ring = document.querySelector(".maplet-user-accuracy");
        return {
          center: window.map.getCenter(),
          zoom: window.map.getZoom(),
          dot: !!document.querySelector(".maplet-user-location"),
          ring: ring ? ring.getBoundingClientRect().width : 0,
          state: window.geolocate.getState(),
        };
      })()`);
      if (Math.abs(located.center[0]! + 122.33) > 0.01 || Math.abs(located.center[1]! - 47.6) > 0.01)
        fail(`the map should fly to the reported position, got ${located.center}`);
      if (!located.dot || located.ring < 10)
        fail(`expected the location dot and its accuracy circle, got ${JSON.stringify(located)}`);
      await page.mouse("mouseMoved", 400, 300);
      await page.mouse("mousePressed", 400, 300, { buttons: 1 });
      for (let i = 1; i <= 5; i++) await page.mouse("mouseMoved", 400 + i * 10, 300, { buttons: 1 });
      await page.mouse("mouseReleased", 450, 300, { buttons: 0 });
      await page.waitFor("window.geolocate.getState() === 'background'", 3000);
      await page.evaluate("document.querySelector('.maplet-geolocate-button').click()");
      await page.waitFor("window.geolocate.getState() === 'active'", 3000);
      await page.evaluate("document.querySelector('.maplet-geolocate-button').click()");
      await page.waitFor("window.geolocate.getState() === 'off'", 3000);
      const end = await page.evaluate<{ log: string[]; cleared: unknown; dot: boolean }>(
        "({ log: window.geoLog, cleared: window.cleared, dot: !!document.querySelector('.maplet-user-location') })",
      );
      if (
        end.cleared !== 7 ||
        end.dot ||
        end.log[0] !== "trackuserlocationstart" ||
        end.log.at(-1) !== "trackuserlocationend"
      )
        fail(`turning tracking off should stop the watch and remove the dot, got ${JSON.stringify(end)}`);
    },
  },
  {
    name: "the URL hash, cooperative gestures and the remaining events",
    async run({ page, base }) {
      await page.evaluate(`history.replaceState(null, "", "#5/10/20/30/40")`);
      await createMap(page, rasterStyle(base, "/fixture/raster"), { hash: true });
      const start = await page.evaluate<number[]>(
        "[window.map.getZoom(), ...window.map.getCenter(), window.map.getBearing(), window.map.getPitch()]",
      );
      if (start.some((v, i) => Math.abs(v - [5, 20, 10, 30, 40][i]!) > 1e-6))
        fail(`the map should start where the hash says, got ${start}`);
      await page.evaluate("void window.map.jumpTo({ center: [-122.5, 47.25], zoom: 9, bearing: 0, pitch: 0 })");
      await page.waitFor("location.hash.startsWith('#9/')", 3000);
      const written = await page.evaluate<string>("location.hash");
      if (written !== "#9/47.25/-122.5") fail(`the hash should follow the map, got ${written}`);
      await page.evaluate(`location.hash = "#7/1/2"`);
      await page.waitFor("Math.abs(window.map.getZoom() - 7) < 1e-9", 3000);
      await page.evaluate("window.map.remove()");

      await page.evaluate(`history.replaceState(null, "", "#map=4/1/2&foo=bar")`);
      await createMap(page, rasterStyle(base, "/fixture/raster"), { hash: "map" });
      const named = await page.evaluate<number[]>("[window.map.getZoom(), ...window.map.getCenter()]");
      if (Math.abs(named[0]! - 4) > 1e-9 || Math.abs(named[1]! - 2) > 1e-9 || Math.abs(named[2]! - 1) > 1e-9)
        fail(`a named hash should be read too, got ${named}`);
      await page.evaluate("void window.map.jumpTo({ zoom: 6 })");
      await page.waitFor("location.hash.startsWith('#map=6/')", 3000);
      const kept = await page.evaluate<string>("location.hash");
      if (!kept.endsWith("&foo=bar")) fail(`other hash parameters should be kept, got ${kept}`);
      await page.evaluate(`window.map.remove(); history.replaceState(null, "", location.pathname)`);

      await createMap(page, rasterStyle(base, "/fixture/raster"), { cooperativeGestures: true, zoom: 3 });
      await page.mouse("mouseWheel", 400, 300, { deltaX: 0, deltaY: -100 });
      await page.waitFor("document.querySelector('.maplet-cooperative.maplet-visible') !== null", 3000);
      const notice = await page.evaluate<string>("document.querySelector('.maplet-cooperative').textContent");
      const still = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(still - 3) > 1e-9 || !notice.includes("scroll to zoom"))
        fail(`a plain wheel should not zoom a cooperative map, got zoom ${still} and "${notice}"`);
      await page.mouse("mouseWheel", 400, 300, { deltaX: 0, deltaY: -100, modifiers: 2 });
      await idle(page);
      const zoomed = await page.evaluate<number>("window.map.getZoom()");
      if (!(zoomed > 3.2)) fail(`Ctrl + wheel should zoom a cooperative map, got ${zoomed}`);
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const before = await page.evaluate<number[]>("window.map.getCenter()");
      await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 400, y: 300 }] });
      for (let i = 1; i <= 6; i++) {
        await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 400 + i * 12, y: 300 }] });
      }
      await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await idle(page);
      const after = await page.evaluate<number[]>("window.map.getCenter()");
      const touchNotice = await page.evaluate<string>("document.querySelector('.maplet-cooperative').textContent");
      if (Math.hypot(after[0]! - before[0]!, after[1]! - before[1]!) > 1e-9 || !touchNotice.includes("two fingers"))
        fail(`one finger should not pan a cooperative map, moved to ${after} with "${touchNotice}"`);
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await page.evaluate("window.map.remove()");

      await createMap(page, rasterStyle(base, "/fixture/raster"), { zoom: 3 });
      await page.evaluate(`(() => {
        window.events = [];
        const map = window.map;
        for (const type of ["dragstart", "drag", "dragend", "styledata"]) map.on(type, () => window.events.push(type));
        map.on("data", (e) => window.events.push("data:" + e.dataType));
        map.on("wheel", (e) => { window.events.push("wheel"); e.preventDefault(); });
      })()`);
      await page.mouse("mouseWheel", 400, 300, { deltaX: 0, deltaY: -100 });
      await idle(page);
      const wheelZoom = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(wheelZoom - 3) > 1e-9)
        fail(`preventDefault in a wheel listener should stop the zoom, got ${wheelZoom}`);
      await page.mouse("mouseMoved", 400, 300);
      await page.mouse("mousePressed", 400, 300, { buttons: 1 });
      for (let i = 1; i <= 4; i++) await page.mouse("mouseMoved", 400 + i * 10, 300, { buttons: 1 });
      await page.mouse("mouseReleased", 440, 300, { buttons: 0 });
      await page.evaluate(`void window.map.setPaintProperty("r", "opacity", 0.5)`);
      await page.evaluate("new Promise((r) => setTimeout(r, 50))");
      const events = await page.evaluate<string[]>("window.events");
      const expect = ["wheel", "dragstart", "drag", "dragend", "styledata", "data:style"];
      for (const e of expect) if (!events.includes(e)) fail(`expected a ${e} event, got ${JSON.stringify(events)}`);
      if (events.indexOf("dragstart") > events.indexOf("drag") || events.indexOf("drag") > events.indexOf("dragend"))
        fail(`drag events came out of order: ${JSON.stringify(events)}`);
    },
  },
  {
    name: "debug views draw tile edges, label boxes and padding",
    async run({ page, base, shot }) {
      const style = JSON.stringify({
        version: 1,
        sources: {
          fx: { type: "raster", tiles: [`${base}/fixture/raster/{z}/{x}/{y}.png`], tileSize: 256 },
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                { type: "Feature", properties: { name: "Label" }, geometry: { type: "Point", coordinates: [20, 20] } },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "r", type: "raster", source: "fx", paint: { fadeDuration: 0, opacity: 0.2 } },
          { id: "t", type: "symbol", source: "g", layout: { text: ["get", "name"], size: 18 } },
        ],
      });
      await createMap(page, style, { zoom: 3, center: [0, 0] });
      await page.evaluate(
        "window.map.showTileBoundaries = true; window.map.showCollisionBoxes = true; window.map.showPadding = true",
      );
      await page.evaluate("void window.map.setPadding({ left: 200 })");
      await idle(page);
      await shot("debug");
      const colors = await page.evaluate<{ red: number; blue: number; green: number }>(`(() => {
        const c = document.querySelector(".maplet-debug");
        const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let red = 0, blue = 0, green = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 100) continue;
          if (data[i] > 180 && data[i + 1] < 120) red++;
          else if (data[i + 2] > 180 && data[i] < 120) blue++;
          else if (data[i + 1] > 160 && data[i] < 160 && data[i + 2] < 140) green++;
        }
        return { red, blue, green };
      })()`);
      if (colors.red < 500 || colors.blue < 40 || colors.green < 300)
        fail(`expected tile edges, a label box and the padding frame, got ${JSON.stringify(colors)}`);
      await page.evaluate(
        "window.map.showTileBoundaries = false; window.map.showCollisionBoxes = false; window.map.showPadding = false",
      );
      await idle(page);
      const gone = await page.evaluate<number>("document.querySelectorAll('.maplet-debug').length");
      if (gone !== 0) fail("turning the debug views off should remove their canvas");
    },
  },
  {
    name: "image, canvas and video sources stretch over their corners",
    async run({ page, base, shot }) {
      const square = [
        [-20, 20],
        [20, 20],
        [20, -20],
        [-20, -20],
      ];
      const background = { id: "bg", type: "background", paint: { color: "#ffffff" } };
      const style = JSON.stringify({
        version: 1,
        sources: { pic: { type: "image", url: `${base}/fixture/raster/2/1/1.png`, coordinates: square } },
        layers: [background, { id: "pic", type: "raster", source: "pic" }],
      });
      await createMap(page, style, { zoom: 3, center: [0, 0] });
      await shot("image-source");
      const inside = await pixel(page, 420, 320);
      const outside = await pixel(page, 400, 40);
      if (!isZoomColor(inside, 2)) fail(`the image should cover its corners, got ${inside}`);
      if (!near(outside, WHITE, 6)) fail(`outside its corners the map should be untouched, got ${outside}`);
      await page.evaluate(
        `void window.map.getSource("pic").setCoordinates([[10, 20], [30, 20], [30, -20], [10, -20]])`,
      );
      await idle(page);
      const moved = await pixel(page, 380, 320);
      if (!near(moved, WHITE, 6)) fail(`setCoordinates should move the image away, got ${moved}`);
      const east = await page.evaluate<{ x: number; y: number }>("window.map.project([20, 0])");
      const there = await pixel(page, Math.round(east.x), Math.round(east.y) + 10);
      if (!isZoomColor(there, 2)) fail(`the image should now sit between 10 and 30 degrees east, got ${there}`);
      await page.evaluate("window.map.remove()");

      const tiny = [
        [-122.3302, 47.6001],
        [-122.3298, 47.6001],
        [-122.3298, 47.5999],
        [-122.3302, 47.5999],
      ];
      const close = JSON.stringify({
        version: 1,
        sources: { pic: { type: "image", url: `${base}/fixture/raster/2/1/1.png`, coordinates: tiny } },
        layers: [background, { id: "pic", type: "raster", source: "pic", paint: { resampling: "nearest" } }],
      });
      await createMap(page, close, { zoom: 20, center: [-122.33, 47.6] });
      for (const [corner, dx, dy] of [
        [tiny[0], 1, 1],
        [tiny[2], -1, -1],
      ] as const) {
        const at = await page.evaluate<{ x: number; y: number }>(`window.map.project(${JSON.stringify(corner)})`);
        const into = await pixel(page, Math.round(at.x + dx * 3), Math.round(at.y + dy * 3));
        const away = await pixel(page, Math.round(at.x - dx * 3), Math.round(at.y - dy * 3));
        if (near(into, WHITE, 6) || !near(away, WHITE, 6))
          fail(`at zoom 20 the image edge should sit on its corner ${corner}, got ${into} inside and ${away} outside`);
      }
      await page.evaluate("window.map.remove()");

      const trapezoid = [
        [-10, 15],
        [10, 15],
        [25, -15],
        [-25, -15],
      ];
      await page.evaluate(`(() => {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        const g = c.getContext("2d");
        g.fillStyle = "#ff0000"; g.fillRect(0, 0, 32, 32);
        g.fillStyle = "#00ff00"; g.fillRect(32, 0, 32, 32);
        g.fillStyle = "#0000ff"; g.fillRect(32, 32, 32, 32);
        g.fillStyle = "#ffff00"; g.fillRect(0, 32, 32, 32);
        window.paintCanvas = c;
      })()`);
      await page.evaluate(`(async () => {
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [0, 0], zoom: 3, style: {
          version: 1,
          sources: { live: { type: "canvas", canvas: window.paintCanvas, coordinates: ${JSON.stringify(trapezoid)}, animate: false } },
          layers: [${JSON.stringify(background)}, { id: "live", type: "raster", source: "live" }],
        } });
        await new Promise((resolve) => window.map.once("idle", resolve));
      })()`);
      await shot("canvas-trapezoid");
      const middle = await page.evaluate<{ x: number; y: number }>(`(() => {
        const [a, b, c, d] = ${JSON.stringify(trapezoid)}.map((p) => window.map.project(p));
        const ax = c.x - a.x, ay = c.y - a.y, bx = d.x - b.x, by = d.y - b.y;
        const t = ((b.x - a.x) * by - (b.y - a.y) * bx) / (ax * by - ay * bx);
        return { x: a.x + t * ax, y: a.y + t * ay };
      })()`);
      const YELLOW = [255, 255, 0, 255];
      for (const [dx, dy, color, name] of [
        [-5, -5, RED, "red"],
        [5, -5, GREEN, "green"],
        [5, 5, BLUE, "blue"],
        [-5, 5, YELLOW, "yellow"],
      ] as const) {
        const got = await pixel(page, Math.round(middle.x + dx), Math.round(middle.y + dy));
        if (!near(got, color, 12))
          fail(`the canvas quarters should meet where the diagonals cross, expected ${name} near it but got ${got}`);
      }
      const kept = await page.evaluate<string>("typeof window.map.getStyle().sources.live.canvas");
      if (kept !== "object") fail(`getStyle should hand back the canvas element, got ${kept}`);
      const center = await page.evaluate<{ x: number; y: number }>("window.map.project([0, -10])");
      const cx = Math.round(center.x);
      const cy = Math.round(center.y);
      await page.evaluate(`(() => {
        window.map.getSource("live").play();
        const g = window.paintCanvas.getContext("2d");
        g.fillStyle = "#0000ff";
        g.fillRect(0, 0, 64, 64);
      })()`);
      await page.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
      const playing = await pixel(page, cx, cy);
      if (!near(playing, BLUE, 12)) fail(`a playing canvas source should follow the canvas, got ${playing}`);
      await page.evaluate(`(() => {
        window.map.getSource("live").pause();
        window.map.once("render", () => {
          const g = window.paintCanvas.getContext("2d");
          g.fillStyle = "#ff0000";
          g.fillRect(0, 0, 64, 64);
        });
      })()`);
      await page.evaluate("new Promise((resolve) => setTimeout(resolve, 300))");
      const paused = await pixel(page, cx, cy);
      if (!near(paused, BLUE, 12)) fail(`a paused canvas source should keep its last picture, got ${paused}`);
      await page.evaluate("window.map.remove()");

      const recorded = await page.evaluate<string>(`(async () => {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        const g = c.getContext("2d");
        const recorder = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm" });
        const parts = [];
        recorder.ondataavailable = (e) => parts.push(e.data);
        const stopped = new Promise((resolve) => (recorder.onstop = resolve));
        recorder.start();
        for (let i = 0; i < 12; i++) {
          g.fillStyle = i % 2 ? "#0000ff" : "#ff0000";
          g.fillRect(0, 0, 64, 64);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        recorder.stop();
        await stopped;
        return URL.createObjectURL(new Blob(parts, { type: "video/webm" }));
      })()`);
      const film = JSON.stringify({
        version: 1,
        sources: {
          film: { type: "video", urls: [`${base}/fixture/missing.webm`, recorded], coordinates: square },
        },
        layers: [background, { id: "film", type: "raster", source: "film" }],
      });
      await createMap(page, film, { zoom: 3, center: [0, 0] });
      const seen = await page.evaluate<{ red: number; blue: number }>(`(async () => {
        const seen = { red: 0, blue: 0 };
        const end = performance.now() + 1200;
        while (performance.now() < end) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const [r, g, b] = window.pixel(400, 300);
          if (r > 170 && g < 90 && b < 90) seen.red++;
          if (b > 170 && r < 90 && g < 90) seen.blue++;
        }
        return seen;
      })()`);
      if (seen.red === 0 || seen.blue === 0)
        fail(`a playing video source should show its frames as they change, saw ${JSON.stringify(seen)}`);
      const isVideo = await page.evaluate<boolean>(
        `window.map.getSource("film").getVideo() instanceof HTMLVideoElement`,
      );
      if (!isVideo) fail("getVideo should return the video element");
      await page.evaluate(`window.map.getSource("film").pause()`);
      await page.evaluate("new Promise((resolve) => setTimeout(resolve, 200))");
      const still = await page.evaluate<number[][]>(`(async () => {
        const out = [];
        for (let i = 0; i < 4; i++) {
          out.push(window.pixel(400, 300));
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return out;
      })()`);
      if (still.some((p) => !near(p as RGBA, still[0] as RGBA, 4)))
        fail(`a paused video should hold its frame, got ${JSON.stringify(still)}`);
      await page.evaluate("window.map.remove()");

      const other = base.includes("127.0.0.1")
        ? base.replace("127.0.0.1", "localhost")
        : base.replace("localhost", "127.0.0.1");
      const tainted = await page.evaluate<{ errors: string[]; background: number[] }>(`(async () => {
        const img = new Image();
        img.src = "${other}/fixture/raster/3/1/1.png";
        await img.decode();
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        c.getContext("2d").drawImage(img, 0, 0, 64, 64);
        const errors = [];
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [0, 0], zoom: 3, style: {
          version: 1,
          sources: { foreign: { type: "canvas", canvas: c, coordinates: ${JSON.stringify(square)} } },
          layers: [${JSON.stringify(background)}, { id: "foreign", type: "raster", source: "foreign" }],
        } });
        window.map.on("error", (e) => errors.push(e.error.message));
        await new Promise((resolve) => window.map.once("load", resolve));
        for (let i = 0; i < 10; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
        return { errors, background: window.pixel(400, 40) };
      })()`);
      if (tainted.errors.length !== 1 || !tainted.errors[0]!.includes("CORS"))
        fail(`a canvas the map may not read should be reported once, got ${JSON.stringify(tainted.errors)}`);
      if (!near(tainted.background as RGBA, WHITE, 6))
        fail(`the rest of the map should still draw, got ${tainted.background}`);
      await page.evaluate("window.map.remove()");

      const small = [
        [1, -1],
        [3, -1],
        [3, -3],
        [1, -3],
      ];
      await page.evaluate(`(async () => {
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [2, -2], zoom: 6, pitch: 60, style: {
          version: 1,
          sources: {
            dem: { type: "dem", tiles: ["${base}/fixture/dem/{z}/{x}/{y}.png"], tileSize: 256, maxZoom: 12 },
            pic: { type: "image", url: "${base}/fixture/raster/2/1/1.png", coordinates: ${JSON.stringify(square)} },
            live: { type: "canvas", canvas: window.paintCanvas, coordinates: ${JSON.stringify(small)}, animate: true },
          },
          layers: [
            ${JSON.stringify(background)},
            { id: "pic", type: "raster", source: "pic" },
            { id: "live", type: "raster", source: "live" },
          ],
          terrain: { source: "dem" },
        } });
        await new Promise((resolve) => window.map.once("load", resolve));
        await new Promise((resolve) => setTimeout(resolve, 1500));
      })()`);
      await shot("overlays-on-terrain");
      const draped = await pixel(page, 150, 330);
      if (!isZoomColor(draped, 2)) fail(`the image should drape over terrain, got ${draped}`);
      const live = await pixel(page, 400, 300);
      if (!near(live, RED, 16)) fail(`the canvas should drape over terrain too, got ${live}`);
      const counts = await page.evaluate<{ tiles: number; redrawn: number[] }>(`(async () => {
        const redrawn = [];
        const end = performance.now() + 400;
        while (performance.now() < end) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          redrawn.push(window.map.getDiagnostics().terrain.redrawn);
        }
        return { tiles: window.map.getDiagnostics().terrain.tiles, redrawn };
      })()`);
      const most = Math.max(...counts.redrawn);
      if (most === 0 || most > 4 || counts.tiles <= 6)
        fail(`an animated overlay should only redraw the terrain tiles under it, got ${JSON.stringify(counts)}`);
    },
  },
  {
    name: "setStyle keeps the sources and layers that didn't change",
    async run({ page, base }) {
      const polygon = (size: number) => ({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 1,
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-size, -size],
                  [size, -size],
                  [size, size],
                  [-size, size],
                  [-size, -size],
                ],
              ],
            },
          },
        ],
      });
      const raster = { type: "raster", tiles: [`${base}/fixture/raster/{z}/{x}/{y}.png`], tileSize: 256 };
      const first = {
        version: 1,
        sources: { fx: raster, g: { type: "geojson", data: polygon(10) } },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "r", type: "raster", source: "fx", paint: { fadeDuration: 0 } },
          { id: "f", type: "fill", source: "g", paint: { color: "#ff0000" } },
        ],
      };
      await createMap(page, JSON.stringify(first), { zoom: 3, center: [0, 0] });
      await page.evaluate(`(() => {
        window.loads = 0;
        window.map.on("styleload", () => window.loads++);
        window.before = { fx: window.map.getSource("fx"), g: window.map.getSource("g") };
        window.map.setFeatureState({ source: "g", id: 1 }, { picked: true });
      })()`);
      const rasterHits = async () => {
        const hits = (await (await fetch(`${base}/fixture/stats`)).json()) as Record<string, number>;
        return Object.keys(hits).filter((k) => k.startsWith("raster:")).length;
      };
      const restyle = async (style: unknown, options = "{}") => {
        await fetch(`${base}/fixture/reset`);
        await page.evaluate(`void window.map.setStyle(${JSON.stringify(style)}, ${options})`);
        await idle(page);
      };

      const recolored = {
        ...first,
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "r", type: "raster", source: "fx", paint: { fadeDuration: 0, opacity: 0.5 } },
          { id: "f", type: "fill", source: "g", paint: { color: "#0000ff" } },
        ],
      };
      await restyle(recolored);
      if ((await rasterHits()) !== 0) fail("changing paint should not load any tiles again");
      const blue = await pixel(page, 400, 300);
      if (!near(blue, BLUE, 6)) fail(`the fill should turn blue in place, got ${blue}`);
      const kept = await page.evaluate<{ same: boolean; picked: unknown; style: string; loads: number }>(`(() => ({
        same: window.map.getSource("fx") === window.before.fx && window.map.getSource("g") === window.before.g,
        picked: window.map.getFeatureState({ source: "g", id: 1 }).picked,
        style: JSON.stringify(window.map.getStyle()),
        loads: window.loads,
      }))()`);
      if (!kept.same) fail("unchanged sources should be kept, not created again");
      if (kept.picked !== true) fail(`feature state on a kept source should survive, got ${kept.picked}`);
      if (kept.style !== JSON.stringify(recolored))
        fail(`getStyle should return the new style exactly, got ${kept.style}`);
      if (kept.loads !== 1) fail(`styleload should fire once after the update, got ${kept.loads}`);

      const reordered = {
        ...first,
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "f2", type: "fill", source: "g", paint: { color: "#00ff00" } },
          { id: "r", type: "raster", source: "fx", paint: { fadeDuration: 0, opacity: 0.5 } },
        ],
      };
      await restyle(reordered);
      const ids = await page.evaluate<string[]>("window.map.getLayerIds()");
      if (ids.join() !== "bg,f2,r") fail(`layers should be added, removed and moved to match, got ${ids}`);
      if ((await rasterHits()) !== 0) fail("reordering layers should not load any tiles again");

      const reshaped = {
        ...first,
        sources: { fx: raster, g: { type: "geojson", data: polygon(5) } },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "r", type: "raster", source: "fx", paint: { fadeDuration: 0 } },
          { id: "f2", type: "fill", source: "g", paint: { color: "#00ff00" } },
        ],
      };
      await restyle(reshaped);
      const edge = await page.evaluate<{ x: number; y: number }>("window.map.project([7.5, 2.5])");
      const outside = await pixel(page, Math.round(edge.x), Math.round(edge.y));
      const green = await pixel(page, 400, 300);
      if (!isZoomColor(outside, 4) || !near(green, GREEN, 6))
        fail(`new GeoJSON data should replace the old shape, got ${outside} outside and ${green} inside`);
      const adopted = await page.evaluate<boolean>(`window.map.getSource("g") === window.before.g`);
      if (!adopted) fail("a GeoJSON source whose data changed should take the new data, not be created again");
      if ((await rasterHits()) !== 0) fail("new GeoJSON data should not reload the raster tiles");

      const resized = { ...reshaped, sources: { fx: { ...raster, tileSize: 512 }, g: reshaped.sources.g } };
      await restyle(resized);
      const replaced = await page.evaluate<boolean>(`window.map.getSource("fx") !== window.before.fx`);
      if (!replaced || (await rasterHits()) === 0) fail("a source whose tiles changed should be loaded again");

      await page.evaluate(`window.errors = []`);
      await page.evaluate(
        `void window.map.setStyle({ version: 1, sources: {}, layers: [{ id: "x", type: "fill", source: "missing" }] })`,
      );
      const invalid = await page.evaluate<{ codes: string[]; ids: string[] }>(
        "({ codes: window.errors.map((e) => e.code), ids: window.map.getLayerIds() })",
      );
      if (!invalid.codes.includes("invalid-style") || invalid.ids.join() !== "bg,r,f2")
        fail(`an invalid style should be reported and leave the map as it was, got ${JSON.stringify(invalid)}`);

      await restyle(resized, "{ diff: false }");
      const rebuilt = await page.evaluate<{ fresh: boolean; picked: unknown }>(`({
        fresh: window.map.getSource("g") !== window.before.g,
        picked: window.map.getFeatureState({ source: "g", id: 1 }).picked,
      })`);
      if (!rebuilt.fresh || rebuilt.picked !== undefined || (await rasterHits()) === 0)
        fail(`diff: false should build everything again, got ${JSON.stringify(rebuilt)}`);
    },
  },
  {
    name: "paint changes ease over the transition the style asks for",
    async run({ page, base, shot }) {
      const square = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
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
        ],
      };
      const style = {
        version: 1,
        transition: { duration: 400 },
        sources: { g: { type: "geojson", data: square } },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "f", type: "fill", source: "g", paint: { color: "#ff0000" } },
        ],
      };
      await createMap(page, JSON.stringify(style), { zoom: 3, center: [0, 0] });
      const fade = await framesDuring(page, `window.map.setPaintProperty("bg", "color", "#000000")`, 40, 40, 700);
      const greys = fade.map((p) => p[0]);
      const between = greys.filter((g) => g > 10 && g < 245).length;
      if (greys[0]! < 215 || greys[greys.length - 1]! > 2 || between < 2)
        fail(`the background should fade from white to black, got ${greys.join(" ")}`);
      if (greys.some((g, i) => i > 0 && g > greys[i - 1]! + 2))
        fail(`the fade should only go one way, got ${greys.join(" ")}`);

      const driven = await framesDuring(
        page,
        `window.map.setPaintProperty("f", "color", ["coalesce", ["get", "missing"], "#0000ff"])`,
        400,
        300,
        700,
      );
      const blended = driven.filter((p) => p[0] > 10 && p[0] < 245 && p[2] > 10 && p[2] < 245).length;
      if (blended < 2 || !near(driven[driven.length - 1]!, BLUE, 6))
        fail(
          `colors that depend on the feature should fade too, got ${driven.map((p) => `${p[0]}/${p[2]}`).join(" ")}`,
        );
      await page.evaluate(`(() => {
        window.map.setPaintProperty("f", "colorTransition", { duration: 0 });
        window.map.setPaintProperty("f", "color", "#00ff00");
      })()`);
      await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const own = await pixel(page, 400, 300);
      if (!near(own, GREEN, 6)) fail(`a property's own transition should win over the style's, got ${own}`);
      const kept = await page.evaluate<unknown>(`window.map.getPaintProperty("f", "colorTransition")`);
      if (JSON.stringify(kept) !== '{"duration":0}')
        fail(`getPaintProperty should return the transition, got ${JSON.stringify(kept)}`);

      const next = {
        ...style,
        layers: [{ id: "bg", type: "background", paint: { color: "#ffffff" } }, style.layers[1]],
      };
      const themed = await framesDuring(page, `void window.map.setStyle(${JSON.stringify(next)})`, 40, 40, 700);
      const lights = themed.map((p) => p[0]);
      if (lights[0]! > 40 || lights[lights.length - 1]! < 253 || lights.filter((g) => g > 10 && g < 245).length < 2)
        fail(`switching styles should fade the colors that changed, got ${lights.join(" ")}`);

      await page.evaluate("window.map.remove()");
      const draped = {
        ...style,
        sources: {
          ...style.sources,
          dem: { type: "dem", tiles: [`${base}/fixture/dem/{z}/{x}/{y}.png`], tileSize: 256, maxZoom: 12 },
        },
        terrain: { source: "dem" },
      };
      await createMap(page, JSON.stringify(draped), { zoom: 3, center: [0, 0], pitch: 30 });
      const reds = await framesDuring(page, `window.map.setPaintProperty("f", "color", "#0000ff")`, 400, 300, 700);
      const mixed = reds.filter((p) => p[0] > 10 && p[0] < 245 && p[2] > 10 && p[2] < 245).length;
      const last = reds[reds.length - 1]!;
      await shot("transition-terrain");
      if (mixed < 2 || !near(last, BLUE, 8))
        fail(`a fill draped on terrain should fade too, got ${reds.map((p) => `${p[0]}/${p[2]}`).join(" ")}`);

      await page.evaluate("window.map.remove()");
      const labelled = {
        version: 1,
        transition: { duration: 400 },
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                { type: "Feature", properties: { name: "WWW" }, geometry: { type: "Point", coordinates: [0, 0] } },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "t",
            type: "symbol",
            source: "g",
            layout: { text: ["get", "name"], size: 56, weight: "bold", allowOverlap: true },
            paint: { color: "#ff0000" },
          },
        ],
      };
      await createMap(page, JSON.stringify(labelled), { zoom: 3, center: [0, 0] });
      const ink = await page.evaluate<[number, number] | null>(`(() => {
        const gl = window.map.getCanvas().getContext("webgl2");
        const px = new Uint8Array(400 * 200 * 4);
        gl.readPixels(200, gl.drawingBufferHeight - 400, 400, 200, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 245 && px[i + 1] < 10 && px[i + 2] < 10) {
            const k = i / 4;
            return [200 + (k % 400), 399 - Math.floor(k / 400)];
          }
        }
        return null;
      })()`);
      if (!ink) fail("the label should be drawn in red");
      const [ix, iy] = ink!;
      const inks = await framesDuring(page, `window.map.setPaintProperty("t", "color", "#0000ff")`, ix, iy, 700);
      const purple = inks.filter((p) => p[0] > 10 && p[0] < 245 && p[2] > 10 && p[2] < 245).length;
      if (purple < 2 || !near(inks[inks.length - 1]!, BLUE, 12))
        fail(`label colors should fade too, got ${inks.map((p) => `${p[0]}/${p[2]}`).join(" ")}`);
    },
  },
  {
    name: "styles written for MapLibre and Mapbox load as they are",
    async run({ page, base, shot }) {
      const v8 = {
        version: 8,
        sources: {
          v: { type: "vector", tiles: [`${base}/fixture/vector/{z}/{x}/{y}.pbf`], maxzoom: 6 },
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#ffffff" } },
          {
            id: "areas",
            type: "fill",
            source: "v",
            "source-layer": "areas",
            filter: ["==", "$type", "Polygon"],
            paint: {
              "fill-color": { property: "z", type: "categorical", stops: [[3, "#00ff00"]], default: "#ff0000" },
              "fill-opacity": {
                stops: [
                  [0, 1],
                  [22, 1],
                ],
              },
            },
          },
          { id: "stars", type: "sky" },
          { id: "marsh", type: "fill", source: "v", "source-layer": "areas", paint: { "fill-pattern": "marsh" } },
          { id: "rails", type: "line", source: "v", "source-layer": "areas", paint: { "line-pattern": "rail" } },
        ],
      };
      const result = await page.evaluate<{ skipped: string[]; version: number; ids: string[] }>(`(async () => {
        window.map = new maplet.Map({ container: "map", style: null, preserveDrawingBuffer: true, fadeDuration: 0, center: [10, 10], zoom: 3 });
        const loaded = new Promise((resolve) => window.map.once("styleload", resolve));
        window.map.setStyle(${JSON.stringify(v8)});
        const event = await loaded;
        await new Promise((resolve) => window.map.once("idle", resolve));
        const style = window.map.getStyle();
        return { skipped: event.skipped, version: style.version, ids: style.layers.map((l) => l.id) };
      })()`);
      await shot("v8-style");
      const green = await pixel(page, 400, 300);
      if (!near(green, GREEN, 6)) fail(`a v8 style should draw with its own colors, got ${green}`);
      if (result.version !== 1 || result.ids.join() !== "bg,areas,marsh")
        fail(
          `the style should come through as a Maplet style without the parts it can't draw, got ${JSON.stringify(result)}`,
        );
      if (!result.skipped.some((s) => s.includes("sky")) || !result.skipped.some((s) => s.includes("pattern")))
        fail(`styleload should list what was left out, got ${JSON.stringify(result.skipped)}`);
      await page.evaluate("window.map.remove()");

      const fallback = {
        version: 8,
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#123456" } }],
      };
      const first = await page.evaluate<{
        requested: string[][];
        zoom: number;
        lat: number;
        lng: number;
      }>(`(async () => {
        const requested = [];
        const data = "data:application/json," + encodeURIComponent(${JSON.stringify(JSON.stringify(fallback))});
        window.map = new maplet.Map({
          container: "map",
          preserveDrawingBuffer: true,
          transformRequest: (url, kind) => {
            requested.push([url, kind]);
            return kind === "style" ? { url: data } : undefined;
          },
        });
        await new Promise((resolve) => window.map.once("idle", resolve));
        const [lng, lat] = window.map.getCenter();
        return { requested, zoom: window.map.getZoom(), lat, lng };
      })()`);
      const fallbackColor = await pixel(page, 400, 300);
      if (
        first.requested[0]?.[0] !== "https://tiles.openfreemap.org/styles/liberty" ||
        first.requested[0]?.[1] !== "style"
      )
        fail(`a map without a style should load OpenFreeMap Liberty, asked for ${JSON.stringify(first.requested)}`);
      if (!near(fallbackColor, [0x12, 0x34, 0x56, 255], 3))
        fail(`the default style should be drawn, got ${fallbackColor}`);
      if (
        Math.abs(first.zoom - Math.log2(800 / 512)) > 0.01 ||
        Math.abs(first.lat - 24.2) > 0.5 ||
        Math.abs(first.lng) > 1e-9
      )
        fail(`a first map should show the whole world, got zoom ${first.zoom} at ${first.lng}, ${first.lat}`);
      await page.evaluate("window.map.remove()");

      const blank = await page.evaluate<{ style: unknown; asked: number }>(`(async () => {
        let asked = 0;
        window.map = new maplet.Map({ container: "map", style: null, transformRequest: () => { asked++; return undefined; } });
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { style: window.map.getStyle(), asked };
      })()`);
      if (blank.style !== null || blank.asked !== 0)
        fail(`style: null should leave the map empty, got ${JSON.stringify(blank)}`);
    },
  },
  {
    name: "symbol layout follows expressions the way v8 styles use them",
    async run({ page, shot }) {
      const red = (x0: number, y0: number, x1: number, y1: number) =>
        page.evaluate<number[] | null>(`(() => {
          const gl = window.map.getCanvas().getContext("webgl2");
          const w = ${x1 - x0}, h = ${y1 - y0};
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(${x0}, gl.drawingBufferHeight - ${y1}, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const i = (row * w + col) * 4;
              if (px[i] > 150 && px[i + 1] < 110 && px[i + 2] < 110) {
                const x = ${x0} + col, y = ${y1} - 1 - row;
                a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y);
              }
            }
          }
          return Number.isFinite(a) ? [a, b, c, d] : null;
        })()`);
      const feature = (geometry: unknown, properties: Record<string, unknown>) => ({
        type: "Feature",
        properties,
        geometry,
      });
      const style = {
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                feature(
                  {
                    type: "LineString",
                    coordinates: [
                      [3, 3],
                      [20, 19],
                    ],
                  },
                  { name: "WWWWWW", kind: "road" },
                ),
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "t",
            type: "symbol",
            source: "g",
            layout: {
              text: ["get", "name"],
              size: 26,
              allowOverlap: true,
              spacing: 5000,
              placement: ["step", ["zoom"], "point", 4, "line"],
            },
            paint: { color: "#ff0000" },
          },
        ],
      };
      await createMap(page, JSON.stringify(style), { zoom: 3.5, center: [11.5, 11] });
      const flat = await red(0, 0, 800, 600);
      await page.evaluate("void window.map.jumpTo({ zoom: 4.5 })");
      await idle(page);
      await shot("placement-line");
      const along = await red(0, 0, 800, 600);
      const aspect = (box: number[] | null) => (box ? (box[2]! - box[0]! + 1) / (box[3]! - box[1]! + 1) : 0);
      if (aspect(flat) < 2.5) fail(`below zoom 4 the label should sit flat as a point label, got ${flat}`);
      if (aspect(along) > 2 || aspect(along) < 0.5)
        fail(`from zoom 4 the label should run along the line, got ${along}`);
      await page.evaluate(`void window.map.setLayoutProperty("t", "rotationAlignment", "viewport")`);
      await idle(page);
      await shot("viewport-alignment");
      const upright = await red(0, 0, 800, 600);
      if (aspect(upright) < 2.5) fail(`viewport alignment should keep line placed text upright, got ${upright}`);
      await page.evaluate("window.map.remove()");

      const points = {
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                feature({ type: "Point", coordinates: [-30, 0] }, { name: "XX", side: "left" }),
                feature({ type: "Point", coordinates: [30, 0] }, { name: "XX", side: "right" }),
                feature({ type: "Point", coordinates: [0, 25] }, { name: "AAA", lines: 1 }),
                feature({ type: "Point", coordinates: [0, -25] }, { name: "AAA\nBBB", lines: 2 }),
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "t",
            type: "symbol",
            source: "g",
            layout: {
              text: ["get", "name"],
              size: 24,
              allowOverlap: true,
              anchor: ["match", ["get", "side"], "left", "left", "right", "right", "center"],
            },
            paint: { color: "#ff0000" },
          },
        ],
      };
      await createMap(page, JSON.stringify(points), { zoom: 2, center: [0, 0] });
      await shot("anchors-and-lines");
      const west = await page.evaluate<{ x: number; y: number }>("window.map.project([-30, 0])");
      const east = await page.evaluate<{ x: number; y: number }>("window.map.project([30, 0])");
      const north = await page.evaluate<{ x: number; y: number }>("window.map.project([0, 25])");
      const south = await page.evaluate<{ x: number; y: number }>("window.map.project([0, -25])");
      const left = await red(
        Math.round(west.x) - 80,
        Math.round(west.y) - 30,
        Math.round(west.x) + 80,
        Math.round(west.y) + 30,
      );
      const right = await red(
        Math.round(east.x) - 80,
        Math.round(east.y) - 30,
        Math.round(east.x) + 80,
        Math.round(east.y) + 30,
      );
      if (!left || left[0]! < west.x - 3)
        fail(`anchor left should put the text right of its point, got ${left} for ${west.x}`);
      if (!right || right[2]! > east.x + 3)
        fail(`anchor right should put the text left of its point, got ${right} for ${east.x}`);
      const one = await red(
        Math.round(north.x) - 80,
        Math.round(north.y) - 60,
        Math.round(north.x) + 80,
        Math.round(north.y) + 60,
      );
      const two = await red(
        Math.round(south.x) - 80,
        Math.round(south.y) - 60,
        Math.round(south.x) + 80,
        Math.round(south.y) + 60,
      );
      const height = (box: number[] | null) => (box ? box[3]! - box[1]! + 1 : 0);
      if (height(two) < height(one) * 1.8)
        fail(`a line break should start a second line, got ${height(two)} against ${height(one)}`);
    },
  },
  {
    name: "pattern fills repeat an image fixed to the map",
    async run({ page, shot }) {
      const style = {
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: {
                    type: "Polygon",
                    coordinates: [
                      [
                        [-170, -80],
                        [170, -80],
                        [170, 80],
                        [-170, 80],
                        [-170, -80],
                      ],
                    ],
                  },
                },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          { id: "f", type: "fill", source: "g", paint: { pattern: "stripes", color: "#00ff00" } },
        ],
      };
      await page.evaluate(`(async () => {
        const data = new Uint8Array(8 * 8 * 4);
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) data.set(x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 8 + x) * 4);
        }
        window.stripes = { width: 8, height: 8, data };
        window.missing = [];
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [0, 0], zoom: 3, style: ${JSON.stringify(style)} });
        window.map.on("styleimagemissing", (e) => window.missing.push(e.id));
        window.map.addImage("stripes", window.stripes);
        await new Promise((resolve) => window.map.once("idle", resolve));
      })()`);
      await shot("stripes");
      const row = (y: number) =>
        page.evaluate<string>(`(() => {
          let out = "";
          for (let x = 380; x < 420; x++) {
            const [r, , b] = window.pixel(x, ${y});
            out += r + b < 200 ? "?" : r > b ? "r" : "b";
          }
          return out;
        })()`);
      const stripes = await row(300);
      const runs = stripes.match(/r+|b+|\?+/g) ?? [];
      const inner = runs.slice(1, -1);
      if (stripes.includes("?") || inner.length < 6 || inner.some((r) => r.length !== 4))
        fail(`the pattern should repeat in 4 pixel stripes, got ${stripes}`);
      const shifted = async (dx: number) => {
        const target = await page.evaluate<number[]>(`window.map.unproject([400 + ${dx}, 300])`);
        await page.evaluate(`void window.map.jumpTo({ center: ${JSON.stringify(target)} })`);
        await idle(page);
        return row(300);
      };
      const period = await shifted(8);
      if (period !== stripes)
        fail(`moving the map one period should show the same stripes, got ${period} against ${stripes}`);
      const half = await shifted(4);
      const flipped = stripes.replace(/r/g, "x").replace(/b/g, "r").replace(/x/g, "b");
      if (half !== flipped)
        fail(`moving the map half a period should swap the stripes, got ${half} against ${flipped}`);
      await page.evaluate("void window.map.jumpTo({ center: [-122.33, 47.6], zoom: 18 })");
      await idle(page);
      const close = await row(300);
      const closeRuns = (close.match(/r+|b+|\?+/g) ?? []).slice(1, -1);
      if (close.includes("?") || closeRuns.length < 6 || closeRuns.some((r) => r.length !== 4))
        fail(`at zoom 18 the stripes should stay 4 pixels wide, got ${close}`);
      await page.evaluate(`void window.map.setPaintProperty("f", "pattern", "nothing-here")`);
      await idle(page);
      const missing = await page.evaluate<string[]>("window.missing");
      if (!missing.includes("nothing-here"))
        fail(`a missing pattern image should be reported, got ${JSON.stringify(missing)}`);
    },
  },
  {
    name: "labels use the style's own fonts from its glyph server",
    async run({ page, base, shot }) {
      const style = {
        version: 1,
        glyphs: `${base}/fixture/glyphs/{fontstack}/{range}.pbf`,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                { type: "Feature", properties: { name: "WW" }, geometry: { type: "Point", coordinates: [0, 8] } },
                { type: "Feature", properties: { name: "ZZ" }, geometry: { type: "Point", coordinates: [0, -8] } },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "t",
            type: "symbol",
            source: "g",
            layout: { text: ["get", "name"], font: ["Block Regular"], size: 24, allowOverlap: true },
            paint: { color: "#ff0000" },
          },
        ],
      };
      await fetch(`${base}/fixture/reset`);
      await createMap(page, JSON.stringify(style), { zoom: 3, center: [0, 0] });
      await shot("server-glyphs");
      const red = (x0: number, y0: number, x1: number, y1: number) =>
        page.evaluate<{ box: number[] | null; count: number }>(`(() => {
          const gl = window.map.getCanvas().getContext("webgl2");
          const w = ${x1 - x0}, h = ${y1 - y0};
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(${x0}, gl.drawingBufferHeight - ${y1}, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, count = 0;
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const i = (row * w + col) * 4;
              if (px[i] > 200 && px[i + 1] < 80 && px[i + 2] < 80) {
                count++;
                const x = ${x0} + col, y = ${y1} - 1 - row;
                a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y);
              }
            }
          }
          return { box: Number.isFinite(a) ? [a, b, c, d] : null, count };
        })()`);
      const top = await page.evaluate<{ x: number; y: number }>("window.map.project([0, 8])");
      const bottom = await page.evaluate<{ x: number; y: number }>("window.map.project([0, -8])");
      const blocks = await red(
        Math.round(top.x) - 60,
        Math.round(top.y) - 30,
        Math.round(top.x) + 60,
        Math.round(top.y) + 30,
      );
      const letters = await red(
        Math.round(bottom.x) - 60,
        Math.round(bottom.y) - 30,
        Math.round(bottom.x) + 60,
        Math.round(bottom.y) + 30,
      );
      const fill = (r: { box: number[] | null; count: number }) =>
        r.box ? r.count / ((r.box[2]! - r.box[0]! + 1) * (r.box[3]! - r.box[1]! + 1)) : 0;
      if (!blocks.box || fill(blocks) < 0.8)
        fail(
          `"WW" should be drawn with the server's solid square glyphs by the time the map is idle, got ${JSON.stringify(blocks)}`,
        );
      if (!letters.box || fill(letters) > 0.7)
        fail(`"ZZ" isn't on the server, so it should fall back to the device font, got ${JSON.stringify(letters)}`);
      const hits = (await (await fetch(`${base}/fixture/stats`)).json()) as Record<string, number>;
      if (hits["glyphs:Block Regular/0"] !== 1)
        fail(`the glyph range should be asked for once, got ${JSON.stringify(hits)}`);
    },
  },
  {
    name: "line labels lie on the ground when the map is tilted",
    async run({ page, shot }) {
      const style = (alignment: string) => ({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: { name: "HHHHHH" },
                  geometry: {
                    type: "LineString",
                    coordinates: [
                      [-4, 0],
                      [4, 0],
                    ],
                  },
                },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "t",
            type: "symbol",
            source: "g",
            layout: {
              text: ["get", "name"],
              size: 28,
              placement: "line",
              allowOverlap: true,
              pitchAlignment: alignment,
              spacing: 5000,
            },
            paint: { color: "#ff0000" },
          },
        ],
      });
      const height = async () =>
        page.evaluate<number>(`(() => {
          const gl = window.map.getCanvas().getContext("webgl2");
          const px = new Uint8Array(800 * 600 * 4);
          gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let top = Infinity, bottom = -Infinity;
          for (let y = 0; y < 600; y++) {
            for (let x = 0; x < 800; x++) {
              const i = (y * 800 + x) * 4;
              if (px[i] > 200 && px[i + 1] < 90 && px[i + 2] < 90) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
            }
          }
          return Number.isFinite(top) ? bottom - top + 1 : 0;
        })()`);
      const measure = async (alignment: string, pitch: number) => {
        await createMap(page, JSON.stringify(style(alignment)), { zoom: 5, center: [0, 0], pitch });
        const h = await height();
        await shot(`${alignment}-${pitch}`);
        await page.evaluate("window.map.remove()");
        return h;
      };
      const flatGround = await measure("map", 0);
      const flatUpright = await measure("viewport", 0);
      const tiltedGround = await measure("map", 60);
      const tiltedUpright = await measure("viewport", 60);
      if (!flatGround || Math.abs(flatGround - flatUpright) > 2)
        fail(`without tilt both alignments should look the same, got ${flatGround} and ${flatUpright} pixels high`);
      if (!tiltedGround || tiltedGround > tiltedUpright * 0.75)
        fail(`tilted, text on the ground should be squashed, got ${tiltedGround} against ${tiltedUpright} pixels high`);
    },
  },
  {
    name: "icons stretch to fit their text and keep their corners",
    async run({ page, shot }) {
      const style = {
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                { type: "Feature", properties: { name: "MM" }, geometry: { type: "Point", coordinates: [0, 10] } },
                {
                  type: "Feature",
                  properties: { name: "MMMMMMMM" },
                  geometry: { type: "Point", coordinates: [0, -10] },
                },
              ],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "t",
            type: "symbol",
            source: "g",
            layout: {
              text: ["get", "name"],
              size: 20,
              icon: "shield",
              iconTextFit: "both",
              iconTextFitPadding: [2, 4, 2, 4],
              allowOverlap: true,
              iconAllowOverlap: true,
            },
            paint: { color: "#ff0000" },
          },
        ],
      };
      await page.evaluate(`(async () => {
        const data = new Uint8Array(12 * 12 * 4);
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 12; x++) {
            const edge = x < 3 || y < 3 || x >= 9 || y >= 9;
            data.set(edge ? [0, 0, 255, 255] : [0, 255, 0, 255], (y * 12 + x) * 4);
          }
        }
        window.map = new maplet.Map({ container: "map", preserveDrawingBuffer: true, fadeDuration: 0, center: [0, 0], zoom: 3, style: ${JSON.stringify(style)} });
        window.map.addImage("shield", { width: 12, height: 12, data }, { stretchX: [[3, 9]], stretchY: [[3, 9]], content: [3, 3, 9, 9] });
        await new Promise((resolve) => window.map.once("idle", resolve));
      })()`);
      await shot("fitted-icons");
      const scan = (cx: number, cy: number) =>
        page.evaluate<{ green: number[] | null; red: number[] | null; blueLeft: number }>(`(() => {
          const gl = window.map.getCanvas().getContext("webgl2");
          const x0 = ${cx} - 150, y0 = ${cy} - 40, w = 300, h = 80;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(x0, gl.drawingBufferHeight - (y0 + h), w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const box = () => [Infinity, Infinity, -Infinity, -Infinity];
          const green = box(), red = box();
          const add = (b, x, y) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const i = (row * w + col) * 4;
              const r = px[i], g = px[i + 1], b = px[i + 2];
              const x = x0 + col, y = y0 + h - 1 - row;
              if (g > 200 && r < 60 && b < 60) add(green, x, y);
              if (r > 200 && g < 80 && b < 80) add(red, x, y);
            }
          }
          let blueLeft = 0;
          if (Number.isFinite(green[0])) {
            const y = Math.round((green[1] + green[3]) / 2);
            const row = y0 + h - 1 - y;
            for (let col = 0; col < w; col++) {
              const i = (row * w + col) * 4;
              if (px[i + 2] > 200 && px[i] < 60 && px[i + 1] < 60) blueLeft++;
              else if (blueLeft > 0) break;
            }
          }
          const ok = (b) => (Number.isFinite(b[0]) ? b : null);
          return { green: ok(green), red: ok(red), blueLeft };
        })()`);
      const short = await page.evaluate<{ x: number; y: number }>("window.map.project([0, 10])");
      const long = await page.evaluate<{ x: number; y: number }>("window.map.project([0, -10])");
      const a = await scan(Math.round(short.x), Math.round(short.y));
      const b = await scan(Math.round(long.x), Math.round(long.y));
      for (const [name, r] of [
        ["MM", a],
        ["MMMMMMMM", b],
      ] as const) {
        if (!r.green || !r.red) fail(`the ${name} label should have its icon and text, got ${JSON.stringify(r)}`);
        const inside =
          r.green![0]! <= r.red![0]! &&
          r.green![2]! >= r.red![2]! &&
          r.green![1]! <= r.red![1]! &&
          r.green![3]! >= r.red![3]!;
        if (!inside) fail(`the icon's content area should wrap the ${name} text, got ${JSON.stringify(r)}`);
        if (r.blueLeft < 2 || r.blueLeft > 4)
          fail(`the icon's border should stay 3 pixels wide, got ${r.blueLeft} for ${name}`);
      }
      const widthA = a.green![2]! - a.green![0]!;
      const widthB = b.green![2]! - b.green![0]!;
      const textA = a.red![2]! - a.red![0]!;
      const textB = b.red![2]! - b.red![0]!;
      if (Math.abs(widthB - widthA - (textB - textA)) > 6)
        fail(`the icon should grow with its text, got icons ${widthA} and ${widthB} for text ${textA} and ${textB}`);
    },
  },
  {
    name: "a building's parts replace the outline drawn around them",
    async run({ page, shot }) {
      const box = (half: number, color: string, height: number) => ({
        type: "Feature",
        properties: { color, height },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-half, -half],
              [half, -half],
              [half, half],
              [-half, half],
              [-half, -half],
            ],
          ],
        },
      });
      const style = JSON.stringify({
        version: 1,
        sources: {
          g: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [box(0.0005, "#ff0000", 200), box(0.0005, "#0000ff", 20), box(0.0001, "#0000ff", 180)],
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ffffff" } },
          {
            id: "b",
            type: "extrusion",
            source: "g",
            layout: { hideOutlines: true },
            paint: { color: ["get", "color"], height: ["get", "height"] },
          },
        ],
      });
      const count = () =>
        page.evaluate<{ red: number; blue: number }>(`(() => {
          const gl = window.map.getCanvas().getContext("webgl2");
          const px = new Uint8Array(800 * 600 * 4);
          gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let red = 0, blue = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > 90 && px[i + 1] < 40 && px[i + 2] < 40) red++;
            if (px[i + 2] > 90 && px[i] < 40 && px[i + 1] < 40) blue++;
          }
          return { red, blue };
        })()`);
      await createMap(page, style, { zoom: 16, pitch: 55 });
      await shot("parts");
      const parts = await count();
      if (parts.red > 0) fail(`the outline should be left out, found ${parts.red} of its pixels`);
      if (parts.blue < 2000) fail(`the parts should be drawn, found ${parts.blue} pixels of them`);
      await page.evaluate(`void window.map.setLayoutProperty("b", "hideOutlines", false)`);
      await idle(page);
      await shot("outline");
      const outline = await count();
      if (outline.red < 2000) fail(`with hideOutlines off the outline should be drawn, found ${outline.red} pixels`);
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`map reported errors: ${JSON.stringify(errors)}`);
    },
  },
  {
    name: "the map always fills the screen, with no empty bands past the poles",
    async run({ page, shot }) {
      const style = JSON.stringify({
        version: 1,
        sources: {
          w: {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [-180, -85.06],
                    [180, -85.06],
                    [180, 85.06],
                    [-180, 85.06],
                    [-180, -85.06],
                  ],
                ],
              },
            },
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { color: "#ff00ff" } },
          { id: "w", type: "fill", source: "w", paint: { color: "#00aa00" } },
        ],
      });
      await page.evaluate(`(() => {
        const el = document.getElementById("map");
        el.style.inset = "auto";
        el.style.left = "0px";
        el.style.top = "0px";
        el.style.width = "300px";
        el.style.height = "580px";
      })()`);
      await createMap(page, style, { zoom: -2, center: [0, 0] });
      const blank = () =>
        page.evaluate<number>(`(() => {
          const gl = window.map.getCanvas().getContext("webgl2");
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let n = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 60 && px[i + 2] > 200) n++;
          return n;
        })()`);
      const move = async (camera: Record<string, unknown>) => {
        await page.evaluate(`void window.map.jumpTo(${JSON.stringify(camera)})`);
        await idle(page);
      };
      await shot("zoomed-out");
      const zoom = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(zoom - Math.log2(580 / 512)) > 1e-6)
        fail(`zooming out should stop where the world fills the height, got zoom ${zoom}`);
      if ((await blank()) > 0) fail("zoomed all the way out, the map should still fill the screen");
      const buttons = await page.evaluate<boolean[]>(`(() => {
        window.map.addControl(new maplet.NavigationControl());
        return [...document.querySelectorAll(".maplet-navigation button")].slice(0, 2).map((b) => b.disabled);
      })()`);
      if (buttons[0] !== false || buttons[1] !== true)
        fail(`at the world limit only zoom out should be disabled, got ${JSON.stringify(buttons)}`);
      for (const lat of [89, -89]) {
        await move({ center: [0, lat], zoom: 1.5 });
        const left = await blank();
        if (left > 0) fail(`panned to latitude ${lat}, ${left} pixels showed past the world`);
      }
      await shot("at-the-pole");
      await move({ center: [0, 0], zoom: -2, bearing: 45 });
      await shot("rotated");
      const rotated = await blank();
      if (rotated > 0) fail(`rotated and zoomed out, ${rotated} pixels showed past the world`);
      await move({ bearing: 0, zoom: -2 });
      await move({ center: [-122.33, 47.6], zoom: 12 });
      const [lng, lat] = await page.evaluate<[number, number]>("window.map.getCenter()");
      if (Math.abs(lng + 122.33) > 1e-6 || Math.abs(lat - 47.6) > 1e-6)
        fail(`jumping from the zoomed-out world to Seattle should land there, got ${lng}, ${lat}`);
      const errors = await page.evaluate<unknown[]>("window.errors");
      if (errors.length > 0) fail(`map reported errors: ${JSON.stringify(errors)}`);
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
        const map = new maplet.Map({ container: "map", style: null });
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
