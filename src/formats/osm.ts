import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import { Reader } from "./protobuf.ts";
import { ringContains } from "./rings.ts";
import type { XmlElement } from "./xml.ts";
import { parseXml } from "./xml.ts";

export class OsmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OsmError";
  }
}

type Tags = Record<string, string>;

interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}

class NodeStore {
  private ids = new Float64Array(4096);
  private lons = new Float64Array(4096);
  private lats = new Float64Array(4096);
  private count = 0;
  private sorted = true;
  readonly tags = new Map<number, Tags>();

  add(id: number, lon: number, lat: number, tags: Tags | null): void {
    if (this.count === this.ids.length) {
      const grow = (a: Float64Array) => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.ids = grow(this.ids);
      this.lons = grow(this.lons);
      this.lats = grow(this.lats);
    }
    if (this.count > 0 && id <= this.ids[this.count - 1]!) this.sorted = false;
    this.ids[this.count] = id;
    this.lons[this.count] = lon;
    this.lats[this.count] = lat;
    this.count++;
    if (tags) this.tags.set(id, tags);
  }

  finish(): void {
    if (this.sorted) return;
    const order = Array.from({ length: this.count }, (_, i) => i).sort((a, b) => this.ids[a]! - this.ids[b]!);
    const pick = (a: Float64Array) => Float64Array.from(order, (i) => a[i]!);
    this.ids = pick(this.ids);
    this.lons = pick(this.lons);
    this.lats = pick(this.lats);
    this.sorted = true;
  }

  get(id: number): Position | null {
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.ids[mid]!;
      if (v === id) return [this.lons[mid]!, this.lats[mid]!];
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }
}

interface OsmData {
  nodes: NodeStore;
  ways: { id: number; refs: number[]; tags: Tags }[];
  relations: { id: number; members: OsmMember[]; tags: Tags }[];
}

const IGNORED = new Set(["created_by", "source", "converted_by", "odbl", "odbl:note"]);
const AREA_KEYS = new Set([
  "building",
  "building:part",
  "landuse",
  "natural",
  "leisure",
  "amenity",
  "shop",
  "tourism",
  "historic",
  "military",
  "place",
  "aeroway",
  "power",
  "man_made",
  "waterway",
  "office",
  "craft",
  "landcover",
  "area:highway",
  "indoor",
  "golf",
  "public_transport",
  "railway",
  "emergency",
  "healthcare",
  "sport",
  "geological",
]);
const LINE_VALUES: Record<string, Set<string>> = {
  natural: new Set(["coastline", "cliff", "ridge", "arete", "tree_row", "valley", "gorge", "earth_bank"]),
  leisure: new Set(["track", "slipway"]),
  man_made: new Set(["embankment", "pipeline", "cutline", "breakwater", "groyne", "dyke", "goods_conveyor"]),
  waterway: new Set(["river", "stream", "canal", "drain", "ditch", "weir", "rapids", "fairway", "tidal_channel"]),
  aeroway: new Set(["taxiway", "runway", "parking_position", "jet_bridge"]),
  power: new Set(["line", "minor_line", "cable"]),
  railway: new Set([
    "rail",
    "light_rail",
    "subway",
    "tram",
    "narrow_gauge",
    "monorail",
    "funicular",
    "miniature",
    "abandoned",
    "disused",
    "construction",
    "preserved",
  ]),
  public_transport: new Set(["stop_position"]),
};

function interesting(tags: Tags | null): boolean {
  if (!tags) return false;
  for (const k in tags) if (!IGNORED.has(k)) return true;
  return false;
}

function isArea(tags: Tags): boolean {
  if (tags.area === "yes") return true;
  if (tags.area === "no") return false;
  for (const k in tags) {
    if (!AREA_KEYS.has(k)) continue;
    const v = tags[k]!;
    if (v === "no") continue;
    if (LINE_VALUES[k]?.has(v)) continue;
    return true;
  }
  return false;
}

export function isOsmXml(head: string): boolean {
  return /<osm[\s>]/.test(head);
}

export function isOsmPbf(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (size < 8 || size > 64 * 1024 || 4 + size > bytes.length) return false;
  return new TextDecoder().decode(bytes.subarray(4, 4 + Math.min(size, 24))).includes("OSMHeader");
}

