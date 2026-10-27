import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync, deflateSync } from "node:zlib";
import { InflateError, inflateSync } from "../../src/formats/inflate.ts";

function sample(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = i % 7 === 0 ? x >>> 24 : (i * 31 + (x >>> 29)) & 63;
  }
  return out;
}

test("inflate reads what zlib writes at every level, including stored and fixed blocks", () => {
  for (const size of [0, 1, 100, 5000, 70000, 300000]) {
    const data = sample(size, size + 1);
    for (const level of [0, 1, 6, 9]) {
      assert.deepEqual(inflateSync(deflateSync(data, { level })), data, `size ${size} level ${level}`);
      assert.deepEqual(inflateSync(deflateRawSync(data, { level }), false), data, `raw size ${size} level ${level}`);
    }
  }
  const text = new TextEncoder().encode("Olympia, Washington 98501, United States ".repeat(500));
  assert.deepEqual(inflateSync(deflateSync(text, { strategy: 4 })), text);
});

test("broken or cut data is reported instead of returning garbage", () => {
  const packed = deflateSync(sample(10000, 3));
  assert.throws(() => inflateSync(packed.subarray(0, packed.length >> 1)), InflateError);
  assert.throws(() => inflateSync(new Uint8Array([1, 2, 3])), InflateError);
});
