import type { Transform } from "../camera/transform.ts";
import { EARTH_CIRCUMFERENCE } from "../geo/mercator.ts";
import type { DemSource } from "../sources/dem.ts";
import { ImageSource, overlayWraps } from "../sources/image.ts";
import type { RasterSource } from "../sources/raster.ts";
import type { MapSource } from "../sources/source.ts";
import type { VectorBucket, VectorTile } from "../sources/vector.ts";
import { isVectorTileSource } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import { premultiply } from "../style/color.ts";
import type { StateLookup } from "../style/feature-state.ts";
import type { StyleLayer } from "../style/layer.ts";
import { terrainMesh } from "../terrain/mesh.ts";
import type { Terrain, TerrainSlot } from "../terrain/terrain.ts";
import type { LabelTerrain, SymbolLayerInput } from "../text/labels.ts";
import { LabelRenderer } from "../text/labels.ts";
import { textShader } from "../text/shader.ts";
import type { RenderPiece, TileManager } from "../tiles/manager.ts";
import type { Tile } from "../tiles/tile.ts";
import type { DrapeEntry, RenderView } from "./drape.ts";
import { DrapeCache, Hash, SlotView } from "./drape.ts";
import type { GL, Program } from "./gl.ts";
import type { ImageAtlas } from "./images.ts";
import type { PendingRead } from "./pick.ts";
import { PickBuffer } from "./pick.ts";
import { hillshadeShader } from "./shaders/hillshade.ts";
import { overlayShader, rasterShader, solidShader } from "./shaders/raster.ts";
import { terrainShader } from "./shaders/terrain.ts";
import { circleShader, extrusionShader, fillOutlineShader, fillShader, lineShader } from "./shaders/vector.ts";
import type { PickPass } from "./vector-layers.ts";
import { VectorPainter, WARM_VARIANTS } from "./vector-layers.ts";

export interface FrameInput {
  readonly transform: Transform;
  readonly view: RenderView;
  readonly target?: readonly [number, number];
  readonly framebuffer?: WebGLFramebuffer | null;
  readonly terrain?: Terrain | null;
  readonly accept?: (piece: RenderPiece<unknown>) => boolean;
  readonly acceptNear?: (piece: RenderPiece<unknown>) => boolean;
  readonly region?: readonly [number, number, number, number];
  readonly states?: ((layer: StyleLayer) => StateLookup | null) | undefined;
  readonly pixelRatio: number;
  readonly layers: readonly StyleLayer[];
  readonly sources: ReadonlyMap<string, MapSource>;
  readonly now: number;
  readonly cameraVersion: number;
}

export interface PickBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PickedFeature {
  layer: StyleLayer;
  tile: Tile<VectorTile>;
  bucket: VectorBucket;
  feature: number;
}

export interface PaintStats {
  drawCalls: number;
  pieces: number;
  drapes: number;
}

interface TerrainGeometry {
  vao: WebGLVertexArrayObject;
  vertices: WebGLBuffer;
  indices: WebGLBuffer;
  count: number;
}

const POINT_MARGIN = 0.125;
const DRAPED: ReadonlySet<string> = new Set(["background", "raster", "hillshade", "fill", "line", "circle", "heatmap"]);
const DRAPE_CACHE_BYTES = 32 * 1024 * 1024;

interface PickSetup {
  width: number;
  height: number;
  scale: [number, number];
  clip: Float64Array;
}

function pickSetup(frame: FrameInput, box: PickBox): PickSetup {
  const t = frame.transform;
  const hx = Math.max(box.x1 - box.x0, 1 / frame.pixelRatio) / t.width;
  const hy = Math.max(box.y1 - box.y0, 1 / frame.pixelRatio) / t.height;
  const cx = (box.x0 + box.x1) / t.width - 1;
  const cy = 1 - (box.y0 + box.y1) / t.height;
  return {
    width: Math.max(1, Math.round((box.x1 - box.x0) * frame.pixelRatio)),
    height: Math.max(1, Math.round((box.y1 - box.y0) * frame.pixelRatio)),
    scale: [hx, hy],
    clip: Float64Array.of(1 / hx, 0, 0, 0, 0, 1 / hy, 0, 0, 0, 0, 1, 0, -cx / hx, -cy / hy, 0, 1),
  };
}

