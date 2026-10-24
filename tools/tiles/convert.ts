import { closeSync, openSync, readSync } from "node:fs";
import type { ByteRanges } from "../../src/formats/sqlite.ts";
import { MBTilesArchive } from "../../src/sources/mbtiles.ts";
import { Compression, PMTilesWriter, TileType } from "./pmtiles-writer.ts";

class FileRanges implements ByteRanges {
  private readonly fd: number;

  constructor(path: string) {
    this.fd = openSync(path, "r");
  }

  async read(offset: number, length: number): Promise<{ data: Uint8Array }> {
    const buffer = Buffer.alloc(length);
    const n = readSync(this.fd, buffer, 0, length, offset);
    return { data: new Uint8Array(buffer.buffer, buffer.byteOffset, n) };
  }

  close(): void {
    closeSync(this.fd);
  }
}

const TYPES: Record<string, number> = {
  pbf: TileType.mvt,
  mvt: TileType.mvt,
  png: TileType.png,
  jpg: TileType.jpeg,
  jpeg: TileType.jpeg,
  webp: TileType.webp,
  avif: TileType.avif,
};

export async function convertMbtiles(
  input: string,
  output: string,
  log: (message: string) => void = () => {},
): Promise<{ tiles: number; bytes: number }> {
  const ranges = new FileRanges(input);
  try {
    const archive = new MBTilesArchive(ranges, input);
    const signal = new AbortController().signal;
    const meta = await archive.metadata(signal);
    const writer = new PMTilesWriter();
    let minZoom = 99;
    let maxZoom = 0;
    let gzipped = 0;
    let plain = 0;
    let started = performance.now();
    await archive.forEachTile((z, x, y, data) => {
      writer.add(z, x, y, data);
      minZoom = Math.min(minZoom, z);
      maxZoom = Math.max(maxZoom, z);
      if (data[0] === 0x1f && data[1] === 0x8b) gzipped++;
      else plain++;
      if (performance.now() - started > 10000) {
        started = performance.now();
        log(`  ${writer.count.toLocaleString()} tiles read`);
      }
    }, signal);
    if (writer.count === 0) throw new Error(`${input} has no tiles`);
    const format = (meta.format ?? "").toLowerCase();
    const tileType = TYPES[format] ?? (gzipped > 0 ? TileType.mvt : TileType.unknown);
    const bounds = (meta.bounds ?? "-180,-85.0511,180,85.0511").split(",").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const center = (meta.center ?? "").split(",").map(Number);
    const metadata: Record<string, unknown> = {};
    for (const key of ["name", "description", "attribution", "version", "type"]) {
      if (meta[key]) metadata[key] = meta[key];
    }
    if (meta.json) {
      try {
        Object.assign(metadata, JSON.parse(meta.json));
      } catch {
        log("warning: the metadata json field is not valid JSON and was left out");
      }
    }
    for (const [key, actual] of [
      ["minzoom", minZoom],
      ["maxzoom", maxZoom],
    ] as const) {
      const stated = meta[key];
      if (stated !== undefined && stated !== "" && Number(stated) !== actual) {
        log(`warning: the metadata says ${key} ${stated} but the tiles go to ${actual}; using ${actual}`);
      }
    }
    const tiles = writer.count;
    const result = writer.write(output, {
      tileType,
      tileCompression: gzipped > 0 && plain === 0 ? Compression.gzip : Compression.none,
      minZoom,
      maxZoom,
      bounds: bounds.length === 4 && bounds.every(Number.isFinite) ? bounds : [-180, -85.0511, 180, 85.0511],
      center:
        center.length >= 2 && center.every(Number.isFinite)
          ? [center[0]!, center[1]!, center[2] ?? Math.floor((minZoom + maxZoom) / 2)]
          : [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, minZoom],
      metadata,
    });
    if (gzipped > 0 && plain > 0)
      log("warning: some tiles are gzipped and some are not; the archive says they are not");
    return { tiles, bytes: result.bytes };
  } finally {
    ranges.close();
  }
}
