import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import type { Unproject } from "../geo/projection.ts";
import { projectionFromWkt } from "../geo/projection.ts";
import { assemblePolygons } from "./rings.ts";

export class ShapefileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapefileError";
  }
}

export interface ShapefileParts {
  shp: Uint8Array;
  dbf?: Uint8Array | undefined;
  prj?: string | undefined;
  cpg?: string | undefined;
}

export function shapefileToGeoJSON(parts: ShapefileParts): FeatureCollection {
  const unproject = parts.prj ? projectionFromWkt(parts.prj) : null;
  const shapes = readShp(parts.shp, unproject);
  const records = parts.dbf ? readDbf(parts.dbf, parts.cpg) : [];
  const features: Feature[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const geometry = shapes[i];
    if (!geometry) continue;
    features.push({ type: "Feature", properties: records[i] ?? {}, geometry });
  }
  if (!unproject) {
    for (const f of features) {
      if (outOfRange(f.geometry)) {
        throw new ShapefileError(
          "The shapefile coordinates are not longitude and latitude, and there is no .prj file saying which projection they use",
        );
      }
    }
  }
  return { type: "FeatureCollection", features };
}

function outOfRange(g: Geometry | null): boolean {
  if (!g) return false;
  const check = (p: Position) => Math.abs(p[0]!) > 180.5 || Math.abs(p[1]!) > 90.5;
  switch (g.type) {
    case "Point":
      return check(g.coordinates);
    case "MultiPoint":
    case "LineString":
      return g.coordinates.some(check);
    case "MultiLineString":
    case "Polygon":
      return g.coordinates.some((l) => l.some(check));
    case "MultiPolygon":
      return g.coordinates.some((p) => p.some((l) => l.some(check)));
    default:
      return false;
  }
}

function readShp(bytes: Uint8Array, unproject: Unproject | null): (Geometry | null)[] {
  if (bytes.length < 100) throw new ShapefileError("The .shp file is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, false) !== 9994) throw new ShapefileError("The .shp file has the wrong signature");
  const end = Math.min(bytes.length, view.getInt32(24, false) * 2);
  const point = (o: number): Position => {
    const x = view.getFloat64(o, true);
    const y = view.getFloat64(o + 8, true);
    return unproject ? unproject(x, y) : [x, y];
  };
  const out: (Geometry | null)[] = [];
  let p = 100;
  while (p + 12 <= end) {
    const length = view.getInt32(p + 4, false) * 2;
    const start = p + 8;
    p = start + length;
    if (length < 4 || p > end) break;
    const type = view.getInt32(start, true);
    out.push(readShape(view, start, type, point));
  }
  return out;
}

function readShape(view: DataView, o: number, type: number, point: (o: number) => Position): Geometry | null {
  switch (type) {
    case 0:
      return null;
    case 1:
    case 11:
    case 21:
      return { type: "Point", coordinates: point(o + 4) };
    case 8:
    case 18:
    case 28: {
      const count = view.getInt32(o + 36, true);
      const coordinates: Position[] = [];
      for (let i = 0; i < count; i++) coordinates.push(point(o + 40 + i * 16));
      return coordinates.length === 1
        ? { type: "Point", coordinates: coordinates[0]! }
        : { type: "MultiPoint", coordinates };
    }
    case 3:
    case 13:
    case 23:
    case 5:
    case 15:
    case 25: {
      const numParts = view.getInt32(o + 36, true);
      const numPoints = view.getInt32(o + 40, true);
      const partsAt = o + 44;
      const pointsAt = partsAt + numParts * 4;
      const rings: Position[][] = [];
      for (let k = 0; k < numParts; k++) {
        const from = view.getInt32(partsAt + k * 4, true);
        const to = k + 1 < numParts ? view.getInt32(partsAt + (k + 1) * 4, true) : numPoints;
        const ring: Position[] = [];
        for (let i = from; i < to; i++) ring.push(point(pointsAt + i * 16));
        if (ring.length > 0) rings.push(ring);
      }
      const polygon = type === 5 || type === 15 || type === 25;
      if (!polygon) {
        const lines = rings.filter((r) => r.length >= 2);
        if (lines.length === 0) return null;
        return lines.length === 1
          ? { type: "LineString", coordinates: lines[0]! }
          : { type: "MultiLineString", coordinates: lines };
      }
      return assemblePolygons(rings.filter((r) => r.length >= 4));
    }
    default:
      return null;
  }
}

function readDbf(bytes: Uint8Array, cpg: string | undefined): Record<string, unknown>[] {
  if (bytes.length < 32) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const headerSize = view.getUint16(8, true);
  const recordSize = view.getUint16(10, true);
  const decoder = textDecoder(cpg, bytes[29]!);
  const fields: { name: string; type: string; offset: number; length: number }[] = [];
  let offset = 1;
  for (let p = 32; p + 32 <= headerSize && bytes[p] !== 0x0d; p += 32) {
    let nameEnd = p;
    while (nameEnd < p + 11 && bytes[nameEnd] !== 0) nameEnd++;
    const length = bytes[p + 16]!;
    fields.push({
      name: decoder.decode(bytes.subarray(p, nameEnd)).trim(),
      type: String.fromCharCode(bytes[p + 11]!),
      offset,
      length,
    });
    offset += length;
  }
  const records: Record<string, unknown>[] = [];
  for (let r = 0; r < count; r++) {
    const start = headerSize + r * recordSize;
    if (start + recordSize > bytes.length) break;
    const props: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = decoder.decode(bytes.subarray(start + f.offset, start + f.offset + f.length)).trim();
      props[f.name] = fieldValue(f.type, raw);
    }
    records.push(props);
  }
  return records;
}

function fieldValue(type: string, raw: string): unknown {
  switch (type) {
    case "N":
    case "F": {
      if (raw === "" || /^\*+$/.test(raw)) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "L":
      return /^[YyTt]/.test(raw) ? true : /^[NnFf]/.test(raw) ? false : null;
    case "D":
      return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
    default:
      return raw;
  }
}

const LANGUAGE_DRIVERS: Record<number, string> = {
  1: "ibm437",
  2: "ibm850",
  3: "windows-1252",
  87: "windows-1252",
  77: "gbk",
  78: "euc-kr",
  79: "big5",
  123: "euc-kr",
  125: "windows-1255",
  126: "windows-1256",
  200: "windows-1250",
  201: "windows-1251",
  202: "windows-1254",
  203: "windows-1253",
};

function textDecoder(cpg: string | undefined, driver: number): TextDecoder {
  const labels = [cpg?.trim(), LANGUAGE_DRIVERS[driver], "utf-8"];
  for (const label of labels) {
    if (!label) continue;
    try {
      return new TextDecoder(label);
    } catch {}
  }
  return new TextDecoder();
}
