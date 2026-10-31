import type { Projection } from "../geo/globe.ts";
import { globeness, mercatorFromUnit, nearestInBox, rotateToward, unitFromMercator } from "../geo/globe.ts";
import type { Mat4, Vec4 } from "../geo/mat4.ts";
import * as mat4 from "../geo/mat4.ts";
import type { LngLat } from "../geo/mercator.ts";
import {
  clampLatitude,
  EARTH_CIRCUMFERENCE,
  latFromMercatorY,
  lngFromMercatorX,
  mercatorX,
  mercatorY,
  TILE_SIZE,
  worldSize,
} from "../geo/mercator.ts";
import type { TileSlot } from "../geo/tile.ts";
import { MAX_TILE_ZOOM } from "../geo/tile.ts";

export const MIN_ZOOM = -2;

export interface CoverOptions {
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  round: boolean;
  maxTiles?: number;
}

export interface CoveringTile extends TileSlot {
  distance: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface WorldBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const NO_PADDING: Padding = { top: 0, right: 0, bottom: 0, left: 0 };

const DEG = Math.PI / 180;
const DEFAULT_FOV = (2 * Math.atan(0.375)) / DEG;
const MAX_GROUND_ANGLE = 88 * DEG;

export class Transform {
  width = 1;
  height = 1;
  minZoom = 0;
  maxZoom = 22;
  minPitch = 0;
  maxPitch = 60;
  renderWorldCopies = true;
  keepInWorld = true;
  private fovDeg = DEFAULT_FOV;

  readonly projMatrix: Mat4 = mat4.create();
  readonly viewMatrix: Mat4 = mat4.create();
  readonly pixelMatrix: Mat4 = mat4.create();
  readonly pixelMatrixInverse: Mat4 = mat4.create();
  readonly unitMatrix: Mat4 = mat4.create();
  readonly globeMatrix: Mat4 = mat4.create();
  readonly globeMatrixInverse: Mat4 = mat4.create();

  private mode: Projection = "mercator";
  private globeAmount = 0;
  private radius = 1;
  private readonly globeCam: [number, number, number] = [0, 0, 1];
  private readonly forward: [number, number, number] = [0, 0, -1];
  private readonly axisC: number[] = [1, 0, 0];
  private readonly axisE: number[] = [0, 1, 0];
  private readonly axisN: number[] = [0, 0, 1];
  private coverCache = new Map<string, CoveringTile[]>();
  private cx = 0.5;
  private cy = 0.5;
  private z = 0;
  private bearingDeg = 0;
  private pitchDeg = 0;
  private dirty = true;
  private cameraDistance = 1;
  private cameraPos: [number, number, number] = [0, 0, 1];
  private farZ = 1;
  private nearZ = 1;
  private elevationMeters = 0;
  private groundMeters = 0;
  private peakMeters = Number.NEGATIVE_INFINITY;
  private peakPx = 0;
  private elevationPx = 0;
  private groundPx = 0;
  private pad: Padding = { ...NO_PADDING };
  private limits: WorldBounds | null = null;
  private readonly tmp: Vec4 = [0, 0, 0, 0];

  get center(): LngLat {
    return [lngFromMercatorX(this.cx), latFromMercatorY(this.cy)];
  }

  get centerWorld(): [number, number] {
    return [this.cx, this.cy];
  }

  get zoom(): number {
    return this.z;
  }

  get bearing(): number {
    return this.bearingDeg;
  }

  get pitch(): number {
    return this.pitchDeg;
  }

  get fov(): number {
    return this.fovDeg;
  }

  get scale(): number {
    return 2 ** this.z;
  }

  get worldSize(): number {
    return worldSize(this.z);
  }

  get cameraToCenterDistance(): number {
    this.update();
    return this.cameraDistance;
  }

  get cameraPosition(): [number, number, number] {
    this.update();
    return this.cameraPos;
  }

  get elevation(): number {
    return this.elevationMeters;
  }

  get ground(): number {
    return this.groundMeters;
  }

  get pixelsPerMeter(): number {
    return (this.worldSize * Math.cosh(Math.PI * (1 - 2 * this.cy))) / EARTH_CIRCUMFERENCE;
  }

  get centerElevationPixels(): number {
    this.update();
    return this.elevationPx;
  }

  get far(): number {
    this.update();
    return this.farZ;
  }

  get padding(): Padding {
    return { ...this.pad };
  }

  get centerPoint(): [number, number] {
    return [
      this.width / 2 + (this.pad.left - this.pad.right) / 2,
      this.height / 2 + (this.pad.top - this.pad.bottom) / 2,
    ];
  }

  get maxBounds(): WorldBounds | null {
    return this.limits ? { ...this.limits } : null;
  }

  get near(): number {
    this.update();
    return this.nearZ;
  }

  get projection(): Projection {
    return this.mode;
  }

  get globeness(): number {
    this.update();
    return this.globeAmount;
  }

  get globeRadius(): number {
    this.update();
    return this.radius;
  }

  get globeCamera(): readonly [number, number, number] {
    this.update();
    return this.globeCam;
  }

  setProjection(projection: Projection): void {
    const next: Projection = projection === "globe" ? "globe" : "mercator";
    if (next === this.mode) return;
    this.mode = next;
    this.dirty = true;
    this.constrain();
  }

  clone(): Transform {
    const t = new Transform();
    t.mode = this.mode;
    t.width = this.width;
    t.height = this.height;
    t.minZoom = this.minZoom;
    t.maxZoom = this.maxZoom;
    t.minPitch = this.minPitch;
    t.maxPitch = this.maxPitch;
    t.renderWorldCopies = this.renderWorldCopies;
    t.keepInWorld = this.keepInWorld;
    t.fovDeg = this.fovDeg;
    t.cx = this.cx;
    t.cy = this.cy;
    t.z = this.z;
    t.bearingDeg = this.bearingDeg;
    t.pitchDeg = this.pitchDeg;
    t.elevationMeters = this.elevationMeters;
    t.groundMeters = this.groundMeters;
    t.peakMeters = this.peakMeters;
    t.pad = { ...this.pad };
    t.limits = this.limits ? { ...this.limits } : null;
    t.dirty = true;
    return t;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.dirty = true;
    this.constrain();
  }

