import {
  BIKE_BACKWARD,
  BIKE_FORWARD,
  CAR_BACKWARD,
  CAR_FORWARD,
  DESTINATION_ONLY,
  FOOT,
  MINOR_SERVICE,
  MODE_BIKE,
  MODE_CAR,
  ROAD_CLASSES,
  ROUNDABOUT,
  TOLL,
} from "../../src/route/format.ts";
import type { Tags } from "./osm-pbf.ts";

const CLASSES = new Set<string>(ROAD_CLASSES);

const CAR_CLASSES = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
]);

const BIKE_DEFAULT = new Set([
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
  "track",
  "path",
  "cycleway",
]);

const FOOT_DEFAULT = new Set([
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
  "track",
  "pedestrian",
  "footway",
  "path",
  "cycleway",
  "bridleway",
  "steps",
]);

const KEEP = [
  "highway",
  "name",
  "ref",
  "oneway",
  "oneway:bicycle",
  "oneway:foot",
  "cycleway",
  "cycleway:left",
  "cycleway:right",
  "cycleway:both",
  "junction",
  "access",
  "vehicle",
  "motor_vehicle",
  "motorcar",
  "bicycle",
  "foot",
  "maxspeed",
  "service",
  "toll",
  "area",
  "impassable",
];

const RESTRICTION_KEEP = [
  "type",
  "restriction",
  "restriction:motorcar",
  "restriction:motor_vehicle",
  "restriction:vehicle",
  "restriction:bicycle",
  "except",
];

const DENIED = new Set([
  "no",
  "private",
  "agricultural",
  "forestry",
  "emergency",
  "psv",
  "bus",
  "delivery",
  "military",
  "use_sidepath",
  "dismount",
  "discouraged",
]);

export function isRouteWay(tags: Tags): boolean {
  const highway = tags.highway;
  if (!highway || !CLASSES.has(highway)) return false;
  if (tags.area === "yes" || tags.impassable === "yes") return false;
  return true;
}

export function isRestriction(tags: Tags): boolean {
  return tags.type === "restriction";
}

export function routeTags(tags: Tags): Tags | null {
  const keep = tags.type === "restriction" ? RESTRICTION_KEEP : KEEP;
  const out: Tags = {};
  let any = false;
  for (const key of keep) {
    const value = tags[key];
    if (value !== undefined) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : null;
}

function first(tags: Tags, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = tags[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function allowed(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !DENIED.has(value);
}

function onewayOf(value: string | undefined, implied: boolean): -1 | 0 | 1 {
  if (value === "yes" || value === "true" || value === "1") return 1;
  if (value === "-1" || value === "reverse") return -1;
  if (value === "no" || value === "false" || value === "0") return 0;
  return implied ? 1 : 0;
}

export function wayFlags(tags: Tags): number {
  const highway = tags.highway ?? "";
  const roundabout = tags.junction === "roundabout" || tags.junction === "circular";
  const implied = roundabout || highway === "motorway" || highway === "motorway_link";
  const oneway = onewayOf(tags.oneway, implied);
  let flags = 0;
  const car =
    CAR_CLASSES.has(highway) && allowed(first(tags, ["motorcar", "motor_vehicle", "vehicle", "access"]), true);
  if (car) {
    if (oneway >= 0) flags |= CAR_FORWARD;
    if (oneway <= 0) flags |= CAR_BACKWARD;
  }
  const bikeTag = first(tags, ["bicycle", "vehicle", "access"]);
  const bikeExplicit = tags.bicycle === "yes" || tags.bicycle === "designated" || tags.bicycle === "permissive";
  const bike = bikeExplicit || (BIKE_DEFAULT.has(highway) && allowed(bikeTag, true));
  if (bike) {
    const contraflow = [tags.cycleway, tags["cycleway:left"], tags["cycleway:right"], tags["cycleway:both"]].some(
      (v) => v?.startsWith("opposite") ?? false,
    );
    const bikeWay =
      tags["oneway:bicycle"] !== undefined ? onewayOf(tags["oneway:bicycle"], false) : contraflow ? 0 : oneway;
    if (bikeWay >= 0) flags |= BIKE_FORWARD;
    if (bikeWay <= 0) flags |= BIKE_BACKWARD;
  }
  const footExplicit = tags.foot === "yes" || tags.foot === "designated" || tags.foot === "permissive";
  const foot = footExplicit || (FOOT_DEFAULT.has(highway) && allowed(first(tags, ["foot", "access"]), true));
  if (foot) flags |= FOOT;
  if (roundabout) flags |= ROUNDABOUT;
  if (tags.toll === "yes") flags |= TOLL;
  const service = tags.service;
  if (
    highway === "service" &&
    (service === "alley" ||
      service === "parking_aisle" ||
      service === "driveway" ||
      service === "parking" ||
      service === "drive-through")
  )
    flags |= MINOR_SERVICE;
  const access = first(tags, ["motorcar", "motor_vehicle", "vehicle", "access"]);
  if (access === "destination" || access === "customers") flags |= DESTINATION_ONLY;
  return flags;
}

export function maxspeedOf(value: string | undefined, highway: string): number {
  if (!value) return 0;
  if (value === "none") return highway.startsWith("motorway") ? 130 : 0;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|knots)?\s*$/i.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const kmh = unit === "mph" ? n * 1.609344 : unit === "knots" ? n * 1.852 : n;
  return Math.max(0, Math.min(255, Math.round(kmh)));
}

export function restrictionModes(tags: Tags): { value: string; modes: number } | null {
  const except = new Set((tags.except ?? "").split(";").map((s) => s.trim()));
  let modes = 0;
  let value: string | undefined;
  const generic = tags.restriction;
  if (generic) {
    value = generic;
    if (!except.has("motorcar") && !except.has("motor_vehicle")) modes |= MODE_CAR;
    if (!except.has("bicycle")) modes |= MODE_BIKE;
  }
  for (const key of ["restriction:motorcar", "restriction:motor_vehicle", "restriction:vehicle"] as const) {
    const v = tags[key];
    if (!v) continue;
    value ??= v;
    if (v === value) modes |= MODE_CAR;
    if (key === "restriction:vehicle" && v === value && !except.has("bicycle")) modes |= MODE_BIKE;
  }
  const bike = tags["restriction:bicycle"];
  if (bike && (value === undefined || bike === value)) {
    value ??= bike;
    modes |= MODE_BIKE;
  }
  if (!value || modes === 0) return null;
  if (!/^(no|only)_(left_turn|right_turn|straight_on|u_turn)$/.test(value)) return null;
  return { value, modes };
}
