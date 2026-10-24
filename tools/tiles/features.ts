import { coastlineWater } from "./coastline.ts";
import type { RegionData } from "./extract.ts";
import type { Polygon, Rect } from "./geometry.ts";
import {
  buildPolygons,
  clipLine,
  clipRing,
  joinWays,
  labelPoint,
  polygonArea,
  ringBounds,
  signedArea,
  splitRings,
  worldX,
  worldY,
} from "./geometry.ts";
import type { Tags } from "./osm-pbf.ts";
import type { Classified, Props } from "./schema.ts";
import { boundaryLevel, boundaryMinZoom, classify, isArea } from "./schema.ts";

export type GeomType = 1 | 2 | 3;

export interface TileFeature {
  id: number;
  layer: string;
  minZoom: number;
  type: GeomType;
  parts: Float64Array[];
  props: Props;
  bbox: Rect;
  sortKey: number;
}

export interface FeatureStats {
  features: number;
  byLayer: Record<string, number>;
  missingRefs: number;
  brokenRelations: number;
  droppedCoastPieces: number;
  invertedCoastRings: number;
}

const POINT_LAYERS = new Set(["place", "poi", "water_name", "mountain_peak", "housenumber"]);

export function regionRect(bbox: [number, number, number, number]): Rect {
  return { x0: worldX(bbox[0] * 1e7), y0: worldY(bbox[3] * 1e7), x1: worldX(bbox[2] * 1e7), y1: worldY(bbox[1] * 1e7) };
}

