import { deepClone } from "../core/clone.ts";
import { MapkernError } from "../core/errors.ts";
import { fontFromNames } from "../text/glyphs.ts";
import { compile, isOperator } from "./expression.ts";
import type { PropertyDef } from "./layer.ts";
import { LAYOUT, PAINT, transitionOf } from "./layer.ts";
import type { LayerSpec, LayerType, SkySpec, SourceSpec, StyleSpec } from "./types.ts";
import { validateLayer, validateSky, validateSource, validateStyle } from "./validate.ts";

export interface ImportedStyle {
  style: StyleSpec;
  skipped: string[];
}

type Json = Record<string, unknown>;

interface Target {
  group: "paint" | "layout";
  name: string;
}

const paint = (name: string): Target => ({ group: "paint", name });
const layout = (name: string): Target => ({ group: "layout", name });

const TYPES: Record<string, LayerType> = {
  background: "background",
  fill: "fill",
  line: "line",
  symbol: "symbol",
  circle: "circle",
  heatmap: "heatmap",
  "fill-extrusion": "extrusion",
  raster: "raster",
  hillshade: "hillshade",
};

const PROPERTIES: Record<LayerType, Record<string, Target>> = {
  background: { "background-color": paint("color"), "background-opacity": paint("opacity") },
  fill: {
    "fill-antialias": paint("antialias"),
    "fill-opacity": paint("opacity"),
    "fill-color": paint("color"),
    "fill-outline-color": paint("outlineColor"),
    "fill-translate": paint("translate"),
    "fill-translate-anchor": paint("translateAnchor"),
    "fill-pattern": paint("pattern"),
  },
  line: {
    "line-cap": layout("cap"),
    "line-join": layout("join"),
    "line-miter-limit": layout("miterLimit"),
    "line-opacity": paint("opacity"),
    "line-color": paint("color"),
    "line-width": paint("width"),
    "line-gap-width": paint("gapWidth"),
    "line-offset": paint("offset"),
    "line-blur": paint("blur"),
    "line-dasharray": paint("dash"),
  },
  circle: {
    "circle-radius": paint("radius"),
    "circle-color": paint("color"),
    "circle-blur": paint("blur"),
    "circle-opacity": paint("opacity"),
    "circle-translate": paint("translate"),
    "circle-translate-anchor": paint("translateAnchor"),
    "circle-pitch-scale": paint("pitchScale"),
    "circle-pitch-alignment": paint("pitchAlignment"),
    "circle-stroke-width": paint("strokeWidth"),
    "circle-stroke-color": paint("strokeColor"),
    "circle-stroke-opacity": paint("strokeOpacity"),
  },
  heatmap: {
    "heatmap-radius": paint("radius"),
    "heatmap-weight": paint("weight"),
    "heatmap-intensity": paint("intensity"),
    "heatmap-color": paint("color"),
    "heatmap-opacity": paint("opacity"),
  },
  extrusion: {
    "fill-extrusion-opacity": paint("opacity"),
    "fill-extrusion-color": paint("color"),
    "fill-extrusion-height": paint("height"),
    "fill-extrusion-base": paint("base"),
  },
  raster: {
    "raster-opacity": paint("opacity"),
    "raster-hue-rotate": paint("hueRotate"),
    "raster-brightness-min": paint("brightnessMin"),
    "raster-brightness-max": paint("brightnessMax"),
    "raster-saturation": paint("saturation"),
    "raster-contrast": paint("contrast"),
    "raster-resampling": paint("resampling"),
    "raster-fade-duration": paint("fadeDuration"),
  },
  hillshade: {
    "hillshade-illumination-direction": paint("illuminationDirection"),
    "hillshade-illumination-anchor": paint("illuminationAnchor"),
    "hillshade-exaggeration": paint("exaggeration"),
    "hillshade-shadow-color": paint("shadowColor"),
    "hillshade-highlight-color": paint("highlightColor"),
    "hillshade-accent-color": paint("accentColor"),
  },
  symbol: {
    "symbol-placement": layout("placement"),
    "symbol-spacing": layout("spacing"),
    "icon-allow-overlap": layout("iconAllowOverlap"),
    "icon-ignore-placement": layout("iconIgnorePlacement"),
    "icon-optional": layout("iconOptional"),
    "icon-rotation-alignment": layout("iconRotationAlignment"),
    "icon-size": layout("iconSize"),
    "icon-image": layout("icon"),
    "icon-rotate": layout("iconRotate"),
    "icon-padding": layout("iconPadding"),
    "icon-offset": layout("iconOffset"),
    "icon-anchor": layout("iconAnchor"),
    "icon-text-fit": layout("iconTextFit"),
    "icon-text-fit-padding": layout("iconTextFitPadding"),
    "text-rotation-alignment": layout("rotationAlignment"),
    "text-pitch-alignment": layout("pitchAlignment"),
    "text-field": layout("text"),
    "text-size": layout("size"),
    "text-max-width": layout("maxWidth"),
    "text-line-height": layout("lineHeight"),
    "text-letter-spacing": layout("letterSpacing"),
    "text-justify": layout("justify"),
    "text-radial-offset": layout("radialOffset"),
    "text-variable-anchor": layout("variableAnchor"),
    "text-anchor": layout("anchor"),
    "text-max-angle": layout("maxAngle"),
    "text-rotate": layout("rotate"),
    "text-padding": layout("padding"),
    "text-keep-upright": layout("keepUpright"),
    "text-transform": layout("transform"),
    "text-offset": layout("offset"),
    "text-allow-overlap": layout("allowOverlap"),
    "text-ignore-placement": layout("ignorePlacement"),
    "text-optional": layout("optional"),
    "text-color": paint("color"),
    "text-halo-color": paint("haloColor"),
    "text-halo-width": paint("haloWidth"),
    "text-halo-blur": paint("haloBlur"),
    "text-opacity": paint("opacity"),
    "text-translate": paint("translate"),
    "text-translate-anchor": paint("translateAnchor"),
    "icon-color": paint("iconColor"),
    "icon-halo-color": paint("iconHaloColor"),
    "icon-halo-width": paint("iconHaloWidth"),
    "icon-opacity": paint("iconOpacity"),
    "icon-translate": paint("iconTranslate"),
    "icon-translate-anchor": paint("iconTranslateAnchor"),
  },
};