function drapeSize(t: Transform, slot: TerrainSlot, pixelRatio: number): number {
  const n = 2 ** slot.z;
  const x0 = slot.wrap + slot.x / n;
  const y0 = slot.y / n;
  const x1 = x0 + 1 / n;
  const y1 = y0 + 1 / n;
  const z = t.centerElevationPixels;
  const corners = [t.project(x0, y0, z), t.project(x1, y0, z), t.project(x1, y1, z), t.project(x0, y1, z)];
  if (corners.some((p) => p.w <= 0)) return 1024;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  const pixels = Math.sqrt(Math.abs(area) / 2) * pixelRatio;
  return pixels > 600 ? 1024 : pixels > 300 ? 512 : 256;
}

export class Painter {
  readonly gl: GL;
  stats: PaintStats = { drawCalls: 0, pieces: 0, drapes: 0 };
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private openMask: WebGLTexture | null = null;
  private flatDem: WebGLTexture | null = null;
  private terrainGeometry: TerrainGeometry | null = null;
  private readonly drapes: DrapeCache;
  private readonly hash = new Hash();
  private drapesBehind = false;
  private readonly matrix = new Float32Array(16);
  private readonly hue = new Float32Array(9);
  private readonly vector: VectorPainter;
  readonly labels: LabelRenderer;

  get images(): ImageAtlas {
    return this.labels.images;
  }
  private readonly pickBuffer: PickBuffer;

  constructor(gl: GL) {
    this.gl = gl;
    this.labels = new LabelRenderer(gl);
    const labels = this.labels;
    this.vector = new VectorPainter(gl, {
      atlas: labels.images,
      texture: () => labels.imageTexture(),
      missing: (id) => labels.markMissing(id),
    });
    this.pickBuffer = new PickBuffer(gl);
    this.drapes = new DrapeCache(gl);
    this.init();
  }

  get drapeBytes(): number {
    return this.drapes.bytes;
  }

