import type { FeatureFormat } from "../formats/feature-format.ts";
import { FEATURE_FORMATS } from "../formats/feature-format.ts";
import { compile, ExpressionError } from "./expression.ts";
import { LAYOUT, PAINT } from "./layer.ts";
import type { LayerType, SourceSpec, StyleSpec } from "./types.ts";

export interface StyleIssue {
  path: string;
  message: string;
}

const LAYER_TYPES = new Set<LayerType>(Object.keys(PAINT) as LayerType[]);
const SOURCE_TYPES = new Set(["raster", "vector", "dem", "geojson"]);
const SOURCE_KEYS: Record<string, Set<string>> = {
  raster: new Set(["type", "tiles", "url", "minZoom", "maxZoom", "bounds", "scheme", "attribution", "tileSize"]),
  vector: new Set(["type", "tiles", "url", "minZoom", "maxZoom", "bounds", "scheme", "attribution", "promoteId"]),
  dem: new Set([
    "type",
    "tiles",
    "url",
    "minZoom",
    "maxZoom",
    "bounds",
    "scheme",
    "attribution",
    "tileSize",
    "encoding",
  ]),
  geojson: new Set([
    "type",
    "data",
    "format",
    "maxZoom",
    "tolerance",
    "buffer",
    "attribution",
    "promoteId",
    "generateId",
    "cluster",
    "clusterRadius",
    "clusterMaxZoom",
    "clusterMinPoints",
    "clusterProperties",
  ]),
};
const LAYER_KEYS = new Set([
  "id",
  "type",
  "source",
  "sourceLayer",
  "minZoom",
  "maxZoom",
  "visible",
  "filter",
  "paint",
  "layout",
  "sortKey",
]);
const STYLE_KEYS = new Set([
  "version",
  "name",
  "center",
  "zoom",
  "bearing",
  "pitch",
  "sources",
  "layers",
  "terrain",
  "fonts",
  "sprite",
  "metadata",
]);

export function validateStyle(style: unknown): StyleIssue[] {
  const issues: StyleIssue[] = [];
  if (!isObject(style)) return [{ path: "", message: "style must be an object" }];
  if (style.version !== 1) issues.push({ path: "version", message: "version must be 1" });
  for (const key of Object.keys(style)) {
    if (!STYLE_KEYS.has(key)) issues.push({ path: key, message: `unknown style property "${key}"` });
  }
  if (style.sprite !== undefined && !isSprite(style.sprite)) {
    issues.push({ path: "sprite", message: "sprite must be a URL or a list of { id, url }" });
  }
  if (style.center !== undefined && !isLngLat(style.center)) {
    issues.push({ path: "center", message: "center must be [lng, lat]" });
  }
  for (const key of ["zoom", "bearing", "pitch"] as const) {
    if (style[key] !== undefined && !isFiniteNumber(style[key]))
      issues.push({ path: key, message: `${key} must be a number` });
  }
  const sources = style.sources;
  if (!isObject(sources)) {
    issues.push({ path: "sources", message: "sources must be an object" });
  } else {
    for (const [id, source] of Object.entries(sources)) issues.push(...validateSource(id, source));
  }
  const layers = style.layers;
  if (!Array.isArray(layers)) {
    issues.push({ path: "layers", message: "layers must be an array" });
  } else {
    const ids = new Set<string>();
    layers.forEach((layer, i) => {
      issues.push(
        ...validateLayer(layer, `layers[${i}]`, isObject(sources) ? (sources as Record<string, SourceSpec>) : {}),
      );
      if (isObject(layer) && typeof layer.id === "string") {
        if (ids.has(layer.id)) issues.push({ path: `layers[${i}].id`, message: `duplicate layer id "${layer.id}"` });
        ids.add(layer.id);
      }
    });
  }
  if (style.terrain !== undefined) {
    const t = style.terrain;
    if (!isObject(t) || typeof t.source !== "string") {
      issues.push({ path: "terrain", message: "terrain must be { source, exaggeration? }" });
    } else if (isObject(sources) && (sources as Record<string, SourceSpec>)[t.source]?.type !== "dem") {
      issues.push({ path: "terrain.source", message: `terrain source "${t.source}" must be a dem source` });
    }
  }
  return issues;
}

