import { gunzipSync } from "../formats/inflate.ts";
import { MemoryRangeSource } from "../search/file.ts";
import { BlobRangeSource, HttpRangeSource, type RangeSource } from "../sources/pmtiles.ts";
import type { RouteData } from "./format.ts";
import { meters, RouteGraph } from "./graph.ts";
import type { LngLatLike, Route, RouteOptions } from "./router.ts";
import { Router } from "./router.ts";
import {
  decodeTile,
  Reader,
  TILED_MAGIC,
  TILED_VERSION,
  type TileData,
  type TiledMeta,
  tileOf,
  tileXY,
} from "./tiles.ts";

export type TiledRouteSource = string | URL | Blob | ArrayBuffer | Uint8Array;

const KEY = 4194304;

export class TiledRouteFile {
  readonly meta: TiledMeta;
  private readonly source: RangeSource;
  private readonly offsets = new Map<number, [number, number]>();
  private readonly cache = new Map<number, Promise<TileData | null>>();
  bytesRead = 0;

  private constructor(source: RangeSource, meta: TiledMeta, offsets: Map<number, [number, number]>, read: number) {
    this.source = source;
    this.meta = meta;
    this.offsets = offsets;
    this.bytesRead = read;
  }

  static async open(
    input: TiledRouteSource,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TiledRouteFile> {
    const source = toSource(input);
    const first = (await source.read(0, 16, signal)).data;
    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    if (first.byteLength < 16 || view.getUint32(0, true) !== TILED_MAGIC)
      throw new Error("Not a tiled Mapkern route file");
    const version = view.getUint32(4, true);
    if (version !== TILED_VERSION) throw new Error(`Route file version ${version} is not supported`);
    const jsonLength = view.getUint32(8, true);
    const dirLength = view.getUint32(12, true);
    const head = (await source.read(16, jsonLength + dirLength, signal)).data;
    const meta = JSON.parse(new TextDecoder().decode(head.subarray(0, jsonLength))) as TiledMeta;
    const dir = new Reader(gunzipSync(head.subarray(jsonLength, jsonLength + dirLength)));
    const count = dir.uint();
    const offsets = new Map<number, [number, number]>();
    let id = 0;
    let at = 16 + jsonLength + dirLength;
    for (let i = 0; i < count; i++) {
      id += dir.uint();
      const length = dir.uint();
      offsets.set(id, [at, length]);
      at += length;
    }
    return new TiledRouteFile(source, meta, offsets, 16 + jsonLength + dirLength);
  }

  has(id: number): boolean {
    return this.offsets.has(id);
  }

  tile(id: number, signal?: AbortSignal): Promise<TileData | null> {
    let loading = this.cache.get(id);
    if (!loading) {
      const range = this.offsets.get(id);
      loading = range
        ? this.source.read(range[0], range[1], signal ?? new AbortController().signal).then(({ data }) => {
            this.bytesRead += data.byteLength;
            return decodeTile(id, this.meta.zoom, gunzipSync(data));
          })
        : Promise.resolve(null);
      loading.catch(() => this.cache.delete(id));
      this.cache.set(id, loading);
    }
    return loading;
  }
}

function toSource(input: TiledRouteSource): RangeSource {
  if (input instanceof Uint8Array) return new MemoryRangeSource(input);
  if (input instanceof ArrayBuffer) return new MemoryRangeSource(new Uint8Array(input));
  if (typeof Blob !== "undefined" && input instanceof Blob) return new BlobRangeSource(input, "blob");
  const base = typeof location === "undefined" ? undefined : location.href;
  return new HttpRangeSource(new URL(String(input), base).href);
}

interface Assembled {
  graph: RouteGraph;
  frontier: Uint8Array;
  nodeTile: Float64Array;
}

export class TiledRouter {
  readonly file: TiledRouteFile;
  private readonly loaded = new Map<number, TileData>();
  private assembled: Assembled | null = null;
  rounds = 0;

  constructor(file: TiledRouteFile) {
    this.file = file;
  }

  static async open(input: TiledRouteSource): Promise<TiledRouter> {
    return new TiledRouter(await TiledRouteFile.open(input));
  }

  get tilesLoaded(): number {
    return this.loaded.size;
  }

  async route(points: readonly LngLatLike[], options: RouteOptions = {}): Promise<Route | null> {
    const pts = points.map((p): [number, number] => (Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat]));
    const zoom = this.file.meta.zoom;
    const wanted = new Set<number>();
    for (const [lng, lat] of pts) for (const t of around(tileOf(lng, lat, zoom), zoom, 1)) wanted.add(t);
    for (let i = 0; i + 1 < pts.length; i++) for (const t of corridor(pts[i]!, pts[i + 1]!, zoom)) wanted.add(t);
    await this.load(wanted);
    this.rounds = 0;
    for (;;) {
      this.rounds++;
      const a = this.assemble();
      const router = new Router(a.graph);
      router.frontier = a.frontier;
      const result = router.route(pts, options);
      if (router.reached.size === 0) return result;
      const more = new Set<number>();
      for (const node of router.reached) {
        const t = a.nodeTile[node]!;
        if (!this.loaded.has(t) && this.file.has(t)) more.add(t);
      }
      if (more.size === 0) return result;
      await this.load(more);
    }
  }

  private async load(ids: Iterable<number>): Promise<void> {
    const fresh = [...ids].filter((id) => !this.loaded.has(id) && this.file.has(id));
    if (fresh.length === 0) return;
    const tiles = await Promise.all(fresh.map((id) => this.file.tile(id)));
    for (const tile of tiles) if (tile) this.loaded.set(tile.id, tile);
    this.assembled = null;
  }

