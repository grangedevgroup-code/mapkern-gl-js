import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import type { Unproject } from "../geo/projection.ts";
import { ProjectionError, projectionFromEpsg, projectionFromWkt } from "../geo/projection.ts";
import type { ByteRanges, SchemaRow, SqlValue } from "./sqlite.ts";
import { SqliteReader } from "./sqlite.ts";
import { parseGeoPackageGeometry } from "./wkb.ts";

export class GeoPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoPackageError";
  }
}

const IDS = new Set(["GPKG", "GP10", "GP11"]);

export function isGeoPackage(bytes: Uint8Array): boolean {
  if (bytes.length < 72) return false;
  if (new TextDecoder().decode(bytes.subarray(0, 15)) !== "SQLite format 3") return false;
  return IDS.has(String.fromCharCode(bytes[68]!, bytes[69]!, bytes[70]!, bytes[71]!));
}

interface Columns {
  names: string[];
  types: string[];
  rowid: number;
}

export function tableColumns(sql: string): Columns {
  const clean = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const open = clean.indexOf("(");
  if (open < 0) throw new GeoPackageError("A table definition has no columns");
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = open + 1;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i]!;
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "[") quote = "]";
    else if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) {
        parts.push(clean.slice(start, i));
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      parts.push(clean.slice(start, i));
      start = i + 1;
    }
  }
  const names: string[] = [];
  const types: string[] = [];
  let rowid = -1;
  let tableKey: string | null = null;
  for (const raw of parts) {
    const part = raw.trim();
    const constraint = /^(constraint|primary|unique|check|foreign)\b/i.exec(part);
    if (constraint) {
      const key = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (key?.[1] && !key[1].includes(",")) tableKey = unquote(key[1].trim().split(/\s+/)[0]!);
      continue;
    }
    const [name, rest] = identifier(part);
    names.push(name);
    const type = /^\s*([A-Za-z]+)/.exec(rest)?.[1]?.toUpperCase() ?? "";
    types.push(type);
    if (type === "INTEGER" && /\bprimary\s+key\b(?!\s+desc)/i.test(rest)) rowid = names.length - 1;
  }
  if (rowid < 0 && tableKey !== null) {
    const i = names.findIndex((n) => n.toLowerCase() === tableKey!.toLowerCase());
    if (i >= 0 && types[i] === "INTEGER") rowid = i;
  }
  return { names, types, rowid };
}

function identifier(part: string): [string, string] {
  const first = part[0];
  const close = first === '"' ? '"' : first === "`" ? "`" : first === "[" ? "]" : first === "'" ? "'" : "";
  if (close) {
    let i = 1;
    let name = "";
    while (i < part.length) {
      const c = part[i]!;
      if (c === close) {
        if (close !== "]" && part[i + 1] === close) {
          name += c;
          i += 2;
          continue;
        }
        return [name, part.slice(i + 1)];
      }
      name += c;
      i++;
    }
    return [name, ""];
  }
  const m = /^(\S+)([\s\S]*)$/.exec(part);
  return [m?.[1] ?? part, m?.[2] ?? ""];
}

function unquote(name: string): string {
  return identifier(name)[0];
}

class MemoryRanges implements ByteRanges {
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  read(offset: number, length: number): Promise<{ data: Uint8Array }> {
    return Promise.resolve({ data: this.bytes.subarray(offset, offset + length) });
  }
}

type Row = Record<string, SqlValue>;

async function readTable(db: SqliteReader, table: SchemaRow, signal: AbortSignal): Promise<Row[]> {
  const { names, rowid } = tableColumns(table.sql);
  const rows: Row[] = [];
  await db.scan(table.root, signal, (id, values) => {
    const row: Row = {};
    names.forEach((name, i) => {
      row[name] = i === rowid ? id : (values[i] ?? null);
    });
    rows.push(row);
  });
  return rows;
}