const QUIET = new Set([
  "line-round-limit",
  "fill-extrusion-vertical-gradient",
  "symbol-z-order",
  "icon-keep-upright",
  "symbol-avoid-edges",
]);

const DROPPED_ROOT = ["light", "lights", "projection", "imports", "models", "camera", "state", "schema"];

const SKY_NAMES: Record<string, keyof SkySpec> = {
  "sky-color": "color",
  "horizon-color": "horizonColor",
  "fog-color": "fogColor",
  "fog-ground-blend": "fogBlend",
  "horizon-fog-blend": "horizonFogBlend",
  "sky-horizon-blend": "horizonBlend",
};

const FOG_NAMES: Record<string, (keyof SkySpec)[]> = {
  color: ["horizonColor", "fogColor"],
  "high-color": ["color"],
  "horizon-blend": ["horizonBlend"],
};

function convertSky(input: Record<string, unknown>, skipped: Skipped): SkySpec | undefined {
  const sky: SkySpec = {};
  const set = (name: keyof SkySpec, value: unknown) => {
    const kind = name.endsWith("olor") ? "color" : "number";
    (sky as Record<string, unknown>)[name] = convertValue(
      value,
      { kind, default: null, expression: true, feature: false },
      name,
    );
  };
  if (isObject(input.sky)) {
    for (const [key, value] of Object.entries(input.sky)) {
      const name = SKY_NAMES[key];
      if (name) set(name, value);
      else if (key !== "atmosphere-blend") skipped.add(`sky ${key} isn't supported yet`);
    }
  } else if (isObject(input.fog)) {
    for (const [key, value] of Object.entries(input.fog)) {
      const names = FOG_NAMES[key];
      if (names) for (const name of names) set(name, value);
      else skipped.add(`fog ${key} isn't supported yet, the fog colors are used for the sky`);
    }
  }
  if (Object.keys(sky).length === 0) return undefined;
  const issues = validateSky(sky);
  if (issues.length > 0) {
    skipped.add(`sky couldn't be read: ${issues[0]!.message}`);
    return undefined;
  }
  return sky;
}

const V8_HEAT = [
  "interpolate",
  ["linear"],
  ["heatmap-density"],
  0,
  "rgba(0, 0, 255, 0)",
  0.1,
  "royalblue",
  0.3,
  "cyan",
  0.5,
  "lime",
  0.7,
  "yellow",
  1,
  "red",
];

const LEGACY_COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);

const STEPPED = new Set(["line-dasharray", "text-variable-anchor", "text-font", "icon-image", "text-field"]);

class Skipped {
  private readonly reasons = new Map<string, string[]>();

  add(reason: string, layer?: string): void {
    let layers = this.reasons.get(reason);
    if (!layers) {
      layers = [];
      this.reasons.set(reason, layers);
    }
    if (layer !== undefined && !layers.includes(layer)) layers.push(layer);
  }

