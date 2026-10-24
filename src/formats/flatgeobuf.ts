import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import type { Unproject } from "../geo/projection.ts";
import { projectionFromEpsg, projectionFromWkt } from "../geo/projection.ts";

export class FlatGeobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlatGeobufError";
  }
}

const MAGIC = [0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62];
const NODE_BYTES = 40;

export function isFlatGeobuf(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && MAGIC.every((b, i) => bytes[i] === b);
}

interface Column {
  name: string;
  type: number;
}

class Table {
  readonly view: DataView;
  readonly at: number;
  private readonly vtable: number;
  private readonly vtableSize: number;

  constructor(view: DataView, at: number) {
    this.view = view;
    this.at = at;
    this.vtable = at - view.getInt32(at, true);
    this.vtableSize = view.getUint16(this.vtable, true);
  }

  field(index: number): number {
    const slot = 4 + index * 2;
    if (slot >= this.vtableSize) return 0;
    const offset = this.view.getUint16(this.vtable + slot, true);
    return offset === 0 ? 0 : this.at + offset;
  }

  uint8(index: number, fallback = 0): number {
    const p = this.field(index);
    return p ? this.view.getUint8(p) : fallback;
  }

  uint16(index: number, fallback = 0): number {
    const p = this.field(index);
    return p ? this.view.getUint16(p, true) : fallback;
  }

  int32(index: number, fallback = 0): number {
    const p = this.field(index);
    return p ? this.view.getInt32(p, true) : fallback;
  }

  uint64(index: number): number {
    const p = this.field(index);
    return p ? Number(this.view.getBigUint64(p, true)) : 0;
  }

  table(index: number): Table | null {
    const p = this.field(index);
    return p ? new Table(this.view, p + this.view.getUint32(p, true)) : null;
  }

  vector(index: number): { start: number; length: number } | null {
    const p = this.field(index);
    if (!p) return null;
    const v = p + this.view.getUint32(p, true);
    return { start: v + 4, length: this.view.getUint32(v, true) };
  }

  string(index: number): string | null {
    const v = this.vector(index);
    if (!v) return null;
    return decoder.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + v.start, v.length));
  }

  tables(index: number): Table[] {
    const v = this.vector(index);
    if (!v) return [];
    const out: Table[] = [];
    for (let i = 0; i < v.length; i++) {
      const p = v.start + i * 4;
      out.push(new Table(this.view, p + this.view.getUint32(p, true)));
    }
    return out;
  }

  doubles(index: number): Float64Array | null {
    const v = this.vector(index);
    if (!v) return null;
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = this.view.getFloat64(v.start + i * 8, true);
    return out;
  }

  uints(index: number): Uint32Array | null {
    const v = this.vector(index);
    if (!v) return null;
    const out = new Uint32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = this.view.getUint32(v.start + i * 4, true);
    return out;
  }
}

const decoder = new TextDecoder();

export function flatgeobufToGeoJSON(bytes: Uint8Array): FeatureCollection {
  if (!isFlatGeobuf(bytes)) throw new FlatGeobufError("The file is not FlatGeobuf");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(8, true);
  const headerStart = 12;
  const header = new Table(view, headerStart + view.getUint32(headerStart, true));
  const headerType = header.uint8(2);
  const hasZ = header.uint8(3) === 1;
  const columns: Column[] = header.tables(7).map((c) => ({ name: c.string(0) ?? "", type: c.uint8(1) }));
  const count = header.uint64(8);
  const nodeSize = header.uint16(9, 16);
  const crs = header.table(10);
  let unproject: Unproject | null = null;
  if (crs) {
    const wkt = crs.string(4);
    const code = crs.int32(1);
    unproject = wkt ? projectionFromWkt(wkt) : projectionFromEpsg(code);
  }
  let p = headerStart + headerSize;
  if (nodeSize > 0 && count > 0) p += treeSize(count, nodeSize);
  const features: Feature[] = [];
  while (p + 4 <= bytes.length) {
    const size = view.getUint32(p, true);
    const start = p + 4;
    p = start + size;
    if (size === 0 || p > bytes.length) break;
    const feature = new Table(view, start + view.getUint32(start, true));
    const g = feature.table(0);
    const geometry = g ? readGeometry(g, headerType, hasZ, unproject) : null;
    if (!geometry) continue;
    const own = feature.tables(2);
    const featureColumns = own.length > 0 ? own.map((c) => ({ name: c.string(0) ?? "", type: c.uint8(1) })) : columns;
    features.push({ type: "Feature", properties: readProperties(feature, featureColumns), geometry });
  }
  return { type: "FeatureCollection", features };
}

