import type { Feature, FeatureCollection } from "../geo/geojson.ts";
import { cotToGeoJSON, isCot } from "./cot.ts";
import { csvToGeoJSON } from "./csv.ts";
import { esriJsonToGeoJSON, isEsriJson } from "./esrijson.ts";
import type { FeatureFormat } from "./feature-format.ts";
import { flatgeobufToGeoJSON, isFlatGeobuf } from "./flatgeobuf.ts";
import { geopackageToGeoJSON, isGeoPackage } from "./geopackage.ts";
import { gmlToGeoJSON, isGml } from "./gml.ts";
import { gpxToGeoJSON } from "./gpx.ts";
import { kmlToGeoJSON } from "./kml.ts";
import { shapefileToGeoJSON } from "./shapefile.ts";
import { isTopology, topologyToGeoJSON } from "./topojson.ts";
import { parseWkt } from "./wkt.ts";
import type { ZipEntry } from "./zip.ts";
import { isZip, readZipEntry, zipEntries } from "./zip.ts";

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const text = new TextDecoder();

export async function bytesToGeoJSON(bytes: Uint8Array, name = "", format?: FeatureFormat): Promise<unknown> {
  const kind = format ?? detect(bytes, name);
  switch (kind) {
    case "flatgeobuf":
      return flatgeobufToGeoJSON(bytes);
    case "geopackage":
      return geopackageToGeoJSON(bytes);
    case "kmz":
    case "shapefile":
      return isZip(bytes) ? fromZip(bytes) : shapefileToGeoJSON({ shp: bytes });
    case "kml":
      return kmlToGeoJSON(text.decode(bytes));
    case "gpx":
      return gpxToGeoJSON(text.decode(bytes));
    case "cot":
      return cotToGeoJSON(text.decode(bytes));
    case "gml":
      return gmlToGeoJSON(text.decode(bytes));
    case "csv":
      return csvToGeoJSON(text.decode(bytes));
    case "wkt":
      return wktToGeoJSON(text.decode(bytes));
    default:
      return jsonToGeoJSON(text.decode(bytes));
  }
}

export function objectToGeoJSON(data: unknown): unknown {
  if (isTopology(data)) return topologyToGeoJSON(data);
  if (isEsriJson(data)) return esriJsonToGeoJSON(data);
  return data;
}

function detect(bytes: Uint8Array, name: string): FeatureFormat {
  if (isFlatGeobuf(bytes)) return "flatgeobuf";
  if (isGeoPackage(bytes)) return "geopackage";
  const ext = extension(name);
  if (isZip(bytes)) return ext === "kmz" ? "kmz" : "shapefile";
  if (ext === "shp") return "shapefile";
  const head = text.decode(bytes.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<")) {
    if (/<gpx[\s>]/i.test(head) || ext === "gpx") return "gpx";
    if (ext === "cot" || isCot(head)) return "cot";
    if (ext === "gml" || isGml(head)) return "gml";
    return "kml";
  }
  if (head.startsWith("{") || head.startsWith("[")) return "geojson";
  if (
    ext === "wkt" ||
    /^(SRID=\d+;)?\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i.test(
      head,
    )
  ) {
    return "wkt";
  }
  if (ext === "csv" || ext === "tsv" || ext === "txt") return "csv";
  return "csv";
}

function extension(name: string): string {
  const clean = name.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
}

function jsonToGeoJSON(source: string): unknown {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new FormatError(`The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return objectToGeoJSON(data);
}

function wktToGeoJSON(source: string): FeatureCollection {
  const features: Feature[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim()) features.push({ type: "Feature", properties: {}, geometry: parseWkt(line) });
  }
  return { type: "FeatureCollection", features };
}

async function fromZip(bytes: Uint8Array): Promise<FeatureCollection> {
  const entries = zipEntries(bytes).filter((e) => !e.name.endsWith("/") && !/(^|\/)__MACOSX\//.test(e.name));
  const byExt = (ext: string) => entries.filter((e) => extension(e.name) === ext);
  const read = (entry: ZipEntry) => readZipEntry(bytes, entry);
  const features: Feature[] = [];
  const add = (data: unknown) => {
    const fc = data as FeatureCollection;
    if (fc && Array.isArray(fc.features)) for (const f of fc.features) features.push(f);
  };
  const kml = byExt("kml").sort((a, b) => (a.name === "doc.kml" ? -1 : b.name === "doc.kml" ? 1 : 0));
  for (const entry of kml) add(kmlToGeoJSON(text.decode(await read(entry))));
  for (const shp of byExt("shp")) {
    const base = shp.name.slice(0, -4).toLowerCase();
    const sibling = (ext: string) => entries.find((e) => e.name.toLowerCase() === `${base}.${ext}`);
    const dbf = sibling("dbf");
    const prj = sibling("prj");
    const cpg = sibling("cpg");
    add(
      shapefileToGeoJSON({
        shp: await read(shp),
        dbf: dbf ? await read(dbf) : undefined,
        prj: prj ? text.decode(await read(prj)) : undefined,
        cpg: cpg ? text.decode(await read(cpg)) : undefined,
      }),
    );
  }
  for (const entry of [...byExt("geojson"), ...byExt("json")]) add(jsonToGeoJSON(text.decode(await read(entry))));
  for (const entry of byExt("gpx")) add(gpxToGeoJSON(text.decode(await read(entry))));
  for (const entry of byExt("gml")) add(gmlToGeoJSON(text.decode(await read(entry))));
  for (const entry of byExt("fgb")) add(flatgeobufToGeoJSON(await read(entry)));
  for (const entry of byExt("gpkg")) add(await geopackageToGeoJSON(await read(entry)));
  for (const entry of byExt("csv")) add(csvToGeoJSON(text.decode(await read(entry))));
  for (const entry of [...byExt("cot"), ...byExt("xml")]) {
    const source = text.decode(await read(entry));
    if (isCot(source)) add(cotToGeoJSON(source));
  }
  if (features.length === 0 && kml.length === 0 && byExt("shp").length === 0) {
    throw new FormatError(
      "The ZIP file has no map data in it (looked for KML, Shapefile, GeoJSON, GPX, GML, FlatGeobuf, GeoPackage, CSV and CoT)",
    );
  }
  return { type: "FeatureCollection", features };
}
