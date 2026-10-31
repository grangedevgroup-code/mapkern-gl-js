import { gunzipSync } from "../formats/inflate.ts";
import { MemoryRangeSource } from "../search/file.ts";
import { BlobRangeSource, HttpRangeSource, type RangeSource } from "../sources/pmtiles.ts";
import type { RouteData } from "./format.ts";
import { meters, RouteGraph } from "./graph.ts";
import type { LngLatLike, Route, RouteOptions } from "./router.ts";
import { Router } from "./router.ts";
import {
  decodeDirectory,
  decodeOverviewTile,
  decodeTile,
  keyAt,
  keyZXY,
  quadStart,
  TILED_MAGIC,
  TILED_VERSION,
  type TileData,
  type TiledMeta,
} from "./tiles.ts";

export type TiledRouteSource = string | URL | Blob | ArrayBuffer | Uint8Array;

const KEY = 4194304;

type Layer = "detail" | "overview";

interface PartIndex {
  detail: Map<number, [number, number]>;
  overview: Map<number, [number, number]>;
}

interface Part {
  source: RangeSource;
  detail: [number, number] | null;
  overview: [number, number] | null;
  index: PartIndex | null;
  opening: Promise<PartIndex> | null;
}

interface Manifest {
  format: string;
  version: number;
  meta: TiledMeta;
  parts: { file: string; detail: [number, number] | null; overview: [number, number] | null }[];
}

async function retry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 2 || (error instanceof DOMException && error.name === "AbortError")) throw error;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

async function readHeader(source: RangeSource, signal: AbortSignal): Promise<{ meta: TiledMeta; index: PartIndex }> {
  const first = (await retry(() => source.read(0, 20, signal))).data;
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  if (first.byteLength < 20 || view.getUint32(0, true) !== TILED_MAGIC)
    throw new Error("Not a tiled Mapkern route file");
  const version = view.getUint32(4, true);
  if (version !== TILED_VERSION) throw new Error(`Route file version ${version} is not supported`);
  const jsonLength = view.getUint32(8, true);
  const dirLength = view.getUint32(12, true);
  const overviewLength = view.getUint32(16, true);
  const head = (await retry(() => source.read(20, jsonLength + dirLength + overviewLength, signal))).data;
  const meta = JSON.parse(new TextDecoder().decode(head.subarray(0, jsonLength))) as TiledMeta;
  const base = 20 + jsonLength + dirLength + overviewLength;
  const detail = decodeDirectory(gunzipSync(head.subarray(jsonLength, jsonLength + dirLength)), base);
  const end = detail.length ? detail[detail.length - 1]!.offset + detail[detail.length - 1]!.length : base;
  const overview = overviewLength
    ? decodeDirectory(gunzipSync(head.subarray(jsonLength + dirLength, jsonLength + dirLength + overviewLength)), end)
    : [];
  const map = (list: { key: number; offset: number; length: number }[]) =>
    new Map(list.map((e) => [e.key, [e.offset, e.length] as [number, number]]));
  return { meta, index: { detail: map(detail), overview: map(overview) } };
}

function spanOf(keys: Iterable<number>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of keys) {
    const q = quadStart(k);
    lo = Math.min(lo, q);
    hi = Math.max(hi, q + 4 ** (16 - keyZXY(k)[0]) - 1);
  }
  return lo <= hi ? [lo, hi] : null;
}

export class TiledRouteFile {
  readonly meta: TiledMeta;
  private readonly parts: Part[];
  private readonly cache = new Map<string, Promise<TileData | null>>();
  bytesRead = 0;

  private constructor(meta: TiledMeta, parts: Part[]) {
    this.meta = meta;
    this.parts = parts;
  }

