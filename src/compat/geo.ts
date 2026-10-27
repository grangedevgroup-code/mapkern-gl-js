const EARTH_RADIUS = 6371008.8;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
const DEG = Math.PI / 180;

export type PointLike = Point | [number, number] | { x: number; y: number };

export class Point {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  clone(): Point {
    return new Point(this.x, this.y);
  }

  add(p: { x: number; y: number }): Point {
    return this.clone()._add(p);
  }

  sub(p: { x: number; y: number }): Point {
    return this.clone()._sub(p);
  }

  multByPoint(p: { x: number; y: number }): Point {
    return this.clone()._multByPoint(p);
  }

  divByPoint(p: { x: number; y: number }): Point {
    return this.clone()._divByPoint(p);
  }

  mult(k: number): Point {
    return this.clone()._mult(k);
  }

  div(k: number): Point {
    return this.clone()._div(k);
  }

  rotate(angle: number): Point {
    return this.clone()._rotate(angle);
  }

  rotateAround(angle: number, p: { x: number; y: number }): Point {
    return this.clone()._rotateAround(angle, p);
  }

  matMult(m: readonly number[]): Point {
    return this.clone()._matMult(m);
  }

  unit(): Point {
    return this.clone()._unit();
  }

  perp(): Point {
    return this.clone()._perp();
  }

  round(): Point {
    return this.clone()._round();
  }

  mag(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  equals(other: { x: number; y: number }): boolean {
    return this.x === other.x && this.y === other.y;
  }

  dist(p: { x: number; y: number }): number {
    return Math.sqrt(this.distSqr(p));
  }

  distSqr(p: { x: number; y: number }): number {
    const dx = p.x - this.x;
    const dy = p.y - this.y;
    return dx * dx + dy * dy;
  }

  angle(): number {
    return Math.atan2(this.y, this.x);
  }

  angleTo(b: { x: number; y: number }): number {
    return Math.atan2(this.y - b.y, this.x - b.x);
  }

  angleWith(b: { x: number; y: number }): number {
    return this.angleWithSep(b.x, b.y);
  }

  angleWithSep(x: number, y: number): number {
    return Math.atan2(this.x * y - this.y * x, this.x * x + this.y * y);
  }

  _matMult(m: readonly number[]): this {
    const x = m[0]! * this.x + m[1]! * this.y;
    const y = m[2]! * this.x + m[3]! * this.y;
    this.x = x;
    this.y = y;
    return this;
  }

  _add(p: { x: number; y: number }): this {
    this.x += p.x;
    this.y += p.y;
    return this;
  }

  _sub(p: { x: number; y: number }): this {
    this.x -= p.x;
    this.y -= p.y;
    return this;
  }

  _mult(k: number): this {
    this.x *= k;
    this.y *= k;
    return this;
  }

  _div(k: number): this {
    this.x /= k;
    this.y /= k;
    return this;
  }

  _multByPoint(p: { x: number; y: number }): this {
    this.x *= p.x;
    this.y *= p.y;
    return this;
  }

  _divByPoint(p: { x: number; y: number }): this {
    this.x /= p.x;
    this.y /= p.y;
    return this;
  }

  _unit(): this {
    return this._div(this.mag());
  }

  _perp(): this {
    const y = this.y;
    this.y = this.x;
    this.x = -y;
    return this;
  }

  _rotate(angle: number): this {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = cos * this.x - sin * this.y;
    const y = sin * this.x + cos * this.y;
    this.x = x;
    this.y = y;
    return this;
  }

  _rotateAround(angle: number, p: { x: number; y: number }): this {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = p.x + cos * (this.x - p.x) - sin * (this.y - p.y);
    const y = p.y + sin * (this.x - p.x) + cos * (this.y - p.y);
    this.x = x;
    this.y = y;
    return this;
  }

  _round(): this {
    this.x = Math.round(this.x);
    this.y = Math.round(this.y);
    return this;
  }

  static convert(value: PointLike): Point {
    if (value instanceof Point) return value;
    if (Array.isArray(value)) return new Point(Number(value[0]), Number(value[1]));
    if (value && typeof value.x === "number" && typeof value.y === "number") return new Point(value.x, value.y);
    throw new Error("A point must be a Point, an [x, y] array or an { x, y } object");
  }
}

export type LngLatLike =
  | LngLat
  | readonly [number, number]
  | { lng: number; lat: number }
  | { lon: number; lat: number };

export function wrap(n: number, min: number, max: number): number {
  const d = max - min;
  const w = ((((n - min) % d) + d) % d) + min;
  return w === min ? max : w;
}

export class LngLat {
  lng: number;
  lat: number;

