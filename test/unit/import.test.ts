import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../../src/style/expression.ts";
import { convertFilter, fontOf, importStyle, tokens } from "../../src/style/import.ts";
import { validateStyle } from "../../src/style/validate.ts";

const vector = { type: "vector", url: "https://example.com/tiles.json" };

function one(layer: Record<string, unknown>, sources: Record<string, unknown> = { v: vector }) {
  const { style, skipped } = importStyle({ version: 8, sources, layers: [layer] });
  assert.deepEqual(validateStyle(style), []);
  return { layer: style.layers[0] as unknown as Record<string, unknown> | undefined, skipped, style };
}

function matches(filter: unknown, properties: Record<string, unknown>, geometryType = "Polygon", id?: number): boolean {
  const c = compile(convertFilter(filter), "boolean", false, "filter", { geometry: true });
  return c.evaluate({ zoom: 10, feature: { properties, id, geometryType: geometryType as "Polygon" } }) === true;
}

test("properties get their names in every kind of layer", () => {
  const { layer } = one({
    id: "roads",
    type: "line",
    source: "v",
    "source-layer": "transportation",
    minzoom: 4,
    maxzoom: 18,
    layout: { "line-cap": "round", "line-join": "round", visibility: "none", "line-sort-key": ["get", "rank"] },
    paint: {
      "line-color": "#f00",
      "line-width": 2,
      "line-gap-width": 1,
      "line-dasharray": [2, 1],
      "line-color-transition": { duration: 500 },
    },
  });
  assert.deepEqual(layer, {
    id: "roads",
    type: "line",
    source: "v",
    sourceLayer: "transportation",
    minZoom: 4,
    maxZoom: 18,
    visible: false,
    sortKey: ["get", "rank"],
    paint: { color: "#f00", width: 2, gapWidth: 1, dash: [2, 1], colorTransition: { duration: 500 } },
    layout: { cap: "round", join: "round" },
  });
  const extrusion = one({
    id: "b",
    type: "fill-extrusion",
    source: "v",
    "source-layer": "building",
    paint: { "fill-extrusion-height": ["get", "h"], "fill-extrusion-color": "#ccc" },
  }).layer;
  assert.equal(extrusion?.type, "extrusion");
  assert.deepEqual(extrusion?.paint, { height: ["get", "h"], color: "#ccc" });
});

test("symbols keep v8 defaults, fonts, sort keys and overlap", () => {
  const { layer } = one({
    id: "labels",
    type: "symbol",
    source: "v",
    "source-layer": "place",
    layout: {
      "text-field": "{name}\n{name:en}",
      "text-font": ["Open Sans Semibold Italic", "Arial Unicode MS Regular"],
      "symbol-sort-key": ["get", "rank"],
      "text-overlap": "always",
      "symbol-placement": ["step", ["zoom"], "point", 11, "line"],
    },
    paint: { "text-color": "#333", "text-halo-width": 1 },
  });
  assert.deepEqual(layer?.layout, {
    text: ["concat", ["to-string", ["get", "name"]], "\n", ["to-string", ["get", "name:en"]]],
    font: ["Open Sans", "Arial Unicode MS", "sans-serif"],
    weight: "bold",
    italic: true,
    priority: ["*", -1, ["get", "rank"]],
    placement: ["step", ["zoom"], "point", 11, "line"],
    allowOverlap: true,
    size: 16,
  });
  assert.deepEqual(fontOf(["Noto Sans Regular"]), {
    families: ["Noto Sans", "sans-serif"],
    bold: false,
    italic: false,
  });
  assert.deepEqual(tokens("{ref}"), ["to-string", ["get", "ref"]]);
  assert.deepEqual(tokens("plain"), "plain");
  assert.deepEqual(tokens("road_{len}"), ["concat", "road_", ["to-string", ["get", "len"]]]);
});

