import type { Geometry, Position } from "../geo/geojson.ts";

export class WkbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WkbError";
  }
}

export function parseWkb(bytes: Uint8Array, start = 0): { geometry: Geometry | null; end: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start;
  const need = (n: number) => {
    if (p + n > bytes.length) throw new WkbError("The WKB geometry ends too early");
  };
  const read = (): Geometry | null => {
    need(5);
    const little = bytes[p] === 1;
    p += 1;
    let type = view.getUint32(p, little);
    p += 4;
    let z = (type & 0x80000000) !== 0;
    let m = (type & 0x40000000) !== 0;
    if (type & 0x20000000) {
      need(4);
      p += 4;
    }
    type &= 0x0fffffff;
    if (type >= 3000) {
      z = true;
      m = true;
      type -= 3000;
    } else if (type >= 2000) {
      m = true;
      type -= 2000;
    } else if (type >= 1000) {
      z = true;
      type -= 1000;
    }
    const size = (2 + (z ? 1 : 0) + (m ? 1 : 0)) * 8;
    const point = (): Position => {
      need(size);
      const x = view.getFloat64(p, little);
      const y = view.getFloat64(p + 8, little);
      const height = z ? view.getFloat64(p + 16, little) : Number.NaN;
      p += size;
      return Number.isNaN(height) ? [x, y] : [x, y, height];
    };
    const count = () => {
      need(4);
      const n = view.getUint32(p, little);
      p += 4;
      if (n > bytes.length) throw new WkbError("The WKB geometry has an impossible count");
      return n;
    };
    const points = (): Position[] => {
      const n = count();
      const out: Position[] = [];
      for (let i = 0; i < n; i++) out.push(point());
      return out;
    };
    const rings = (): Position[][] => {
      const n = count();
      const out: Position[][] = [];
      for (let i = 0; i < n; i++) out.push(points());
      return out;
    };
    switch (type) {
      case 1: {
        const at = point();
        return Number.isNaN(at[0]!) || Number.isNaN(at[1]!) ? null : { type: "Point", coordinates: at };
      }
      case 2:
        return { type: "LineString", coordinates: points() };
      case 3:
        return { type: "Polygon", coordinates: rings() };
      case 4:
      case 5:
      case 6:
      case 7: {
        const n = count();
        const parts: Geometry[] = [];
        for (let i = 0; i < n; i++) {
          const part = read();
          if (part) parts.push(part);
        }
        if (type === 7) return { type: "GeometryCollection", geometries: parts };
        if (type === 4) {
          return {
            type: "MultiPoint",
            coordinates: parts.flatMap((g) => (g.type === "Point" ? [g.coordinates] : [])),
          };
        }
        if (type === 5) {
          return {
            type: "MultiLineString",
            coordinates: parts.flatMap((g) => (g.type === "LineString" ? [g.coordinates] : [])),
          };
        }
        return {
          type: "MultiPolygon",
          coordinates: parts.flatMap((g) => (g.type === "Polygon" ? [g.coordinates] : [])),
        };
      }
      default:
        throw new WkbError(`WKB geometry type ${type} is not supported`);
    }
  };
  const geometry = read();
  return { geometry, end: p };
}

export function parseHexWkb(hex: string): Geometry | null {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) throw new WkbError("Not a hex WKB string");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return parseWkb(bytes).geometry;
}

export function parseGeoPackageGeometry(blob: Uint8Array): Geometry | null {
  if (blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) return parseWkb(blob).geometry;
  const flags = blob[3]!;
  if (flags & 0x10) return null;
  const envelope = (flags >> 1) & 7;
  const size = [0, 32, 48, 48, 64][envelope];
  if (size === undefined) throw new WkbError("The GeoPackage geometry has an unknown envelope");
  return parseWkb(blob, 8 + size).geometry;
}
