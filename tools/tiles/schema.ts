import type { Tags } from "./osm-pbf.ts";

export type GeomKind = "point" | "line" | "area";
export type Props = Record<string, string | number | boolean>;

export interface Classified {
  layer: string;
  minZoom: number;
  minPixels?: number;
  props: Props;
  sortKey?: number;
}

export interface AreaLabel {
  layer: string;
  minZoom: number;
  minPixels: number;
  props: Props;
}

export const LAYERS = [
  "water",
  "waterway",
  "landcover",
  "landuse",
  "park",
  "boundary",
  "aeroway",
  "road",
  "railway",
  "building",
  "place",
  "poi",
  "water_name",
  "mountain_peak",
  "housenumber",
] as const;

export type LayerName = (typeof LAYERS)[number];

const KEPT_KEYS = new Set([
  "name",
  "name:en",
  "ref",
  "highway",
  "railway",
  "service",
  "waterway",
  "water",
  "natural",
  "landuse",
  "leisure",
  "amenity",
  "shop",
  "tourism",
  "historic",
  "office",
  "craft",
  "sport",
  "man_made",
  "aeroway",
  "building",
  "building:part",
  "height",
  "min_height",
  "building:levels",
  "building:min_level",
  "roof:levels",
  "place",
  "population",
  "capital",
  "admin_level",
  "boundary",
  "maritime",
  "disputed",
  "protect_class",
  "bridge",
  "tunnel",
  "ford",
  "layer",
  "oneway",
  "junction",
  "surface",
  "tracktype",
  "access",
  "area",
  "type",
  "ele",
  "addr:housenumber",
  "intermittent",
  "wetland",
  "wood",
  "leaf_type",
  "golf",
  "religion",
  "cuisine",
  "public_transport",
  "station",
  "level",
  "indoor",
  "location",
]);

export function keepTags(tags: Tags): Tags | null {
  let out: Tags | null = null;
  for (const key in tags) {
    if (!KEPT_KEYS.has(key)) continue;
    out ??= {};
    out[key] = tags[key]!;
  }
  return out;
}

function named(tags: Tags, props: Props): Props {
  const name = tags.name;
  if (name) props.name = name;
  const en = tags["name:en"];
  if (en && en !== name) props.name_en = en;
  return props;
}

function num(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|ft|')?\s*$/i.exec(value);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return m[2] && m[2].toLowerCase() !== "m" ? v * 0.3048 : v;
}

function brunnel(tags: Tags): string | null {
  if (tags.bridge && tags.bridge !== "no") return "bridge";
  if (tags.tunnel && tags.tunnel !== "no") return "tunnel";
  if (tags.ford && tags.ford !== "no") return "ford";
  return null;
}

const AREA_KEYS = ["building", "landuse", "leisure", "amenity", "shop", "tourism", "historic", "aeroway", "place", "building:part", "office", "craft"];
const LINEAR_NATURAL = new Set(["coastline", "cliff", "tree_row", "ridge", "arete", "valley", "earth_bank", "gully"]);

export function isArea(tags: Tags): boolean {
  if (tags.area === "no") return false;
  if (tags.area === "yes") return true;
  if (tags.type === "multipolygon") return true;
  if (tags.natural) return !LINEAR_NATURAL.has(tags.natural);
  if (tags.waterway) return tags.waterway === "riverbank" || tags.waterway === "dock" || tags.waterway === "boatyard";
  if (tags.water) return true;
  if (tags.highway) return tags.highway === "pedestrian" && tags.area === "yes";
  if (tags.railway) return tags.railway === "platform" || tags.railway === "station";
  if (tags.man_made) return tags.man_made !== "pier" && tags.man_made !== "breakwater" && tags.man_made !== "embankment" && tags.man_made !== "pipeline";
  if (tags.boundary) return tags.boundary === "protected_area" || tags.boundary === "national_park";
  return AREA_KEYS.some((k) => tags[k] !== undefined);
}

const WATER_CLASSES: Record<string, string> = {
  lake: "lake",
  pond: "lake",
  reservoir: "reservoir",
  basin: "basin",
  river: "river",
  canal: "river",
  stream: "river",
  oxbow: "lake",
  lagoon: "lake",
  wastewater: "basin",
  fishpond: "lake",
};

