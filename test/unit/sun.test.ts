import assert from "node:assert/strict";
import { test } from "node:test";
import { sunAltitude, sunAzimuth, sunPosition } from "../../src/geo/sun.ts";

const near = (actual: number, expected: number, within: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);

test("the sun stands over the tropics at the solstices and over the equator at the equinoxes", () => {
  near(sunPosition(Date.UTC(2026, 5, 21, 8, 24)).declination, 23.44, 0.02, "June solstice");
  near(sunPosition(Date.UTC(2026, 11, 21, 20, 50)).declination, -23.44, 0.02, "December solstice");
  near(sunPosition(Date.UTC(2026, 2, 20, 14, 46)).declination, 0, 0.02, "March equinox");
  near(sunPosition(Date.UTC(2026, 8, 23, 0, 5)).declination, 0, 0.02, "September equinox");
});

test("at noon UTC the sun is overhead near Greenwich, shifted by the equation of time", () => {
  near(sunPosition(Date.UTC(2026, 3, 15, 12)).subsolarLng, 0, 0.3, "mid April, when clocks and the sun agree");
  near(
    sunPosition(Date.UTC(2026, 10, 3, 12)).subsolarLng,
    -4.1,
    0.3,
    "early November, the sun runs 16 minutes early and is past Greenwich",
  );
  near(
    sunPosition(Date.UTC(2026, 1, 11, 12)).subsolarLng,
    3.5,
    0.3,
    "mid February, the sun runs 14 minutes late and has not reached Greenwich",
  );
  near(sunPosition(Date.UTC(2026, 3, 15, 18)).subsolarLng, -90, 0.3, "six hours later it is a quarter turn west");
});

test("sunrise and sunset happen where the sun is just under the horizon", () => {
  const sunrise = sunPosition(Date.UTC(2026, 5, 21, 12, 11));
  near(sunAltitude(sunrise, -122.33, 47.61), -0.83, 0.6, "Seattle sunrise on the June solstice");
  const sunset = sunPosition(Date.UTC(2026, 11, 21, 15, 54));
  near(sunAltitude(sunset, -0.13, 51.51), -0.83, 0.6, "London sunset on the December solstice");
  near(
    sunAltitude(sunPosition(Date.UTC(2026, 2, 20, 12)), 0, 0),
    88.1,
    0.3,
    "the equator at noon UTC on the March equinox, the sun 7 minutes late",
  );
});

test("the sun is in the east in the morning, south at noon and west in the evening north of the tropics", () => {
  const day = (hour: number) => sunPosition(Date.UTC(2026, 5, 21, hour));
  near(sunAzimuth(day(8), 13.4, 52.52), 100, 25, "Berlin morning");
  near(sunAzimuth(day(11), 13.4, 52.52), 180, 15, "Berlin noon");
  near(sunAzimuth(day(16), 13.4, 52.52), 260, 25, "Berlin evening");
  assert.ok(sunAltitude(day(11), 13.4, 52.52) > 55, "Berlin's midsummer sun stands high");
  assert.ok(sunAltitude(day(23), 13.4, 52.52) < -10, "and is well under the horizon at night");
});

test("daylight leaves the map alone, night tints it and twilight blends between", async () => {
  const { lightAt } = await import("../../src/render/night.ts");
  const look = { sun: sunPosition(0), night: [0.2, 0.25, 0.4] as const, twilight: 12, light: null };
  assert.deepEqual(lightAt(look, 30), [1, 1, 1]);
  const full = lightAt(look, -20);
  for (let i = 0; i < 3; i++) near(full[i]!, look.night[i]!, 1e-9, "full night");
  const dusk = lightAt(look, -6);
  assert.ok(dusk[0] < 1 && dusk[0] > 0.2, `dusk ${dusk}`);
  const sunset = lightAt(look, -0.83);
  assert.ok(sunset[2] < sunset[0], `the sun going down warms the light a little: ${sunset}`);
  let last = 1;
  for (let altitude = 10; altitude >= -14; altitude -= 0.5) {
    const v = lightAt(look, altitude)[1];
    assert.ok(v <= last + 1e-9, `light only falls as the sun sinks, at ${altitude}`);
    last = v;
  }
});

test("sun settings are checked", async () => {
  const { validateSun, sunTime } = await import("../../src/style/validate.ts");
  assert.deepEqual(validateSun({ time: "2026-06-21T20:00:00Z", night: "#1c2541", twilight: 6, shade: false }), []);
  assert.deepEqual(validateSun({ time: "now" }), []);
  assert.deepEqual(validateSun({ time: 1782072000000 }), []);
  const paths = validateSun({ time: "yesterday", night: "dark", twilight: 40, shade: "yes", glow: 1 }).map(
    (i) => i.path,
  );
  assert.deepEqual(paths.sort(), ["sun.glow", "sun.night", "sun.shade", "sun.time", "sun.twilight"]);
  assert.equal(sunTime("2026-06-21T20:00:00Z"), Date.UTC(2026, 5, 21, 20));
});