  setPadding(padding: Padding): void {
    const p = this.pad;
    if (p.top === padding.top && p.right === padding.right && p.bottom === padding.bottom && p.left === padding.left) {
      return;
    }
    this.pad = { top: padding.top, right: padding.right, bottom: padding.bottom, left: padding.left };
    this.dirty = true;
    this.constrain();
  }

  setMaxBounds(bounds: WorldBounds | null): void {
    this.limits = bounds ? { ...bounds } : null;
    this.constrain();
  }

  setCenter(lng: number, lat: number): void {
    this.setCenterWorld(mercatorX(lng), mercatorY(clampLatitude(lat)));
  }

  setCenterWorld(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const nx = this.renderWorldCopies ? x - Math.floor(x) : Math.min(1, Math.max(0, x));
    const ny = Math.min(1, Math.max(0, y));
    if (nx === this.cx && ny === this.cy) return;
    this.cx = nx;
    this.cy = ny;
    this.dirty = true;
    this.constrain();
  }

  setZoom(zoom: number): void {
    if (!Number.isFinite(zoom)) return;
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    if (z === this.z) return;
    this.z = z;
    this.dirty = true;
    this.constrain();
  }

  setBearing(bearing: number): void {
    if (!Number.isFinite(bearing)) return;
    let b = ((bearing % 360) + 360) % 360;
    if (b > 180) b -= 360;
    if (b === this.bearingDeg) return;
    this.bearingDeg = b;
    this.dirty = true;
    this.constrain();
  }

  get lowestZoom(): number {
    if (!this.keepInWorld || this.mode === "globe") return this.minZoom;
    return Math.max(this.minZoom, Math.min(this.maxZoom, this.view().fit));
  }

  private view() {
    const limits = this.limits;
    const wraps = this.renderWorldCopies && !limits;
    const bounds = {
      x0: limits ? limits.x0 : 0,
      x1: limits ? limits.x1 : 1,
      y0: Math.max(0, limits ? limits.y0 : 0),
      y1: Math.min(1, limits ? limits.y1 : 1),
    };
    const [px, py] = this.centerPoint;
    const angle = this.bearingDeg * DEG;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const pitch = this.pitchDeg * DEG;
    const tilt = Math.sin(pitch);
    const upright = Math.cos(pitch);
    const d = this.height / 2 / Math.tan((this.fov * DEG) / 2);
    const reach = d * upright * Math.tan(MAX_GROUND_ANGLE);
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const [sx, sy] of [
      [-px, -py],
      [this.width - px, -py],
      [this.width - px, this.height - py],
      [-px, this.height - py],
    ] as const) {
      const ahead = d * tilt - sy * upright;
      const down = d * upright + sy * tilt;
      let t = sy < 0 ? 1 : down > 0 ? (d * upright) / down : Infinity;
      if (ahead > 0 && t * ahead > reach) t = reach / ahead;
      const gx = t * sx;
      const gy = sy < 0 ? sy : d * tilt - t * ahead;
      const dx = gx * cos - gy * sin;
      const dy = gx * sin + gy * cos;
      left = Math.min(left, dx);
      right = Math.max(right, dx);
      top = Math.min(top, dy);
      bottom = Math.max(bottom, dy);
    }
    const spanX = wraps ? Infinity : (bounds.x1 - bounds.x0) * TILE_SIZE;
    const spanY = (bounds.y1 - bounds.y0) * TILE_SIZE;
    const fit = Math.log2(Math.max((right - left) / spanX, (bottom - top) / spanY));
    return { bounds, wraps, left, right, top, bottom, fit };
  }

  private constrain(): void {
    if (!this.keepInWorld) return;
    if (this.mode === "globe" && globeness(this.z) > 0) return;
    const { bounds: b, wraps, left, right, top, bottom, fit } = this.view();
    let z = this.z;
    if (z < fit) z = Math.min(this.maxZoom, fit);
    const ws = worldSize(z);
    let x = this.cx;
    if (!wraps) {
      const mid = (b.x0 + b.x1) / 2;
      x = this.cx + Math.round(mid - this.cx);
      const minX = b.x0 - left / ws;
      const maxX = b.x1 - right / ws;
      x = minX > maxX ? (minX + maxX) / 2 : Math.min(maxX, Math.max(minX, x));
    }
    const minY = b.y0 - top / ws;
    const maxY = b.y1 - bottom / ws;
    const y = minY > maxY ? (minY + maxY) / 2 : Math.min(maxY, Math.max(minY, this.cy));
    const nx = this.renderWorldCopies ? x - Math.floor(x) : Math.min(1, Math.max(0, x));
    if (nx === this.cx && y === this.cy && z === this.z) return;
    this.cx = nx;
    this.cy = y;
    this.z = z;
    this.dirty = true;
  }

  setPitch(pitch: number): void {
    if (!Number.isFinite(pitch)) return;
    const p = Math.min(this.maxPitch, Math.max(this.minPitch, pitch));
    if (p === this.pitchDeg) return;
    this.pitchDeg = p;
    this.dirty = true;
    this.constrain();
  }

  setElevation(meters: number): void {
    if (!Number.isFinite(meters) || meters === this.elevationMeters) return;
    this.elevationMeters = meters;
    this.dirty = true;
  }

  setGround(meters: number): void {
    if (!Number.isFinite(meters) || meters === this.groundMeters) return;
    this.groundMeters = meters;
    this.dirty = true;
  }

  setPeak(meters: number): void {
    const value = Number.isFinite(meters) ? meters : Number.NEGATIVE_INFINITY;
    if (value === this.peakMeters) return;
    this.peakMeters = value;
    this.dirty = true;
  }

