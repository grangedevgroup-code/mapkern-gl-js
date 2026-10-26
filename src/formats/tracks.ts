import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";
import type { XmlElement } from "./xml.ts";
import { child, children, parseXml, textOf } from "./xml.ts";

export function isTcx(head: string): boolean {
  return /<TrainingCenterDatabase[\s>]/.test(head);
}

interface TrackPart {
  points: Position[];
  times: string[];
  heart: number[];
}

function readTcxTrack(track: XmlElement): TrackPart {
  const part: TrackPart = { points: [], times: [], heart: [] };
  for (const p of children(track, "Trackpoint")) {
    const position = child(p, "Position");
    const lat = Number(textOf(child(position, "LatitudeDegrees")));
    const lon = Number(textOf(child(position, "LongitudeDegrees")));
    if (!position || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const altitude = child(p, "AltitudeMeters");
    const z = altitude ? Number(textOf(altitude)) : Number.NaN;
    part.points.push(Number.isFinite(z) ? [lon, lat, z] : [lon, lat]);
    const time = textOf(child(p, "Time"));
    if (time) part.times.push(time);
    const hr = Number(textOf(child(child(p, "HeartRateBpm"), "Value")));
    if (Number.isFinite(hr) && hr > 0) part.heart.push(hr);
  }
  return part;
}

function lineOf(parts: TrackPart[]): Geometry | null {
  const lines = parts.map((p) => p.points).filter((l) => l.length >= 2);
  if (lines.length === 0) return null;
  return lines.length === 1
    ? { type: "LineString", coordinates: lines[0]! }
    : { type: "MultiLineString", coordinates: lines };
}

function sum(elements: XmlElement[], name: string): number | undefined {
  let total = 0;
  let found = false;
  for (const e of elements) {
    const v = Number(textOf(child(e, name)));
    if (child(e, name) && Number.isFinite(v)) {
      total += v;
      found = true;
    }
  }
  return found ? total : undefined;
}

export function tcxToGeoJSON(text: string): FeatureCollection {
  const root = child(parseXml(text), "TrainingCenterDatabase");
  const features: Feature[] = [];
  for (const activity of children(child(root, "Activities"), "Activity")) {
    const laps = children(activity, "Lap");
    const parts = laps.flatMap((lap) => children(lap, "Track").map(readTcxTrack));
    const geometry = lineOf(parts);
    if (!geometry) continue;
    const times = parts.flatMap((p) => p.times);
    const heart = parts.flatMap((p) => p.heart);
    const properties: Record<string, unknown> = { kind: "activity" };
    if (activity.attrs.Sport) properties.sport = activity.attrs.Sport;
    const id = textOf(child(activity, "Id"));
    if (id) properties.id = id;
    if (times[0]) properties.start = times[0];
    if (times.length > 0) properties.end = times[times.length - 1];
    const distance = sum(laps, "DistanceMeters");
    if (distance !== undefined) properties.distance = distance;
    const duration = sum(laps, "TotalTimeSeconds");
    if (duration !== undefined) properties.duration = duration;
    const calories = sum(laps, "Calories");
    if (calories !== undefined) properties.calories = calories;
    if (heart.length > 0) {
      properties.heartRate = Math.round(heart.reduce((a, b) => a + b, 0) / heart.length);
      properties.maxHeartRate = Math.max(...heart);
    }
    features.push({ type: "Feature", properties, geometry });
  }
  for (const course of children(child(root, "Courses"), "Course")) {
    const geometry = lineOf(children(course, "Track").map(readTcxTrack));
    const name = textOf(child(course, "Name"));
    if (geometry)
      features.push({ type: "Feature", properties: { kind: "course", ...(name ? { name } : {}) }, geometry });
    for (const point of children(course, "CoursePoint")) {
      const position = child(point, "Position");
      const lat = Number(textOf(child(position, "LatitudeDegrees")));
      const lon = Number(textOf(child(position, "LongitudeDegrees")));
      if (!position || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const properties: Record<string, unknown> = { kind: "coursepoint" };
      for (const [key, tag] of [
        ["name", "Name"],
        ["type", "PointType"],
        ["time", "Time"],
        ["notes", "Notes"],
      ] as const) {
        const value = textOf(child(point, tag));
        if (value) properties[key] = value;
      }
      features.push({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } });
    }
  }
  return { type: "FeatureCollection", features };
}

const IGC_FIX = /^B(\d{2})(\d{2})(\d{2})(\d{2})(\d{5})([NS])(\d{3})(\d{5})([EW])([AV])([-\d]\d{4})([-\d]\d{4})/;

export function isIgc(text: string): boolean {
  return /^\s*A[A-Z0-9]{3}/.test(text) && /(^|\n)B\d{13}[NS]\d{8}[EW]/.test(text);
}

export function igcToGeoJSON(text: string): FeatureCollection {
  const properties: Record<string, unknown> = { kind: "flight" };
  let date: [number, number, number] | null = null;
  const points: Position[] = [];
  const times: number[] = [];
  let dayOffset = 0;
  let lastSeconds = -1;
  const headers: Record<string, string> = {
    PLT: "pilot",
    CM2: "copilot",
    GTY: "glider",
    GID: "gliderId",
    CID: "competitionId",
    CCL: "competitionClass",
    SIT: "site",
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("H")) {
      const code = line.slice(2, 5);
      if (code === "DTE") {
        const m = /(\d{2})(\d{2})(\d{2})/.exec(line.slice(5));
        if (m) date = [2000 + Number(m[3]) - (Number(m[3]) > 79 ? 100 : 0), Number(m[2]), Number(m[1])];
      } else if (headers[code]) {
        const value = line.includes(":") ? line.slice(line.indexOf(":") + 1).trim() : line.slice(5).trim();
        if (value && !/^(not ?set|none|unknown|n\/a)$/i.test(value)) properties[headers[code]] = value;
      }
      continue;
    }
    const m = IGC_FIX.exec(line);
    if (!m) continue;
    const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (lastSeconds >= 0 && seconds < lastSeconds - 3600) dayOffset++;
    lastSeconds = seconds;
    const lat = (Number(m[4]) + Number(m[5]) / 60000) * (m[6] === "S" ? -1 : 1);
    const lon = (Number(m[7]) + Number(m[8]) / 60000) * (m[9] === "W" ? -1 : 1);
    const pressure = Number(m[11]);
    const gnss = Number(m[12]);
    points.push([lon, lat, gnss !== 0 ? gnss : pressure]);
    times.push(seconds + dayOffset * 86400);
  }
  if (date) properties.date = `${date[0]}-${String(date[1]).padStart(2, "0")}-${String(date[2]).padStart(2, "0")}`;
  if (times.length > 0 && date) {
    const base = Date.UTC(date[0], date[1] - 1, date[2]);
    properties.start = new Date(base + times[0]! * 1000).toISOString().replace(".000Z", "Z");
    properties.end = new Date(base + times[times.length - 1]! * 1000).toISOString().replace(".000Z", "Z");
  }
  const features: Feature[] =
    points.length >= 2
      ? [{ type: "Feature", properties, geometry: { type: "LineString", coordinates: points } }]
      : points.length === 1
        ? [{ type: "Feature", properties, geometry: { type: "Point", coordinates: points[0]! } }]
        : [];
  return { type: "FeatureCollection", features };
}

