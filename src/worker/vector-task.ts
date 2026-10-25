import type { VectorFeature } from "../formats/mvt.ts";
import { classifyRings, decodeTile, featureKey } from "../formats/mvt.ts";
import type { Compiled, FeatureContext, GeometryType } from "../style/expression.ts";
import { compile } from "../style/expression.ts";
import { CircleBuilder, ExtrusionBuilder, FillBuilder, LineBuilder } from "./buckets.ts";
import type { PackedFeatures, PackedLabels } from "./packed.ts";
import { FeatureTableBuilder, featureTransfers, LabelBuilder, labelTransfers } from "./packed.ts";
import type { LabelInfo, SymbolLayout } from "./symbols.ts";
import { labelCandidates, labelInfo, lineLabels, mergeParts } from "./symbols.ts";

export type BucketType = "fill" | "line" | "circle" | "symbol" | "extrusion";

export interface LayerProgram {
  id: string;
  type: BucketType;
  sourceLayer: string | null;
  filter: unknown;
  minZoom: number;
  maxZoom: number;
  keys: string[];
  layout: Record<string, unknown>;
  sortKey: unknown;
}

export interface VectorTileRequest {
  bytes: ArrayBuffer;
  z: number;
  x: number;
  y: number;
  layers: LayerProgram[];
  overzoom: boolean;
  promoteId: string | Readonly<Record<string, string>> | null;
}

export interface Geometry {
  vertices: ArrayBuffer;
  indices: ArrayBuffer;
  vertexCount: number;
  indexCount: number;
}

export interface BucketData {
  layerId: string;
  type: BucketType;
  extent: number;
  features: PackedFeatures;
  main: Geometry | null;
  outline: Geometry | null;
  labels?: PackedLabels;
}

export interface VectorTileResult {
  buckets: BucketData[];
  layers: string[];
  featureCount: number;
  decodeMs: number;
}

const GEOMETRY_NAMES: Record<number, GeometryType> = { 0: "Unknown", 1: "Point", 2: "LineString", 3: "Polygon" };

const compiled = new Map<string, Compiled<unknown>>();

function cachedCompile(key: string, value: unknown, kind: "boolean" | "number" | "string"): Compiled<unknown> {
  const cacheKey = `${kind}:${key}:${JSON.stringify(value)}`;
  let c = compiled.get(cacheKey);
  if (!c) {
    c = compile(value, kind, kind === "boolean" ? false : kind === "string" ? "" : 0, key);
    if (compiled.size > 4096) compiled.clear();
    compiled.set(cacheKey, c);
  }
  return c;
}

