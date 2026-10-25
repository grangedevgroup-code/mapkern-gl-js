import { BYTES, VARINT, Writer } from "../../src/formats/protobuf.ts";

export interface TestGlyph {
  id: number;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

export function glyphRange(name: string, start: number, glyphs: readonly TestGlyph[]): Uint8Array {
  const w = new Writer();
  w.message(1, (stack) => {
    stack.tag(1, BYTES);
    stack.string(name);
    stack.tag(2, BYTES);
    stack.string(`${start}-${start + 255}`);
    for (const g of glyphs) {
      stack.message(3, (m) => {
        m.tag(1, VARINT);
        m.varint(g.id);
        if (g.width > 0 && g.height > 0) {
          const bw = g.width + 6;
          const bh = g.height + 6;
          const bitmap = new Uint8Array(bw * bh);
          for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) bitmap[y * bw + x] = x >= 3 && x < bw - 3 && y >= 3 && y < bh - 3 ? 255 : 0;
          }
          m.tag(2, BYTES);
          m.bytes(bitmap);
        }
        m.tag(3, VARINT);
        m.varint(g.width);
        m.tag(4, VARINT);
        m.varint(g.height);
        m.tag(5, VARINT);
        m.svarint(g.left);
        m.tag(6, VARINT);
        m.svarint(g.top);
        m.tag(7, VARINT);
        m.varint(g.advance);
      });
    }
  });
  return w.finish();
}

export const BLOCK_FONT: readonly TestGlyph[] = [
  { id: 32, width: 0, height: 0, left: 0, top: -20, advance: 6 },
  { id: 87, width: 14, height: 14, left: 1, top: -6, advance: 16 },
];
