import assert from "node:assert/strict";
import { test } from "node:test";
import { featureIdValue, featureKey } from "../../src/formats/mvt.ts";
import { FeatureStates } from "../../src/style/feature-state.ts";

test("states are kept per source and source layer", () => {
  const states = new FeatureStates();
  states.set("roads", "streets", 7, { hover: true });
  states.set("roads", "paths", 7, { hover: false });
  states.set("parks", undefined, 7, { open: 1 });
  assert.deepEqual(states.get("roads", "streets", 7), { hover: true });
  assert.deepEqual(states.get("roads", "paths", 7), { hover: false });
  assert.deepEqual(states.get("parks", undefined, 7), { open: 1 });
  assert.deepEqual(states.get("roads", "streets", 8), {});
});

test("setting merges keys and only real changes bump the version", () => {
  const states = new FeatureStates();
  const scope = states.scope("s", undefined);
  states.set("s", undefined, 1, { hover: true });
  const after = scope.version;
  states.set("s", undefined, 1, { hover: true });
  assert.equal(scope.version, after);
  states.set("s", undefined, 1, { selected: true });
  assert.deepEqual(states.get("s", undefined, 1), { hover: true, selected: true });
  assert.equal(scope.version, after + 1);
});

test("the change log lists the features touched since a version", () => {
  const states = new FeatureStates();
  const scope = states.scope("s", undefined);
  const start = scope.version;
  states.set("s", undefined, 1, { hover: true });
  states.set("s", undefined, 2, { hover: true });
  states.set("s", undefined, 1, { hover: false });
  assert.deepEqual([...(scope.changedSince(start) ?? [])].sort(), [1, 2]);
  assert.deepEqual([...(scope.changedSince(scope.version) ?? [])], []);
  states.remove("s", undefined, undefined, undefined);
  assert.equal(scope.changedSince(start), null);
});

test("a long change log falls back to a full refresh", () => {
  const states = new FeatureStates();
  const scope = states.scope("s", undefined);
  const start = scope.version;
  for (let i = 0; i < 2000; i++) states.set("s", undefined, i, { n: i });
  assert.equal(scope.changedSince(start), null);
  const recent = scope.version - 3;
  assert.deepEqual([...(scope.changedSince(recent) ?? [])], [1997, 1998, 1999]);
});

test("removing one key, one feature or a whole source", () => {
  const states = new FeatureStates();
  states.set("s", undefined, 1, { hover: true, selected: true });
  states.set("s", undefined, 2, { hover: true });
  states.remove("s", undefined, 1, "hover");
  assert.deepEqual(states.get("s", undefined, 1), { selected: true });
  states.remove("s", undefined, 1, undefined);
  assert.deepEqual(states.get("s", undefined, 1), {});
  assert.deepEqual(states.get("s", undefined, 2), { hover: true });
  states.dropSource("s");
  assert.deepEqual(states.get("s", undefined, 2), {});
});

test("returned states are copies", () => {
  const states = new FeatureStates();
  states.set("s", undefined, 1, { hover: true });
  const copy = states.get("s", undefined, 1);
  copy.hover = false;
  assert.deepEqual(states.get("s", undefined, 1), { hover: true });
});

test("feature ids map to stable keys", () => {
  assert.equal(featureKey(42), 42);
  assert.equal(featureKey("42"), 42);
  assert.equal(featureKey(Number.NaN), undefined);
  assert.equal(featureKey(""), undefined);
  assert.equal(featureKey(true), undefined);
  const us = featureKey("US");
  assert.equal(us, featureKey("US"));
  assert.ok(us !== undefined && us < 0 && Number.isSafeInteger(us));
  const keys = new Set<number | undefined>();
  for (let i = 0; i < 50000; i++) keys.add(featureKey(`feature-${i}`));
  assert.equal(keys.size, 50000);
  assert.equal(featureIdValue("US"), "US");
  assert.equal(featureIdValue(7), 7);
  assert.equal(featureIdValue(null), undefined);
});
