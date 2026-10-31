import type { Transform } from "../camera/transform.ts";
import * as mat4 from "../geo/mat4.ts";
import { EARTH_CIRCUMFERENCE } from "../geo/mercator.ts";
import type { DemSource, DemTile } from "../sources/dem.ts";
import { ImageSource, overlayWraps } from "../sources/image.ts";
import type { RasterSource } from "../sources/raster.ts";
import type { MapSource } from "../sources/source.ts";
import type { VectorBucket, VectorTile } from "../sources/vector.ts";
import { isVectorTileSource } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import { premultiply } from "../style/color.ts";
import type { StateLookup } from "../style/feature-state.ts";
import type { CustomLayerInput, StyleLayer } from "../style/layer.ts";
import type { SkySpec } from "../style/types.ts";
import { GRID, terrainMesh } from "../terrain/mesh.ts";
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
import type { SunLook } from "./night.ts";
import { NightPainter, nightInView, nightShader } from "./night.ts";
import type { PendingRead } from "./pick.ts";
import { PickBuffer } from "./pick.ts";
import { atmosphereShader, poleShader } from "./shaders/globe.ts";
import { hillshadeShader } from "./shaders/hillshade.ts";
import { overlayShader, rasterShader, solidShader } from "./shaders/raster.ts";
import { globeSurfaceShader, terrainShader } from "./shaders/terrain.ts";
import { circleShader, extrusionShader, fillOutlineShader, fillShader, lineShader } from "./shaders/vector.ts";
import { SkyPainter, skyInView, skyLook, skyShader } from "./sky.ts";
import type { PickPass } from "./vector-layers.ts";
import { VectorPainter, WARM_VARIANTS } from "./vector-layers.ts";

export interface FrameInput {
  readonly transform: Transform;
  readonly view: RenderView;
  readonly target?: readonly [number, number];
  readonly framebuffer?: WebGLFramebuffer | null;
  readonly terrain?: Terrain | null;
  readonly surface?: Surface | null;
  readonly accept?: (piece: RenderPiece<unknown>) => boolean;
  readonly acceptNear?: (piece: RenderPiece<unknown>) => boolean;
  readonly region?: readonly [number, number, number, number];
  readonly states?: ((layer: StyleLayer) => StateLookup | null) | undefined;
  readonly pixelRatio: number;
  readonly layers: readonly StyleLayer[];
  readonly sources: ReadonlyMap<string, MapSource>;
  readonly sky?: SkySpec | null;
  readonly sun?: SunLook | null;
  readonly now: number;
  readonly cameraVersion: number;
  readonly moving?: boolean;
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

interface PickRead {
  layer: StyleLayer;
  draws: { piece: RenderPiece<VectorTile>; bucket: VectorBucket }[];
  read: PendingRead | null;
  pixels: Uint32Array | null;
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

export interface Surface {
  readonly slots: readonly TerrainSlot[];
  readonly exaggeration: number;
  readonly relief: number;
  readonly source: { elevationTexture(data: DemTile): WebGLTexture | null } | null;
}

const SPACE: RGBA = [0.035, 0.045, 0.085, 1];
const GLOBE_LAND: RGBA = [0.86, 0.88, 0.9, 1];
const POLE_SAMPLES = 16;

function spread<T>(list: readonly T[], count: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(list[Math.floor(((i + 0.5) * list.length) / count)]!);
  return out;
}

function over(top: RGBA, bottom: RGBA): RGBA {
  const k = 1 - top[3];
  return [top[0] + bottom[0] * k, top[1] + bottom[1] * k, top[2] + bottom[2] * k, top[3] + bottom[3] * k];
}

const POINT_MARGIN = 0.125;
const MERCATOR_Z = (2 * Math.PI * 6371008.8) / EARTH_CIRCUMFERENCE;

function customInput(t: Transform): Float64Array & CustomLayerInput {
  const ws = t.worldSize;
  const matrix = mat4.scale(new Float64Array(16), t.pixelMatrix, ws, ws, ws * MERCATOR_Z) as Float64Array &
    Record<string, unknown>;
  const projection = Float64Array.from(t.projMatrix);
  const fov = (t.fov * Math.PI) / 180;
  const extra: Record<string, unknown> = {
    matrix,
    modelViewProjectionMatrix: matrix,
    projection,
    projectionMatrix: projection,
    fov,
    nearZ: t.near,
    farZ: t.far,
    defaultProjectionData: {
      mainMatrix: matrix,
      fallbackMatrix: matrix,
      tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [1, 1, 1, 1],
      projectionTransition: 0,
    },
  };
  for (const [key, value] of Object.entries(extra)) {
    Object.defineProperty(matrix, key, { value, enumerable: false });
  }
  return matrix as unknown as Float64Array & CustomLayerInput;
}
const DRAPED: ReadonlySet<string> = new Set(["background", "raster", "hillshade", "fill", "line", "circle", "heatmap"]);
const SCREEN_SIZED: ReadonlySet<string> = new Set(["hillshade", "line", "circle", "heatmap"]);
const RESTING_ZOOM_STEP = 0.05;
const MOVING_ZOOM_STEP = 0.25;
const MOVING_DRAPES = 6;

function drapeFollowsZoom(layer: StyleLayer): boolean {
  if (layer.usesZoom || SCREEN_SIZED.has(layer.type)) return true;
  if (layer.type !== "fill" && layer.type !== "background") return false;
  return Boolean((layer.spec as { paint?: { pattern?: unknown } }).paint?.pattern);
}
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
  if (t.globeness > 0) {
    const pixels = Math.sqrt(t.tileArea(slot.z, slot.x, slot.y, slot.wrap)) * pixelRatio;
    return pixels > 600 ? 1024 : pixels > 300 ? 512 : 256;
  }
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
  private capGeometry: TerrainGeometry | null = null;
  private blankDrape: WebGLTexture | null = null;
  private poleTarget: { texture: WebGLTexture; framebuffer: WebGLFramebuffer } | null = null;
  private readonly drapes: DrapeCache;
  private readonly hash = new Hash();
  private drapesBehind = false;
  private readonly matrix = new Float32Array(16);
  private readonly hue = new Float32Array(9);
  private readonly vector: VectorPainter;
  private readonly sky: SkyPainter;
  private readonly night: NightPainter;
  readonly labels: LabelRenderer;

