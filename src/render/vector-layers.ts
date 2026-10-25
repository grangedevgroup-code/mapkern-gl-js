import { latFromMercatorY, metersPerPixel } from "../geo/mercator.ts";
import type { GpuGeometry, VectorBucket, VectorTile } from "../sources/vector.ts";
import { dataDrivenPaint } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import type { StateLookup } from "../style/feature-state.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { Terrain } from "../terrain/terrain.ts";
import type { RenderPiece, TileManager } from "../tiles/manager.ts";
import type { GL, Program, ProgramSource } from "./gl.ts";
import { HeatmapResources } from "./heatmap.ts";
import type { ImageAtlas } from "./images.ts";
import type { PaintBudget } from "./paint-table.ts";
import type { FrameInput, PaintStats } from "./painter.ts";
import { heatmapColorShader, heatmapShader } from "./shaders/heatmap.ts";
import {
  circleShader,
  extrusionShader,
  fillOutlineShader,
  fillPatternShader,
  fillShader,
  lineShader,
} from "./shaders/vector.ts";

type PaintUniform = { name: string; uniform: string; kind: "color" | "number" };

export interface PickPass {
  readonly clip: Float64Array;
  readonly scale: readonly [number, number];
  register(piece: RenderPiece<VectorTile>, bucket: VectorBucket): number;
}

const FILL_PAINT: PaintUniform[] = [
  { name: "color", uniform: "u_color", kind: "color" },
  { name: "opacity", uniform: "u_opacity", kind: "number" },
];

const LINE_PAINT: PaintUniform[] = [
  { name: "color", uniform: "u_color", kind: "color" },
  { name: "width", uniform: "u_width", kind: "number" },
  { name: "opacity", uniform: "u_opacity", kind: "number" },
  { name: "blur", uniform: "u_blur", kind: "number" },
  { name: "offset", uniform: "u_offset", kind: "number" },
  { name: "gapWidth", uniform: "u_gap_width", kind: "number" },
];

const EXTRUSION_PAINT: PaintUniform[] = [
  { name: "color", uniform: "u_color", kind: "color" },
  { name: "height", uniform: "u_height", kind: "number" },
  { name: "base", uniform: "u_base", kind: "number" },
];

const HEATMAP_PAINT: PaintUniform[] = [
  { name: "radius", uniform: "u_radius", kind: "number" },
  { name: "weight", uniform: "u_weight", kind: "number" },
];

const CIRCLE_PAINT: PaintUniform[] = [
  { name: "color", uniform: "u_color", kind: "color" },
  { name: "radius", uniform: "u_radius", kind: "number" },
  { name: "opacity", uniform: "u_opacity", kind: "number" },
  { name: "strokeColor", uniform: "u_stroke_color", kind: "color" },
  { name: "strokeWidth", uniform: "u_stroke_width", kind: "number" },
  { name: "strokeOpacity", uniform: "u_stroke_opacity", kind: "number" },
  { name: "blur", uniform: "u_blur", kind: "number" },
];

const LIGHT = normalize(-0.45, -0.65, 0.75);

const PICK = ["PICK"];
const PICKING: ReadonlyMap<ProgramSource, ProgramSource> = new Map(
  [fillShader, lineShader, circleShader, extrusionShader].map((s) => [s, { ...s, defines: PICK }]),
);
const EXTRUSION_TERRAIN: ProgramSource = { ...extrusionShader, defines: ["TERRAIN"] };
const EXTRUSION_TERRAIN_PICK: ProgramSource = { ...extrusionShader, defines: ["PICK", "TERRAIN"] };

export const WARM_VARIANTS: readonly ProgramSource[] = [EXTRUSION_TERRAIN];

function screenOffset(layer: StyleLayer, bearing: number, zoom: number): [number, number] {
  const [x, y] = pairOf(layer.paintValue<unknown>("translate", { zoom }));
  if (layer.fixed<string>("translateAnchor") !== "viewport" || bearing === 0) return [x, y];
  const b = (bearing * Math.PI) / 180;
  const cos = Math.cos(b);
  const sin = Math.sin(b);
  return [x * cos - y * sin, x * sin + y * cos];
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}

