import type { TileFeature } from "./features.ts";
import type { Rect } from "./geometry.ts";
import { clipLine, clipRing, signedArea, simplify } from "./geometry.ts";
import type { EncodedFeature, EncodedLayer } from "./mvt-writer.ts";
import { encodeTile } from "./mvt-writer.ts";
import { LAYERS } from "./schema.ts";

export interface TilerOptions {
  minZoom: number;
  maxZoom: number;
  extent: number;
  maxZoomExtent: number;
  buffer: number;
  bounds: Rect;
  onTile(z: number, x: number, y: number, data: Uint8Array): void;
  log?: (message: string) => void;
}

export interface TilerStats {
  tiles: number;
  bytes: number;
  maxTileBytes: number;
  maxTile: string;
  byZoom: number[];
}

const LAYER_ORDER = new Map<string, number>(LAYERS.map((l, i) => [l, i]));

export function buildTiles(features: TileFeature[], options: TilerOptions): TilerStats {
  const stats: TilerStats = {
    tiles: 0,
    bytes: 0,
    maxTileBytes: 0,
    maxTile: "",
    byZoom: new Array(options.maxZoom + 1).fill(0),
  };
  const started = performance.now();
  let lastLog = started;
  const visit = (z: number, x: number, y: number, feats: TileFeature[]) => {
    if (z >= options.minZoom) {
      const data = encode(z, x, y, feats, options);
      if (data) {
        options.onTile(z, x, y, data);
        stats.tiles++;
        stats.bytes += data.length;
        stats.byZoom[z]!++;
        if (data.length > stats.maxTileBytes) {
          stats.maxTileBytes = data.length;
          stats.maxTile = `${z}/${x}/${y}`;
        }
      }
      const now = performance.now();
      if (options.log && now - lastLog > 10000) {
        lastLog = now;
        options.log(
          `  tiles: ${stats.tiles.toLocaleString()} written, at ${z}/${x}/${y}, ${((now - started) / 1000).toFixed(0)} s`,
        );
      }
    }
    if (z >= options.maxZoom) return;
    const n = 2 ** (z + 1);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = x * 2 + dx;
        const cy = y * 2 + dy;
        const tile: Rect = { x0: cx / n, y0: cy / n, x1: (cx + 1) / n, y1: (cy + 1) / n };
        if (
          tile.x1 < options.bounds.x0 ||
          tile.x0 > options.bounds.x1 ||
          tile.y1 < options.bounds.y0 ||
          tile.y0 > options.bounds.y1
        )
          continue;
        const pad = options.buffer / options.extent / n;
        const buffered: Rect = { x0: tile.x0 - pad, y0: tile.y0 - pad, x1: tile.x1 + pad, y1: tile.y1 + pad };
        const child = clipFeatures(feats, tile, buffered);
        if (child.length > 0) visit(z + 1, cx, cy, child);
      }
    }
  };
  visit(0, 0, 0, features);
  return stats;
}

function clipFeatures(feats: TileFeature[], tile: Rect, buffered: Rect): TileFeature[] {
  const out: TileFeature[] = [];
  for (const f of feats) {
    const b = f.bbox;
    if (f.type === 1) {
      const p = f.parts[0]!;
      const x = p[0]!;
      const y = p[1]!;
      if (x >= tile.x0 && x < tile.x1 && y >= tile.y0 && y < tile.y1) out.push(f);
      continue;
    }
    if (b.x1 < buffered.x0 || b.x0 > buffered.x1 || b.y1 < buffered.y0 || b.y0 > buffered.y1) continue;
    if (b.x0 >= buffered.x0 && b.x1 <= buffered.x1 && b.y0 >= buffered.y0 && b.y1 <= buffered.y1) {
      out.push(f);
      continue;
    }
    const parts: Float64Array[] = [];
    if (f.type === 2) {
      for (const p of f.parts) parts.push(...clipLine(p, buffered));
    } else {
      let keepHoles = false;
      for (const ring of f.parts) {
        const outer = signedArea(ring) > 0;
        const c = clipRing(ring, buffered);
        if (outer) {
          keepHoles = c !== null;
          if (c) parts.push(c);
        } else if (keepHoles && c) {
          parts.push(c);
        }
      }
    }
    if (parts.length === 0) continue;
    out.push({ ...f, parts, bbox: boundsOf(parts) });
  }
  return out;
}