  get images(): ImageAtlas {
    return this.labels.images;
  }
  private readonly pickBuffer: PickBuffer;
  private readonly customFailures = new Set<number>();

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
    this.sky = new SkyPainter(gl);
    this.night = new NightPainter(gl);
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
    this.capGeometry = null;
    this.blankDrape = null;
    this.poleTarget = null;
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
      skyShader,
      nightShader,
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
    const surface = frame.surface ?? terrain;
    const globe = surface !== null && frame.transform.globeness > 0;
    if (surface) this.renderDrapes(frame, surface);
    else if (this.drapes.count > 0) this.drapes.destroy();
    this.prerenderCustom(frame);
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
    if (surface) {
      if (globe && !frame.framebuffer) this.drawAtmosphere(frame, clear);
      this.drawTerrain(frame, surface, globe ? clear : null);
      for (const layer of layers) {
        if ((layer.type === "extrusion" || layer.type === "custom") && layer.isVisible(zoom))
          this.drawLayer(frame, layer);
      }
    } else {
      for (let i = start; i < layers.length; i++) {
        const layer = layers[i]!;
        if (layer.isVisible(zoom)) this.drawLayer(frame, layer);
      }
    }
    const fog =
      terrain !== null && !globe && frame.sky !== undefined && frame.sky !== null && frame.transform.pitch > 0;
    if (!frame.framebuffer && !globe && (fog || skyInView(frame.transform))) {
      this.sky.draw(frame.transform, skyLook(frame.sky, zoom, clear), fog, this.quadVao);
      this.stats.drawCalls++;
    }
    if (frame.sun && !frame.framebuffer && !globe && nightInView(frame.transform, frame.sun)) {
      this.night.draw(frame.transform, frame.sun, this.quadVao);
      this.stats.drawCalls++;
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
    const globe = transform.globeness > 0;
    return {
      height: (x, y) => terrain.heightAt(x, y),
      hidden: (x, y, z) => !globe && terrain.hidden(camera, x, y, z),
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
      case "custom":
        this.drawCustom(frame, layer);
        break;
      default:
        break;
    }
  }

