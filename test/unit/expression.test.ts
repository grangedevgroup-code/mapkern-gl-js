import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvalContext } from "../../src/style/expression.ts";
import { compile, ExpressionError } from "../../src/style/expression.ts";

const feature = (properties: Record<string, unknown>, extra: Partial<EvalContext> = {}): EvalContext => ({
  zoom: 10,
  feature: { properties, id: 7, geometryType: "Point" },
  ...extra,
});

const run = (expression: unknown, ctx: EvalContext = feature({}), kind: "any" | "number" | "string" = "any") =>
  compile<unknown>(expression, kind, null, "test", true).evaluate(ctx);

const close = (a: unknown, b: number, eps = 1e-6) => {
  assert.equal(typeof a, "number");
  assert.ok(Math.abs((a as number) - b) <= eps, `${a} != ${b}`);
};

test("feature data and lookups", () => {
  const ctx = feature({ name: "Rainier", height: 4392, tags: ["peak", "volcano"] });
  assert.equal(run(["get", "name"], ctx), "Rainier");
  assert.equal(run(["has", "height"], ctx), true);
  assert.equal(run(["has", "missing"], ctx), false);
  assert.equal(run(["id"], ctx), 7);
  assert.equal(run(["geometry-type"], ctx), "Point");
  assert.equal(run(["at", 1, ["get", "tags"]], ctx), "volcano");
  assert.equal(run(["at", 5, ["get", "tags"]], ctx), null);
  assert.equal(run(["index-of", "volcano", ["get", "tags"]], ctx), 1);
  assert.equal(run(["index-of", "ni", ["get", "name"]], ctx), 3);
  assert.deepEqual(run(["split", "a,b,c", ","]), ["a", "b", "c"]);
  assert.equal(run(["length", ["get", "tags"]], ctx), 2);
});

test("decisions, matching and steps", () => {
  const ctx = feature({ kind: "trail", width: 3 });
  assert.equal(run(["match", ["get", "kind"], ["road", "street"], 1, "trail", 2, 0], ctx), 2);
  assert.equal(run(["case", [">", ["get", "width"], 5], "wide", "narrow"], ctx), "narrow");
  assert.equal(run(["coalesce", ["get", "missing"], "fallback"], ctx), "fallback");
  assert.equal(run(["step", ["zoom"], "low", 8, "mid", 12, "high"], ctx), "mid");
  assert.equal(run(["all", ["==", ["get", "kind"], "trail"], ["<", ["get", "width"], 4]], ctx), true);
  assert.equal(run(["any", ["==", ["get", "kind"], "road"], ["!", true]], ctx), false);
  assert.equal(run(["in", "b", ["literal", ["a", "b"]]], ctx), true);
});

test("variables keep a value for reuse", () => {
  const ctx = feature({ a: 3, b: 4 });
  assert.equal(run(["let", "x", ["*", ["get", "a"], 2], "y", 1, ["+", ["var", "x"], ["var", "y"]]], ctx), 7);
  assert.throws(() => compile(["var", "nope"], "any", null), ExpressionError);
  assert.throws(() => compile(["let", "x", 1], "any", null), ExpressionError);
});

test("type assertions return the first value of the right type", () => {
  const ctx = feature({ n: "12", m: 5, list: [1, 2, 3] });
  assert.equal(run(["number", ["get", "n"], ["get", "m"]], ctx), 5);
  assert.equal(run(["string", ["get", "m"], "x"], ctx), "x");
  assert.equal(run(["boolean", ["get", "m"]], ctx), null);
  assert.deepEqual(run(["array", "number", 3, ["get", "list"]], ctx), [1, 2, 3]);
  assert.equal(run(["array", "string", ["get", "list"]], ctx), null);
  assert.deepEqual(run(["object", ["literal", { a: 1 }]]), { a: 1 });
});

test("math, including the inverse trigonometry", () => {
  close(run(["+", 1, 2, 3]), 6);
  close(run(["-", 10, 4]), 6);
  close(run(["/", 9, 3]), 3);
  close(run(["%", 10, 4]), 2);
  close(run(["^", 2, 10]), 1024);
  close(run(["acos", 1]), 0);
  close(run(["asin", 1]), Math.PI / 2);
  close(run(["atan", 1]), Math.PI / 4);
  close(run(["ln2"]), Math.LN2);
  close(run(["sqrt", 16]), 4);
  close(run(["max", 3, 9, 4]), 9);
});