  setElevationKeepCamera(meters: number): void {
    if (!Number.isFinite(meters) || meters === this.elevationMeters) return;
    this.update();
    const ws = this.worldSize;
    const camX = this.cameraPos[0] / ws;
    const camY = this.cameraPos[1] / ws;
    const camZ = this.cameraPos[2] / ws;
    const pitch = this.pitchDeg * DEG;
    const bearing = this.bearingDeg * DEG;
    const fx = Math.sin(pitch) * Math.sin(bearing);
    const fy = -Math.sin(pitch) * Math.cos(bearing);
    let x = this.cx;
    let y = this.cy;
    let distance = 0;
    for (let i = 0; i < 6; i++) {
      const height = (meters * Math.cosh(Math.PI * (1 - 2 * y))) / EARTH_CIRCUMFERENCE;
      distance = (camZ - height) / Math.cos(pitch);
      const nx = camX + fx * distance;
      const ny = camY + fy * distance;
      const settled = Math.abs(ny - y) < 1e-15;
      x = nx;
      y = ny;
      if (settled) break;
    }
    if (!(distance > 0) || y < 0 || y > 1) return;
    this.elevationMeters = meters;
    this.setZoom(Math.log2(this.cameraDistance / distance / TILE_SIZE));
    this.setCenterWorld(x, y);
    this.dirty = true;
  }

  setZoomRange(minZoom: number, maxZoom: number): void {
    this.minZoom = Math.max(MIN_ZOOM, Math.min(minZoom, maxZoom));
    this.maxZoom = Math.min(MAX_TILE_ZOOM, Math.max(minZoom, maxZoom));
    this.setZoom(this.z);
  }

  setFov(degrees: number): void {
    const next = Math.max(0.1, Math.min(150, degrees));
    if (next === this.fovDeg) return;
    this.fovDeg = next;
    this.dirty = true;
    this.setPitch(this.pitchDeg);
  }

  setPitchRange(minPitch: number, maxPitch: number): void {
    this.minPitch = Math.max(0, Math.min(minPitch, maxPitch));
    this.maxPitch = Math.min(85, Math.max(minPitch, maxPitch));
    this.setPitch(this.pitchDeg);
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const fovRad = this.fov * DEG;
    const pitch = this.pitchDeg * DEG;
    const d = this.height / 2 / Math.tan(fovRad / 2);
    this.cameraDistance = d;
    const ws = this.worldSize;
    const ppm = (ws * Math.cosh(Math.PI * (1 - 2 * this.cy))) / EARTH_CIRCUMFERENCE;
    this.elevationPx = this.elevationMeters * ppm;
    this.groundPx = Math.min(this.groundMeters * ppm, this.elevationPx);
    const camHeight = d * Math.cos(pitch);
    const [, principalY] = this.centerPoint;
    const topAngle = Math.min(pitch + Math.atan(principalY / d), MAX_GROUND_ANGLE);
    const groundAlongTopRay = (camHeight + this.elevationPx - this.groundPx) / Math.cos(topAngle);
    const farDepth = groundAlongTopRay * Math.cos(fovRad / 2);
    this.farZ = farDepth * 1.01 + 1;
    this.nearZ = Math.max(d / 100, 0.01);
    const bearingRad = this.bearingDeg * DEG;
    const reach = d * Math.sin(pitch);
    this.globeCam[0] = -Math.sin(bearingRad) * reach;
    this.globeCam[1] = Math.cos(bearingRad) * reach;
    this.globeCam[2] = camHeight + this.elevationPx;
    this.forward[0] = -this.globeCam[0] / d;
    this.forward[1] = -this.globeCam[1] / d;
    this.forward[2] = -camHeight / d;
    this.globeAmount = this.mode === "globe" ? globeness(this.z) : 0;
    this.coverCache.clear();
    if (this.globeAmount > 0) {
      const m = Math.PI * (1 - 2 * this.cy);
      this.radius = (ws * Math.cosh(m)) / (2 * Math.PI);
      const sinLat = Math.tanh(m);
      const cosLat = 1 / Math.cosh(m);
      const lng = 2 * Math.PI * this.cx - Math.PI;
      const sinLng = Math.sin(lng);
      const cosLng = Math.cos(lng);
      this.axisC[0] = cosLat * cosLng;
      this.axisC[1] = cosLat * sinLng;
      this.axisC[2] = sinLat;
      this.axisE[0] = -sinLng;
      this.axisE[1] = cosLng;
      this.axisE[2] = 0;
      this.axisN[0] = -sinLat * cosLng;
      this.axisN[1] = -sinLat * sinLng;
      this.axisN[2] = cosLat;
      const rho = this.radius / this.globeAmount;
      const reachToCenter = Math.hypot(this.globeCam[0], this.globeCam[1], this.globeCam[2] + rho);
      const globeFar = reachToCenter * 1.01 + 1;
      this.farZ = this.globeAmount >= 1 ? globeFar : Math.max(this.farZ, globeFar);
    }
    mat4.perspective(this.projMatrix, fovRad, this.width / this.height, this.nearZ, this.farZ);
    const [principalX] = this.centerPoint;
    this.projMatrix[8] = -((principalX - this.width / 2) * 2) / this.width;
    this.projMatrix[9] = ((principalY - this.height / 2) * 2) / this.height;
    const v = this.viewMatrix;
    mat4.identity(v);
    mat4.translate(v, v, 0, 0, -d);
    mat4.rotateX(v, v, -pitch);
    mat4.rotateZ(v, v, this.bearingDeg * DEG);
    mat4.scale(v, v, 1, -1, 1);
    mat4.translate(v, v, -this.cx * ws, -this.cy * ws, -this.elevationPx);
    mat4.multiply(this.pixelMatrix, this.projMatrix, v);
    mat4.invert(this.pixelMatrixInverse, this.pixelMatrix);
    mat4.scale(this.unitMatrix, this.pixelMatrix, ws, ws, 1);
    const bearing = this.bearingDeg * DEG;
    const horizontal = d * Math.sin(pitch);
    this.cameraPos = [
      this.cx * ws - Math.sin(bearing) * horizontal,
      this.cy * ws + Math.cos(bearing) * horizontal,
      camHeight + this.elevationPx,
    ];
    this.peakPx = Number.isFinite(this.peakMeters)
      ? Math.max(this.groundPx, Math.min(this.peakMeters * ppm, this.cameraPos[2] - 1))
      : this.groundPx;
    if (this.globeAmount > 0) {
      mat4.translate(this.globeMatrix, this.pixelMatrix, this.cx * ws, this.cy * ws, 0);
      mat4.invert(this.globeMatrixInverse, this.globeMatrix);
    }
  }

