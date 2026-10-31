export const GLOBE_FULL_ZOOM = 10;
export const GLOBE_FLAT_ZOOM = 12;

export type Projection = "mercator" | "globe";

export function globeness(zoom: number): number {
  if (zoom <= GLOBE_FULL_ZOOM) return 1;
  if (zoom >= GLOBE_FLAT_ZOOM) return 0;
  const t = (zoom - GLOBE_FULL_ZOOM) / (GLOBE_FLAT_ZOOM - GLOBE_FULL_ZOOM);
  return 1 - t * t * (3 - 2 * t);
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

export function rotateToward(
  c: readonly number[],
  from: readonly number[],
  to: readonly number[],
  out: number[],
): number[] {
  const kx = from[1]! * to[2]! - from[2]! * to[1]!;
  const ky = from[2]! * to[0]! - from[0]! * to[2]!;
  const kz = from[0]! * to[1]! - from[1]! * to[0]!;
  const sin = Math.hypot(kx, ky, kz);
  const cos = from[0]! * to[0]! + from[1]! * to[1]! + from[2]! * to[2]!;
  if (sin < 1e-15) {
    out[0] = c[0]!;
    out[1] = c[1]!;
    out[2] = c[2]!;
    return out;
  }
  const ax = kx / sin;
  const ay = ky / sin;
  const az = kz / sin;
  const dot = ax * c[0]! + ay * c[1]! + az * c[2]!;
  const cx = ay * c[2]! - az * c[1]!;
  const cy = az * c[0]! - ax * c[2]!;
  const cz = ax * c[1]! - ay * c[0]!;
  const angle = Math.atan2(sin, cos);
  const s = Math.sin(angle);
  const k = 1 - Math.cos(angle);
  const co = Math.cos(angle);
  out[0] = c[0]! * co + cx * s + ax * dot * k;
  out[1] = c[1]! * co + cy * s + ay * dot * k;
  out[2] = c[2]! * co + cz * s + az * dot * k;
  return out;
}

export function nearestDotInBox(
  lat0: number,
  lat1: number,
  lng0: number,
  lng1: number,
  latC: number,
  lngC: number,
): number {
  const span = lng1 - lng0;
  let d = lngC - lng0;
  d -= Math.floor(d / (2 * Math.PI)) * 2 * Math.PI;
  const sinC = Math.sin(latC);
  const cosC = Math.cos(latC);
  if (d <= span) {
    const lat = Math.max(lat0, Math.min(lat1, latC));
    return Math.cos(lat - latC);
  }
  const toEdge = Math.min(d - span, 2 * Math.PI - d);
  const cosD = Math.cos(toEdge);
  const best = Math.atan2(sinC, cosC * cosD);
  const lat = Math.max(lat0, Math.min(lat1, best));
  return Math.cos(lat) * cosC * cosD + Math.sin(lat) * sinC;
}