export function validateSource(id: string, source: unknown): StyleIssue[] {
  const path = `sources.${id}`;
  if (!isObject(source)) return [{ path, message: "source must be an object" }];
  const type = source.type;
  if (typeof type !== "string" || !SOURCE_TYPES.has(type)) {
    return [{ path: `${path}.type`, message: "source type must be raster, vector, dem or geojson" }];
  }
  const issues: StyleIssue[] = [];
  const allowed = SOURCE_KEYS[type]!;
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: `unknown ${type} source property "${key}"` });
  }
  if (type === "geojson") {
    if (source.data === undefined || (typeof source.data !== "string" && !isObject(source.data))) {
      issues.push({ path: `${path}.data`, message: "geojson data must be GeoJSON, a URL or a file" });
    }
    if (source.format !== undefined && !FEATURE_FORMATS.includes(source.format as FeatureFormat)) {
      issues.push({ path: `${path}.format`, message: `format must be one of ${FEATURE_FORMATS.join(", ")}` });
    }
    if (isFiniteNumber(source.maxZoom) && source.maxZoom > 24) {
      issues.push({ path: `${path}.maxZoom`, message: "geojson maxZoom must be 24 or less" });
    }
    if (isFiniteNumber(source.buffer) && source.buffer > 512) {
      issues.push({ path: `${path}.buffer`, message: "buffer must be between 0 and 512 pixels" });
    }
  } else {
    const hasTiles =
      Array.isArray(source.tiles) && source.tiles.length > 0 && source.tiles.every((t) => typeof t === "string");
    if (!hasTiles && typeof source.url !== "string") {
      issues.push({ path, message: `${type} source needs "tiles" or a TileJSON "url"` });
    }
    if (source.scheme !== undefined && source.scheme !== "xyz" && source.scheme !== "tms") {
      issues.push({ path: `${path}.scheme`, message: "scheme must be xyz or tms" });
    }
    if (
      source.bounds !== undefined &&
      !(Array.isArray(source.bounds) && source.bounds.length === 4 && source.bounds.every(isFiniteNumber))
    ) {
      issues.push({ path: `${path}.bounds`, message: "bounds must be [west, south, east, north]" });
    }
    if (type === "dem" && source.encoding !== undefined && !isEncoding(source.encoding)) {
      issues.push({
        path: `${path}.encoding`,
        message: "encoding must be terrarium, mapbox or { red, green, blue, offset }",
      });
    }
  }
  if (source.promoteId !== undefined && !isPromoteId(source.promoteId, type === "vector")) {
    issues.push({
      path: `${path}.promoteId`,
      message:
        type === "vector"
          ? "promoteId must be a property name or { sourceLayer: propertyName }"
          : "promoteId must be a property name",
    });
  }
  if (source.generateId !== undefined && typeof source.generateId !== "boolean") {
    issues.push({ path: `${path}.generateId`, message: "generateId must be true or false" });
  }
  if (source.cluster !== undefined && typeof source.cluster !== "boolean") {
    issues.push({ path: `${path}.cluster`, message: "cluster must be true or false" });
  }
  for (const key of ["clusterRadius", "clusterMaxZoom", "clusterMinPoints"] as const) {
    const v = source[key];
    if (v !== undefined && (!isFiniteNumber(v) || v < 0))
      issues.push({ path: `${path}.${key}`, message: `${key} must be a non-negative number` });
  }
  if (source.clusterProperties !== undefined) issues.push(...checkClusterProperties(source.clusterProperties, path));
  for (const key of ["minZoom", "maxZoom", "tileSize", "tolerance", "buffer"] as const) {
    const v = source[key];
    if (v !== undefined && (!isFiniteNumber(v) || v < 0))
      issues.push({ path: `${path}.${key}`, message: `${key} must be a non-negative number` });
  }
  return issues;
}

export function validateLayer(layer: unknown, path: string, sources: Record<string, SourceSpec>): StyleIssue[] {
  if (!isObject(layer)) return [{ path, message: "layer must be an object" }];
  const issues: StyleIssue[] = [];
  if (typeof layer.id !== "string" || layer.id.length === 0)
    issues.push({ path: `${path}.id`, message: "layer id must be a non-empty string" });
  const type = layer.type as LayerType;
  if (typeof type !== "string" || !LAYER_TYPES.has(type)) {
    issues.push({ path: `${path}.type`, message: `layer type must be one of ${[...LAYER_TYPES].join(", ")}` });
    return issues;
  }
  for (const key of Object.keys(layer)) {
    if (!LAYER_KEYS.has(key)) issues.push({ path: `${path}.${key}`, message: `unknown layer property "${key}"` });
  }
  if (type !== "background") {
    if (typeof layer.source !== "string") {
      issues.push({ path: `${path}.source`, message: `${type} layer needs a source` });
    } else {
      const source = sources[layer.source];
      if (!source) issues.push({ path: `${path}.source`, message: `source "${layer.source}" does not exist` });
      else issues.push(...checkSourceType(type, source, layer, path));
    }
  }
  for (const key of ["minZoom", "maxZoom"] as const) {
    if (layer[key] !== undefined && !isFiniteNumber(layer[key]))
      issues.push({ path: `${path}.${key}`, message: `${key} must be a number` });
  }
  if (layer.visible !== undefined && typeof layer.visible !== "boolean")
    issues.push({ path: `${path}.visible`, message: "visible must be true or false" });
  if (layer.filter !== undefined) issues.push(...checkExpression(layer.filter, `${path}.filter`, false));
  issues.push(...checkGroup(layer.paint, PAINT[type], `${path}.paint`, type, true));
  issues.push(...checkGroup(layer.layout, LAYOUT[type], `${path}.layout`, type, false));
  return issues;
}

