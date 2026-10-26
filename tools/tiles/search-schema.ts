import type { Tags } from "./osm-pbf.ts";

export const CATEGORY_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "leisure",
  "healthcare",
  "office",
  "craft",
  "historic",
  "emergency",
  "aeroway",
  "railway",
  "public_transport",
  "sport",
  "club",
  "military",
  "man_made",
  "natural",
  "waterway",
  "landuse",
  "highway",
  "building",
];

const STREETS = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "pedestrian",
  "track",
  "road",
  "busway",
  "footway",
  "path",
  "cycleway",
  "bridleway",
  "steps",
]);

const NAME_KEY =
  /^(?:name|alt_name|official_name|short_name|loc_name|int_name|reg_name|old_name)(?::[a-z]{2,3}(?:-[A-Za-z]{2,8})?)?$/;

const KEPT = new Set([
  ...CATEGORY_KEYS,
  "place",
  "population",
  "capital",
  "admin_level",
  "boundary",
  "type",
  "wikidata",
  "ref",
  "iata",
  "icao",
]);

const WORLD_PLACES = new Set([
  "country",
  "state",
  "province",
  "region",
  "county",
  "district",
  "municipality",
  "city",
  "town",
  "village",
  "hamlet",
  "borough",
  "suburb",
  "quarter",
  "neighbourhood",
  "island",
  "archipelago",
  "locality",
]);

export function isNameKey(key: string): boolean {
  return NAME_KEY.test(key);
}

export function searchTags(tags: Tags): Tags | null {
  let out: Tags | null = null;
  for (const key in tags) {
    if (!(KEPT.has(key) || key.startsWith("addr:") || NAME_KEY.test(key))) continue;
    out ??= {};
    out[key] = tags[key]!;
  }
  return out;
}

export function streetClass(tags: Tags): string | null {
  const h = tags.highway;
  if (!h || !STREETS.has(h)) return null;
  if (!tags.name && !(tags.ref && (h === "motorway" || h === "trunk" || h === "primary"))) return null;
  return h;
}

export function categoryOf(tags: Tags): string | null {
  for (const key of CATEGORY_KEYS) {
    const value = tags[key];
    if (!value || value === "no") continue;
    if (key === "highway" && (STREETS.has(value) || value.endsWith("_link"))) continue;
    if (value === "yes" && key !== "building") continue;
    return `${key}=${value}`;
  }
  return null;
}

export function hasAddress(tags: Tags): boolean {
  return Boolean(tags["addr:housenumber"] && (tags["addr:street"] || tags["addr:place"]));
}

export function isSearchPoint(tags: Tags): boolean {
  if (hasAddress(tags)) return true;
  if (!tags.name) return false;
  return Boolean(tags.place) || categoryOf(tags) !== null;
}

export function isSearchWay(tags: Tags): boolean {
  if (hasAddress(tags)) return true;
  if (!tags.name && !tags.ref) return false;
  return streetClass(tags) !== null || (Boolean(tags.name) && (Boolean(tags.place) || categoryOf(tags) !== null));
}

export function isSearchRelation(tags: Tags): boolean {
  if (!tags.name) return false;
  if (tags.type === "boundary" && tags.boundary === "administrative") return Boolean(tags.admin_level);
  if (tags.type === "multipolygon") return Boolean(tags.place) || categoryOf(tags) !== null;
  return false;
}

export function isWorldFeature(tags: Tags): boolean {
  if (!tags.name) return false;
  if (tags.place && WORLD_PLACES.has(tags.place)) return true;
  if (tags.aeroway === "aerodrome" && (tags.iata || tags.icao)) return true;
  return Boolean(tags.wikidata) && categoryOf(tags) !== null;
}

export function isWorldRelation(tags: Tags): boolean {
  if (!tags.name) return false;
  if (tags.type === "boundary" && tags.boundary === "administrative")
    return tags.admin_level === "2" || tags.admin_level === "4";
  return tags.type === "multipolygon" && isWorldFeature(tags);
}