const LANDCOVER: Record<string, string> = {
  wood: "wood",
  forest: "wood",
  scrub: "scrub",
  heath: "scrub",
  grassland: "grass",
  grass: "grass",
  meadow: "grass",
  village_green: "grass",
  wetland: "wetland",
  marsh: "wetland",
  sand: "sand",
  beach: "sand",
  dune: "sand",
  bare_rock: "rock",
  scree: "rock",
  shingle: "rock",
  glacier: "ice",
  farmland: "farmland",
  orchard: "farmland",
  vineyard: "farmland",
  plant_nursery: "farmland",
  allotments: "farmland",
};

const LANDUSE: Record<string, string> = {
  residential: "residential",
  commercial: "commercial",
  retail: "retail",
  industrial: "industrial",
  railway: "railway",
  cemetery: "cemetery",
  grave_yard: "cemetery",
  military: "military",
  quarry: "quarry",
  landfill: "quarry",
  construction: "construction",
  brownfield: "construction",
  garages: "industrial",
  farmyard: "farmland",
  religious: "religious",
};

const ROAD: Record<string, [string, number]> = {
  motorway: ["motorway", 4],
  trunk: ["trunk", 5],
  primary: ["primary", 7],
  secondary: ["secondary", 9],
  tertiary: ["tertiary", 10],
  motorway_link: ["motorway", 9],
  trunk_link: ["trunk", 9],
  primary_link: ["primary", 10],
  secondary_link: ["secondary", 11],
  tertiary_link: ["tertiary", 12],
  unclassified: ["minor", 12],
  residential: ["minor", 12],
  living_street: ["minor", 13],
  road: ["minor", 13],
  busway: ["minor", 13],
  service: ["service", 13],
  track: ["track", 13],
  pedestrian: ["path", 13],
  footway: ["path", 14],
  path: ["path", 14],
  cycleway: ["path", 14],
  bridleway: ["path", 14],
  steps: ["path", 14],
  corridor: ["path", 14],
};

const RAIL: Record<string, number> = {
  rail: 9,
  light_rail: 11,
  subway: 11,
  tram: 12,
  narrow_gauge: 11,
  monorail: 12,
  funicular: 12,
  preserved: 12,
};

const PLACE: Record<string, [number, number]> = {
  country: [1, 2],
  state: [3, 4],
  province: [3, 4],
  city: [5, 4],
  town: [7, 8],
  village: [8, 10],
  suburb: [9, 11],
  quarter: [10, 12],
  hamlet: [10, 12],
  neighbourhood: [11, 13],
  island: [9, 10],
  islet: [12, 13],
  locality: [12, 14],
  isolated_dwelling: [13, 14],
};

const POI_KEYS = ["amenity", "shop", "tourism", "leisure", "historic", "office", "craft", "man_made", "railway", "aeroway", "public_transport", "sport"];

const MAJOR_POI: Record<string, number> = {
  hospital: 12,
  university: 12,
  college: 13,
  stadium: 12,
  aerodrome: 10,
  station: 13,
  ferry_terminal: 13,
  museum: 13,
  zoo: 12,
  theme_park: 12,
  townhall: 13,
  park: 13,
  attraction: 14,
  library: 14,
  school: 14,
};

const POI_SKIP = new Set(["yes", "no", "bench", "waste_basket", "bicycle_parking", "parking_space", "parking_entrance", "vending_machine", "post_box", "telephone", "drinking_water", "toilets", "recycling", "waste_disposal", "grit_bin", "clock", "hunting_stand", "loading_dock", "survey_point", "street_lamp", "utility_pole", "pole", "tower", "mast", "manhole", "flagpole", "water_tap"]);

function poiClass(tags: Tags): [string, string] | null {
  for (const key of POI_KEYS) {
    const value = tags[key];
    if (!value || POI_SKIP.has(value)) continue;
    if (key === "railway" && value !== "station" && value !== "halt" && value !== "tram_stop" && value !== "subway_entrance") continue;
    if (key === "aeroway" && value !== "aerodrome" && value !== "helipad" && value !== "terminal") continue;
    if (key === "man_made" && value !== "lighthouse" && value !== "windmill" && value !== "observatory" && value !== "pier") continue;
    if (key === "leisure" && (value === "pitch" || value === "track" || value === "playground" || value === "picnic_table" || value === "firepit" || value === "swimming_pool")) {
      if (!tags.name) continue;
    }
    return [key, value];
  }
  return null;
}

