import { gzipSync } from "node:zlib";
import type { RouteData } from "../../src/route/format.ts";
import {
  COORD,
  newColumns,
  packColumns,
  TILE_ZOOM,
  TILED_MAGIC,
  TILED_VERSION,
  type TiledMeta,
  tileBounds,
  tileOf,
  tileXY,
  Writer,
} from "../../src/route/tiles.ts";

export interface TiledBuildOptions {
  zoom?: number;
  tolerance?: number;
  attribution?: string;
  log?: (message: string) => void;
}

function hilbert(x: number, y: number): number {
  let d = 0;
  for (let s = 1 << 15; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

function simplify(lon: number[], lat: number[], tolerance: number): number[] {
  const n = lon.length;
  if (n <= 2 || tolerance <= 0) return [...lon.keys()];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const k = Math.cos((lat[0]! * Math.PI) / 180);
  const limit = (tolerance / 111195) ** 2;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = lon[a]! * k;
    const ay = lat[a]!;
    const dx = lon[b]! * k - ax;
    const dy = lat[b]! - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = lon[i]! * k - ax;
      const py = lat[i]! - ay;
      const t = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0;
      const ex = dx * t - px;
      const ey = dy * t - py;
      const e = ex * ex + ey * ey;
      if (e > worst) {
        worst = e;
        at = i;
      }
    }
    if (worst > limit) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export function encodeTiledRoute(data: RouteData, options: TiledBuildOptions = {}): Uint8Array {
  const zoom = options.zoom ?? TILE_ZOOM;
  const tolerance = options.tolerance ?? 1;
  const log = options.log ?? (() => undefined);
  const m = data.meta;
  const nodeTile = new Float64Array(m.nodes);
  const byTile = new Map<number, number[]>();
  for (let i = 0; i < m.nodes; i++) {
    const t = tileOf(data.nodeLon[i]! / 1e7, data.nodeLat[i]! / 1e7, zoom);
    nodeTile[i] = t;
    let list = byTile.get(t);
    if (!list) {
      list = [];
      byTile.set(t, list);
    }
    list.push(i);
  }
  const local = new Int32Array(m.nodes);
  for (const [t, list] of byTile) {
    const [w, s, e, n] = tileBounds(t, zoom);
    const key = (i: number) =>
      hilbert(
        Math.floor(((data.nodeLon[i]! / 1e7 - w) / (e - w)) * 65535),
        Math.floor(((data.nodeLat[i]! / 1e7 - s) / (n - s)) * 65535),
      );
    list.sort((a, b) => key(a) - key(b));
    list.forEach((node, i) => {
      local[node] = i;
    });
  }
  const owned = new Map<number, number[]>();
  const foreign = new Map<number, number[]>();
  const push = (map: Map<number, number[]>, t: number, e: number) => {
    let list = map.get(t);
    if (!list) {
      list = [];
      map.set(t, list);
    }
    list.push(e);
  };
  for (let e = 0; e < m.edges; e++) {
    const a = nodeTile[data.edgeFrom[e]!]!;
    const b = nodeTile[data.edgeTo[e]!]!;
    push(owned, a, e);
    if (b !== a) push(foreign, b, e);
  }
  for (const list of owned.values()) list.sort((x, y) => local[data.edgeFrom[x]!]! - local[data.edgeFrom[y]!]!);
  const ownedIndex = new Int32Array(m.edges);
  for (const list of owned.values()) list.forEach((e, i) => (ownedIndex[e] = i));
  const restrictionsByTile = new Map<number, number[]>();
  for (let r = 0; r < m.restrictions; r++) push(restrictionsByTile, nodeTile[data.resVia[r]!]!, r);
  const ids = [...byTile.keys()].sort((a, b) => a - b);
  const blobs: Uint8Array[] = [];
  let raw = 0;
  for (const id of ids) {
    const nodes = byTile.get(id)!;
    const edgeList = [...(owned.get(id) ?? []), ...(foreign.get(id) ?? [])];
    const ownedCount = owned.get(id)?.length ?? 0;
    const position = new Map<number, number>();
    edgeList.forEach((e, i) => position.set(e, i));
    const c = newColumns();
    const strings = new Map<string, number>();
    const string = (s: string) => {
      if (!s) return 0;
      let v = strings.get(s);
      if (v === undefined) {
        v = strings.size + 1;
        strings.set(s, v);
      }
      return v;
    };
    const restrictions = (restrictionsByTile.get(id) ?? []).filter(
      (r) => position.has(data.resFrom[r]!) && position.has(data.resTo[r]!),
    );
    c.counts.uint(nodes.length);
    c.counts.uint(ownedCount);
    c.counts.uint(edgeList.length - ownedCount);
    c.counts.uint(restrictions.length);
    const [w, s] = tileBounds(id, zoom);
    let x = Math.round(w * COORD);
    let y = Math.round(s * COORD);
    const q = (v: number) => Math.round((v / 1e7) * COORD);
    for (const node of nodes) {
      const nx = q(data.nodeLon[node]!);
      const ny = q(data.nodeLat[node]!);
      c.nodes.int(nx - x);
      c.nodes.int(ny - y);
      x = nx;
      y = ny;
    }
    const [tx, ty] = tileXY(id, zoom);
    const ref = (node: number) => {
      const [nx, ny] = tileXY(nodeTile[node]!, zoom);
      c.ends.int(nx - tx);
      c.ends.int(ny - ty);
      c.ends.uint(local[node]!);
    };
    edgeList.forEach((e, i) => {
      const from = data.edgeFrom[e]!;
      const to = data.edgeTo[e]!;
      ref(from);
      ref(to);
      if (i >= ownedCount) c.owners.uint(ownedIndex[e]!);
      const lon = [data.nodeLon[from]! / 1e7];
      const lat = [data.nodeLat[from]! / 1e7];
      for (let k = data.shapeStart[e]!; k < data.shapeStart[e + 1]!; k++) {
        lon.push(data.shapeLon[k]! / 1e7);
        lat.push(data.shapeLat[k]! / 1e7);
      }
      lon.push(data.nodeLon[to]! / 1e7);
      lat.push(data.nodeLat[to]! / 1e7);
      const keep = simplify(lon, lat, tolerance);
      const inner = keep.slice(1, -1);
      c.shapes.uint(inner.length);
      let px = q(data.nodeLon[from]!);
      let py = q(data.nodeLat[from]!);
      if (nodeTile[from] !== id) {
        c.far.int(px - q(data.nodeLon[to]!));
        c.far.int(py - q(data.nodeLat[to]!));
      }
      for (const k of inner) {
        const sx = Math.round(lon[k]! * COORD);
        const sy = Math.round(lat[k]! * COORD);
        c.shapes.int(sx - px);
        c.shapes.int(sy - py);
        px = sx;
        py = sy;
      }
      if (nodeTile[to] !== id) {
        c.far.int(q(data.nodeLon[to]!) - px);
        c.far.int(q(data.nodeLat[to]!) - py);
      }
      c.classes.byte(data.edgeClass[e]!);
      c.flags.uint(data.edgeFlags[e]!);
      c.speeds.byte(data.edgeSpeed[e]!);
      const name = data.edgeName[e]!;
      const refName = data.edgeRef[e]!;
      c.names.uint(string(name >= 0 ? (m.names[name] ?? "") : ""));
      c.refs.uint(string(refName >= 0 ? (m.names[refName] ?? "") : ""));
    });
    for (const r of restrictions) {
      c.restrictions.uint(local[data.resVia[r]!]!);
      c.restrictions.uint(position.get(data.resFrom[r]!)!);
      c.restrictions.uint(position.get(data.resTo[r]!)!);
      c.restrictions.byte(data.resKind[r]!);
      c.restrictions.byte(data.resModes[r]!);
    }
    const encoder = new TextEncoder();
    c.strings.uint(strings.size);
    for (const s of strings.keys()) {
      const b = encoder.encode(s);
      c.strings.uint(b.length);
      c.strings.bytes(b);
    }
    const packed = packColumns(c);
    raw += packed.length;
    blobs.push(gzipSync(packed, { level: 9 }));
  }
  const dir = new Writer();
  dir.uint(ids.length);
  let last = 0;
  ids.forEach((id, i) => {
    dir.uint(id - last);
    last = id;
    dir.uint(blobs[i]!.length);
  });
  const directory = gzipSync(dir.done(), { level: 9 });
  const meta: TiledMeta = {
    zoom,
    bbox: m.bbox,
    tiles: ids.length,
    nodes: m.nodes,
    edges: m.edges,
    ...(options.attribution ? { attribution: options.attribution } : {}),
    created: new Date().toISOString(),
  };
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const header = new Writer();
  const fixed = new Uint8Array(16);
  const view = new DataView(fixed.buffer);
  view.setUint32(0, TILED_MAGIC, true);
  view.setUint32(4, TILED_VERSION, true);
  view.setUint32(8, json.length, true);
  view.setUint32(12, directory.length, true);
  header.bytes(fixed);
  header.bytes(json);
  header.bytes(directory);
  const head = header.done();
  const total = head.length + blobs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let at = head.length;
  for (const b of blobs) {
    out.set(b, at);
    at += b.length;
  }
  const sizes = blobs.map((b) => b.length).sort((a, b) => a - b);
  log(
    `${ids.length} tiles at zoom ${zoom}: ${(raw / 1e6).toFixed(1)} MB packed, ${(total / 1e6).toFixed(1)} MB gzip, ` +
      `median tile ${(sizes[sizes.length >> 1]! / 1e3).toFixed(0)} KB, largest ${(sizes[sizes.length - 1]! / 1e3).toFixed(0)} KB`,
  );
  return out;
}