export interface PatternImages {
  readonly atlas: ImageAtlas;
  texture(): WebGLTexture | null;
  missing(id: string): void;
}

export class VectorPainter {
  readonly budget: PaintBudget = { deadline: Number.POSITIVE_INFINITY, behind: false };
  private readonly gl: GL;
  private readonly images: PatternImages;
  private readonly matrix = new Float32Array(16);
  private readonly dash = new Float32Array(8);
  private boundStride = -1;
  private readonly heat: HeatmapResources;

  constructor(gl: GL, images: PatternImages) {
    this.gl = gl;
    this.images = images;
    this.heat = new HeatmapResources(gl);
  }

  reset(): void {
    this.heat.reset();
  }

  destroy(): void {
    this.heat.destroy();
  }

  draw(
    frame: FrameInput,
    layer: StyleLayer,
    manager: TileManager<VectorTile>,
    stats: PaintStats,
    pick?: PickPass,
  ): void {
    switch (layer.type) {
      case "fill":
        this.drawFill(frame, layer, manager, stats, pick);
        break;
      case "line":
        this.drawLine(frame, layer, manager, stats, pick);
        break;
      case "circle":
        this.drawCircle(frame, layer, manager, stats, pick);
        break;
      case "extrusion":
        this.drawExtrusion(frame, layer, manager, stats, pick);
        break;
      case "heatmap":
        if (!pick) this.drawHeatmap(frame, layer, manager, stats);
        break;
      default:
        break;
    }
  }

