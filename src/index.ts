export type { MapletErrorCode } from "./core/errors.ts";
export { MapletError } from "./core/errors.ts";
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
  MapTouchEvent,
  MapWheelEvent,
  PaddingOptions,
  PointLike,
  QueryGeometry,
  QueryOptions,
  ScreenPosition,
  Source,
  SourceDataEvent,
  StyleImageMissingEvent,
  TouchZoomRotateSwitch,
  UiText,
} from "./core/map.ts";
export { MapletMap as Map } from "./core/map.ts";
export type { QueriedFeature, SourceQueriedFeature } from "./core/query.ts";
export type { Feature, FeatureCollection, GeoJSON, Geometry } from "./geo/geojson.ts";
export type { LngLat, LngLatLike, LngLatObject } from "./geo/mercator.ts";
export { distanceMeters, lngLatToWorld, metersPerPixel, worldToLngLat } from "./geo/mercator.ts";
export type { DemSource } from "./sources/dem.ts";
export { openTileFile } from "./sources/files.ts";
export type { GeoJSONSource } from "./sources/geojson.ts";
export type { Corners, ImageSource } from "./sources/image.ts";
export type { RasterSource } from "./sources/raster.ts";
export type { VectorSource } from "./sources/vector.ts";
export type { FeatureTarget } from "./style/feature-state.ts";
export type * from "./style/types.ts";
export type { StyleIssue } from "./style/validate.ts";
export { validateStyle } from "./style/validate.ts";
export type { LightStyleOptions } from "./styles/light.ts";
export { lightStyle } from "./styles/light.ts";
export type { RequestParameters, ResourceKind, TransformRequest } from "./tiles/fetch.ts";
export type { TileStats } from "./tiles/manager.ts";
export type { ProtocolHandler, ProtocolRequest, ProtocolResult } from "./tiles/protocols.ts";
export { addProtocol, removeProtocol } from "./tiles/protocols.ts";
export type { Anchor } from "./ui/anchor.ts";
export type {
  AttributionOptions,
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
} from "./ui/controls.ts";
export {
  AttributionControl,
  FullscreenControl,
  GeolocateControl,
  NavigationControl,
  ScaleControl,
} from "./ui/controls.ts";
export type { Alignment, MarkerEvent, MarkerEvents, MarkerOptions } from "./ui/marker.ts";
export { Marker } from "./ui/marker.ts";
export type { PopupEvent, PopupEvents, PopupOptions } from "./ui/popup.ts";
export { Popup } from "./ui/popup.ts";
export type { SourceGeoJSONFeature } from "./worker/geojson.ts";

declare const MAPLET_VERSION: string | undefined;

export const version: string = typeof MAPLET_VERSION === "string" ? MAPLET_VERSION : "0.0.0-dev";
