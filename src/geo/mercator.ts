export const EARTH_RADIUS = 6378137;
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
export const MAX_LATITUDE = 85.0511287798066;
export const TILE_SIZE = 512;

export type LngLat = [lng: number, lat: number];
export interface LngLatObject {
  lng: number;
  lat: number;
}
export type LngLatLike = readonly [number, number] | LngLatObject;

export function toLngLat(value: LngLatLike): LngLat {
  if (Array.isArray(value)) {
    const lng = value[0];
    const lat = value[1];
    if (typeof lng === "number" && typeof lat === "number" && Number.isFinite(lng) && Number.isFinite(lat)) {
      return [lng, lat];
    }
  } else if (typeof value === "object" && value !== null) {
    const v = value as LngLatObject;
    if (Number.isFinite(v.lng) && Number.isFinite(v.lat)) return [v.lng, v.lat];
  }
  throw new TypeError("Expected [lng, lat] or { lng, lat } with finite numbers");
}

export function clampLatitude(lat: number): number {
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
}

export function wrapLongitude(lng: number): number {
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lng > 0 ? 180 : w;
}

export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

export function mercatorY(lat: number): number {
  const s = Math.sin((clampLatitude(lat) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latFromMercatorY(y: number): number {
  return (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;
}

export function lngLatToWorld(lng: number, lat: number): [number, number] {
  return [mercatorX(lng), mercatorY(lat)];
}

export function worldToLngLat(x: number, y: number): LngLat {
  return [lngFromMercatorX(x), latFromMercatorY(y)];
}

export function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

export function metersPerPixel(lat: number, zoom: number): number {
  return (Math.cos((clampLatitude(lat) * Math.PI) / 180) * EARTH_CIRCUMFERENCE) / worldSize(zoom);
}

export function metersToWorldUnits(meters: number, lat: number): number {
  return meters / (EARTH_CIRCUMFERENCE * Math.cos((clampLatitude(lat) * Math.PI) / 180));
}

export function metersToWorldUnitsAtY(meters: number, y: number): number {
  return metersToWorldUnits(meters, latFromMercatorY(y));
}

export function distanceMeters(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}
