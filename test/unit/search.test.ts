import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchIndex, SearchIndexSet } from "../../src/search/index.ts";
import { tokenize, withinEdits } from "../../src/search/text.ts";
import type { RegionData } from "../../tools/tiles/extract.ts";
import type { Tags } from "../../tools/tiles/osm-pbf.ts";
import { collectEntries, stitch, writeSearchIndex } from "../../tools/tiles/search.ts";

function town(): RegionData {
  const nodes: [number, number, number][] = [];
  const points: RegionData["points"] = [];
  const ways: { id: number; refs: number[]; tags: Tags | null }[] = [];
  let nextNode = 1;
  const node = (lon: number, lat: number, tags?: Tags) => {
    const id = nextNode++;
    nodes.push([id, Math.round(lon * 1e7), Math.round(lat * 1e7)]);
    if (tags) points.push({ id, lon: Math.round(lon * 1e7), lat: Math.round(lat * 1e7), tags });
    return id;
  };
  const way = (id: number, coords: [number, number][], tags: Tags | null) => {
    ways.push({ id, refs: coords.map(([x, y]) => node(x, y)), tags });
  };
  const square = (id: number, x0: number, y0: number, x1: number, y1: number) => {
    const a = node(x0, y0);
    const b = node(x1, y0);
    const c = node(x1, y1);
    const d = node(x0, y1);
    ways.push({ id, refs: [a, b, c, d, a], tags: null });
  };
  square(1, 0, 0, 0.03, 0.03);
  square(2, -1, -1, 2, 2);
  node(0.015, 0.015, { place: "city", name: "Testville", population: "40000" });
  node(1.015, 1.015, { place: "town", name: "Farburg" });
  way(
    10,
    [
      [0.005, 0.01],
      [0.01, 0.01],
    ],
    { highway: "residential", name: "Main Street" },
  );
  way(
    11,
    [
      [0.01, 0.01],
      [0.02, 0.01],
    ],
    { highway: "residential", name: "Main Street" },
  );
  way(
    12,
    [
      [0.01, 0.005],
      [0.01, 0.025],
    ],
    { highway: "tertiary", name: "Oak Avenue" },
  );
  way(
    13,
    [
      [1.01, 1.01],
      [1.02, 1.01],
    ],
    { highway: "residential", name: "Main Street" },
  );
  node(0.012, 0.0101, { "addr:housenumber": "100", "addr:street": "Main Street", "addr:postcode": "98501" });
  node(0.014, 0.0101, { "addr:housenumber": "102", "addr:street": "Main Street" });
  way(
    14,
    [
      [0.0102, 0.02],
      [0.0104, 0.02],
      [0.0104, 0.0202],
      [0.0102, 0.0202],
      [0.0102, 0.02],
    ],
    { building: "yes", "addr:housenumber": "5", "addr:street": "Oak Avenue" },
  );
  ways[ways.length - 1]!.refs[4] = ways[ways.length - 1]!.refs[0]!;
  node(0.011, 0.0099, { amenity: "cafe", name: "Bean There", "name:fr": "Café Là" });
  node(0.016, 0.011, { shop: "supermarket", name: "Corner Market" });
  nodes.sort((a, b) => a[0] - b[0]);
  ways.sort((a, b) => a.id - b.id);
  const offsets = [0];
  const refs: number[] = [];
  for (const w of ways) {
    refs.push(...w.refs);
    offsets.push(refs.length);
  }
  return {
    bbox: [-0.5, -0.5, 1.5, 1.5],
    warnings: [],
    nodeIds: Float64Array.from(nodes, (n) => n[0]),
    nodeLon: Int32Array.from(nodes, (n) => n[1]),
    nodeLat: Int32Array.from(nodes, (n) => n[2]),
    points,
    wayIds: Float64Array.from(ways, (w) => w.id),
    wayOffsets: Uint32Array.from(offsets),
    wayRefs: Float64Array.from(refs),
    wayTags: ways.map((w) => w.tags),
    relations: [
      {
        id: 1,
        tags: { type: "boundary", boundary: "administrative", admin_level: "8", name: "Testville" },
        members: [{ type: 1, ref: 1, role: "outer" }],
      },
      {
        id: 2,
        tags: { type: "boundary", boundary: "administrative", admin_level: "4", name: "Teststate" },
        members: [{ type: 1, ref: 2, role: "outer" }],
      },
    ],
  };
}

const BOX: [number, number, number, number] = [-0.5, -0.5, 1.5, 1.5];
const file = writeSearchIndex(BOX, collectEntries(town()));
const index = await SearchIndex.load(file);

test("text is folded to plain lowercase tokens with street words shortened", () => {
  assert.deepEqual(tokenize("Saint-Étienne's North Street"), ["saint", "etiennes", "n", "st"]);
  assert.deepEqual(tokenize("  "), []);
});

test("typo distance counts a swapped pair as one edit and gives up past the limit", () => {
  assert.equal(withinEdits("olympai", "olympia", 1), 1);
  assert.equal(withinEdits("cafe", "cafes", 1), 1);
  assert.equal(withinEdits("cafe", "cafe", 1), 0);
  assert.equal(withinEdits("market", "basket", 1), -1);
});

test("an index file opens from bytes or a Blob and rejects other files", async () => {
  assert.equal(index.size, collectEntries(town()).length);
  assert.deepEqual(index.bbox, BOX);
  const fromBlob = await SearchIndex.load(new Blob([file as BlobPart]));
  assert.equal((await fromBlob.search("corner"))[0]?.name, "Corner Market");
  await assert.rejects(SearchIndex.load(new Uint8Array(200)), /not a Mapkern search index/);
});