function poiRank(cls: string, sub: string, tags: Tags): number {
  const major = MAJOR_POI[sub];
  if (major !== undefined) return major;
  if (cls === "railway" || cls === "public_transport") return 14;
  return tags.name ? 14 : 15;
}

function placeRank(tags: Tags, base: number): number {
  const pop = Number(tags.population);
  let rank = base;
  if (Number.isFinite(pop) && pop > 0) {
    if (pop >= 1_000_000) rank -= 2;
    else if (pop >= 250_000) rank -= 1;
    else if (pop < 1_000 && rank < 9) rank += 1;
  }
  if (tags.capital === "yes" || tags.capital === "2") rank -= 1;
  return Math.max(1, rank);
}

export function classify(tags: Tags, kind: GeomKind): Classified[] {
  const out: Classified[] = [];
  if (kind === "point") {
    classifyPoint(tags, out);
  } else if (kind === "line") {
    classifyLine(tags, out);
  } else {
    classifyArea(tags, out);
  }
  return out;
}

function classifyPoint(tags: Tags, out: Classified[]): void {
  const place = tags.place;
  if (place && tags.name) {
    const p = PLACE[place];
    if (p) {
      const rank = placeRank(tags, p[0]);
      const props = named(tags, { class: place, rank });
      if (tags.capital) props.capital = tags.capital === "yes" ? 2 : Number(tags.capital) || 0;
      const pop = Number(tags.population);
      if (Number.isFinite(pop) && pop > 0) props.population = Math.round(pop);
      out.push({ layer: "place", minZoom: Math.max(2, Math.min(14, p[1] - (rank < p[0] ? 1 : 0))), props });
    }
    return;
  }
  if (tags.natural === "peak" || tags.natural === "volcano") {
    const ele = num(tags.ele);
    const props = named(tags, { class: tags.natural });
    if (ele !== null) props.ele = Math.round(ele);
    out.push({ layer: "mountain_peak", minZoom: ele !== null && ele > 2500 ? 8 : ele !== null && ele > 1000 ? 10 : 12, props });
    return;
  }
  if ((tags.natural === "bay" || tags.natural === "strait" || tags.place === "sea" || tags.place === "ocean") && tags.name) {
    out.push({ layer: "water_name", minZoom: 8, props: named(tags, { class: tags.natural ?? tags.place ?? "bay" }) });
    return;
  }
  const poi = poiClass(tags);
  if (poi) {
    const [cls, sub] = poi;
    const rank = poiRank(cls, sub, tags);
    if (rank <= 14) out.push({ layer: "poi", minZoom: rank, props: named(tags, { class: cls, subclass: sub, rank }) });
    return;
  }
  const number = tags["addr:housenumber"];
  if (number) out.push({ layer: "housenumber", minZoom: 14, props: { housenumber: number } });
}

