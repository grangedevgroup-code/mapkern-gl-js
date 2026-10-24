import assert from "node:assert/strict";
import { test } from "node:test";
import { FeatureTable } from "../../src/worker/packed.ts";
import type { LayerProgram } from "../../src/worker/vector-task.ts";
import { buildVectorTile } from "../../src/worker/vector-task.ts";
import { encodeTile } from "../../tools/tiles/mvt-writer.ts";

const circles: LayerProgram = {
  id: "dots",
  type: "circle",
  sourceLayer: "poi",
  filter: null,
  minZoom: 0,
  maxZoom: 24,
  keys: [],
  layout: {},
  sortKey: null,
};

function tile(): ArrayBuffer {
  const bytes = encodeTile([
    {
      name: "poi",
      extent: 4096,
      features: [
        { id: 1, type: 1, parts: [Int32Array.of(100, 100)], props: { osm: 501 } },
        { id: 2, type: 1, parts: [Int32Array.of(200, 200)], props: { osm: "502" } },
        { id: 3, type: 1, parts: [Int32Array.of(300, 300)], props: { name: "no id" } },
      ],
    },
  ]);
  return bytes.slice().buffer;
}

async function ids(promoteId: string | null): Promise<(number | undefined)[]> {
  const { result } = await buildVectorTile(
    { bytes: tile(), z: 10, x: 0, y: 0, layers: [circles], overzoom: false, promoteId },
    new AbortController().signal,
  );
  const bucket = result.buckets[0]!;
  const table = new FeatureTable(bucket.features);
  return Array.from({ length: bucket.features.count }, (_, i) => table.id(i));
}

test("vector tiles keep their own feature ids", async () => {
  assert.deepEqual(await ids(null), [1, 2, 3]);
});

test("promoteId takes feature ids from a property", async () => {
  assert.deepEqual(await ids("osm"), [501, 502, undefined]);
});
