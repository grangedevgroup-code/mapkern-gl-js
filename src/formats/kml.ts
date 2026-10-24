import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import type { XmlElement } from "./xml.ts";
import { child, children, descendants, parseXml, textOf } from "./xml.ts";

interface KmlStyle {
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  fill?: string;
  fillOpacity?: number;
  marker?: string;
}

export function kmlToGeoJSON(text: string): FeatureCollection {
  const doc = parseXml(text);
  const styles = readStyles(doc);
  const features: Feature[] = [];
  for (const placemark of descendants(doc, "Placemark")) {
    const geometry = readGeometry(placemark);
    if (!geometry) continue;
    features.push({ type: "Feature", properties: readProperties(placemark, styles), geometry });
  }
  return { type: "FeatureCollection", features };
}

function readGeometry(parent: XmlElement): Geometry | null {
  const geometries: Geometry[] = [];
  for (const node of parent.children) {
    const g = geometry(node);
    if (g) geometries.push(g);
  }
  if (geometries.length === 0) return null;
  return geometries.length === 1 ? geometries[0]! : { type: "GeometryCollection", geometries };
}

function geometry(node: XmlElement): Geometry | null {
  switch (node.name) {
    case "Point": {
      const [position] = coordinates(child(node, "coordinates"));
      return position ? { type: "Point", coordinates: position } : null;
    }
    case "LineString": {
      const line = coordinates(child(node, "coordinates"));
      return line.length >= 2 ? { type: "LineString", coordinates: line } : null;
    }
    case "LinearRing": {
      const ring = coordinates(child(node, "coordinates"));
      return ring.length >= 3 ? { type: "Polygon", coordinates: [ring] } : null;
    }
    case "Polygon": {
      const outer = coordinates(child(child(child(node, "outerBoundaryIs"), "LinearRing"), "coordinates"));
      if (outer.length < 3) return null;
      const rings = [outer];
      for (const inner of children(node, "innerBoundaryIs")) {
        for (const ring of children(inner, "LinearRing")) {
          const hole = coordinates(child(ring, "coordinates"));
          if (hole.length >= 3) rings.push(hole);
        }
      }
      return { type: "Polygon", coordinates: rings };
    }
    case "MultiGeometry":
      return readGeometry(node);
    case "Track": {
      const line = children(node, "coord")
        .map((c) => textOf(c).split(/\s+/).map(Number))
        .filter((p) => p.length >= 2 && p.every(Number.isFinite));
      return line.length >= 2 ? { type: "LineString", coordinates: line } : null;
    }
    case "MultiTrack": {
      const lines: Position[][] = [];
      for (const track of children(node, "Track")) {
        const g = geometry(track);
        if (g?.type === "LineString") lines.push(g.coordinates);
      }
      return lines.length > 0 ? { type: "MultiLineString", coordinates: lines } : null;
    }
    case "Model": {
      const location = child(node, "Location");
      const lng = Number(textOf(child(location, "longitude")));
      const lat = Number(textOf(child(location, "latitude")));
      return Number.isFinite(lng) && Number.isFinite(lat) ? { type: "Point", coordinates: [lng, lat] } : null;
    }
    default:
      return null;
  }
}

function coordinates(node: XmlElement | undefined): Position[] {
  const text = textOf(node).replace(/\s*,\s*/g, ",");
  if (!text) return [];
  const out: Position[] = [];
  for (const tuple of text.split(/\s+/)) {
    const values = tuple.split(",").map(Number);
    if (values.length >= 2 && Number.isFinite(values[0]) && Number.isFinite(values[1])) {
      out.push(values.length >= 3 && Number.isFinite(values[2]) ? [values[0]!, values[1]!, values[2]!] : [values[0]!, values[1]!]);
    }
  }
  return out;
}