function classifyLine(tags: Tags, out: Classified[]): void {
  const highway = tags.highway;
  if (highway) {
    const road = ROAD[highway];
    if (road) {
      const [cls, minZoom] = road;
      const props = named(tags, { class: cls });
      if (highway.endsWith("_link")) props.ramp = 1;
      if (cls === "path" || cls === "service") props.subclass = highway === "service" ? (tags.service ?? "service") : highway;
      const b = brunnel(tags);
      if (b) props.brunnel = b;
      if (tags.oneway === "yes" || tags.oneway === "1" || tags.junction === "roundabout") props.oneway = 1;
      else if (tags.oneway === "-1") props.oneway = -1;
      const layer = Number(tags.layer);
      if (Number.isInteger(layer) && layer !== 0) props.layer = Math.max(-5, Math.min(5, layer));
      if (tags.ref) props.ref = tags.ref;
      if (tags.surface) props.surface = /^(paved|asphalt|concrete|paving_stones|sett|chipseal|metal|wood)/.test(tags.surface) ? "paved" : "unpaved";
      const service = tags.service;
      const minor = service === "parking_aisle" || service === "driveway" || service === "drive-through";
      out.push({ layer: "road", minZoom: minor ? 14 : minZoom, props, sortKey: roadSort(cls, props) });
    }
    return;
  }
  const railway = tags.railway;
  if (railway) {
    const minZoom = RAIL[railway];
    if (minZoom !== undefined) {
      const props = named(tags, { class: railway });
      const b = brunnel(tags);
      if (b) props.brunnel = b;
      if (tags.service) props.service = tags.service;
      const layer = Number(tags.layer);
      if (Number.isInteger(layer) && layer !== 0) props.layer = Math.max(-5, Math.min(5, layer));
      out.push({ layer: "railway", minZoom: tags.service ? 13 : minZoom, props });
    }
    return;
  }
  const waterway = tags.waterway;
  if (waterway) {
    const minZoom = waterway === "river" ? 8 : waterway === "canal" ? 11 : waterway === "stream" ? 13 : waterway === "ditch" || waterway === "drain" ? 14 : -1;
    if (minZoom >= 0) {
      const props = named(tags, { class: waterway });
      const b = brunnel(tags);
      if (b === "tunnel") props.brunnel = b;
      if (tags.intermittent === "yes") props.intermittent = 1;
      out.push({ layer: "waterway", minZoom, props });
    }
    return;
  }
  const aeroway = tags.aeroway;
  if (aeroway === "runway" || aeroway === "taxiway") {
    out.push({ layer: "aeroway", minZoom: aeroway === "runway" ? 10 : 12, props: named(tags, { class: aeroway }) });
    return;
  }
  if (tags.man_made === "pier" || tags.man_made === "breakwater") {
    out.push({ layer: "landuse", minZoom: 13, props: { class: "pier" } });
  }
}

function roadSort(cls: string, props: Props): number {
  const order: Record<string, number> = { path: 1, track: 2, service: 3, minor: 4, tertiary: 5, secondary: 6, primary: 7, trunk: 8, motorway: 9 };
  const layer = typeof props.layer === "number" ? props.layer : 0;
  const ramp = props.ramp ? -0.5 : 0;
  return layer * 20 + (props.brunnel === "bridge" ? 10 : props.brunnel === "tunnel" ? -10 : 0) + (order[cls] ?? 0) + ramp;
}