function checkSourceType(
  type: LayerType,
  source: SourceSpec,
  layer: Record<string, unknown>,
  path: string,
): StyleIssue[] {
  const featureLayers: LayerType[] = ["fill", "line", "circle", "heatmap", "symbol", "extrusion"];
  if (type === "raster" && source.type !== "raster")
    return [{ path: `${path}.source`, message: "raster layers need a raster source" }];
  if (type === "hillshade" && source.type !== "dem")
    return [{ path: `${path}.source`, message: "hillshade layers need a dem source" }];
  if (featureLayers.includes(type)) {
    if (source.type !== "vector" && source.type !== "geojson") {
      return [{ path: `${path}.source`, message: `${type} layers need a vector or geojson source` }];
    }
    if (source.type === "vector" && typeof layer.sourceLayer !== "string") {
      return [{ path: `${path}.sourceLayer`, message: "layers on a vector source need sourceLayer" }];
    }
  }
  return [];
}

function checkGroup(
  group: unknown,
  defs: Record<string, { expression: boolean; check?: (v: unknown) => string | null; kind: string }>,
  path: string,
  type: string,
  allowState: boolean,
): StyleIssue[] {
  if (group === undefined) return [];
  if (!isObject(group)) return [{ path, message: "must be an object" }];
  const issues: StyleIssue[] = [];
  for (const [key, value] of Object.entries(group)) {
    const def = defs[key];
    if (!def) {
      issues.push({ path: `${path}.${key}`, message: `"${key}" is not a property of ${type} layers` });
      continue;
    }
    if (def.expression) {
      issues.push(...checkExpression(value, `${path}.${key}`, allowState));
    } else if (def.check) {
      const problem = def.check(value);
      if (problem) issues.push({ path: `${path}.${key}`, message: problem });
    }
  }
  return issues;
}

function checkExpression(value: unknown, path: string, allowState: boolean): StyleIssue[] {
  try {
    compile(value, "any", null, path, allowState);
    return [];
  } catch (error) {
    const message = error instanceof ExpressionError ? error.message.replace(`${path}: `, "") : String(error);
    return [{ path, message }];
  }
}

export function formatIssues(issues: readonly StyleIssue[]): string {
  return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("\n");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkClusterProperties(value: unknown, path: string): StyleIssue[] {
  if (!isObject(value)) return [{ path: `${path}.clusterProperties`, message: "clusterProperties must be an object" }];
  const issues: StyleIssue[] = [];
  for (const [name, spec] of Object.entries(value)) {
    const at = `${path}.clusterProperties.${name}`;
    if (!Array.isArray(spec) || spec.length !== 2) {
      issues.push({ path: at, message: "each cluster property must be [operator, expression]" });
      continue;
    }
    const [operator, mapped] = spec as [unknown, unknown];
    const reducer = typeof operator === "string" ? [operator, ["accumulated"], ["get", name]] : operator;
    issues.push(...checkExpression(mapped, at, false), ...checkExpression(reducer, at, false));
  }
  return issues;
}

function isSprite(v: unknown): boolean {
  if (typeof v === "string") return v !== "";
  if (!Array.isArray(v) || v.length === 0) return false;
  const ids = new Set<string>();
  for (const entry of v) {
    if (!isObject(entry) || typeof entry.id !== "string" || typeof entry.url !== "string" || entry.url === "") {
      return false;
    }
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
  }
  return true;
}

function isPromoteId(v: unknown, perLayer: boolean): boolean {
  if (typeof v === "string") return v !== "";
  return perLayer && isObject(v) && Object.values(v).every((name) => typeof name === "string" && name !== "");
}

function isEncoding(v: unknown): boolean {
  if (v === "terrarium" || v === "mapbox") return true;
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 4 && ["red", "green", "blue", "offset"].every((k) => keys.includes(k) && isFiniteNumber(v[k]));
}

function isLngLat(v: unknown): boolean {
  return Array.isArray(v) && v.length === 2 && v.every(isFiniteNumber);
}

export function isStyleSpec(v: unknown): v is StyleSpec {
  return validateStyle(v).length === 0;
}