  surfaceLocal(x: number, y: number, h: number, out: number[] | Float64Array): void {
    this.update();
    const ws = this.worldSize;
    let dx = x - this.cx;
    dx -= Math.round(dx);
    const fx = dx * ws;
    const fy = (y - this.cy) * ws;
    const g = this.globeAmount;
    if (g <= 0) {
      out[0] = fx;
      out[1] = fy;
      out[2] = h;
      return;
    }
    const u = scratchUnit;
    unitFromMercator(x, y, u);
    const m = Math.PI * (1 - 2 * y);
    const r = this.radius + (h * Math.cosh(Math.PI * (1 - 2 * this.cy))) / Math.cosh(m);
    const c = this.axisC;
    const e = this.axisE;
    const n = this.axisN;
    const gx = r * (u[0]! * e[0]! + u[1]! * e[1]! + u[2]! * e[2]!);
    const gy = -r * (u[0]! * n[0]! + u[1]! * n[1]! + u[2]! * n[2]!);
    const gz = r * (u[0]! * c[0]! + u[1]! * c[1]! + u[2]! * c[2]!) - this.radius;
    out[0] = fx + (gx - fx) * g;
    out[1] = fy + (gy - fy) * g;
    out[2] = h + (gz - h) * g;
  }

  globeHidden(lx: number, ly: number, lz: number): boolean {
    const g = this.globeAmount;
    if (g <= 0) return false;
    const rho = this.radius / g;
    const cam = this.globeCam;
    const nz = lz + rho;
    const dot = lx * (cam[0] - lx) + ly * (cam[1] - ly) + nz * (cam[2] - lz);
    return dot < -1e-9 * rho * rho;
  }

  private projectGlobe(x: number, y: number, zPixels: number, out: Float64Array | number[]): number {
    const l = scratchLocal;
    this.surfaceLocal(x, y, zPixels, l);
    const m = this.globeMatrix;
    const lx = l[0]!;
    const ly = l[1]!;
    const lz = l[2]!;
    const cx = m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!;
    const cy = m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!;
    const w = m[3]! * lx + m[7]! * ly + m[11]! * lz + m[15]!;
    out[0] = ((cx / w + 1) / 2) * this.width;
    out[1] = ((1 - cy / w) / 2) * this.height;
    if (w > 0 && this.globeHidden(lx, ly, lz)) return -w;
    return w;
  }

  groundFrame(x: number, y: number, zPixels: number, out: Float64Array): number {
    this.update();
    if (this.globeAmount <= 0) {
      const u = this.unitMatrix;
      const w = u[3]! * x + u[7]! * y + u[11]! * zPixels + u[15]!;
      if (w <= 0) return w;
      const xn = (u[0]! * x + u[4]! * y + u[8]! * zPixels + u[12]!) / w;
      const yn = (u[1]! * x + u[5]! * y + u[9]! * zPixels + u[13]!) / w;
      const hw = this.width / 2;
      const hh = this.height / 2;
      out[0] = (xn + 1) * hw;
      out[1] = (1 - yn) * hh;
      out[2] = (hw * (u[0]! - xn * u[3]!)) / w;
      out[3] = (hw * (u[4]! - xn * u[7]!)) / w;
      out[4] = (-hh * (u[1]! - yn * u[3]!)) / w;
      out[5] = (-hh * (u[5]! - yn * u[7]!)) / w;
      return w;
    }
    const p = scratchScreen;
    const w = this.projectGlobe(x, y, zPixels, p);
    if (w <= 0) return w;
    const sx = p[0]!;
    const sy = p[1]!;
    const step = 0.5 / this.worldSize;
    this.projectGlobe(x + step, y, zPixels, p);
    const ex = p[0]!;
    const ey = p[1]!;
    this.projectGlobe(x - step, y, zPixels, p);
    out[2] = (ex - p[0]!) / (2 * step);
    out[4] = (ey - p[1]!) / (2 * step);
    this.projectGlobe(x, y + step, zPixels, p);
    const nx = p[0]!;
    const ny = p[1]!;
    this.projectGlobe(x, y - step, zPixels, p);
    out[3] = (nx - p[0]!) / (2 * step);
    out[5] = (ny - p[1]!) / (2 * step);
    out[0] = sx;
    out[1] = sy;
    return w;
  }

  private globeRay(px: number, py: number): [number, number, number] {
    const nx = (px / this.width) * 2 - 1;
    const ny = 1 - (py / this.height) * 2;
    const b = mat4.transformVec4([0, 0, 0, 0], this.globeMatrixInverse, nx, ny, 1, 1);
    const cam = this.globeCam;
    return [b[0] / b[3] - cam[0], b[1] / b[3] - cam[1], b[2] / b[3] - cam[2]];
  }

  private localToMercator(lx: number, ly: number, lz: number): [number, number] {
    const c = this.axisC;
    const e = this.axisE;
    const n = this.axisN;
    const up = lz + this.radius;
    return mercatorFromUnit(
      up * c[0]! + lx * e[0]! - ly * n[0]!,
      up * c[1]! + lx * e[1]! - ly * n[1]!,
      up * c[2]! + lx * e[2]! - ly * n[2]!,
    );
  }