test("old style filters turn into expressions that pick the same features", () => {
  const filters: [unknown, Record<string, unknown>, string, boolean][] = [
    [["==", "class", "park"], { class: "park" }, "Polygon", true],
    [["==", "class", "park"], { class: "wood" }, "Polygon", false],
    [["!=", "class", "park"], {}, "Polygon", true],
    [["==", "$type", "LineString"], {}, "LineString", true],
    [["in", "class", "a", "b"], { class: "b" }, "Polygon", true],
    [["!in", "class", "a", "b"], { class: "c" }, "Polygon", true],
    [["in", "admin_level", 2, "2"], { admin_level: "2" }, "Polygon", true],
    [["in", "$type", "Point", "Polygon"], {}, "LineString", false],
    [["has", "name"], { name: "x" }, "Polygon", true],
    [["!has", "name"], { name: "x" }, "Polygon", false],
    [["<", "rank", 5], { rank: 3 }, "Polygon", true],
    [["<", "rank", 5], { rank: "3" }, "Polygon", false],
    [[">=", "rank", 5], {}, "Polygon", false],
    [["all", ["==", "class", "park"], [">", "area", 10]], { class: "park", area: 20 }, "Polygon", true],
    [["any", ["==", "class", "park"], ["==", "class", "wood"]], { class: "wood" }, "Polygon", true],
    [["none", ["==", "class", "park"], ["==", "class", "wood"]], { class: "wood" }, "Polygon", false],
    [["all", ["==", ["get", "class"], "park"], ["has", "name"]], { class: "park", name: "x" }, "Polygon", true],
  ];
  for (const [filter, properties, type, expected] of filters) {
    assert.equal(matches(filter, properties, type), expected, JSON.stringify(filter));
  }
  assert.equal(matches(["has", "$id"], {}, "Polygon", 7), true);
  assert.equal(matches(["==", "$id", 7], {}, "Polygon", 7), true);
  const modern = ["==", ["get", "class"], "park"];
  assert.equal(convertFilter(modern), modern);
});

test("old style functions turn into the matching expressions", () => {
  const { layer } = one({
    id: "f",
    type: "fill",
    source: "v",
    "source-layer": "x",
    paint: {
      "fill-opacity": {
        base: 1.5,
        stops: [
          [5, 0.2],
          [10, 0.8],
        ],
      },
      "fill-color": {
        property: "kind",
        type: "categorical",
        stops: [
          ["park", "#0f0"],
          ["water", "#00f"],
        ],
        default: "#888",
      },
      "fill-outline-color": {
        property: "level",
        stops: [
          [0, "#000"],
          [10, "#fff"],
        ],
      },
    },
  });
  const paint = layer?.paint as Record<string, unknown>;
  assert.deepEqual(paint.opacity, ["interpolate", ["exponential", 1.5], ["zoom"], 5, 0.2, 10, 0.8]);
  assert.deepEqual(paint.color, ["match", ["get", "kind"], "park", "#0f0", "water", "#00f", "#888"]);
  const outline = compile(paint.outlineColor, "color", null, "o");
  const at = (level: unknown) =>
    outline.evaluate({ zoom: 0, feature: { properties: { level }, id: undefined, geometryType: "Polygon" } });
  assert.deepEqual(at(5), [0.5, 0.5, 0.5, 1]);
  assert.equal(at("high"), null);
  const symbol = one({
    id: "s",
    type: "symbol",
    source: "v",
    "source-layer": "x",
    layout: {
      "text-field": "{name}",
      "text-size": {
        property: "value",
        stops: [
          [{ zoom: 10, value: 0 }, 10],
          [{ zoom: 10, value: 10 }, 20],
          [{ zoom: 15, value: 0 }, 14],
          [{ zoom: 15, value: 10 }, 28],
        ],
      },
      "text-transform": {
        stops: [
          [8, "none"],
          [12, "uppercase"],
        ],
      },
    },
  }).layer;
  const layout = symbol?.layout as Record<string, unknown>;
  assert.deepEqual(layout.transform, ["step", ["zoom"], "none", 12, "uppercase"]);
  const size = compile(layout.size, "number", 16, "size");
  const sizeAt = (zoom: number, value: number) =>
    size.evaluate({ zoom, feature: { properties: { value }, id: undefined, geometryType: "Point" } });
  assert.equal(sizeAt(10, 5), 15);
  assert.equal(sizeAt(15, 10), 28);
  assert.equal(sizeAt(12.5, 0), 12);
});

