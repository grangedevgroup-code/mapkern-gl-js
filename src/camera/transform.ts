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

  get near(): number {
    this.update();
    return this.nearZ;
  }

  get far(): number {
    this.update();
    return this.farZ;
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

  clone(): Transform {
    const t = new Transform();
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
    if (!this.keepInWorld) return this.minZoom;
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
    const ws = this.worldSize;
    const p = mat4.transformVec4(this.tmp, this.pixelMatrix, x * ws, y * ws, zPixels, 1);
    const w = p[3];
    return { x: ((p[0] / w + 1) / 2) * this.width, y: ((1 - p[1] / w) / 2) * this.height, w };
  }

  projectTo(out: Float64Array, x: number, y: number, zPixels = 0): number {
    this.update();
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
    const { origin, dir } = this.screenRay(px, py);
    if (dir[2] >= -1e-12) return null;
    const t = ((groundZ ?? this.elevationPx) - origin[2]) / dir[2];
    if (t < 0) return null;
    const ws = this.worldSize;
    return [(origin[0] + dir[0] * t) / ws, (origin[1] + dir[1] * t) / ws];
  }

  unprojectClamped(px: number, py: number, groundZ?: number): [number, number] {
    this.update();
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

  setLocationAtPoint(world: readonly number[], px: number, py: number, z?: number): void {
    for (let i = 0; i < 4; i++) {
      const now = this.unprojectClamped(px, py, z === undefined ? undefined : z * this.worldSize);
      const dx = world[0]! - now[0];
      const dy = world[1]! - now[1];
      this.setCenterWorld(this.cx + dx, this.cy + dy);
      if (this.elevationMeters === 0 || Math.abs(dx) + Math.abs(dy) < 1e-15) break;
    }
  }

  zoomAround(zoom: number, px: number, py: number, z?: number): void {
    const anchor = this.unproject(px, py, z === undefined ? undefined : z * this.worldSize);
    this.setZoom(zoom);
    if (anchor) this.setLocationAtPoint(anchor, px, py, z);
  }

  footprint(): [number, number][] {
    this.update();
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

  coveringTiles(options: CoverOptions): CoveringTile[] {
    this.update();
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
