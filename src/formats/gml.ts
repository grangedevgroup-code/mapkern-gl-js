import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import type { Unproject } from "../geo/projection.ts";
import { projectionFromEpsg } from "../geo/projection.ts";
import type { XmlElement } from "./xml.ts";
import { child, children, parseXml, textOf } from "./xml.ts";

export class GmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmlError";
  }
}

const GEOMETRIES = new Set([
  "Point",
  "LineString",
  "Curve",
  "LinearRing",
  "Polygon",
  "Surface",
  "PolyhedralSurface",
  "MultiPoint",
  "MultiLineString",
  "MultiCurve",
  "MultiPolygon",
  "MultiSurface",
  "MultiGeometry",
  "GeometryCollection",
  "Envelope",
  "Box",
]);
const MEMBERS = new Set(["featureMember", "featureMembers", "member"]);
const GEOGRAPHIC = new Set([4326, 4258, 4269, 4267, 4283, 4617, 4674, 4979, 4937, 4171]);
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;

export function isGml(head: string): boolean {
  return /xmlns:gml\s*=|<gml:|<wfs:FeatureCollection/.test(head) && !/<kml[\s>]/i.test(head);
}

interface Crs {
  swap: boolean;
  unproject: Unproject | null;
}

const PLAIN: Crs = { swap: false, unproject: null };

function crsOf(name: string | undefined, parent: Crs): Crs {
  if (!name) return parent;
  const trimmed = name.trim();
  let start = trimmed.length;
  while (start > 0 && trimmed.charCodeAt(start - 1) >= 48 && trimmed.charCodeAt(start - 1) <= 57) start--;
  const code = start < trimmed.length ? Number(trimmed.slice(start)) : Number.NaN;
  if (!Number.isFinite(code)) return parent;
  const modern = /^(?:urn:|https?:\/\/www\.opengis\.net\/def\/crs\/)/i.test(name);
  if (GEOGRAPHIC.has(code)) return { swap: modern, unproject: null };
  if (code === 0) return PLAIN;
  return { swap: false, unproject: projectionFromEpsg(code) };
}

function dimension(e: XmlElement, fallback: number): number {
  const d = Number(e.attrs.srsDimension ?? e.attrs.dimension);
  return d === 2 || d === 3 || d === 4 ? d : fallback;
}

function place(values: number[], crs: Crs): Position {
  let x = values[0]!;
  let y = values[1]!;
  if (crs.swap) [x, y] = [y, x];
  if (crs.unproject) [x, y] = crs.unproject(x, y);
  return values.length > 2 && Number.isFinite(values[2]) ? [x, y, values[2]!] : [x, y];
}

function positions(e: XmlElement, crs: Crs, dim: number): Position[] {
  const list = child(e, "posList");
  if (list) {
    const d = dimension(list, dimension(e, dim));
    const n = textOf(list).split(/\s+/).filter(Boolean).map(Number);
    const out: Position[] = [];
    for (let i = 0; i + d <= n.length; i += d) out.push(place(n.slice(i, i + d), crs));
    return out;
  }
  const coordinates = child(e, "coordinates");
  if (coordinates) {
    const cs = coordinates.attrs.cs ?? ",";
    const ts = coordinates.attrs.ts ?? " ";
    const decimal = coordinates.attrs.decimal ?? ".";
    const tuples = textOf(coordinates)
      .split(ts === " " ? /\s+/ : ts)
      .filter((t) => t.trim());
    return tuples.map((t) =>
      place(
        t
          .trim()
          .split(cs)
          .map((v) => Number(decimal === "." ? v : v.split(decimal).join("."))),
        crs,
      ),
    );
  }
  const pos = children(e, "pos");
  if (pos.length > 0) {
    return pos.map((p) => place(textOf(p).split(/\s+/).filter(Boolean).map(Number), crs));
  }
  const coord = children(e, "coord");
  return coord.map((c) => {
    const values = ["X", "Y", "Z"]
      .map((k) => textOf(child(c, k)))
      .filter(Boolean)
      .map(Number);
    return place(values, crs);
  });
}

function ringsOf(polygon: XmlElement, crs: Crs, dim: number): Position[][] {
  const rings: Position[][] = [];
  const ring = (holder: XmlElement | undefined) => {
    const r = holder?.children.find((c) => c.name === "LinearRing" || c.name === "Ring");
    if (!r) return;
    let points = r.name === "Ring" ? curvePoints(r, crs, dim) : positions(r, crs, dimension(r, dim));
    if (points.length > 0) {
      const a = points[0]!;
      const b = points[points.length - 1]!;
      if (a[0] !== b[0] || a[1] !== b[1]) points = [...points, a];
      rings.push(points);
    }
  };
  ring(child(polygon, "exterior") ?? child(polygon, "outerBoundaryIs"));
  for (const holder of [...children(polygon, "interior"), ...children(polygon, "innerBoundaryIs")]) ring(holder);
  return rings;
}

function curvePoints(e: XmlElement, crs: Crs, dim: number): Position[] {
  const out: Position[] = [];
  const add = (pts: Position[]) => {
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  };
  for (const member of children(e, "curveMember")) {
    const g = member.children[0];
    if (g) add(g.name === "LineString" ? positions(g, crs, dimension(g, dim)) : curvePoints(g, crs, dim));
  }
  for (const segments of children(e, "segments")) {
    for (const s of segments.children) add(positions(s, crs, dimension(s, dim)));
  }
  if (out.length === 0) add(positions(e, crs, dim));
  return out;
}

function members(e: XmlElement, single: string, plural: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const m of children(e, single)) if (m.children[0]) out.push(m.children[0]);
  for (const m of children(e, plural)) out.push(...m.children);
  return out;
}

