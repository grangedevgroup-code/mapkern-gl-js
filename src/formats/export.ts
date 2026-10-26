import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";

type Input = Feature | FeatureCollection | Geometry;

function featuresOf(data: Input): Feature[] {
  if (data.type === "FeatureCollection") return data.features;
  if (data.type === "Feature") return [data];
  return [{ type: "Feature", properties: {}, geometry: data }];
}

function xml(text: unknown): string {
  let out = "";
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : ch;
  }
  return out;
}

function number(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 1e9) / 1e9) : "0";
}

function textValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export interface KmlWriteOptions {
  name?: string;
}

export function geoJSONToKml(data: Input, options: KmlWriteOptions = {}): string {
  const coords = (ps: Position[]) => ps.map((p) => p.slice(0, 3).map(number).join(",")).join(" ");
  const geometry = (g: Geometry): string => {
    switch (g.type) {
      case "Point":
        return `<Point><coordinates>${coords([g.coordinates])}</coordinates></Point>`;
      case "LineString":
        return `<LineString><coordinates>${coords(g.coordinates)}</coordinates></LineString>`;
      case "Polygon":
        return `<Polygon>${g.coordinates
          .map(
            (ring, i) =>
              `<${i === 0 ? "outerBoundaryIs" : "innerBoundaryIs"}><LinearRing><coordinates>${coords(ring)}</coordinates></LinearRing></${i === 0 ? "outerBoundaryIs" : "innerBoundaryIs"}>`,
          )
          .join("")}</Polygon>`;
      case "MultiPoint":
        return `<MultiGeometry>${g.coordinates.map((p) => geometry({ type: "Point", coordinates: p })).join("")}</MultiGeometry>`;
      case "MultiLineString":
        return `<MultiGeometry>${g.coordinates.map((l) => geometry({ type: "LineString", coordinates: l })).join("")}</MultiGeometry>`;
      case "MultiPolygon":
        return `<MultiGeometry>${g.coordinates.map((p) => geometry({ type: "Polygon", coordinates: p })).join("")}</MultiGeometry>`;
      case "GeometryCollection":
        return `<MultiGeometry>${g.geometries.map(geometry).join("")}</MultiGeometry>`;
    }
  };
  const placemarks = featuresOf(data).map((f) => {
    const props = { ...(f.properties ?? {}) };
    const name = props.name;
    const description = props.description;
    delete props.name;
    delete props.description;
    const extended = Object.entries(props)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(textValue(v))}</value></Data>`)
      .join("");
    return [
      f.id !== undefined ? `<Placemark id="${xml(f.id)}">` : "<Placemark>",
      name !== undefined && name !== null ? `<name>${xml(textValue(name))}</name>` : "",
      description !== undefined && description !== null
        ? `<description>${xml(textValue(description))}</description>`
        : "",
      extended ? `<ExtendedData>${extended}</ExtendedData>` : "",
      f.geometry ? geometry(f.geometry) : "",
      "</Placemark>",
    ].join("");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
    options.name ? `<name>${xml(options.name)}</name>` : "",
    ...placemarks,
    "</Document></kml>",
    "",
  ].join("\n");
}

export interface GpxWriteOptions {
  creator?: string;
}

export function geoJSONToGpx(data: Input, options: GpxWriteOptions = {}): string {
  const point = (tag: string, p: Position, inner = "") =>
    `<${tag} lat="${number(p[1]!)}" lon="${number(p[0]!)}">${p.length > 2 && Number.isFinite(p[2]) ? `<ele>${number(p[2]!)}</ele>` : ""}${inner}</${tag}>`;
  const describe = (props: Record<string, unknown>) =>
    ["name", "cmt", "desc", "src", "sym", "type"]
      .filter((k) => props[k] !== undefined && props[k] !== null && typeof props[k] !== "object")
      .map((k) => `<${k}>${xml(props[k])}</${k}>`)
      .join("");
  const waypoints: string[] = [];
  const tracks: string[] = [];
  const add = (g: Geometry, props: Record<string, unknown>) => {
    switch (g.type) {
      case "Point": {
        const time = typeof props.time === "string" ? `<time>${xml(props.time)}</time>` : "";
        waypoints.push(point("wpt", g.coordinates, time + describe(props)));
        return;
      }
      case "MultiPoint":
        for (const p of g.coordinates) add({ type: "Point", coordinates: p }, props);
        return;
      case "LineString":
      case "MultiLineString":
      case "Polygon":
      case "MultiPolygon": {
        const lines =
          g.type === "LineString"
            ? [g.coordinates]
            : g.type === "MultiLineString"
              ? g.coordinates
              : g.type === "Polygon"
                ? [g.coordinates[0] ?? []]
                : g.coordinates.map((p) => p[0] ?? []);
        const segments = lines
          .filter((l) => l.length > 0)
          .map((l) => `<trkseg>${l.map((p) => point("trkpt", p)).join("")}</trkseg>`)
          .join("");
        if (segments) tracks.push(`<trk>${describe(props)}${segments}</trk>`);
        return;
      }
      case "GeometryCollection":
        for (const part of g.geometries) add(part, props);
    }
  };
  for (const f of featuresOf(data)) if (f.geometry) add(f.geometry, f.properties ?? {});
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xml(options.creator ?? "Mapkern")}" xmlns="http://www.topografix.com/GPX/1/1">`,
    ...waypoints,
    ...tracks,
    "</gpx>",
    "",
  ].join("\n");
}

