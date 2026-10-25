import assert from "node:assert/strict";
import { test } from "node:test";
import { formatHash, parseHash, readHash, writeHash } from "../../src/core/hash.ts";

test("positions are written as zoom/lat/lng with bearing and pitch only when set", () => {
  assert.equal(formatHash({ zoom: 9, center: [-122.5, 47.25], bearing: 0, pitch: 0 }), "9/47.25/-122.5");
  assert.equal(
    formatHash({ zoom: 2.5, center: [53.071, 39.262], bearing: -24.12, pitch: 60 }),
    "2.5/39.26/53.07/-24.1/60",
  );
  assert.equal(formatHash({ zoom: 3, center: [1, 2], bearing: 15, pitch: 0 }), "3/2/1/15");
});

test("the number of decimals grows with zoom so a step stays under a pixel", () => {
  const coarse = formatHash({ zoom: 2, center: [10.123456, 20.123456], bearing: 0, pitch: 0 });
  const fine = formatHash({ zoom: 18, center: [10.123456, 20.123456], bearing: 0, pitch: 0 });
  assert.ok(coarse.split("/")[1]!.length < fine.split("/")[1]!.length);
  const [, lat, lng] = fine.split("/").map(Number);
  const pixel = 360 / (512 * 2 ** 18);
  assert.ok(Math.abs(lat! - 20.123456) < pixel && Math.abs(lng! - 10.123456) < pixel);
});

test("hashes are read back and bad ones ignored", () => {
  assert.deepEqual(parseHash("2.59/39.26/53.07/-24.1/60"), {
    zoom: 2.59,
    center: [53.07, 39.26],
    bearing: -24.1,
    pitch: 60,
  });
  assert.deepEqual(parseHash("4/1/2"), { zoom: 4, center: [2, 1], bearing: 0, pitch: 0 });
  assert.equal(parseHash("4/1"), null);
  assert.equal(parseHash("4/95/2"), null);
  assert.equal(parseHash("a/b/c"), null);
});

test("a named hash sits among other parameters", () => {
  assert.equal(readHash("#map=4/1/2&foo=bar", "map"), "4/1/2");
  assert.equal(readHash("#foo=bar", "map"), null);
  assert.equal(readHash("#4/1/2", null), "4/1/2");
  assert.equal(readHash("#foo=bar", null), null);
  assert.equal(writeHash("#map=4/1/2&foo=bar", "map", "5/3/4"), "#map=5/3/4&foo=bar");
  assert.equal(writeHash("#foo=bar", "map", "5/3/4"), "#map=5/3/4&foo=bar");
  assert.equal(writeHash("#anything", null, "5/3/4"), "#5/3/4");
});
