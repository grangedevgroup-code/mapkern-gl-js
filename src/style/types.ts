import type { FeatureFormat } from "../formats/feature-format.ts";
import type { GeoJSON } from "../geo/geojson.ts";

export type Expression = readonly [string, ...unknown[]];
export type Value<T> = T | Expression;

export type Color = string;

export interface TileSourceBase {
  tiles?: string[];
  url?: string;
  minZoom?: number;
  maxZoom?: number;
  bounds?: [number, number, number, number];
  scheme?: "xyz" | "tms";
  attribution?: string;
}

export interface RasterSourceSpec extends TileSourceBase {
  type: "raster";
  tileSize?: number;
}

export interface VectorSourceSpec extends TileSourceBase {
  type: "vector";
  promoteId?: string | Record<string, string>;
}

export type DemEncoding = "terrarium" | "mapbox" | { red: number; green: number; blue: number; offset: number };

export interface DemSourceSpec extends TileSourceBase {
  type: "dem";
  tileSize?: number;
  encoding?: DemEncoding;
}

export type GeoJSONData = GeoJSON | string | Blob;

export interface GeoJSONSourceSpec {
  type: "geojson";
  data: GeoJSONData;
  format?: FeatureFormat;
  maxZoom?: number;
  tolerance?: number;
  buffer?: number;
  attribution?: string;
  promoteId?: string;
  generateId?: boolean;
  cluster?: boolean;
  clusterRadius?: number;
  clusterMaxZoom?: number;
  clusterMinPoints?: number;
  clusterProperties?: Record<string, unknown>;
}

export interface ImageSourceSpec {
  type: "image";
  url: string;
  coordinates: [number, number][];
  attribution?: string;
}

export interface VideoSourceSpec {
  type: "video";
  urls: string[];
  coordinates: [number, number][];
  attribution?: string;
}

export interface CanvasSourceSpec {
  type: "canvas";
  canvas: string | HTMLCanvasElement;
  coordinates: [number, number][];
  animate?: boolean;
  attribution?: string;
}

export type SourceSpec =
  | RasterSourceSpec
  | VectorSourceSpec
  | DemSourceSpec
  | GeoJSONSourceSpec
  | ImageSourceSpec
  | VideoSourceSpec
  | CanvasSourceSpec;

interface LayerBase {
  id: string;
  minZoom?: number;
  maxZoom?: number;
  visible?: boolean;
}

interface SourceLayerBase extends LayerBase {
  source: string;
  sourceLayer?: string;
  filter?: Expression;
}

export interface BackgroundLayerSpec extends LayerBase {
  type: "background";
  paint?: { color?: Value<Color>; opacity?: Value<number> };
}

export interface RasterLayerSpec extends LayerBase {
  type: "raster";
  source: string;
  paint?: {
    opacity?: Value<number>;
    brightnessMin?: Value<number>;
    brightnessMax?: Value<number>;
    contrast?: Value<number>;
    saturation?: Value<number>;
    hueRotate?: Value<number>;
    fadeDuration?: number;
    resampling?: "linear" | "nearest";
  };
}

export interface FillLayerSpec extends SourceLayerBase {
  type: "fill";
  paint?: {
    color?: Value<Color>;
    opacity?: Value<number>;
    outlineColor?: Value<Color>;
    translate?: [number, number];
    translateAnchor?: "map" | "viewport";
    antialias?: boolean;
  };
  sortKey?: Value<number>;
}

export interface LineLayerSpec extends SourceLayerBase {
  type: "line";
  paint?: {
    offset?: Value<number>;
    gapWidth?: Value<number>;
    color?: Value<Color>;
    width?: Value<number>;
    opacity?: Value<number>;
    blur?: Value<number>;
    dash?: number[];
  };
  layout?: {
    cap?: "butt" | "round" | "square";
    join?: "miter" | "round" | "bevel";
    miterLimit?: number;
  };
  sortKey?: Value<number>;
}

