import type { Feature, FeatureCollection, Geometry } from "../geo/geojson.ts";
import type { XmlElement } from "./xml.ts";
import { child, children, descendants, parseXml, textOf } from "./xml.ts";

const AFFILIATIONS = new Set(["p", "u", "a", "f", "n", "s", "h", "j", "k"]);
const DIMENSIONS = new Set(["P", "A", "G", "S", "U", "F", "X"]);

export function cotTypeToSidc(type: string): string | null {
  const parts = String(type ?? "").split("-");
  if (parts[0] !== "a" || parts.length < 3) return null;
  const affiliation = parts[1]!.toLowerCase();
  const dimension = parts[2]!.toUpperCase();
  if (!AFFILIATIONS.has(affiliation) || !DIMENSIONS.has(dimension)) return null;
  const fn = parts.slice(3).join("").toUpperCase().slice(0, 6);
  if (!/^[A-Z0-9]*$/.test(fn)) return null;
  return `S${affiliation.toUpperCase()}${dimension}P${fn.padEnd(6, "-")}-----`;
}

export function sidcToCotType(sidc: string): string | null {
  const s = String(sidc ?? "").toUpperCase();
  if (!/^S[PUAFNSHJK][PAGSUFX][A-Z*-][A-Z0-9*-]{6}/.test(s)) return null;
  const fn = s.slice(4, 10).replace(/[*-]+$/, "");
  return ["a", s[1]!.toLowerCase(), s[2]!, ...fn.split("")].join("-");
}