function projection(srs: Row | undefined, table: string): Unproject | null {
  if (!srs) return null;
  const organization = String(srs.organization ?? "").toUpperCase();
  const code = Number(srs.organization_coordsys_id);
  const definition = typeof srs.definition === "string" ? srs.definition.trim() : "";
  if (Number(srs.srs_id) <= 0 || code <= 0) return null;
  if (organization === "EPSG" && Number.isFinite(code)) {
    try {
      return projectionFromEpsg(code);
    } catch (error) {
      if (!(error instanceof ProjectionError) || !definition || definition === "undefined") throw error;
    }
  }
  if (!definition || definition === "undefined") {
    throw new GeoPackageError(
      `The layer "${table}" uses ${organization}:${code}, which has no definition to convert from`,
    );
  }
  return projectionFromWkt(definition);
}

function convert(geometry: Geometry, unproject: Unproject): Geometry {
  const point = (p: Position): Position => {
    const [x, y] = unproject(p[0]!, p[1]!);
    return p.length > 2 ? [x, y, p[2]!] : [x, y];
  };
  switch (geometry.type) {
    case "Point":
      return { type: "Point", coordinates: point(geometry.coordinates) };
    case "MultiPoint":
      return { type: "MultiPoint", coordinates: geometry.coordinates.map(point) };
    case "LineString":
      return { type: "LineString", coordinates: geometry.coordinates.map(point) };
    case "MultiLineString":
      return { type: "MultiLineString", coordinates: geometry.coordinates.map((l) => l.map(point)) };
    case "Polygon":
      return { type: "Polygon", coordinates: geometry.coordinates.map((r) => r.map(point)) };
    case "MultiPolygon":
      return { type: "MultiPolygon", coordinates: geometry.coordinates.map((p) => p.map((r) => r.map(point))) };
    case "GeometryCollection":
      return { type: "GeometryCollection", geometries: geometry.geometries.map((g) => convert(g, unproject)) };
  }
}

export async function geopackageToGeoJSON(
  bytes: Uint8Array,
  signal: AbortSignal = new AbortController().signal,
): Promise<FeatureCollection> {
  const db = new SqliteReader(new MemoryRanges(bytes));
  const schema = await db.schema(signal);
  const tables = new Map(schema.filter((r) => r.type === "table").map((r) => [r.name.toLowerCase(), r]));
  const table = async (name: string) => {
    const t = tables.get(name);
    return t ? readTable(db, t, signal) : [];
  };
  const contents = await table("gpkg_contents");
  if (!tables.has("gpkg_contents")) throw new GeoPackageError("The file is an SQLite database but not a GeoPackage");
  const columns = new Map((await table("gpkg_geometry_columns")).map((r) => [String(r.table_name).toLowerCase(), r]));
  const systems = new Map((await table("gpkg_spatial_ref_sys")).map((r) => [Number(r.srs_id), r]));
  const layers = contents.filter((r) => String(r.data_type).toLowerCase() === "features");
  const features: Feature[] = [];
  for (const layer of layers) {
    const name = String(layer.table_name);
    const definition = tables.get(name.toLowerCase());
    const column = columns.get(name.toLowerCase());
    if (!definition || !column) continue;
    const geometryColumn = String(column.column_name);
    const unproject = projection(systems.get(Number(column.srs_id)), name);
    const { names, types, rowid } = tableColumns(definition.sql);
    await db.scan(definition.root, signal, (id, values) => {
      const properties: Record<string, unknown> = {};
      let geometry: Geometry | null = null;
      names.forEach((field, i) => {
        const value = i === rowid ? id : (values[i] ?? null);
        if (field === geometryColumn) {
          geometry = value instanceof Uint8Array ? parseGeoPackageGeometry(value) : null;
          return;
        }
        if (i === rowid || value instanceof Uint8Array) return;
        properties[field] = types[i] === "BOOLEAN" && typeof value === "number" ? value !== 0 : value;
      });
      if (layers.length > 1 && !("layer" in properties)) properties.layer = name;
      const shape = geometry as Geometry | null;
      features.push({
        type: "Feature",
        id,
        properties,
        geometry: shape && unproject ? convert(shape, unproject) : shape,
      });
    });
  }
  return { type: "FeatureCollection", features };
}