export function geometryToWkt(g: Geometry | null): string {
  if (!g) return "GEOMETRYCOLLECTION EMPTY";
  const z = hasZ(g);
  const p = (c: Position) => (z ? [c[0]!, c[1]!, c[2] ?? 0] : [c[0]!, c[1]!]).map(number).join(" ");
  const line = (cs: Position[]) => `(${cs.map(p).join(", ")})`;
  const poly = (rings: Position[][]) => `(${rings.map(line).join(", ")})`;
  const tag = (name: string) => (z ? `${name} Z` : name);
  switch (g.type) {
    case "Point":
      return `${tag("POINT")} (${p(g.coordinates)})`;
    case "LineString":
      return g.coordinates.length ? `${tag("LINESTRING")} ${line(g.coordinates)}` : "LINESTRING EMPTY";
    case "Polygon":
      return g.coordinates.length ? `${tag("POLYGON")} ${poly(g.coordinates)}` : "POLYGON EMPTY";
    case "MultiPoint":
      return g.coordinates.length
        ? `${tag("MULTIPOINT")} (${g.coordinates.map((c) => `(${p(c)})`).join(", ")})`
        : "MULTIPOINT EMPTY";
    case "MultiLineString":
      return g.coordinates.length
        ? `${tag("MULTILINESTRING")} (${g.coordinates.map(line).join(", ")})`
        : "MULTILINESTRING EMPTY";
    case "MultiPolygon":
      return g.coordinates.length
        ? `${tag("MULTIPOLYGON")} (${g.coordinates.map(poly).join(", ")})`
        : "MULTIPOLYGON EMPTY";
    case "GeometryCollection":
      return g.geometries.length
        ? `GEOMETRYCOLLECTION (${g.geometries.map(geometryToWkt).join(", ")})`
        : "GEOMETRYCOLLECTION EMPTY";
  }
}

function hasZ(g: Geometry): boolean {
  switch (g.type) {
    case "Point":
      return g.coordinates.length > 2;
    case "LineString":
    case "MultiPoint":
      return g.coordinates.some((c) => c.length > 2);
    case "Polygon":
    case "MultiLineString":
      return g.coordinates.some((r) => r.some((c) => c.length > 2));
    case "MultiPolygon":
      return g.coordinates.some((p) => p.some((r) => r.some((c) => c.length > 2)));
    case "GeometryCollection":
      return g.geometries.some(hasZ);
  }
}

export function geoJSONToWkt(data: Input): string {
  return `${featuresOf(data)
    .map((f) => geometryToWkt(f.geometry))
    .join("\n")}\n`;
}

export interface CsvWriteOptions {
  geometry?: "auto" | "wkt" | "lonlat";
  delimiter?: string;
}

export function geoJSONToCsv(data: Input, options: CsvWriteOptions = {}): string {
  const features = featuresOf(data);
  const delimiter = options.delimiter ?? ",";
  const points = features.every((f) => f.geometry?.type === "Point");
  const mode = options.geometry === "wkt" || (options.geometry !== "lonlat" && !points) ? "wkt" : "lonlat";
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    for (const k of Object.keys(f.properties ?? {})) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const geometryColumns = mode === "wkt" ? ["wkt"] : ["longitude", "latitude"];
  const columns = [...geometryColumns.filter((c) => !seen.has(c)), ...keys];
  const cell = (v: unknown) => {
    const s = textValue(v);
    return /["\r\n]/.test(s) || s.includes(delimiter) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [columns.map(cell).join(delimiter)];
  for (const f of features) {
    const props = f.properties ?? {};
    const geo: Record<string, unknown> = {};
    if (mode === "wkt") geo.wkt = f.geometry ? geometryToWkt(f.geometry) : "";
    else if (f.geometry?.type === "Point") {
      geo.longitude = f.geometry.coordinates[0];
      geo.latitude = f.geometry.coordinates[1];
    }
    rows.push(columns.map((c) => cell(c in geo && !seen.has(c) ? geo[c] : props[c])).join(delimiter));
  }
  return `${rows.join("\r\n")}\r\n`;
}
