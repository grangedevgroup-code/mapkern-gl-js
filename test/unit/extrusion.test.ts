import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTRUSION_STRIDE, ExtrusionBuilder } from "../../src/worker/buckets.ts";

interface Vertex {
  x: number;
  y: number;
  nx: number;
  ny: number;
  nz: number;
  top: boolean;
}

function vertices(builder: ExtrusionBuilder): Vertex[] {
  const buffer = builder.vertices.finish();
  const view = new DataView(buffer);
  const out: Vertex[] = [];
  for (let o = 0; o < buffer.byteLength; o += EXTRUSION_STRIDE) {
    out.push({
      x: view.getInt16(o, true),
      y: view.getInt16(o + 2, true),
      nx: view.getInt8(o + 4),
      ny: view.getInt8(o + 5),
      nz: view.getInt8(o + 6),
      top: view.getInt8(o + 7) > 0,
    });
  }
  return out;
}

const square = (x0: number, y0: number, x1: number, y1: number) => Int32Array.of(x0, y0, x1, y0, x1, y1, x0, y1, x0, y0);
const reversed = (ring: Int32Array) => {
  const out = new Int32Array(ring.length);
  for (let i = 0, j = ring.length - 2; i < ring.length; i += 2, j -= 2) {
    out[i] = ring[j]!;
    out[i + 1] = ring[j + 1]!;
  }
  return out;
};

test("a box gets a roof and four walls", () => {
  const builder = new ExtrusionBuilder(4096);
  builder.addPolygon([square(100, 100, 200, 200)], 0);
  const v = vertices(builder);
  assert.equal(v.length, 4 + 4 * 4);
  assert.equal(builder.indices.finish().byteLength / 4, 6 + 4 * 6);
  const roof = v.filter((p) => p.nz > 0);
  assert.equal(roof.length, 4);
  assert.ok(roof.every((p) => p.top));
  const walls = v.filter((p) => p.nz === 0);
  assert.equal(walls.filter((p) => p.top).length, 8);
});

test("walls face away from the building", () => {
  const builder = new ExtrusionBuilder(4096);
  builder.addPolygon([square(100, 100, 200, 200)], 0);
  for (const p of vertices(builder).filter((q) => q.nz === 0)) {
    const outX = p.x === 100 && p.nx < 0;
    const outXr = p.x === 200 && p.nx > 0;
    const outY = p.y === 100 && p.ny < 0;
    const outYb = p.y === 200 && p.ny > 0;
    assert.ok(outX || outXr || outY || outYb, `wall at ${p.x},${p.y} faces ${p.nx},${p.ny}`);
  }
});

test("courtyard walls face into the courtyard, whichever way the rings wind", () => {
  for (const flip of [false, true]) {
    const outer = square(0, 0, 300, 300);
    const hole = reversed(square(100, 100, 200, 200));
    const builder = new ExtrusionBuilder(4096);
    builder.addPolygon(flip ? [reversed(outer), reversed(hole)] : [outer, hole], 0);
    const inner = vertices(builder).filter((p) => p.nz === 0 && p.x >= 100 && p.x <= 200 && p.y >= 100 && p.y <= 200);
    assert.equal(inner.length, 16);
    for (const p of inner) {
      const intoX = (p.x === 100 && p.nx > 0) || (p.x === 200 && p.nx < 0);
      const intoY = (p.y === 100 && p.ny > 0) || (p.y === 200 && p.ny < 0);
      assert.ok(intoX || intoY, `courtyard wall at ${p.x},${p.y} faces ${p.nx},${p.ny}`);
    }
  }
});

test("walls along the tile buffer are left out", () => {
  const builder = new ExtrusionBuilder(4096);
  builder.addPolygon([square(-64, 100, 200, 200)], 0);
  const walls = vertices(builder).filter((p) => p.nz === 0);
  assert.equal(walls.length, 4 * 3);
  assert.ok(walls.every((p) => p.x >= 0 || p.y === 100 || p.y === 200));
});
