import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Entry, Header } from "../../src/formats/pmtiles.ts";
import {
  Compression,
  encodeDirectory,
  HEADER_SIZE,
  ROOT_LIMIT,
  TileType,
  tileId,
  writeHeader,
} from "../../src/formats/pmtiles.ts";

export interface ArchiveInfo {
  tileType: number;
  tileCompression: number;
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
  center: [number, number, number];
  metadata: Record<string, unknown>;
}

export class PMTilesWriter {
  private readonly dir: string;
  private readonly fd: number;
  private spooled = 0;
  private bytes = 0;
  private ids: number[] = [];
  private refs: number[] = [];
  private readonly offsets: number[] = [];
  private readonly lengths: number[] = [];
  private readonly byHash = new Map<string, number>();

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "maplet-pmtiles-"));
    this.fd = openSync(join(this.dir, "tiles.bin"), "w+");
  }

  get count(): number {
    return this.ids.length;
  }

  get size(): number {
    return this.bytes;
  }

  add(z: number, x: number, y: number, data: Uint8Array): void {
    const hash = createHash("sha256").update(data).digest("base64");
    let ref = this.byHash.get(hash);
    if (ref === undefined) {
      writeSync(this.fd, data, 0, data.length, this.spooled);
      ref = this.offsets.length;
      this.offsets.push(this.spooled);
      this.lengths.push(data.length);
      this.byHash.set(hash, ref);
      this.spooled += data.length;
    }
    this.ids.push(tileId(z, x, y));
    this.refs.push(ref);
    this.bytes += data.length;
  }

  write(path: string, info: ArchiveInfo): { entries: number; contents: number; bytes: number; leaves: number } {
    try {
      return this.finish(path, info);
    } finally {
      closeSync(this.fd);
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  private finish(path: string, info: ArchiveInfo): { entries: number; contents: number; bytes: number; leaves: number } {
    const order = this.ids.map((_, i) => i).sort((a, b) => this.ids[a]! - this.ids[b]!);
    const placed = new Float64Array(this.offsets.length).fill(-1);
    const sequence: number[] = [];
    const entries: Entry[] = [];
    let dataLength = 0;
    for (const i of order) {
      const ref = this.refs[i]!;
      if (placed[ref]! < 0) {
        placed[ref] = dataLength;
        dataLength += this.lengths[ref]!;
        sequence.push(ref);
      }
      const id = this.ids[i]!;
      const offset = placed[ref]!;
      const last = entries[entries.length - 1];
      if (last && last.tileId === id) continue;
      if (last && last.offset === offset && last.tileId + last.runLength === id) {
        last.runLength++;
      } else {
        entries.push({ tileId: id, offset, length: this.lengths[ref]!, runLength: 1 });
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
      tileContents: sequence.length,
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
    const out = openSync(path, "w");
    try {
      writeSync(out, writeHeader(header));
      writeSync(out, root);
      writeSync(out, metadata);
      if (leaves.length > 0) writeSync(out, leaves);
      let buffer = Buffer.alloc(1 << 20);
      for (const ref of sequence) {
        const length = this.lengths[ref]!;
        if (length > buffer.length) buffer = Buffer.alloc(length);
        readSync(this.fd, buffer, 0, length, this.offsets[ref]!);
        writeSync(out, buffer, 0, length);
      }
    } finally {
      closeSync(out);
    }
    this.ids = [];
    this.refs = [];
    return { entries: entries.length, contents: sequence.length, bytes: dataOffset + dataLength, leaves: leaves.length };
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