test("sources keep v8 defaults and addresses stay usable", () => {
  const { style, skipped } = importStyle(
    {
      version: 8,
      sprite: "sprites/basic",
      sources: {
        v: { type: "vector", tiles: ["tiles/{z}/{x}/{y}.pbf"], attribution: "Me" },
        r: { type: "raster", tiles: ["https://example.com/{z}/{x}/{y}.png"] },
        d: { type: "raster-dem", url: "https://example.com/dem.json" },
        t: { type: "raster-dem", url: "https://example.com/t.json", encoding: "terrarium", tileSize: 256 },
        c: {
          type: "raster-dem",
          url: "https://example.com/c.json",
          encoding: "custom",
          redFactor: 0.1,
          greenFactor: 0.2,
          blueFactor: 0.3,
          baseShift: -5,
        },
        g: { type: "geojson", data: "data/places.geojson", cluster: true, maxzoom: 16 },
        m: { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" },
        w: { type: "weird" },
      },
      layers: [],
      terrain: { source: "d", exaggeration: 1.5 },
    },
    "https://maps.example.com/styles/basic/style.json",
  );
  assert.equal(style.sprite, "https://maps.example.com/styles/basic/sprites/basic");
  assert.deepEqual(style.sources.v, {
    type: "vector",
    tiles: ["https://maps.example.com/styles/basic/tiles/{z}/{x}/{y}.pbf"],
    maxZoom: 22,
    attribution: "Me",
  });
  assert.equal((style.sources.r as { tileSize?: number }).tileSize, 512);
  assert.equal((style.sources.d as { encoding?: unknown }).encoding, "mapbox");
  assert.equal((style.sources.t as { encoding?: unknown; tileSize?: number }).encoding, "terrarium");
  assert.deepEqual((style.sources.c as { encoding?: unknown }).encoding, {
    red: 0.1,
    green: 0.2,
    blue: 0.3,
    offset: -5,
  });
  assert.deepEqual(style.sources.g, {
    type: "geojson",
    data: "https://maps.example.com/styles/basic/data/places.geojson",
    maxZoom: 16,
    cluster: true,
  });
  assert.deepEqual(style.terrain, { source: "d", exaggeration: 1.5 });
  assert.equal(style.sources.m, undefined);
  assert.equal(style.sources.w, undefined);
  assert.ok(skipped.some((s) => s.includes("mapbox://")));
  assert.ok(skipped.some((s) => s.includes("weird")));
});

test("what can't be drawn is left out and listed, never the whole style", () => {
  const { style, skipped } = importStyle({
    version: 8,
    sources: { v: vector },
    fog: { color: "white" },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#fff", "background-pattern": "dots" } },
      { id: "wet", type: "fill", source: "v", "source-layer": "x", paint: { "fill-pattern": "marsh" } },
      { id: "mixed", type: "fill", source: "v", "source-layer": "x", paint: { "fill-pattern": ["get", "kind"] } },
      { id: "rails", type: "line", source: "v", "source-layer": "x", paint: { "line-pattern": "rail" } },
      { id: "odd", type: "fill", source: "v", "source-layer": "x", paint: { "fill-color": ["frobnicate", 1] } },
      { id: "bad", type: "fill", source: "v", "source-layer": "x", filter: ["frobnicate"], paint: {} },
      { id: "sky", type: "sky" },
      { id: "lost", type: "fill", source: "missing", "source-layer": "x" },
      {
        id: "fit",
        type: "symbol",
        source: "v",
        "source-layer": "x",
        layout: { "icon-text-fit": "both", "icon-image": "a" },
      },
    ],
  });
  assert.deepEqual(
    style.layers.map((l) => l.id),
    ["bg", "wet", "odd", "fit"],
  );
  assert.deepEqual(style.layers[0]!.paint, { color: "#fff" });
  assert.deepEqual(style.layers[1]!.paint, { pattern: "marsh" });
  assert.equal((style.layers[2]!.paint as Record<string, unknown> | undefined)?.color, undefined);
  for (const words of [
    "fog",
    "background-pattern",
    "line patterns and patterns that change per feature",
    "mixed",
    "rails",
    "fill-color",
    "frobnicate",
    "sky layers",
    "icon-text-fit",
  ]) {
    assert.ok(
      skipped.some((s) => s.includes(words)),
      `expected a note about ${words} in ${JSON.stringify(skipped)}`,
    );
  }
  assert.throws(() => importStyle({ version: 1, sources: {}, layers: [] }), /version 8/);
});

