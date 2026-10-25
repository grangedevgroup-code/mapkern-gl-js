import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ByteSource, TiffImage } from "../../src/formats/tiff.ts";
import { blocksAcross, lzw, packBits, readBlock, readTiff } from "../../src/formats/tiff.ts";
import { writeTiff } from "./tiff-writer.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tiff");

function bytes(data: Uint8Array): ByteSource {
  return {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length),
  };
}

async function raster(source: ByteSource, image: TiffImage): Promise<Float32Array> {
  const out = new Float32Array(image.width * image.height);
  const across = blocksAcross(image);
  const down = Math.ceil(image.height / image.blockHeight);
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const block = await readBlock(source, image, by * across + bx);
      const rows = block.length / image.blockWidth;
      for (let r = 0; r < rows; r++) {
        const y = by * image.blockHeight + r;
        if (y >= image.height) break;
        for (let c = 0; c < image.blockWidth; c++) {
          const x = bx * image.blockWidth + c;
          if (x < image.width) out[y * image.width + x] = block[r * image.blockWidth + c]!;
        }
      }
    }
  }
  return out;
}

async function check(source: ByteSource, expect: (x: number, y: number) => number): Promise<TiffImage> {
  const [image] = await readTiff(source);
  assert.ok(image);
  const values = await raster(source, image);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const want = Math.fround(expect(x, y));
      assert.equal(values[y * image.width + x], want, `pixel ${x},${y}`);
    }
  }
  return image;
}

test("float32 with LZW and the floating point predictor, written by libtiff", async () => {
  const source = bytes(readFileSync(join(fixtures, "f32-lzw-predictor3.tif")));
  const image = await check(source, (x, y) => (x === 5 && y === 7 ? -9999 : 100 + 3.5 * x - 2.25 * y + 0.125 * x * y));
  assert.equal(image.compression, 5);
  assert.equal(image.predictor, 3);
  assert.equal(image.noData, -9999);
  assert.ok(image.geo);
  assert.equal(image.geo.epsg, 4326);
  assert.equal(image.geo.geographic, true);
  assert.deepEqual(image.geo.transform, [-121.8, 0.001, 0, 46.9, 0, -0.001]);
});

test("int32 with deflate and horizontal differencing, written by libtiff", async () => {
  const source = bytes(readFileSync(join(fixtures, "i32-deflate-predictor2.tif")));
  const image = await check(source, (x, y) => -500 + 37 * x - 41 * y);
  assert.equal(image.blockHeight, 10);
  assert.equal(image.offsets.length, 5);
});

test("uint16 with PackBits, written by libtiff", async () => {
  await check(bytes(readFileSync(join(fixtures, "u16-packbits.tif"))), (x, y) => 300 * (x % 3) + y);
});

const surface = (x: number, y: number) => 250.25 + Math.sin(x / 7) * 40 - y * 1.5;

test("tiled, big-endian and deflated", async () => {
  const image = await check(
    bytes(
      writeTiff({
        little: false,
        big: false,
        width: 70,
        height: 45,
        tile: 32,
        type: "f32",
        deflate: true,
        value: surface,
      }),
    ),
    surface,
  );
  assert.equal(image.tiled, true);
  assert.equal(image.offsets.length, 6);
});

test("BigTIFF with float64 samples and a transformation matrix", async () => {
  const matrix = [10, 0, 0, 500000, 0, -10, 0, 5200000, 0, 0, 0, 0, 0, 0, 0, 1];
  const keys = [1, 1, 0, 3, 1024, 0, 1, 1, 3072, 0, 1, 32610, 3076, 0, 1, 9001];
  const image = await check(
    bytes(
      writeTiff({
        little: true,
        big: true,
        width: 33,
        height: 21,
        tile: null,
        type: "f64",
        deflate: false,
        value: surface,
        tags: [
          [34264, 12, matrix],
          [34735, 3, keys],
        ],
      }),
    ),
    surface,
  );
  assert.ok(image.geo);
  assert.equal(image.geo.epsg, 32610);
  assert.equal(image.geo.geographic, false);
  assert.deepEqual(image.geo.transform, [500000, 10, 0, 5200000, 0, -10]);
});

test("signed 16-bit samples keep their sign", async () => {
  await check(
    bytes(
      writeTiff({
        little: true,
        big: false,
        width: 20,
        height: 9,
        tile: null,
        type: "i16",
        deflate: true,
        value: (x, y) => x * 300 - y * 4000,
      }),
    ),
    (x, y) => x * 300 - y * 4000,
  );
});

test("PackBits and LZW handle runs, literals and table resets", () => {
  assert.deepEqual(Array.from(packBits(Uint8Array.of(2, 1, 2, 3, 0xfd, 9, 0x80, 0, 7), 8)), [1, 2, 3, 9, 9, 9, 9, 7]);
  const clear = 256;
  const end = 257;
  const codes = [clear, 65, 66, 258, 260, 65, clear, 67, end];
  let bits = "";
  let width = 9;
  let next = 258;
  for (const code of codes) {
    bits += code.toString(2).padStart(width, "0");
    if (code === clear) {
      width = 9;
      next = 258;
    } else if (code !== end) {
      next++;
      if (next + 1 >= 1 << width && width < 12) width++;
    }
  }
  while (bits.length % 8) bits += "0";
  const input = new Uint8Array(bits.length / 8);
  for (let i = 0; i < input.length; i++) input[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const text = String.fromCharCode(...lzw(input, 16));
  assert.equal(text, "ABABABAAC");
});

test("files that are not TIFFs are rejected clearly", async () => {
  await assert.rejects(readTiff(bytes(new TextEncoder().encode("PNG...not a tiff"))), /not a TIFF/);
});
