import type { Expression, LayerSpec, StyleSpec } from "../style/types.ts";

export interface LightStyleOptions {
  url?: string;
  tiles?: string[];
  maxZoom?: number;
  attribution?: string;
  buildings?: boolean | "flat";
  labels?: boolean;
  font?: string[];
}

const DEFAULT_FONT = ["Inter", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"];

function labelLayers(font: string[] = DEFAULT_FONT): LayerSpec[] {
  const name: Expression = ["coalesce", ["get", "name"], ["get", "name_en"]];
  const halo = { haloColor: "rgba(255, 255, 255, 0.85)", haloWidth: 1.6 };
  return [
    {
      id: "water-name",
      type: "symbol",
      source: "osm",
      sourceLayer: "water_name",
      layout: {
        text: name,
        font,
        italic: true,
        size: linearZoom([
          [8, 11],
          [14, 15],
        ]),
        maxWidth: 8,
        priority: 50,
      },
      paint: { color: "#557790", haloColor: "rgba(255, 255, 255, 0.6)", haloWidth: 1.2 },
    },
    {
      id: "peak-label",
      type: "symbol",
      source: "osm",
      sourceLayer: "mountain_peak",
      minZoom: 10,
      filter: ["has", "name"],
      layout: { text: name, font, size: 11, maxWidth: 8, priority: 45 },
      paint: { color: "#76664f", ...halo },
    },
    {
      id: "poi-label",
      type: "symbol",
      source: "osm",
      sourceLayer: "poi",
      minZoom: 16,
      filter: ["has", "name"],
      layout: {
        text: ["get", "name"],
        font,
        size: 11.5,
        anchor: "top",
        offset: [0, 0.45],
        maxWidth: 8,
        padding: 6,
        priority: ["-", 20, ["coalesce", ["get", "rank"], 15]],
      },
      paint: { color: "#675f54", ...halo },
    },
    {
      id: "road-label",
      type: "symbol",
      source: "osm",
      sourceLayer: "road",
      minZoom: 13,
      filter: ["all", ["has", "name"], ["!", ["in", ["get", "class"], ["literal", ["path", "track"]]]]],
      layout: {
        text: ["get", "name"],
        font,
        placement: "line",
        spacing: 320,
        size: linearZoom([
          [13, 10.5],
          [17, 14],
        ]),
        priority: [
          "match",
          ["get", "class"],
          "motorway",
          40,
          "trunk",
          38,
          "primary",
          36,
          "secondary",
          34,
          "tertiary",
          32,
          "minor",
          30,
          28,
        ],
      },
      paint: { color: "#57534d", ...halo },
    },
    {
      id: "place-neighbourhood",
      type: "symbol",
      source: "osm",
      sourceLayer: "place",
      minZoom: 12,
      filter: ["in", ["get", "class"], ["literal", ["suburb", "quarter", "neighbourhood"]]],
      layout: {
        text: name,
        font,
        transform: "uppercase",
        letterSpacing: 0.08,
        size: ["match", ["get", "class"], "suburb", 12, 11],
        maxWidth: 7,
        priority: ["-", 80, ["get", "rank"]],
      },
      paint: { color: "#7a7570", ...halo },
    },
    {
      id: "place-village",
      type: "symbol",
      source: "osm",
      sourceLayer: "place",
      minZoom: 10,
      filter: [
        "in",
        ["get", "class"],
        ["literal", ["village", "hamlet", "locality", "island", "islet", "isolated_dwelling"]],
      ],
      layout: {
        text: name,
        font,
        size: ["match", ["get", "class"], "village", 13, "island", 13, 11.5],
        maxWidth: 8,
        priority: ["-", 90, ["get", "rank"]],
      },
      paint: { color: "#3f4447", ...halo },
    },
    {
      id: "place-town",
      type: "symbol",
      source: "osm",
      sourceLayer: "place",
      filter: ["==", ["get", "class"], "town"],
      layout: {
        text: name,
        font,
        size: linearZoom([
          [8, 12],
          [14, 17],
        ]),
        maxWidth: 8,
        priority: ["-", 100, ["get", "rank"]],
      },
      paint: { color: "#2f3437", ...halo },
    },
    {
      id: "place-city",
      type: "symbol",
      source: "osm",
      sourceLayer: "place",
      filter: ["==", ["get", "class"], "city"],
      layout: {
        text: name,
        font,
        weight: "bold",
        size: linearZoom([
          [5, 13],
          [12, 20],
        ]),
        maxWidth: 8,
        priority: ["-", 120, ["get", "rank"]],
      },
      paint: { color: "#24292c", ...halo },
    },
  ];
}

const zoomScale = (stops: [number, number][], base = 1.5): Expression => [
  "interpolate",
  ["exponential", base],
  ["zoom"],
  ...stops.flat(),
];

const linearZoom = (stops: [number, number][]): Expression => ["interpolate", ["linear"], ["zoom"], ...stops.flat()];

const ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"] as const;
type RoadClass = (typeof ROAD_CLASSES)[number];

const ROAD_WIDTH: Record<RoadClass, [number, number][]> = {
  motorway: [
    [5, 0.6],
    [10, 2],
    [14, 5],
    [18, 20],
  ],
  trunk: [
    [5, 0.5],
    [10, 1.8],
    [14, 4.5],
    [18, 18],
  ],
  primary: [
    [7, 0.5],
    [10, 1.4],
    [14, 4.5],
    [18, 18],
  ],
  secondary: [
    [9, 0.5],
    [12, 1.4],
    [14, 4],
    [18, 16],
  ],
  tertiary: [
    [10, 0.4],
    [12, 1.1],
    [14, 3.4],
    [18, 14],
  ],
  minor: [
    [12, 0.4],
    [14, 2.4],
    [18, 12],
  ],
  service: [
    [13, 0.3],
    [15, 1.4],
    [18, 6],
  ],
};

const ROAD_FILL: Record<RoadClass, string> = {
  motorway: "#f6cf8c",
  trunk: "#f9dfa9",
  primary: "#fef3d6",
  secondary: "#ffffff",
  tertiary: "#ffffff",
  minor: "#ffffff",
  service: "#ffffff",
};

const ROAD_CASING: Record<RoadClass, string> = {
  motorway: "#d39a4f",
  trunk: "#d9ad6f",
  primary: "#d8c7a4",
  secondary: "#d3cbbd",
  tertiary: "#d6cfc3",
  minor: "#d8d2c8",
  service: "#ddd8cf",
};

const ROAD_MIN: Record<RoadClass, number> = {
  motorway: 4,
  trunk: 5,
  primary: 7,
  secondary: 9,
  tertiary: 10,
  minor: 12,
  service: 13,
};

function roadLayers(brunnel: "tunnel" | "road" | "bridge"): LayerSpec[] {
  const out: LayerSpec[] = [];
  const brunnelFilter: Expression =
    brunnel === "road"
      ? ["!", ["in", ["get", "brunnel"], ["literal", ["bridge", "tunnel"]]]]
      : ["==", ["get", "brunnel"], brunnel];
  const order = [...ROAD_CLASSES].reverse();
  for (const part of ["casing", "fill"] as const) {
    for (const cls of order) {
      const widths = ROAD_WIDTH[cls];
      const filter: Expression = ["all", ["==", ["get", "class"], cls], brunnelFilter];
      if (part === "casing") {
        out.push({
          id: `road-${brunnel}-${cls}-casing`,
          type: "line",
          source: "osm",
          sourceLayer: "road",
          minZoom: Math.max(ROAD_MIN[cls], cls === "motorway" || cls === "trunk" ? 8 : ROAD_MIN[cls] + 1),
          filter,
          layout: { cap: "butt", join: "round" },
          paint: {
            color: brunnel === "tunnel" ? "#d9d6d0" : ROAD_CASING[cls],
            width: zoomScale(widths.map(([z, w]) => [z, w * 1.35 + 1] as [number, number])),
            opacity: brunnel === "tunnel" ? 0.7 : 1,
            ...(brunnel === "tunnel" ? { dash: [0.4, 0.3] } : {}),
          },
        });
      } else {
        out.push({
          id: `road-${brunnel}-${cls}`,
          type: "line",
          source: "osm",
          sourceLayer: "road",
          minZoom: ROAD_MIN[cls],
          filter,
          layout: { cap: "round", join: "round" },
          paint: {
            color: brunnel === "tunnel" ? "#f4f2ee" : ROAD_FILL[cls],
            width: zoomScale(widths),
          },
        });
      }
    }
  }
  return out;
}

export function lightStyle(options: LightStyleOptions = {}): StyleSpec {
  const source: StyleSpec["sources"][string] = options.tiles
    ? { type: "vector", tiles: options.tiles, maxZoom: options.maxZoom ?? 14 }
    : { type: "vector", url: options.url ?? "tiles.pmtiles" };
  if (options.attribution !== undefined) (source as { attribution?: string }).attribution = options.attribution;
  const layers: LayerSpec[] = [
    { id: "background", type: "background", paint: { color: "#f3f2ed" } },
    {
      id: "landcover",
      type: "fill",
      source: "osm",
      sourceLayer: "landcover",
      paint: {
        color: [
          "match",
          ["get", "class"],
          "wood",
          "#d5e4cb",
          "grass",
          "#e1ebd3",
          "scrub",
          "#dbe6cf",
          "wetland",
          "#d6e5dc",
          "sand",
          "#f0e7cc",
          "rock",
          "#e3e1da",
          "ice",
          "#f5f9fb",
          "farmland",
          "#ecebd6",
          "#e4e8da",
        ],
        opacity: linearZoom([
          [5, 0.6],
          [10, 1],
        ]),
      },
    },
    {
      id: "landuse",
      type: "fill",
      source: "osm",
      sourceLayer: "landuse",
      paint: {
        color: [
          "match",
          ["get", "class"],
          "residential",
          "#ecebe4",
          "commercial",
          "#f1e9e4",
          "retail",
          "#f2e7e2",
          "industrial",
          "#eae7ec",
          "railway",
          "#e9e6e8",
          "cemetery",
          "#dbe5d3",
          "military",
          "#efe2de",
          "quarry",
          "#e5e2dc",
          "construction",
          "#ebe8e0",
          "park",
          "#d3e6c5",
          "pitch",
          "#cfe5c6",
          "golf",
          "#d5e9c9",
          "school",
          "#f1eadb",
          "hospital",
          "#f3e2e2",
          "parking",
          "#eaeae6",
          "airport",
          "#e7e7eb",
          "pier",
          "#ecebe6",
          "pedestrian",
          "#efeee9",
          "religious",
          "#ebe8e1",
          "#ecebe5",
        ],
        opacity: linearZoom([
          [6, 0.5],
          [11, 1],
        ]),
      },
    },
    {
      id: "park",
      type: "fill",
      source: "osm",
      sourceLayer: "park",
      paint: { color: "#cfe3bf", opacity: 0.55 },
    },
    {
      id: "water",
      type: "fill",
      source: "osm",
      sourceLayer: "water",
      paint: { color: "#a9c8da" },
    },
    {
      id: "waterway",
      type: "line",
      source: "osm",
      sourceLayer: "waterway",
      layout: { cap: "round", join: "round" },
      paint: {
        color: "#a9c8da",
        width: [
          "interpolate",
          ["exponential", 1.4],
          ["zoom"],
          8,
          ["match", ["get", "class"], "river", 0.8, 0.2],
          14,
          ["match", ["get", "class"], "river", 3, "canal", 2.5, 1],
          18,
          ["match", ["get", "class"], "river", 12, "canal", 8, 3],
        ],
      },
    },
    {
      id: "aeroway-area",
      type: "fill",
      source: "osm",
      sourceLayer: "aeroway",
      minZoom: 12,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { color: "#e2e2e8" },
    },
    {
      id: "aeroway-runway",
      type: "line",
      source: "osm",
      sourceLayer: "aeroway",
      minZoom: 10,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: {
        color: "#d8d8df",
        width: zoomScale([
          [10, 1],
          [14, 14],
          [18, 80],
        ]),
      },
    },
  ];
  const extruded = options.buildings !== false && options.buildings !== "flat";
  if (options.buildings === "flat") {
    layers.push({
      id: "building",
      type: "fill",
      source: "osm",
      sourceLayer: "building",
      minZoom: 12,
      paint: {
        color: "#e0ddd5",
        outlineColor: "#d0ccc2",
        opacity: linearZoom([
          [12, 0],
          [13, 1],
        ]),
      },
    });
  }
  layers.push(...roadLayers("tunnel"));
  layers.push(
    {
      id: "path",
      type: "line",
      source: "osm",
      sourceLayer: "road",
      minZoom: 15,
      filter: ["in", ["get", "class"], ["literal", ["path", "track"]]],
      layout: { cap: "butt", join: "round" },
      paint: {
        color: ["match", ["get", "class"], "track", "#c6b296", "#c2b4a5"],
        width: zoomScale([
          [13, 0.6],
          [16, 1.4],
          [18, 3],
        ]),
        opacity: 0.7,
        dash: [2, 1.4],
      },
    },
    {
      id: "railway",
      type: "line",
      source: "osm",
      sourceLayer: "railway",
      minZoom: 9,
      filter: ["!", ["has", "service"]],
      paint: {
        color: "#b6b2ac",
        width: zoomScale([
          [9, 0.6],
          [14, 1.6],
          [18, 3.5],
        ]),
      },
    },
  );
  layers.push(...roadLayers("road"));
  layers.push(...roadLayers("bridge"));
  layers.push(
    {
      id: "boundary-state",
      type: "line",
      source: "osm",
      sourceLayer: "boundary",
      filter: ["all", ["<=", ["get", "admin_level"], 4], [">", ["get", "admin_level"], 2], ["!", ["has", "maritime"]]],
      paint: {
        color: "#a597ad",
        width: linearZoom([
          [3, 0.6],
          [10, 1.4],
        ]),
        dash: [3, 2],
      },
    },
    {
      id: "boundary-country",
      type: "line",
      source: "osm",
      sourceLayer: "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!", ["has", "maritime"]]],
      paint: {
        color: "#8f8199",
        width: linearZoom([
          [0, 0.6],
          [10, 2],
        ]),
      },
    },
    {
      id: "boundary-county",
      type: "line",
      source: "osm",
      sourceLayer: "boundary",
      minZoom: 8,
      filter: ["all", ["==", ["get", "admin_level"], 6], ["!", ["has", "maritime"]]],
      paint: { color: "#bcb2c2", width: 1, dash: [2, 2] },
    },
    {
      id: "poi-dot",
      type: "circle",
      source: "osm",
      sourceLayer: "poi",
      minZoom: 15,
      filter: ["has", "name"],
      paint: {
        radius: zoomScale([
          [14, 2],
          [18, 4],
        ]),
        color: [
          "match",
          ["get", "class"],
          "amenity",
          "#c07d5d",
          "shop",
          "#9a7bb0",
          "tourism",
          "#4f8fa8",
          "leisure",
          "#5f9a5f",
          "#8f8f8f",
        ],
        strokeColor: "#ffffff",
        strokeWidth: 1,
      },
    },
  );
  if (extruded) {
    layers.push({
      id: "building-3d",
      type: "extrusion",
      source: "osm",
      sourceLayer: "building",
      minZoom: 12,
      paint: {
        color: "#e3dfd7",
        height: ["coalesce", ["get", "height"], 6],
        base: ["coalesce", ["get", "min_height"], 0],
      },
    });
  }
  if (options.labels !== false) layers.push(...labelLayers(options.font));
  return {
    version: 1,
    name: "Maplet Light",
    sources: { osm: source },
    layers,
  };
}