  constructor(lng: number, lat: number) {
    if (Number.isNaN(lng) || Number.isNaN(lat)) throw new Error(`Invalid LngLat object: (${lng}, ${lat})`);
    this.lng = +lng;
    this.lat = +lat;
    if (this.lat > 90 || this.lat < -90)
      throw new Error("Invalid LngLat latitude value: it must be between -90 and 90");
  }

  wrap(): LngLat {
    return new LngLat(wrap(this.lng, -180, 180), this.lat);
  }

  toArray(): [number, number] {
    return [this.lng, this.lat];
  }

  toString(): string {
    return `LngLat(${this.lng}, ${this.lat})`;
  }

  distanceTo(other: LngLatLike): number {
    const b = LngLat.convert(other);
    const lat1 = this.lat * DEG;
    const lat2 = b.lat * DEG;
    const a = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos((b.lng - this.lng) * DEG);
    return EARTH_RADIUS * Math.acos(Math.min(a, 1));
  }

  toBounds(radius = 0): LngLatBounds {
    return LngLatBounds.fromLngLat(this, radius);
  }

  static convert(value: LngLatLike): LngLat {
    if (value instanceof LngLat) return value;
    if (Array.isArray(value) && (value.length === 2 || value.length === 3)) {
      return new LngLat(Number(value[0]), Number(value[1]));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as { lng?: unknown; lon?: unknown; lat?: unknown };
      const lng = v.lng !== undefined ? v.lng : v.lon;
      if (lng !== undefined && v.lat !== undefined) return new LngLat(Number(lng), Number(v.lat));
    }
    throw new Error("A LngLatLike must be a LngLat, an { lng, lat } or { lon, lat } object, or an array of [lng, lat]");
  }
}

export type LngLatBoundsLike =
  | LngLatBounds
  | readonly [LngLatLike, LngLatLike]
  | readonly [number, number, number, number];

export class LngLatBounds {
  _sw!: LngLat;
  _ne!: LngLat;

  constructor(
    sw?: LngLatLike | readonly [number, number, number, number] | readonly [LngLatLike, LngLatLike],
    ne?: LngLatLike,
  ) {
    if (sw === undefined || sw === null) return;
    if (ne !== undefined) {
      this.setSouthWest(sw as LngLatLike).setNorthEast(ne);
    } else if (Array.isArray(sw)) {
      if (sw.length === 4) {
        this.setSouthWest([sw[0] as number, sw[1] as number]).setNorthEast([sw[2] as number, sw[3] as number]);
      } else {
        this.setSouthWest(sw[0] as LngLatLike).setNorthEast(sw[1] as LngLatLike);
      }
    }
  }

  setNorthEast(ne: LngLatLike): this {
    this._ne = ne instanceof LngLat ? new LngLat(ne.lng, ne.lat) : LngLat.convert(ne);
    return this;
  }

  setSouthWest(sw: LngLatLike): this {
    this._sw = sw instanceof LngLat ? new LngLat(sw.lng, sw.lat) : LngLat.convert(sw);
    return this;
  }

  extend(obj: LngLatLike | LngLatBoundsLike | null | undefined): this {
    if (obj === null || obj === undefined) return this;
    let sw: LngLat;
    let ne: LngLat;
    if (obj instanceof LngLat) {
      sw = obj;
      ne = obj;
    } else if (obj instanceof LngLatBounds) {
      if (!obj._sw || !obj._ne) return this;
      sw = obj._sw;
      ne = obj._ne;
    } else if (Array.isArray(obj)) {
      if (obj.length === 4 || (obj as unknown[]).every(Array.isArray)) {
        return this.extend(LngLatBounds.convert(obj as LngLatBoundsLike));
      }
      return this.extend(LngLat.convert(obj as unknown as LngLatLike));
    } else if (typeof obj === "object") {
      return this.extend(LngLat.convert(obj as LngLatLike));
    } else {
      return this;
    }
    if (!this._sw && !this._ne) {
      this._sw = new LngLat(sw.lng, sw.lat);
      this._ne = new LngLat(ne.lng, ne.lat);
    } else {
      this._sw.lng = Math.min(sw.lng, this._sw.lng);
      this._sw.lat = Math.min(sw.lat, this._sw.lat);
      this._ne.lng = Math.max(ne.lng, this._ne.lng);
      this._ne.lat = Math.max(ne.lat, this._ne.lat);
    }
    return this;
  }

  getCenter(): LngLat {
    return new LngLat((this._sw.lng + this._ne.lng) / 2, (this._sw.lat + this._ne.lat) / 2);
  }

