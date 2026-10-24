import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Entry, Header } from "../../src/formats/pmtiles.ts";
import { Compression, HEADER_SIZE, ROOT_LIMIT, TileType, encodeDirectory, tileId, writeHeader } from "../../src/formats/pmtiles.ts";

export interface ArchiveInfo {
  tileType: number;
  tileCompression: number;
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
  center: [number, number, number];
  metadata: Record<string, unknown>;
}

interface Stored {
  id: number;
  hash: string;
  data: Uint8Array;
}

export class PMTilesWriter {
  private readonly tiles: Stored[] = [];
  private bytes = 0;

  get count(): number {
    return this.tiles.length;
  }

  get size(): number {
    return this.bytes;
  }

  add(z: number, x: number, y: number, data: Uint8Array): void {
    const hash = createHash("sha256").update(data).digest("base64");
    this.tiles.push({ id: tileId(z, x, y), hash, data });
    this.bytes += data.length;
  }

  write(path: string, info: ArchiveInfo): { entries: number; contents: number; bytes: number; leaves: number } {
    const sorted = [...this.tiles].sort((a, b) => a.id - b.id);
    const entries: Entry[] = [];
    const contents = new Map<string, { offset: number; length: number }>();
    const chunks: Uint8Array[] = [];
    let dataLength = 0;
    for (const t of sorted) {
      let content = contents.get(t.hash);
      if (!content) {
        content = { offset: dataLength, length: t.data.length };
        contents.set(t.hash, content);
        chunks.push(t.data);
        dataLength += t.data.length;
      }
      const last = entries[entries.length - 1];
      if (last && last.offset === content.offset && last.tileId + last.runLength === t.id) {
        last.runLength++;
      } else {
        entries.push({ tileId: t.id, offset: content.offset, length: content.length, runLength: 1 });
      }
    }
    const { root, leaves } = buildDirectories(entries);
    const metadata = gzipSync(Buffer.from(JSON.stringify(info.metadata)), { level: 9 });
    const rootOffset = HEADER_SIZE;
    const metadataOffset = rootOffset + root.length;
    const leafOffset = metadataOffset + metadata.length;
    const dataOffset = leafOffset + leaves.length;
    const addressed = entries.reduce((s, e) => s + e.runLength, 0);
    const header: Header = {
      rootOffset,
      rootLength: root.length,
      metadataOffset,
      metadataLength: metadata.length,
      leafOffset,
      leafLength: leaves.length,
      dataOffset,
      dataLength,
      addressedTiles: addressed,
      tileEntries: entries.length,
      tileContents: contents.size,
      clustered: true,
      internalCompression: Compression.gzip,
      tileCompression: info.tileCompression,
      tileType: info.tileType,
      minZoom: info.minZoom,
      maxZoom: info.maxZoom,
      minLon: info.bounds[0],
      minLat: info.bounds[1],
      maxLon: info.bounds[2],
      maxLat: info.bounds[3],
      centerZoom: info.center[2],
      centerLon: info.center[0],
      centerLat: info.center[1],
    };
    const fd = openSync(path, "w");
    try {
      writeSync(fd, writeHeader(header));
      writeSync(fd, root);
      writeSync(fd, metadata);
      if (leaves.length > 0) writeSync(fd, leaves);
      for (const c of chunks) writeSync(fd, c);
    } finally {
      closeSync(fd);
    }
    return { entries: entries.length, contents: contents.size, bytes: dataOffset + dataLength, leaves: leaves.length };
  }
}

function buildDirectories(entries: Entry[]): { root: Uint8Array; leaves: Uint8Array } {
  const limit = ROOT_LIMIT - HEADER_SIZE;
  const whole = gzipSync(encodeDirectory(entries), { level: 9 });
  if (whole.length <= limit) return { root: whole, leaves: new Uint8Array(0) };
  for (let leafSize = 4096; ; leafSize *= 2) {
    const leafChunks: Uint8Array[] = [];
    const rootEntries: Entry[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const slice = entries.slice(i, i + leafSize);
      const compressed = gzipSync(encodeDirectory(slice), { level: 9 });
      rootEntries.push({ tileId: slice[0]!.tileId, offset, length: compressed.length, runLength: 0 });
      leafChunks.push(compressed);
      offset += compressed.length;
    }
    const root = gzipSync(encodeDirectory(rootEntries), { level: 9 });
    if (root.length <= limit) {
      const leaves = new Uint8Array(offset);
      let o = 0;
      for (const c of leafChunks) {
        leaves.set(c, o);
        o += c.length;
      }
      return { root, leaves };
    }
  }
}

export { Compression, TileType };
