import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "../../scripts/build.ts";
import { startServer } from "../../scripts/server.ts";
import type { Page } from "./cdp.ts";
import { Browser } from "./cdp.ts";
import { fixtureRoute } from "./fixtures.ts";
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
  return near(actual, c) || near(actual, c.map((v) => Math.round(v * 0.9)));
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

async function idle(page: Page): Promise<void> {
  await page.evaluate(`new Promise((resolve) => { if (window.map.loaded() && !window.map.isMoving()) { window.map.triggerRepaint(); } window.map.once("idle", resolve); window.map.triggerRepaint(); })`);
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
      await page.evaluate("window.map.jumpTo({ zoom: 4 })");
      await new Promise((r) => setTimeout(r, 400));
      await shot("fallback-pending");
      for (const [x, y] of [[100, 100], [700, 100], [400, 300], [100, 500], [700, 500]] as const) {
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
      await page.evaluate("window.map.jumpTo({ zoom: 4 })");
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
      if (Math.abs(lng - expected) > 0.3 || Math.abs(lat) > 0.3) fail(`expected centre near ${expected},0 after drag, got ${lng},${lat}`);
      const anchor = await page.evaluate<[number, number]>("window.map.unproject([600, 200])");
      await page.mouse("mouseWheel", 600, 200, { deltaX: 0, deltaY: -100 });
      await idle(page);
      await shot("after-wheel");
      const zoom = await page.evaluate<number>("window.map.getZoom()");
      if (Math.abs(zoom - 3.5) > 0.05) fail(`expected zoom 3.5 after one wheel notch, got ${zoom}`);
      const moved = await page.evaluate<{ x: number; y: number }>(`window.map.project(${JSON.stringify(anchor)})`);
      if (Math.hypot(moved.x - 600, moved.y - 200) > 1) fail(`wheel zoom moved the point under the cursor to ${moved.x},${moved.y}`);
    },
  },
  {
    name: "pitch and bearing keep the view covered",
    async run({ page, base, shot }) {
      await createMap(page, rasterStyle(base, "/fixture/raster"), { zoom: 4 });
      await page.evaluate("window.map.jumpTo({ pitch: 60, bearing: 30 })");
      await idle(page);
      await shot("pitched");
      const d = await page.evaluate<{ blankRatio: number }>("window.map.getDiagnostics()");
      if (d.blankRatio > 0) fail(`blank ratio ${d.blankRatio} after load at pitch 60`);
      for (const [x, y] of [[20, 20], [780, 20], [400, 300], [20, 580], [780, 580]] as const) {
        const c = await pixel(page, x, y);
        if (near(c, [255, 255, 255], 3)) fail(`blank pixel at ${x},${y} at pitch 60`);
      }
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
      if (!first || first.code !== "invalid-style") fail(`expected invalid-style error, got ${JSON.stringify(errors)}`);
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
        for (const entry of page.console.filter((c) => c.type === "error" || c.type === "warning")) console.log(`     console.${entry.type}: ${entry.text}`);
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
