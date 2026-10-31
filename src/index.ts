export type { MapkernErrorCode } from "./core/errors.ts";
export { MapkernError } from "./core/errors.ts";
export type { ImageInput, ImageOptions } from "./core/images.ts";
export type {
  AnimationOptions,
  BoundsLike,
  CameraOptions,
  Diagnostics,
  FitBoundsOptions,
  FlyToOptions,
  HandlerSwitch,
  MapDataEvent,
  MapErrorEvent,
  MapEvent,
  MapEvents,
  MapLayerEvent,
  MapLayerEvents,
  MapMoveEvent,
  MapOptions,
  MapPointerEvent,
  MapStyleEvent,
  MapTouchEvent,
  MapWheelEvent,
  PaddingOptions,
  PointLike,
  QueryGeometry,
  QueryOptions,
  ScreenPosition,
  SetStyleOptions,
  Source,
  SourceDataEvent,
  StyleImageMissingEvent,
  TouchZoomRotateSwitch,
  UiText,
} from "./core/map.ts";
export { DEFAULT_STYLE, MapkernMap as Map } from "./core/map.ts";
export type { QueriedFeature, SourceQueriedFeature } from "./core/query.ts";
export type { Feature, FeatureCollection, GeoJSON, Geometry } from "./geo/geojson.ts";
export type { Projection } from "./geo/globe.ts";
export type { LngLat, LngLatLike, LngLatObject } from "./geo/mercator.ts";
export { distanceMeters, lngLatToWorld, metersPerPixel, worldToLngLat } from "./geo/mercator.ts";
export type { SunPosition } from "./geo/sun.ts";
export { sunAltitude, sunAzimuth, sunPosition } from "./geo/sun.ts";
export type { SearchKind } from "./search/format.ts";
export { SearchIndexError } from "./search/format.ts";
export type {
  Geocoder,
  ReverseOptions,
  SearchIndexOptions,
  SearchIndexSource,
  SearchOptions,
  SearchResult,
} from "./search/index.ts";
export { SearchIndex, SearchIndexSet } from "./search/index.ts";
export type { DemSource } from "./sources/dem.ts";
export { openElevationFile } from "./sources/elevation.ts";
export { openTileFile } from "./sources/files.ts";
export type { GeoJSONSource } from "./sources/geojson.ts";
export type { Corners, ImageSource } from "./sources/image.ts";
export type { RasterSource } from "./sources/raster.ts";
export type { VectorSource } from "./sources/vector.ts";
export type { FeatureTarget } from "./style/feature-state.ts";
export type { ImportedStyle } from "./style/import.ts";
export { importStyle } from "./style/import.ts";
export type { CustomLayer, CustomLayerInput } from "./style/layer.ts";
export type * from "./style/types.ts";
export type { StyleIssue } from "./style/validate.ts";
export { validateStyle } from "./style/validate.ts";
export type { LightStyleOptions } from "./styles/light.ts";
export { lightStyle } from "./styles/light.ts";
export { clearDiskCache } from "./tiles/cache.ts";
export type { RequestParameters, ResourceKind, TransformRequest } from "./tiles/fetch.ts";
export type { TileStats } from "./tiles/manager.ts";
export type { ProtocolHandler, ProtocolRequest, ProtocolResult } from "./tiles/protocols.ts";
export { addProtocol, removeProtocol } from "./tiles/protocols.ts";
export type { Anchor } from "./ui/anchor.ts";
export type {
  AttributionOptions,
  Basemap,
  BasemapChangeEvent,
  BasemapEvents,
  BasemapOptions,
  Control,
  ControlPosition,
  FullscreenEvent,
  FullscreenEvents,
  FullscreenOptions,
  GeolocateErrorEvent,
  GeolocateEvent,
  GeolocateEvents,
  GeolocateOptions,
  GeolocateState,
  GeolocateTrackEvent,
  NavigationOptions,
  ScaleOptions,
  ScaleUnit,
  TerrainControlOptions,
  TerrainEvents,
  TerrainView,
  TerrainViewEvent,
} from "./ui/controls.ts";
export {
  AttributionControl,
  BasemapControl,
  FullscreenControl,
  GeolocateControl,
  NavigationControl,
  ScaleControl,
  TerrainControl,
} from "./ui/controls.ts";
export { LogoControl } from "./ui/logo.ts";
export type { Alignment, MarkerEvent, MarkerEvents, MarkerOptions } from "./ui/marker.ts";
export { Marker } from "./ui/marker.ts";
export type { PopupEvent, PopupEvents, PopupOptions } from "./ui/popup.ts";
export { Popup } from "./ui/popup.ts";
export type {
  SearchControlOptions,
  SearchErrorEvent,
  SearchEvents,
  SearchResultEvent,
  SearchResultsEvent,
} from "./ui/search.ts";
export { SearchControl } from "./ui/search.ts";
export type { SourceGeoJSONFeature } from "./worker/geojson.ts";

declare const MAPKERN_VERSION: string | undefined;

export const version: string = typeof MAPKERN_VERSION === "string" ? MAPKERN_VERSION : "0.0.0-dev";
export type { CotWriteOptions } from "./formats/cot.ts";
export { cotToGeoJSON, cotTypeToSidc, geoJSONToCot, sidcToCotType } from "./formats/cot.ts";
export type { CsvWriteOptions, GpxWriteOptions, KmlWriteOptions } from "./formats/export.ts";
export { geoJSONToCsv, geoJSONToGpx, geoJSONToKml, geoJSONToWkt, geometryToWkt } from "./formats/export.ts";
export type { FeatureFormat } from "./formats/feature-format.ts";
export { FEATURE_FORMATS } from "./formats/feature-format.ts";
export type { ReadOptions } from "./formats/read.ts";
export { readFeatures } from "./formats/read.ts";
export type { MgrsPoint, Utm } from "./geo/mgrs.ts";
export { fromMgrs, fromUtm, toMgrs, toUtm, utmZone } from "./geo/mgrs.ts";
export type {
  Affiliation,
  Dimension,
  DrawnSymbol,
  Echelon,
  MilitarySymbolsOptions,
  SymbolCode,
  SymbolOptions,
} from "./military/symbol.ts";
export { drawSymbol, militarySymbols, parseSidc } from "./military/symbol.ts";