export function osmXmlToGeoJSON(text: string): FeatureCollection {
  const root = parseXml(text).children.find((c) => c.name === "osm");
  if (!root) throw new OsmError("The file has no <osm> element");
  const data: OsmData = { nodes: new NodeStore(), ways: [], relations: [] };
  const tagsOf = (e: XmlElement): Tags => {
    const tags: Tags = {};
    for (const c of e.children) if (c.name === "tag" && c.attrs.k !== undefined) tags[c.attrs.k] = c.attrs.v ?? "";
    return tags;
  };
  for (const e of root.children) {
    const id = Number(e.attrs.id);
    if (e.name === "node") {
      const tags = e.children.length > 0 ? tagsOf(e) : null;
      data.nodes.add(id, Number(e.attrs.lon), Number(e.attrs.lat), tags);
    } else if (e.name === "way") {
      const refs = e.children.filter((c) => c.name === "nd").map((c) => Number(c.attrs.ref));
      data.ways.push({ id, refs, tags: tagsOf(e) });
    } else if (e.name === "relation") {
      const members = e.children
        .filter((c) => c.name === "member")
        .map((c) => ({ type: c.attrs.type as OsmMember["type"], ref: Number(c.attrs.ref), role: c.attrs.role ?? "" }));
      data.relations.push({ id, members, tags: tagsOf(e) });
    }
  }
  return build(data);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function osmPbfToGeoJSON(bytes: Uint8Array): Promise<FeatureCollection> {
  const data: OsmData = { nodes: new NodeStore(), ways: [], relations: [] };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const headerSize = view.getUint32(pos, false);
    pos += 4;
    if (pos + headerSize > bytes.length) throw new OsmError("The OSM PBF file ends inside a block header");
    const header = new Reader(bytes, pos, pos + headerSize);
    pos += headerSize;
    let type = "";
    let size = 0;
    while (!header.done) {
      const tag = header.tag();
      if (tag >> 3 === 1) type = header.string();
      else if (tag >> 3 === 3) size = header.varint();
      else header.skip(tag & 7);
    }
    if (pos + size > bytes.length) throw new OsmError("The OSM PBF file ends inside a block");
    const blob = new Reader(bytes, pos, pos + size);
    pos += size;
    let content: Uint8Array | null = null;
    while (!blob.done) {
      const tag = blob.tag();
      const field = tag >> 3;
      if (field === 1) content = blob.bytes();
      else if (field === 3) content = await inflate(blob.bytes());
      else if (field === 4 || field === 6 || field === 7) {
        throw new OsmError("This OSM PBF file uses LZMA, LZ4 or Zstandard blocks, which are not supported");
      } else blob.skip(tag & 7);
    }
    if (!content) continue;
    if (type === "OSMHeader") checkHeader(content);
    else if (type === "OSMData") readBlock(content, data);
  }
  return build(data);
}

function checkHeader(content: Uint8Array): void {
  const r = new Reader(content);
  while (!r.done) {
    const tag = r.tag();
    if (tag >> 3 === 4) {
      const feature = r.string();
      if (feature !== "OsmSchema-V0.6" && feature !== "DenseNodes") {
        throw new OsmError(`This OSM PBF file needs "${feature}", which is not supported`);
      }
    } else r.skip(tag & 7);
  }
}

function packed(r: Reader, read: () => number): number[] {
  const end = r.packedEnd();
  const out: number[] = [];
  while (r.pos < end) out.push(read());
  return out;
}

