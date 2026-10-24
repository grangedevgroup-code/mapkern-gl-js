import type { TerrainSlot } from "../terrain/terrain.ts";
import type { GL } from "./gl.ts";

export interface RenderView {
  readonly zoom: number;
  readonly bearing: number;
  readonly width: number;
  readonly height: number;
  tileMatrix(z: number, x: number, y: number, wrap: number, extent: number, out: Float32Array): Float32Array;
}

export class SlotView implements RenderView {
  readonly zoom: number;
  readonly bearing: number;
  readonly width: number;
  readonly height: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly size: number;

  constructor(slot: TerrainSlot, zoom: number, bearing: number, cssSize: number) {
    const n = 2 ** slot.z;
    this.zoom = zoom;
    this.bearing = bearing;
    this.width = cssSize;
    this.height = cssSize;
    this.x0 = slot.wrap + slot.x / n;
    this.y0 = slot.y / n;
    this.size = 1 / n;
  }

  tileMatrix(z: number, x: number, y: number, wrap: number, extent: number, out: Float32Array): Float32Array {
    const n = 2 ** z;
    const scale = 1 / (extent * n * this.size);
    out.fill(0);
    out[0] = 2 * scale;
    out[5] = -2 * scale;
    out[10] = 1;
    out[12] = (2 * (wrap + x / n - this.x0)) / this.size - 1;
    out[13] = 1 - (2 * (y / n - this.y0)) / this.size;
    out[15] = 1;
    return out;
  }

  overlaps(z: number, x: number, y: number, wrap: number): boolean {
    const n = 2 ** z;
    const x0 = wrap + x / n;
    const y0 = y / n;
    return x0 < this.x0 + this.size && x0 + 1 / n > this.x0 && y0 < this.y0 + this.size && y0 + 1 / n > this.y0;
  }
}

export interface DrapeEntry {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  size: number;
  signature: number;
  zoom: number;
  used: number;
}

export class DrapeCache {
  private readonly gl: GL;
  private readonly entries = new Map<string, DrapeEntry>();
  private frame = 0;

  constructor(gl: GL) {
    this.gl = gl;
  }

  get bytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += entryBytes(e);
    return total;
  }

  get count(): number {
    return this.entries.size;
  }

  begin(): void {
    this.frame++;
  }

  lookup(key: string): DrapeEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) entry.used = this.frame;
    return entry;
  }

  target(key: string, size: number): DrapeEntry {
    let entry = this.entries.get(key);
    if (entry && entry.size !== size) {
      this.release(entry);
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      const g = this.gl;
      const gl = g.gl;
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      if (!texture || !framebuffer) throw new Error("Could not create a terrain texture");
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, Math.log2(size) + 1, gl.RGBA8, size, size);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      g.applyAnisotropy();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      entry = { texture, framebuffer, size, signature: Number.NaN, zoom: Number.NaN, used: this.frame };
      this.entries.set(key, entry);
    }
    entry.used = this.frame;
    return entry;
  }

  trim(budget: number): void {
    const old = [...this.entries].filter(([, e]) => e.used !== this.frame).sort((a, b) => a[1].used - b[1].used);
    let spare = 0;
    for (const [, entry] of old) spare += entryBytes(entry);
    for (const [key, entry] of old) {
      if (spare <= budget) break;
      spare -= entryBytes(entry);
      this.release(entry);
      this.entries.delete(key);
    }
  }

  reset(): void {
    this.entries.clear();
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }

  private release(entry: DrapeEntry): void {
    if (this.gl.isLost) return;
    this.gl.gl.deleteFramebuffer(entry.framebuffer);
    this.gl.gl.deleteTexture(entry.texture);
  }
}

function entryBytes(entry: DrapeEntry): number {
  return Math.round((entry.size * entry.size * 4 * 4) / 3);
}

export class Hash {
  private h = 0x811c9dc5;
  private readonly f = new Float64Array(1);
  private readonly u = new Uint32Array(this.f.buffer);

  reset(): this {
    this.h = 0x811c9dc5;
    return this;
  }

  add(value: number): this {
    this.f[0] = value;
    this.h = Math.imul(this.h ^ this.u[0]!, 16777619);
    this.h = Math.imul(this.h ^ this.u[1]!, 16777619);
    return this;
  }

  get value(): number {
    return this.h >>> 0;
  }
}
