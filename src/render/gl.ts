import { MapkernError } from "../core/errors.ts";

export interface Program {
  readonly name: string;
  readonly handle: WebGLProgram;
  readonly uniforms: ReadonlyMap<string, WebGLUniformLocation>;
  readonly attributes: ReadonlyMap<string, number>;
}

interface ProgramRecord extends Program {
  readonly uniforms: Map<string, WebGLUniformLocation>;
  readonly attributes: Map<string, number>;
  ready: boolean;
  vs: WebGLShader | null;
  fs: WebGLShader | null;
}

export interface ProgramSource {
  name: string;
  vertex: string;
  fragment: string;
  defines?: readonly string[];
}

export type BlendMode = "none" | "premultiplied" | "additive" | "multiply";

export type DataFormat = "rg16f" | "r32f" | "r8";

export class GL {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly maxAnisotropy: number;
  private readonly anisotropic: EXT_texture_filter_anisotropic | null;
  private readonly programs = new Map<string, ProgramRecord>();
  private currentProgram: WebGLProgram | null = null;
  private blend: BlendMode | null = null;
  private depthTest: boolean | null = null;
  private depthMask: boolean | null = null;
  private stencilTest: boolean | null = null;
  private cullFace: boolean | null = null;
  private viewport: [number, number, number, number] = [0, 0, 0, 0];
  private lost = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.anisotropic = gl.getExtension("EXT_texture_filter_anisotropic");
    this.maxAnisotropy = this.anisotropic
      ? Math.min(8, gl.getParameter(this.anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
      : 1;
  }

  static create(canvas: HTMLCanvasElement, attributes: WebGLContextAttributes): GL {
    const gl = canvas.getContext("webgl2", attributes);
    if (!gl) {
      throw new MapkernError("webgl-unavailable", "WebGL 2 is not available in this browser or on this device");
    }
    return new GL(gl);
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  markLost(): void {
    this.lost = true;
    this.programs.clear();
    this.resetState();
  }

  markRestored(): void {
    this.lost = false;
    this.resetState();
  }

  resetState(): void {
    this.currentProgram = null;
    this.blend = null;
    this.depthTest = null;
    this.depthMask = null;
    this.stencilTest = null;
    this.cullFace = null;
    this.viewport = [0, 0, 0, 0];
  }

  program(source: ProgramSource): Program {
    const key =
      source.defines && source.defines.length > 0 ? `${source.name}#${source.defines.join(",")}` : source.name;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const program = this.compile(key, source);
    this.programs.set(key, program);
    return program;
  }

  use(program: Program): void {
    if (this.currentProgram === program.handle) return;
    const record = program as ProgramRecord;
    if (!record.ready) this.verify(record);
    this.gl.useProgram(program.handle);
    this.currentProgram = program.handle;
  }

  setViewport(x: number, y: number, w: number, h: number): void {
    const v = this.viewport;
    if (v[0] === x && v[1] === y && v[2] === w && v[3] === h) return;
    this.gl.viewport(x, y, w, h);
    this.viewport = [x, y, w, h];
  }

  setBlend(mode: BlendMode): void {
    if (this.blend === mode) return;
    const gl = this.gl;
    if (mode === "none") {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      if (mode === "premultiplied") gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else if (mode === "multiply") gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      else gl.blendFunc(gl.ONE, gl.ONE);
    }
    this.blend = mode;
  }

  setDepth(test: boolean, write: boolean): void {
    const gl = this.gl;
    if (this.depthTest !== test) {
      if (test) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      this.depthTest = test;
    }
    if (this.depthMask !== write) {
      gl.depthMask(write);
      this.depthMask = write;
    }
  }

  setStencil(enabled: boolean): void {
    if (this.stencilTest === enabled) return;
    const gl = this.gl;
    if (enabled) gl.enable(gl.STENCIL_TEST);
    else gl.disable(gl.STENCIL_TEST);
    this.stencilTest = enabled;
  }

  setCull(enabled: boolean): void {
    if (this.cullFace === enabled) return;
    const gl = this.gl;
    if (enabled) gl.enable(gl.CULL_FACE);
    else gl.disable(gl.CULL_FACE);
    this.cullFace = enabled;
  }

  createBuffer(target: GLenum, data: ArrayBufferView, usage: GLenum = this.gl.STATIC_DRAW): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) throw new MapkernError("context-lost", "Could not create a GPU buffer");
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, usage);
    return buffer;
  }

  createTexture(source: TexImageSource, options: { mipmap: boolean; premultiplied: boolean }): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new MapkernError("context-lost", "Could not create a GPU texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, options.premultiplied);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (options.mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.applyAnisotropy();
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return texture;
  }

  applyAnisotropy(): void {
    if (this.anisotropic && this.maxAnisotropy > 1) {
      this.gl.texParameterf(this.gl.TEXTURE_2D, this.anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAnisotropy);
    }
  }

  createDataTexture(
    width: number,
    height: number,
    format: DataFormat,
    data: ArrayBufferView,
    linear: boolean,
  ): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new MapkernError("context-lost", "Could not create a GPU texture");
    const [internal, layout, type] = this.dataLayout(format);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, layout, type, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return texture;
  }

  updateDataTexture(
    texture: WebGLTexture,
    x: number,
    y: number,
    width: number,
    height: number,
    format: DataFormat,
    data: ArrayBufferView,
  ): void {
    if (this.isLost) return;
    const gl = this.gl;
    const [, layout, type] = this.dataLayout(format);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, layout, type, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  private dataLayout(format: DataFormat): [GLenum, GLenum, GLenum] {
    const gl = this.gl;
    switch (format) {
      case "rg16f":
        return [gl.RG16F, gl.RG, gl.FLOAT];
      case "r32f":
        return [gl.R32F, gl.RED, gl.FLOAT];
      case "r8":
        return [gl.R8, gl.RED, gl.UNSIGNED_BYTE];
    }
  }

  bindTexture(unit: number, texture: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  deleteTexture(texture: WebGLTexture | null | undefined): void {
    if (texture && !this.isLost) this.gl.deleteTexture(texture);
  }

  deleteBuffer(buffer: WebGLBuffer | null | undefined): void {
    if (buffer && !this.isLost) this.gl.deleteBuffer(buffer);
  }

  deleteVertexArray(vao: WebGLVertexArrayObject | null | undefined): void {
    if (vao && !this.isLost) this.gl.deleteVertexArray(vao);
  }

  destroy(): void {
    if (!this.isLost) {
      for (const p of this.programs.values()) this.gl.deleteProgram(p.handle);
    }
    this.programs.clear();
  }

  private compile(key: string, source: ProgramSource): ProgramRecord {
    const gl = this.gl;
    const prelude = `#version 300 es\nprecision highp float;\n${(source.defines ?? []).map((d) => `#define ${d}\n`).join("")}`;
    const vs = this.shader(gl.VERTEX_SHADER, prelude + source.vertex, key);
    const fs = this.shader(gl.FRAGMENT_SHADER, prelude + source.fragment, key);
    const handle = gl.createProgram();
    if (!handle) throw new MapkernError("shader-compile", `Could not create program ${key}`);
    gl.attachShader(handle, vs);
    gl.attachShader(handle, fs);
    gl.linkProgram(handle);
    return { name: key, handle, uniforms: new Map(), attributes: new Map(), ready: false, vs, fs };
  }

  private verify(program: ProgramRecord): void {
    const gl = this.gl;
    const handle = program.handle;
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS) && !gl.isContextLost()) {
      const logs: string[] = [];
      for (const [stage, shader] of [
        ["vertex", program.vs],
        ["fragment", program.fs],
      ] as const) {
        if (shader && !gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          logs.push(`${stage}: ${gl.getShaderInfoLog(shader) ?? ""}`);
      }
      logs.push(gl.getProgramInfoLog(handle) ?? "");
      const log = logs.filter((l) => l.trim().length > 0).join("\n");
      this.release(program);
      gl.deleteProgram(handle);
      this.programs.delete(program.name);
      throw new MapkernError("shader-compile", `Program ${program.name} failed to build: ${log}`, {
        program: program.name,
        log,
      });
    }
    const uniformCount = gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < uniformCount; i++) {
      const info = gl.getActiveUniform(handle, i);
      if (!info) continue;
      const name = info.name.endsWith("[0]") ? info.name.slice(0, -3) : info.name;
      const loc = gl.getUniformLocation(handle, info.name);
      if (loc) program.uniforms.set(name, loc);
    }
    const attribCount = gl.getProgramParameter(handle, gl.ACTIVE_ATTRIBUTES) as number;
    for (let i = 0; i < attribCount; i++) {
      const info = gl.getActiveAttrib(handle, i);
      if (!info) continue;
      program.attributes.set(info.name, gl.getAttribLocation(handle, info.name));
    }
    this.release(program);
    program.ready = true;
  }

  private release(program: ProgramRecord): void {
    const gl = this.gl;
    for (const shader of [program.vs, program.fs]) {
      if (!shader) continue;
      gl.detachShader(program.handle, shader);
      gl.deleteShader(shader);
    }
    program.vs = null;
    program.fs = null;
  }

  private shader(type: GLenum, text: string, key: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new MapkernError("shader-compile", `Could not create shader for ${key}`);
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    return shader;
  }
}