  init(): void {
    this.labels.reset();
    this.vector.reset();
    this.pickBuffer.reset();
    this.drapes.reset();
    this.terrainGeometry = null;
    for (const shader of [
      solidShader,
      rasterShader,
      hillshadeShader,
      terrainShader,
      fillShader,
      fillOutlineShader,
      lineShader,
      circleShader,
      extrusionShader,
      textShader,
      ...WARM_VARIANTS,
    ]) {
      this.gl.program(shader);
    }
    const gl = this.gl.gl;
    this.quadBuffer = this.gl.createBuffer(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.openMask = this.gl.createDataTexture(1, 1, "r8", Uint8Array.of(255), false);
    this.flatDem = this.gl.createDataTexture(1, 1, "r32f", Float32Array.of(0), false);
  }

  render(frame: FrameInput): boolean {
    const g = this.gl;
    const gl = g.gl;
    this.stats = { drawCalls: 0, pieces: 0, drapes: 0 };
    this.vector.budget.deadline = performance.now() + 4;
    this.vector.budget.behind = false;
    const terrain = frame.terrain ?? null;
    if (terrain) this.renderDrapes(frame, terrain);
    else if (this.drapes.count > 0) this.drapes.destroy();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    g.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const zoom = frame.view.zoom;
    const layers = frame.layers;
    let start = 0;
    let clear: RGBA = [0, 0, 0, 0];
    const first = layers[0];
    if (first && first.type === "background" && first.isVisible(zoom)) {
      clear = this.backgroundColor(first, zoom);
      start = 1;
    }
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clearDepth(1);
    gl.clearStencil(0);
    g.setDepth(false, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (terrain) {
      this.drawTerrain(frame, terrain);
      for (const layer of layers) {
        if (layer.type === "extrusion" && layer.isVisible(zoom)) this.drawLayer(frame, layer);
      }
    } else {
      for (let i = start; i < layers.length; i++) {
        const layer = layers[i]!;
        if (layer.isVisible(zoom)) this.drawLayer(frame, layer);
      }
    }
    const symbols: SymbolLayerInput[] = [];
    for (const layer of layers) {
      if (layer.type !== "symbol" || !layer.source) continue;
      const manager = vectorManager(frame.sources.get(layer.source));
      if (manager) symbols.push({ layer, manager, states: frame.states?.(layer) ?? null });
    }
    let animating = false;
    if (symbols.length > 0 || this.labels.visibleCount > 0) {
      const ground = terrain ? this.labelTerrain(frame.transform, terrain) : null;
      animating = this.labels.update(
        frame.transform,
        symbols,
        frame.now,
        frame.cameraVersion,
        frame.pixelRatio,
        ground,
      );
      this.stats.drawCalls += this.labels.draw(frame.transform, frame.pixelRatio);
    }
    gl.bindVertexArray(null);
    return animating || this.drapesBehind || this.vector.budget.behind;
  }

  private labelTerrain(transform: Transform, terrain: Terrain): LabelTerrain {
    const ws = transform.worldSize;
    const c = transform.cameraPosition;
    const camera = [c[0] / ws, c[1] / ws, c[2] / ws];
    return {
      height: (x, y) => terrain.heightAt(x, y),
      hidden: (x, y, z) => terrain.hidden(camera, x, y, z),
    };
  }

  private drawLayer(frame: FrameInput, layer: StyleLayer): void {
    switch (layer.type) {
      case "background":
        this.drawSolid(this.backgroundColor(layer, frame.view.zoom));
        break;
      case "raster": {
        const source = layer.source ? frame.sources.get(layer.source) : undefined;
        if (source?.type === "raster") this.drawRaster(frame, layer, source as RasterSource);
        else if (source instanceof ImageSource) this.drawOverlay(frame, layer, source);
        break;
      }
      case "hillshade": {
        const source = layer.source ? frame.sources.get(layer.source) : undefined;
        if (source?.type === "dem") this.drawHillshade(frame, layer, source as DemSource);
        break;
      }
      case "fill":
      case "line":
      case "circle":
      case "heatmap":
      case "extrusion": {
        const source = layer.source ? frame.sources.get(layer.source) : undefined;
        const manager = vectorManager(source);
        if (manager) this.vector.draw(frame, layer, manager, this.stats);
        break;
      }
      default:
        break;
    }
  }

  private renderDrapes(frame: FrameInput, terrain: Terrain): void {
    const g = this.gl;
    const gl = g.gl;
    const t = frame.transform;
    const zoom = t.zoom;
    const layers = frame.layers.filter((l) => DRAPED.has(l.type) && l.isVisible(zoom));
    const turning = layers.some((l) => l.type === "hillshade" && l.fixed<string>("illuminationAnchor") !== "map");
    const bearing = turning ? Math.round(t.bearing / 4) * 4 : 0;
    const deadline = performance.now() + 6;
    this.drapes.begin();
    this.drapesBehind = false;
    const common = this.hash.reset().add(bearing).add(frame.pixelRatio);
    const sources: (readonly RenderPiece<unknown>[])[] = [];
    const pointSources = new Set<readonly RenderPiece<unknown>[]>();
    const overlays: ImageSource[] = [];
    for (const layer of layers) {
      common
        .add(layer.uid)
        .add(layer.revision)
        .add(layer.motion)
        .add(frame.states?.(layer)?.version ?? 0);
      const overlay = layer.type === "raster" && layer.source ? frame.sources.get(layer.source) : undefined;
      if (overlay instanceof ImageSource && !overlays.includes(overlay)) overlays.push(overlay);
      const pieces = this.piecesOf(frame, layer);
      if (pieces && !sources.includes(pieces)) sources.push(pieces);
      if (pieces && (layer.type === "circle" || layer.type === "heatmap")) pointSources.add(pieces);
    }
    const shared = common.value;
    for (const slot of terrain.slots) {
      const size = drapeSize(t, slot, frame.pixelRatio);
      const view = new SlotView(slot, zoom, bearing, 512 * 2 ** (zoom - slot.z));
      const signature = this.drapeSignature(shared, sources, pointSources, overlays, view, size);
      const current = this.drapes.lookup(slot.key);
      const drawn = current !== undefined && !Number.isNaN(current.signature);
      if (drawn && current.size === size && current.signature === signature && Math.abs(current.zoom - zoom) < 0.05)
        continue;
      if (performance.now() > deadline && (drawn || this.drapeFallback(slot))) {
        this.drapesBehind = true;
        continue;
      }
      const entry = this.drapes.target(slot.key, size);
      gl.bindFramebuffer(gl.FRAMEBUFFER, entry.framebuffer);
      g.setViewport(0, 0, size, size);
      g.setDepth(false, false);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const sub: FrameInput = {
        ...frame,
        view,
        pixelRatio: size / view.width,
        target: [size, size],
        framebuffer: entry.framebuffer,
        terrain: null,
        accept: (piece) => view.overlaps(piece.tile.z, piece.tile.x, piece.tile.y, piece.wrap),
        acceptNear: (piece) => view.overlaps(piece.tile.z, piece.tile.x, piece.tile.y, piece.wrap, POINT_MARGIN),
        region: view.rect,
      };
      for (const layer of layers) this.drawLayer(sub, layer);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      entry.signature = signature;
      entry.zoom = zoom;
      this.stats.drapes++;
    }
    this.drapes.trim(DRAPE_CACHE_BYTES);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private drapeFallback(slot: TerrainSlot): { entry: DrapeEntry; rect: [number, number, number, number] } | null {
    for (let dz = 1; dz <= 4 && dz <= slot.z; dz++) {
      const n = 2 ** dz;
      const x = Math.floor(slot.x / n);
      const y = Math.floor(slot.y / n);
      const entry = this.drapes.lookup(`${slot.z - dz}/${x}/${y}/${slot.wrap}`);
      if (entry && !Number.isNaN(entry.signature)) {
        return { entry, rect: [(slot.x - x * n) / n, (slot.y - y * n) / n, 1 / n, 1 / n] };
      }
    }
    return null;
  }

  private drapeSignature(
    shared: number,
    sources: readonly (readonly RenderPiece<unknown>[])[],
    pointSources: ReadonlySet<readonly RenderPiece<unknown>[]>,
    overlays: readonly ImageSource[],
    view: SlotView,
    size: number,
  ): number {
    const h = this.hash.reset().add(shared).add(size);
    for (let i = 0; i < overlays.length; i++) {
      const overlay = overlays[i]!;
      if (overlayWraps(overlay.worldBounds, view.rect, true).length > 0) h.add(i).add(overlay.version);
    }
    for (const pieces of sources) {
      const margin = pointSources.has(pieces) ? POINT_MARGIN : 0;
      for (const p of pieces) {
        const tile = p.tile;
        if (!view.overlaps(tile.z, tile.x, tile.y, p.wrap, margin)) continue;
        h.add(tile.key).add(tile.revision).add(p.opacity).add(p.wrap).add(p.clip.x0).add(p.clip.y0).add(p.clip.x1);
      }
      h.add(-1);
    }
    return h.value;
  }

  private piecesOf(frame: FrameInput, layer: StyleLayer): readonly RenderPiece<unknown>[] | null {
    const source = layer.source ? frame.sources.get(layer.source) : undefined;
    if (layer.type === "raster")
      return source?.type === "raster" ? ((source as RasterSource).manager?.pieces ?? null) : null;
    if (layer.type === "hillshade")
      return source?.type === "dem" ? ((source as DemSource).manager?.pieces ?? null) : null;
    if (layer.type === "background") return null;
    return vectorManager(source)?.pieces ?? null;
  }

  private drawTerrain(frame: FrameInput, terrain: Terrain): void {
    const g = this.gl;
    const gl = g.gl;
    const t = frame.transform;
    const mesh = this.terrainMesh();
    if (!mesh) return;
    const program = g.program(terrainShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(true, true);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1i(uniform(program, "u_drape"), 0);
    gl.uniform1i(uniform(program, "u_dem"), 1);
    gl.uniform1f(uniform(program, "u_world"), t.worldSize);
    gl.uniform1f(uniform(program, "u_exaggeration"), terrain.exaggeration);
    const uMatrix = uniform(program, "u_matrix");
    const uRect = uniform(program, "u_dem_rect");
    const uSize = uniform(program, "u_dem_size");
    const uHas = uniform(program, "u_has_dem");
    const uRows = uniform(program, "u_rows");
    const uSkirt = uniform(program, "u_skirt");
    const uDrapeRect = uniform(program, "u_drape_rect");
    const pixelsPerMeter = t.pixelsPerMeter * terrain.exaggeration;
    gl.bindVertexArray(mesh.vao);
    for (const slot of terrain.slots) {
      let entry = this.drapes.lookup(slot.key);
      let rect: readonly [number, number, number, number] = [0, 0, 1, 1];
      if (!entry || Number.isNaN(entry.signature)) {
        const fallback = this.drapeFallback(slot);
        if (!fallback) continue;
        entry = fallback.entry;
        rect = fallback.rect;
      }
      gl.uniform4f(uDrapeRect, rect[0], rect[1], rect[2], rect[3]);
      const data = slot.dem?.data ?? null;
      const dem = data ? terrain.source.elevationTexture(data) : null;
      g.bindTexture(0, entry.texture);
      g.bindTexture(1, dem ?? this.flatDem);
      const n = 2 ** slot.z;
      t.tileMatrix(slot.z, slot.x, slot.y, slot.wrap, 1, this.matrix);
      gl.uniformMatrix4fv(uMatrix, false, this.matrix);
      const r = slot.rect;
      gl.uniform4f(uRect, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      gl.uniform1f(uSize, data ? data.grid.size : 1);
      gl.uniform1f(uHas, dem ? 1 : 0);
      gl.uniform2f(uRows, slot.y / n, (slot.y + 1) / n);
      const range = data ? data.grid.max - data.grid.min : 0;
      gl.uniform1f(uSkirt, Math.max(30, range * 0.2) * pixelsPerMeter);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      this.stats.drawCalls++;
      this.stats.pieces++;
    }
    g.bindTexture(1, null);
    gl.activeTexture(gl.TEXTURE0);
    g.setDepth(false, false);
  }

  private terrainMesh(): TerrainGeometry | null {
    if (this.terrainGeometry) return this.terrainGeometry;
    const g = this.gl;
    const gl = g.gl;
    if (g.isLost) return null;
    const mesh = terrainMesh();
    const vao = gl.createVertexArray();
    if (!vao) return null;
    gl.bindVertexArray(vao);
    const vertices = g.createBuffer(gl.ARRAY_BUFFER, mesh.vertices);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.SHORT, false, 8, 0);
    const indices = g.createBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    gl.bindVertexArray(null);
    this.terrainGeometry = { vao, vertices, indices, count: mesh.indices.length };
    return this.terrainGeometry;
  }

  async pick(
    frame: FrameInput,
    box: PickBox,
    accept: (layer: StyleLayer) => boolean,
    ground?: { frame: FrameInput; box: PickBox },
  ): Promise<PickedFeature[]> {
    if (this.gl.isLost) return [];
    const zoom = frame.transform.zoom;
    const main = pickSetup(frame, box);
    const flat = ground ? pickSetup(ground.frame, ground.box) : main;
    const stats: PaintStats = { drawCalls: 0, pieces: 0, drapes: 0 };
    const found: PickedFeature[] = [];
    const reads: {
      layer: StyleLayer;
      draws: { piece: RenderPiece<VectorTile>; bucket: VectorBucket }[];
      read: PendingRead | null;
    }[] = [];
    let bound: PickSetup | null = null;
    try {
      for (let i = frame.layers.length - 1; i >= 0; i--) {
        const layer = frame.layers[i]!;
        if (!layer.isVisible(zoom) || !accept(layer)) continue;
        if (layer.type !== "fill" && layer.type !== "line" && layer.type !== "circle" && layer.type !== "extrusion")
          continue;
        const manager = vectorManager(layer.source ? frame.sources.get(layer.source) : undefined);
        if (!manager) continue;
        const draped = layer.type !== "extrusion";
        const setup = draped ? flat : main;
        const input = draped && ground ? ground.frame : frame;
        if (setup !== bound) {
          this.pickBuffer.begin(setup.width, setup.height);
          bound = setup;
        }
        const draws: { piece: RenderPiece<VectorTile>; bucket: VectorBucket }[] = [];
        const pass: PickPass = {
          clip: setup.clip,
          scale: setup.scale,
          register: (piece, bucket) => draws.push({ piece, bucket }),
        };
        this.pickBuffer.clear();
        this.vector.draw(input, layer, manager, stats, pass);
        if (draws.length === 0) continue;
        reads.push({ layer, draws, read: this.pickBuffer.copy() });
      }
    } finally {
      if (bound) this.pickBuffer.end();
    }
    const labels = this.labels.hits(box, (layer) => layer.isVisible(zoom) && accept(layer));
    const results = reads.length > 0 ? await this.pickBuffer.collect(reads.map((r) => r.read)) : [];
    for (let r = 0; r < reads.length; r++) {
      const pixels = results[r];
      if (!pixels) continue;
      const { layer, draws } = reads[r]!;
      const seen = new Set<number>();
      for (let p = 0; p < pixels.length; p += 4) {
        const draw = pixels[p]!;
        if (draw === 0) continue;
        const feature = pixels[p + 1]!;
        const key = draw * 4294967296 + feature;
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = draws[draw - 1];
        if (hit) found.push({ layer, tile: hit.piece.tile, bucket: hit.bucket, feature });
      }
    }
    const order = new Map(frame.layers.map((l, i) => [l, i]));
    return [...labels, ...found].sort((a, b) => (order.get(b.layer) ?? 0) - (order.get(a.layer) ?? 0));
  }

  destroy(): void {
    this.pickBuffer.destroy();
    this.labels.destroy();
    this.vector.destroy();
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteVertexArray(this.quadVao);
    this.gl.deleteTexture(this.openMask);
    this.gl.deleteTexture(this.flatDem);
    this.drapes.destroy();
    const terrain = this.terrainGeometry;
    if (terrain) {
      this.gl.deleteVertexArray(terrain.vao);
      this.gl.deleteBuffer(terrain.vertices);
      this.gl.deleteBuffer(terrain.indices);
    }
    this.terrainGeometry = null;
    this.quadBuffer = null;
    this.quadVao = null;
    this.openMask = null;
    this.flatDem = null;
  }

  private backgroundColor(layer: StyleLayer, zoom: number): RGBA {
    const ctx = { zoom };
    return premultiply(layer.paintValue<RGBA>("color", ctx), layer.paintValue<number>("opacity", ctx));
  }

  private drawSolid(color: RGBA): void {
    if (color[3] <= 0) return;
    const g = this.gl;
    const gl = g.gl;
    const program = g.program(solidShader);
    g.use(program);
    g.setBlend("premultiplied");
    gl.uniform4f(uniform(program, "u_color"), color[0], color[1], color[2], color[3]);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.drawCalls++;
  }

  private drawHillshade(frame: FrameInput, layer: StyleLayer, source: DemSource): void {
    const manager = source.manager;
    if (!manager || manager.pieces.length === 0) return;
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.view.zoom;
    const ctx = { zoom };
    const exaggeration = Math.min(1, Math.max(0, layer.paintValue<number>("exaggeration", ctx)));
    if (exaggeration <= 0) return;
    const program = g.program(hillshadeShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    const anchor = layer.fixed<string>("illuminationAnchor") === "map" ? 0 : frame.view.bearing;
    const azimuth = (layer.fixed<number>("illuminationDirection") + anchor) * DEG;
    const level = Math.cos(LIGHT_ALTITUDE);
    gl.uniform3f(
      uniform(program, "u_light"),
      Math.sin(azimuth) * level,
      -Math.cos(azimuth) * level,
      Math.sin(LIGHT_ALTITUDE),
    );
    gl.uniform1f(uniform(program, "u_flat"), Math.sin(LIGHT_ALTITUDE));
    gl.uniform1f(uniform(program, "u_gain"), 1.2 * exaggeration);
    for (const [name, property] of [
      ["u_shadow", "shadowColor"],
      ["u_highlight", "highlightColor"],
      ["u_accent", "accentColor"],
    ] as const) {
      const c = premultiply(layer.paintValue<RGBA>(property, ctx), 1);
      gl.uniform4f(uniform(program, name), c[0], c[1], c[2], c[3]);
    }
    gl.uniform1i(uniform(program, "u_gradient"), 0);
    gl.uniform1i(uniform(program, "u_mask"), 1);
    gl.bindVertexArray(this.quadVao);
    const uMatrix = uniform(program, "u_matrix");
    const uClip = uniform(program, "u_clip");
    const uOpacity = uniform(program, "u_opacity");
    const uTexel = uniform(program, "u_texel");
    const uRows = uniform(program, "u_rows");
    const uScale = uniform(program, "u_scale");
    const vertical = (0.5 + exaggeration) * hillshadeBoost(zoom);
    for (const piece of manager.pieces) {
      const data = piece.tile.data;
      if (!data?.gradientTexture || (frame.accept && !frame.accept(piece))) continue;
      const { z, x, y } = piece.tile;
      const n = 2 ** z;
      const size = data.grid.size;
      g.bindTexture(0, data.gradientTexture);
      g.bindTexture(1, data.maskTexture ?? this.openMask);
      frame.view.tileMatrix(z, x, y, piece.wrap, 1, this.matrix);
      gl.uniformMatrix4fv(uMatrix, false, this.matrix);
      gl.uniform4f(uClip, piece.clip.x0, piece.clip.y0, piece.clip.x1, piece.clip.y1);
      gl.uniform1f(uOpacity, piece.opacity);
      gl.uniform2f(uTexel, size / (size + 2), 1 / (size + 2));
      gl.uniform2f(uRows, y / n, (y + 1) / n);
      gl.uniform1f(uScale, (vertical * n * size) / EARTH_CIRCUMFERENCE);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.stats.drawCalls++;
      this.stats.pieces++;
    }
    g.bindTexture(1, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  private rasterColors(program: Program, layer: StyleLayer, zoom: number): void {
    const gl = this.gl.gl;
    const ctx = { zoom };
    const contrast = Math.max(-1, Math.min(0.99, layer.paintValue<number>("contrast", ctx)));
    gl.uniform1f(
      uniform(program, "u_saturation"),
      Math.max(-1, Math.min(1, layer.paintValue<number>("saturation", ctx))),
    );
    gl.uniform1f(uniform(program, "u_contrast"), contrast > 0 ? 1 / (1 - contrast) : 1 + contrast);
    gl.uniform2f(
      uniform(program, "u_brightness"),
      layer.paintValue<number>("brightnessMin", ctx),
      layer.paintValue<number>("brightnessMax", ctx),
    );
    hueMatrix(layer.paintValue<number>("hueRotate", ctx), this.hue);
    gl.uniformMatrix3fv(uniform(program, "u_hue"), false, this.hue);
    gl.uniform1i(uniform(program, "u_image"), 0);
  }

  private drawOverlay(frame: FrameInput, layer: StyleLayer, source: ImageSource): void {
    const texture = source.textureFor();
    const mesh = source.meshFor();
    if (!texture || !mesh) return;
    const zoom = frame.view.zoom;
    const opacity = layer.paintValue<number>("opacity", { zoom });
    if (opacity <= 0) return;
    const wraps = overlayWraps(
      source.worldBounds,
      frame.region ?? footprintRect(frame.transform),
      frame.transform.renderWorldCopies,
    );
    if (wraps.length === 0) return;
    const g = this.gl;
    const gl = g.gl;
    const program = g.program(overlayShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    this.rasterColors(program, layer, zoom);
    gl.uniform1f(uniform(program, "u_opacity"), opacity);
    g.bindTexture(0, texture);
    const nearest = layer.fixed<string>("resampling") === "nearest";
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.bindVertexArray(mesh.vao);
    const uMatrix = uniform(program, "u_matrix");
    for (const wrap of wraps) {
      frame.view.tileMatrix(mesh.z, mesh.x, mesh.y, wrap, 1, this.matrix);
      gl.uniformMatrix4fv(uMatrix, false, this.matrix);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      this.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
  }

  private drawRaster(frame: FrameInput, layer: StyleLayer, source: RasterSource): void {
    const manager = source.manager;
    if (!manager || manager.pieces.length === 0) return;
    const g = this.gl;
    const gl = g.gl;
    const ctx = { zoom: frame.view.zoom };
    const opacity = layer.paintValue<number>("opacity", ctx);
    if (opacity <= 0) return;
    const program = g.program(rasterShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    this.rasterColors(program, layer, frame.view.zoom);
    const nearest = layer.fixed<string>("resampling") === "nearest";
    gl.bindVertexArray(this.quadVao);
    const uMatrix = uniform(program, "u_matrix");
    const uClip = uniform(program, "u_clip");
    const uOpacity = uniform(program, "u_opacity");
    for (const piece of manager.pieces) {
      const texture = piece.tile.data?.texture;
      if (!texture || (frame.accept && !frame.accept(piece))) continue;
      g.bindTexture(0, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      frame.view.tileMatrix(piece.tile.z, piece.tile.x, piece.tile.y, piece.wrap, 1, this.matrix);
      gl.uniformMatrix4fv(uMatrix, false, this.matrix);
      gl.uniform4f(uClip, piece.clip.x0, piece.clip.y0, piece.clip.x1, piece.clip.y1);
      gl.uniform1f(uOpacity, opacity * piece.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.stats.drawCalls++;
      this.stats.pieces++;
    }
  }
}

const DEG = Math.PI / 180;
const LIGHT_ALTITUDE = 45 * DEG;

export function hillshadeBoost(zoom: number): number {
  return 2 ** (0.3 * Math.max(0, 12 - zoom));
}

function uniform(program: Program, name: string): WebGLUniformLocation | null {
  return program.uniforms.get(name) ?? null;
}

export function hueMatrix(degrees: number, out: Float32Array): Float32Array {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const k = (1 - c) / 3;
  const r = Math.sin(a) / Math.sqrt(3);
  out[0] = c + k;
  out[1] = k + r;
  out[2] = k - r;
  out[3] = k - r;
  out[4] = c + k;
  out[5] = k + r;
  out[6] = k + r;
  out[7] = k - r;
  out[8] = c + k;
  return out;
}

function vectorManager(source: MapSource | undefined): TileManager<VectorTile> | null {
  return isVectorTileSource(source) ? source.manager : null;
}

function footprintRect(transform: Transform): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of transform.footprint()) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}
