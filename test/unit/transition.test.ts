import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../../src/style/expression.ts";
import { StyleLayer } from "../../src/style/layer.ts";
import { blend, checkTransition, settled, Transition, timing } from "../../src/style/transition.ts";

const constant = (value: unknown, kind: "number" | "color") => compile(value, kind, null, "test");

test("numbers blend straight, colors blend without going dark", () => {
  assert.equal(blend("number", 10, 20, 0.25), 12.5);
  assert.equal(blend("number", 10, null, 0.25), null);
  const half = blend("color", [0, 0, 0, 0], [1, 0, 0, 1], 0.5) as number[];
  assert.deepEqual(half, [1, 0, 0, 0.5]);
  const grey = blend("color", [1, 1, 1, 1], [0, 0, 0, 1], 0.5) as number[];
  assert.deepEqual(grey, [0.5, 0.5, 0.5, 1]);
  assert.deepEqual(blend("color", [0, 0, 0, 0], [0, 0, 0, 0], 0.5), [0, 0, 0, 0]);
});

test("timing fills in a duration of 300 ms and treats zero as no transition", () => {
  assert.equal(timing(undefined), null);
  assert.equal(timing({ duration: 0 }), null);
  assert.deepEqual(timing({ delay: 100 }), { duration: 300, delay: 100 });
  assert.deepEqual(timing({ duration: 500 }), { duration: 500, delay: 0 });
  assert.equal(checkTransition({ duration: 200, delay: 0 }), null);
  assert.match(checkTransition({ duration: -1 }) ?? "", /duration/);
  assert.match(checkTransition({ speed: 2 }) ?? "", /speed/);
  assert.match(checkTransition(300) ?? "", /duration, delay/);
});

test("a transition holds, eases and lands, and a second one starts from where the first is", () => {
  let now = 0;
  const clock = () => now;
  const first = new Transition("number", constant(0, "number"), constant(10, "number"), 0, 100, clock);
  const ctx = { zoom: 0 };
  now = -10;
  assert.equal(first.evaluate(ctx), 0);
  now = 50;
  assert.equal(first.evaluate(ctx), 5);
  now = 25;
  assert.ok((first.evaluate(ctx) as number) < 2.5);
  now = 50;
  const second = new Transition("number", first, constant(20, "number"), 50, 150, clock);
  assert.equal(second.evaluate(ctx), 5);
  now = 100;
  assert.equal(second.evaluate(ctx), 15);
  now = 150;
  assert.equal(second.evaluate(ctx), 20);
  assert.equal(settled(second, 150), second.target);
  assert.equal(settled(second, 120), second);
});

test("layers animate constant values and per feature values alike", () => {
  const layer = new StyleLayer({ id: "f", type: "fill", source: "s", paint: { color: "#ffffff" } });
  const start = performance.now();
  layer.setPaint("color", "#000000", { duration: 100 });
  assert.equal(layer.settle(start - 1000), true);
  assert.deepEqual(layer.paintValue("color", { zoom: 0 }), [1, 1, 1, 1]);
  assert.equal(layer.settle(start + 10_000), false);
  assert.deepEqual(layer.paintValue("color", { zoom: 0 }), [0, 0, 0, 1]);
  assert.ok(!(layer.paintProperty("color") instanceof Transition));

  const begin = performance.now();
  layer.setPaint("color", ["get", "color"], { duration: 100 });
  const moving = layer.paintProperty("color");
  assert.ok(moving instanceof Transition && moving.featureDependent && moving.properties.has("color"));
  const feature = {
    zoom: 0,
    feature: { properties: { color: "#ffffff" }, id: undefined, geometryType: "Polygon" as const },
  };
  assert.equal(layer.settle(begin + 50), true);
  const middle = layer.paintValue<number[]>("color", feature);
  assert.ok(middle[0]! > 0.3 && middle[0]! < 0.7, `got ${middle}`);
  assert.equal(layer.settle(begin + 10_000), false);
  assert.deepEqual(layer.paintValue("color", feature), [1, 1, 1, 1]);
});

test("a property's own transition wins over the style's", () => {
  const layer = new StyleLayer({
    id: "f",
    type: "fill",
    source: "s",
    paint: { color: "#ffffff", colorTransition: { duration: 0 } },
  });
  layer.setPaint("color", "#000000", { duration: 500 });
  assert.equal(layer.settle(performance.now()), false);
  layer.setPaint("colorTransition", { duration: 400 });
  layer.setPaint("color", "#ff0000");
  assert.equal(layer.settle(performance.now() - 1000), true);
  assert.throws(() => layer.setPaint("translateTransition", { duration: 100 }), /not a paint property/);
});