  private prerenderCustom(frame: FrameInput): void {
    const zoom = frame.view.zoom;
    let input: (Float64Array & CustomLayerInput) | null = null;
    for (const layer of frame.layers) {
      const custom = layer.custom;
      if (!custom?.prerender || !layer.isVisible(zoom)) continue;
      input ??= customInput(frame.transform);
      this.runCustom(frame, () => custom.prerender?.(this.gl.gl, input!), layer);
    }
  }

  private drawCustom(frame: FrameInput, layer: StyleLayer): void {
    const custom = layer.custom;
    if (!custom) return;
    const g = this.gl;
    const input = customInput(frame.transform);
    g.setStencil(false);
    g.setBlend("premultiplied");
    if (custom.renderingMode === "3d") g.setDepth(true, true);
    else g.setDepth(false, false);
    this.runCustom(frame, () => custom.render(g.gl, input), layer);
    this.stats.drawCalls++;
  }

  private runCustom(frame: FrameInput, run: () => void, layer: StyleLayer): void {
    const g = this.gl;
    const gl = g.gl;
    try {
      run();
    } catch (error) {
      if (!this.customFailures.has(layer.uid)) {
        this.customFailures.add(layer.uid);
        setTimeout(() => {
          throw error;
        }, 0);
      }
    }
    g.resetState();
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer ?? null);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.colorMask(true, true, true, true);
    gl.depthFunc(gl.LEQUAL);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    gl.blendEquation(gl.FUNC_ADD);
    gl.stencilMask(0xff);
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const target = frame.target;
    if (target) g.setViewport(0, 0, target[0], target[1]);
    else g.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }

