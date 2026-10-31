export const GLOBE_FULL_ZOOM = 10;
export const GLOBE_FLAT_ZOOM = 12;

export type Projection = "mercator" | "globe";

export function globeness(zoom: number): number {
  if (zoom <= GLOBE_FULL_ZOOM) return 1;
  if (zoom >= GLOBE_FLAT_ZOOM) return 0;
  const t = (zoom - GLOBE_FULL_ZOOM) / (GLOBE_FLAT_ZOOM - GLOBE_FULL_ZOOM);
  return 1 - t * t * (3 - 2 * t);
}

export function globeFitZoom(width: number, height: number, fov: number, lat: number): number {
  if (!(width > 0 && height > 0)) return 0;
  const d = height / 2 / Math.tan((fov * Math.PI) / 360);
  const r = 0.42 * Math.min(width, height);
  const radius = (r * r + r * Math.sqrt(r * r + d * d)) / d;
  const rad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.log2((2 * Math.PI * radius * Math.cos(rad)) / 512);
}

export function unitFromMercator(x: number, y: number, out: number[] | Float64Array): void {
  const m = Math.PI * (1 - 2 * y);
  const cosLat = 1 / Math.cosh(m);
  const sinLat = Math.tanh(m);
  const lng = 2 * Math.PI * x - Math.PI;
  out[0] = cosLat * Math.cos(lng);
  out[1] = cosLat * Math.sin(lng);
  out[2] = sinLat;
}

export function mercatorFromUnit(px: number, py: number, pz: number): [number, number] {
  const length = Math.hypot(px, py, pz);
  const sinLat = Math.max(-1, Math.min(1, pz / length));
  const lng = Math.atan2(py, px);
  const x = (lng + Math.PI) / (2 * Math.PI);
  const y = (1 - Math.atanh(Math.max(-0.9999999999999, Math.min(0.9999999999999, sinLat))) / Math.PI) / 2;
  return [x - Math.floor(x), Math.max(0, Math.min(1, y))];
}

export function nearestInBox(
  lat0: number,
  lat1: number,
  lng0: number,
  lng1: number,
  latC: number,
  lngC: number,
  out: number[],
): number {
  const span = lng1 - lng0;
  let d = lngC - lng0;
  d -= Math.floor(d / (2 * Math.PI)) * 2 * Math.PI;
  const sinC = Math.sin(latC);
  const cosC = Math.cos(latC);
  if (d <= span) {
    const lat = Math.max(lat0, Math.min(lat1, latC));
    out[0] = lat;
    out[1] = lngC;
    return Math.cos(lat - latC);
  }
  const east = d - span;
  const west = 2 * Math.PI - d;
  const toEdge = Math.min(east, west);
  const cosD = Math.cos(toEdge);
  const best = Math.atan2(sinC, cosC * cosD);
  const lat = Math.max(lat0, Math.min(lat1, best));
  out[0] = lat;
  out[1] = east <= west ? lng1 : lng0;
  return Math.cos(lat) * cosC * cosD + Math.sin(lat) * sinC;
}