function boundsOf(parts: Float64Array[]): Rect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i]!;
      const y = p[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

function encode(z: number, x: number, y: number, feats: TileFeature[], options: TilerOptions): Uint8Array | null {
  const extent = z === options.maxZoom ? options.maxZoomExtent : options.extent;
  const scale = 2 ** z * extent;
  const ox = x * extent;
  const oy = y * extent;
  const tolerance = z === options.maxZoom ? 1 : (extent / 512) * 0.4;
  const layers = new Map<string, EncodedFeature[]>();
  const sortKeys = new Map<EncodedFeature, number>();
  const add = (layer: string, encoded: EncodedFeature, sortKey: number) => {
    let list = layers.get(layer);
    if (!list) {
      list = [];
      layers.set(layer, list);
    }
    sortKeys.set(encoded, sortKey);
    list.push(encoded);
  };
  const groups = new Map<string, { feature: TileFeature; lines: Float64Array[] }>();
  for (const f of feats) {
    if (f.minZoom > z) continue;
    if (f.type === 2 && z < options.maxZoom) {
      const key = JSON.stringify([f.layer, Object.entries(f.props).sort((a, b) => (a[0] < b[0] ? -1 : 1))]);
      let group = groups.get(key);
      if (!group) {
        group = { feature: f, lines: [] };
        groups.set(key, group);
      }
      for (const part of f.parts) group.lines.push(toLocal(part, scale, ox, oy));
      continue;
    }
    const parts: Int32Array[] = [];
    if (f.type === 1) {
      const p = f.parts[0]!;
      parts.push(Int32Array.of(Math.round(p[0]! * scale - ox), Math.round(p[1]! * scale - oy)));
    } else {
      let outerKept = true;
      for (const part of f.parts) {
        const isOuter = f.type === 3 && signedArea(part) > 0;
        if (f.type === 3 && !isOuter && !outerKept) continue;
        const simple = simplify(toLocal(part, scale, ox, oy), tolerance, f.type === 3);
        const q = quantize(simple);
        if (f.type === 2) {
          if (q.length >= 4) parts.push(q);
          continue;
        }
        if (q.length < 8) {
          if (isOuter) outerKept = false;
          continue;
        }
        const area = signedArea(q);
        if (isOuter ? area < 1 : area > -1) {
          if (isOuter) outerKept = false;
          continue;
        }
        if (isOuter) outerKept = true;
        parts.push(q);
      }
    }
    if (parts.length === 0) continue;
    let list = layers.get(f.layer);
    if (!list) {
      list = [];
      layers.set(f.layer, list);
    }
    const encoded: EncodedFeature = { id: f.id, type: f.type, parts, props: f.props };
    sortKeys.set(encoded, f.sortKey);
    list.push(encoded);
  }
  if (layers.size === 0) return null;
  const out: EncodedLayer[] = [];
  for (const [name, list] of [...layers].sort(
    (a, b) => (LAYER_ORDER.get(a[0]) ?? 99) - (LAYER_ORDER.get(b[0]) ?? 99),
  )) {
    list.sort((a, b) => (sortKeys.get(a) ?? 0) - (sortKeys.get(b) ?? 0));
    out.push({ name, extent, features: list });
  }
  return encodeTile(out);
}

function quantize(points: Float64Array): Int32Array {
  const out = new Int32Array(points.length);
  let n = 0;
  let px = Number.NaN;
  let py = Number.NaN;
  for (let i = 0; i < points.length; i += 2) {
    const x = Math.round(points[i]!);
    const y = Math.round(points[i + 1]!);
    if (x === px && y === py) continue;
    out[n++] = x;
    out[n++] = y;
    px = x;
    py = y;
  }
  return out.slice(0, n);
}
