import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { deepClone } from "../../src/core/clone.ts";
import { inflateRaw } from "../../src/formats/zip.ts";

test("zip entries inflate the same with and without raw deflate support", async () => {
  const text = new TextEncoder().encode("<kml><Placemark><name>Ridge</name></Placemark></kml>".repeat(40));
  const packed = new Uint8Array(deflateRawSync(text));
  for (const raw of [true, false]) {
    const out = await inflateRaw(packed, crc32(text), text.length, raw);
    assert.deepEqual(out, text);
  }
});

test("deep copies match structuredClone for style data", () => {
  const style = {
    version: 8,
    sources: { a: { type: "vector", tiles: ["https://x/{z}/{x}/{y}"], bounds: [-1, -2, 3, 4] } },
    layers: [{ id: "l", type: "line", paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 4] } }],
    meta: { when: new Date(0), empty: null, skipped: undefined },
  };
  const copy = deepClone(style);
  assert.deepEqual(copy, structuredClone(style));
  assert.notEqual(copy.layers[0], style.layers[0]);
  const saved = globalThis.structuredClone;
  try {
    (globalThis as { structuredClone?: unknown }).structuredClone = undefined;
    const fallback = deepClone(style);
    assert.deepEqual(fallback, style);
    assert.notEqual(fallback.sources.a.bounds, style.sources.a.bounds);
    assert.ok(fallback.meta.when instanceof Date && fallback.meta.when !== style.meta.when);
  } finally {
    globalThis.structuredClone = saved;
  }
});
