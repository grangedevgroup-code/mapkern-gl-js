import type { Transform } from "./transform.ts";

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export type Easing = (t: number) => number;

export const easeOutCubic: Easing = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const linear: Easing = (t) => t;

export interface Anchor {
  world: [number, number];
  screen: [number, number];
}

export interface CameraMotion {
  readonly duration: number;
  readonly target: CameraState;
  apply(transform: Transform, t: number): void;
}

export function readState(transform: Transform): CameraState {
  const [x, y] = transform.centerWorld;
  return { x, y, zoom: transform.zoom, bearing: transform.bearing, pitch: transform.pitch };
}

export function shortestX(from: number, to: number): number {
  let dx = to - from;
  dx -= Math.round(dx);
  return from + dx;
}

export function shortestBearing(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return from + d;
}

export function easeMotion(from: CameraState, to: CameraState, duration: number, easing: Easing, anchor?: Anchor): CameraMotion {
  const tx = shortestX(from.x, to.x);
  const tb = shortestBearing(from.bearing, to.bearing);
  return {
    duration,
    target: to,
    apply(transform, t) {
      const k = easing(Math.min(1, Math.max(0, t)));
      transform.setZoom(from.zoom + (to.zoom - from.zoom) * k);
      transform.setBearing(from.bearing + (tb - from.bearing) * k);
      transform.setPitch(from.pitch + (to.pitch - from.pitch) * k);
      if (anchor) {
        transform.setLocationAtPoint(anchor.world, anchor.screen[0], anchor.screen[1]);
      } else {
        transform.setCenterWorld(from.x + (tx - from.x) * k, from.y + (to.y - from.y) * k);
      }
    },
  };
}

export interface FlyOptions {
  curve: number;
  speed: number;
  screenSpeed?: number;
  maxDuration?: number;
  duration?: number;
  minZoom?: number;
  easing: Easing;
}

export function flyMotion(from: CameraState, to: CameraState, viewport: number, options: FlyOptions): CameraMotion {
  const rho = options.curve;
  const tx = shortestX(from.x, to.x);
  const tb = shortestBearing(from.bearing, to.bearing);
  const scale0 = 2 ** from.zoom;
  const scale1 = 2 ** to.zoom;
  const w0 = viewport / scale0;
  let w1 = viewport / scale1;
  const u1 = Math.hypot(tx - from.x, to.y - from.y) * 512;
  const rho2 = rho * rho;
  if (options.minZoom !== undefined) {
    const peak = Math.min(options.minZoom, from.zoom, to.zoom);
    const wMax = viewport / 2 ** peak;
    w1 = Math.min(w1, wMax * 4);
  }
  const b = (i: 0 | 1) => {
    const w = i === 0 ? w0 : w1;
    return (w1 * w1 - w0 * w0 + (i === 0 ? 1 : -1) * rho2 * rho2 * u1 * u1) / (2 * w * rho2 * u1);
  };
  const r = (i: 0 | 1) => {
    const bi = b(i);
    return Math.log(Math.sqrt(bi * bi + 1) - bi);
  };
  let S: number;
  let widthAt: (s: number) => number;
  let progressAt: (s: number) => number;
  if (u1 < 1e-9 || !Number.isFinite(r(0)) || !Number.isFinite(r(1))) {
    const k = w1 < w0 ? -1 : 1;
    S = Math.abs(Math.log(w1 / w0)) / rho;
    widthAt = (s) => w0 * Math.exp(k * rho * s);
    progressAt = () => 0;
  } else {
    const r0 = r(0);
    const r1 = r(1);
    S = (r1 - r0) / rho;
    widthAt = (s) => (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0);
    progressAt = (s) => ((w0 * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0))) / rho2) / u1;
  }
  let duration: number;
  if (options.duration !== undefined) {
    duration = options.duration;
  } else {
    const speed = options.screenSpeed !== undefined ? options.screenSpeed / rho : options.speed;
    duration = (1000 * S) / Math.max(speed, 1e-6);
    if (!Number.isFinite(duration)) duration = 0;
    if (options.maxDuration !== undefined && duration > options.maxDuration) duration = 0;
  }
  return {
    duration,
    target: to,
    apply(transform, t) {
      const k = options.easing(Math.min(1, Math.max(0, t)));
      const s = k * S;
      const u = k >= 1 ? 1 : progressAt(s);
      const zoom = k >= 1 ? to.zoom : from.zoom + Math.log2(w0 / widthAt(s));
      transform.setZoom(zoom);
      transform.setBearing(from.bearing + (tb - from.bearing) * k);
      transform.setPitch(from.pitch + (to.pitch - from.pitch) * k);
      transform.setCenterWorld(from.x + (tx - from.x) * u, from.y + (to.y - from.y) * u);
    },
  };
}
