import type { Feature, FeatureCollection, Position } from "../geo/geojson.ts";
import type { XmlElement } from "./xml.ts";
import { child, children, parseXml, textOf } from "./xml.ts";

export function gpxToGeoJSON(text: string): FeatureCollection {
  const gpx = child(parseXml(text), "gpx");
  const features: Feature[] = [];
  for (const point of children(gpx, "wpt")) {
    const position = readPoint(point);
    if (position) features.push({ type: "Feature", properties: readProperties(point, "waypoint"), geometry: { type: "Point", coordinates: position } });
  }
  for (const route of children(gpx, "rte")) {
    const line = readLine(children(route, "rtept"));
    if (line.length >= 2) {
      features.push({ type: "Feature", properties: readProperties(route, "route"), geometry: { type: "LineString", coordinates: line } });
    }
  }
  for (const track of children(gpx, "trk")) {
    const segments = children(track, "trkseg")
      .map((segment) => readLine(children(segment, "trkpt")))
      .filter((line) => line.length >= 2);
    if (segments.length === 0) continue;
    const properties = readProperties(track, "track");
    const times = children(children(track, "trkseg")[0], "trkpt").map((p) => textOf(child(p, "time")));
    if (times[0]) properties.start = times[0];
    const last = times[times.length - 1];
    if (last) properties.end = last;
    features.push({
      type: "Feature",
      properties,
      geometry:
        segments.length === 1
          ? { type: "LineString", coordinates: segments[0]! }
          : { type: "MultiLineString", coordinates: segments },
    });
  }
  return { type: "FeatureCollection", features };
}

function readPoint(node: XmlElement): Position | null {
  const lat = Number(node.attrs.lat);
  const lon = Number(node.attrs.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || node.attrs.lat === undefined || node.attrs.lon === undefined) return null;
  const ele = child(node, "ele");
  const z = ele ? Number(textOf(ele)) : Number.NaN;
  return Number.isFinite(z) ? [lon, lat, z] : [lon, lat];
}

function readLine(points: XmlElement[]): Position[] {
  const out: Position[] = [];
  for (const p of points) {
    const position = readPoint(p);
    if (position) out.push(position);
  }
  return out;
}

function readProperties(node: XmlElement, kind: string): Record<string, unknown> {
  const props: Record<string, unknown> = { kind };
  for (const key of ["name", "desc", "cmt", "type", "sym", "time", "src"]) {
    const value = child(node, key);
    if (value) props[key] = textOf(value);
  }
  const ele = child(node, "ele");
  if (ele) {
    const z = Number(textOf(ele));
    if (Number.isFinite(z)) props.ele = z;
  }
  const link = child(node, "link");
  if (link?.attrs.href) props.link = link.attrs.href;
  return props;
}
