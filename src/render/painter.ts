import type { Transform } from "../camera/transform.ts";
import { EARTH_CIRCUMFERENCE } from "../geo/mercator.ts";
import type { DemSource } from "../sources/dem.ts";
import type { RasterSource } from "../sources/raster.ts";
import type { MapSource } from "../sources/source.ts";
import type { VectorBucket, VectorTile } from "../sources/vector.ts";
import { isVectorTileSource } from "../sources/vector.ts";
import type { RGBA } from "../style/color.ts";
import { premultiply } from "../style/color.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { SymbolLayerInput } from "../text/labels.ts";
import { LabelRenderer } from "../text/labels.ts";
import { textShader } from "../text/shader.ts";
import type { RenderPiece, TileManager } from "../tiles/manager.ts";
import type { Tile } from "../tiles/tile.ts";
import type { GL, Program } from "./gl.ts";
import { PickBuffer } from "./pick.ts";
import { hillshadeShader } from "./shaders/hillshade.ts";
import { rasterShader, solidShader } from "./shaders/raster.ts";
import { circleShader, extrusionShader, fillOutlineShader, fillShader, lineShader } from "./shaders/vector.ts";
import type { PickPass } from "./vector-layers.ts";
import { VectorPainter } from "./vector-layers.ts";

export interface FrameInput {
  readonly transform: Transform;
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
}

export class Painter {
  readonly gl: GL;
  stats: PaintStats = { drawCalls: 0, pieces: 0 };
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private openMask: WebGLTexture | null = null;
  private readonly matrix = new Float32Array(16);
  private readonly hue = new Float32Array(9);
  private readonly vector: VectorPainter;
  readonly labels: LabelRenderer;
  private readonly pickBuffer: PickBuffer;

  constructor(gl: GL) {
    this.gl = gl;
    this.vector = new VectorPainter(gl);
    this.labels = new LabelRenderer(gl);
    this.pickBuffer = new PickBuffer(gl);
    this.init();
  }

  init(): void {
    this.labels.reset();
    this.pickBuffer.reset();
    for (const shader of [
      solidShader,
      rasterShader,
      hillshadeShader,
      fillShader,
      fillOutlineShader,
      lineShader,
      circleShader,
      extrusionShader,
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
    this.openMask = this.gl.createDataTexture(1, 1, "r8", Uint8Array.of(255), false);
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
        case "hillshade": {
          const source = layer.source ? frame.sources.get(layer.source) : undefined;
          if (source?.type === "dem") this.drawHillshade(frame, layer, source as DemSource);
          break;
        }
        case "fill":
        case "line":
        case "circle":
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

  pick(frame: FrameInput, box: PickBox, accept: (layer: StyleLayer) => boolean): PickedFeature[] {
    if (this.gl.isLost) return [];
    const t = frame.transform;
    const zoom = t.zoom;
    const width = Math.max(1, Math.round((box.x1 - box.x0) * frame.pixelRatio));
    const height = Math.max(1, Math.round((box.y1 - box.y0) * frame.pixelRatio));
    const hx = Math.max(box.x1 - box.x0, 1 / frame.pixelRatio) / t.width;
    const hy = Math.max(box.y1 - box.y0, 1 / frame.pixelRatio) / t.height;
    const cx = (box.x0 + box.x1) / t.width - 1;
    const cy = 1 - (box.y0 + box.y1) / t.height;
    const clip = Float64Array.of(1 / hx, 0, 0, 0, 0, 1 / hy, 0, 0, 0, 0, 1, 0, -cx / hx, -cy / hy, 0, 1);
    const stats: PaintStats = { drawCalls: 0, pieces: 0 };
    const found: PickedFeature[] = [];
    this.pickBuffer.begin(width, height);
    try {
      for (let i = frame.layers.length - 1; i >= 0; i--) {
        const layer = frame.layers[i]!;
        if (!layer.isVisible(zoom) || !accept(layer)) continue;
        if (layer.type !== "fill" && layer.type !== "line" && layer.type !== "circle" && layer.type !== "extrusion")
          continue;
        const manager = vectorManager(layer.source ? frame.sources.get(layer.source) : undefined);
        if (!manager) continue;
        const draws: { piece: RenderPiece<VectorTile>; bucket: VectorBucket }[] = [];
        const pass: PickPass = {
          clip,
          scale: [hx, hy],
          register: (piece, bucket) => draws.push({ piece, bucket }),
        };
        this.pickBuffer.clear();
        this.vector.draw(frame, layer, manager, stats, pass);
        if (draws.length === 0) continue;
        const pixels = this.pickBuffer.read();
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
    } finally {
      this.pickBuffer.end();
    }
    const labels = this.labels.hits(box, (layer) => layer.isVisible(zoom) && accept(layer));
    const order = new Map(frame.layers.map((l, i) => [l, i]));
    return [...labels, ...found].sort((a, b) => (order.get(b.layer) ?? 0) - (order.get(a.layer) ?? 0));
  }

  destroy(): void {
    this.pickBuffer.destroy();
    this.labels.destroy();
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteVertexArray(this.quadVao);
    this.gl.deleteTexture(this.openMask);
    this.quadBuffer = null;
    this.quadVao = null;
    this.openMask = null;
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
    const zoom = frame.transform.zoom;
    const ctx = { zoom };
    const exaggeration = Math.min(1, Math.max(0, layer.paintValue<number>("exaggeration", ctx)));
    if (exaggeration <= 0) return;
    const program = g.program(hillshadeShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    const anchor = layer.fixed<string>("illuminationAnchor") === "map" ? 0 : frame.transform.bearing;
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
      if (!data?.gradientTexture) continue;
      const { z, x, y } = piece.tile;
      const n = 2 ** z;
      const size = data.grid.size;
      g.bindTexture(0, data.gradientTexture);
      g.bindTexture(1, data.maskTexture ?? this.openMask);
      frame.transform.tileMatrix(z, x, y, piece.wrap, 1, this.matrix);
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