async function inflate(bytes: ArrayBuffer): Promise<Uint8Array> {
  const view = new Uint8Array(bytes);
  if (view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b) {
    const stream = new Blob([view]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return view;
}

class FeatureView implements FeatureContext {
  readonly feature: VectorFeature;
  readonly geometryType: GeometryType;
  readonly index: number;
  constructor(feature: VectorFeature, index: number) {
    this.feature = feature;
    this.index = feature.source ?? index;
    this.geometryType = GEOMETRY_NAMES[feature.type] ?? "Unknown";
  }
  get properties(): Readonly<Record<string, unknown>> {
    return this.feature.properties();
  }
  get id(): number | string | undefined {
    return this.feature.textId ?? this.feature.id;
  }
}

export interface FeatureLayer {
  readonly name: string;
  readonly extent: number;
  readonly length: number;
  feature(index: number): VectorFeature;
}

export async function buildVectorTile(
  request: VectorTileRequest,
  signal: AbortSignal,
): Promise<{ result: VectorTileResult; transfer: Transferable[] }> {
  const started = performance.now();
  const data = await inflate(request.bytes);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const layers = decodeTile(data);
  const source = request.promoteId === null ? layers : promoteIds(layers, request.promoteId);
  return buildBuckets(source, request.z, request.layers, request.overzoom, started);
}

function promoteIds(
  layers: ReadonlyMap<string, FeatureLayer>,
  promote: string | Readonly<Record<string, string>>,
): Map<string, FeatureLayer> {
  const out = new Map<string, FeatureLayer>();
  for (const [name, layer] of layers) {
    const key = typeof promote === "string" ? promote : promote[name];
    if (typeof key !== "string") {
      out.set(name, layer);
      continue;
    }
    out.set(name, {
      name: layer.name,
      extent: layer.extent,
      length: layer.length,
      feature: (index) => {
        const feature = layer.feature(index);
        const raw = feature.property(key);
        const id = featureKey(raw);
        return {
          id,
          textId: typeof raw === "string" && id !== undefined ? raw : undefined,
          source: index,
          type: feature.type,
          extent: feature.extent,
          properties: () => feature.properties(),
          property: (k) => feature.property(k),
          geometry: () => feature.geometry(),
        };
      },
    });
  }
  return out;
}

export function buildBuckets(
  layers: ReadonlyMap<string, FeatureLayer>,
  zoom: number,
  programs: readonly LayerProgram[],
  overzoom: boolean,
  started = performance.now(),
): { result: VectorTileResult; transfer: Transferable[] } {
  const buckets: BucketData[] = [];
  const transfer: Transferable[] = [];
  let featureCount = 0;
  const views = new Map<string, FeatureView[]>();
  for (const program of programs) {
    if (program.maxZoom <= zoom) continue;
    if (!overzoom && program.minZoom >= zoom + 1) continue;
    const source = sourceLayer(layers, program.sourceLayer);
    if (!source) continue;
    let list = views.get(source.name);
    if (!list) {
      list = [];
      for (let i = 0; i < source.length; i++) list.push(new FeatureView(source.feature(i), i));
      views.set(source.name, list);
    }
    const filter =
      program.filter === null || program.filter === undefined
        ? null
        : cachedCompile(`${program.id}.filter`, program.filter, "boolean");
    let selected = filter ? list.filter((f) => filter.evaluate({ zoom, feature: f }) === true) : list.slice();
    if (program.type === "fill" || program.type === "extrusion")
      selected = selected.filter((f) => f.feature.type === 3);
    else if (program.type === "line") selected = selected.filter((f) => f.feature.type === 2 || f.feature.type === 3);
    if (selected.length === 0) continue;
    if (program.sortKey !== null && program.sortKey !== undefined) {
      const sortKey = cachedCompile(`${program.id}.sortKey`, program.sortKey, "number");
      const keyed = selected.map((f, i) => ({ f, i, k: sortKey.evaluate({ zoom, feature: f }) as number }));
      keyed.sort((a, b) => a.k - b.k || a.i - b.i);
      selected = keyed.map((e) => e.f);
    }
    const bucket = buildBucket(program, source, selected, zoom);
    if (!bucket) continue;
    featureCount += bucket.features.count;
    for (const g of [bucket.main, bucket.outline]) {
      if (!g) continue;
      transfer.push(g.vertices, g.indices);
    }
    featureTransfers(bucket.features, transfer);
    if (bucket.labels) labelTransfers(bucket.labels, transfer);
    buckets.push(bucket);
  }
  return {
    result: { buckets, layers: [...layers.keys()], featureCount, decodeMs: performance.now() - started },
    transfer,
  };
}

function sourceLayer(layers: ReadonlyMap<string, FeatureLayer>, name: string | null): FeatureLayer | undefined {
  if (name !== null) return layers.get(name);
  return layers.values().next().value;
}

function geometry(vertices: ArrayBuffer, indices: ArrayBuffer, vertexCount: number): Geometry {
  return { vertices, indices, vertexCount, indexCount: indices.byteLength / 4 };
}

function buildBucket(
  program: LayerProgram,
  source: FeatureLayer,
  selected: FeatureView[],
  zoom: number,
): BucketData | null {
  const features = new FeatureTableBuilder(program.keys);
  const layout = program.layout;
  if (program.type === "fill") {
    const fill = new FillBuilder();
    for (const f of selected) {
      const index = features.count;
      const polygons = classifyRings(f.feature.geometry());
      if (polygons.length === 0) continue;
      for (const rings of polygons) fill.addPolygon(rings, index);
      features.add(f.feature, f.index);
    }
    if (fill.vertexCount === 0) return null;
    return {
      layerId: program.id,
      type: "fill",
      extent: source.extent,
      features: features.finish(),
      main: geometry(fill.vertices.finish(), fill.indices.finish(), fill.vertexCount),
      outline: fill.edges.length > 0 ? geometry(new ArrayBuffer(0), fill.edges.finish(), fill.vertexCount) : null,
    };
  }
  if (program.type === "extrusion") {
    const extrusion = new ExtrusionBuilder(source.extent);
    for (const f of selected) {
      const index = features.count;
      const polygons = classifyRings(f.feature.geometry());
      if (polygons.length === 0) continue;
      for (const rings of polygons) extrusion.addPolygon(rings, index);
      features.add(f.feature, f.index);
    }
    if (extrusion.vertexCount === 0) return null;
    return {
      layerId: program.id,
      type: "extrusion",
      extent: source.extent,
      features: features.finish(),
      main: geometry(extrusion.vertices.finish(), extrusion.indices.finish(), extrusion.vertexCount),
      outline: null,
    };
  }
  if (program.type === "line") {
    const cap = (layout.cap as LineBuilderCap) ?? "butt";
    const join = (layout.join as LineBuilderJoin) ?? "miter";
    const miterLimit = typeof layout.miterLimit === "number" ? layout.miterLimit : 2;
    const lines = new LineBuilder({ cap, join, miterLimit, roundLimit: 0.94 });
    for (const f of selected) {
      const index = features.count;
      const parts = f.feature.geometry();
      if (parts.length === 0) continue;
      const closed = f.feature.type === 3;
      for (const part of parts) lines.addLine(part, index, closed);
      features.add(f.feature, f.index);
    }
    if (lines.vertexCount === 0) return null;
    return {
      layerId: program.id,
      type: "line",
      extent: source.extent,
      features: features.finish(),
      main: geometry(lines.vertices.finish(), lines.indices.finish(), lines.vertexCount),
      outline: null,
    };
  }
  if (program.type === "symbol") {
    const symbol: SymbolLayout = {
      text: cachedCompile(`${program.id}.text`, layout.text ?? "", "string"),
      size: cachedCompile(`${program.id}.size`, layout.size ?? 14, "number"),
      priority: cachedCompile(`${program.id}.priority`, layout.priority ?? 0, "number"),
      placement: layout.placement === "line" ? "line" : "point",
      spacing: typeof layout.spacing === "number" ? layout.spacing : 250,
      transform: layout.transform === "uppercase" || layout.transform === "lowercase" ? layout.transform : "none",
    };
    const labels = new LabelBuilder();
    const streets = new Map<string, { info: LabelInfo; index: number; parts: Int32Array[] }>();
    for (const f of selected) {
      const index = features.count;
      if (symbol.placement === "line" && f.feature.type === 2) {
        const info = labelInfo({ zoom, feature: f }, symbol);
        const parts = info ? f.feature.geometry() : [];
        if (!info || parts.length === 0) continue;
        const key = `${info.size}|${info.text}`;
        const group = streets.get(key);
        if (group) {
          group.info.priority = Math.max(group.info.priority, info.priority);
          for (const part of parts) group.parts.push(part);
          continue;
        }
        streets.set(key, { info, index, parts: [...parts] });
        features.add(f.feature, f.index);
        continue;
      }
      const found = labelCandidates(f.feature, index, { zoom, feature: f }, symbol, source.extent);
      if (found.length === 0) continue;
      for (const c of found) labels.add(c.text, c.feature, c.size, c.priority, c.line, c.anchors, c.path);
      features.add(f.feature, f.index);
    }
    for (const { info, index, parts } of streets.values()) {
      for (const c of lineLabels(mergeParts(parts), info, index, symbol, source.extent)) {
        labels.add(c.text, c.feature, c.size, c.priority, c.line, c.anchors, c.path);
      }
    }
    if (labels.count === 0) return null;
    return {
      layerId: program.id,
      type: "symbol",
      extent: source.extent,
      features: features.finish(),
      main: null,
      outline: null,
      labels: labels.finish(),
    };
  }
  if (program.type === "circle") {
    const circles = new CircleBuilder();
    for (const f of selected) {
      const index = features.count;
      const parts = f.feature.geometry();
      let added = false;
      for (const part of parts) {
        if (f.feature.type === 1) {
          for (let i = 0; i < part.length; i += 2) {
            circles.addPoint(part[i]!, part[i + 1]!, index);
            added = true;
          }
        }
      }
      if (added) features.add(f.feature, f.index);
    }
    if (circles.vertexCount === 0) return null;
    return {
      layerId: program.id,
      type: "circle",
      extent: source.extent,
      features: features.finish(),
      main: geometry(circles.vertices.finish(), circles.indices.finish(), circles.vertexCount),
      outline: null,
    };
  }
  return null;
}

type LineBuilderCap = "butt" | "round" | "square";
type LineBuilderJoin = "miter" | "round" | "bevel";