function treeSize(count: number, nodeSize: number): number {
  const size = Math.min(Math.max(nodeSize, 2), 65535);
  let n = count;
  let nodes = n;
  do {
    n = Math.ceil(n / size);
    nodes += n;
  } while (n !== 1);
  return nodes * NODE_BYTES;
}

function readGeometry(g: Table, headerType: number, hasZ: boolean, unproject: Unproject | null): Geometry | null {
  const type = headerType === 0 ? g.uint8(6) : headerType;
  const position = (xy: Float64Array, z: Float64Array | null, i: number): Position => {
    const [x, y] = unproject ? unproject(xy[i * 2]!, xy[i * 2 + 1]!) : [xy[i * 2]!, xy[i * 2 + 1]!];
    return hasZ && z ? [x, y, z[i]!] : [x, y];
  };
  const lines = (): Position[][] => {
    const xy = g.doubles(1);
    if (!xy) return [];
    const z = hasZ ? g.doubles(2) : null;
    const ends = g.uints(0) ?? Uint32Array.of(xy.length / 2);
    const out: Position[][] = [];
    let from = 0;
    for (const end of ends) {
      const line: Position[] = [];
      for (let i = from; i < end; i++) line.push(position(xy, z, i));
      out.push(line);
      from = end;
    }
    return out;
  };
  switch (type) {
    case 1: {
      const xy = g.doubles(1);
      return xy && xy.length >= 2 ? { type: "Point", coordinates: position(xy, hasZ ? g.doubles(2) : null, 0) } : null;
    }
    case 4: {
      const xy = g.doubles(1);
      if (!xy) return null;
      const z = hasZ ? g.doubles(2) : null;
      const coordinates: Position[] = [];
      for (let i = 0; i < xy.length / 2; i++) coordinates.push(position(xy, z, i));
      return { type: "MultiPoint", coordinates };
    }
    case 2: {
      const [line] = lines();
      return line && line.length >= 2 ? { type: "LineString", coordinates: line } : null;
    }
    case 5:
      return { type: "MultiLineString", coordinates: lines() };
    case 3:
      return { type: "Polygon", coordinates: lines() };
    case 6: {
      const polygons: Position[][][] = [];
      for (const part of g.tables(7)) {
        const polygon = readGeometry(part, 3, hasZ, unproject);
        if (polygon?.type === "Polygon") polygons.push(polygon.coordinates);
      }
      return { type: "MultiPolygon", coordinates: polygons };
    }
    case 7: {
      const geometries: Geometry[] = [];
      for (const part of g.tables(7)) {
        const child = readGeometry(part, 0, hasZ, unproject);
        if (child) geometries.push(child);
      }
      return { type: "GeometryCollection", geometries };
    }
    default:
      return null;
  }
}

function readProperties(feature: Table, columns: Column[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const v = feature.vector(1);
  if (!v) return props;
  const view = feature.view;
  let p = v.start;
  const end = v.start + v.length;
  while (p + 2 <= end) {
    const column = columns[view.getUint16(p, true)];
    p += 2;
    if (!column) break;
    let value: unknown;
    switch (column.type) {
      case 0:
        value = view.getInt8(p);
        p += 1;
        break;
      case 1:
        value = view.getUint8(p);
        p += 1;
        break;
      case 2:
        value = view.getUint8(p) !== 0;
        p += 1;
        break;
      case 3:
        value = view.getInt16(p, true);
        p += 2;
        break;
      case 4:
        value = view.getUint16(p, true);
        p += 2;
        break;
      case 5:
        value = view.getInt32(p, true);
        p += 4;
        break;
      case 6:
        value = view.getUint32(p, true);
        p += 4;
        break;
      case 7:
        value = Number(view.getBigInt64(p, true));
        p += 8;
        break;
      case 8:
        value = Number(view.getBigUint64(p, true));
        p += 8;
        break;
      case 9:
        value = view.getFloat32(p, true);
        p += 4;
        break;
      case 10:
        value = view.getFloat64(p, true);
        p += 8;
        break;
      default: {
        const length = view.getUint32(p, true);
        p += 4;
        const text = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p, Math.min(length, end - p)));
        p += length;
        if (column.type === 14) continue;
        value = column.type === 12 ? parseJson(text) : text;
      }
    }
    props[column.name] = value;
  }
  return props;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
