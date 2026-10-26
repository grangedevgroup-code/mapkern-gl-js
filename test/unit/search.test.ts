import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { decodeSearchData, encodeSearchData } from "../../src/search/format.ts";
import { SearchIndex } from "../../src/search/index.ts";
import { tokenize, withinEdits } from "../../src/search/text.ts";
import type { RegionData } from "../../tools/tiles/extract.ts";
import type { Tags } from "../../tools/tiles/osm-pbf.ts";
import { indexRegion } from "../../tools/tiles/search.ts";

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

const index = new SearchIndex(indexRegion(town()).data);

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

test("an index survives writing and reading back", () => {
  const { data } = indexRegion(town());
  const back = decodeSearchData(encodeSearchData(data));
  assert.deepEqual(back.strings, data.strings);
  assert.deepEqual(Array.from(back.postings), Array.from(data.postings));
  assert.deepEqual(Array.from(back.coords), Array.from(data.coords));
  assert.deepEqual(back.bbox, data.bbox);
  assert.throws(() => decodeSearchData(new Uint8Array(40)), /not a Mapkern search index/);
});

test("pieces of one street become one result with its town and region", () => {
  const [first, ...rest] = index.search("main st", { near: [0.01, 0.01] });
  assert.equal(first?.kind, "street");
  assert.equal(first?.name, "Main Street");
  assert.equal(first?.context, "Testville, Teststate");
  assert.equal(rest.filter((r) => r.kind === "street" && r.context.startsWith("Testville")).length, 0);
});

test("a house number finds the address", () => {
  const [first] = index.search("100 main");
  assert.equal(first?.kind, "address");
  assert.equal(first?.name, "100 Main Street");
  assert.deepEqual(first?.address, { number: "100", street: "Main Street" });
  assert.equal(first?.context, "Testville, Teststate 98501");
});

test("a building with an address is found at its middle", () => {
  const [first] = index.search("5 oak avenue");
  assert.equal(first?.name, "5 Oak Avenue");
  assert.ok(Math.abs(first!.center[0] - 0.0103) < 1e-6 && Math.abs(first!.center[1] - 0.0201) < 1e-6);
});

test("typos, partial words and other languages still match", () => {
  assert.equal(index.search("testvile")[0]?.name, "Testville");
  assert.equal(index.search("bean th")[0]?.name, "Bean There");
  assert.equal(index.search("cafe la")[0]?.name, "Bean There");
});

test("a category word finds places of that kind, also with a town", () => {
  assert.equal(index.search("coffee")[0]?.name, "Bean There");
  assert.equal(index.search("cafe testville")[0]?.name, "Bean There");
  assert.equal(index.search("grocery")[0]?.name, "Corner Market");
});

test("the nearer of two equal names comes first", () => {
  const far = index.search("main street", { near: [1.015, 1.01], kinds: ["street"] });
  assert.equal(far[0]?.context, "Farburg, Teststate");
  const close = index.search("main street", { near: [0.01, 0.01], kinds: ["street"] });
  assert.equal(close[0]?.context, "Testville, Teststate");
  assert.equal(close.length, 2);
});

test("kinds and bbox narrow the results", () => {
  assert.ok(index.search("main", { kinds: ["address"] }).every((r) => r.kind === "address"));
  assert.ok(index.search("main", { bbox: [0.5, 0.5, 1.5, 1.5] }).every((r) => r.center[0] > 0.5));
  assert.deepEqual(index.search("zzzz"), []);
});

test("reverse geocoding gives the nearest address, place of business, street and town", () => {
  const near = index.reverse([0.0121, 0.0102]);
  assert.deepEqual(
    near.map((r) => [r.kind, r.name]),
    [
      ["address", "100 Main Street"],
      ["poi", "Bean There"],
      ["street", "Main Street"],
      ["place", "Testville"],
    ],
  );
  assert.ok(near[0]!.distance! < 15);
  assert.equal(index.reverse([0.0121, 0.0102], { kinds: ["street"] })[0]?.name, "Main Street");
  assert.deepEqual(index.reverse([0.5, 0.5], { kinds: ["address"] }), []);
});

test("a gzipped index loads", async () => {
  const bytes = gzipSync(encodeSearchData(indexRegion(town()).data));
  const loaded = await SearchIndex.load(new Uint8Array(bytes));
  assert.equal(loaded.size, index.size);
  assert.equal(loaded.search("corner")[0]?.name, "Corner Market");
});
