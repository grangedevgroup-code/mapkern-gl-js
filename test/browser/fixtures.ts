import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Route } from "../../scripts/server.ts";
import { fixtureTile } from "./png.ts";

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
