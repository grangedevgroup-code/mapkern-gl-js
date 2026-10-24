import { MapletError } from "../core/errors.ts";
import {
  clampLatitude,
  EARTH_CIRCUMFERENCE,
  latFromMercatorY,
  lngFromMercatorX,
  mercatorX,
  mercatorY,
} from "../geo/mercator.ts";
import type { Rect } from "../geo/tile.ts";
import { MAX_TILE_ZOOM, quadkey, tmsY } from "../geo/tile.ts";
import type { TileSourceBase } from "../style/types.ts";
import type { TransformRequest } from "../tiles/fetch.ts";
import { expandTemplate, fetchBytes, resolveRequest } from "../tiles/fetch.ts";

export interface VectorLayerInfo {
  id: string;
  fields: Record<string, string>;
  minZoom?: number;
  maxZoom?: number;
}

export interface TileSet {
  tiles: string[];
  minZoom: number;
  maxZoom: number;
  bounds: Rect | null;
  scheme: "xyz" | "tms";
  attribution: string | undefined;
  vectorLayers: VectorLayerInfo[];
  raw: Record<string, unknown>;
}

export interface TileSetDefaults {
  minZoom: number;
  maxZoom: number;
}

export function archiveSpec<T extends TileSourceBase>(spec: T): T {
  const url = spec.url;
  const m = url ? /\.(pmtiles|mbtiles)(\?|#|$)/i.exec(url) : null;
  if (!url || !m || /^(pmtiles|mbtiles):\/\//i.test(url)) return spec;
  return { ...spec, url: `${m[1]!.toLowerCase()}://${absoluteUrl(url)}` };
}

export function absoluteUrl(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
}

export async function resolveTileSet(
  sourceId: string,
  spec: TileSourceBase,
  defaults: TileSetDefaults,
  transformRequest: TransformRequest | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<TileSet> {
  let raw: Record<string, unknown> = {};
  let base: string | undefined;
  if (spec.url) {
    const params = resolveRequest(spec.url, "source", transformRequest);
    const result = await fetchBytes(params, signal, timeoutMs, "source").catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new MapletError(
        "source-error",
        `Could not load TileJSON for source "${sourceId}" from ${spec.url}`,
        { sourceId },
        error,
      );
    });
    if (result.kind === "empty") {
      throw new MapletError("source-error", `TileJSON for source "${sourceId}" was not found at ${spec.url}`, {
        sourceId,
      });
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(result.data));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      raw = parsed as Record<string, unknown>;
    } catch (error) {
      throw new MapletError("source-error", `TileJSON for source "${sourceId}" is not valid JSON`, { sourceId }, error);
    }
    base = params.url;
  }
  const tilesValue = spec.tiles ?? raw.tiles;
  if (!Array.isArray(tilesValue) || tilesValue.length === 0 || !tilesValue.every((t) => typeof t === "string")) {
    throw new MapletError("source-error", `Source "${sourceId}" needs a non-empty "tiles" list of URL templates`, {
      sourceId,
    });
  }
  const tiles = (tilesValue as string[]).map((t) => absolutize(t, base));
  const minZoom = zoomValue(spec.minZoom ?? raw.minzoom, defaults.minZoom);
  const maxZoom = Math.max(minZoom, zoomValue(spec.maxZoom ?? raw.maxzoom, defaults.maxZoom));
  const boundsValue = spec.bounds ?? raw.bounds;
  const scheme = (spec.scheme ?? raw.scheme) === "tms" ? "tms" : "xyz";
  const attribution =
    typeof spec.attribution === "string"
      ? spec.attribution
      : typeof raw.attribution === "string"
        ? raw.attribution
        : undefined;
  const vectorLayers: VectorLayerInfo[] = [];
  if (Array.isArray(raw.vector_layers)) {
    for (const layer of raw.vector_layers) {
      if (typeof layer !== "object" || layer === null) continue;
      const l = layer as Record<string, unknown>;
      if (typeof l.id !== "string") continue;
      const info: VectorLayerInfo = { id: l.id, fields: {} };
      if (typeof l.fields === "object" && l.fields !== null) {
        for (const [k, v] of Object.entries(l.fields)) info.fields[k] = String(v);
      }
      if (typeof l.minzoom === "number") info.minZoom = l.minzoom;
      if (typeof l.maxzoom === "number") info.maxZoom = l.maxzoom;
      vectorLayers.push(info);
    }
  }
  return { tiles, minZoom, maxZoom, bounds: boundsRect(boundsValue), scheme, attribution, vectorLayers, raw };
}

function zoomValue(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_TILE_ZOOM, Math.round(value)));
}

function absolutize(url: string, base: string | undefined): string {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!/^https?:/i.test(base) && !/^[./]/.test(base)) return url;
  try {
    const encoded = url.replace(/\{/g, "%7B").replace(/\}/g, "%7D");
    return new URL(encoded, new URL(base, globalThis.location?.href)).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  } catch {
    return url;
  }
}

export function lngLatBounds(set: TileSet | null): [number, number, number, number] | null {
  const b = set?.bounds;
  if (!b) return null;
  return [lngFromMercatorX(b.x0), latFromMercatorY(b.y1), lngFromMercatorX(b.x1), latFromMercatorY(b.y0)];
}

export function boundsRect(value: unknown): Rect | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return null;
  }
  const [w, s, e, n] = value as number[];
  if (w! >= e! || s! >= n!) return null;
  if (w! <= -180 && e! >= 180 && s! <= -85 && n! >= 85) return null;
  return {
    x0: mercatorX(Math.max(-180, w!)),
    x1: mercatorX(Math.min(180, e!)),
    y0: mercatorY(clampLatitude(n!)),
    y1: mercatorY(clampLatitude(s!)),
  };
}

export function tileUrl(set: TileSet, z: number, x: number, y: number): string {
  const template = set.tiles[(x + y) % set.tiles.length]!;
  const yy = set.scheme === "tms" ? tmsY(z, y) : y;
  return expandTemplate(template, z, x, yy, (key) => {
    if (key === "quadkey") return quadkey(z, x, y);
    if (key === "bbox-epsg-3857") {
      const n = 2 ** z;
      const size = EARTH_CIRCUMFERENCE / n;
      const half = EARTH_CIRCUMFERENCE / 2;
      const minX = x * size - half;
      const maxY = half - y * size;
      return `${minX},${maxY - size},${minX + size},${maxY}`;
    }
    return undefined;
  });
}
