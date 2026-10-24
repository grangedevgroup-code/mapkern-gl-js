import type { Transform } from "../camera/transform.ts";
import type { RasterSource } from "../sources/raster.ts";
import type { MapSource } from "../sources/source.ts";
import type { VectorTile } from "../sources/vector.ts";
import { isVectorTileSource } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import { premultiply } from "../style/color.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { SymbolLayerInput } from "../text/labels.ts";
import { LabelRenderer } from "../text/labels.ts";
import { textShader } from "../text/shader.ts";
import type { TileManager } from "../tiles/manager.ts";
import type { GL, Program } from "./gl.ts";
import { rasterShader, solidShader } from "./shaders/raster.ts";
import { circleShader, fillOutlineShader, fillShader, lineShader } from "./shaders/vector.ts";
import { VectorPainter } from "./vector-layers.ts";

export interface FrameInput {
  readonly transform: Transform;
  readonly pixelRatio: number;
  readonly layers: readonly StyleLayer[];
  readonly sources: ReadonlyMap<string, MapSource>;
  readonly now: number;
  readonly cameraVersion: number;
}

export interface PaintStats {
  drawCalls: number;
  pieces: number;
}

export class Painter {
  readonly gl: GL;
  stats: PaintStats = { drawCalls: 0, pieces: 0 };
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private readonly matrix = new Float32Array(16);
  private readonly hue = new Float32Array(9);
  private readonly vector: VectorPainter;
  readonly labels: LabelRenderer;

  constructor(gl: GL) {
    this.gl = gl;
    this.vector = new VectorPainter(gl);
    this.labels = new LabelRenderer(gl);
    this.init();
  }

  init(): void {
    this.labels.reset();
    for (const shader of [
      solidShader,
      rasterShader,
      fillShader,
      fillOutlineShader,
      lineShader,
      circleShader,
      textShader,
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
  }

  render(frame: FrameInput): boolean {
    const g = this.gl;
    const gl = g.gl;
    this.stats = { drawCalls: 0, pieces: 0 };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    g.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const zoom = frame.transform.zoom;
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
    for (let i = start; i < layers.length; i++) {
      const layer = layers[i]!;
      if (!layer.isVisible(zoom)) continue;
      switch (layer.type) {
        case "background":
          this.drawSolid(this.backgroundColor(layer, zoom));
          break;
        case "raster": {
          const source = layer.source ? frame.sources.get(layer.source) : undefined;
          if (source?.type === "raster") this.drawRaster(frame, layer, source as RasterSource);
          break;
        }
        case "fill":
        case "line":
        case "circle": {
          const source = layer.source ? frame.sources.get(layer.source) : undefined;
          const manager = vectorManager(source);
          if (manager) this.vector.draw(frame, layer, manager, this.stats);
          break;
        }
        default:
          break;
      }
    }
    const symbols: SymbolLayerInput[] = [];
    for (const layer of layers) {
      if (layer.type !== "symbol" || !layer.source) continue;
      const manager = vectorManager(frame.sources.get(layer.source));
      if (manager) symbols.push({ layer, manager });
    }
    let animating = false;
    if (symbols.length > 0 || this.labels.visibleCount > 0) {
      animating = this.labels.update(frame.transform, symbols, frame.now, frame.cameraVersion, frame.pixelRatio);
      this.stats.drawCalls += this.labels.draw(frame.transform, frame.pixelRatio);
    }
    gl.bindVertexArray(null);
    return animating;
  }

  destroy(): void {
    this.labels.destroy();
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteVertexArray(this.quadVao);
    this.quadBuffer = null;
    this.quadVao = null;
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

  private drawRaster(frame: FrameInput, layer: StyleLayer, source: RasterSource): void {
    const manager = source.manager;
    if (!manager || manager.pieces.length === 0) return;
    const g = this.gl;
    const gl = g.gl;
    const ctx = { zoom: frame.transform.zoom };
    const opacity = layer.paintValue<number>("opacity", ctx);
    if (opacity <= 0) return;
    const program = g.program(rasterShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
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
    const nearest = layer.fixed<string>("resampling") === "nearest";
    gl.bindVertexArray(this.quadVao);
    const uMatrix = uniform(program, "u_matrix");
    const uClip = uniform(program, "u_clip");
    const uOpacity = uniform(program, "u_opacity");
    for (const piece of manager.pieces) {
      const texture = piece.tile.data?.texture;
      if (!texture) continue;
      g.bindTexture(0, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      frame.transform.tileMatrix(piece.tile.z, piece.tile.x, piece.tile.y, piece.wrap, 1, this.matrix);
      gl.uniformMatrix4fv(uMatrix, false, this.matrix);
      gl.uniform4f(uClip, piece.clip.x0, piece.clip.y0, piece.clip.x1, piece.clip.y1);
      gl.uniform1f(uOpacity, opacity * piece.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.stats.drawCalls++;
      this.stats.pieces++;
    }
  }
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
