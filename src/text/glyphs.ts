import { signedDistanceField } from "./sdf.ts";

export const GLYPH_SIZE = 24;
export const GLYPH_BUFFER = 4;
export const SDF_RADIUS = 8;

export interface GlyphMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

export interface FontSpec {
  family: string;
  weight: string;
  italic: boolean;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function fontKey(font: FontSpec): string {
  return `${font.italic ? "i" : "n"}${font.weight}|${font.family}`;
}

export function cssFamily(stack: readonly string[]): string {
  const generic = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-sans-serif",
    "ui-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
  ]);
  return stack.map((f) => (generic.has(f) ? f : `"${f.replace(/["\\]/g, "")}"`)).join(", ");
}

export class GlyphAtlas {
  width = 1024;
  height = 512;
  data: Uint8Array;
  dirty: { y0: number; y1: number } | null = null;
  resized = true;
  private readonly glyphs = new Map<string, GlyphMetrics | null>();
  private shelves: { y: number; height: number; x: number }[] = [];
  private nextY = 0;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: Ctx2D | null = null;
  private readonly maxHeight = 4096;
  generation = 0;

  constructor() {
    this.data = new Uint8Array(this.width * this.height);
  }

  get size(): number {
    return this.glyphs.size;
  }

  has(font: FontSpec, text: string): boolean {
    return this.glyphs.has(`${fontKey(font)}|${text}`);
  }

  get(font: FontSpec, text: string): GlyphMetrics | null | undefined {
    return this.glyphs.get(`${fontKey(font)}|${text}`);
  }

  rasterize(font: FontSpec, text: string): GlyphMetrics | null {
    const key = `${fontKey(font)}|${text}`;
    const existing = this.glyphs.get(key);
    if (existing !== undefined) return existing;
    const ctx = this.context();
    if (!ctx) {
      this.glyphs.set(key, null);
      return null;
    }
    ctx.font = `${font.italic ? "italic " : ""}${font.weight} ${GLYPH_SIZE}px ${font.family}`;
    const m = ctx.measureText(text);
    const advance = m.width;
    const left = Math.ceil(m.actualBoundingBoxLeft ?? 0);
    const right = Math.ceil(m.actualBoundingBoxRight ?? advance);
    const ascent = Math.ceil(m.actualBoundingBoxAscent ?? GLYPH_SIZE * 0.8);
    const descent = Math.ceil(m.actualBoundingBoxDescent ?? GLYPH_SIZE * 0.2);
    const w = Math.max(0, left + right);
    const h = Math.max(0, ascent + descent);
    if (w === 0 || h === 0 || text.trim() === "") {
      const metrics: GlyphMetrics = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, advance };
      this.glyphs.set(key, metrics);
      return metrics;
    }
    const bw = w + GLYPH_BUFFER * 2;
    const bh = h + GLYPH_BUFFER * 2;
    const spot = this.allocate(bw, bh);
    if (!spot) return null;
    const canvas = this.canvas!;
    if (canvas.width < bw || canvas.height < bh) {
      canvas.width = Math.max(canvas.width, bw);
      canvas.height = Math.max(canvas.height, bh);
      ctx.font = `${font.italic ? "italic " : ""}${font.weight} ${GLYPH_SIZE}px ${font.family}`;
    }
    ctx.clearRect(0, 0, bw, bh);
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(text, GLYPH_BUFFER + left, GLYPH_BUFFER + ascent);
    const image = ctx.getImageData(0, 0, bw, bh).data;
    const alpha = new Uint8Array(bw * bh);
    for (let i = 0; i < alpha.length; i++) alpha[i] = image[i * 4 + 3]!;
    const sdf = signedDistanceField(alpha, bw, bh, SDF_RADIUS);
    for (let y = 0; y < bh; y++) this.data.set(sdf.subarray(y * bw, (y + 1) * bw), (spot.y + y) * this.width + spot.x);
    this.markDirty(spot.y, spot.y + bh);
    const metrics: GlyphMetrics = {
      x: spot.x,
      y: spot.y,
      width: bw,
      height: bh,
      left: -left - GLYPH_BUFFER,
      top: -ascent - GLYPH_BUFFER,
      advance,
    };
    this.glyphs.set(key, metrics);
    return metrics;
  }

  reset(): void {
    this.glyphs.clear();
    this.shelves = [];
    this.nextY = 0;
    this.width = 1024;
    this.height = 512;
    this.data = new Uint8Array(this.width * this.height);
    this.resized = true;
    this.dirty = null;
    this.generation++;
  }

  private markDirty(y0: number, y1: number): void {
    if (!this.dirty) this.dirty = { y0, y1 };
    else {
      this.dirty.y0 = Math.min(this.dirty.y0, y0);
      this.dirty.y1 = Math.max(this.dirty.y1, y1);
    }
  }

  private allocate(w: number, h: number): { x: number; y: number } | null {
    if (w > this.width) return null;
    for (const shelf of this.shelves) {
      if (h <= shelf.height && h >= shelf.height * 0.6 && shelf.x + w <= this.width) {
        const spot = { x: shelf.x, y: shelf.y };
        shelf.x += w + 1;
        return spot;
      }
    }
    const shelfHeight = Math.ceil(h / 4) * 4;
    while (this.nextY + shelfHeight > this.height) {
      if (this.height * 2 > this.maxHeight) return null;
      const next = new Uint8Array(this.width * this.height * 2);
      next.set(this.data);
      this.data = next;
      this.height *= 2;
      this.resized = true;
    }
    const shelf = { y: this.nextY, height: shelfHeight, x: w + 1 };
    this.shelves.push(shelf);
    this.nextY += shelfHeight + 1;
    return { x: 0, y: shelf.y };
  }

  private context(): Ctx2D | null {
    if (this.ctx) return this.ctx;
    const size = 128;
    if (typeof OffscreenCanvas !== "undefined") {
      this.canvas = new OffscreenCanvas(size, size);
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    return this.ctx;
  }
}

const COMPLEX =
  /[\u0590-\u08ff\u0900-\u0dff\u0e00-\u0eff\u0f00-\u0fff\u1000-\u109f\u1780-\u17ff\u1800-\u18af\ufb1d-\ufdff\ufe70-\ufeff]/;

export function needsWholeShaping(text: string): boolean {
  return COMPLEX.test(text);
}

export function splitGraphemes(text: string): string[] {
  const segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: string },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (segmenter) {
    const out: string[] = [];
    for (const s of new segmenter(undefined, { granularity: "grapheme" }).segment(text)) out.push(s.segment);
    return out;
  }
  return [...text];
}
