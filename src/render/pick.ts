import type { GL } from "./gl.ts";

const ZERO = new Uint32Array(4);
const ONE = new Float32Array([1]);

export class PickBuffer {
  private readonly gl: GL;
  private framebuffer: WebGLFramebuffer | null = null;
  private color: WebGLTexture | null = null;
  private depth: WebGLRenderbuffer | null = null;
  private width = 0;
  private height = 0;
  private pixels = new Uint32Array(0);

  constructor(gl: GL) {
    this.gl = gl;
  }

  begin(width: number, height: number): void {
    const gl = this.gl.gl;
    if (!this.framebuffer || width !== this.width || height !== this.height) this.allocate(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.gl.setViewport(0, 0, width, height);
  }

  clear(): void {
    const gl = this.gl.gl;
    this.gl.setDepth(false, true);
    gl.clearBufferuiv(gl.COLOR, 0, ZERO);
    gl.clearBufferfv(gl.DEPTH, 0, ONE);
  }

  read(): Uint32Array {
    const gl = this.gl.gl;
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.pixels);
    return this.pixels;
  }

  end(): void {
    this.gl.gl.bindFramebuffer(this.gl.gl.FRAMEBUFFER, null);
  }

  reset(): void {
    this.framebuffer = null;
    this.color = null;
    this.depth = null;
    this.width = 0;
    this.height = 0;
  }

  destroy(): void {
    const gl = this.gl.gl;
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.color) gl.deleteTexture(this.color);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    this.reset();
  }

  private allocate(width: number, height: number): void {
    const gl = this.gl.gl;
    this.destroy();
    this.color = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, width, height);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.width = width;
    this.height = height;
    this.pixels = new Uint32Array(width * height * 4);
  }
}
