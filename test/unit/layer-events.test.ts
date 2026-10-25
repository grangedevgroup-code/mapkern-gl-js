import assert from "node:assert/strict";
import { test } from "node:test";
import type { LayerEventType, PointerInput, PointerType } from "../../src/core/layer-events.ts";
import { LayerEvents } from "../../src/core/layer-events.ts";
import type { QueriedFeature } from "../../src/core/query.ts";

interface Fired {
  type: LayerEventType;
  ids: unknown[];
  x: number;
  prevent: () => void;
}

function feature(layer: string, id: number): QueriedFeature {
  return { type: "Feature", id, properties: {}, geometry: null, layer, source: "s", sourceLayer: undefined, state: {} };
}

function setup(under: (x: number) => QueriedFeature[]) {
  const queries: { x: number; layers: readonly string[] }[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const events = new LayerEvents<Fired>({
    query: async (point, layers) => {
      queries.push({ x: point[0], layers });
      if (gate) await gate;
      return under(point[0]).filter((f) => layers.includes(f.layer));
    },
    event: (type, input, features, prevent) => ({ type, ids: features.map((f) => f.id), x: input.point[0], prevent }),
    active: () => true,
  });
  const input = (type: PointerType, x: number): PointerInput => ({
    type,
    event: {} as MouseEvent,
    point: [x, 0],
    lngLat: null,
  });
  return {
    events,
    queries,
    input,
    hold() {
      gate = new Promise((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
    },
    release() {
      release?.();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("clicks reach listeners only when their layers are under the pointer", async () => {
  const { events, input } = setup((x) => (x < 10 ? [feature("parks", 1), feature("water", 9)] : []));
  const fired: Fired[] = [];
  events.add("click", ["parks"], (e) => fired.push(e));
  await events.dispatch(input("click", 5));
  await events.dispatch(input("click", 50));
  assert.deepEqual(
    fired.map((e) => [e.type, e.ids]),
    [["click", [1]]],
  );
  assert.equal(events.dispatch(input("mousedown", 5)), null);
});

test("enter fires once per visit and leave fires when the pointer moves off", async () => {
  const { events, input } = setup((x) => (x < 10 ? [feature("parks", 1)] : x < 20 ? [feature("parks", 2)] : []));
  const log: string[] = [];
  events.add("mouseenter", ["parks"], (e) => log.push(`enter ${e.ids}`));
  events.add("mouseleave", ["parks"], (e) => log.push(`leave ${e.ids.length}`));
  for (const x of [50, 5, 15, 30, 7]) await events.dispatch(input("mousemove", x));
  await events.dispatch(input("mouseout", 7));
  assert.deepEqual(log, ["enter 1", "leave 0", "enter 1", "leave 0"]);
});

test("mouse moves are merged while a query is running and order is kept", async () => {
  const t = setup((x) => [feature("parks", x)]);
  const fired: Fired[] = [];
  t.events.add("mousemove", ["parks"], (e) => fired.push(e));
  t.events.add("click", ["parks"], (e) => fired.push(e));
  t.hold();
  const first = t.events.dispatch(t.input("mousemove", 1));
  await settle();
  t.events.dispatch(t.input("mousemove", 2));
  t.events.dispatch(t.input("mousemove", 3));
  const click = t.events.dispatch(t.input("click", 4));
  t.events.dispatch(t.input("mousemove", 5));
  t.release();
  await first;
  await click;
  await settle();
  assert.deepEqual(
    t.queries.map((q) => q.x),
    [1, 3, 4, 5],
  );
  assert.deepEqual(
    fired.map((e) => `${e.type}:${e.x}`),
    ["mousemove:1", "mousemove:3", "click:4", "mousemove:5"],
  );
});

test("preventDefault in a listener is reported back to the caller", async () => {
  const { events, input } = setup(() => [feature("pins", 3)]);
  events.add("mousedown", ["pins"], (e) => e.prevent());
  assert.equal(await events.dispatch(input("mousedown", 1)), true);
  events.add("dblclick", ["pins"], () => {});
  assert.equal(await events.dispatch(input("dblclick", 1)), false);
});

test("one query serves every listener and removed listeners stay quiet", async () => {
  const { events, input, queries } = setup(() => [feature("a", 1), feature("b", 2)]);
  const seen: string[] = [];
  const onA = (e: Fired) => seen.push(`a${e.ids}`);
  events.add("click", ["a"], onA);
  events.add("click", ["b", "a"], (e) => seen.push(`ab${e.ids.join("")}`));
  await events.dispatch(input("click", 1));
  assert.equal(queries.length, 1);
  assert.deepEqual([...queries[0]!.layers].sort(), ["a", "b"]);
  events.remove("click", ["a"], onA);
  await events.dispatch(input("click", 1));
  assert.deepEqual(seen, ["a1", "ab12", "ab12"]);
});

test("a throwing listener does not stop the others", async () => {
  const { events, input } = setup(() => [feature("a", 1)]);
  const seen: number[] = [];
  const thrown: unknown[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    try {
      fn();
    } catch (error) {
      thrown.push(error);
    }
    return 0;
  }) as typeof setTimeout;
  try {
    events.add("click", ["a"], () => {
      throw new Error("boom");
    });
    events.add("click", ["a"], () => seen.push(1));
    await events.dispatch(input("click", 1));
  } finally {
    globalThis.setTimeout = original;
  }
  assert.deepEqual(seen, [1]);
  assert.equal(thrown.length, 1);
});
