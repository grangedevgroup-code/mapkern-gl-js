import type { RGBA } from "../style/color.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { GL } from "./gl.ts";

export interface HeatTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

const RAMP_SIZE = 256;
const MAX_TARGETS = 3;

export class HeatmapResources {
  private readonly gl: GL;
  private targets = new Map<string, HeatTarget>();
  private ramps = new Map<number, { revision: number; zoom: number; texture: WebGLTexture }>();
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private floatTargets: boolean | null = null;

  constructor(gl: GL) {
    this.gl = gl;
  }

  target(width: number, height: number): HeatTarget | null {
    const key = `${width}x${height}`;
    const found = this.targets.get(key);
    if (found) return found;
    if (this.targets.size >= MAX_TARGETS) this.dropTargets();
    const gl = this.gl.gl;
    this.floatTargets ??= gl.getExtension("EXT_color_buffer_float") !== null;
    const made =
      this.make(width, height, this.floatTargets) ?? (this.floatTargets ? this.make(width, height, false) : null);
    if (made) this.targets.set(key, made);
    return made;
  }

  ramp(layer: StyleLayer, zoom: number): WebGLTexture | null {
    const color = layer.paintProperty<unknown>("color");
    const key = color.zoomDependent ? Math.round(zoom * 20) / 20 : 0;
    const cached = this.ramps.get(layer.uid);
    if (cached && cached.revision === layer.revision && cached.zoom === key) return cached.texture;
    const data = new Uint8Array(RAMP_SIZE * 4);
    for (let i = 0; i < RAMP_SIZE; i++) {
      const value = color.evaluate({ zoom, density: i / (RAMP_SIZE - 1) });
      const c = (Array.isArray(value) && value.length === 4 ? value : [0, 0, 0, 0]) as RGBA;
      data[i * 4] = Math.round(c[0] * c[3] * 255);
      data[i * 4 + 1] = Math.round(c[1] * c[3] * 255);
      data[i * 4 + 2] = Math.round(c[2] * c[3] * 255);
      data[i * 4 + 3] = Math.round(c[3] * 255);
    }
    const gl = this.gl.gl;
    const texture = cached?.texture ?? gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, RAMP_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.ramps.set(layer.uid, { revision: layer.revision, zoom: key, texture });
    return texture;
  }

  drawQuad(): void {
    const gl = this.gl.gl;
    if (!this.quadVao) {
      this.quadVao = gl.createVertexArray();
      this.quadBuffer = gl.createBuffer();
      gl.bindVertexArray(this.quadVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, Float32Array.of(-1, -1, 1, -1, -1, 1, 1, 1), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    }
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  forget(uid: number): void {
    const ramp = this.ramps.get(uid);
    if (!ramp) return;
    this.gl.deleteTexture(ramp.texture);
    this.ramps.delete(uid);
  }

  reset(): void {
    this.targets = new Map();
    this.ramps = new Map();
    this.quadVao = null;
    this.quadBuffer = null;
    this.floatTargets = null;
  }

  destroy(): void {
    this.dropTargets();
    for (const ramp of this.ramps.values()) this.gl.deleteTexture(ramp.texture);
    this.gl.deleteVertexArray(this.quadVao);
    this.gl.deleteBuffer(this.quadBuffer);
    this.reset();
  }

  private dropTargets(): void {
    const gl = this.gl;
    for (const t of this.targets.values()) {
      gl.deleteTexture(t.texture);
      if (!gl.isLost) gl.gl.deleteFramebuffer(t.framebuffer);
    }
    this.targets.clear();
  }

  private make(width: number, height: number, float: boolean): HeatTarget | null {
    const gl = this.gl.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    if (!complete) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      return null;
    }
    return { texture, framebuffer, width, height, scale: float ? 1 : 0.25 };
  }
}
