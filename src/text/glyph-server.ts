import { Reader } from "../formats/protobuf.ts";

export interface ServerGlyph {
  readonly bitmap: Uint8Array | null;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advance: number;
}

export const SERVER_BORDER = 3;

export type GlyphLoader = (url: string, signal: AbortSignal) => Promise<Uint8Array | null>;

interface RawGlyph {
  id: number;
  bitmap: Uint8Array | null;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

export function decodeGlyphs(bytes: Uint8Array): Map<number, ServerGlyph> {
  const raw: RawGlyph[] = [];
  const top = new Reader(bytes);
  while (!top.done) {
    const tag = top.tag();
    if (tag >> 3 !== 1) {
      top.skip(tag & 7);
      continue;
    }
    const stack = top.sub();
    while (!stack.done) {
      const t = stack.tag();
      if (t >> 3 !== 3) {
        stack.skip(t & 7);
        continue;
      }
      const g = stack.sub();
      const glyph: RawGlyph = { id: -1, bitmap: null, width: 0, height: 0, left: 0, top: 0, advance: 0 };
      while (!g.done) {
        const gt = g.tag();
        switch (gt >> 3) {
          case 1:
            glyph.id = g.varint();
            break;
          case 2:
            glyph.bitmap = g.bytes();
            break;
          case 3:
            glyph.width = g.varint();
            break;
          case 4:
            glyph.height = g.varint();
            break;
          case 5:
            glyph.left = g.svarint();
            break;
          case 6:
            glyph.top = g.svarint();
            break;
          case 7:
            glyph.advance = g.varint();
            break;
          default:
            g.skip(gt & 7);
        }
      }
      if (glyph.id >= 0) raw.push(glyph);
    }
  }
  const space = raw.find((g) => g.id === 32);
  const capital = raw.find((g) => g.id === 72);
  const ascender = space ? -space.top : capital ? capital.height - capital.top : 24;
  const out = new Map<number, ServerGlyph>();
  for (const g of raw) {
    const size = (g.width + SERVER_BORDER * 2) * (g.height + SERVER_BORDER * 2);
    const bitmap = g.width > 0 && g.height > 0 && g.bitmap && g.bitmap.length >= size ? g.bitmap : null;
    out.set(g.id, {
      bitmap,
      width: g.width,
      height: g.height,
      left: g.left,
      top: g.top + ascender,
      advance: g.advance,
    });
  }
  return out;
}

export function glyphUrl(template: string, stack: string, start: number): string {
  const encoded = stack
    .split(",")
    .map((name) => encodeURIComponent(name.trim()))
    .join(",");
  return template.replace("{fontstack}", encoded).replace("{range}", `${start}-${start + 255}`);
}

const LOCAL = /[ᄀ-ᇿ⺀-⿟⿰-〿぀-ヿ㄀-㆏ㆠ-ㇿ㈀-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/;

export function fromServer(unit: string): boolean {
  if (unit.length === 0 || unit.length > 2) return false;
  const cp = unit.codePointAt(0)!;
  if (cp > 0xffff ? unit.length !== 2 : unit.length !== 1) return false;
  return cp <= 0xffff && !LOCAL.test(unit);
}

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

export function genericStack(stack: string): boolean {
  const names = stack
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  return names.length > 0 && names.every((name) => GENERIC.has(name));
}

export class GlyphServer {
  readonly template: string;
  private readonly load: GlyphLoader;
  private readonly arrived: () => void;
  private readonly ranges = new Map<string, Map<number, ServerGlyph> | null | "loading">();
  private readonly controller = new AbortController();
  private waiting = 0;

  constructor(template: string, load: GlyphLoader, arrived: () => void) {
    this.template = template;
    this.load = load;
    this.arrived = arrived;
  }

  glyph(stack: string, codepoint: number): ServerGlyph | null | undefined {
    if (genericStack(stack)) return null;
    const start = Math.floor(codepoint / 256) * 256;
    const key = `${stack}|${start}`;
    const range = this.ranges.get(key);
    if (range === undefined) {
      this.fetch(stack, start, key);
      return undefined;
    }
    if (range === "loading") return undefined;
    if (range === null) return null;
    return range.get(codepoint) ?? null;
  }

  get loading(): boolean {
    return this.waiting > 0;
  }

  destroy(): void {
    this.controller.abort();
  }

  private fetch(stack: string, start: number, key: string): void {
    this.ranges.set(key, "loading");
    this.waiting++;
    this.load(glyphUrl(this.template, stack, start), this.controller.signal)
      .then((bytes) => {
        this.ranges.set(key, bytes ? decodeGlyphs(bytes) : null);
      })
      .catch(() => {
        this.ranges.set(key, null);
      })
      .finally(() => {
        this.waiting--;
        if (!this.controller.signal.aborted) this.arrived();
      });
  }
}
