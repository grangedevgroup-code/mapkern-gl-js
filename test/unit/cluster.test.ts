import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClusterLeaf, ClusterSettings } from "../../src/worker/cluster.ts";
import { abbreviate, ClusterTree } from "../../src/worker/cluster.ts";

const settings = (extra: Partial<ClusterSettings> = {}): ClusterSettings => ({
  radius: 50,
  maxZoom: 14,
  minPoints: 2,
  properties: {},
  ...extra,
});

function grid(count: number, spacing: number): ClusterLeaf[] {
  const out: ClusterLeaf[] = [];
  const side = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    out.push({ x: 0.3 + (i % side) * spacing, y: 0.4 + Math.floor(i / side) * spacing, properties: { value: i } });
  }
  return out;
}

test("every zoom level keeps every point exactly once", () => {
  const leaves = grid(400, 0.0003);
  const tree = new ClusterTree(leaves, settings());
  for (let z = 0; z <= 14; z++) {
    const entities = tree.entitiesIn(z, 0, 0, 1, 1);
    const total = entities.reduce((sum, e) => sum + e.count, 0);
    assert.equal(total, 400, `zoom ${z} holds ${total} points`);
  }
  assert.equal(tree.entitiesIn(0, 0, 0, 1, 1).length, 1);
  assert.equal(tree.entitiesIn(14, 0, 0, 1, 1).length, 400);
});

test("points closer than the radius merge and far ones stay apart", () => {
  const leaves: ClusterLeaf[] = [
    { x: 0.5, y: 0.5, properties: {} },
    { x: 0.5 + 10 / (512 * 2 ** 8), y: 0.5, properties: {} },
    { x: 0.7, y: 0.5, properties: {} },
  ];
  const tree = new ClusterTree(leaves, settings());
  const at8 = tree.entitiesIn(8, 0, 0, 1, 1);
  assert.equal(at8.length, 2);
  const cluster = at8.find((e) => e.cluster >= 0)!;
  assert.equal(cluster.count, 2);
  assert.ok(Math.abs(cluster.x - (0.5 + 5 / (512 * 2 ** 8))) < 1e-12, "the center is the average of its points");
  assert.equal(tree.entitiesIn(12, 0, 0, 1, 1).length, 3);
});

test("minPoints keeps small groups as single points", () => {
  const leaves: ClusterLeaf[] = [
    { x: 0.5, y: 0.5, properties: {} },
    { x: 0.5000001, y: 0.5, properties: {} },
  ];
  const tree = new ClusterTree(leaves, settings({ minPoints: 3 }));
  assert.equal(tree.clusters.length, 0);
  assert.equal(tree.entitiesIn(0, 0, 0, 1, 1).length, 2);
});

test("cluster children, leaves and the zoom that splits them", () => {
  const leaves = grid(50, 0.00002);
  const tree = new ClusterTree(leaves, settings());
  const [top] = tree.entitiesIn(0, 0, 0, 1, 1);
  assert.ok(top && top.cluster >= 0);
  const id = top.cluster;
  const zoom = tree.expansionZoom(id);
  const children = tree.children(id);
  assert.ok(children.length >= 2);
  const childCounts = children.reduce((sum, c) => sum + c.count, 0);
  assert.equal(childCounts, 50);
  const atSplit = tree.entitiesIn(zoom, 0, 0, 1, 1);
  for (const child of children) assert.ok(atSplit.includes(child), "children are what you see at the expansion zoom");
  const all = tree.leaves(id, Number.POSITIVE_INFINITY, 0);
  assert.deepEqual(
    [...all].sort((a, b) => a - b),
    [...Array(50).keys()],
  );
  assert.deepEqual(tree.leaves(id, 5, 10), all.slice(10, 15));
  const props = tree.properties(id);
  assert.equal(props.cluster, true);
  assert.equal(props.cluster_id, id);
  assert.equal(props.point_count, 50);
});

test("cluster properties add up values from every point", () => {
  const leaves = grid(30, 0.00001);
  const tree = new ClusterTree(
    leaves,
    settings({
      properties: {
        sum: ["+", ["get", "value"]],
        biggest: ["max", ["get", "value"]],
        names: [
          ["concat", ["accumulated"], ",", ["get", "names"]],
          ["to-string", ["get", "value"]],
        ],
      },
    }),
  );
  const [top] = tree.entitiesIn(0, 0, 0, 1, 1);
  const props = tree.properties(top!.cluster);
  assert.equal(props.sum, (29 * 30) / 2);
  assert.equal(props.biggest, 29);
  const names = String(props.names).split(",").map(Number);
  assert.deepEqual(
    names.sort((a, b) => a - b),
    [...Array(30).keys()],
  );
});

test("counts are shortened the usual way", () => {
  assert.equal(abbreviate(999), 999);
  assert.equal(abbreviate(1234), "1.2k");
  assert.equal(abbreviate(15500), "16k");
});

test("a large set clusters quickly", () => {
  const leaves: ClusterLeaf[] = [];
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 100000; i++) leaves.push({ x: random(), y: 0.3 + random() * 0.4, properties: {} });
  const started = performance.now();
  const tree = new ClusterTree(leaves, settings({ maxZoom: 16 }));
  const elapsed = performance.now() - started;
  assert.equal(
    tree.entitiesIn(3, 0, 0, 1, 1).reduce((sum, e) => sum + e.count, 0),
    100000,
  );
  assert.ok(elapsed < 4000, `clustering 100k points took ${elapsed.toFixed(0)} ms`);
});