function readBlock(content: Uint8Array, data: OsmData): void {
  const r = new Reader(content);
  const strings: string[] = [];
  const groups: Reader[] = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;
  const decoder = new TextDecoder();
  while (!r.done) {
    const tag = r.tag();
    switch (tag >> 3) {
      case 1: {
        const table = r.sub();
        while (!table.done) {
          const t = table.tag();
          if (t >> 3 === 1) strings.push(decoder.decode(table.bytes()));
          else table.skip(t & 7);
        }
        break;
      }
      case 2:
        groups.push(r.sub());
        break;
      case 17:
        granularity = r.varint();
        break;
      case 19:
        latOffset = r.int64();
        break;
      case 20:
        lonOffset = r.int64();
        break;
      default:
        r.skip(tag & 7);
    }
  }
  const lat = (v: number) => (latOffset + granularity * v) * 1e-9;
  const lon = (v: number) => (lonOffset + granularity * v) * 1e-9;
  const tagsFrom = (keys: number[], vals: number[]): Tags => {
    const tags: Tags = {};
    for (let i = 0; i < keys.length; i++) tags[strings[keys[i]!]!] = strings[vals[i]!] ?? "";
    return tags;
  };
  for (const g of groups) {
    while (!g.done) {
      const tag = g.tag();
      const field = tag >> 3;
      if (field === 1) readNode(g.sub(), data, lat, lon, tagsFrom);
      else if (field === 2) readDense(g.sub(), data, lat, lon, strings);
      else if (field === 3) readWay(g.sub(), data, tagsFrom);
      else if (field === 4) readRelation(g.sub(), data, strings, tagsFrom);
      else g.skip(tag & 7);
    }
  }
}

function readNode(
  r: Reader,
  data: OsmData,
  lat: (v: number) => number,
  lon: (v: number) => number,
  tagsFrom: (k: number[], v: number[]) => Tags,
): void {
  let id = 0;
  let la = 0;
  let lo = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  while (!r.done) {
    const tag = r.tag();
    switch (tag >> 3) {
      case 1:
        id = r.svarint();
        break;
      case 2:
        keys = packed(r, () => r.varint());
        break;
      case 3:
        vals = packed(r, () => r.varint());
        break;
      case 8:
        la = r.svarint();
        break;
      case 9:
        lo = r.svarint();
        break;
      default:
        r.skip(tag & 7);
    }
  }
  data.nodes.add(id, lon(lo), lat(la), keys.length > 0 ? tagsFrom(keys, vals) : null);
}

function readDense(
  r: Reader,
  data: OsmData,
  lat: (v: number) => number,
  lon: (v: number) => number,
  strings: string[],
): void {
  let ids: number[] = [];
  let lats: number[] = [];
  let lons: number[] = [];
  let keysVals: number[] = [];
  while (!r.done) {
    const tag = r.tag();
    switch (tag >> 3) {
      case 1:
        ids = packed(r, () => r.svarint());
        break;
      case 8:
        lats = packed(r, () => r.svarint());
        break;
      case 9:
        lons = packed(r, () => r.svarint());
        break;
      case 10:
        keysVals = packed(r, () => r.varint());
        break;
      default:
        r.skip(tag & 7);
    }
  }
  let id = 0;
  let la = 0;
  let lo = 0;
  let k = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i]!;
    la += lats[i] ?? 0;
    lo += lons[i] ?? 0;
    let tags: Tags | null = null;
    while (k < keysVals.length && keysVals[k] !== 0) {
      tags ??= {};
      tags[strings[keysVals[k]!]!] = strings[keysVals[k + 1]!] ?? "";
      k += 2;
    }
    k++;
    data.nodes.add(id, lon(lo), lat(la), tags);
  }
}

function readWay(r: Reader, data: OsmData, tagsFrom: (k: number[], v: number[]) => Tags): void {
  let id = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  let refs: number[] = [];
  while (!r.done) {
    const tag = r.tag();
    switch (tag >> 3) {
      case 1:
        id = r.int64();
        break;
      case 2:
        keys = packed(r, () => r.varint());
        break;
      case 3:
        vals = packed(r, () => r.varint());
        break;
      case 8: {
        let ref = 0;
        refs = packed(r, () => {
          ref += r.svarint();
          return ref;
        });
        break;
      }
      default:
        r.skip(tag & 7);
    }
  }
  data.ways.push({ id, refs, tags: tagsFrom(keys, vals) });
}

const MEMBER_TYPES: OsmMember["type"][] = ["node", "way", "relation"];