  private drawHeatmap(frame: FrameInput, layer: StyleLayer, manager: TileManager<VectorTile>, stats: PaintStats): void {
    const g = this.gl;
    const gl = g.gl;
    const [width, height] = frame.target ?? [gl.drawingBufferWidth, gl.drawingBufferHeight];
    const target = this.heat.target(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
    if (!target) return;
    const zoom = frame.view.zoom;
    const states = frame.states?.(layer) ?? null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    g.setViewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const program = this.program(heatmapShader, undefined);
    g.setBlend("additive");
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, HEATMAP_PAINT);
    const u = program.uniforms;
    gl.uniform1f(u.get("u_intensity") ?? null, Math.max(0, layer.paintValue<number>("intensity", { zoom })));
    gl.uniform1f(u.get("u_scale") ?? null, target.scale);
    gl.uniform2f(u.get("u_viewport") ?? null, frame.view.width, frame.view.height);
    const near = frame.acceptNear ?? frame.accept;
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main || (near && !near(piece))) continue;
      this.bindPaint(program, layer, bucket, zoom, HEATMAP_PAINT, states);
      this.tileUniforms(program, frame, piece, bucket, undefined);
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer ?? null);
    g.setViewport(0, 0, width, height);
    const ramp = this.heat.ramp(layer, zoom);
    const color = g.program(heatmapColorShader);
    g.use(color);
    g.setBlend("premultiplied");
    g.bindTexture(0, target.texture);
    g.bindTexture(1, ramp);
    const c = color.uniforms;
    gl.uniform1i(c.get("u_density") ?? null, 0);
    gl.uniform1i(c.get("u_ramp") ?? null, 1);
    gl.uniform1f(c.get("u_opacity") ?? null, Math.max(0, Math.min(1, layer.paintValue<number>("opacity", { zoom }))));
    gl.uniform1f(c.get("u_unscale") ?? null, 1 / target.scale);
    this.heat.drawQuad();
    stats.drawCalls++;
    this.boundStride = -1;
  }

  private program(source: ProgramSource, pick: PickPass | undefined): Program {
    const g = this.gl;
    const program = g.program(
      source === EXTRUSION_TERRAIN && pick ? EXTRUSION_TERRAIN_PICK : pick ? (PICKING.get(source) ?? source) : source,
    );
    g.use(program);
    g.setBlend(pick ? "none" : "premultiplied");
    return program;
  }

  private prepare(program: Program, layer: StyleLayer, zoom: number, paint: PaintUniform[]): void {
    const gl = this.gl.gl;
    const ctx = { zoom };
    this.boundStride = -1;
    for (const p of paint) {
      const loc = program.uniforms.get(p.uniform) ?? null;
      const value = layer.paintValue<unknown>(p.name, ctx);
      if (p.kind === "color") {
        const c = (Array.isArray(value) ? value : [0, 0, 0, 0]) as RGBA;
        gl.uniform4f(loc, c[0], c[1], c[2], c[3]);
      } else {
        gl.uniform1f(loc, typeof value === "number" ? value : 0);
      }
    }
    gl.uniform1i(program.uniforms.get("u_paint") ?? null, 1);
    gl.uniform1f(program.uniforms.get("u_zoom_t") ?? null, zoom - Math.floor(zoom));
  }

  private bindPaint(
    program: Program,
    layer: StyleLayer,
    bucket: VectorBucket,
    zoom: number,
    paint: PaintUniform[],
    states: StateLookup | null,
  ): void {
    const g = this.gl;
    const gl = g.gl;
    bucket.paint.update(g, layer, bucket.features, dataDrivenPaint(layer.type), zoom, this.budget, states);
    const stride = bucket.paint.stride;
    if (stride === 0 && this.boundStride === 0) return;
    this.boundStride = stride;
    g.bindTexture(1, bucket.paint.texture);
    gl.uniform1f(
      program.uniforms.get("u_zoom_t") ?? null,
      Math.min(1, Math.max(0, zoom - (Number.isNaN(bucket.paint.base) ? Math.floor(zoom) : bucket.paint.base))),
    );
    gl.uniform1i(program.uniforms.get("u_paint_width") ?? null, bucket.paint.width);
    gl.uniform1i(program.uniforms.get("u_paint_stride") ?? null, stride);
    for (const p of paint) {
      const slot = bucket.paint.slot(p.name);
      gl.uniform1i(program.uniforms.get(`${p.uniform}_slot`) ?? null, slot.slot);
      gl.uniform1i(program.uniforms.get(`${p.uniform}_comp`) ?? null, slot.composite ? 1 : 0);
    }
  }

  private drawPattern(
    frame: FrameInput,
    layer: StyleLayer,
    manager: TileManager<VectorTile>,
    stats: PaintStats,
    name: string,
  ): void {
    const rect = this.images.atlas.get(name);
    if (!rect) {
      this.images.missing(name);
      return;
    }
    const texture = this.images.texture();
    const zoom = frame.view.zoom;
    const opacity = layer.paintValue<number>("opacity", { zoom });
    if (!texture || opacity <= 0) return;
    const g = this.gl;
    const gl = g.gl;
    const program = g.program(fillPatternShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    this.boundStride = -1;
    g.bindTexture(0, texture);
    const u = (n: string) => program.uniforms.get(n) ?? null;
    const image = rect.image;
    const ratio = image.pixelRatio;
    const periodX = image.width / ratio;
    const periodY = image.height / ratio;
    const base = Math.floor(zoom);
    gl.uniform1i(u("u_atlas"), 0);
    gl.uniform4f(u("u_rect"), rect.x, rect.y, image.width, image.height);
    gl.uniform1f(u("u_ratio"), ratio);
    gl.uniform1f(u("u_mix"), zoom - base);
    gl.uniform1f(u("u_opacity"), opacity);
    const translate = screenOffset(layer, frame.view.bearing, zoom);
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main || (frame.accept && !frame.accept(piece))) continue;
      const tile = piece.tile;
      this.tileUniforms(program, frame, piece, bucket, undefined);
      const size = 512 * 2 ** (base - tile.z);
      const ox = (piece.wrap * 2 ** tile.z + tile.x) * size;
      const oy = tile.y * size;
      gl.uniform1f(u("u_extent"), bucket.extent);
      gl.uniform1f(u("u_tile_size"), size);
      gl.uniform4f(
        u("u_pattern_origin"),
        positive(ox, periodX),
        positive(oy, periodY),
        positive(ox * 2, periodX),
        positive(oy * 2, periodY),
      );
      const units = bucket.extent / (512 * 2 ** (zoom - tile.z));
      gl.uniform2f(u("u_translate"), translate[0] * units, translate[1] * units);
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
  }

  private tileUniforms(
    program: Program,
    frame: FrameInput,
    piece: RenderPiece<VectorTile>,
    bucket: VectorBucket,
    pick: PickPass | undefined,
  ): void {
    const gl = this.gl.gl;
    const tile = piece.tile;
    const extent = bucket.extent;
    frame.view.tileMatrix(tile.z, tile.x, tile.y, piece.wrap, extent, this.matrix);
    if (pick) {
      multiplyInto(this.matrix, pick.clip);
      gl.uniform1ui(program.uniforms.get("u_draw") ?? null, pick.register(piece, bucket));
    }
    gl.uniformMatrix4fv(program.uniforms.get("u_matrix") ?? null, false, this.matrix);
    const clip = piece.clip;
    gl.uniform4f(
      program.uniforms.get("u_clip") ?? null,
      clip.x0 * extent,
      clip.y0 * extent,
      clip.x1 * extent,
      clip.y1 * extent,
    );
  }

  private bindGround(program: Program, terrain: Terrain, piece: RenderPiece<VectorTile>, extent: number): void {
    const g = this.gl;
    const gl = g.gl;
    const tile = piece.tile;
    const found = terrain.demFor(tile.z, tile.x, tile.y);
    const data = found?.tile.data ?? null;
    const texture = data ? terrain.source.elevationTexture(data) : null;
    g.bindTexture(2, texture ?? flatDem(g));
    gl.activeTexture(gl.TEXTURE0);
    const r = found?.rect ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
    const n = 2 ** tile.z;
    const u = program.uniforms;
    gl.uniform4f(u.get("u_dem_rect") ?? null, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    gl.uniform1f(u.get("u_dem_size") ?? null, data ? data.grid.size : 1);
    gl.uniform1f(u.get("u_has_dem") ?? null, texture ? 1 : 0);
    gl.uniform2f(u.get("u_rows") ?? null, tile.y / n, (tile.y + 1) / n);
    gl.uniform1f(u.get("u_extent") ?? null, extent);
  }

  private drawGeometry(g: GpuGeometry, stats: PaintStats): void {
    const gl = this.gl.gl;
    gl.bindVertexArray(g.vao);
    gl.drawElements(gl.TRIANGLES, g.indexCount, gl.UNSIGNED_INT, 0);
    stats.drawCalls++;
  }

  private drawFill(
    frame: FrameInput,
    layer: StyleLayer,
    manager: TileManager<VectorTile>,
    stats: PaintStats,
    pick: PickPass | undefined,
  ): void {
    const states = frame.states?.(layer) ?? null;
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.view.zoom;
    const pattern = layer.paintValue<unknown>("pattern", { zoom });
    if (!pick && typeof pattern === "string" && pattern !== "") {
      this.drawPattern(frame, layer, manager, stats, pattern);
      return;
    }
    const program = this.program(fillShader, pick);
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, FILL_PAINT);
    const translate = screenOffset(layer, frame.view.bearing, frame.view.zoom);
    let any = false;
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main || (frame.accept && !frame.accept(piece))) continue;
      any = true;
      this.bindPaint(program, layer, bucket, zoom, FILL_PAINT, states);
      this.tileUniforms(program, frame, piece, bucket, pick);
      const units = bucket.extent / (512 * 2 ** (zoom - piece.tile.z));
      gl.uniform2f(program.uniforms.get("u_translate") ?? null, translate[0] * units, translate[1] * units);
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
    if (pick || !any || layer.paintValue<unknown>("antialias", { zoom }) === false) return;
    const opacity = layer.paintValue<number>("opacity", { zoom });
    if (opacity <= 0) return;
    const outline = layer.paintProperty<unknown>("outlineColor");
    const outlineProgram = this.program(fillOutlineShader, undefined);
    const colorSource = outline.constant && outline.evaluate({ zoom }) === null ? "color" : "outlineColor";
    const paint: PaintUniform[] = [
      { name: colorSource, uniform: "u_color", kind: "color" },
      { name: "opacity", uniform: "u_opacity", kind: "number" },
    ];
    this.prepare(outlineProgram, layer, zoom, paint);
    const [targetWidth, targetHeight] = frame.target ?? [gl.drawingBufferWidth, gl.drawingBufferHeight];
    gl.uniform2f(outlineProgram.uniforms.get("u_world") ?? null, targetWidth, targetHeight);
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.outline || (frame.accept && !frame.accept(piece))) continue;
      this.bindPaint(outlineProgram, layer, bucket, zoom, paint, states);
      this.tileUniforms(outlineProgram, frame, piece, bucket, undefined);
      const units = bucket.extent / (512 * 2 ** (zoom - piece.tile.z));
      gl.uniform2f(outlineProgram.uniforms.get("u_translate") ?? null, translate[0] * units, translate[1] * units);
      gl.bindVertexArray(bucket.outline.vao);
      gl.drawElements(gl.LINES, bucket.outline.indexCount, gl.UNSIGNED_INT, 0);
      stats.drawCalls++;
    }
  }

  private drawLine(
    frame: FrameInput,
    layer: StyleLayer,
    manager: TileManager<VectorTile>,
    stats: PaintStats,
    pick: PickPass | undefined,
  ): void {
    const states = frame.states?.(layer) ?? null;
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.view.zoom;
    const program = this.program(lineShader, pick);
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, LINE_PAINT);
    gl.uniform1f(program.uniforms.get("u_pixel_ratio") ?? null, frame.pixelRatio);
    gl.uniform1f(program.uniforms.get("u_min_width") ?? null, 0);
    gl.uniform2f(program.uniforms.get("u_translate") ?? null, 0, 0);
    const dash = layer.fixed<number[] | null>("dash");
    if (dash && dash.length > 0) {
      const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : dash;
      const n = Math.min(8, pattern.length);
      this.dash.fill(0);
      let total = 0;
      for (let i = 0; i < n; i++) {
        this.dash[i] = pattern[i]!;
        total += pattern[i]!;
      }
      gl.uniform1fv(program.uniforms.get("u_dash") ?? null, this.dash);
      gl.uniform1i(program.uniforms.get("u_dash_count") ?? null, total > 0 ? n : 0);
      gl.uniform1f(program.uniforms.get("u_dash_total") ?? null, total);
    } else {
      gl.uniform1i(program.uniforms.get("u_dash_count") ?? null, 0);
    }
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main || (frame.accept && !frame.accept(piece))) continue;
      this.bindPaint(program, layer, bucket, zoom, LINE_PAINT, states);
      this.tileUniforms(program, frame, piece, bucket, pick);
      gl.uniform1f(program.uniforms.get("u_units_per_px") ?? null, bucket.extent / (512 * 2 ** (zoom - piece.tile.z)));
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
  }

  private drawCircle(
    frame: FrameInput,
    layer: StyleLayer,
    manager: TileManager<VectorTile>,
    stats: PaintStats,
    pick: PickPass | undefined,
  ): void {
    const states = frame.states?.(layer) ?? null;
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.view.zoom;
    const program = this.program(circleShader, pick);
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, CIRCLE_PAINT);
    gl.uniform1f(program.uniforms.get("u_pixel_ratio") ?? null, frame.pixelRatio);
    const [hx, hy] = pick ? pick.scale : [1, 1];
    gl.uniform2f(program.uniforms.get("u_viewport") ?? null, frame.view.width * hx, frame.view.height * hy);
    const u = program.uniforms;
    const flatView = frame.view !== frame.transform;
    gl.uniform1i(u.get("u_pitch_align") ?? null, layer.fixed<string>("pitchAlignment") === "map" ? 1 : 0);
    gl.uniform1i(u.get("u_pitch_scale") ?? null, layer.fixed<string>("pitchScale") === "map" ? 1 : 0);
    gl.uniform1f(u.get("u_camera_distance") ?? null, flatView ? 1 : frame.transform.cameraToCenterDistance);
    const translate = screenOffset(layer, frame.view.bearing, frame.view.zoom);
    const near = frame.acceptNear ?? frame.accept;
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main || (near && !near(piece))) continue;
      this.bindPaint(program, layer, bucket, zoom, CIRCLE_PAINT, states);
      this.tileUniforms(program, frame, piece, bucket, pick);
      const units = bucket.extent / (512 * 2 ** (zoom - piece.tile.z));
      gl.uniform1f(u.get("u_units_per_px") ?? null, units);
      gl.uniform2f(u.get("u_translate") ?? null, translate[0] * units, translate[1] * units);
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
  }

  private drawExtrusion(
    frame: FrameInput,
    layer: StyleLayer,
    manager: TileManager<VectorTile>,
    stats: PaintStats,
    pick: PickPass | undefined,
  ): void {
    const states = frame.states?.(layer) ?? null;
    const g = this.gl;
    const gl = g.gl;
    const transform = frame.transform;
    const zoom = transform.zoom;
    const opacity = layer.paintValue<number>("opacity", { zoom });
    if (!(opacity > 0)) return;
    const terrain = frame.terrain ?? null;
    const program = this.program(terrain ? EXTRUSION_TERRAIN : extrusionShader, pick);
    this.prepare(program, layer, zoom, EXTRUSION_PAINT);
    gl.uniform1f(program.uniforms.get("u_opacity") ?? null, Math.min(1, opacity));
    if (terrain) {
      gl.uniform1i(program.uniforms.get("u_dem") ?? null, 2);
      gl.uniform1f(program.uniforms.get("u_world") ?? null, transform.worldSize);
      gl.uniform1f(program.uniforms.get("u_exaggeration") ?? null, terrain.exaggeration);
    }
    const b = (transform.bearing * Math.PI) / 180;
    const [sx, sy, sz] = LIGHT;
    gl.uniform3f(
      program.uniforms.get("u_light") ?? null,
      sx * Math.cos(b) - sy * Math.sin(b),
      sx * Math.sin(b) + sy * Math.cos(b),
      sz,
    );
    const passes = opacity < 1 && !pick ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const depthOnly = passes === 2 && pass === 0;
      gl.colorMask(!depthOnly, !depthOnly, !depthOnly, !depthOnly);
      g.setDepth(true, depthOnly || passes === 1);
      gl.depthFunc(passes === 2 && pass === 1 ? gl.EQUAL : gl.LEQUAL);
      for (const piece of manager.pieces) {
        const bucket = piece.tile.data?.buckets.get(layer.id);
        if (!bucket?.main) continue;
        this.bindPaint(program, layer, bucket, zoom, EXTRUSION_PAINT, states);
        this.tileUniforms(program, frame, piece, bucket, pick);
        if (terrain) this.bindGround(program, terrain, piece, bucket.extent);
        const lat = latFromMercatorY((piece.tile.y + 0.5) / 2 ** piece.tile.z);
        gl.uniform1f(program.uniforms.get("u_pixels_per_meter") ?? null, 1 / metersPerPixel(lat, zoom));
        this.drawGeometry(bucket.main, stats);
        if (pass === passes - 1) stats.pieces++;
      }
    }
    gl.colorMask(true, true, true, true);
    gl.depthFunc(gl.LEQUAL);
    g.setDepth(false, false);
  }
}

const NO_DEM = new WeakMap<GL, WebGLTexture>();

function flatDem(gl: GL): WebGLTexture {
  let texture = NO_DEM.get(gl);
  if (!texture) {
    texture = gl.createDataTexture(1, 1, "r32f", Float32Array.of(0), false);
    NO_DEM.set(gl, texture);
  }
  return texture;
}

function multiplyInto(m: Float32Array, a: Float64Array): void {
  const b = Array.from(m);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
}

function pairOf(value: unknown): [number, number] {
  return Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number"
    ? [value[0], value[1]]
    : [0, 0];
}

function positive(value: number, period: number): number {
  const r = value % period;
  return r < 0 ? r + period : r;
}