  list(): string[] {
    const out: string[] = [];
    for (const [reason, layers] of this.reasons) {
      if (layers.length === 0) out.push(reason);
      else if (layers.length <= 3) out.push(`${reason} (${layers.join(", ")})`);
      else out.push(`${reason} (${layers.slice(0, 3).join(", ")} and ${layers.length - 3} more)`);
    }
    return out;
  }
}

export function isStyleV8(value: unknown): boolean {
  return isObject(value) && value.version === 8;
}

export interface ImportedLayer {
  layer: LayerSpec | null;
  skipped: string[];
}

export interface ImportedSource {
  source: SourceSpec | null;
  skipped: string[];
}

export function importLayer(raw: unknown, sources: Record<string, SourceSpec>, serverFonts: boolean): ImportedLayer {
  if (!isObject(raw) || typeof raw.id !== "string") {
    throw new MapkernError("invalid-style", "A layer needs an id and a type");
  }
  const skipped = new Skipped();
  const converted = convertLayer(raw, sources, skipped, serverFonts);
  const layer = converted ? settle(converted.layer, converted.origin, raw.id, sources, skipped) : null;
  return { layer, skipped: skipped.list() };
}

export function importSource(id: string, raw: unknown, base?: string): ImportedSource {
  const skipped = new Skipped();
  const source = convertSource(id, raw, base, skipped);
  if (!source) return { source: null, skipped: skipped.list() };
  const issues = validateSource(id, source);
  if (issues.length > 0) {
    skipped.add(`source "${id}" couldn't be read: ${issues[0]!.message}`);
    return { source: null, skipped: skipped.list() };
  }
  return { source, skipped: skipped.list() };
}

export function importSky(root: { sky?: unknown; fog?: unknown }): { sky: SkySpec | null; skipped: string[] } {
  const skipped = new Skipped();
  const sky = convertSky(root as Record<string, unknown>, skipped) ?? null;
  return { sky, skipped: skipped.list() };
}

export function layerTypeOf(v8Type: string): LayerType | undefined {
  return TYPES[v8Type];
}

export function serverGlyphs(glyphs: unknown): string | null {
  return typeof glyphs === "string" && !glyphs.startsWith("mapbox://") ? glyphs : null;
}

export function importStyle(input: unknown, base?: string): ImportedStyle {
  if (!isObject(input) || input.version !== 8) {
    throw new MapkernError("invalid-style", "importStyle reads styles written for the version 8 style format");
  }
  const skipped = new Skipped();
  const style: Json = { version: 1 };
  for (const key of ["name", "center", "zoom", "bearing", "pitch", "metadata", "transition"]) {
    if (input[key] !== undefined) style[key] = deepClone(input[key]);
  }
  const glyphs = typeof input.glyphs === "string" && !input.glyphs.startsWith("mapbox://") ? input.glyphs : null;
  if (glyphs) style.glyphs = absolute(glyphs, base);
  else if (input.glyphs !== undefined)
    skipped.add("the glyphs use a mapbox:// address, so labels use the device's fonts");
  if (input.sprite !== undefined) {
    const sprite = spriteOf(input.sprite, base);
    if (sprite === null) skipped.add("the sprite uses a mapbox:// address, which only Mapbox's servers understand");
    else style.sprite = sprite;
  }
  for (const key of DROPPED_ROOT) if (input[key] !== undefined) skipped.add(`${key} isn't supported yet`);
  const sky = convertSky(input, skipped);
  if (sky) style.sky = sky;
  const sources: Record<string, SourceSpec> = {};
  for (const [id, raw] of Object.entries(isObject(input.sources) ? input.sources : {})) {
    const source = convertSource(id, raw, base, skipped);
    if (!source) continue;
    const issues = validateSource(id, source);
    if (issues.length > 0) {
      skipped.add(`source "${id}" couldn't be read: ${issues[0]!.message}`);
      continue;
    }
    sources[id] = source;
  }
  if (isObject(input.terrain) && typeof input.terrain.source === "string") {
    if (sources[input.terrain.source]?.type === "dem") {
      style.terrain = { source: input.terrain.source, exaggeration: numberOr(input.terrain.exaggeration, 1) };
    } else {
      skipped.add(`terrain needs the raster-dem source "${input.terrain.source}"`);
    }
  }
  const layers: LayerSpec[] = [];
  const ids = new Set<string>();
  const list = Array.isArray(input.layers) ? input.layers : [];
  const byId = new Map<string, Json>();
  for (const raw of list) if (isObject(raw) && typeof raw.id === "string" && !byId.has(raw.id)) byId.set(raw.id, raw);
  for (const original of list) {
    if (!isObject(original) || typeof original.id !== "string" || ids.has(original.id)) continue;
    const raw = typeof original.ref === "string" ? withRef(original, byId.get(original.ref)) : original;
    if (!raw) {
      skipped.add("layers whose ref names no other layer", original.id);
      continue;
    }
    const converted = convertLayer(raw, sources, skipped, glyphs !== null);
    if (!converted) continue;
    const checked = settle(converted.layer, converted.origin, original.id, sources, skipped);
    if (!checked) continue;
    ids.add(original.id);
    layers.push(checked);
  }
  style.sources = sources;
  style.layers = layers;
  for (let attempt = 0; attempt < 16; attempt++) {
    const root = validateStyle(style).filter(
      (issue) => !issue.path.startsWith("layers") && !issue.path.startsWith("sources"),
    );
    if (root.length === 0) break;
    for (const issue of root) {
      const key = issue.path.split(".")[0]!;
      if (key in style && key !== "version") {
        delete style[key];
        skipped.add(`${key} couldn't be used: ${issue.message}`);
      }
    }
  }
  return { style: style as unknown as StyleSpec, skipped: skipped.list() };
}