  getSouthWest(): LngLat {
    return this._sw;
  }

  getNorthEast(): LngLat {
    return this._ne;
  }

  getNorthWest(): LngLat {
    return new LngLat(this.getWest(), this.getNorth());
  }

  getSouthEast(): LngLat {
    return new LngLat(this.getEast(), this.getSouth());
  }

  getWest(): number {
    return this._sw.lng;
  }

  getSouth(): number {
    return this._sw.lat;
  }

  getEast(): number {
    return this._ne.lng;
  }

  getNorth(): number {
    return this._ne.lat;
  }

  toArray(): [[number, number], [number, number]] {
    return [this._sw.toArray(), this._ne.toArray()];
  }

  toString(): string {
    return `LngLatBounds(${this._sw.toString()}, ${this._ne.toString()})`;
  }

  isEmpty(): boolean {
    return !(this._sw && this._ne);
  }

  contains(lnglat: LngLatLike): boolean {
    const { lng, lat } = LngLat.convert(lnglat);
    if (lat < this._sw.lat || lat > this._ne.lat) return false;
    if (this._sw.lng <= this._ne.lng) return lng >= this._sw.lng && lng <= this._ne.lng;
    return lng >= this._sw.lng || lng <= this._ne.lng;
  }

  intersects(other: LngLatBoundsLike): boolean {
    const b = LngLatBounds.convert(other);
    if (b.getNorth() < this.getSouth() || b.getSouth() > this.getNorth()) return false;
    const span = (w: number, e: number): [number, number] => (w <= e ? [w, e] : [w, e + 360]);
    const [aw, ae] = span(this.getWest(), this.getEast());
    const [bw, be] = span(b.getWest(), b.getEast());
    for (const shift of [-360, 0, 360]) if (bw + shift <= ae && be + shift >= aw) return true;
    return false;
  }

  adjustAntiMeridian(): LngLatBounds {
    const sw = new LngLat(this._sw.lng, this._sw.lat);
    const ne = new LngLat(this._ne.lng, this._ne.lat);
    if (sw.lng > ne.lng) ne.lng += 360;
    return new LngLatBounds(sw, ne);
  }

  static convert(value: LngLatBoundsLike | null | undefined): LngLatBounds {
    if (value instanceof LngLatBounds) return value;
    if (!value) return value as unknown as LngLatBounds;
    return new LngLatBounds(value as readonly [LngLatLike, LngLatLike]);
  }

  static fromLngLat(center: LngLatLike, radius = 0): LngLatBounds {
    const c = LngLat.convert(center);
    const latAccuracy = (360 * radius) / EARTH_CIRCUMFERENCE;
    const lngAccuracy = latAccuracy / Math.cos(DEG * c.lat);
    return new LngLatBounds(
      new LngLat(c.lng - lngAccuracy, c.lat - latAccuracy),
      new LngLat(c.lng + lngAccuracy, c.lat + latAccuracy),
    );
  }
}

function circumferenceAt(lat: number): number {
  return EARTH_CIRCUMFERENCE * Math.cos(lat * DEG);
}

export function mercatorXFromLng(lng: number): number {
  return (180 + lng) / 360;
}

export function mercatorYFromLat(lat: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}

export function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

export class MercatorCoordinate {
  x: number;
  y: number;
  z: number;

  constructor(x: number, y: number, z = 0) {
    this.x = +x;
    this.y = +y;
    this.z = +z;
  }

  static fromLngLat(lngLatLike: LngLatLike, altitude = 0): MercatorCoordinate {
    const ll = LngLat.convert(lngLatLike);
    return new MercatorCoordinate(
      mercatorXFromLng(ll.lng),
      mercatorYFromLat(ll.lat),
      altitude / circumferenceAt(ll.lat),
    );
  }

  toLngLat(): LngLat {
    return new LngLat(lngFromMercatorX(this.x), latFromMercatorY(this.y));
  }

  toAltitude(): number {
    return this.z * circumferenceAt(latFromMercatorY(this.y));
  }

  meterInMercatorCoordinateUnits(): number {
    return 1 / circumferenceAt(latFromMercatorY(this.y));
  }
}

export const COMPAT_EARTH_CIRCUMFERENCE = EARTH_CIRCUMFERENCE;

export function lngLatTuple(value: LngLatLike): [number, number] {
  const ll = LngLat.convert(value);
  return [ll.lng, ll.lat];
}

export function boundsTuple(value: LngLatBoundsLike): [[number, number], [number, number]] {
  const b = LngLatBounds.convert(value);
  return [
    [b.getWest(), b.getSouth()],
    [b.getEast(), b.getNorth()],
  ];
}
