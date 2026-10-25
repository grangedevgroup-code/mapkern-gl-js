import type { GL } from "./gl.ts";

const ZERO = new Uint32Array(4);
const ONE = new Float32Array([1]);

export interface PendingRead {
  buffer: WebGLBuffer;
  length: number;
}

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

  copy(): PendingRead | null {
    const gl = this.gl.gl;
    const buffer = gl.createBuffer();
    if (!buffer) return null;
    const length = this.width * this.height * 4;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, length * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { buffer, length };
  }

  async collect(reads: readonly (PendingRead | null)[]): Promise<(Uint32Array | null)[]> {
    const gl = this.gl.gl;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (sync) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.gl.isLost) return resolve();
          const status = gl.clientWaitSync(sync, 0, 0);
          if (status === gl.TIMEOUT_EXPIRED) setTimeout(check, 1);
          else resolve();
        };
        check();
      });
      if (!this.gl.isLost) gl.deleteSync(sync);
    }
    const out: (Uint32Array | null)[] = [];
    for (const read of reads) {
      if (!read || this.gl.isLost) {
        out.push(null);
        continue;
      }
      const pixels = new Uint32Array(read.length);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(read.buffer);
      out.push(pixels);
    }
    return out;
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