function withRef(layer: Json, parent: Json | undefined): Json | null {
  if (!parent || typeof parent.ref === "string") return null;
  const out: Json = { ...layer };
  delete out.ref;
  for (const key of ["type", "source", "source-layer", "minzoom", "maxzoom", "filter", "layout"]) {
    if (parent[key] !== undefined) out[key] = parent[key];
  }
  return out;
}

function convertSource(id: string, raw: unknown, base: string | undefined, skipped: Skipped): SourceSpec | null {
  if (!isObject(raw)) {
    skipped.add(`source "${id}" isn't an object`);
    return null;
  }
  const urls = [raw.url, raw.data, ...(Array.isArray(raw.tiles) ? raw.tiles : [])];
  if (urls.some((u) => typeof u === "string" && u.startsWith("mapbox://"))) {
    skipped.add(`source "${id}" uses a mapbox:// address, which only Mapbox's servers understand`);
    return null;
  }
  switch (raw.type) {
    case "vector": {
      if (raw.encoding !== undefined && raw.encoding !== "mvt") {
        skipped.add(`source "${id}" uses ${String(raw.encoding)} tiles, which aren't supported yet`);
        return null;
      }
      const out = tiled("vector", raw, base);
      if (raw.promoteId !== undefined) out.promoteId = raw.promoteId;
      return out as unknown as SourceSpec;
    }
    case "raster": {
      const out = tiled("raster", raw, base);
      out.tileSize = numberOr(raw.tileSize, 512);
      return out as unknown as SourceSpec;
    }
    case "raster-dem": {
      const out = tiled("dem", raw, base);
      out.tileSize = numberOr(raw.tileSize, 512);
      if (raw.encoding === "terrarium") out.encoding = "terrarium";
      else if (raw.encoding === "custom") {
        out.encoding = {
          red: numberOr(raw.redFactor, 1),
          green: numberOr(raw.greenFactor, 1),
          blue: numberOr(raw.blueFactor, 1),
          offset: numberOr(raw.baseShift, 0),
        };
      } else out.encoding = "mapbox";
      return out as unknown as SourceSpec;
    }
    case "geojson": {
      const out: Json = { type: "geojson", data: typeof raw.data === "string" ? absolute(raw.data, base) : raw.data };
      if (raw.maxzoom !== undefined) out.maxZoom = raw.maxzoom;
      for (const key of [
        "attribution",
        "buffer",
        "tolerance",
        "generateId",
        "promoteId",
        "cluster",
        "clusterRadius",
        "clusterMaxZoom",
        "clusterMinPoints",
        "clusterProperties",
      ]) {
        if (raw[key] !== undefined) out[key] = deepClone(raw[key]);
      }
      if (raw.lineMetrics === true) skipped.add(`source "${id}": lineMetrics isn't supported yet`);
      if (raw.filter !== undefined)
        skipped.add(`source "${id}": a source filter isn't supported yet, use layer filters`);
      return out as unknown as SourceSpec;
    }
    case "image":
      return {
        type: "image",
        url: typeof raw.url === "string" ? absolute(raw.url, base) : "",
        coordinates: raw.coordinates,
        ...(raw.attribution !== undefined ? { attribution: raw.attribution } : {}),
      } as unknown as SourceSpec;
    case "video":
      return {
        type: "video",
        urls: Array.isArray(raw.urls) ? raw.urls.map((u) => absolute(String(u), base)) : [],
        coordinates: raw.coordinates,
        ...(raw.attribution !== undefined ? { attribution: raw.attribution } : {}),
      } as unknown as SourceSpec;
    case "canvas":
      return {
        type: "canvas",
        canvas: raw.canvas,
        coordinates: raw.coordinates,
        ...(raw.animate !== undefined ? { animate: raw.animate } : {}),
      } as unknown as SourceSpec;
    default:
      skipped.add(`source "${id}" has type ${String(raw.type)}, which isn't supported`);
      return null;
  }
}