export function isCot(text: string): boolean {
  return /<event[\s>]/.test(text) && /<point[\s/>]/.test(text) && /\btype\s*=\s*["']/.test(text);
}

export function cotToGeoJSON(text: string): FeatureCollection {
  const doc = parseXml(text);
  const features: Feature[] = [];
  for (const event of descendants(doc, "event")) {
    const feature = readEvent(event);
    if (feature) features.push(feature);
  }
  return { type: "FeatureCollection", features };
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function pointOf(event: XmlElement): [number, number, number?] | null {
  const point = child(event, "point");
  const lat = number(point?.attrs.lat);
  const lon = number(point?.attrs.lon);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const hae = number(point?.attrs.hae);
  return hae === undefined || hae === 9999999 ? [lon, lat] : [lon, lat, hae];
}

function argb(value: string | undefined): string | undefined {
  const n = number(value);
  if (n === undefined) return undefined;
  const u = n >>> 0;
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex((u >>> 16) & 255)}${hex((u >>> 8) & 255)}${hex(u & 255)}`;
}

function opacity(value: string | undefined): number | undefined {
  const n = number(value);
  if (n === undefined) return undefined;
  return Math.round((((n >>> 0) >>> 24) / 255) * 1000) / 1000;
}

function readEvent(event: XmlElement): Feature | null {
  const at = pointOf(event);
  if (!at) return null;
  const type = event.attrs.type ?? "";
  const detail = child(event, "detail");
  const props: Record<string, unknown> = { type };
  for (const key of ["uid", "how", "time", "start", "stale"]) if (event.attrs[key]) props[key] = event.attrs[key];
  const point = child(event, "point");
  for (const key of ["ce", "le"]) {
    const v = number(point?.attrs[key]);
    if (v !== undefined && v !== 9999999) props[key] = v;
  }
  const callsign = child(detail, "contact")?.attrs.callsign;
  if (callsign) props.callsign = callsign;
  if (callsign) props.name = callsign;
  const remarks = textOf(child(detail, "remarks")).trim();
  if (remarks) props.remarks = remarks;
  const group = child(detail, "__group");
  if (group?.attrs.name) props.team = group.attrs.name;
  if (group?.attrs.role) props.role = group.attrs.role;
  const track = child(detail, "track");
  const course = number(track?.attrs.course);
  const speed = number(track?.attrs.speed);
  if (course !== undefined) props.course = course;
  if (speed !== undefined) props.speed = speed;
  const sidc = cotTypeToSidc(type);
  if (sidc) props.sidc = sidc;
  const stroke = child(detail, "strokeColor")?.attrs.value;
  const fill = child(detail, "fillColor")?.attrs.value;
  if (stroke !== undefined) {
    const color = argb(stroke);
    if (color) props.stroke = color;
    const a = opacity(stroke);
    if (a !== undefined) props["stroke-opacity"] = a;
  }
  const width = number(child(detail, "strokeWeight")?.attrs.value);
  if (width !== undefined) props["stroke-width"] = width;
  if (fill !== undefined) {
    const color = argb(fill);
    if (color) props.fill = color;
    const a = opacity(fill);
    if (a !== undefined) props["fill-opacity"] = a;
  }
  const id = event.attrs.uid;
  const geometry = shapeOf(event, detail, type, at);
  const feature: Feature = { type: "Feature", properties: props, geometry };
  if (id) feature.id = id;
  return feature;
}

function linkPoints(detail: XmlElement | undefined): [number, number][] {
  const out: [number, number][] = [];
  for (const link of children(detail, "link")) {
    const raw = link.attrs.point;
    if (!raw) continue;
    const [lat, lon] = raw.split(",").map((v) => Number(v.trim()));
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat!) <= 90 && Math.abs(lon!) <= 180)
      out.push([lon!, lat!]);
  }
  return out;
}

function shapeOf(
  event: XmlElement,
  detail: XmlElement | undefined,
  type: string,
  at: [number, number, number?],
): Geometry {
  const ellipse = child(child(detail, "shape"), "ellipse");
  if (ellipse) {
    const major = number(ellipse.attrs.major);
    const minor = number(ellipse.attrs.minor) ?? major;
    const angle = number(ellipse.attrs.angle) ?? 0;
    if (major !== undefined && minor !== undefined && major > 0) return ring(at, major, minor, angle);
  }
  const points = linkPoints(detail);
  if (points.length >= 2) {
    const closed = type.startsWith("u-d-r") || type === "u-d-f-p" || child(detail, "fillColor") !== undefined;
    if (closed && points.length >= 3) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const loop = first[0] === last[0] && first[1] === last[1] ? points : [...points, first];
      return { type: "Polygon", coordinates: [loop] };
    }
    return { type: "LineString", coordinates: points };
  }
  void event;
  return { type: "Point", coordinates: at.length === 3 ? [at[0], at[1], at[2]!] : [at[0], at[1]] };
}

function ring(center: [number, number, number?], major: number, minor: number, angle: number): Geometry {
  const [lon, lat] = center;
  const coords: [number, number][] = [];
  const rotation = (angle * Math.PI) / 180;
  const metersPerDegree = 111320;
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2;
    const x = major * Math.cos(t);
    const y = minor * Math.sin(t);
    const east = x * Math.cos(rotation) + y * Math.sin(rotation);
    const north = -x * Math.sin(rotation) + y * Math.cos(rotation);
    coords.push([lon + east / (metersPerDegree * Math.cos((lat * Math.PI) / 180)), lat + north / metersPerDegree]);
  }
  return { type: "Polygon", coordinates: [coords] };
}

export interface CotWriteOptions {
  staleMinutes?: number;
  now?: Date;
}

export function geoJSONToCot(data: Feature | FeatureCollection, options: CotWriteOptions = {}): string {
  const features = data.type === "FeatureCollection" ? data.features : [data];
  const now = options.now ?? new Date();
  const stale = new Date(now.getTime() + (options.staleMinutes ?? 10) * 60000);
  return features
    .map((f, i) => writeEvent(f, now, stale, i))
    .filter((e): e is string => e !== null)
    .join("\n");
}

function escapeXml(value: unknown): string {
  return String(value).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function writeEvent(feature: Feature, now: Date, stale: Date, index: number): string | null {
  const g = feature.geometry;
  if (!g) return null;
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  let at: number[] | undefined;
  let links: number[][] = [];
  let shapeType: string | null = null;
  if (g.type === "Point") at = g.coordinates as number[];
  else if (g.type === "LineString") {
    links = g.coordinates as number[][];
    at = links[0];
    shapeType = "u-d-f";
  } else if (g.type === "Polygon") {
    links = (g.coordinates as number[][][])[0] ?? [];
    at = links[0];
    shapeType = "u-d-f-p";
  } else return null;
  if (!at || at.length < 2) return null;
  const sidcType = typeof props.sidc === "string" ? sidcToCotType(props.sidc) : null;
  const type = typeof props.type === "string" && props.type ? props.type : (shapeType ?? sidcType ?? "a-u-G");
  const uid = feature.id ?? props.uid ?? `maplet-${now.getTime().toString(36)}-${index}`;
  const how = typeof props.how === "string" ? props.how : "h-g-i-g-o";
  const callsign = props.callsign ?? props.name;
  const remarks = props.remarks ?? props.description;
  const hae = at.length > 2 && Number.isFinite(at[2]) ? at[2] : 9999999;
  const parts = [
    `<event version="2.0" uid="${escapeXml(uid)}" type="${escapeXml(type)}" how="${escapeXml(how)}" time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}">`,
    `<point lat="${at[1]}" lon="${at[0]}" hae="${hae}" ce="${Number(props.ce) || 9999999}" le="${Number(props.le) || 9999999}"/>`,
    "<detail>",
  ];
  if (callsign !== undefined && callsign !== null && callsign !== "")
    parts.push(`<contact callsign="${escapeXml(callsign)}"/>`);
  for (const p of links) parts.push(`<link point="${p[1]},${p[0]}"/>`);
  if (remarks !== undefined && remarks !== null && remarks !== "")
    parts.push(`<remarks>${escapeXml(remarks)}</remarks>`);
  parts.push("</detail>", "</event>");
  return parts.join("");
}
