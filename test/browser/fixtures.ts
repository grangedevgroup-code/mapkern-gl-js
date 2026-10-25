import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Route } from "../../scripts/server.ts";
import { EARTH_CIRCUMFERENCE, mercatorX, mercatorY } from "../../src/geo/mercator.ts";
import { encodeTile } from "../../tools/tiles/mvt-writer.ts";
import { BLOCK_FONT, glyphRange } from "./glyph-pbf.ts";
import { encodePng, fixtureTile } from "./png.ts";

const cache = new Map<string, Buffer>();
const hits = new Map<string, number>();

function tile(z: number, x: number, y: number): Buffer {
  const key = `${z}/${x}/${y}`;
  let png = cache.get(key);
  if (!png) {
    png = fixtureTile(z, x, y);
    cache.set(key, png);
  }
  return png;
}

export const HILL: [number, number] = [3, 2];
const HILL_X = mercatorX(HILL[0]);
const HILL_Y = mercatorY(HILL[1]);
const HOLE = 0.53;

export function demHeight(X: number, Y: number): number | null {
  if ((X > HOLE && Y > HOLE) || X >= 0.75) return null;
  const dx = (X - HILL_X) * EARTH_CIRCUMFERENCE;
  const dy = (Y - HILL_Y) * EARTH_CIRCUMFERENCE;
  return 6000 * Math.exp(-(dx * dx + dy * dy) / 1e10);
}

const demCache = new Map<string, Buffer>();

function demTile(z: number, x: number, y: number, size = 256): Buffer {
  const key = `${z}/${x}/${y}`;
  const cached = demCache.get(key);
  if (cached) return cached;
  const n = 2 ** z;
  const rgba = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h = demHeight((x + (i + 0.5) / size) / n, (y + (j + 0.5) / size) / n);
      if (h === null) continue;
      const v = h + 32768;
      const whole = Math.floor(v);
      const o = (j * size + i) * 4;
      rgba[o] = whole >> 8;
      rgba[o + 1] = whole & 255;
      rgba[o + 2] = Math.floor((v - whole) * 256);
      rgba[o + 3] = 255;
    }
  }
  const png = encodePng(size, size, rgba);
  demCache.set(key, png);
  return png;
}

export function square(size: number, color: string): unknown {
  const ring = [
    [-size, -size],
    [size, -size],
    [size, size],
    [-size, size],
    [-size, -size],
  ];
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { color }, geometry: { type: "Polygon", coordinates: [ring] } }],
  };
}

export const fixtureRoute: Route = async (req, res, url) => {
  const path = url.pathname;
  if (path === "/fixture/stats") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(Object.fromEntries(hits)));
    return true;
  }
  if (path === "/fixture/reset") {
    hits.clear();
    res.writeHead(204);
    res.end();
    return true;
  }
  const glyphs = /^\/fixture\/glyphs\/([^/]+)\/(\d+)-(\d+)\.pbf$/.exec(path);
  if (glyphs) {
    const stack = decodeURIComponent(glyphs[1]!);
    const start = Number(glyphs[2]);
    hits.set(`glyphs:${stack}/${start}`, (hits.get(`glyphs:${stack}/${start}`) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 250));
    if (!stack.startsWith("Block") || start !== 0) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(200, { "content-type": "application/x-protobuf", "cache-control": "no-store" });
    res.end(Buffer.from(glyphRange(stack, start, BLOCK_FONT)));
    return true;
  }
  const vector = /^\/fixture\/vector\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(path);
  if (vector) {
    const [z, x, y] = [Number(vector[1]), Number(vector[2]), Number(vector[3])];
    const square = Int32Array.of(0, 0, 4096, 0, 4096, 4096, 0, 4096, 0, 0);
    const body = encodeTile([
      {
        name: "areas",
        extent: 4096,
        features: [{ id: 1000 + z, type: 3, parts: [square], props: { name: `tile ${z}/${x}/${y}`, z } }],
      },
    ]);
    res.writeHead(200, { "content-type": "application/x-protobuf", "cache-control": "no-store" });
    res.end(Buffer.from(body));
    return true;
  }
  const dem = /^\/fixture\/dem\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
  if (dem) {
    const [z, x, y] = [Number(dem[1]), Number(dem[2]), Number(dem[3])];
    hits.set(`dem:${z}/${x}/${y}`, (hits.get(`dem:${z}/${x}/${y}`) ?? 0) + 1);
    if (z > 12 || x >= 2 ** z || y >= 2 ** z || (z > 0 && x / 2 ** z >= 0.75)) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(demTile(z, x, y));
    return true;
  }
  if (path === "/fixture/sprite.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        green: { x: 0, y: 0, width: 16, height: 16, pixelRatio: 1 },
        magenta: { x: 16, y: 0, width: 16, height: 16, pixelRatio: 1 },
      }),
    );
    return true;
  }
  if (path === "/fixture/sprite.png") {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(spriteSheet());
    return true;
  }
  if (path === "/fixture/formats/places.kml") {
    res.writeHead(200, { "content-type": "application/vnd.google-earth.kml+xml", "cache-control": "no-store" });
    res.end(
      '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>West</name><Point><coordinates>-10,0</coordinates></Point></Placemark></Document></kml>',
    );
    return true;
  }
  if (path === "/fixture/geojson/square.json") {
    res.writeHead(200, { "content-type": "application/geo+json", "cache-control": "no-store" });
    res.end(JSON.stringify(square(10, "#0000ff")));
    return true;
  }
  const m = /^\/fixture\/(raster|slow\/(\d+)\/(\d+)|fail\/(\d+)\/(\d+))\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
  if (!m) return false;
  const z = Number(m[6]);
  const x = Number(m[7]);
  const y = Number(m[8]);
  const key = `${m[1]}:${z}/${x}/${y}`;
  hits.set(key, (hits.get(key) ?? 0) + 1);
  if (z > 22 || x >= 2 ** z || y >= 2 ** z) {
    res.writeHead(404);
    res.end();
    return true;
  }
  if (m[2] !== undefined && z >= Number(m[3])) {
    await new Promise((r) => setTimeout(r, Number(m[2])));
  }
  if (m[4] !== undefined && z >= Number(m[5])) {
    res.writeHead(Number(m[4]), { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("fixture failure");
    return true;
  }
  if (req.destroyed) return true;
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(tile(z, x, y));
  return true;
};

export function writeMbtilesFixture(path: string, maxZoom = 5): void {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE metadata (name text, value text)");
  db.exec("CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)");
  db.exec("CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row)");
  const meta = db.prepare("INSERT INTO metadata VALUES (?, ?)");
  meta.run("name", "Fixture");
  meta.run("format", "png");
  meta.run("minzoom", "0");
  meta.run("maxzoom", String(maxZoom));
  const insert = db.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  for (let z = 0; z <= maxZoom; z++) {
    const n = 2 ** z;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) insert.run(z, x, n - 1 - y, tile(z, x, y));
    }
  }
  db.exec("COMMIT");
  db.close();
}

function spriteSheet(): Buffer {
  const rgba = new Uint8Array(32 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4;
      const green = x < 16;
      rgba[i] = green ? 0 : 255;
      rgba[i + 1] = green ? 255 : 0;
      rgba[i + 2] = green ? 0 : 255;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(32, 16, rgba);
}
