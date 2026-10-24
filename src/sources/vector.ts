import type { Transform } from "../camera/transform.ts";
import type { TileCoord } from "../geo/tile.ts";
import type { GL } from "../render/gl.ts";
import { PaintTable } from "../render/paint-table.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { VectorSourceSpec } from "../style/types.ts";
import { fetchBytes, resolveRequest } from "../tiles/fetch.ts";
import type { TileLoader, TileStats } from "../tiles/manager.ts";
import { TileManager } from "../tiles/manager.ts";
import type { PackedLabels } from "../worker/packed.ts";
import { FeatureTable } from "../worker/packed.ts";
import type {
  BucketData,
  BucketType,
  Geometry,
  LayerProgram,
  VectorTileRequest,
  VectorTileResult,
} from "../worker/vector-task.ts";
import type { MapSource, SourceContext } from "./source.ts";
import { tileEvents } from "./source.ts";
import type { TileSet } from "./tilejson.ts";
import { resolveTileSet, tileUrl } from "./tilejson.ts";

export interface GpuGeometry {
  vao: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  bytes: number;
  shared?: boolean;
}

export interface VectorBucket {
  readonly layerId: string;
  readonly type: BucketType;
  readonly extent: number;
  readonly features: FeatureTable;
  main: GpuGeometry | null;
  outline: GpuGeometry | null;
  cpu: BucketData | null;
  paint: PaintTable;
  labels: PackedLabels | null;
}

export interface VectorTile {
  buckets: Map<string, VectorBucket>;
  signature: string;
  bytes: number;
  uploaded: boolean;
  featureCount: number;
}

export interface VectorTileSource {
  readonly manager: TileManager<VectorTile> | null;
}

export function isVectorTileSource(source: MapSource | undefined): source is MapSource & VectorTileSource {
  return source?.type === "vector" || source?.type === "geojson";
}

const DATA_DRIVEN: Record<string, readonly string[]> = {
  fill: ["color", "opacity", "outlineColor"],
  line: ["color", "width", "opacity", "blur"],
  circle: ["radius", "color", "opacity", "strokeColor", "strokeWidth", "blur"],
  extrusion: ["color", "height", "base"],
  symbol: ["color", "haloColor", "haloWidth", "opacity"],
};

export function dataDrivenPaint(type: string): readonly string[] {
  return DATA_DRIVEN[type] ?? [];
}

export function layerProgram(layer: StyleLayer): LayerProgram | null {
  const type = layer.type;
  if (type !== "fill" && type !== "line" && type !== "circle" && type !== "symbol" && type !== "extrusion") return null;
  const keys = new Set<string>();
  for (const name of DATA_DRIVEN[type] ?? []) {
    const c = layer.paintProperty<unknown>(name);
    if (c.featureDependent) for (const k of c.properties) keys.add(k);
  }
  const layout: Record<string, unknown> = {};
  if (type === "line") {
    layout.cap = layer.fixed<string>("cap");
    layout.join = layer.fixed<string>("join");
    layout.miterLimit = layer.fixed<number>("miterLimit");
  }
  if (type === "symbol") {
    const raw = (layer.spec as { layout?: Record<string, unknown> }).layout ?? {};
    layout.text = raw.text ?? "";
    layout.size = raw.size ?? 14;
    layout.priority = raw.priority ?? 0;
    layout.placement = layer.fixed<string>("placement");
    layout.spacing = layer.fixed<number>("spacing");
    layout.transform = layer.fixed<string>("transform");
    for (const name of ["text", "size", "priority"]) {
      const c = layer.layoutProperty<unknown>(name);
      if (c.featureDependent) for (const k of c.properties) keys.add(k);
    }
  }
  const spec = layer.spec as { filter?: unknown; sortKey?: unknown };
  return {
    id: layer.id,
    type,
    sourceLayer: layer.sourceLayer ?? null,
    filter: spec.filter ?? null,
    minZoom: layer.minZoom,
    maxZoom: layer.maxZoom,
    keys: [...keys].sort(),
    layout,
    sortKey: spec.sortKey ?? null,
  };
}

export class LayerPrograms {
  programs: LayerProgram[] = [];
  signature = "";
  private revisions = new Map<string, number>();

