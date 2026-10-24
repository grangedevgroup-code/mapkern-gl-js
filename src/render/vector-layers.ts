import { latFromMercatorY, metersPerPixel } from "../geo/mercator.ts";
import type { GpuGeometry, VectorBucket, VectorTile } from "../sources/vector.ts";
import { dataDrivenPaint } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { TileManager } from "../tiles/manager.ts";
import type { GL, Program } from "./gl.ts";
import type { FrameInput, PaintStats } from "./painter.ts";
import { circleShader, extrusionShader, fillOutlineShader, fillShader, lineShader } from "./shaders/vector.ts";

type PaintUniform = { name: string; uniform: string; kind: "color" | "number" };

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

const LIGHT = normalize(-0.45, -0.65, 0.75);

function normalize(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}

const CIRCLE_PAINT: PaintUniform[] = [
  { name: "color", uniform: "u_color", kind: "color" },
  { name: "radius", uniform: "u_radius", kind: "number" },
  { name: "opacity", uniform: "u_opacity", kind: "number" },
  { name: "strokeColor", uniform: "u_stroke_color", kind: "color" },
  { name: "strokeWidth", uniform: "u_stroke_width", kind: "number" },
  { name: "blur", uniform: "u_blur", kind: "number" },
];

export class VectorPainter {
  private readonly gl: GL;
  private readonly matrix = new Float32Array(16);
  private readonly dash = new Float32Array(8);

  constructor(gl: GL) {
    this.gl = gl;
  }

  draw(frame: FrameInput, layer: StyleLayer, manager: TileManager<VectorTile>, stats: PaintStats): void {
    switch (layer.type) {
      case "fill":
        this.drawFill(frame, layer, manager, stats);
        break;
      case "line":
        this.drawLine(frame, layer, manager, stats);
        break;
      case "circle":
        this.drawCircle(frame, layer, manager, stats);
        break;
      case "extrusion":
        this.drawExtrusion(frame, layer, manager, stats);
        break;
      default:
        break;
    }
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

  private boundStride = -1;

  private tileUniforms(
    program: Program,
    frame: FrameInput,
    tile: { z: number; x: number; y: number },
    wrap: number,
    extent: number,
    clip: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    const gl = this.gl.gl;
    frame.transform.tileMatrix(tile.z, tile.x, tile.y, wrap, extent, this.matrix);
    gl.uniformMatrix4fv(program.uniforms.get("u_matrix") ?? null, false, this.matrix);
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

  private drawFill(frame: FrameInput, layer: StyleLayer, manager: TileManager<VectorTile>, stats: PaintStats): void {
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.transform.zoom;
    const program = g.program(fillShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, FILL_PAINT);
    const translate = layer.fixed<[number, number]>("translate") ?? [0, 0];
    let any = false;
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main) continue;
      any = true;
      this.bindPaint(program, layer, bucket, zoom, FILL_PAINT);
      this.tileUniforms(program, frame, piece.tile, piece.wrap, bucket.extent, piece.clip);
      const units = bucket.extent / (512 * 2 ** (zoom - piece.tile.z));
      gl.uniform2f(program.uniforms.get("u_translate") ?? null, translate[0] * units, translate[1] * units);
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
    if (!any || layer.fixed<boolean>("antialias") === false) return;
    const opacity = layer.paintValue<number>("opacity", { zoom });
    if (opacity <= 0) return;
    const outline = layer.paintProperty<unknown>("outlineColor");
    const outlineProgram = g.program(fillOutlineShader);
    g.use(outlineProgram);
    const colorSource = outline.constant && outline.evaluate({ zoom }) === null ? "color" : "outlineColor";
    const paint: PaintUniform[] = [
      { name: colorSource, uniform: "u_color", kind: "color" },
      { name: "opacity", uniform: "u_opacity", kind: "number" },
    ];
    this.prepare(outlineProgram, layer, zoom, paint);
    gl.uniform2f(outlineProgram.uniforms.get("u_world") ?? null, gl.drawingBufferWidth, gl.drawingBufferHeight);
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.outline) continue;
      this.bindPaint(outlineProgram, layer, bucket, zoom, paint);
      this.tileUniforms(outlineProgram, frame, piece.tile, piece.wrap, bucket.extent, piece.clip);
      const units = bucket.extent / (512 * 2 ** (zoom - piece.tile.z));
      gl.uniform2f(outlineProgram.uniforms.get("u_translate") ?? null, translate[0] * units, translate[1] * units);
      gl.bindVertexArray(bucket.outline.vao);
      gl.drawElements(gl.LINES, bucket.outline.indexCount, gl.UNSIGNED_INT, 0);
      stats.drawCalls++;
    }
  }

  private drawLine(frame: FrameInput, layer: StyleLayer, manager: TileManager<VectorTile>, stats: PaintStats): void {
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.transform.zoom;
    const program = g.program(lineShader);
    g.use(program);
    g.setBlend("premultiplied");
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
      if (!bucket?.main) continue;
      this.bindPaint(program, layer, bucket, zoom, LINE_PAINT);
      this.tileUniforms(program, frame, piece.tile, piece.wrap, bucket.extent, piece.clip);
      gl.uniform1f(program.uniforms.get("u_units_per_px") ?? null, bucket.extent / (512 * 2 ** (zoom - piece.tile.z)));
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
  }

  private drawCircle(frame: FrameInput, layer: StyleLayer, manager: TileManager<VectorTile>, stats: PaintStats): void {
    const g = this.gl;
    const gl = g.gl;
    const zoom = frame.transform.zoom;
    const program = g.program(circleShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    this.prepare(program, layer, zoom, CIRCLE_PAINT);
    gl.uniform1f(program.uniforms.get("u_pixel_ratio") ?? null, frame.pixelRatio);
    gl.uniform2f(program.uniforms.get("u_viewport") ?? null, frame.transform.width, frame.transform.height);
    for (const piece of manager.pieces) {
      const bucket = piece.tile.data?.buckets.get(layer.id);
      if (!bucket?.main) continue;
      this.bindPaint(program, layer, bucket, zoom, CIRCLE_PAINT);
      this.tileUniforms(program, frame, piece.tile, piece.wrap, bucket.extent, piece.clip);
      this.drawGeometry(bucket.main, stats);
      stats.pieces++;
    }
  }

  private drawExtrusion(
    frame: FrameInput,
    layer: StyleLayer,
    manager: TileManager<VectorTile>,
    stats: PaintStats,
  ): void {
    const g = this.gl;
    const gl = g.gl;
    const transform = frame.transform;
    const zoom = transform.zoom;
    const opacity = layer.paintValue<number>("opacity", { zoom });
    if (!(opacity > 0)) return;
    const program = g.program(extrusionShader);
    g.use(program);
    g.setBlend("premultiplied");
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
    const passes = opacity < 1 ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const depthOnly = passes === 2 && pass === 0;
      gl.colorMask(!depthOnly, !depthOnly, !depthOnly, !depthOnly);
      g.setDepth(true, depthOnly || passes === 1);
      gl.depthFunc(passes === 2 && pass === 1 ? gl.EQUAL : gl.LEQUAL);
      for (const piece of manager.pieces) {
        const bucket = piece.tile.data?.buckets.get(layer.id);
        if (!bucket?.main) continue;
        this.bindPaint(program, layer, bucket, zoom, EXTRUSION_PAINT);
        this.tileUniforms(program, frame, piece.tile, piece.wrap, bucket.extent, piece.clip);
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
