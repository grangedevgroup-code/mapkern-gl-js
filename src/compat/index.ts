import * as native from "../index.ts";
import { version } from "../index.ts";
import { LngLat, LngLatBounds, MercatorCoordinate, Point } from "./geo.ts";
import { CompatMap, defaults } from "./map.ts";
import { addProtocol, removeProtocol } from "./protocol.ts";
import {
  AttributionControl,
  FullscreenControl,
  GeolocateControl,
  GlobeControl,
  LogoControl,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  TerrainControl,
} from "./ui.ts";

type Handler = (event: never) => void;

export class Evented {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(type: string, listener: Handler): this {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(listener);
    return this;
  }

  off(type: string, listener: Handler): this {
    this.handlers.get(type)?.delete(listener);
    return this;
  }

  once(type: string, listener?: Handler): this | Promise<unknown> {
    if (!listener) return new Promise((resolve) => this.once(type, resolve as Handler));
    const wrapper: Handler = (event) => {
      this.off(type, wrapper);
      listener(event);
    };
    return this.on(type, wrapper);
  }

  fire(event: string | { type: string }, properties?: Record<string, unknown>): this {
    const e = typeof event === "string" ? { ...(properties ?? {}), type: event } : { ...event };
    (e as Record<string, unknown>).target = this;
    for (const listener of [...(this.handlers.get(e.type) ?? [])]) listener.call(this, e as never);
    return this;
  }

  listens(type: string): boolean {
    return (this.handlers.get(type)?.size ?? 0) > 0;
  }
}

let workerUrl = "";

export function setRTLTextPlugin(_url?: string, _lazy?: boolean): Promise<void> {
  return Promise.resolve();
}

export function getRTLTextPluginStatus(): string {
  return "loaded";
}

export function prewarm(): void {}

export function clearPrewarmedResources(): void {}

export function setWorkerUrl(url: string): void {
  workerUrl = url;
}

export function getWorkerUrl(): string {
  return workerUrl;
}

export function setWorkerCount(count: number): void {
  defaults.workerCount = Math.max(0, Math.floor(count));
}

export function getWorkerCount(): number {
  return defaults.workerCount || Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));
}

export function setMaxParallelImageRequests(count: number): void {
  defaults.maxParallelImageRequests = Math.max(0, Math.floor(count));
}

export function getMaxParallelImageRequests(): number {
  return defaults.maxParallelImageRequests || 24;
}

export function importScriptInWorkers(_url: string): Promise<void> {
  return Promise.reject(new Error("Mapkern's workers can't load extra scripts"));
}

export function addSourceType(name: string): Promise<void> {
  return Promise.reject(new Error(`Mapkern can't add a source type "${name}"; use addProtocol for custom tiles`));
}

export function supported(): boolean {
  try {
    return typeof document !== "undefined" && document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

export function getVersion(): string {
  return version;
}

export {
  AttributionControl,
  addProtocol,
  CompatMap as Map,
  FullscreenControl,
  GeolocateControl,
  GlobeControl,
  LngLat,
  LngLatBounds,
  LogoControl,
  Marker,
  MercatorCoordinate,
  NavigationControl,
  native as mapkern,
  Point,
  Popup,
  removeProtocol,
  ScaleControl,
  TerrainControl,
  version,
};

export const config = { MAX_PARALLEL_IMAGE_REQUESTS: 16 };

const namespace: Record<string, unknown> = {
  AttributionControl,
  Evented,
  FullscreenControl,
  GeolocateControl,
  GlobeControl,
  LngLat,
  LngLatBounds,
  LogoControl,
  Map: CompatMap,
  Marker,
  MercatorCoordinate,
  NavigationControl,
  Point,
  Popup,
  ScaleControl,
  TerrainControl,
  addProtocol,
  addSourceType,
  clearPrewarmedResources,
  config,
  getMaxParallelImageRequests,
  getRTLTextPluginStatus,
  getVersion,
  getWorkerCount,
  getWorkerUrl,
  importScriptInWorkers,
  mapkern: native,
  prewarm,
  removeProtocol,
  setMaxParallelImageRequests,
  setRTLTextPlugin,
  setWorkerCount,
  setWorkerUrl,
  supported,
  version,
};

export default namespace;
