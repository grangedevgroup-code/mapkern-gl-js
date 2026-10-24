import { latFromMercatorY, metersPerPixel } from "../geo/mercator.ts";
import type { GpuGeometry, VectorBucket, VectorTile } from "../sources/vector.ts";
import { dataDrivenPaint } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { RenderPiece, TileManager } from "../tiles/manager.ts";
import type { GL, Program, ProgramSource } from "./gl.ts";
import type { FrameInput, PaintStats } from "./painter.ts";
import { circleShader, extrusionShader, fillOutlineShader, fillShader, lineShader } from "./shaders/vector.ts";

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
];

const EXTRUSION_PAINT: PaintUniform[] = [
  { name: "color", uniform: "u_color", kind: "color" },
  { name: "height", uniform: "u_height", kind: "number" },
  { name: "base", uniform: "u_base", kind: "number" },
];

const CIRCLE_PAINT: PaintUniform[] = [
  { name: "color", uniform: "u_color", kind: "color" },
  { name: "radius", uniform: "u_radius", kind: "number" },
  { name: "opacity", uniform: "u_opacity", kind: "number" },
  { name: "strokeColor", uniform: "u_stroke_color", kind: "color" },
  { name: "strokeWidth", uniform: "u_stroke_width", kind: "number" },
  { name: "blur", uniform: "u_blur", kind: "number" },
];

const LIGHT = normalize(-0.45, -0.65, 0.75);

const PICK = ["PICK"];
const PICKING: ReadonlyMap<ProgramSource, ProgramSource> = new Map(
  [fillShader, lineShader, circleShader, extrusionShader].map((s) => [s, { ...s, defines: PICK }]),
);

function normalize(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}

export class VectorPainter {
  private readonly gl: GL;
  private readonly matrix = new Float32Array(16);
  private readonly dash = new Float32Array(8);
  private boundStride = -1;

  constructor(gl: GL) {
    this.gl = gl;
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
      default:
        break;
    }
  }

  private program(source: ProgramSource, pick: PickPass | undefined): Program {
    const g = this.gl;
    const program = g.program(pick ? (PICKING.get(source) ?? source) : source);
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
  ): void {
    const g = this.gl;
    const gl = g.gl;
    bucket.paint.update(g, layer, bucket.features, dataDrivenPaint(layer.type), zoom);
    const stride = bucket.paint.stride;
    if (stride === 0 && this.boundStride === 0) return;
    this.boundStride = stride;
    g.bindTexture(1, bucket.paint.texture);
    gl.uniform1i(program.uniforms.get("u_paint_width") ?? null, bucket.paint.width);
    gl.uniform1i(program.uniforms.get("u_paint_stride") ?? null, stride);
    for (const p of paint) {
      const slot = bucket.paint.slot(p.name);
      gl.uniform1i(program.uniforms.get(`${p.uniform}_slot`) ?? null, slot.slot);
      gl.uniform1i(program.uniforms.get(`${p.uniform}_comp`) ?? null, slot.composite ? 1 : 0);
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
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.view.zoom;
    const program = this.program(fillShader, pick);
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, FILL_PAINT);
    const translate = layer.fixed<[number, number]>("translate") ?? [0, 0];
    let any = false;
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main || (frame.accept && !frame.accept(piece))) continue;
      any = true;
      this.bindPaint(program, layer, bucket, zoom, FILL_PAINT);
      this.tileUniforms(program, frame, piece, bucket, pick);
      const units = bucket.extent / (512 * 2 ** (zoom - piece.tile.z));
      gl.uniform2f(program.uniforms.get("u_translate") ?? null, translate[0] * units, translate[1] * units);
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
    if (pick || !any || layer.fixed<boolean>("antialias") === false) return;
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
      this.bindPaint(outlineProgram, layer, bucket, zoom, paint);
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
      this.bindPaint(program, layer, bucket, zoom, LINE_PAINT);
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
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.view.zoom;
    const program = this.program(circleShader, pick);
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, CIRCLE_PAINT);
    gl.uniform1f(program.uniforms.get("u_pixel_ratio") ?? null, frame.pixelRatio);
    const [hx, hy] = pick ? pick.scale : [1, 1];
    gl.uniform2f(program.uniforms.get("u_viewport") ?? null, frame.view.width * hx, frame.view.height * hy);
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main || (frame.accept && !frame.accept(piece))) continue;
      this.bindPaint(program, layer, bucket, zoom, CIRCLE_PAINT);
      this.tileUniforms(program, frame, piece, bucket, pick);
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
    const g = this.gl;
    const gl = g.gl;
    const transform = frame.transform;
    const zoom = transform.zoom;
    const opacity = layer.paintValue<number>("opacity", { zoom });
    if (!(opacity > 0)) return;
    const program = this.program(extrusionShader, pick);
    this.prepare(program, layer, zoom, EXTRUSION_PAINT);
    gl.uniform1f(program.uniforms.get("u_opacity") ?? null, Math.min(1, opacity));
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
        this.bindPaint(program, layer, bucket, zoom, EXTRUSION_PAINT);
        this.tileUniforms(program, frame, piece, bucket, pick);
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

function multiplyInto(m: Float32Array, a: Float64Array): void {
  const b = Array.from(m);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] =
        a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
}