  update(layers: readonly StyleLayer[]): boolean {
    let changed = layers.length !== this.revisions.size;
    if (!changed) {
      for (const layer of layers) {
        if (this.revisions.get(layer.id) !== layer.revision) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return false;
    this.revisions = new Map(layers.map((l) => [l.id, l.revision]));
    const programs = layers.map(layerProgram).filter((p): p is LayerProgram => p !== null);
    const signature = JSON.stringify(programs);
    if (signature === this.signature) return false;
    const first = this.signature === "";
    this.signature = signature;
    this.programs = programs;
    return !first;
  }
}

export function vectorTile(decoded: VectorTileResult, signature: string): VectorTile {
  const buckets = new Map<string, VectorBucket>();
  let bytes = 0;
  for (const b of decoded.buckets) {
    buckets.set(b.layerId, {
      layerId: b.layerId,
      type: b.type,
      extent: b.extent,
      features: new FeatureTable(b.features),
      main: null,
      outline: null,
      cpu: b,
      paint: new PaintTable(),
      labels: b.labels ?? null,
    });
    bytes += geometryBytes(b.main) + geometryBytes(b.outline) + b.features.ids.byteLength * 4;
  }
  return { buckets, signature, bytes, uploaded: false, featureCount: decoded.featureCount };
}

export function vectorTileLoader(gl: GL, load: TileLoader<VectorTile>["load"]): TileLoader<VectorTile> {
  return {
    load,
    needsUpload: (data) => !data.uploaded,
    upload: (data) => {
      for (const bucket of data.buckets.values()) {
        const cpu = bucket.cpu;
        if (!cpu) continue;
        bucket.main = cpu.main ? uploadGeometry(gl, bucket.type, cpu.main) : null;
        bucket.outline = cpu.outline && bucket.main ? uploadOutline(gl, bucket.main, cpu.outline) : null;
        bucket.cpu = null;
      }
      data.uploaded = true;
    },
    release: (data) => {
      for (const bucket of data.buckets.values()) {
        releaseGeometry(gl, bucket.main);
        releaseGeometry(gl, bucket.outline);
        bucket.paint.release(gl);
        bucket.main = null;
        bucket.outline = null;
        bucket.cpu = null;
      }
      data.buckets.clear();
    },
    byteSize: (data) => {
      let bytes = 0;
      for (const b of data.buckets.values()) {
        bytes += (b.main?.bytes ?? 0) + (b.outline?.bytes ?? 0) + b.paint.bytes + b.features.bytes;
        if (b.cpu) bytes += geometryBytes(b.cpu.main) + geometryBytes(b.cpu.outline);
      }
      return bytes || data.bytes;
    },
  };
}

export class VectorSource implements MapSource, VectorTileSource {
  readonly id: string;
  readonly type = "vector" as const;
  spec: VectorSourceSpec;
  manager: TileManager<VectorTile> | null = null;
  tileSet: TileSet | null = null;
  private readonly ctx: SourceContext;
  private readonly layers = new LayerPrograms();

  constructor(id: string, spec: VectorSourceSpec, ctx: SourceContext) {
    this.id = id;
    this.spec = spec;
    this.ctx = ctx;
  }

  get loaded(): boolean {
    return this.manager !== null;
  }

  get attribution(): string | undefined {
    return this.spec.attribution ?? this.tileSet?.attribution;
  }

  async load(signal: AbortSignal): Promise<void> {
    const spec =
      this.spec.url && /\.pmtiles(\?|#|$)/i.test(this.spec.url) && !this.spec.url.startsWith("pmtiles://")
        ? { ...this.spec, url: `pmtiles://${absoluteUrl(this.spec.url)}` }
        : this.spec;
    const set = await resolveTileSet(
      this.id,
      spec,
      { minZoom: 0, maxZoom: 14 },
      this.ctx.transformRequest,
      this.ctx.requestTimeoutMs,
      signal,
    );
    if (signal.aborted) return;
    this.tileSet = set;
    this.ctx.scheduler.setGroupLimit(this.id, 16);
    this.manager = new TileManager<VectorTile>(
      this.id,
      { tileSize: 512, minZoom: set.minZoom, maxZoom: set.maxZoom, roundZoom: false, bounds: set.bounds },
      vectorTileLoader(this.ctx.gl, (tile, tileSignal, onDecoding) => this.loadTile(set, tile, tileSignal, onDecoding)),
      this.ctx.scheduler,
      {
        fadeDuration: 0,
        backstopLevels: [2, 4],
        maxRetries: 3,
        cacheBytes: this.ctx.cacheBytes,
        failureCooldownMs: 120000,
        prefetchLimit: this.ctx.prefetchLimit,
      },
      tileEvents(this.id, this.ctx),
    );
  }

  setLayers(layers: readonly StyleLayer[]): void {
    if (this.layers.update(layers)) this.manager?.refresh();
  }

  update(transform: Transform, now: number, predicted: readonly Transform[]): void {
    this.manager?.update(transform, now, predicted);
  }

  uploadPending(deadline: number, now: number): boolean {
    return this.manager?.uploadPending(deadline, now) ?? false;
  }

  isIdle(): boolean {
    return this.manager ? this.manager.isLoaded && !this.manager.hasPendingUploads : false;
  }

  isFading(): boolean {
    return false;
  }

  stats(): TileStats | null {
    return this.manager?.stats ?? null;
  }

  reload(): void {
    this.manager?.reload();
  }

  destroy(): void {
    this.manager?.destroy();
    this.manager = null;
  }

  private async loadTile(
    set: TileSet,
    tile: TileCoord,
    signal: AbortSignal,
    onDecoding: () => void,
  ): Promise<VectorTile | null> {
    const ctx = this.ctx;
    const url = tileUrl(set, tile.z, tile.x, tile.y);
    const result = await fetchBytes(resolveRequest(url, "tile", ctx.transformRequest), signal, ctx.requestTimeoutMs);
    if (result.kind === "empty") return null;
    onDecoding();
    const { programs, signature } = this.layers;
    const request: VectorTileRequest = {
      bytes: result.data,
      z: tile.z,
      x: tile.x,
      y: tile.y,
      layers: programs,
      overzoom: tile.z >= set.maxZoom,
      promoteId: this.spec.promoteId ?? null,
    };
    const decoded = await ctx
      .workers()
      .send<VectorTileResult>("vector", request, [result.data], signal, tile.x + tile.y);
    return vectorTile(decoded, signature);
  }
}

function geometryBytes(g: Geometry | null): number {
  return g ? g.vertices.byteLength + g.indices.byteLength : 0;
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
}

export function uploadGeometry(gl: GL, type: BucketType, g: Geometry): GpuGeometry | null {
  if (g.indexCount === 0 || g.vertexCount === 0 || gl.isLost) return null;
  const ctx = gl.gl;
  const vao = ctx.createVertexArray();
  if (!vao) return null;
  ctx.bindVertexArray(vao);
  const vertexBuffer = gl.createBuffer(ctx.ARRAY_BUFFER, new Uint8Array(g.vertices));
  if (type === "fill" || type === "extrusion") {
    ctx.enableVertexAttribArray(0);
    ctx.vertexAttribPointer(0, 2, ctx.SHORT, false, 8, 0);
    ctx.enableVertexAttribArray(4);
    ctx.vertexAttribIPointer(4, 1, ctx.UNSIGNED_INT, 8, 4);
  } else if (type === "line") {
    ctx.enableVertexAttribArray(0);
    ctx.vertexAttribPointer(0, 2, ctx.SHORT, false, 20, 0);
    ctx.enableVertexAttribArray(1);
    ctx.vertexAttribPointer(1, 2, ctx.SHORT, false, 20, 4);
    ctx.enableVertexAttribArray(2);
    ctx.vertexAttribPointer(2, 4, ctx.BYTE, true, 20, 8);
    ctx.enableVertexAttribArray(3);
    ctx.vertexAttribPointer(3, 1, ctx.FLOAT, false, 20, 12);
    ctx.enableVertexAttribArray(4);
    ctx.vertexAttribIPointer(4, 1, ctx.UNSIGNED_INT, 20, 16);
  } else if (type === "circle") {
    ctx.enableVertexAttribArray(0);
    ctx.vertexAttribPointer(0, 2, ctx.SHORT, false, 12, 0);
    ctx.enableVertexAttribArray(1);
    ctx.vertexAttribPointer(1, 4, ctx.BYTE, true, 12, 4);
    ctx.enableVertexAttribArray(4);
    ctx.vertexAttribIPointer(4, 1, ctx.UNSIGNED_INT, 12, 8);
  }
  const indexBuffer = gl.createBuffer(ctx.ELEMENT_ARRAY_BUFFER, new Uint32Array(g.indices));
  ctx.bindVertexArray(null);
  return {
    vao,
    vertexBuffer,
    indexBuffer,
    indexCount: g.indexCount,
    bytes: g.vertices.byteLength + g.indices.byteLength,
  };
}

export function uploadOutline(gl: GL, main: GpuGeometry, g: Geometry): GpuGeometry | null {
  if (g.indexCount === 0 || gl.isLost) return null;
  const ctx = gl.gl;
  const vao = ctx.createVertexArray();
  if (!vao) return null;
  ctx.bindVertexArray(vao);
  ctx.bindBuffer(ctx.ARRAY_BUFFER, main.vertexBuffer);
  ctx.enableVertexAttribArray(0);
  ctx.vertexAttribPointer(0, 2, ctx.SHORT, false, 8, 0);
  ctx.enableVertexAttribArray(4);
  ctx.vertexAttribIPointer(4, 1, ctx.UNSIGNED_INT, 8, 4);
  const indexBuffer = gl.createBuffer(ctx.ELEMENT_ARRAY_BUFFER, new Uint32Array(g.indices));
  ctx.bindVertexArray(null);
  return {
    vao,
    vertexBuffer: main.vertexBuffer,
    indexBuffer,
    indexCount: g.indexCount,
    bytes: g.indices.byteLength,
    shared: true,
  };
}

export function releaseGeometry(gl: GL, g: GpuGeometry | null): void {
  if (!g) return;
  gl.deleteVertexArray(g.vao);
  if (!g.shared) gl.deleteBuffer(g.vertexBuffer);
  gl.deleteBuffer(g.indexBuffer);
}