test("pieces of one street become one result with its town and region", async () => {
  const [first, ...rest] = await index.search("main st", { near: [0.01, 0.01] });
  assert.equal(first?.kind, "street");
  assert.equal(first?.name, "Main Street");
  assert.equal(first?.context, "Testville, Teststate");
  assert.equal(rest.filter((r) => r.kind === "street" && r.context.startsWith("Testville")).length, 0);
});

test("a house number finds the address", async () => {
  const [first] = await index.search("100 main");
  assert.equal(first?.kind, "address");
  assert.equal(first?.name, "100 Main Street");
  assert.deepEqual(first?.address, { number: "100", street: "Main Street" });
  assert.equal(first?.context, "Testville, Teststate 98501");
});

test("a building with an address is found at its middle", async () => {
  const [first] = await index.search("5 oak avenue");
  assert.equal(first?.name, "5 Oak Avenue");
  assert.ok(Math.abs(first!.center[0] - 0.0103) < 1e-6 && Math.abs(first!.center[1] - 0.0201) < 1e-6);
});

test("typos, partial words and other languages still match", async () => {
  assert.equal((await index.search("testvile"))[0]?.name, "Testville");
  assert.equal((await index.search("bean th"))[0]?.name, "Bean There");
  assert.equal((await index.search("cafe la"))[0]?.name, "Bean There");
});

test("a category word finds places of that kind, also with a town", async () => {
  assert.equal((await index.search("coffee"))[0]?.name, "Bean There");
  assert.equal((await index.search("cafe testville"))[0]?.name, "Bean There");
  assert.equal((await index.search("grocery"))[0]?.name, "Corner Market");
});

test("the nearer of two equal names comes first", async () => {
  const far = await index.search("main street", { near: [1.015, 1.01], kinds: ["street"] });
  assert.equal(far[0]?.context, "Farburg, Teststate");
  const close = await index.search("main street", { near: [0.01, 0.01], kinds: ["street"] });
  assert.equal(close[0]?.context, "Testville, Teststate");
  assert.equal(close.length, 2);
});

test("a single letter suggests towns, the nearest first", async () => {
  assert.deepEqual(
    (await index.search("t", { near: [0.01, 0.01] })).map((r) => r.name),
    ["Testville", "Teststate"],
  );
  assert.deepEqual(await index.search("t", { kinds: ["street"] }), []);
});

test("kinds and bbox narrow the results", async () => {
  assert.ok((await index.search("main", { kinds: ["address"] })).every((r) => r.kind === "address"));
  assert.ok((await index.search("main", { bbox: [0.5, 0.5, 1.5, 1.5] })).every((r) => r.center[0] > 0.5));
  assert.deepEqual(await index.search("zzzz"), []);
});

test("reverse geocoding gives the nearest address, place of business, street and town", async () => {
  const near = await index.reverse([0.0116, 0.01]);
  assert.deepEqual(
    near.map((r) => [r.kind, r.name]),
    [
      ["address", "100 Main Street"],
      ["poi", "Bean There"],
      ["street", "Main Street"],
      ["place", "Testville"],
    ],
  );
  assert.ok(near[0]!.distance! < 60);
  assert.equal((await index.reverse([0.0116, 0.01], { kinds: ["street"] }))[0]?.name, "Main Street");
  assert.deepEqual(await index.reverse([0.5, 0.5], { kinds: ["address"] }), []);
});

test("a set of indexes searches all of them and keeps one copy of each place", async () => {
  const set = new SearchIndexSet([index, await SearchIndex.load(file)]);
  const names = (await set.search("corner")).map((r) => r.osm);
  assert.equal(names.length, 1);
  assert.equal((await set.reverse([0.0116, 0.01], { kinds: ["address"] })).length, 1);
});

test("long posting lists, many term blocks and many entry blocks read back exactly", async () => {
  const entries = [];
  for (let i = 0; i < 9000; i++) {
    entries.push({
      osm: i * 4,
      kind: 1,
      rank: i % 200,
      category: null,
      name: `${i} Long Road`,
      number: String(i),
      street: "Long Road",
      context: `Town ${i % 7}`,
      lon: (i % 100) * 0.001,
      lat: Math.floor(i / 100) * 0.001,
      shape: null,
      tokens: new Set([String(i), "long", "rd", `word${i}`]),
    });
  }
  const big = await SearchIndex.load(writeSearchIndex([0, 0, 0.1, 0.1], entries));
  assert.equal(big.size, 9000);
  const hit = await big.search("8765 long rd");
  assert.equal(hit[0]?.name, "8765 Long Road");
  assert.equal(hit[0]?.context, "Town 1");
  assert.equal((await big.search("word4321"))[0]?.address?.number, "4321");
  const nearest = await big.reverse([0.0501, 0.0502], { kinds: ["address"], limit: 1 });
  assert.equal(nearest[0]?.name, "5050 Long Road");
});

test("border pieces of any length are stitched into one closed ring", () => {
  const n = 500_000;
  const a = new Float64Array(n * 2);
  const b = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[i * 2] = i / n;
    a[i * 2 + 1] = 0;
    b[i * 2] = 1 - i / n;
    b[i * 2 + 1] = 1;
  }
  const rings = stitch([a, b]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0]!.length, n * 4 + 2);
  assert.equal(rings[0]![0], rings[0]![rings[0]!.length - 2]);
});