  private assemble(): Assembled {
    if (this.assembled) return this.assembled;
    const nodeIndex = new Map<number, number>();
    const lon: number[] = [];
    const lat: number[] = [];
    const tileOfNode: number[] = [];
    const frontier: number[] = [];
    for (const tile of this.loaded.values()) {
      for (let i = 0; i < tile.lon.length; i++) {
        nodeIndex.set(tile.id * KEY + i, lon.length);
        lon.push(tile.lon[i]!);
        lat.push(tile.lat[i]!);
        tileOfNode.push(tile.id);
        frontier.push(0);
      }
    }
    const node = (t: number, local: number, x: number, y: number) => {
      const key = t * KEY + local;
      let i = nodeIndex.get(key);
      if (i === undefined) {
        i = lon.length;
        nodeIndex.set(key, i);
        lon.push(x);
        lat.push(y);
        tileOfNode.push(t);
        frontier.push(1);
      }
      return i;
    };
    const edgeIndex = new Map<number, number>();
    const names = new Map<string, number>();
    const name = (s: string) => {
      if (!s) return -1;
      let v = names.get(s);
      if (v === undefined) {
        v = names.size;
        names.set(s, v);
      }
      return v;
    };
    const from: number[] = [];
    const to: number[] = [];
    const length: number[] = [];
    const cls: number[] = [];
    const flags: number[] = [];
    const speed: number[] = [];
    const nameId: number[] = [];
    const refId: number[] = [];
    const shapeStart: number[] = [0];
    const shapeLon: number[] = [];
    const shapeLat: number[] = [];
    const resFrom: number[] = [];
    const resVia: number[] = [];
    const resTo: number[] = [];
    const resKind: number[] = [];
    const resModes: number[] = [];
    for (const tile of this.loaded.values()) {
      const local: number[] = [];
      for (const e of tile.edges) {
        const key = e.owner * KEY + e.ownerIndex;
        let id = edgeIndex.get(key);
        if (id === undefined) {
          const n = e.lon.length;
          id = from.length;
          edgeIndex.set(key, id);
          from.push(node(e.fromTile, e.fromLocal, e.lon[0]!, e.lat[0]!));
          to.push(node(e.toTile, e.toLocal, e.lon[n - 1]!, e.lat[n - 1]!));
          let len = 0;
          for (let k = 1; k < n; k++) len += meters([e.lon[k - 1]!, e.lat[k - 1]!], [e.lon[k]!, e.lat[k]!]);
          length.push(len);
          cls.push(e.cls);
          flags.push(e.flags);
          speed.push(e.speed);
          nameId.push(name(e.name));
          refId.push(name(e.ref));
          for (let k = 1; k < n - 1; k++) {
            shapeLon.push(Math.round(e.lon[k]! * 1e7));
            shapeLat.push(Math.round(e.lat[k]! * 1e7));
          }
          shapeStart.push(shapeLon.length);
        }
        local.push(id);
      }
      for (const r of tile.restrictions) {
        resFrom.push(local[r.from]!);
        resTo.push(local[r.to]!);
        resVia.push(nodeIndex.get(tile.id * KEY + r.via)!);
        resKind.push(r.kind);
        resModes.push(r.modes);
      }
    }
    const meta = this.file.meta;
    const data: RouteData = {
      meta: {
        bbox: meta.bbox,
        names: [...names.keys()],
        nodes: lon.length,
        edges: from.length,
        shape: shapeLon.length,
        restrictions: resFrom.length,
      },
      nodeLon: Int32Array.from(lon, (v) => Math.round(v * 1e7)),
      nodeLat: Int32Array.from(lat, (v) => Math.round(v * 1e7)),
      edgeFrom: Uint32Array.from(from),
      edgeTo: Uint32Array.from(to),
      edgeLength: Float32Array.from(length),
      edgeClass: Uint8Array.from(cls),
      edgeFlags: Uint16Array.from(flags),
      edgeSpeed: Uint8Array.from(speed),
      edgeName: Int32Array.from(nameId),
      edgeRef: Int32Array.from(refId),
      shapeStart: Uint32Array.from(shapeStart),
      shapeLon: Int32Array.from(shapeLon),
      shapeLat: Int32Array.from(shapeLat),
      resFrom: Uint32Array.from(resFrom),
      resVia: Uint32Array.from(resVia),
      resTo: Uint32Array.from(resTo),
      resKind: Uint8Array.from(resKind),
      resModes: Uint8Array.from(resModes),
    };
    this.assembled = {
      graph: new RouteGraph(data),
      frontier: Uint8Array.from(frontier),
      nodeTile: Float64Array.from(tileOfNode),
    };
    return this.assembled;
  }
}

function around(id: number, zoom: number, r: number): number[] {
  const n = 2 ** zoom;
  const [x, y] = tileXY(id, zoom);
  const out: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy;
      if (yy < 0 || yy >= n) continue;
      out.push(yy * n + ((x + dx + n) % n));
    }
  }
  return out;
}

function corridor(a: [number, number], b: [number, number], zoom: number): Set<number> {
  const out = new Set<number>();
  const km = meters(a, b) / 1000;
  const steps = Math.max(2, Math.ceil(km / 5));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const id = tileOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, zoom);
    out.add(id);
  }
  return out;
}

export { meters };