  static async open(
    input: TiledRouteSource,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TiledRouteFile> {
    if ((typeof input === "string" || input instanceof URL) && /\.json(\?|#|$)/.test(String(input))) {
      const base = typeof location === "undefined" ? undefined : location.href;
      const url = new URL(String(input), base);
      const manifest = await retry(async () => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Could not load the route manifest (${response.status})`);
        return (await response.json()) as Manifest;
      });
      if (manifest.format !== "mapkern-route") throw new Error("Not a Mapkern route manifest");
      const parts = manifest.parts.map(
        (p): Part => ({
          source: new HttpRangeSource(new URL(p.file, url).href),
          detail: p.detail,
          overview: p.overview,
          index: null,
          opening: null,
        }),
      );
      return new TiledRouteFile(manifest.meta, parts);
    }
    const source = toSource(input);
    const { meta, index } = await readHeader(source, signal);
    const file = new TiledRouteFile(meta, [
      { source, detail: spanOf(index.detail.keys()), overview: spanOf(index.overview.keys()), index, opening: null },
    ]);
    return file;
  }

  get hasOverview(): boolean {
    return (this.meta.overview?.tiles ?? 0) > 0;
  }

  private partFor(key: number, layer: Layer): Part | null {
    const q = quadStart(key);
    for (const p of this.parts) {
      const r = p[layer];
      if (r && q >= r[0] && q <= r[1]) return p;
    }
    return null;
  }

  private open(part: Part): Promise<PartIndex> {
    if (part.index) return Promise.resolve(part.index);
    part.opening ??= readHeader(part.source, new AbortController().signal).then(({ index }) => {
      part.index = index;
      return index;
    });
    part.opening.catch(() => {
      part.opening = null;
    });
    return part.opening;
  }

  private zooms(layer: Layer): [number, number] {
    const o = this.meta.overview;
    return layer === "detail" ? [this.meta.minZoom, this.meta.maxZoom] : [o?.minZoom ?? 0, o?.maxZoom ?? -1];
  }

  async prepare(points: Iterable<[number, number]>, layer: Layer): Promise<void> {
    const [lo, hi] = this.zooms(layer);
    const waiting = new Set<Part>();
    for (const [lon, lat] of points) {
      for (let z = hi; z >= lo; z--) {
        const part = this.partFor(keyAt(lon, lat, z), layer);
        if (part && !part.index) waiting.add(part);
      }
    }
    await Promise.all([...waiting].map((p) => this.open(p)));
  }

  async prepareKeys(keys: Iterable<number>, layer: Layer): Promise<void> {
    const waiting = new Set<Part>();
    for (const k of keys) {
      const part = this.partFor(k, layer);
      if (part && !part.index) waiting.add(part);
    }
    await Promise.all([...waiting].map((p) => this.open(p)));
  }

  has(key: number, layer: Layer = "detail"): boolean {
    return this.partFor(key, layer)?.index?.[layer].has(key) ?? false;
  }

  leaf(lon: number, lat: number, layer: Layer = "detail"): number | null {
    const [lo, hi] = this.zooms(layer);
    for (let z = hi; z >= lo; z--) {
      const key = keyAt(lon, lat, z);
      if (this.has(key, layer)) return key;
    }
    return null;
  }

  private active = 0;
  private readonly waiting: (() => void)[] = [];

  private async fetch(source: RangeSource, offset: number, length: number): Promise<Uint8Array> {
    if (this.active >= 6) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return (await retry(() => source.read(offset, length, new AbortController().signal))).data;
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  tile(key: number, layer: Layer = "detail"): Promise<TileData | null> {
    const id = `${layer}:${key}`;
    let loading = this.cache.get(id);
    if (!loading) {
      const part = this.partFor(key, layer);
      loading = part
        ? this.open(part).then(async (index) => {
            const range = index[layer].get(key);
            if (!range) return null;
            const data = await this.fetch(part.source, range[0], range[1]);
            this.bytesRead += data.byteLength;
            const bytes = gunzipSync(data);
            return layer === "detail" ? decodeTile(key, bytes) : decodeOverviewTile(key, bytes);
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
  private readonly highways = new Map<number, TileData>();
  near = 6000;
  longRoute = 20000;
  private assembled: Assembled | null = null;
  private readonly slots = new Map<number, number>();
  rounds = 0;

  constructor(file: TiledRouteFile) {
    this.file = file;
  }

  static async open(input: TiledRouteSource): Promise<TiledRouter> {
    return new TiledRouter(await TiledRouteFile.open(input));
  }

  private slot(key: number): number {
    let s = this.slots.get(key);
    if (s === undefined) {
      s = this.slots.size;
      this.slots.set(key, s);
    }
    return s;
  }

  get tilesLoaded(): number {
    return this.loaded.size;
  }

  async route(points: readonly LngLatLike[], options: RouteOptions = {}): Promise<Route | null> {
    const pts = points.map((p): [number, number] => (Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat]));
    let longest = 0;
    for (let i = 0; i + 1 < pts.length; i++) longest = Math.max(longest, meters(pts[i]!, pts[i + 1]!));
    const layered = (options.profile ?? "car") === "car" && this.file.hasOverview && longest > this.longRoute;
    const detailPoints: [number, number][] = [];
    const highwayPoints: [number, number][] = [];
    const disc = (lng: number, lat: number, radius: number) => {
      const r = radius / 111195;
      const k = r / Math.cos((lat * Math.PI) / 180);
      const rings = Math.max(1, Math.ceil(radius / 1500));
      detailPoints.push([lng, lat]);
      for (let ring = 1; ring <= rings; ring++) {
        const f = ring / rings;
        const count = 8 * ring;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * 2 * Math.PI;
          detailPoints.push([lng + Math.cos(a) * k * f, lat + Math.sin(a) * r * f]);
        }
      }
    };
    for (const [lng, lat] of pts) disc(lng, lat, layered ? this.near : (options.snapRadius ?? 2000) / 2);
    for (let i = 0; i + 1 < pts.length; i++) {
      for (const p of corridor(pts[i]!, pts[i + 1]!)) (layered ? highwayPoints : detailPoints).push(p);
    }
    await Promise.all([this.file.prepare(detailPoints, "detail"), this.file.prepare(highwayPoints, "overview")]);
    const leaves = (list: [number, number][], layer: "detail" | "overview") => {
      const out = new Set<number>();
      for (const [lng, lat] of list) {
        const t = this.file.leaf(lng, lat, layer);
        if (t !== null) out.add(t);
      }
      return out;
    };
    await Promise.all([
      this.load(leaves(detailPoints, "detail")),
      this.loadHighways(leaves(highwayPoints, "overview")),
    ]);
    this.rounds = 0;
    for (;;) {
      this.rounds++;
      const a = this.assemble();
      const frontier = a.frontier.slice();
      const g = a.graph.data;
      const far = (node: number) => {
        const p: [number, number] = [g.nodeLon[node]! / 1e7, g.nodeLat[node]! / 1e7];
        for (const q of pts) if (meters(p, q) <= this.near) return false;
        return true;
      };
      const wantHighway = new Map<number, number>();
      if (layered) {
        const farNodes: number[] = [];
        for (let node = 0; node < frontier.length; node++) if (frontier[node] && far(node)) farNodes.push(node);
        await this.file.prepare(
          farNodes.map((n): [number, number] => [g.nodeLon[n]! / 1e7, g.nodeLat[n]! / 1e7]),
          "overview",
        );
        for (const node of farNodes) {
          const leaf = this.file.leaf(g.nodeLon[node]! / 1e7, g.nodeLat[node]! / 1e7, "overview");
          if (leaf === null) continue;
          if (this.highways.has(leaf)) frontier[node] = 0;
          else wantHighway.set(node, leaf);
        }
      }
      const router = new Router(a.graph);
      router.frontier = frontier;
      const result = router.route(pts, options);
      if (router.reached.size === 0) return result;
      await this.file.prepareKeys(
        [...router.reached].map((n) => a.nodeTile[n]!),
        "detail",
      );
      const more = new Set<number>();
      const moreHighways = new Set<number>();
      for (const node of router.reached) {
        const leaf = wantHighway.get(node);
        if (leaf !== undefined) {
          moreHighways.add(leaf);
          continue;
        }
        const t = a.nodeTile[node]!;
        if (!this.loaded.has(t) && this.file.has(t)) more.add(t);
      }
      if (more.size === 0 && moreHighways.size === 0) return result;
      await Promise.all([this.load(more), this.loadHighways(moreHighways)]);
    }
  }

  private async loadHighways(ids: Iterable<number>): Promise<void> {
    const fresh = [...ids].filter((id) => !this.highways.has(id));
    if (fresh.length === 0) return;
    const tiles = await Promise.all(fresh.map((id) => this.file.tile(id, "overview")));
    for (const tile of tiles) if (tile) this.highways.set(tile.id, tile);
    this.assembled = null;
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
    const busy: number[] = [];
    for (const tile of this.loaded.values()) {
      for (let i = 0; i < tile.lon.length; i++) {
        nodeIndex.set(this.slot(tile.id) * KEY + i, lon.length);
        lon.push(tile.lon[i]!);
        lat.push(tile.lat[i]!);
        tileOfNode.push(tile.id);
        frontier.push(0);
        busy.push(2);
      }
    }
    const node = (t: number, local: number, x: number, y: number) => {
      const key = this.slot(t) * KEY + local;
      let i = nodeIndex.get(key);
      if (i === undefined) {
        i = lon.length;
        nodeIndex.set(key, i);
        lon.push(x);
        lat.push(y);
        tileOfNode.push(t);
        frontier.push(1);
        busy.push(2);
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
    for (const tile of [...this.loaded.values(), ...this.highways.values()]) {
      const local: number[] = [];
      for (const e of tile.edges) {
        const key = this.slot(e.owner) * KEY + e.ownerIndex;
        let id = edgeIndex.get(key);
        if (id === undefined) {
          const n = e.lon.length;
          id = from.length;
          edgeIndex.set(key, id);
          const a = node(e.fromTile, e.fromLocal, e.lon[0]!, e.lat[0]!);
          const b = node(e.toTile, e.toLocal, e.lon[n - 1]!, e.lat[n - 1]!);
          from.push(a);
          to.push(b);
          if (e.busy !== undefined) {
            if (frontier[a]) busy[a] = e.busy & 1;
            if (frontier[b]) busy[b] = (e.busy >> 1) & 1;
          }
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
        const via = nodeIndex.get(this.slot(r.viaTile) * KEY + r.via);
        if (via === undefined) continue;
        resFrom.push(local[r.from]!);
        resTo.push(local[r.to]!);
        resVia.push(via);
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
      nodeBusy: Uint8Array.from(busy),
    };
    this.assembled = {
      graph: new RouteGraph(data),
      frontier: Uint8Array.from(frontier),
      nodeTile: Float64Array.from(tileOfNode),
    };
    return this.assembled;
  }
}

function corridor(a: [number, number], b: [number, number]): [number, number][] {
  const steps = Math.max(2, Math.ceil(meters(a, b) / 1000));
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
