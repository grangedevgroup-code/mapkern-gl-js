import { gzipSync } from "node:zlib";
import type { RouteData } from "../../src/route/format.ts";
import { CAR_BACKWARD, CAR_FORWARD } from "../../src/route/format.ts";
import {
  COORD,
  encodeDirectory,
  keyAt,
  keyBounds,
  keyZXY,
  MAX_ZOOM,
  MIN_ZOOM,
  newColumns,
  OVERVIEW_CLASSES,
  OVERVIEW_EDGES,
  OVERVIEW_MAX_ZOOM,
  OVERVIEW_MIN_ZOOM,
  packColumns,
  quadStart,
  TILE_EDGES,
  TILED_MAGIC,
  TILED_VERSION,
  type TiledMeta,
} from "../../src/route/tiles.ts";

export interface TiledBuildOptions {
  minZoom?: number;
  maxZoom?: number;
  tileEdges?: number;
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

export function buildRouteTiles(data: RouteData, options: TiledBuildOptions = {}): TiledBuild {
  const minZoom = options.minZoom ?? MIN_ZOOM;
  const maxZoom = options.maxZoom ?? MAX_ZOOM;
  const limit = options.tileEdges ?? TILE_EDGES;
  const tolerance = options.tolerance ?? 1;
  const log = options.log ?? (() => undefined);
  const m = data.meta;
  const nodeTile = new Float64Array(m.nodes);
  const degree = new Uint32Array(m.nodes);
  for (let e = 0; e < m.edges; e++) degree[data.edgeFrom[e]!]!++;
  const byTile = new Map<number, number[]>();
  const pending: [number, number[]][] = [];
  const top = new Map<number, number[]>();
  for (let i = 0; i < m.nodes; i++) {
    const t = keyAt(data.nodeLon[i]! / 1e7, data.nodeLat[i]! / 1e7, minZoom);
    let list = top.get(t);
    if (!list) {
      list = [];
      top.set(t, list);
    }
    list.push(i);
  }
  pending.push(...top);
  while (pending.length) {
    const [key, list] = pending.pop()!;
    const [z] = keyZXY(key);
    let edges = 0;
    for (const n of list) edges += degree[n]!;
    if (edges <= limit || z >= maxZoom) {
      byTile.set(key, list);
      for (const n of list) nodeTile[n] = key;
      continue;
    }
    const kids = new Map<number, number[]>();
    for (const n of list) {
      const k = keyAt(data.nodeLon[n]! / 1e7, data.nodeLat[n]! / 1e7, z + 1);
      let l = kids.get(k);
      if (!l) {
        l = [];
        kids.set(k, l);
      }
      l.push(n);
    }
    pending.push(...kids);
  }
  const local = new Int32Array(m.nodes);
  for (const [t, list] of byTile) {
    const [w, s, e, n] = keyBounds(t);
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
  for (const list of owned.values())
    list.forEach((e, i) => {
      ownedIndex[e] = i;
    });
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
    edgeList.forEach((e, i) => {
      position.set(e, i);
    });
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
    const [w, s] = keyBounds(id);
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
    const others = new Set<number>();
    for (const e of edgeList) {
      for (const node of [data.edgeFrom[e]!, data.edgeTo[e]!]) if (nodeTile[node] !== id) others.add(nodeTile[node]!);
    }
    const sorted = [...others].sort((a, b) => a - b);
    const slot = new Map<number, number>([[id, 0]]);
    sorted.forEach((k, i) => {
      slot.set(k, i + 1);
    });
    c.neighbors.uint(sorted.length);
    let prevKey = 0;
    for (const k of sorted) {
      c.neighbors.uint(k - prevKey);
      prevKey = k;
    }
    const ref = (node: number) => {
      c.ends.uint(slot.get(nodeTile[node]!)!);
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
  const major = (e: number) =>
    data.edgeClass[e]! < OVERVIEW_CLASSES && (data.edgeFlags[e]! & (CAR_FORWARD | CAR_BACKWARD)) !== 0;
  const coord = (n: number): [number, number] => [data.nodeLon[n]! / 1e7, data.nodeLat[n]! / 1e7];
  const overviewNodes = new Set<number>();
  let majorEdges = 0;
  for (let e = 0; e < m.edges; e++) {
    if (!major(e)) continue;
    majorEdges++;
    overviewNodes.add(data.edgeFrom[e]!);
    overviewNodes.add(data.edgeTo[e]!);
  }
  const overviewTile = new Map<number, number>();
  const topOverview = new Map<number, number[]>();
  for (const n of overviewNodes) {
    const k = keyAt(...coord(n), OVERVIEW_MIN_ZOOM);
    let l = topOverview.get(k);
    if (!l) {
      l = [];
      topOverview.set(k, l);
    }
    l.push(n);
  }
  const fullDegree = new Uint32Array(m.nodes);
  for (let e = 0; e < m.edges; e++) {
    fullDegree[data.edgeFrom[e]!]!++;
    fullDegree[data.edgeTo[e]!]!++;
  }
  const majorDegree = new Uint32Array(m.nodes);
  for (let e = 0; e < m.edges; e++) if (major(e)) majorDegree[data.edgeFrom[e]!]!++;
  const queue: [number, number[]][] = [...topOverview];
  while (queue.length) {
    const [key, list] = queue.pop()!;
    const [z] = keyZXY(key);
    let edges = 0;
    for (const n of list) edges += majorDegree[n]!;
    if (edges <= OVERVIEW_EDGES || z >= OVERVIEW_MAX_ZOOM) {
      for (const n of list) overviewTile.set(n, key);
      continue;
    }
    const kids = new Map<number, number[]>();
    for (const n of list) {
      const k = keyAt(...coord(n), z + 1);
      let l = kids.get(k);
      if (!l) {
        l = [];
        kids.set(k, l);
      }
      l.push(n);
    }
    queue.push(...kids);
  }
  const overviewEdges = new Map<number, number[]>();
  for (let e = 0; e < m.edges; e++) {
    if (!major(e)) continue;
    const a = overviewTile.get(data.edgeFrom[e]!)!;
    const b = overviewTile.get(data.edgeTo[e]!)!;
    push(overviewEdges, a, e);
    if (b !== a) push(overviewEdges, b, e);
  }
  const overviewRestrictions = new Map<number, number[]>();
  for (let r = 0; r < m.restrictions; r++) {
    if (major(data.resFrom[r]!) && major(data.resTo[r]!) && overviewTile.has(data.resVia[r]!)) {
      push(overviewRestrictions, overviewTile.get(data.resVia[r]!)!, r);
    }
  }
  const overviewIds = [...overviewEdges.keys()].sort((a, b) => a - b);
  const overviewBlobs: Uint8Array[] = [];
  for (const id of overviewIds) {
    const list = overviewEdges.get(id)!.sort((x, y) => x - y);
    const position = new Map<number, number>();
    list.forEach((e, i) => {
      position.set(e, i);
    });
    const restrictions = (overviewRestrictions.get(id) ?? []).filter(
      (r) => position.has(data.resFrom[r]!) && position.has(data.resTo[r]!),
    );
    const c = newColumns();
    const keys = new Set<number>();
    for (const e of list) {
      keys.add(nodeTile[data.edgeFrom[e]!]!);
      keys.add(nodeTile[data.edgeTo[e]!]!);
    }
    for (const r of restrictions) keys.add(nodeTile[data.resVia[r]!]!);
    const sorted = [...keys].sort((a, b) => a - b);
    const slot = new Map<number, number>();
    sorted.forEach((k, i) => {
      slot.set(k, i);
    });
    c.neighbors.uint(sorted.length);
    let prevKey = 0;
    for (const k of sorted) {
      c.neighbors.uint(k - prevKey);
      prevKey = k;
    }
    c.counts.uint(list.length);
    c.counts.uint(restrictions.length);
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
    const [w, s] = keyBounds(id);
    let ox = Math.round(w * COORD);
    let oy = Math.round(s * COORD);
    const q = (v: number) => Math.round((v / 1e7) * COORD);
    for (const e of list) {
      const from = data.edgeFrom[e]!;
      const to = data.edgeTo[e]!;
      c.ends.uint(slot.get(nodeTile[from]!)!);
      c.ends.uint(local[from]!);
      c.ends.uint(slot.get(nodeTile[to]!)!);
      c.ends.uint(local[to]!);
      c.ends.uint((fullDegree[from]! >= 3 ? 1 : 0) | (fullDegree[to]! >= 3 ? 2 : 0));
      c.owners.uint(ownedIndex[e]!);
      const fx = q(data.nodeLon[from]!);
      const fy = q(data.nodeLat[from]!);
      c.far.int(fx - ox);
      c.far.int(fy - oy);
      ox = fx;
      oy = fy;
      const lon = [data.nodeLon[from]! / 1e7];
      const lat = [data.nodeLat[from]! / 1e7];
      for (let k = data.shapeStart[e]!; k < data.shapeStart[e + 1]!; k++) {
        lon.push(data.shapeLon[k]! / 1e7);
        lat.push(data.shapeLat[k]! / 1e7);
      }
      lon.push(data.nodeLon[to]! / 1e7);
      lat.push(data.nodeLat[to]! / 1e7);
      const inner = simplify(lon, lat, tolerance).slice(1, -1);
      c.shapes.uint(inner.length);
      let px = fx;
      let py = fy;
      for (const k of inner) {
        const sx = Math.round(lon[k]! * COORD);
        const sy = Math.round(lat[k]! * COORD);
        c.shapes.int(sx - px);
        c.shapes.int(sy - py);
        px = sx;
        py = sy;
      }
      c.far.int(q(data.nodeLon[to]!) - px);
      c.far.int(q(data.nodeLat[to]!) - py);
      c.classes.byte(data.edgeClass[e]!);
      c.flags.uint(data.edgeFlags[e]!);
      c.speeds.byte(data.edgeSpeed[e]!);
      const name = data.edgeName[e]!;
      const refName = data.edgeRef[e]!;
      c.names.uint(string(name >= 0 ? (m.names[name] ?? "") : ""));
      c.refs.uint(string(refName >= 0 ? (m.names[refName] ?? "") : ""));
    }
    for (const r of restrictions) {
      c.restrictions.uint(slot.get(nodeTile[data.resVia[r]!]!)!);
      c.restrictions.uint(local[data.resVia[r]!]!);
      c.restrictions.uint(position.get(data.resFrom[r]!)!);
      c.restrictions.uint(position.get(data.resTo[r]!)!);
      c.restrictions.byte(data.resKind[r]!);
      c.restrictions.byte(data.resModes[r]!);
    }
    const encoder = new TextEncoder();
    c.strings.uint(strings.size);
    for (const str of strings.keys()) {
      const b = encoder.encode(str);
      c.strings.uint(b.length);
      c.strings.bytes(b);
    }
    overviewBlobs.push(gzipSync(packColumns(c), { level: 9 }));
  }
  const overviewBytes = overviewBlobs.reduce((a, b) => a + b.length, 0);
  log(`highway layer: ${majorEdges} edges in ${overviewIds.length} tiles, ${(overviewBytes / 1e6).toFixed(1)} MB`);
  const meta: TiledMeta = {
    minZoom,
    maxZoom,
    bbox: m.bbox,
    tiles: ids.length,
    nodes: m.nodes,
    edges: m.edges,
    overview: { minZoom: OVERVIEW_MIN_ZOOM, maxZoom: OVERVIEW_MAX_ZOOM, tiles: overviewIds.length },
    ...(options.attribution ? { attribution: options.attribution } : {}),
    created: new Date().toISOString(),
  };
  const detailBytes = blobs.reduce((x, b) => x + b.length, 0);
  const sizes = blobs.map((b) => b.length).sort((x, y) => x - y);
  log(
    `${ids.length} tiles at zoom ${minZoom}-${maxZoom}: ${(raw / 1e6).toFixed(1)} MB packed, ${(detailBytes / 1e6).toFixed(1)} MB gzip, ` +
      `median tile ${(sizes[sizes.length >> 1]! / 1e3).toFixed(0)} KB, largest ${(sizes[sizes.length - 1]! / 1e3).toFixed(0)} KB`,
  );
  return {
    meta,
    detail: ids.map((key, i) => ({ key, blob: blobs[i]! })),
    overview: overviewIds.map((key, i) => ({ key, blob: overviewBlobs[i]! })),
  };
}

export interface TileBlob {
  key: number;
  blob: Uint8Array;
}

export interface TiledBuild {
  meta: TiledMeta;
  detail: TileBlob[];
  overview: TileBlob[];
}

export function encodeTiledRoute(data: RouteData, options: TiledBuildOptions = {}): Uint8Array {
  const build = buildRouteTiles(data, options);
  return writeArchive(build.meta, build.detail, build.overview);
}

export function writeArchive(meta: TiledMeta, detail: TileBlob[], overview: TileBlob[]): Uint8Array {
  const order = (list: TileBlob[]) => list.slice().sort((a, b) => quadStart(a.key) - quadStart(b.key));
  const d = order(detail);
  const o = order(overview);
  const directory = gzipSync(encodeDirectory(d.map((t) => ({ key: t.key, length: t.blob.length }))), { level: 9 });
  const overviewDirectory = gzipSync(encodeDirectory(o.map((t) => ({ key: t.key, length: t.blob.length }))), {
    level: 9,
  });
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const fixed = new Uint8Array(20);
  const view = new DataView(fixed.buffer);
  view.setUint32(0, TILED_MAGIC, true);
  view.setUint32(4, TILED_VERSION, true);
  view.setUint32(8, json.length, true);
  view.setUint32(12, directory.length, true);
  view.setUint32(16, overviewDirectory.length, true);
  const parts = [fixed, json, directory, overviewDirectory, ...d.map((t) => t.blob), ...o.map((t) => t.blob)];
  const out = new Uint8Array(parts.reduce((x, p) => x + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface RouteManifest {
  format: "mapkern-route";
  version: number;
  meta: TiledMeta;
  parts: { file: string; bytes: number; detail: [number, number] | null; overview: [number, number] | null }[];
}

function span(list: TileBlob[]): [number, number] | null {
  if (list.length === 0) return null;
  const last = list[list.length - 1]!;
  return [quadStart(list[0]!.key), quadStart(last.key) + 4 ** (16 - keyZXY(last.key)[0]) - 1];
}

export function splitArchive(
  build: TiledBuild,
  name: string,
  maxBytes: number,
): { manifest: RouteManifest; files: { file: string; bytes: Uint8Array }[] } {
  const groups: { detail: TileBlob[]; overview: TileBlob[] }[] = [];
  const chunk = (list: TileBlob[], kind: "detail" | "overview") => {
    let current: TileBlob[] = [];
    let size = 0;
    for (const t of list.slice().sort((a, b) => quadStart(a.key) - quadStart(b.key))) {
      if (current.length && size + t.blob.length > maxBytes) {
        groups.push(kind === "detail" ? { detail: current, overview: [] } : { detail: [], overview: current });
        current = [];
        size = 0;
      }
      current.push(t);
      size += t.blob.length;
    }
    if (current.length)
      groups.push(kind === "detail" ? { detail: current, overview: [] } : { detail: [], overview: current });
  };
  chunk(build.overview, "overview");
  chunk(build.detail, "detail");
  const files: { file: string; bytes: Uint8Array }[] = [];
  const parts: RouteManifest["parts"] = [];
  groups.forEach((g, i) => {
    const file = `${name}-${String(i).padStart(3, "0")}.mkroute`;
    const bytes = writeArchive(build.meta, g.detail, g.overview);
    files.push({ file, bytes });
    parts.push({ file, bytes: bytes.length, detail: span(g.detail), overview: span(g.overview) });
  });
  return { manifest: { format: "mapkern-route", version: TILED_VERSION, meta: build.meta, parts }, files };
}
