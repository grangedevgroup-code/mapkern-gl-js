import type { MapkernMap } from "./map.ts";

export interface HashPosition {
  zoom: number;
  center: [number, number];
  bearing: number;
  pitch: number;
}

export function formatHash(position: HashPosition): string {
  const { zoom, center, bearing, pitch } = position;
  const digits = Math.max(0, Math.ceil(Math.log10((512 * 2 ** zoom) / 360) + 0.3));
  const round = (v: number, d: number) => {
    const text = v.toFixed(d);
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  };
  const parts = [round(zoom, 2), round(center[1], digits), round(center[0], digits)];
  if (bearing !== 0 || pitch !== 0) parts.push(round(bearing, 1));
  if (pitch !== 0) parts.push(round(pitch, 0));
  return parts.join("/");
}

export function parseHash(value: string): HashPosition | null {
  const parts = value.split("/").map(Number);
  if (parts.length < 3 || parts.length > 5 || parts.some((n) => !Number.isFinite(n))) return null;
  const [zoom, lat, lng, bearing = 0, pitch = 0] = parts as [number, number, number, number?, number?];
  if (lat < -90 || lat > 90) return null;
  return { zoom, center: [lng, lat], bearing, pitch };
}

export function readHash(hash: string, name: string | null): string | null {
  const body = hash.replace(/^#/, "");
  if (name === null) return body.includes("=") ? null : body || null;
  for (const pair of body.split("&")) {
    const at = pair.indexOf("=");
    if (at > 0 && decodeURIComponent(pair.slice(0, at)) === name) return decodeURIComponent(pair.slice(at + 1));
  }
  return null;
}

export function writeHash(hash: string, name: string | null, value: string): string {
  if (name === null) return `#${value}`;
  const body = hash.replace(/^#/, "");
  const pairs = body ? body.split("&") : [];
  const key = encodeURIComponent(name);
  let found = false;
  const next = pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at > 0 && decodeURIComponent(pair.slice(0, at)) === name) {
      found = true;
      return `${key}=${value}`;
    }
    return pair;
  });
  if (!found) next.unshift(`${key}=${value}`);
  return `#${next.join("&")}`;
}

export class MapHash {
  private readonly map: MapkernMap;
  private readonly name: string | null;
  private readonly view: Window;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private written = "";

  constructor(map: MapkernMap, name: string | null) {
    this.map = map;
    this.name = name;
    this.view = map.getContainer().ownerDocument.defaultView ?? window;
    this.view.addEventListener("hashchange", this.onHashChange);
    map.on("moveend", this.onMoveEnd);
  }

  read(): HashPosition | null {
    const value = readHash(this.view.location.hash, this.name);
    return value === null ? null : parseHash(value);
  }

  destroy(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.view.removeEventListener("hashchange", this.onHashChange);
    this.map.off("moveend", this.onMoveEnd);
  }

  private readonly onMoveEnd = (): void => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, 250);
  };

  private write(): void {
    const map = this.map;
    const value = formatHash({
      zoom: map.getZoom(),
      center: map.getCenter(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    });
    const hash = writeHash(this.view.location.hash, this.name, value);
    if (hash === this.view.location.hash) return;
    this.written = hash;
    try {
      this.view.history.replaceState(this.view.history.state, "", hash);
    } catch {
      this.view.location.hash = hash;
    }
  }

  private readonly onHashChange = (): void => {
    if (this.view.location.hash === this.written) return;
    const position = this.read();
    if (!position) return;
    this.map.jumpTo(position);
  };
}