  private renderDrapes(frame: FrameInput, terrain: Surface): void {
    const g = this.gl;
    const gl = g.gl;
    const t = frame.transform;
    const zoom = t.zoom;
    const layers = frame.layers.filter((l) => DRAPED.has(l.type) && l.isVisible(zoom));
    const turning = layers.some((l) => l.type === "hillshade" && l.fixed<string>("illuminationAnchor") !== "map");
    const bearing = turning ? Math.round(t.bearing / 4) * 4 : 0;
    const deadline = performance.now() + 6;
    const zoomed = layers.some(drapeFollowsZoom);
    const tolerance = !zoomed ? Number.POSITIVE_INFINITY : frame.moving ? MOVING_ZOOM_STEP : RESTING_ZOOM_STEP;
    let redrawn = 0;
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
      const drift = drawn ? Math.abs(current.zoom - zoom) : 0;
      if (drawn && current.size === size && current.signature === signature && drift < tolerance) {
        if (drift >= RESTING_ZOOM_STEP && tolerance !== Number.POSITIVE_INFINITY) this.drapesBehind = true;
        continue;
      }
      const busy = performance.now() > deadline || (frame.moving === true && redrawn >= MOVING_DRAPES);
      if (busy && (drawn || this.drapeFallback(slot))) {
        this.drapesBehind = true;
        continue;
      }
      redrawn++;
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

  private drawTerrain(frame: FrameInput, terrain: Surface, blank: RGBA | null): void {
    const g = this.gl;
    const gl = g.gl;
    const t = frame.transform;
    const mesh = this.terrainMesh();
    if (!mesh) return;
    if (blank) {
      this.drawGlobe(frame, terrain, mesh, blank);
      return;
    }
    const program = g.program(terrainShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(true, true);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1i(uniform(program, "u_drape"), 0);
    gl.uniform1i(uniform(program, "u_dem"), 1);
    gl.uniform1i(uniform(program, "u_gradient"), 2);
    gl.uniform1f(uniform(program, "u_world"), t.worldSize);
    gl.uniform1f(uniform(program, "u_exaggeration"), terrain.exaggeration);
    const sunLight = frame.sun?.light ?? null;
    const light = sunLight ?? (terrain.relief > 0 ? reliefLight(t.bearing) : null);
    gl.uniform3f(uniform(program, "u_sun_light"), light?.[0] ?? 0, light?.[1] ?? 0, light?.[2] ?? 1);
    gl.uniform1f(uniform(program, "u_sun_gain"), sunLight ? 0.7 : light ? terrain.relief : 0);
    const uGradientTexel = uniform(program, "u_gradient_texel");
    const uGradientScale = uniform(program, "u_gradient_scale");
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
      const dem = data ? (terrain.source?.elevationTexture(data) ?? null) : null;
      g.bindTexture(0, entry.texture);
      g.bindTexture(1, dem ?? this.flatDem);
      g.bindTexture(2, data?.gradientTexture ?? this.flatDem);
      const n = 2 ** slot.z;
      t.tileMatrix(slot.z, slot.x, slot.y, slot.wrap, 1, this.matrix);
      gl.uniformMatrix4fv(uMatrix, false, this.matrix);
      const r = slot.rect;
      gl.uniform4f(uRect, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      gl.uniform1f(uSize, data ? data.grid.size : 1);
      const cells = data ? data.grid.size : 1;
      gl.uniform2f(uGradientTexel, cells / (cells + 2), 1 / (cells + 2));
      gl.uniform1f(uGradientScale, data ? (2 ** data.z * cells) / EARTH_CIRCUMFERENCE : 0);
      gl.uniform1f(uHas, dem ? 1 : 0);
      gl.uniform2f(uRows, slot.y / n, (slot.y + 1) / n);
      const range = data ? data.grid.max - data.grid.min : 0;
      gl.uniform1f(uSkirt, Math.max(30, range * 0.2) * pixelsPerMeter);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      this.stats.drawCalls++;
      this.stats.pieces++;
    }
    g.bindTexture(2, null);
    g.bindTexture(1, null);
    gl.activeTexture(gl.TEXTURE0);
    g.setDepth(false, false);
  }

  private drawGlobe(frame: FrameInput, terrain: Surface, mesh: TerrainGeometry, blank: RGBA): void {
    const g = this.gl;
    const gl = g.gl;
    const t = frame.transform;
    const caps = this.capMesh();
    const empty = this.emptyDrape();
    if (!caps || !empty) return;
    const poles = this.averagePoles(frame, terrain, empty);
    const program = g.program(globeSurfaceShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(true, true);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1i(uniform(program, "u_drape"), 0);
    gl.uniform1i(uniform(program, "u_dem"), 1);
    gl.uniform1i(uniform(program, "u_gradient"), 2);
    gl.uniform1i(uniform(program, "u_pole"), 3);
    g.bindTexture(3, poles);
    const ws = t.worldSize;
    gl.uniform1f(uniform(program, "u_world"), ws);
    gl.uniform1f(uniform(program, "u_exaggeration"), terrain.exaggeration);
    const sunLight = frame.sun?.light ?? null;
    const light = sunLight ?? (terrain.relief > 0 ? reliefLight(t.bearing) : null);
    gl.uniform3f(uniform(program, "u_sun_light"), light?.[0] ?? 0, light?.[1] ?? 0, light?.[2] ?? 1);
    gl.uniform1f(uniform(program, "u_sun_gain"), sunLight ? 0.7 : light ? terrain.relief : 0);
    const [cx, cy] = t.centerWorld;
    const m = Math.PI * (1 - 2 * cy);
    gl.uniform4f(uniform(program, "u_globe"), t.globeness, t.globeRadius, ws, Math.cosh(m));
    gl.uniform3f(uniform(program, "u_globe_center"), cy, Math.tanh(m), 1 / Math.cosh(m));
    const base = blank[3] >= 0.999 ? blank : over(blank, GLOBE_LAND);
    gl.uniform4f(uniform(program, "u_base"), base[0], base[1], base[2], base[3]);
    mat4.toFloat32(t.globeMatrix, this.matrix);
    gl.uniformMatrix4fv(uniform(program, "u_matrix"), false, this.matrix);
    const uGradientTexel = uniform(program, "u_gradient_texel");
    const uGradientScale = uniform(program, "u_gradient_scale");
    const uRect = uniform(program, "u_dem_rect");
    const uSize = uniform(program, "u_dem_size");
    const uHas = uniform(program, "u_has_dem");
    const uRows = uniform(program, "u_rows");
    const uSkirt = uniform(program, "u_skirt");
    const uDrapeRect = uniform(program, "u_drape_rect");
    const uTile = uniform(program, "u_tile");
    const uCap = uniform(program, "u_cap");
    const uDrapeSize = uniform(program, "u_drape_size");
    for (const slot of terrain.slots) {
      const { texture, rect, size } = this.slotDrape(slot, empty);
      gl.uniform4f(uDrapeRect, rect[0], rect[1], rect[2], rect[3]);
      const data = slot.dem?.data ?? null;
      const dem = data ? (terrain.source?.elevationTexture(data) ?? null) : null;
      g.bindTexture(0, texture);
      g.bindTexture(1, dem ?? this.flatDem);
      g.bindTexture(2, data?.gradientTexture ?? this.flatDem);
      gl.uniform1f(uDrapeSize, size);
      const n = 2 ** slot.z;
      let rx = slot.wrap + slot.x / n - cx;
      rx -= Math.round(rx);
      gl.uniform3f(uTile, rx, slot.y / n - cy, 1 / n);
      const r = slot.rect;
      gl.uniform4f(uRect, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      gl.uniform1f(uSize, data ? data.grid.size : 1);
      const cells = data ? data.grid.size : 1;
      gl.uniform2f(uGradientTexel, cells / (cells + 2), 1 / (cells + 2));
      gl.uniform1f(uGradientScale, data ? (2 ** data.z * cells) / EARTH_CIRCUMFERENCE : 0);
      gl.uniform1f(uHas, dem ? 1 : 0);
      gl.uniform2f(uRows, slot.y / n, (slot.y + 1) / n);
      const range = data ? data.grid.max - data.grid.min : 0;
      gl.uniform1f(uSkirt, Math.max(30, range * 0.2) * Math.max(1, terrain.exaggeration));
      gl.uniform1f(uCap, 0);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      this.stats.drawCalls++;
      this.stats.pieces++;
      if (slot.y === 0 || slot.y === n - 1) {
        gl.uniform1f(uCap, 1);
        gl.bindVertexArray(caps.vao);
        const half = caps.count / 2;
        if (slot.y === 0) gl.drawElements(gl.TRIANGLES, half, gl.UNSIGNED_SHORT, 0);
        if (slot.y === n - 1) gl.drawElements(gl.TRIANGLES, half, gl.UNSIGNED_SHORT, half * 2);
        this.stats.drawCalls++;
      }
    }
    g.bindTexture(3, null);
    g.bindTexture(2, null);
    g.bindTexture(1, null);
    gl.activeTexture(gl.TEXTURE0);
    g.setDepth(false, false);
  }

  private slotDrape(
    slot: TerrainSlot,
    empty: WebGLTexture,
  ): { texture: WebGLTexture; rect: readonly [number, number, number, number]; size: number } {
    const entry = this.drapes.lookup(slot.key);
    if (entry && !Number.isNaN(entry.signature))
      return { texture: entry.texture, rect: [0, 0, 1, 1], size: entry.size };
    const fallback = this.drapeFallback(slot);
    if (fallback) return { texture: fallback.entry.texture, rect: fallback.rect, size: fallback.entry.size };
    return { texture: empty, rect: [0, 0, 1, 1], size: 1 };
  }

  private averagePoles(frame: FrameInput, terrain: Surface, empty: WebGLTexture): WebGLTexture | null {
    const g = this.gl;
    const gl = g.gl;
    let target = this.poleTarget;
    if (!target) {
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      if (!texture || !framebuffer) return null;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 2, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      target = { texture, framebuffer };
      this.poleTarget = target;
    }
    const north: TerrainSlot[] = [];
    const south: TerrainSlot[] = [];
    for (const slot of terrain.slots) {
      const n = 2 ** slot.z;
      if (slot.y === 0) north.push(slot);
      if (slot.y === n - 1) south.push(slot);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    g.setViewport(0, 0, 2, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (north.length > 0 || south.length > 0) {
      const program = g.program(poleShader);
      g.use(program);
      g.setBlend("additive");
      g.setDepth(false, false);
      gl.uniform1i(uniform(program, "u_drape"), 0);
      const uTarget = uniform(program, "u_target");
      const uRect = uniform(program, "u_drape_rect");
      const uRow = uniform(program, "u_row");
      const uLod = uniform(program, "u_lod");
      const uWeight = uniform(program, "u_weight");
      gl.bindVertexArray(this.quadVao);
      for (const [list, x, row] of [
        [north, -0.5, 1 / 16],
        [south, 0.5, 15 / 16],
      ] as const) {
        const picked = list.length <= POLE_SAMPLES ? list : spread(list, POLE_SAMPLES);
        gl.uniform1f(uTarget, x);
        gl.uniform1f(uRow, row);
        gl.uniform1f(uWeight, 1 / Math.max(1, picked.length));
        for (const slot of picked) {
          const { texture, rect, size } = this.slotDrape(slot, empty);
          g.bindTexture(0, texture);
          gl.uniform4f(uRect, rect[0], rect[1], rect[2], rect[3]);
          gl.uniform1f(uLod, Math.max(0, Math.log2(size) - 3));
          gl.drawArrays(gl.POINTS, 0, 1);
          this.stats.drawCalls++;
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer ?? null);
    const size = frame.target;
    if (size) g.setViewport(0, 0, size[0], size[1]);
    else g.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    return target.texture;
  }

  private drawAtmosphere(frame: FrameInput, background: RGBA): void {
    const g = this.gl;
    const gl = g.gl;
    const t = frame.transform;
    const program = g.program(atmosphereShader);
    g.use(program);
    g.setBlend("none");
    g.setDepth(false, false);
    mat4.toFloat32(t.globeMatrixInverse, this.matrix);
    gl.uniformMatrix4fv(uniform(program, "u_inverse"), false, this.matrix);
    const cam = t.globeCamera;
    gl.uniform3f(uniform(program, "u_camera"), cam[0], cam[1], cam[2]);
    gl.uniform1f(uniform(program, "u_radius"), t.globeRadius);
    const look = skyLook(frame.sky, t.zoom, background);
    gl.uniform4f(uniform(program, "u_space"), SPACE[0], SPACE[1], SPACE[2], SPACE[3]);
    gl.uniform4f(uniform(program, "u_glow"), look.horizon[0], look.horizon[1], look.horizon[2], look.horizon[3]);
    gl.uniform4f(uniform(program, "u_sky"), look.sky[0], look.sky[1], look.sky[2], look.sky[3]);
    const day = Math.min(1, Math.max(0, (t.zoom - 5) / 4));
    gl.uniform1f(uniform(program, "u_daylight"), day * day * (3 - 2 * day));
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.drawCalls++;
  }

  private emptyDrape(): WebGLTexture | null {
    if (this.blankDrape) return this.blankDrape;
    const g = this.gl;
    if (g.isLost) return null;
    const gl = g.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.blankDrape = texture;
    return texture;
  }

  private capMesh(): TerrainGeometry | null {
    if (this.capGeometry) return this.capGeometry;
    const g = this.gl;
    const gl = g.gl;
    if (g.isLost) return null;
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const row of [0, GRID]) {
      const base = vertices.length / 4;
      for (let i = 0; i <= GRID; i++) vertices.push(i, row, 0, 0, i, row, 0, 1);
      for (let k = 0; k < GRID; k++) {
        const edge = base + k * 2;
        indices.push(edge, edge + 1, edge + 2, edge + 2, edge + 1, edge + 3);
      }
    }
    const vao = gl.createVertexArray();
    if (!vao) return null;
    gl.bindVertexArray(vao);
    const buffer = g.createBuffer(gl.ARRAY_BUFFER, Int16Array.from(vertices));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.SHORT, false, 8, 0);
    const index = g.createBuffer(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(indices));
    gl.bindVertexArray(null);
    this.capGeometry = { vao, vertices: buffer, indices: index, count: indices.length };
    return this.capGeometry;
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
    const reads = this.pickLayers(frame, box, accept, ground, false);
    const labels = this.labels.hits(box, (layer) => layer.isVisible(frame.transform.zoom) && accept(layer));
    const results = reads.length > 0 ? await this.pickBuffer.collect(reads.map((r) => r.read)) : [];
    return this.pickHits(frame, labels, reads, results);
  }

  pickSync(
    frame: FrameInput,
    box: PickBox,
    accept: (layer: StyleLayer) => boolean,
    ground?: { frame: FrameInput; box: PickBox },
  ): PickedFeature[] {
    if (this.gl.isLost) return [];
    const reads = this.pickLayers(frame, box, accept, ground, true);
    const labels = this.labels.hits(box, (layer) => layer.isVisible(frame.transform.zoom) && accept(layer));
    return this.pickHits(
      frame,
      labels,
      reads,
      reads.map((r) => r.pixels),
    );
  }

  private pickHits(
    frame: FrameInput,
    labels: PickedFeature[],
    reads: readonly PickRead[],
    results: readonly (Uint32Array | null)[],
  ): PickedFeature[] {
    const found: PickedFeature[] = [];
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

  private pickLayers(
    frame: FrameInput,
    box: PickBox,
    accept: (layer: StyleLayer) => boolean,
    ground: { frame: FrameInput; box: PickBox } | undefined,
    sync: boolean,
  ): PickRead[] {
    const zoom = frame.transform.zoom;
    const main = pickSetup(frame, box);
    const flat = ground ? pickSetup(ground.frame, ground.box) : main;
    const stats: PaintStats = { drawCalls: 0, pieces: 0, drapes: 0 };
    const reads: PickRead[] = [];
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
        if (sync) reads.push({ layer, draws, read: null, pixels: this.pickBuffer.read().slice() });
        else reads.push({ layer, draws, read: this.pickBuffer.copy(), pixels: null });
      }
    } finally {
      if (bound) this.pickBuffer.end();
    }
    return reads;
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
    const caps = this.capGeometry;
    if (caps) {
      this.gl.deleteVertexArray(caps.vao);
      this.gl.deleteBuffer(caps.vertices);
      this.gl.deleteBuffer(caps.indices);
    }
    this.capGeometry = null;
    this.gl.deleteTexture(this.blankDrape);
    this.blankDrape = null;
    if (this.poleTarget) {
      this.gl.deleteTexture(this.poleTarget.texture);
      this.gl.gl.deleteFramebuffer(this.poleTarget.framebuffer);
    }
    this.poleTarget = null;
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
    const sunLight = frame.sun?.light;
    if (sunLight) {
      gl.uniform3f(uniform(program, "u_light"), sunLight[0], sunLight[1], sunLight[2]);
      gl.uniform1f(uniform(program, "u_flat"), sunLight[2]);
    } else {
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
    }
    gl.uniform1f(uniform(program, "u_gain"), 1.2 * exaggeration);
    const standard = layer.fixed<string>("method") === "standard";
    gl.uniform1i(uniform(program, "u_method"), standard ? 1 : 0);
    gl.uniform1f(uniform(program, "u_intensity"), exaggeration);
    const lightAnchor = layer.fixed<string>("illuminationAnchor") === "map" ? 0 : frame.view.bearing;
    gl.uniform1f(uniform(program, "u_azimuth"), (layer.fixed<number>("illuminationDirection") + lightAnchor) * DEG);
    const uDerive = uniform(program, "u_derive");
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
    const displayZ = Math.round(zoom + Math.log2(512 / source.tileSize));
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
      gl.uniform1f(uDerive, standardSlopeScale(size, Math.max(z, displayZ)));
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

export function standardSlopeScale(size: number, z: number): number {
  const factor = z < 2 ? 0.4 : z < 4.5 ? 0.35 : 0.3;
  const boost = z < 15 ? 2 ** ((15 - z) * factor) : 1;
  return ((size * 2 ** z) / EARTH_CIRCUMFERENCE) * boost;
}

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

function reliefLight(bearing: number): [number, number, number] {
  const azimuth = ((315 + bearing) * Math.PI) / 180;
  const altitude = Math.PI / 4;
  return [Math.sin(azimuth) * Math.cos(altitude), -Math.cos(azimuth) * Math.cos(altitude), Math.sin(altitude)];
}
