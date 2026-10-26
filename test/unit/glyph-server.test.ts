import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeGlyphs, fromServer, GlyphServer, genericStack, glyphUrl } from "../../src/text/glyph-server.ts";
import { BLOCK_FONT, glyphRange } from "../browser/glyph-pbf.ts";

test("glyph ranges decode with the top measured up from the baseline", () => {
  const glyphs = decodeGlyphs(glyphRange("Block Regular", 0, BLOCK_FONT));
  const w = glyphs.get(87)!;
  assert.equal(w.width, 14);
  assert.equal(w.height, 14);
  assert.equal(w.left, 1);
  assert.equal(w.top, 14);
  assert.equal(w.advance, 16);
  assert.equal(w.bitmap?.length, 20 * 20);
  const space = glyphs.get(32)!;
  assert.equal(space.bitmap, null);
  assert.equal(space.advance, 6);
});

test("font stacks and ranges go into the address the way glyph servers expect", () => {
  assert.equal(
    glyphUrl("https://example.com/fonts/{fontstack}/{range}.pbf", "Open Sans Regular,Arial Unicode MS Regular", 256),
    "https://example.com/fonts/Open%20Sans%20Regular,Arial%20Unicode%20MS%20Regular/256-511.pbf",
  );
});

test("Chinese, Japanese and Korean stay on the device's fonts", () => {
  assert.equal(fromServer("A"), true);
  assert.equal(fromServer("é"), true);
  assert.equal(fromServer("東"), false);
  assert.equal(fromServer("한"), false);
  assert.equal(fromServer("カ"), false);
  assert.equal(fromServer("😀"), false);
});

test("each range loads once and missing or failed ranges fall back", async () => {
  const asked: string[] = [];
  let arrived = 0;
  const server = new GlyphServer(
    "https://example.com/{fontstack}/{range}.pbf",
    async (url) => {
      asked.push(url);
      if (url.includes("256-511")) throw new Error("offline");
      return glyphRange("Block Regular", 0, BLOCK_FONT);
    },
    () => arrived++,
  );
  assert.equal(server.glyph("Block Regular", 87), undefined);
  assert.equal(server.glyph("Block Regular", 88), undefined);
  assert.equal(server.loading, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.loading, false);
  assert.equal(server.glyph("Block Regular", 87)?.width, 14);
  assert.equal(server.glyph("Block Regular", 88), null);
  assert.equal(server.glyph("Block Regular", 300), undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.glyph("Block Regular", 300), null);
  assert.deepEqual(asked, [
    "https://example.com/Block%20Regular/0-255.pbf",
    "https://example.com/Block%20Regular/256-511.pbf",
  ]);
  assert.equal(arrived, 2);
});

test("generic families like sans-serif go to the device's fonts without asking the server", async () => {
  assert.equal(genericStack("sans-serif"), true);
  assert.equal(genericStack("system-ui, serif"), true);
  assert.equal(genericStack("Noto Sans Regular,sans-serif"), false);
  const asked: string[] = [];
  const server = new GlyphServer(
    "https://fonts.example/{fontstack}/{range}.pbf",
    async (url) => {
      asked.push(url);
      return null;
    },
    () => {},
  );
  assert.equal(server.glyph("sans-serif", 65), null);
  assert.equal(server.glyph("Noto Sans Regular", 65), undefined);
  assert.deepEqual(asked, ["https://fonts.example/Noto%20Sans%20Regular/0-255.pbf"]);
  server.destroy();
});
