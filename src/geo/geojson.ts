export type Position = number[];

export interface PointGeometry {
  type: "Point";
  coordinates: Position;
}

export interface MultiPointGeometry {
  type: "MultiPoint";
  coordinates: Position[];
}

export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
}

export interface MultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: Position[][];
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Position[][][];
}

export interface GeometryCollection {
  type: "GeometryCollection";
  geometries: Geometry[];
}

export type Geometry =
  | PointGeometry
  | MultiPointGeometry
  | LineStringGeometry
  | MultiLineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry
  | GeometryCollection;

export interface Feature {
  type: "Feature";
  id?: string | number;
  geometry: Geometry | null;
  properties: Record<string, unknown> | null;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

export type GeoJSON = Geometry | Feature | FeatureCollection;