function tiled(type: string, raw: Json, base: string | undefined): Json {
  const out: Json = { type };
  if (typeof raw.url === "string") out.url = absolute(raw.url, base);
  if (Array.isArray(raw.tiles)) {
    out.tiles = raw.tiles.map((t) => absolute(String(t), base));
    if (raw.maxzoom === undefined) out.maxZoom = 22;
  }
  if (raw.minzoom !== undefined) out.minZoom = raw.minzoom;
  if (raw.maxzoom !== undefined) out.maxZoom = raw.maxzoom;
  for (const key of ["bounds", "scheme", "attribution"]) if (raw[key] !== undefined) out[key] = raw[key];
  return out;
}

function convertLayer(
  raw: Json,
  sources: Record<string, SourceSpec>,
  skipped: Skipped,
  serverFonts: boolean,
): { layer: Json; origin: Map<string, string> } | null {
  const id = raw.id as string;
  const type = TYPES[String(raw.type)];
  if (!type) {
    skipped.add(`${String(raw.type)} layers aren't supported yet`, id);
    return null;
  }
  const out: Json = { id, type };
  if (type !== "background") {
    if (typeof raw.source !== "string" || !sources[raw.source]) {
      skipped.add("layers whose source was left out", id);
      return null;
    }
    out.source = raw.source;
    if (raw["source-layer"] !== undefined) out.sourceLayer = raw["source-layer"];
  }
  if (raw.minzoom !== undefined) out.minZoom = raw.minzoom;
  if (raw.maxzoom !== undefined) out.maxZoom = raw.maxzoom;
  if (raw.filter !== undefined) out.filter = convertFilter(raw.filter);
  const paintOut: Json = {};
  const layoutOut: Json = {};
  const origin = new Map<string, string>();
  const table = PROPERTIES[type];
  let overlap: unknown;
  let iconOverlap: unknown;
  let pattern = false;
  const entries = [
    ...Object.entries(isObject(raw.paint) ? raw.paint : {}),
    ...Object.entries(isObject(raw.layout) ? raw.layout : {}),
  ];
  for (const [key, value] of entries) {
    if (key === "visibility") {
      if (value === "none") out.visible = false;
      continue;
    }
    if (key.endsWith("-transition")) {
      const target = table[key.slice(0, -"-transition".length)];
      if (target?.group === "paint" && transitionOf(type, `${target.name}Transition`)) {
        paintOut[`${target.name}Transition`] = deepClone(value);
        origin.set(`paint.${target.name}Transition`, key);
      }
      continue;
    }
    switch (key) {
      case "text-font": {
        const source = isFunction(value) ? functionValue(value, undefined, false, false) : value;
        if (serverFonts) {
          layoutOut.font = source;
          origin.set("layout.font", key);
          continue;
        }
        const constant = fontOf(source);
        if (constant) {
          layoutOut.font = constant.families;
          if (constant.bold) layoutOut.weight = "bold";
          if (constant.italic) layoutOut.italic = true;
        } else {
          layoutOut.font = fontLeaves(source, (list) => ["literal", fontOf(list)!.families]);
          layoutOut.weight = fontLeaves(source, (list) => (fontOf(list)!.bold ? "bold" : "normal"));
          layoutOut.italic = fontLeaves(source, (list) => fontOf(list)!.italic);
        }
        for (const name of ["font", "weight", "italic"]) origin.set(`layout.${name}`, key);
        continue;
      }
      case "fill-sort-key":
      case "line-sort-key":
      case "circle-sort-key":
        out.sortKey = convertValue(value, undefined, key);
        continue;
      case "symbol-sort-key": {
        const v = convertValue(value, undefined, key);
        layoutOut.priority = typeof v === "number" ? -v : ["*", -1, v];
        origin.set("layout.priority", key);
        continue;
      }
      case "text-overlap":
        overlap = value;
        continue;
      case "icon-overlap":
        iconOverlap = value;
        continue;
      case "fill-pattern":
        if (!perFeature(value)) break;
        pattern = true;
        continue;
      case "line-pattern":
        pattern = true;
        continue;
      case "background-pattern":
      case "fill-extrusion-pattern":
        skipped.add(`${key} isn't drawn yet, the plain color is used`, id);
        continue;
      case "line-gradient":
        skipped.add("line-gradient isn't drawn yet, the line color is used", id);
        continue;
      case "icon-pitch-alignment":
        if (value === "map") skipped.add(`${key} map isn't supported yet, icons face the screen`, id);
        continue;
    }
    const target = table[key];
    if (!target) {
      if (!QUIET.has(key)) skipped.add(`${key} isn't supported yet`, id);
      continue;
    }
    const def = (target.group === "paint" ? PAINT : LAYOUT)[type][target.name];
    const converted = convertValue(value, def, key);
    if (converted === undefined) continue;
    (target.group === "paint" ? paintOut : layoutOut)[target.name] = converted;
    origin.set(`${target.group}.${target.name}`, key);
  }
  if (pattern) {
    skipped.add("line patterns and patterns that change per feature aren't drawn yet", id);
    return null;
  }
  if (overlap !== undefined) {
    layoutOut.allowOverlap = overlap === "always";
    origin.set("layout.allowOverlap", "text-overlap");
    if (overlap === "cooperative") skipped.add("text-overlap cooperative is treated as never", id);
  }
  if (iconOverlap !== undefined) {
    layoutOut.iconAllowOverlap = iconOverlap === "always";
    origin.set("layout.iconAllowOverlap", "icon-overlap");
    if (iconOverlap === "cooperative") skipped.add("icon-overlap cooperative is treated as never", id);
  }
  if (type === "symbol" && layoutOut.text !== undefined) {
    layoutOut.size ??= 16;
    layoutOut.font ??= serverFonts
      ? ["Open Sans Regular", "Arial Unicode MS Regular"]
      : ["Open Sans", "Arial Unicode MS", "sans-serif"];
  }
  if (type === "raster") paintOut.fadeDuration ??= 300;
  if (type === "circle") paintOut.pitchScale ??= "map";
  if (type === "heatmap") paintOut.color ??= deepClone(V8_HEAT);
  if (Object.keys(paintOut).length > 0) out.paint = paintOut;
  if (Object.keys(layoutOut).length > 0) out.layout = layoutOut;
  return { layer: out, origin };
}