function readRelation(r: Reader, data: OsmData, strings: string[], tagsFrom: (k: number[], v: number[]) => Tags): void {
  let id = 0;
  let keys: number[] = [];
  let vals: number[] = [];
  let roles: number[] = [];
  let memids: number[] = [];
  let types: number[] = [];
  while (!r.done) {
    const tag = r.tag();
    switch (tag >> 3) {
      case 1:
        id = r.int64();
        break;
      case 2:
        keys = packed(r, () => r.varint());
        break;
      case 3:
        vals = packed(r, () => r.varint());
        break;
      case 8:
        roles = packed(r, () => r.varint());
        break;
      case 9: {
        let ref = 0;
        memids = packed(r, () => {
          ref += r.svarint();
          return ref;
        });
        break;
      }
      case 10:
        types = packed(r, () => r.varint());
        break;
      default:
        r.skip(tag & 7);
    }
  }
  const members = memids.map((ref, i) => ({
    type: MEMBER_TYPES[types[i] ?? 0] ?? "node",
    ref,
    role: strings[roles[i] ?? 0] ?? "",
  }));
  data.relations.push({ id, members, tags: tagsFrom(keys, vals) });
}

function joinRings(ways: number[][]): number[][] {
  const pending = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings: number[][] = [];
  while (pending.length > 0) {
    let ring = pending.shift()!;
    while (ring[0] !== ring[ring.length - 1]) {
      const tail = ring[ring.length - 1];
      const i = pending.findIndex((w) => w[0] === tail || w[w.length - 1] === tail);
      if (i < 0) break;
      const w = pending.splice(i, 1)[0]!;
      ring = ring.concat(w[0] === tail ? w.slice(1) : w.slice(0, -1).reverse());
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

function build(data: OsmData): FeatureCollection {
  data.nodes.finish();
  const features: Feature[] = [];
  const ways = new Map(data.ways.map((w) => [w.id, w]));
  const coords = (refs: number[]): Position[] => {
    const out: Position[] = [];
    for (const ref of refs) {
      const n = data.nodes.get(ref);
      if (n) out.push(n);
    }
    return out;
  };
  const inRelation = new Set<number>();
  for (const rel of data.relations) for (const m of rel.members) if (m.type === "way") inRelation.add(m.ref);
  for (const [id, tags] of data.nodes.tags) {
    const at = data.nodes.get(id);
    if (at && interesting(tags)) {
      features.push({
        type: "Feature",
        id: `node/${id}`,
        properties: { ...tags },
        geometry: { type: "Point", coordinates: at },
      });
    }
  }
  for (const w of data.ways) {
    if (!interesting(w.tags) && inRelation.has(w.id)) continue;
    const line = coords(w.refs);
    if (line.length < 2) continue;
    const closed = w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1];
    const geometry: Geometry =
      closed && isArea(w.tags) ? { type: "Polygon", coordinates: [line] } : { type: "LineString", coordinates: line };
    features.push({ type: "Feature", id: `way/${w.id}`, properties: { ...w.tags }, geometry });
  }
  for (const rel of data.relations) {
    const kind = rel.tags.type;
    let geometry: Geometry | null = null;
    if (kind === "multipolygon" || kind === "boundary") {
      const refsFor = (inner: boolean) =>
        rel.members
          .filter((m) => m.type === "way" && (m.role === "inner") === inner && ways.has(m.ref))
          .map((m) => ways.get(m.ref)!.refs);
      const outers = joinRings(refsFor(false))
        .map(coords)
        .filter((r) => r.length >= 4);
      const inners = joinRings(refsFor(true))
        .map(coords)
        .filter((r) => r.length >= 4);
      const polygons = outers.map((r) => [r]);
      for (const hole of inners) {
        const [x, y] = hole[0]!;
        const owner = polygons.find((p) => ringContains(p[0]!, x!, y!));
        if (owner) owner.push(hole);
      }
      if (polygons.length === 1) geometry = { type: "Polygon", coordinates: polygons[0]! };
      else if (polygons.length > 1) geometry = { type: "MultiPolygon", coordinates: polygons };
    } else if (kind === "route" || kind === "waterway" || kind === "route_master") {
      const lines = rel.members
        .filter((m) => m.type === "way" && ways.has(m.ref))
        .map((m) => coords(ways.get(m.ref)!.refs))
        .filter((l) => l.length >= 2);
      if (lines.length > 0) geometry = { type: "MultiLineString", coordinates: lines };
    }
    if (geometry) features.push({ type: "Feature", id: `relation/${rel.id}`, properties: { ...rel.tags }, geometry });
  }
  return { type: "FeatureCollection", features };
}
