import assert from "node:assert/strict";
import { test } from "node:test";
import { skyLook } from "../../src/render/sky.ts";
import { validateSky, validateStyle } from "../../src/style/validate.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("a sky with colors, blends and zoom expressions is valid", () => {
  assert.deepEqual(
    validateSky({
      color: "#88c6fc",
      horizonColor: "white",
      fogColor: ["interpolate", ["linear"], ["zoom"], 4, "#fff", 10, "#ddd"],
      fogBlend: 0.5,
      horizonFogBlend: 0.8,
      horizonBlend: ["step", ["zoom"], 0.4, 6, 0.8],
    }),
    [],
  );
  assert.deepEqual(validateStyle({ version: 1, sources: {}, layers: [], sky: { color: "#000" } }), []);
});

test("sky mistakes are named", () => {
  const messages = validateSky({ colour: "#fff", fogBlend: 2, color: "not a color" }).map((i) => i.path);
  assert.deepEqual(messages.sort(), ["sky.color", "sky.colour", "sky.fogBlend"]);
  assert.equal(validateSky("blue")[0]?.message, "sky must be an object");
});

test("without a sky, light maps get a pale sky and dark maps a night sky", () => {
  const light = skyLook(null, 3, [0.97, 0.96, 0.94, 1]);
  const dark = skyLook(null, 3, [0.05, 0.05, 0.06, 1]);
  const brightness = (c: readonly number[]) => (c[0]! + c[1]! + c[2]!) / 3;
  assert.ok(brightness(light.haze) > 0.9, `light haze ${light.haze}`);
  assert.ok(brightness(dark.haze) < 0.25, `dark haze ${dark.haze}`);
  assert.ok(light.sky[2]! > light.sky[0]!, "the light sky is blue");
});

test("sky values follow the zoom", () => {
  const spec = {
    horizonColor: "#ffffff",
    fogColor: "#000000",
    horizonFogBlend: ["interpolate", ["linear"], ["zoom"], 0, 0, 10, 1],
  };
  close(skyLook(spec as never, 0, [1, 1, 1, 1]).haze[0]!, 1);
  close(skyLook(spec as never, 5, [1, 1, 1, 1]).haze[0]!, 0.5);
  close(skyLook(spec as never, 10, [1, 1, 1, 1]).haze[0]!, 0);
});