const SENTENCE = /^\$([A-Z]{2})([A-Z]{3}),([^*]*)(?:\*([0-9A-Fa-f]{2}))?$/;

export function isNmea(text: string): boolean {
  const lines = text.split(/\r?\n/, 20).filter((l) => l.trim());
  return lines.length > 0 && lines.filter((l) => SENTENCE.test(l.trim())).length >= Math.ceil(lines.length / 2);
}

function nmeaAngle(value: string, hemisphere: string, degreeDigits: number): number | null {
  if (!value || !/^\d+(\.\d+)?$/.test(value)) return null;
  const degrees = Number(value.slice(0, degreeDigits));
  const minutes = Number(value.slice(degreeDigits));
  const angle = degrees + minutes / 60;
  return hemisphere === "S" || hemisphere === "W" ? -angle : angle;
}

interface Fix {
  time: string;
  lon: number;
  lat: number;
  alt?: number;
  date?: string;
}

export function nmeaToGeoJSON(text: string): FeatureCollection {
  const fixes = new Map<string, Fix>();
  const order: string[] = [];
  let date = "";
  const upsert = (time: string, lon: number, lat: number): Fix => {
    let fix = fixes.get(time);
    if (!fix) {
      fix = { time, lon, lat };
      fixes.set(time, fix);
      order.push(time);
    }
    return fix;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = SENTENCE.exec(line);
    if (!m) continue;
    if (m[4]) {
      let check = 0;
      const body = line.slice(1, line.indexOf("*"));
      for (let i = 0; i < body.length; i++) check ^= body.charCodeAt(i);
      if (check !== Number.parseInt(m[4], 16)) continue;
    }
    const f = m[3]!.split(",");
    const type = m[2];
    if (type === "RMC") {
      if (f[1] !== "A") continue;
      const lat = nmeaAngle(f[2]!, f[3]!, 2);
      const lon = nmeaAngle(f[4]!, f[5]!, 3);
      if (/^\d{6}$/.test(f[8] ?? "")) date = `20${f[8]!.slice(4, 6)}-${f[8]!.slice(2, 4)}-${f[8]!.slice(0, 2)}`;
      if (lat === null || lon === null || !f[0]) continue;
      const fix = upsert(f[0], lon, lat);
      if (date) fix.date = date;
    } else if (type === "GGA") {
      if (!f[5] || f[5] === "0") continue;
      const lat = nmeaAngle(f[1]!, f[2]!, 2);
      const lon = nmeaAngle(f[3]!, f[4]!, 3);
      if (lat === null || lon === null || !f[0]) continue;
      const fix = upsert(f[0], lon, lat);
      const alt = Number(f[8]);
      if (f[8] && Number.isFinite(alt)) fix.alt = alt;
      if (date && !fix.date) fix.date = date;
    } else if (type === "GLL") {
      if (f[5] && f[5] !== "A") continue;
      const lat = nmeaAngle(f[0]!, f[1]!, 2);
      const lon = nmeaAngle(f[2]!, f[3]!, 3);
      if (lat === null || lon === null || !f[4]) continue;
      const fix = upsert(f[4], lon, lat);
      if (date && !fix.date) fix.date = date;
    }
  }
  const points: Position[] = [];
  for (const time of order) {
    const fix = fixes.get(time)!;
    const p: Position = fix.alt !== undefined ? [fix.lon, fix.lat, fix.alt] : [fix.lon, fix.lat];
    const last = points[points.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
  }
  const stamp = (fix: Fix) => {
    const t = `${fix.time.slice(0, 2)}:${fix.time.slice(2, 4)}:${fix.time.slice(4, 6)}`;
    return fix.date ? `${fix.date}T${t}Z` : t;
  };
  const properties: Record<string, unknown> = { kind: "track" };
  if (order.length > 0) {
    properties.start = stamp(fixes.get(order[0]!)!);
    properties.end = stamp(fixes.get(order[order.length - 1]!)!);
  }
  const geometry: Geometry | null =
    points.length >= 2
      ? { type: "LineString", coordinates: points }
      : points.length === 1
        ? { type: "Point", coordinates: points[0]! }
        : null;
  return { type: "FeatureCollection", features: geometry ? [{ type: "Feature", properties, geometry }] : [] };
}