export function buildFeatures(
  data: RegionData,
  maxZoom: number,
  log: (m: string) => void = () => undefined,
): { features: TileFeature[]; stats: FeatureStats } {
  const rect = regionRect(data.bbox);
  const out: TileFeature[] = [];
  const stats: FeatureStats = {
    features: 0,
    byLayer: {},
    missingRefs: 0,
    brokenRelations: 0,
    droppedCoastPieces: 0,
    invertedCoastRings: 0,
  };
  const ids = data.nodeIds;

  const findNode = (id: number): number => {
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = ids[mid]!;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  const findWay = (id: number): number => {
    const w = data.wayIds;
    let lo = 0;
    let hi = w.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = w[mid]!;
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  const wayRefs = (index: number): Float64Array =>
    data.wayRefs.subarray(data.wayOffsets[index]!, data.wayOffsets[index + 1]!);

  const coords = (refs: ArrayLike<number>): Float64Array => {
    const pts: number[] = [];
    for (let i = 0; i < refs.length; i++) {
      const n = findNode(refs[i]!);
      if (n < 0) {
        stats.missingRefs++;
        continue;
      }
      pts.push(worldX(data.nodeLon[n]!), worldY(data.nodeLat[n]!));
    }
    return Float64Array.from(pts);
  };

  const push = (f: TileFeature) => {
    out.push(f);
    stats.byLayer[f.layer] = (stats.byLayer[f.layer] ?? 0) + 1;
  };

  const zoomFor = (c: Classified, area: number): number => {
    let z = c.minZoom;
    if (c.minPixels !== undefined && c.minPixels > 0 && area > 0) {
      const needed = 0.5 * Math.log2(c.minPixels / (area * 512 * 512));
      z = Math.max(z, Math.ceil(needed));
    }
    return Math.max(0, Math.min(maxZoom, z));
  };

  const addPolygons = (id: number, polys: Polygon[], tags: Tags) => {
    const clipped: Polygon[] = [];
    for (const p of polys) {
      const outer = clipRing(p.outer, rect);
      if (!outer || Math.abs(signedArea(outer)) <= 0) continue;
      const holes: Float64Array[] = [];
      for (const h of p.holes) {
        const c = clipRing(h, rect);
        if (c && Math.abs(signedArea(c)) > 0) holes.push(c);
      }
      clipped.push({
        outer: signedArea(outer) < 0 ? reversed(outer) : outer,
        holes: holes.map((h) => (signedArea(h) > 0 ? reversed(h) : h)),
      });
    }
    if (clipped.length === 0) return;
    const area = clipped.reduce((s, p) => s + polygonArea(p), 0);
    for (const c of classify(tags, "area")) {
      const minZoom = zoomFor(c, area);
      if (POINT_LAYERS.has(c.layer)) {
        const largest = clipped.reduce((a, b) => (polygonArea(b) > polygonArea(a) ? b : a));
        const [x, y] = labelPoint(largest);
        push(point(id, c.layer, minZoom, x, y, c.props));
        continue;
      }
      const parts: Float64Array[] = [];
      for (const p of clipped) parts.push(p.outer, ...p.holes);
      push({
        id,
        layer: c.layer,
        minZoom,
        type: 3,
        parts,
        props: c.props,
        bbox: boundsOf(parts),
        sortKey: c.sortKey ?? 0,
      });
    }
  };

  const addLine = (id: number, line: Float64Array, tags: Tags) => {
    const classes = classify(tags, "line");
    if (classes.length === 0) return;
    const pieces = clipLine(line, rect);
    if (pieces.length === 0) return;
    for (const c of classes) {
      push({
        id,
        layer: c.layer,
        minZoom: Math.min(maxZoom, c.minZoom),
        type: 2,
        parts: pieces,
        props: c.props,
        bbox: boundsOf(pieces),
        sortKey: c.sortKey ?? 0,
      });
    }
  };

  for (const p of data.points) {
    const x = worldX(p.lon);
    const y = worldY(p.lat);
    for (const c of classify(p.tags, "point"))
      push(point(p.id * 4, c.layer, Math.min(maxZoom, c.minZoom), x, y, c.props));
  }
  log(`points: ${out.length.toLocaleString()} features`);

  const coastRefs: Float64Array[] = [];
  for (let i = 0; i < data.wayIds.length; i++) {
    const tags = data.wayTags[i];
    if (!tags) continue;
    const refs = wayRefs(i);
    if (refs.length < 2) continue;
    if (tags.natural === "coastline") coastRefs.push(refs);
    const id = data.wayIds[i]! * 4 + 1;
    const closed = refs.length >= 4 && refs[0] === refs[refs.length - 1];
    if (closed && isArea(tags)) {
      const ring = coords(refs);
      if (ring.length >= 8) addPolygons(id, [{ outer: ring, holes: [] }], tags);
    } else {
      const line = coords(refs);
      if (line.length >= 4) addLine(id, line, tags);
    }
  }
  log(`ways: ${out.length.toLocaleString()} features so far`);

  const boundaryWays = new Map<number, { level: number; maritime: boolean }>();
  for (const rel of data.relations) {
    const tags = rel.tags;
    const level = boundaryLevel(tags);
    if (level !== null) {
      for (const m of rel.members) {
        if (m.role === "subarea" || m.role === "admin_centre" || m.role === "label") continue;
        const prev = boundaryWays.get(m.ref);
        if (!prev || level < prev.level) boundaryWays.set(m.ref, { level, maritime: prev?.maritime ?? false });
      }
      continue;
    }
    const outerRefs: Float64Array[] = [];
    const innerRefs: Float64Array[] = [];
    const unknownRefs: Float64Array[] = [];
    let found = 0;
    for (const m of rel.members) {
      const w = findWay(m.ref);
      if (w < 0) continue;
      found++;
      const refs = wayRefs(w);
      if (m.role === "outer") outerRefs.push(refs);
      else if (m.role === "inner") innerRefs.push(refs);
      else unknownRefs.push(refs);
    }
    if (found === 0) continue;
    const outerJoined = joinWays(outerRefs);
    const innerJoined = joinWays(innerRefs);
    const unknownJoined = joinWays(unknownRefs);
    if (outerJoined.closed.length + unknownJoined.closed.length === 0) {
      stats.brokenRelations++;
      continue;
    }
    const outer = outerJoined.closed.map((r) => coords(r)).filter((r) => r.length >= 8);
    const inner = innerJoined.closed.map((r) => coords(r)).filter((r) => r.length >= 8);
    if (unknownJoined.closed.length > 0) {
      const split = splitRings(unknownJoined.closed.map((r) => coords(r)));
      outer.push(...split.outer);
      inner.push(...split.inner);
    }
    if (outerJoined.open.length > 0) stats.brokenRelations++;
    const polys = buildPolygons(outer, inner);
    addPolygons(rel.id * 4 + 2, polys, { ...tags, type: "multipolygon" });
  }
  for (const [wayId, info] of boundaryWays) {
    const w = findWay(wayId);
    if (w < 0) continue;
    const tags = data.wayTags[w];
    const maritime = tags?.maritime === "yes" || tags?.boundary === "maritime" || info.maritime;
    const line = coords(wayRefs(w));
    if (line.length < 4) continue;
    const pieces = clipLine(line, rect);
    if (pieces.length === 0) continue;
    const props: Props = { admin_level: info.level };
    if (maritime) props.maritime = 1;
    if (tags?.disputed === "yes") props.disputed = 1;
    push({
      id: wayId * 4 + 1,
      layer: "boundary",
      minZoom: Math.min(maxZoom, boundaryMinZoom(info.level)),
      type: 2,
      parts: pieces,
      props,
      bbox: boundsOf(pieces),
      sortKey: -info.level,
    });
  }
  log(`relations: ${out.length.toLocaleString()} features so far, ${stats.brokenRelations} broken relations`);

  if (coastRefs.length > 0) {
    const joined = joinWays(coastRefs);
    const chains = [
      ...joined.closed.map((r) => ({ coords: coords(r), closed: true })),
      ...joined.open.map((r) => ({ coords: coords(r), closed: false })),
    ].filter((c) => c.coords.length >= 4);
    const result = coastlineWater(chains, rect);
    stats.droppedCoastPieces = result.droppedPieces;
    stats.invertedCoastRings = result.invertedRings ?? 0;
    let n = 0;
    for (const poly of result.water) {
      const parts = [poly.outer, ...poly.holes];
      push({
        id: 3 + 4 * n++,
        layer: "water",
        minZoom: 0,
        type: 3,
        parts,
        props: { class: "ocean" },
        bbox: boundsOf(parts),
        sortKey: -1,
      });
    }
    log(
      `coastline: ${coastRefs.length} ways, ${joined.open.length} open and ${joined.closed.length} closed chains, ${result.water.length} sea polygons, ${result.droppedPieces} dropped pieces`,
    );
  }
  stats.features = out.length;
  return { features: out, stats };
}

function point(id: number, layer: string, minZoom: number, x: number, y: number, props: Props): TileFeature {
  return {
    id,
    layer,
    minZoom,
    type: 1,
    parts: [Float64Array.of(x, y)],
    props,
    bbox: { x0: x, y0: y, x1: x, y1: y },
    sortKey: 0,
  };
}

function boundsOf(parts: Float64Array[]): Rect {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of parts) {
    const b = ringBounds(p);
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }
  return { x0, y0, x1, y1 };
}

function reversed(ring: Float64Array): Float64Array {
  const out = new Float64Array(ring.length);
  for (let i = 0, j = ring.length - 2; i < ring.length; i += 2, j -= 2) {
    out[i] = ring[j]!;
    out[i + 1] = ring[j + 1]!;
  }
  return out;
}