test("interpolation along curves", () => {
  const z = (zoom: number) => ({ zoom });
  close(run(["interpolate", ["linear"], ["zoom"], 10, 0, 20, 100], z(15)), 50);
  close(run(["interpolate", ["exponential", 2], ["zoom"], 0, 0, 2, 3], z(1)), 1);
  const bezier = run(["interpolate", ["cubic-bezier", 0.42, 0, 0.58, 1], ["zoom"], 0, 0, 1, 1], z(0.5));
  close(bezier, 0.5, 1e-3);
});

test("colors in rgb, hsl, lab and hcl", () => {
  assert.deepEqual(run(["to-rgba", ["rgb", 255, 128, 0]]), [255, 128, 0, 1]);
  const red = run(["hsl", 0, 100, 50]) as number[];
  assert.deepEqual(
    red.map((v) => Math.round(v * 1000) / 1000),
    [1, 0, 0, 1],
  );
  const hsla = run(["to-hsla", "#00ff00"]) as number[];
  assert.deepEqual(
    hsla.map((v) => Math.round(v)),
    [120, 100, 50, 1],
  );
  const lab = run(["interpolate-lab", ["linear"], ["zoom"], 0, "#000000", 1, "#ffffff"], { zoom: 0.5 }) as number[];
  close(lab[0], lab[1]!, 1e-6);
  assert.ok(lab[0]! > 0.4 && lab[0]! < 0.5, `perceptual middle grey was ${lab[0]}`);
  const hcl = compile<unknown>(
    ["interpolate-hcl", ["linear"], ["zoom"], 0, "#ff0000", 1, "#0000ff"],
    "color",
    null,
  ).evaluate({
    zoom: 0,
  }) as number[];
  assert.deepEqual(
    hcl.map((v) => Math.round(v * 100) / 100),
    [1, 0, 0, 1],
  );
});

test("number formatting follows the locale", () => {
  assert.equal(run(["number-format", 1234.5678, { locale: "en-US", "max-fraction-digits": 1 }]), "1,234.6");
  assert.equal(run(["number-format", 3.5, { locale: "en-US", currency: "USD" }]), "$3.50");
  assert.equal(run(["number-format", 1234.5, { locale: "de-DE", "min-fraction-digits": 2 }]), "1.234,50");
});

test("feature state is read in paint properties only", () => {
  const hover = ["case", ["boolean", ["feature-state", "hover"], false], "#ff0000", "#0000ff"];
  const paint = compile(hover, "any", null, "paint", true);
  assert.equal(paint.stateDependent, true);
  assert.equal(paint.featureDependent, true);
  assert.equal(paint.evaluate(feature({}, { state: { hover: true } })), "#ff0000");
  assert.equal(paint.evaluate(feature({})), "#0000ff");
  assert.throws(() => compile(hover, "any", null, "filter", false), /only works in paint properties/);
  assert.equal(compile(["get", "a"], "any", null, "x", true).stateDependent, false);
});

test("strings", () => {
  const ctx = feature({ name: "Mount Rainier" });
  assert.equal(run(["upcase", ["get", "name"]], ctx), "MOUNT RAINIER");
  assert.equal(run(["concat", ["get", "name"], " (", 4392, " m)"], ctx), "Mount Rainier (4392 m)");
  assert.equal(run(["slice", ["get", "name"], 6], ctx), "Rainier");
  assert.equal(run(["is-supported-script", "日本語"]), true);
  assert.equal(run(["to-string", 3]), "3");
  assert.equal(run(["to-number", "12.5"]), 12.5);
});

test("bad expressions are reported with their path", () => {
  assert.throws(
    () => compile(["match", ["get", "a"], 1], "any", null, "layers[2].paint.color"),
    /layers\[2\]\.paint\.color/,
  );
  assert.throws(() => compile(["interpolate", ["linear"], ["zoom"], 5, 1, 2, 0], "any", null), /stops must increase/);
  assert.throws(() => compile(["number-format", 1, 5], "any", null), /options object/);
  assert.throws(() => compile(["nonsense", 1], "boolean", false), /unknown expression "nonsense"/);
  assert.throws(() => compile(["all", ["==", ["get", "a"], 1], ["hsa", "b"]], "boolean", false), /"hsa"/);
  assert.equal(
    compile(["match", ["get", "k"], ["a", "b"], 1, 0], "number", 0).evaluate({
      zoom: 0,
      feature: { properties: { k: "b" } },
    }),
    1,
  );
  assert.equal(compile(["in", "b", ["a", "b"]], "boolean", false).evaluate({ zoom: 0 }), true);
  assert.deepEqual(compile(["literal", ["a", "b"]], "any", null).evaluate({ zoom: 0 }), ["a", "b"]);
  assert.deepEqual(compile([0, 1], "any", null).evaluate({ zoom: 0 }), [0, 1]);
});