export interface CircleLayerSpec extends SourceLayerBase {
  type: "circle";
  paint?: {
    radius?: Value<number>;
    color?: Value<Color>;
    opacity?: Value<number>;
    strokeColor?: Value<Color>;
    strokeWidth?: Value<number>;
    strokeOpacity?: Value<number>;
    blur?: Value<number>;
    translate?: [number, number];
    translateAnchor?: "map" | "viewport";
    pitchScale?: "map" | "viewport";
    pitchAlignment?: "map" | "viewport";
  };
  sortKey?: Value<number>;
}

export type SymbolAnchor =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface SymbolLayerSpec extends SourceLayerBase {
  type: "symbol";
  layout?: {
    text?: Value<string>;
    font?: string[];
    size?: Value<number>;
    weight?: "normal" | "bold";
    italic?: boolean;
    placement?: "point" | "line" | "line-center";
    anchor?: SymbolAnchor;
    variableAnchor?: SymbolAnchor[];
    radialOffset?: number;
    justify?: "auto" | "left" | "center" | "right";
    lineHeight?: number;
    rotate?: Value<number>;
    ignorePlacement?: boolean;
    iconIgnorePlacement?: boolean;
    maxAngle?: number;
    keepUpright?: boolean;
    offset?: [number, number];
    maxWidth?: number;
    letterSpacing?: number;
    padding?: number;
    spacing?: number;
    allowOverlap?: boolean;
    transform?: "none" | "uppercase" | "lowercase";
    priority?: Value<number>;
    optional?: boolean;
    icon?: Value<string>;
    iconSize?: Value<number>;
    iconRotate?: Value<number>;
    iconAnchor?: SymbolAnchor;
    iconOffset?: [number, number];
    iconPadding?: number;
    iconAllowOverlap?: boolean;
    iconOptional?: boolean;
    iconRotationAlignment?: "auto" | "map" | "viewport";
  };
  paint?: {
    color?: Value<Color>;
    haloColor?: Value<Color>;
    haloWidth?: Value<number>;
    haloBlur?: Value<number>;
    opacity?: Value<number>;
    translate?: [number, number];
    translateAnchor?: "map" | "viewport";
    iconTranslate?: [number, number];
    iconTranslateAnchor?: "map" | "viewport";
    iconColor?: Value<Color>;
    iconHaloColor?: Value<Color>;
    iconHaloWidth?: Value<number>;
    iconOpacity?: Value<number>;
  };
}

export interface HeatmapLayerSpec extends SourceLayerBase {
  type: "heatmap";
  paint?: {
    radius?: Value<number>;
    weight?: Value<number>;
    intensity?: Value<number>;
    color?: Value<Color>;
    opacity?: Value<number>;
  };
}

export interface ExtrusionLayerSpec extends SourceLayerBase {
  type: "extrusion";
  paint?: {
    color?: Value<Color>;
    height?: Value<number>;
    base?: Value<number>;
    opacity?: Value<number>;
  };
}

export interface HillshadeLayerSpec extends LayerBase {
  type: "hillshade";
  source: string;
  paint?: {
    exaggeration?: Value<number>;
    shadowColor?: Value<Color>;
    highlightColor?: Value<Color>;
    accentColor?: Value<Color>;
    illuminationDirection?: number;
    illuminationAnchor?: "viewport" | "map";
  };
}

export type LayerSpec =
  | BackgroundLayerSpec
  | RasterLayerSpec
  | FillLayerSpec
  | LineLayerSpec
  | CircleLayerSpec
  | HeatmapLayerSpec
  | SymbolLayerSpec
  | ExtrusionLayerSpec
  | HillshadeLayerSpec;

export type LayerType = LayerSpec["type"];

export interface TerrainSpec {
  source: string;
  exaggeration?: number;
}

export interface StyleSpec {
  version: 1;
  name?: string;
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  sources: Record<string, SourceSpec>;
  layers: LayerSpec[];
  terrain?: TerrainSpec;
  fonts?: Record<string, string[]>;
  sprite?: string | { id: string; url: string }[];
  metadata?: Record<string, unknown>;
}