test("dash patterns step between zooms instead of blending", () => {
  const { layer } = one({
    id: "border",
    type: "line",
    source: "v",
    "source-layer": "boundary",
    paint: {
      "line-dasharray": {
        stops: [
          [6, [1, 0]],
          [7, [2, 2]],
        ],
      },
      "line-width": {
        stops: [
          [4, 0.5],
          [7, 1],
        ],
      },
    },
  });
  assert.deepEqual(layer?.paint, {
    dash: ["step", ["zoom"], ["literal", [1, 0]], 7, ["literal", [2, 2]]],
    width: ["interpolate", ["linear"], ["zoom"], 4, 0.5, 7, 1],
  });
});

test("fonts can change with the zoom or the feature, like other properties", () => {
  const stepped = one({
    id: "poi",
    type: "symbol",
    source: "v",
    "source-layer": "poi",
    layout: {
      "text-field": "{name}",
      "text-font": {
        stops: [
          [16.5, ["Arial Bold", "Arial Unicode MS Bold"]],
          [16.6, ["Arial Regular"]],
        ],
      },
    },
  }).layer?.layout as Record<string, unknown>;
  assert.deepEqual(stepped.font, [
    "step",
    ["zoom"],
    ["literal", ["Arial", "Arial Unicode MS", "sans-serif"]],
    16.6,
    ["literal", ["Arial", "sans-serif"]],
  ]);
  assert.deepEqual(stepped.weight, ["step", ["zoom"], "bold", 16.6, "normal"]);
  assert.deepEqual(stepped.italic, ["step", ["zoom"], false, 16.6, false]);
  const matched = one({
    id: "places",
    type: "symbol",
    source: "v",
    "source-layer": "place",
    layout: {
      "text-field": ["get", "name"],
      "text-font": [
        "match",
        ["get", "class"],
        ["city", "town"],
        ["literal", ["Noto Sans Bold"]],
        ["literal", ["Noto Sans Italic"]],
      ],
    },
  }).layer?.layout as Record<string, unknown>;
  assert.deepEqual(matched.weight, ["match", ["get", "class"], ["city", "town"], "bold", "normal"]);
  assert.deepEqual(matched.italic, ["match", ["get", "class"], ["city", "town"], false, true]);
  assert.deepEqual(matched.font, [
    "match",
    ["get", "class"],
    ["city", "town"],
    ["literal", ["Noto Sans", "sans-serif"]],
    ["literal", ["Noto Sans", "sans-serif"]],
  ]);
});

test("layers that borrow from another layer with ref get its type, source, filter and layout", () => {
  const { style } = importStyle({
    version: 8,
    sources: { v: vector },
    layers: [
      {
        id: "railway",
        type: "line",
        source: "v",
        "source-layer": "transportation",
        filter: ["==", "class", "rail"],
        layout: { "line-cap": "round" },
        paint: { "line-color": "#999" },
      },
      { id: "railway-dash", ref: "railway", paint: { "line-color": "#fff", "line-dasharray": [3, 3] } },
      { id: "orphan", ref: "nowhere", paint: {} },
    ],
  });
  assert.deepEqual(style.layers[1], {
    id: "railway-dash",
    type: "line",
    source: "v",
    sourceLayer: "transportation",
    filter: ["==", ["get", "class"], "rail"],
    paint: { color: "#fff", dash: [3, 3] },
    layout: { cap: "round" },
  });
  assert.equal(style.layers.length, 2);
});