  private sphereHit(px: number, py: number, height: number, clamp: boolean): [number, number] | null {
    const dir = this.globeRay(px, py);
    const cam = this.globeCam;
    const r = this.radius + height;
    const ox = cam[0];
    const oy = cam[1];
    const oz = cam[2] + this.radius;
    const a = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
    const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0) {
        const hx = ox + dir[0] * t;
        const hy = oy + dir[1] * t;
        const hz = oz + dir[2] * t;
        return this.localToMercator(hx, hy, hz - this.radius);
      }
    }
    if (!clamp) return null;
    const t = Math.max(0, -b / a);
    const qx = ox + dir[0] * t;
    const qy = oy + dir[1] * t;
    const qz = oz + dir[2] * t;
    const q = Math.hypot(qx, qy, qz);
    if (q < 1e-12) return [this.cx, this.cy];
    return this.localToMercator((qx / q) * r, (qy / q) * r, (qz / q) * r - this.radius);
  }

  private refineGlobe(guess: [number, number], px: number, py: number, h: number): [number, number] | null {
    let x = guess[0];
    let y = guess[1];
    const p = scratchScreen;
    const step = 0.25 / this.worldSize;
    for (let i = 0; i < 8; i++) {
      if (this.projectGlobe(x, y, h, p) <= 0) return null;
      const ex = p[0]! - px;
      const ey = p[1]! - py;
      if (Math.abs(ex) + Math.abs(ey) < 1e-6) return [x, y];
      this.projectGlobe(x + step, y, h, p);
      const ax = (p[0]! - px - ex) / step;
      const ay = (p[1]! - py - ey) / step;
      this.projectGlobe(x, y + step, h, p);
      const bx = (p[0]! - px - ex) / step;
      const by = (p[1]! - py - ey) / step;
      const det = ax * by - bx * ay;
      if (!(Math.abs(det) > 1e-30)) return null;
      x -= (by * ex - bx * ey) / det;
      y -= (ax * ey - ay * ex) / det;
    }
    if (this.projectGlobe(x, y, h, p) <= 0) return null;
    return Math.abs(p[0]! - px) + Math.abs(p[1]! - py) < 0.01 ? [x, y] : null;
  }

  private unprojectGlobe(px: number, py: number, groundZ: number | undefined, clamp: boolean): [number, number] | null {
    const h = groundZ ?? this.elevationPx;
    const g = this.globeAmount;
    if (g >= 1) return this.sphereHit(px, py, h, clamp);
    const flat = this.flatUnproject(px, py, h);
    const refined = flat ? this.refineGlobe(flat, px, py, h) : null;
    if (refined) return refined;
    const round = this.sphereHit(px, py, h, false);
    const second = round ? this.refineGlobe(round, px, py, h) : null;
    if (second || !clamp) return second;
    return this.flatUnprojectClamped(px, py, h);
  }

  groundMatrix(refX: number, refY: number, width: number, height: number, out: Float32Array): Float32Array {
    this.update();
    const m = this.pixelMatrix;
    const ws = this.worldSize;
    const a = [
      [m[0]!, m[4]!, m[12]!],
      [m[1]!, m[5]!, m[13]!],
      [m[3]!, m[7]!, m[15]!],
    ];
    const window = [
      [width / 2, 0, width / 2],
      [0, height / 2, height / 2],
      [0, 0, 1],
    ];
    const world = [
      [ws, 0, refX * ws],
      [0, ws, refY * ws],
      [0, 0, 1],
    ];
    const s = multiply3(multiply3(window, a), world);
    const inv = invert3(s);
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) out[col * 3 + row] = inv[row]![col]!;
    return out;
  }

  tileMatrix(z: number, x: number, y: number, wrap: number, extent: number, out: Float32Array): Float32Array {
    this.update();
    const ws = this.worldSize;
    const tileWorld = ws / 2 ** z;
    const m = scratchMatrix;
    mat4.translate(m, this.pixelMatrix, (wrap * 2 ** z + x) * tileWorld, y * tileWorld, 0);
    mat4.scale(m, m, tileWorld / extent, tileWorld / extent, 1);
    return mat4.toFloat32(m, out);
  }

  project(x: number, y: number, zPixels = 0): Point & { w: number } {
    this.update();
    if (this.globeAmount > 0) {
      const p = scratchScreen;
      const w = this.projectGlobe(x, y, zPixels, p);
      return { x: p[0]!, y: p[1]!, w };
    }
    const ws = this.worldSize;
    const p = mat4.transformVec4(this.tmp, this.pixelMatrix, x * ws, y * ws, zPixels, 1);
    const w = p[3];
    return { x: ((p[0] / w + 1) / 2) * this.width, y: ((1 - p[1] / w) / 2) * this.height, w };
  }

  projectTo(out: Float64Array, x: number, y: number, zPixels = 0): number {
    this.update();
    if (this.globeAmount > 0) return this.projectGlobe(x, y, zPixels, out);
    const m = this.unitMatrix;
    const cx = m[0]! * x + m[4]! * y + m[8]! * zPixels + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * zPixels + m[13]!;
    const w = m[3]! * x + m[7]! * y + m[11]! * zPixels + m[15]!;
    out[0] = ((cx / w + 1) / 2) * this.width;
    out[1] = ((1 - cy / w) / 2) * this.height;
    return w;
  }

  projectLngLat(lng: number, lat: number): Point {
    const p = this.project(mercatorX(lng), mercatorY(lat));
    return { x: p.x, y: p.y };
  }

  screenRay(px: number, py: number): { origin: [number, number, number]; dir: [number, number, number] } {
    this.update();
    const nx = (px / this.width) * 2 - 1;
    const ny = 1 - (py / this.height) * 2;
    const inv = this.pixelMatrixInverse;
    const a = mat4.transformVec4([0, 0, 0, 0], inv, nx, ny, -1, 1);
    const b = mat4.transformVec4([0, 0, 0, 0], inv, nx, ny, 1, 1);
    const ax = a[0] / a[3],
      ay = a[1] / a[3],
      az = a[2] / a[3];
    const bx = b[0] / b[3],
      by = b[1] / b[3],
      bz = b[2] / b[3];
    return { origin: [ax, ay, az], dir: [bx - ax, by - ay, bz - az] };
  }

  unproject(px: number, py: number, groundZ?: number): [number, number] | null {
    this.update();
    if (this.globeAmount > 0) return this.unprojectGlobe(px, py, groundZ, false);
    return this.flatUnproject(px, py, groundZ);
  }

  private flatUnproject(px: number, py: number, groundZ?: number): [number, number] | null {
    const { origin, dir } = this.screenRay(px, py);
    if (dir[2] >= -1e-12) return null;
    const t = ((groundZ ?? this.elevationPx) - origin[2]) / dir[2];
    if (t < 0) return null;
    const ws = this.worldSize;
    return [(origin[0] + dir[0] * t) / ws, (origin[1] + dir[1] * t) / ws];
  }

  unprojectClamped(px: number, py: number, groundZ?: number): [number, number] {
    this.update();
    if (this.globeAmount > 0) return this.unprojectGlobe(px, py, groundZ, true) ?? [this.cx, this.cy];
    return this.flatUnprojectClamped(px, py, groundZ);
  }

  private flatUnprojectClamped(px: number, py: number, groundZ?: number): [number, number] {
    const { origin, dir } = this.screenRay(px, py);
    const ws = this.worldSize;
    const plane = groundZ ?? this.elevationPx;
    const camHeight = Math.max(0, this.cameraPos[2] - plane);
    const maxHorizontal = camHeight * Math.tan(MAX_GROUND_ANGLE);
    const hx = dir[0],
      hy = dir[1];
    const hl = Math.hypot(hx, hy);
    if (dir[2] < -1e-12) {
      const t = (plane - origin[2]) / dir[2];
      const gx = origin[0] + dir[0] * t;
      const gy = origin[1] + dir[1] * t;
      const ddx = gx - this.cameraPos[0];
      const ddy = gy - this.cameraPos[1];
      const dist = Math.hypot(ddx, ddy);
      if (dist <= maxHorizontal) return [gx / ws, gy / ws];
    }
    if (hl < 1e-12) return [this.cx, this.cy];
    return [(this.cameraPos[0] + (hx / hl) * maxHorizontal) / ws, (this.cameraPos[1] + (hy / hl) * maxHorizontal) / ws];
  }

  unprojectLngLat(px: number, py: number): LngLat | null {
    const w = this.unproject(px, py);
    if (!w) return null;
    return [lngFromMercatorX(w[0]), latFromMercatorY(w[1])];
  }

  setLocationAtPoint(world: readonly number[], px: number, py: number, z?: number, keepSize = false): number {
    this.update();
    if (this.globeAmount > 0) return this.rotateGlobeTo(world, px, py, z, keepSize);
    for (let i = 0; i < 4; i++) {
      const now = this.unprojectClamped(px, py, z === undefined ? undefined : z * this.worldSize);
      const dx = world[0]! - now[0];
      const dy = world[1]! - now[1];
      this.setCenterWorld(this.cx + dx, this.cy + dy);
      if (this.elevationMeters === 0 || Math.abs(dx) + Math.abs(dy) < 1e-15) break;
    }
    return 0;
  }

  private rotateGlobeTo(world: readonly number[], px: number, py: number, z: number | undefined, keepSize: boolean) {
    const target = [0, 0, 0];
    unitFromMercator(world[0]!, world[1]!, target);
    const now = [0, 0, 0];
    const center = [0, 0, 0];
    const next = [0, 0, 0];
    let zoomShift = 0;
    for (let i = 0; i < 8; i++) {
      this.update();
      const hit = this.unprojectClamped(px, py, z === undefined ? undefined : z * this.worldSize);
      unitFromMercator(hit[0], hit[1], now);
      const miss = Math.hypot(now[0]! - target[0]!, now[1]! - target[1]!, now[2]! - target[2]!);
      if (miss < 1e-14) break;
      unitFromMercator(this.cx, this.cy, center);
      rotateToward(center, now, target, next);
      const [nx, ny] = mercatorFromUnit(next[0]!, next[1]!, next[2]!);
      const before = Math.cosh(Math.PI * (1 - 2 * this.cy));
      const g = this.globeAmount;
      this.setCenterWorld(nx, ny);
      if (keepSize) {
        const after = Math.cosh(Math.PI * (1 - 2 * this.cy));
        const shift = g * Math.log2(before / after);
        const zoom = this.z;
        this.setZoom(zoom + shift);
        zoomShift += this.z - zoom;
      }
      if (miss < 1e-12) break;
    }
    return zoomShift;
  }

  zoomAround(zoom: number, px: number, py: number, z?: number): void {
    const anchor = this.unproject(px, py, z === undefined ? undefined : z * this.worldSize);
    this.setZoom(zoom);
    if (anchor) this.setLocationAtPoint(anchor, px, py, z);
  }

  footprint(): [number, number][] {
    this.update();
    if (this.globeAmount > 0) return this.globeFootprint();
    const w = this.width,
      h = this.height;
    const g = this.groundPx;
    const pts: [number, number][] = [
      this.unprojectClamped(0, 0, g),
      this.unprojectClamped(w / 2, 0, g),
      this.unprojectClamped(w, 0, g),
      this.unprojectClamped(w, h, g),
      this.unprojectClamped(0, h, g),
    ];
    const top = this.peakPx;
    if (top > g + 0.5) {
      pts.push(
        this.unprojectClamped(0, 0, top),
        this.unprojectClamped(w, 0, top),
        this.unprojectClamped(w, h, top),
        this.unprojectClamped(0, h, top),
      );
    }
    return convexHull(pts);
  }

  private globeFootprint(): [number, number][] {
    const w = this.width;
    const h = this.height;
    const steps = 8;
    const pts: [number, number][] = [];
    let missed = 0;
    const add = (sx: number, sy: number) => {
      const hit = this.unproject(sx, sy);
      if (!hit) missed++;
      const p = hit ?? this.unprojectClamped(sx, sy);
      pts.push([p[0] + Math.round(this.cx - p[0]), p[1]]);
    };
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      add(w * f, 0);
      add(w, h * f);
      add(w * (1 - f), h);
      add(0, h * (1 - f));
    }
    const pole = [0, 0, 0];
    for (const y of [0, 1]) {
      unitFromMercator(this.cx, y, pole);
      const p = scratchScreen;
      const wv = this.projectGlobe(this.cx, y, 0, p);
      if (wv > 0 && p[0]! >= 0 && p[0]! <= w && p[1]! >= 0 && p[1]! <= h) {
        pts.push([this.cx - 0.5, y], [this.cx + 0.5, y]);
      }
    }
    if (missed === steps * 4 || (missed > 0 && this.globeSpan() > 0.25)) {
      return [
        [this.cx - 0.5, 0],
        [this.cx + 0.5, 0],
        [this.cx + 0.5, 1],
        [this.cx - 0.5, 1],
      ];
    }
    return convexHull(pts);
  }

  private globeSpan(): number {
    const cam = this.globeCam;
    const distance = Math.hypot(cam[0], cam[1], cam[2] + this.radius);
    return Math.acos(Math.min(1, this.radius / distance)) / Math.PI;
  }

  tileArea(z: number, x: number, y: number, wrap: number): number {
    this.update();
    const n = 2 ** z;
    const x0 = wrap + x / n;
    const y0 = y / n;
    if (this.globeAmount <= 0) {
      const a = this.project(x0, y0);
      const b = this.project(x0 + 1 / n, y0);
      const c = this.project(x0 + 1 / n, y0 + 1 / n);
      const d = this.project(x0, y0 + 1 / n);
      if (a.w <= 0 || b.w <= 0 || c.w <= 0 || d.w <= 0) return 0;
      const s = a.x * b.y - b.x * a.y + (b.x * c.y - c.x * b.y) + (c.x * d.y - d.x * c.y) + (d.x * a.y - a.x * d.y);
      return Math.abs(s) / 2;
    }
    const k = z < 3 ? 8 : 2;
    const sx = new Float64Array((k + 1) * (k + 1));
    const sy = new Float64Array((k + 1) * (k + 1));
    const ok = new Uint8Array((k + 1) * (k + 1));
    const p = scratchScreen;
    for (let j = 0; j <= k; j++) {
      for (let i = 0; i <= k; i++) {
        const idx = j * (k + 1) + i;
        ok[idx] = this.projectGlobe(x0 + i / (k * n), y0 + j / (k * n), 0, p) > 0 ? 1 : 0;
        sx[idx] = p[0]!;
        sy[idx] = p[1]!;
      }
    }
    let area = 0;
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        const a = j * (k + 1) + i;
        const b = a + 1;
        const c = b + k + 1;
        const d = a + k + 1;
        if (!ok[a] || !ok[b] || !ok[c] || !ok[d]) continue;
        const s =
          sx[a]! * sy[b]! -
          sx[b]! * sy[a]! +
          (sx[b]! * sy[c]! - sx[c]! * sy[b]!) +
          (sx[c]! * sy[d]! - sx[d]! * sy[c]!) +
          (sx[d]! * sy[a]! - sx[a]! * sy[d]!);
        area += Math.abs(s) / 2;
      }
    }
    return area;
  }

  private globeCovering(options: CoverOptions): CoveringTile[] {
    const ws = this.worldSize;
    const g = this.globeAmount;
    const R = this.radius;
    const cam = this.globeCam;
    const fwd = this.forward;
    const d = this.cameraDistance;
    const c = this.axisC;
    const e = this.axisE;
    const nAxis = this.axisN;
    const up = cam[2] + R;
    const gx = up * c[0]! + cam[0] * e[0]! - cam[1] * nAxis[0]!;
    const gy = up * c[1]! + cam[0] * e[1]! - cam[1] * nAxis[1]!;
    const gz = up * c[2]! + cam[0] * e[2]! - cam[1] * nAxis[2]!;
    const camDistance = Math.hypot(gx, gy, gz);
    const camLat = Math.asin(Math.max(-1, Math.min(1, gz / camDistance)));
    const camLng = Math.atan2(gy, gx);
    const horizon = g >= 1 ? R / camDistance : -2;
    const zoomOffset = Math.log2(TILE_SIZE / options.tileSize);
    const centerTileZoom = this.z + zoomOffset;
    const maxZoom = Math.min(options.maxZoom, MAX_TILE_ZOOM);
    const minZoom = Math.min(options.minZoom, maxZoom);
    const limit = options.maxTiles ?? 2000;
    const centerCos = 1 / Math.cosh(Math.PI * (1 - 2 * this.cy));
    const planes = frustumPlanes(this.globeMatrix);
    const nearest = [0, 0];
    const local = [0, 0, 0];
    const xs = new Float64Array(9);
    const ys = new Float64Array(9);
    const zs = new Float64Array(9);
    const out: CoveringTile[] = [];
    const stack: TileSlot[] = [{ z: 0, x: 0, y: 0, wrap: 0 }];
    while (stack.length > 0) {
      const t = stack.pop()!;
      const n = 2 ** t.z;
      const x0 = t.x / n;
      const y0 = t.y / n;
      const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y0)));
      const lat0 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y0 + 1 / n))));
      const lng0 = 2 * Math.PI * x0 - Math.PI;
      const lng1 = lng0 + (2 * Math.PI) / n;
      const best = nearestInBox(lat0, lat1, lng0, lng1, camLat, camLng, nearest);
      if (t.z >= 1 && best < horizon - 1e-6) continue;
      let k = 0;
      for (let j = 0; j <= 2; j++) {
        for (let i = 0; i <= 2; i++) {
          this.surfaceLocal(x0 + i / (2 * n), y0 + j / (2 * n), 0, local);
          xs[k] = local[0]!;
          ys[k] = local[1]!;
          zs[k] = local[2]!;
          k++;
        }
      }
      if (t.z >= 2) {
        const bulge = (g * R * (1 - Math.cos(Math.PI / n)) + 1) * 1.5;
        let outside = false;
        for (const p of planes) {
          let all = true;
          for (let s = 0; s < 9; s++) {
            if (p[0]! * xs[s]! + p[1]! * ys[s]! + p[2]! * zs[s]! + p[3]! > -bulge) {
              all = false;
              break;
            }
          }
          if (all) {
            outside = true;
            break;
          }
        }
        if (outside) continue;
      }
      let depth = Number.POSITIVE_INFINITY;
      for (let s = 0; s < 9; s++) {
        const dz = (xs[s]! - cam[0]) * fwd[0] + (ys[s]! - cam[1]) * fwd[1] + (zs[s]! - cam[2]) * fwd[2];
        if (dz < depth) depth = dz;
      }
      const nx = (nearest[1]! + Math.PI) / (2 * Math.PI);
      const ny = (1 - Math.asinh(Math.tan(nearest[0]!)) / Math.PI) / 2;
      this.surfaceLocal(nx, Math.max(0, Math.min(1, ny)), 0, local);
      const nd = (local[0]! - cam[0]) * fwd[0] + (local[1]! - cam[1]) * fwd[1] + (local[2]! - cam[2]) * fwd[2];
      if (nd < depth) depth = nd;
      depth = Math.max(this.nearZ, depth);
      const equator = lat0 <= 0 && lat1 >= 0 ? 1 : Math.cos(Math.min(Math.abs(lat0), Math.abs(lat1)));
      const wanted = centerTileZoom + Math.min(0, Math.log2(d / depth)) + g * Math.log2(equator / centerCos);
      const target = Math.max(
        minZoom,
        Math.min(maxZoom, options.round ? Math.round(wanted) : Math.floor(wanted + 1e-9)),
      );
      if (t.z >= target) {
        const mid = 4;
        out.push({
          z: t.z,
          x: t.x,
          y: t.y,
          wrap: 0,
          distance: Math.hypot(xs[mid]! - cam[0], ys[mid]! - cam[1], zs[mid]! - cam[2]),
        });
        continue;
      }
      const z = t.z + 1;
      const x = t.x * 2;
      const y = t.y * 2;
      stack.push(
        { z, x, y, wrap: 0 },
        { z, x: x + 1, y, wrap: 0 },
        { z, x, y: y + 1, wrap: 0 },
        { z, x: x + 1, y: y + 1, wrap: 0 },
      );
    }
    out.sort((a, b) => a.distance - b.distance);
    if (out.length > limit) out.length = limit;
    return out;
  }

  coveringTiles(options: CoverOptions): CoveringTile[] {
    this.update();
    if (this.globeAmount > 0) {
      const key = `${options.tileSize}/${options.minZoom}/${options.maxZoom}/${options.round}/${options.maxTiles ?? 0}`;
      let cached = this.coverCache.get(key);
      if (!cached) {
        cached = this.globeCovering(options);
        this.coverCache.set(key, cached);
      }
      return cached.slice();
    }
    const poly = this.footprint();
    if (poly.length < 3) return [];
    const ws = this.worldSize;
    const zoomOffset = Math.log2(TILE_SIZE / options.tileSize);
    const centerTileZoom = this.z + zoomOffset;
    const maxZoom = Math.min(options.maxZoom, MAX_TILE_ZOOM);
    const minZoom = Math.min(options.minZoom, maxZoom);
    const cam = this.cameraPos;
    const d = this.cameraDistance;
    const limit = options.maxTiles ?? 2000;
    const pitch = this.pitchDeg * DEG;
    const bearing = this.bearingDeg * DEG;
    const dirX = Math.sin(pitch) * Math.sin(bearing);
    const dirY = -Math.sin(pitch) * Math.cos(bearing);
    const baseDepth = (cam[2] - this.peakPx) * Math.cos(pitch);
    const minDepth = this.nearZ;
    let minX = Infinity,
      maxX = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
    }
    const wraps: number[] = [];
    if (this.renderWorldCopies) {
      for (let wv = Math.floor(minX); wv <= Math.floor(maxX - 1e-12); wv++) wraps.push(wv);
    } else {
      wraps.push(0);
    }
    const out: CoveringTile[] = [];
    const stack: TileSlot[] = wraps.map((wrap) => ({ z: 0, x: 0, y: 0, wrap }));
    while (stack.length > 0) {
      const t = stack.pop()!;
      const n = 2 ** t.z;
      const x0 = t.wrap + t.x / n,
        x1 = t.wrap + (t.x + 1) / n;
      const y0 = t.y / n,
        y1 = (t.y + 1) / n;
      if (!polygonIntersectsRect(poly, x0, y0, x1, y1)) continue;
      const nearX = (dirX >= 0 ? x0 : x1) * ws - cam[0];
      const nearY = (dirY >= 0 ? y0 : y1) * ws - cam[1];
      const depth = Math.max(minDepth, nearX * dirX + nearY * dirY + baseDepth);
      const wanted = Math.min(centerTileZoom, centerTileZoom + Math.log2(d / depth));
      const target = Math.max(
        minZoom,
        Math.min(maxZoom, options.round ? Math.round(wanted) : Math.floor(wanted + 1e-9)),
      );
      if (t.z >= target) {
        const cxw = ((x0 + x1) / 2) * ws - cam[0];
        const cyw = ((y0 + y1) / 2) * ws - cam[1];
        out.push({ z: t.z, x: t.x, y: t.y, wrap: t.wrap, distance: Math.hypot(cxw, cyw, cam[2] - this.groundPx) });
        continue;
      }
      const z = t.z + 1,
        x = t.x * 2,
        y = t.y * 2;
      stack.push(
        { z, x, y, wrap: t.wrap },
        { z, x: x + 1, y, wrap: t.wrap },
        { z, x, y: y + 1, wrap: t.wrap },
        { z, x: x + 1, y: y + 1, wrap: t.wrap },
      );
    }
    out.sort((a, b) => a.distance - b.distance);
    if (out.length > limit) out.length = limit;
    return out;
  }
}