function geometry(e: XmlElement, parent: Crs, dim: number): Geometry | null {
  const crs = crsOf(e.attrs.srsName, parent);
  const d = dimension(e, dim);
  switch (e.name) {
    case "Point": {
      const p = positions(e, crs, d)[0];
      return p ? { type: "Point", coordinates: p } : null;
    }
    case "LineString":
    case "LinearRing": {
      const pts = positions(e, crs, d);
      return pts.length >= 2 ? { type: "LineString", coordinates: pts } : null;
    }
    case "Curve": {
      const pts = curvePoints(e, crs, d);
      return pts.length >= 2 ? { type: "LineString", coordinates: pts } : null;
    }
    case "Polygon": {
      const rings = ringsOf(e, crs, d);
      return rings.length > 0 ? { type: "Polygon", coordinates: rings } : null;
    }
    case "Surface":
    case "PolyhedralSurface": {
      const polygons: Position[][][] = [];
      for (const patches of [...children(e, "patches"), ...children(e, "polygonPatches")]) {
        for (const patch of patches.children) {
          const rings = ringsOf(patch, crs, d);
          if (rings.length > 0) polygons.push(rings);
        }
      }
      if (polygons.length === 0) return null;
      return polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0]! }
        : { type: "MultiPolygon", coordinates: polygons };
    }
    case "Envelope":
    case "Box": {
      const corners =
        e.name === "Envelope"
          ? [child(e, "lowerCorner"), child(e, "upperCorner")].map((c) =>
              place(textOf(c).split(/\s+/).filter(Boolean).map(Number), crs),
            )
          : positions(e, crs, d);
      const [a, b] = corners;
      if (!a || !b) return null;
      return {
        type: "Polygon",
        coordinates: [
          [
            [a[0]!, a[1]!],
            [b[0]!, a[1]!],
            [b[0]!, b[1]!],
            [a[0]!, b[1]!],
            [a[0]!, a[1]!],
          ],
        ],
      };
    }
    case "MultiPoint": {
      const pts = members(e, "pointMember", "pointMembers")
        .map((m) => geometry(m, crs, d))
        .flatMap((g) => (g?.type === "Point" ? [g.coordinates] : []));
      return pts.length > 0 ? { type: "MultiPoint", coordinates: pts } : null;
    }
    case "MultiLineString":
    case "MultiCurve": {
      const lines = [
        ...members(e, "lineStringMember", "lineStringMembers"),
        ...members(e, "curveMember", "curveMembers"),
      ]
        .map((m) => geometry(m, crs, d))
        .flatMap((g) =>
          g?.type === "LineString" ? [g.coordinates] : g?.type === "MultiLineString" ? g.coordinates : [],
        );
      return lines.length > 0 ? { type: "MultiLineString", coordinates: lines } : null;
    }
    case "MultiPolygon":
    case "MultiSurface": {
      const polys = [...members(e, "polygonMember", "polygonMembers"), ...members(e, "surfaceMember", "surfaceMembers")]
        .map((m) => geometry(m, crs, d))
        .flatMap((g) => (g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : []));
      return polys.length > 0 ? { type: "MultiPolygon", coordinates: polys } : null;
    }
    case "MultiGeometry":
    case "GeometryCollection": {
      const parts = members(e, "geometryMember", "geometryMembers")
        .map((m) => geometry(m, crs, d))
        .filter((g): g is Geometry => g !== null);
      return parts.length > 0 ? { type: "GeometryCollection", geometries: parts } : null;
    }
    default:
      return null;
  }
}

function featureOf(e: XmlElement, crs: Crs, dim: number): Feature {
  const properties: Record<string, unknown> = {};
  let shape: Geometry | null = null;
  for (const p of e.children) {
    if (p.name === "boundedBy") continue;
    const inner = p.children[0];
    if (inner && GEOMETRIES.has(inner.name)) {
      const g = geometry(inner, crs, dim);
      if (!shape && g) shape = g;
      else if (g && !(p.name in properties)) properties[p.name] = g;
      continue;
    }
    if (p.children.length > 0) continue;
    const text = p.text.trim();
    if (p.attrs.nil === "true" || p.attrs.nil === "1") properties[p.name] = null;
    else properties[p.name] = NUMBER.test(text) ? Number(text) : text;
  }
  const feature: Feature = { type: "Feature", properties, geometry: shape };
  const id = e.attrs.id ?? e.attrs.fid;
  if (id) feature.id = id;
  return feature;
}

export function gmlToGeoJSON(text: string): FeatureCollection {
  const root = parseXml(text).children[0];
  if (!root) throw new GmlError("The GML file is empty");
  const features: Feature[] = [];
  if (GEOMETRIES.has(root.name)) {
    const g = geometry(root, PLAIN, 2);
    if (g) features.push({ type: "Feature", properties: {}, geometry: g });
  } else {
    collect(root, PLAIN, 2, features);
  }
  return { type: "FeatureCollection", features };
}

function collect(collection: XmlElement, parent: Crs, dim: number, out: Feature[]): void {
  const crs = crsOf(
    child(child(collection, "boundedBy"), "Envelope")?.attrs.srsName ?? collection.attrs.srsName,
    parent,
  );
  const d = dimension(collection, dim);
  const memberElements = collection.children.filter((c) => MEMBERS.has(c.name));
  const items = memberElements.length > 0 ? memberElements.flatMap((m) => m.children) : collection.children;
  for (const item of items) {
    if (item.name === "boundedBy" || item.name === "additionalObjects") continue;
    if (/FeatureCollection$/.test(item.name) || item.children.some((c) => MEMBERS.has(c.name))) {
      collect(item, crs, d, out);
      continue;
    }
    out.push(featureOf(item, crs, d));
  }
}
