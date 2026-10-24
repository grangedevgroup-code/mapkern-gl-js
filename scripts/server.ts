import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

export type Route = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

export interface ServerOptions {
  root: string;
  port?: number;
  host?: string;
  routes?: Route[];
  quiet?: boolean;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pbf": "application/x-protobuf",
  ".mvt": "application/vnd.mapbox-vector-tile",
  ".pmtiles": "application/octet-stream",
  ".mbtiles": "application/octet-stream",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".kml": "application/vnd.google-earth.kml+xml",
  ".kmz": "application/vnd.google-earth.kmz",
  ".gpx": "application/gpx+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export function startServer(options: ServerOptions): Promise<{ server: Server; url: string }> {
  const root = resolve(options.root);
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const route of options.routes ?? []) {
      if (await route(req, res, url)) return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      if (!pathname.endsWith("/")) {
        res.writeHead(301, { location: `${pathname}/` });
        res.end();
        return;
      }
      file = join(file, "index.html");
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const headers: Record<string, string> = {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === "" && m[2] === "")) {
        res.writeHead(416, { "content-range": `bytes */${info.size}` });
        res.end();
        return;
      }
      let start = m[1] === "" ? info.size - Number(m[2]) : Number(m[1]);
      let end = m[1] === "" || m[2] === "" ? info.size - 1 : Number(m[2]);
      start = Math.max(0, start);
      end = Math.min(info.size - 1, end);
      if (start > end || start >= info.size) {
        res.writeHead(416, { "content-range": `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) });
      if (req.method === "HEAD") res.end();
      else createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(info.size) });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  }
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const url = `http://${options.host ?? "127.0.0.1"}:${port}`;
      if (!options.quiet) console.log(`Serving ${root} at ${url}`);
      resolvePromise({ server, url });
    });
  });
}
