import assert from "node:assert/strict";
import { test } from "node:test";
import type { StyleImage } from "../../src/render/images.ts";
import { ImageAtlas, premultiplied } from "../../src/render/images.ts";

function solid(id: string, width: number, height: number, value: number, sprite = false): StyleImage {
  const data = new Uint8Array(width * height * 4).fill(value);
  return { id, width, height, data, pixelRatio: 1, sdf: false, sprite };
}

function pixel(atlas: ImageAtlas, x: number, y: number): number[] {
  const i = (y * atlas.width + x) * 4;
  return [...atlas.data.subarray(i, i + 4)];
}

test("images are packed without overlapping and keep a clear gutter", () => {
  const atlas = new ImageAtlas();
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    const id = `icon-${i}`;
    atlas.add(solid(id, 10 + (i % 7) * 3, 8 + (i % 5) * 4, 1 + i));
    ids.push(id);
  }
  const rects = ids.map((id) => atlas.get(id)!);
  for (let a = 0; a < rects.length; a++) {
    const r = rects[a]!;
    assert.ok(r.x >= 1 && r.y >= 1 && r.x + r.image.width < atlas.width && r.y + r.image.height < atlas.height);
    assert.deepEqual(pixel(atlas, r.x, r.y), [1 + a, 1 + a, 1 + a, 1 + a]);
    for (let b = a + 1; b < rects.length; b++) {
      const s = rects[b]!;
      const apart =
        r.x + r.image.width + 2 <= s.x ||
        s.x + s.image.width + 2 <= r.x ||
        r.y + r.image.height + 2 <= s.y ||
        s.y + s.image.height + 2 <= r.y;
      assert.ok(apart, `${r.image.id} overlaps ${s.image.id}`);
    }
  }
});

test("the atlas grows when it fills up and keeps every image", () => {
  const atlas = new ImageAtlas();
  for (let i = 0; i < 30; i++) atlas.add(solid(`big-${i}`, 60, 60, 1 + i));
  const generation = atlas.generation;
  for (let i = 0; i < 30; i++) assert.ok(atlas.get(`big-${i}`), `big-${i} was not placed`);
  assert.ok(atlas.width * atlas.height >= 30 * 62 * 62);
  assert.ok(atlas.generation > generation);
  for (let i = 0; i < 30; i++) {
    const r = atlas.get(`big-${i}`)!;
    assert.deepEqual(pixel(atlas, r.x + 30, r.y + 30), [1 + i, 1 + i, 1 + i, 1 + i]);
  }
});

test("an update of the same size is written in place", () => {
  const atlas = new ImageAtlas();
  atlas.add(solid("a", 8, 8, 5));
  atlas.add(solid("b", 8, 8, 6));
  const before = atlas.get("a")!;
  atlas.dirty = null;
  const generation = atlas.generation;
  const version = atlas.version;
  atlas.add(solid("a", 8, 8, 9));
  const after = atlas.get("a")!;
  assert.equal(after.x, before.x);
  assert.equal(after.y, before.y);
  assert.equal(atlas.generation, generation);
  assert.ok(atlas.version > version);
  const dirty = atlas.dirty as { y0: number; y1: number } | null;
  assert.ok(dirty && dirty.y0 <= after.y && dirty.y1 >= after.y + 8);
  assert.deepEqual(pixel(atlas, after.x + 3, after.y + 3), [9, 9, 9, 9]);
});

test("removing and resizing repack the remaining images", () => {
  const atlas = new ImageAtlas();
  atlas.add(solid("a", 8, 8, 5));
  atlas.add(solid("b", 8, 8, 6, true));
  atlas.add(solid("c", 8, 8, 7));
  for (const id of ["a", "b", "c"]) atlas.get(id);
  assert.equal(atlas.remove("a"), true);
  assert.equal(atlas.remove("a"), false);
  assert.equal(atlas.get("a"), undefined);
  atlas.add(solid("c", 20, 12, 8));
  const c = atlas.get("c")!;
  assert.equal(c.image.width, 20);
  assert.deepEqual(pixel(atlas, c.x + 10, c.y + 6), [8, 8, 8, 8]);
  atlas.clearSprites();
  assert.equal(atlas.has("b"), false);
  assert.deepEqual(atlas.list(), ["c"]);
});

test("pixels are stored premultiplied", () => {
  const out = premultiplied({ width: 1, height: 2, data: Uint8Array.of(255, 128, 0, 128, 10, 20, 30, 0) });
  assert.deepEqual([...out], [128, 64, 0, 128, 0, 0, 0, 0]);
  assert.throws(() => premultiplied({ width: 2, height: 2, data: new Uint8Array(4) }), /expected 16/);
});