function settle(
  layer: Json,
  origin: Map<string, string>,
  id: string,
  sources: Record<string, SourceSpec>,
  skipped: Skipped,
): LayerSpec | null {
  for (let attempt = 0; attempt < 64; attempt++) {
    const issues = validateLayer(layer, "layer", sources);
    if (issues.length === 0) return layer as unknown as LayerSpec;
    let removed = false;
    for (const issue of issues) {
      const m = /^layer\.(paint|layout)\.([^.[]+)/.exec(issue.path);
      const group = m ? (layer[m[1]!] as Json | undefined) : undefined;
      if (m && group && m[2]! in group) {
        delete group[m[2]!];
        skipped.add(`${origin.get(`${m[1]}.${m[2]}`) ?? m[2]} couldn't be used: ${issue.message}`, id);
        removed = true;
      } else if (issue.path === "layer.sortKey" && layer.sortKey !== undefined) {
        delete layer.sortKey;
        skipped.add(`sort key couldn't be used: ${issue.message}`, id);
        removed = true;
      }
    }
    if (!removed) {
      skipped.add(`layers that couldn't be read: ${issues[0]!.message}`, id);
      return null;
    }
  }
  return null;
}

export function convertFilter(filter: unknown): unknown {
  if (!Array.isArray(filter)) return filter;
  return isLegacyFilter(filter) ? legacy(filter) : filter;
}

function isLegacyFilter(f: unknown[]): boolean {
  const op = f[0];
  switch (op) {
    case "has":
      return f.length === 2 && (f[1] === "$id" || f[1] === "$type");
    case "!has":
    case "!in":
    case "none":
      return true;
    case "in":
      return f.length >= 3 && typeof f[1] === "string" && !Array.isArray(f[2]);
    case "all":
    case "any":
      return f.slice(1).some((c) => Array.isArray(c) && isLegacyFilter(c));
    default:
      if (typeof op === "string" && LEGACY_COMPARE.has(op)) {
        return f.length === 3 && typeof f[1] === "string" && !Array.isArray(f[1]) && !Array.isArray(f[2]);
      }
      return false;
  }
}

function legacy(f: unknown[]): unknown {
  const op = f[0] as string;
  switch (op) {
    case "all":
    case "any":
      return [op, ...f.slice(1).map((c) => (Array.isArray(c) && isLegacyFilter(c) ? legacy(c) : c))];
    case "none":
      return ["!", ["any", ...f.slice(1).map((c) => (Array.isArray(c) ? convertFilter(c) : c))]];
    case "has":
      return f[1] === "$type" ? true : f[1] === "$id" ? ["!=", ["id"], null] : ["has", f[1]];
    case "!has":
      return ["!", legacy(["has", f[1]])];
    case "in":
      return membership(f[1] as string, f.slice(2));
    case "!in":
      return ["!", membership(f[1] as string, f.slice(2))];
    default: {
      const getter = keyOf(f[1] as string);
      const value = f[2];
      if (op === "==" || op === "!=") return [op, getter, value];
      if (typeof value === "number") return ["all", ["==", ["typeof", getter], "number"], [op, getter, value]];
      if (typeof value === "string") return ["all", ["==", ["typeof", getter], "string"], [op, getter, value]];
      return false;
    }
  }
}

function membership(key: string, values: unknown[]): unknown {
  const getter = keyOf(key);
  const unique = [...new Set(values)];
  if (unique.length === 0) return false;
  if (unique.every((v) => typeof v === "string") || unique.every((v) => Number.isInteger(v))) {
    return ["match", getter, unique, true, false];
  }
  return ["any", ...unique.map((v) => ["==", getter, v])];
}

function keyOf(key: string): unknown {
  return key === "$type" ? ["geometry-type"] : key === "$id" ? ["id"] : ["get", key];
}

function convertValue(value: unknown, def: PropertyDef | undefined, key: string): unknown {
  const text = key === "text-field" || key === "icon-image";
  if (isFunction(value)) return functionValue(value, def, text, !STEPPED.has(key));
  if (text && typeof value === "string") return tokens(value);
  if (key === "text-field") return plainFormat(value);
  if (def && !def.expression && Array.isArray(value) && value[0] === "literal") return value[1];
  return value;
}

function perFeature(value: unknown): boolean {
  if (isFunction(value)) return typeof value.property === "string";
  if (!Array.isArray(value) || typeof value[0] !== "string") return false;
  try {
    return compile(value, "string", "", "pattern").featureDependent;
  } catch {
    return false;
  }
}

function isFunction(value: unknown): value is Json {
  return isObject(value) && (Array.isArray(value.stops) || value.type === "identity");
}

function functionValue(fn: Json, def: PropertyDef | undefined, text: boolean, smooth: boolean): unknown {
  const output = (v: unknown) => (text && typeof v === "string" ? tokens(v) : Array.isArray(v) ? ["literal", v] : v);
  const stops = (Array.isArray(fn.stops) ? fn.stops : []).filter(
    (s): s is [unknown, unknown] => Array.isArray(s) && s.length === 2,
  );
  const fallback = output(fn.default !== undefined ? fn.default : (def?.default ?? null));
  const numeric = stops.every(
    ([, v]) => typeof v === "number" || (Array.isArray(v) && v.every((n) => typeof n === "number")),
  );
  const interpolatable =
    smooth && (def ? def.kind === "number" || def.kind === "color" || (def.kind === "any" && numeric) : numeric);
  const base = numberOr(fn.base, 1);
  const curve = base === 1 ? ["linear"] : ["exponential", base];
  const op = fn.colorSpace === "lab" ? "interpolate-lab" : fn.colorSpace === "hcl" ? "interpolate-hcl" : "interpolate";
  const property = typeof fn.property === "string" ? fn.property : null;
  const input = property === null ? ["zoom"] : keyOf(property);
  const keyed = stops.length > 0 && isObject(stops[0]![0]);
  const type =
    typeof fn.type === "string"
      ? fn.type
      : property !== null && stops.some(([k]) => typeof k === "string" || typeof k === "boolean")
        ? "categorical"
        : interpolatable
          ? "exponential"
          : "interval";
  const build = (pairs: [unknown, unknown][], arg: unknown): unknown => {
    if (pairs.length === 0) return fallback;
    if (type === "categorical")
      return categorical(
        arg,
        pairs.map(([k, v]) => [k, output(v)]),
        fallback,
      );
    const sorted = ascending(pairs);
    const flat = sorted.flatMap(([k, v]) => [k, output(v)]);
    const body =
      type === "interval" || !interpolatable
        ? ["step", arg, output(sorted[0]![1]), ...flat.slice(2)]
        : [op, curve, arg, ...flat];
    return property === null || keyed ? body : ["case", ["==", ["typeof", arg], "number"], body, fallback];
  };
  if (type === "identity") return identity(input, def, fallback);
  if (!keyed) return build(stops as [unknown, unknown][], input);
  const byZoom = new Map<number, [unknown, unknown][]>();
  for (const [k, v] of stops) {
    const z = numberOr((k as Json).zoom, 0);
    const list = byZoom.get(z) ?? [];
    list.push([(k as Json).value, v]);
    byZoom.set(z, list);
  }
  const zooms = [...byZoom.keys()].sort((a, b) => a - b);
  const inner = (z: number) => build(byZoom.get(z)!, input);
  if (zooms.length === 1) return inner(zooms[0]!);
  if (interpolatable) return [op, curve, ["zoom"], ...zooms.flatMap((z) => [z, inner(z)])];
  return ["step", ["zoom"], inner(zooms[0]!), ...zooms.slice(1).flatMap((z) => [z, inner(z)])];
}

function ascending(pairs: [unknown, unknown][]): [number, unknown][] {
  const out: [number, unknown][] = [];
  for (const [k, v] of pairs) {
    if (typeof k !== "number") continue;
    if (out.length > 0 && k <= out[out.length - 1]![0]) continue;
    out.push([k, v]);
  }
  return out;
}

function categorical(input: unknown, pairs: [unknown, unknown][], fallback: unknown): unknown {
  const seen = new Set<unknown>();
  const unique: [unknown, unknown][] = [];
  for (const pair of pairs) {
    if (seen.has(pair[0])) continue;
    seen.add(pair[0]);
    unique.push(pair);
  }
  const keys = unique.map(([k]) => k);
  if (keys.every((k) => typeof k === "string") || keys.every((k) => Number.isInteger(k))) {
    return ["match", input, ...unique.flat(), fallback];
  }
  return ["case", ...unique.flatMap(([k, v]) => [["==", input, k], v]), fallback];
}

function identity(input: unknown, def: PropertyDef | undefined, fallback: unknown): unknown {
  switch (def?.kind) {
    case "color":
      return fallback === null ? ["to-color", input] : ["to-color", input, fallback];
    case "number":
      return ["coalesce", ["to-number", input, fallback ?? 0], fallback ?? 0];
    case "string":
      return ["to-string", input];
    case "boolean":
      return ["to-boolean", input];
    default:
      return input;
  }
}

const TOKEN = /\{([^{}]+)\}/g;

export function tokens(text: string): unknown {
  const parts: unknown[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(["to-string", ["get", m[1]]]);
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : ["concat", ...parts];
}

function plainFormat(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value[0] === "literal") return value;
  if (value[0] === "format") {
    const parts: unknown[] = [];
    for (const section of value.slice(1)) {
      if (isObject(section)) continue;
      if (Array.isArray(section) && section[0] === "image") continue;
      parts.push(plainFormat(section));
    }
    if (parts.length === 0) return "";
    return parts.length === 1 ? ["to-string", parts[0]] : ["concat", ...parts];
  }
  return value.map((v) => plainFormat(v));
}

function fontLeaves(value: unknown, leaf: (list: string[]) => unknown): unknown {
  const list = fontList(value);
  if (list) return leaf(list);
  if (!Array.isArray(value)) return value;
  if (value[0] === "match") {
    return value.map((v, i) => (i >= 2 && i < value.length - 1 && i % 2 === 0 ? v : i === 0 ? v : fontLeaves(v, leaf)));
  }
  return value.map((v, i) => (i === 0 ? v : fontLeaves(v, leaf)));
}

function fontList(value: unknown): string[] | null {
  const list = Array.isArray(value) && value[0] === "literal" && Array.isArray(value[1]) ? value[1] : value;
  if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === "string")) return null;
  return isOperator(list[0]) ? null : (list as string[]);
}

export function fontOf(value: unknown): { families: string[]; bold: boolean; italic: boolean } | null {
  const list = fontList(value);
  if (!list) return null;
  const font = fontFromNames(list);
  return { families: [...font.families], bold: font.bold, italic: font.italic };
}

function spriteOf(sprite: unknown, base: string | undefined): unknown {
  if (typeof sprite === "string") return sprite.startsWith("mapbox://") ? null : absolute(sprite, base);
  if (Array.isArray(sprite)) {
    const out = sprite
      .filter((s): s is Json => isObject(s) && typeof s.id === "string" && typeof s.url === "string")
      .filter((s) => !(s.url as string).startsWith("mapbox://"))
      .map((s) => ({ id: s.id, url: absolute(s.url as string, base) }));
    return out.length > 0 ? out : null;
  }
  return null;
}

function absolute(url: string, base: string | undefined): string {
  if (!base || /^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, base).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  } catch {
    return url;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
