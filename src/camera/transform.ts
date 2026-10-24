import type { Mat4, Vec4 } from "../geo/mat4.ts";
import * as mat4 from "../geo/mat4.ts";
import type { LngLat } from "../geo/mercator.ts";
import {
  clampLatitude,
  latFromMercatorY,
  lngFromMercatorX,
  mercatorX,
  mercatorY,
  TILE_SIZE,
  worldSize,
} from "../geo/mercator.ts";
import type { TileSlot } from "../geo/tile.ts";
import { MAX_TILE_ZOOM } from "../geo/tile.ts";

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
  readonly fov = DEFAULT_FOV;

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

  get far(): number {
    this.update();
    return this.farZ;
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
    t.cx = this.cx;
    t.cy = this.cy;
    t.z = this.z;
    t.bearingDeg = this.bearingDeg;
    t.pitchDeg = this.pitchDeg;
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
  }

  setZoom(zoom: number): void {
    if (!Number.isFinite(zoom)) return;
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    if (z === this.z) return;
    this.z = z;
    this.dirty = true;
  }

  setBearing(bearing: number): void {
    if (!Number.isFinite(bearing)) return;
    let b = ((bearing % 360) + 360) % 360;
    if (b > 180) b -= 360;
    if (b === this.bearingDeg) return;
    this.bearingDeg = b;
    this.dirty = true;
  }

  setPitch(pitch: number): void {
    if (!Number.isFinite(pitch)) return;
    const p = Math.min(this.maxPitch, Math.max(this.minPitch, pitch));
    if (p === this.pitchDeg) return;
    this.pitchDeg = p;
    this.dirty = true;
  }

  setZoomRange(minZoom: number, maxZoom: number): void {
    this.minZoom = Math.max(0, Math.min(minZoom, maxZoom));
    this.maxZoom = Math.min(MAX_TILE_ZOOM, Math.max(minZoom, maxZoom));
    this.setZoom(this.z);
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
    const camHeight = d * Math.cos(pitch);
    const topAngle = Math.min(pitch + fovRad / 2, MAX_GROUND_ANGLE);
    const groundAlongTopRay = camHeight / Math.cos(topAngle);
    const farDepth = groundAlongTopRay * Math.cos(fovRad / 2);
    this.farZ = farDepth * 1.01 + 1;
    this.nearZ = Math.max(d / 100, 0.01);
    mat4.perspective(this.projMatrix, fovRad, this.width / this.height, this.nearZ, this.farZ);
    const v = this.viewMatrix;
    mat4.identity(v);
    mat4.translate(v, v, 0, 0, -d);
    mat4.rotateX(v, v, -pitch);
    mat4.rotateZ(v, v, this.bearingDeg * DEG);
    mat4.scale(v, v, 1, -1, 1);
    mat4.translate(v, v, -this.cx * ws, -this.cy * ws, 0);
    mat4.multiply(this.pixelMatrix, this.projMatrix, v);
    mat4.invert(this.pixelMatrixInverse, this.pixelMatrix);
    mat4.scale(this.unitMatrix, this.pixelMatrix, ws, ws, 1);
    const bearing = this.bearingDeg * DEG;
    const horizontal = d * Math.sin(pitch);
    this.cameraPos = [
      this.cx * ws - Math.sin(bearing) * horizontal,
      this.cy * ws + Math.cos(bearing) * horizontal,
      camHeight,
    ];
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

  unproject(px: number, py: number, groundZ = 0): [number, number] | null {
    const { origin, dir } = this.screenRay(px, py);
    if (dir[2] >= -1e-12) return null;
    const t = (groundZ - origin[2]) / dir[2];
    if (t < 0) return null;
    const ws = this.worldSize;
    return [(origin[0] + dir[0] * t) / ws, (origin[1] + dir[1] * t) / ws];
  }

  unprojectClamped(px: number, py: number): [number, number] {
    this.update();
    const { origin, dir } = this.screenRay(px, py);
    const ws = this.worldSize;
    const camHeight = this.cameraPos[2];
    const maxHorizontal = camHeight * Math.tan(MAX_GROUND_ANGLE);
    const hx = dir[0],
      hy = dir[1];
    const hl = Math.hypot(hx, hy);
    if (dir[2] < -1e-12) {
      const t = -origin[2] / dir[2];
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

  setLocationAtPoint(world: [number, number], px: number, py: number): void {
    const now = this.unprojectClamped(px, py);
    this.setCenterWorld(this.cx + world[0] - now[0], this.cy + world[1] - now[1]);
  }

  zoomAround(zoom: number, px: number, py: number): void {
    const anchor = this.unproject(px, py);
    this.setZoom(zoom);
    if (anchor) this.setLocationAtPoint(anchor, px, py);
  }

  footprint(): [number, number][] {
    this.update();
    const w = this.width,
      h = this.height;
    const pts: [number, number][] = [
      this.unprojectClamped(0, 0),
      this.unprojectClamped(w / 2, 0),
      this.unprojectClamped(w, 0),
      this.unprojectClamped(w, h),
      this.unprojectClamped(0, h),
    ];
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
    const baseDepth = cam[2] * Math.cos(pitch);
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
        out.push({ z: t.z, x: t.x, y: t.y, wrap: t.wrap, distance: Math.hypot(cxw, cyw, cam[2]) });
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
