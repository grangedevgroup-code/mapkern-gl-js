import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { ByteRanges } from "../../src/formats/sqlite.ts";
import { MBTilesArchive } from "../../src/sources/mbtiles.ts";

const dir = mkdtempSync(join(tmpdir(), "maplet-mbtiles-"));
after(() => rmSync(dir, { recursive: true, force: true }));

class FileRanges implements ByteRanges {
  reads = 0;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(offset: number, length: number): Promise<{ data: Uint8Array }> {
    this.reads++;
    const fd = openSync(this.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const n = readSync(fd, buffer, 0, length, offset);
      return { data: new Uint8Array(buffer.buffer, buffer.byteOffset, n) };
    } finally {
      closeSync(fd);
    }
  }
}

const signal = new AbortController().signal;

function tileBytes(z: number, x: number, y: number): Uint8Array {
  return new TextEncoder().encode(`tile ${z}/${x}/${y}`);
}

function bigTile(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let seed = 3;
  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = seed >> 16;
  }
  return out;
}

function create(name: string, pageSize: number, schema: string[], fill: (db: DatabaseSync) => void): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA page_size = ${pageSize}`);
  for (const statement of schema) db.exec(statement);
  db.exec("CREATE TABLE metadata (name text, value text)");
  const meta = db.prepare("INSERT INTO metadata VALUES (?, ?)");
  meta.run("name", "Test tiles");
  meta.run("format", "pbf");
  meta.run("minzoom", "0");
  meta.run("maxzoom", "6");
  meta.run("bounds", "-123,47,-122,48");
  meta.run("json", JSON.stringify({ vector_layers: [{ id: "roads", fields: {} }] }));
  fill(db);
  db.close();
  return path;
}

const BIG = bigTile(300_000);

function fillTiles(db: DatabaseSync): void {
  const insert = db.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  for (let z = 0; z <= 6; z++) {
    const n = 2 ** z;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) insert.run(z, x, n - 1 - y, z === 6 && x === 5 && y === 7 ? BIG : tileBytes(z, x, y));
    }
  }
  db.exec("COMMIT");
}

async function check(path: string): Promise<FileRanges> {
  const ranges = new FileRanges(path);
  const archive = new MBTilesArchive(ranges, path);
  const meta = await archive.metadata(signal);
  assert.equal(meta.name, "Test tiles");
  for (const [z, x, y] of [
    [0, 0, 0],
    [3, 2, 5],
    [6, 63, 0],
    [6, 0, 63],
  ] as const) {
    assert.deepEqual(await archive.tile(z, x, y, signal), tileBytes(z, x, y), `tile ${z}/${x}/${y}`);
  }
  assert.deepEqual(await archive.tile(6, 5, 7, signal), BIG);
  assert.equal(await archive.tile(7, 0, 0, signal), null);
  return ranges;
}

test("tiles table with its own index, at several page sizes", async () => {
  for (const pageSize of [512, 4096, 65536]) {
    const path = create(
      `table-${pageSize}.mbtiles`,
      pageSize,
      [
        "CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)",
        "CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row)",
      ],
      fillTiles,
    );
    await check(path);
  }
});

test("tiles table indexed through its primary key", async () => {
  const path = create(
    "primary.mbtiles",
    4096,
    [
      "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))",
    ],
    fillTiles,
  );
  await check(path);
});

test("map and images tables behind a view", async () => {
  const path = create(
    "split.mbtiles",
    4096,
    [
      "CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT)",
      "CREATE TABLE images (tile_data BLOB, tile_id TEXT)",
      "CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row)",
      "CREATE UNIQUE INDEX images_id ON images (tile_id)",
      "CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column, map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id",
    ],
    (db) => {
      const map = db.prepare("INSERT INTO map VALUES (?, ?, ?, ?)");
      const image = db.prepare("INSERT INTO images VALUES (?, ?)");
      db.exec("BEGIN");
      for (let z = 0; z <= 6; z++) {
        const n = 2 ** z;
        for (let x = 0; x < n; x++) {
          for (let y = 0; y < n; y++) {
            const id = `${z}-${x}-${y}`;
            map.run(z, x, n - 1 - y, id);
            image.run(z === 6 && x === 5 && y === 7 ? BIG : tileBytes(z, x, y), id);
          }
        }
      }
      db.exec("COMMIT");
    },
  );
  await check(path);
});

test("a large tile is read in a few range requests once the index is cached", async () => {
  const path = create(
    "reads.mbtiles",
    4096,
    [
      "CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)",
      "CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row)",
    ],
    fillTiles,
  );
  const ranges = new FileRanges(path);
  const archive = new MBTilesArchive(ranges, path);
  await archive.tile(6, 5, 6, signal);
  const before = ranges.reads;
  assert.deepEqual(await archive.tile(6, 5, 7, signal), BIG);
  assert.ok(ranges.reads - before <= 6, `took ${ranges.reads - before} reads`);
});

test("files that are not MBTiles are rejected clearly", async () => {
  const path = join(dir, "plain.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE things (a, b)");
  db.close();
  await assert.rejects(new MBTilesArchive(new FileRanges(path), path).tile(0, 0, 0, signal), /no tiles table/);
  const fake = join(dir, "fake.mbtiles");
  const other = new DatabaseSync(fake);
  other.exec("CREATE TABLE tiles (zoom_level, tile_column, tile_row, tile_data)");
  other.close();
  await assert.rejects(new MBTilesArchive(new FileRanges(fake), fake).tile(0, 0, 0, signal), /no index/);
});