function readProperties(placemark: XmlElement, styles: Map<string, KmlStyle>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const key of ["name", "description", "address", "phoneNumber", "styleUrl"]) {
    const node = child(placemark, key);
    if (node) props[key] = textOf(node);
  }
  const visibility = child(placemark, "visibility");
  if (visibility && textOf(visibility) === "0") props.visibility = false;
  const time = child(child(placemark, "TimeStamp"), "when");
  if (time) props.timestamp = textOf(time);
  const span = child(placemark, "TimeSpan");
  if (span) {
    const begin = child(span, "begin");
    const end = child(span, "end");
    if (begin) props.begin = textOf(begin);
    if (end) props.end = textOf(end);
  }
  const extended = child(placemark, "ExtendedData");
  for (const data of children(extended, "Data")) {
    const name = data.attrs.name;
    if (name) props[name] = textOf(child(data, "value"));
  }
  for (const schema of children(extended, "SchemaData")) {
    for (const simple of children(schema, "SimpleData")) {
      const name = simple.attrs.name;
      if (name) props[name] = textOf(simple);
    }
  }
  const url = typeof props.styleUrl === "string" ? props.styleUrl.replace(/^#/, "") : "";
  const inline = child(placemark, "Style");
  const style = { ...(styles.get(url) ?? {}), ...(inline ? readStyle(inline) : {}) };
  if (style.stroke !== undefined) props.stroke = style.stroke;
  if (style.strokeOpacity !== undefined) props["stroke-opacity"] = style.strokeOpacity;
  if (style.strokeWidth !== undefined) props["stroke-width"] = style.strokeWidth;
  if (style.fill !== undefined) props.fill = style.fill;
  if (style.fillOpacity !== undefined) props["fill-opacity"] = style.fillOpacity;
  if (style.marker !== undefined) props["marker-color"] = style.marker;
  return props;
}

function readStyles(doc: XmlElement): Map<string, KmlStyle> {
  const styles = new Map<string, KmlStyle>();
  for (const node of descendants(doc, "Style")) {
    if (node.attrs.id) styles.set(node.attrs.id, readStyle(node));
  }
  for (const map of descendants(doc, "StyleMap")) {
    const id = map.attrs.id;
    if (!id) continue;
    for (const pair of children(map, "Pair")) {
      if (textOf(child(pair, "key")) !== "normal") continue;
      const inline = child(pair, "Style");
      const target = textOf(child(pair, "styleUrl")).replace(/^#/, "");
      const style = inline ? readStyle(inline) : styles.get(target);
      if (style) styles.set(id, style);
    }
  }
  return styles;
}

function readStyle(node: XmlElement): KmlStyle {
  const style: KmlStyle = {};
  const line = child(node, "LineStyle");
  if (line) {
    const color = kmlColor(textOf(child(line, "color")));
    if (color) {
      style.stroke = color.hex;
      style.strokeOpacity = color.alpha;
    }
    const width = Number(textOf(child(line, "width")));
    if (child(line, "width") && Number.isFinite(width)) style.strokeWidth = width;
  }
  const poly = child(node, "PolyStyle");
  if (poly) {
    const color = kmlColor(textOf(child(poly, "color")));
    if (color) {
      style.fill = color.hex;
      style.fillOpacity = textOf(child(poly, "fill")) === "0" ? 0 : color.alpha;
    } else if (textOf(child(poly, "fill")) === "0") {
      style.fillOpacity = 0;
    }
  }
  const icon = child(node, "IconStyle");
  if (icon) {
    const color = kmlColor(textOf(child(icon, "color")));
    if (color) style.marker = color.hex;
  }
  return style;
}

function kmlColor(value: string): { hex: string; alpha: number } | null {
  const v = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{8}$/.test(v)) return null;
  const a = Number.parseInt(v.slice(0, 2), 16) / 255;
  return { hex: `#${v.slice(6, 8)}${v.slice(4, 6)}${v.slice(2, 4)}`.toLowerCase(), alpha: Math.round(a * 1000) / 1000 };
}
