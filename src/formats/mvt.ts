import { BYTES, decodeUtf8, Reader } from "./protobuf.ts";

export type FeatureType = 0 | 1 | 2 | 3;
export type PropertyValue = string | number | boolean;

export interface VectorFeature {
  readonly id: number | undefined;
  readonly type: FeatureType;
  readonly extent: number;
  properties(): Record<string, PropertyValue>;
  property(key: string): PropertyValue | undefined;
  geometry(): Int32Array[];
}

export class VectorLayer {
  readonly name: string;
  readonly extent: number;
  readonly version: number;
  private readonly buf: Uint8Array;
  private readonly features: [number, number][];
  private readonly keys: string[];
  private readonly values: PropertyValue[];

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf;
    const r = new Reader(buf, start, end);
    let name = "";
    let extent = 4096;
    let version = 1;
    const features: [number, number][] = [];
    const keys: string[] = [];
    const values: PropertyValue[] = [];
    while (!r.done) {
      const tag = r.tag();
      const field = tag >> 3;
      const wire = tag & 7;
      if (field === 1 && wire === BYTES) name = r.string();
      else if (field === 2 && wire === BYTES) {
        const len = r.varint();
        features.push([r.pos, r.pos + len]);
        r.pos += len;
        if (r.pos > r.end) throw new Error("Feature runs past the end of its layer");
      } else if (field === 3 && wire === BYTES) keys.push(r.string());
      else if (field === 4 && wire === BYTES) values.push(readValue(r.sub()));
      else if (field === 5) extent = r.varint();
      else if (field === 15) version = r.varint();
      else r.skip(wire);
    }
    if (extent <= 0 || extent > 1 << 20) throw new Error(`Layer ${name} has an invalid extent ${extent}`);
    this.name = name;
    this.extent = extent;
    this.version = version;
    this.features = features;
    this.keys = keys;
    this.values = values;
  }

  get length(): number {
    return this.features.length;
  }

  feature(index: number): VectorFeature {
    const range = this.features[index];
    if (!range) throw new RangeError(`Feature ${index} is out of range`);
    return decodeFeature(this.buf, range[0], range[1], this.keys, this.values, this.extent);
  }
}

function readValue(r: Reader): PropertyValue {
  let value: PropertyValue = "";
  while (!r.done) {
    const tag = r.tag();
    switch (tag >> 3) {
      case 1:
        value = r.string();
        break;
      case 2:
        value = r.float();
        break;
      case 3:
        value = r.double();
        break;
      case 4:
        value = r.int64();
        break;
      case 5:
        value = r.varint();
        break;
      case 6:
        value = r.svarint();
        break;
      case 7:
        value = r.bool();
        break;
      default:
        r.skip(tag & 7);
    }
  }
  return value;
}

function decodeFeature(
  buf: Uint8Array,
  start: number,
  end: number,
  keys: string[],
  values: PropertyValue[],
  extent: number,
): VectorFeature {
  const r = new Reader(buf, start, end);
  let id: number | undefined;
  let type: FeatureType = 0;
  let tagStart = -1;
  let tagEnd = -1;
  let geomStart = -1;
  let geomEnd = -1;
  while (!r.done) {
    const tag = r.tag();
    const field = tag >> 3;
    if (field === 1) id = r.varint();
    else if (field === 2) {
      tagEnd = r.packedEnd();
      tagStart = r.pos;
      r.pos = tagEnd;
    } else if (field === 3) {
      const t = r.varint();
      type = t === 1 || t === 2 || t === 3 ? t : 0;
    } else if (field === 4) {
      geomEnd = r.packedEnd();
      geomStart = r.pos;
      r.pos = geomEnd;
    } else r.skip(tag & 7);
  }
  let props: Record<string, PropertyValue> | null = null;
  const properties = (): Record<string, PropertyValue> => {
    if (props) return props;
    props = {};
    if (tagStart >= 0) {
      const t = new Reader(buf, tagStart, tagEnd);
      while (!t.done) {
        const k = keys[t.varint()];
        if (t.done) break;
        const v = values[t.varint()];
        if (k !== undefined && v !== undefined) props[k] = v;
      }
    }
    return props;
  };
  return {
    id,
    type,
    extent,
    properties,
    property(key: string) {
      return properties()[key];
    },
    geometry() {
      return geomStart >= 0 ? decodeGeometry(buf, geomStart, geomEnd, type) : [];
    },
  };
}

const MAX_POINTS = 1 << 22;

export function decodeGeometry(buf: Uint8Array, start: number, end: number, type: FeatureType): Int32Array[] {
  const r = new Reader(buf, start, end);
  const parts: Int32Array[] = [];
  let current: number[] = [];
  let x = 0;
  let y = 0;
  let total = 0;
  while (!r.done) {
    const cmd = r.varint();
    const id = cmd & 7;
    const count = cmd >>> 3;
    if (id === 1 || id === 2) {
      if (count === 0) continue;
      total += count;
      if (total > MAX_POINTS) throw new Error("Feature geometry is too large");
      for (let i = 0; i < count; i++) {
        if (r.done) throw new Error("Geometry command runs past the end of the feature");
        x += r.svarint();
        if (r.done) throw new Error("Geometry command runs past the end of the feature");
        y += r.svarint();
        if (id === 1 && type !== 1) {
          if (current.length > 0) parts.push(Int32Array.from(current));
          current = [];
        }
        current.push(x, y);
      }
    } else if (id === 7) {
      if (current.length >= 2) current.push(current[0]!, current[1]!);
    } else {
      throw new Error(`Unknown geometry command ${id}`);
    }
  }
  if (current.length > 0) parts.push(Int32Array.from(current));
  return parts;
}

export function decodeTile(bytes: Uint8Array): Map<string, VectorLayer> {
  const layers = new Map<string, VectorLayer>();
  const r = new Reader(bytes);
  while (!r.done) {
    const tag = r.tag();
    if (tag >> 3 === 3 && (tag & 7) === BYTES) {
      const len = r.varint();
      const layer = new VectorLayer(bytes, r.pos, r.pos + len);
      r.pos += len;
      if (r.pos > r.end) throw new Error("Layer runs past the end of the tile");
      if (!layers.has(layer.name)) layers.set(layer.name, layer);
    } else {
      r.skip(tag & 7);
    }
  }
  return layers;
}

export function ringArea(ring: Int32Array): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) sum += (ring[j]! - ring[i]!) * (ring[i + 1]! + ring[j + 1]!);
  return sum / 2;
}

export function classifyRings(rings: Int32Array[]): Int32Array[][] {
  const polygons: Int32Array[][] = [];
  let current: Int32Array[] | null = null;
  let exteriorSign = 0;
  for (const ring of rings) {
    if (ring.length < 8) continue;
    const area = ringArea(ring);
    if (area === 0) continue;
    const sign = area > 0 ? 1 : -1;
    if (exteriorSign === 0) exteriorSign = sign;
    if (sign === exteriorSign || !current) {
      current = [ring];
      polygons.push(current);
    } else {
      current.push(ring);
    }
  }
  return polygons;
}

export function numericId(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  return undefined;
}

export { decodeUtf8 };