const scratchMatrix: Mat4 = mat4.create();

export function convexHull(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonIntersectsRect(
  poly: [number, number][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  let pminX = Infinity,
    pmaxX = -Infinity,
    pminY = Infinity,
    pmaxY = -Infinity;
  for (const p of poly) {
    if (p[0] < pminX) pminX = p[0];
    if (p[0] > pmaxX) pmaxX = p[0];
    if (p[1] < pminY) pminY = p[1];
    if (p[1] > pmaxY) pmaxY = p[1];
  }
  if (pmaxX < x0 || pminX > x1 || pmaxY < y0 || pminY > y1) return false;
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const nx = b[1] - a[1];
    const ny = a[0] - b[0];
    let pMin = Infinity,
      pMax = -Infinity;
    for (const p of poly) {
      const v = p[0] * nx + p[1] * ny;
      if (v < pMin) pMin = v;
      if (v > pMax) pMax = v;
    }
    let rMin = Infinity,
      rMax = -Infinity;
    for (const c of corners) {
      const v = c[0] * nx + c[1] * ny;
      if (v < rMin) rMin = v;
      if (v > rMax) rMax = v;
    }
    if (rMax < pMin || rMin > pMax) return false;
  }
  return true;
}

function multiply3(a: readonly number[][], b: readonly number[][]): number[][] {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r]![c] = a[r]![0]! * b[0]![c]! + a[r]![1]! * b[1]![c]! + a[r]![2]! * b[2]![c]!;
  }
  return out;
}

function invert3(m: readonly number[][]): number[][] {
  const [a, b, c] = m[0]!;
  const [d, e, f] = m[1]!;
  const [g, h, i] = m[2]!;
  const A = e! * i! - f! * h!;
  const B = f! * g! - d! * i!;
  const C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  const k = det !== 0 ? 1 / det : 0;
  return [
    [A * k, (c! * h! - b! * i!) * k, (b! * f! - c! * e!) * k],
    [B * k, (a! * i! - c! * g!) * k, (c! * d! - a! * f!) * k],
    [C * k, (b! * g! - a! * h!) * k, (a! * e! - b! * d!) * k],
  ];
}
