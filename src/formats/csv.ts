import type { Feature, FeatureCollection, Geometry } from "../geo/geojson.ts";
import { fromMgrs } from "../geo/mgrs.ts";
import { parseHexWkb } from "./wkb.ts";
import { parseWkt } from "./wkt.ts";

const LAT_NAMES = ["lat", "latitude", "y", "lat_dd", "latitude_dd", "ylat", "point_y"];
const LON_NAMES = ["lon", "lng", "long", "longitude", "x", "lon_dd", "longitude_dd", "xlon", "point_x"];
const WKT_NAMES = ["wkt", "geometry", "geom", "the_geom", "shape", "wkt_geom", "wkb_geometry", "wkb"];
const HEX_WKB = /^(?:\\x)?(0[01][0-9a-f]{8,})$/i;
const GRID_NAMES = ["mgrs", "grid", "mgrs_grid", "usng", "grid_ref", "gridref"];
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export function csvToGeoJSON(text: string): FeatureCollection {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header || header.length === 0) throw new CsvError("The CSV file is empty");
  const names = header.map((h) => h.trim());
  const lower = names.map((h) => h.toLowerCase());
  const find = (candidates: string[]) => {
    for (const c of candidates) {
      const i = lower.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };
  const latIndex = find(LAT_NAMES);
  const lonIndex = find(LON_NAMES);
  const wktIndex = find(WKT_NAMES);
  const gridIndex = find(GRID_NAMES);
  if (wktIndex < 0 && gridIndex < 0 && (latIndex < 0 || lonIndex < 0)) {
    throw new CsvError("The CSV file needs latitude and longitude columns, an MGRS column, or a WKT geometry column");
  }
  const features: Feature[] = [];
  for (const row of rows) {
    if (row.length === 1 && row[0]!.trim() === "") continue;
    let geometry: Geometry | null = null;
    if (wktIndex >= 0 && row[wktIndex]?.trim()) {
      try {
        geometry = parseWkt(row[wktIndex]!);
      } catch {
        geometry = null;
      }
    }
    if (!geometry && latIndex >= 0 && lonIndex >= 0) {
      const lat = Number(row[latIndex]);
      const lon = Number(row[lonIndex]);
      if (row[latIndex]?.trim() && row[lonIndex]?.trim() && Number.isFinite(lat) && Number.isFinite(lon)) {
        geometry = { type: "Point", coordinates: [lon, lat] };
      }
    }
    if (!geometry && gridIndex >= 0 && row[gridIndex]?.trim()) {
      const point = fromMgrs(row[gridIndex]!);
      if (point) geometry = { type: "Point", coordinates: point.lngLat };
    }
    if (!geometry) continue;
    const properties: Record<string, unknown> = {};
    for (let c = 0; c < names.length; c++) {
      if (c === wktIndex) continue;
      const raw = row[c] ?? "";
      properties[names[c] || `column${c + 1}`] = NUMBER.test(raw.trim()) ? Number(raw) : raw;
    }
    features.push({ type: "Feature", properties, geometry });
  }
  return { type: "FeatureCollection", features };
}

export function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += c;
    }
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text: string): string {
  const end = text.search(/\r|\n/);
  const line = end < 0 ? text : text.slice(0, end);
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    let count = 0;
    let quoted = false;
    for (const c of line) {
      if (c === '"') quoted = !quoted;
      else if (c === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}