function classifyArea(tags: Tags, out: Classified[]): void {
  const natural = tags.natural;
  const landuse = tags.landuse;
  const water = tags.water;
  if (natural === "water" || water || landuse === "reservoir" || landuse === "basin" || tags.waterway === "riverbank" || tags.waterway === "dock") {
    const cls = WATER_CLASSES[water ?? (landuse === "reservoir" ? "reservoir" : landuse === "basin" ? "basin" : "lake")] ?? "lake";
    const props: Props = { class: tags.waterway === "riverbank" ? "river" : cls };
    if (tags.intermittent === "yes") props.intermittent = 1;
    out.push({ layer: "water", minZoom: 4, minPixels: 6, props });
    if (tags.name) out.push({ layer: "water_name", minZoom: 9, minPixels: 6000, props: named(tags, { class: props.class as string }) });
    return;
  }
  if (natural === "bay" || natural === "strait") {
    if (tags.name) out.push({ layer: "water_name", minZoom: 8, minPixels: 8000, props: named(tags, { class: natural }) });
    return;
  }
  const building = tags.building ?? tags["building:part"];
  if (building && building !== "no") {
    const props: Props = {};
    const height = num(tags.height);
    const levels = num(tags["building:levels"]);
    const roofLevels = num(tags["roof:levels"]) ?? 0;
    if (height !== null && height > 0 && height < 1000) props.height = Math.round(height * 10) / 10;
    else if (levels !== null && levels > 0 && levels < 200) props.height = Math.round((levels + roofLevels) * 3.2 * 10) / 10;
    const minHeight = num(tags.min_height);
    const minLevel = num(tags["building:min_level"]);
    if (minHeight !== null && minHeight > 0) props.min_height = Math.round(minHeight * 10) / 10;
    else if (minLevel !== null && minLevel > 0) props.min_height = Math.round(minLevel * 3.2 * 10) / 10;
    if (tags["building:part"]) props.part = 1;
    out.push({ layer: "building", minZoom: 13, minPixels: 2, props });
    const number = tags["addr:housenumber"];
    if (number) out.push({ layer: "housenumber", minZoom: 14, minPixels: 0, props: { housenumber: number } });
    return;
  }
  const cover = (natural && LANDCOVER[natural]) || (landuse && LANDCOVER[landuse]);
  if (cover) {
    const props: Props = { class: cover };
    if (natural === "wetland" && tags.wetland) props.subclass = tags.wetland;
    out.push({ layer: "landcover", minZoom: 5, minPixels: 40, props });
  }
  const leisure = tags.leisure;
  const amenity = tags.amenity;
  const boundary = tags.boundary;
  if (boundary === "national_park" || boundary === "protected_area" || leisure === "nature_reserve") {
    const cls = boundary === "national_park" ? "national_park" : leisure === "nature_reserve" ? "nature_reserve" : "protected_area";
    out.push({ layer: "park", minZoom: 5, minPixels: 400, props: named(tags, { class: cls }) });
    if (tags.name) out.push({ layer: "poi", minZoom: 8, minPixels: 40000, props: named(tags, { class: "park", subclass: cls, rank: 9 }) });
    return;
  }
  let use: string | null = null;
  if (landuse && LANDUSE[landuse]) use = LANDUSE[landuse]!;
  else if (leisure === "park" || leisure === "garden" || leisure === "dog_park" || leisure === "playground" || leisure === "common") use = "park";
  else if (leisure === "pitch" || leisure === "sports_centre" || leisure === "track" || leisure === "stadium") use = "pitch";
  else if (leisure === "golf_course") use = "golf";
  else if (amenity === "school" || amenity === "college" || amenity === "university" || amenity === "kindergarten") use = "school";
  else if (amenity === "hospital" || amenity === "clinic") use = "hospital";
  else if (amenity === "parking") use = "parking";
  else if (amenity === "grave_yard") use = "cemetery";
  else if (tags.aeroway === "aerodrome") use = "airport";
  else if (tags.aeroway === "apron") use = "apron";
  else if (tags.tourism === "zoo" || tags.tourism === "theme_park") use = "park";
  else if (tags.man_made === "pier") use = "pier";
  else if (tags.highway === "pedestrian" || tags.place === "square") use = "pedestrian";
  if (use) {
    const minZoom = use === "parking" || use === "pier" || use === "pedestrian" ? 13 : use === "apron" ? 12 : 6;
    out.push({ layer: use === "apron" ? "aeroway" : "landuse", minZoom, minPixels: use === "airport" ? 200 : 60, props: { class: use } });
  }
  if (tags.place === "island" || tags.place === "islet") {
    if (tags.name) out.push({ layer: "place", minZoom: tags.place === "island" ? 9 : 12, minPixels: 3000, props: named(tags, { class: tags.place, rank: tags.place === "island" ? 9 : 12 }) });
    return;
  }
  const poi = poiClass(tags);
  if (poi && tags.name) {
    const [cls, sub] = poi;
    const rank = poiRank(cls, sub, tags);
    if (rank <= 14) out.push({ layer: "poi", minZoom: rank, minPixels: rank <= 12 ? 2000 : 200, props: named(tags, { class: cls, subclass: sub, rank }) });
  }
}

export function boundaryLevel(tags: Tags): number | null {
  if (tags.boundary !== "administrative") return null;
  const level = Number(tags.admin_level);
  if (!Number.isInteger(level) || level < 2 || level > 8) return null;
  return level;
}

export function boundaryMinZoom(level: number): number {
  if (level <= 2) return 0;
  if (level <= 4) return 3;
  if (level <= 6) return 7;
  return 10;
}

export function isRelevantRelation(tags: Tags): boolean {
  const type = tags.type;
  if (type === "multipolygon") return classify(tags, "area").length > 0;
  if (type === "boundary") {
    if (boundaryLevel(tags) !== null) return true;
    return tags.boundary === "national_park" || tags.boundary === "protected_area";
  }
  return false;
}

export function isRelevantWay(tags: Tags): boolean {
  if (tags.natural === "coastline") return true;
  return classify(tags, "line").length > 0 || classify(tags, "area").length > 0;
}

export function isRelevantPoint(tags: Tags): boolean {
  return classify(tags, "point").length > 0;
}
