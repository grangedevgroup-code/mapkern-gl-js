import assert from "node:assert/strict";
import { test } from "node:test";
import { installStateCache } from "../../src/render/state-cache.ts";

function fakeGL() {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(
        `${name}(${args.map((a) => (a && typeof a === "object" && "length" in a ? `[${Array.from(a as ArrayLike<number>)}]` : String(a))).join(",")})`,
      );
    };
  const gl: Record<string, unknown> = {
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    ACTIVE_TEXTURE: 0x84e0,
    getParameter: () => 0x84c0,
  };
  for (const name of [
    "uniform1f",
    "uniform2f",
    "uniform3f",
    "uniform4f",
    "uniform1i",
    "uniform2i",
    "uniform3i",
    "uniform4i",
    "uniform1ui",
    "uniform2ui",
    "uniform3ui",
    "uniform4ui",
    "uniform1fv",
    "uniform2fv",
    "uniform3fv",
    "uniform4fv",
    "uniform1iv",
    "uniform2iv",
    "uniform3iv",
    "uniform4iv",
    "uniformMatrix2fv",
    "uniformMatrix3fv",
    "uniformMatrix4fv",
    "activeTexture",
    "bindTexture",
    "deleteTexture",
    "bindVertexArray",
    "deleteVertexArray",
    "deleteProgram",
    "linkProgram",
  ]) {
    gl[name] = record(name);
  }
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

test("a uniform set to the value it already holds is not sent again", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const a = {} as WebGLUniformLocation;
  gl.uniform1i(a, 1);
  gl.uniform1i(a, 1);
  gl.uniform1i(a, 2);
  gl.uniform1i(a, 1);
  assert.deepEqual(calls, [
    "uniform1i([object Object],1)",
    "uniform1i([object Object],2)",
    "uniform1i([object Object],1)",
  ]);
});

test("each location keeps its own value", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const a = {} as WebGLUniformLocation;
  const b = {} as WebGLUniformLocation;
  gl.uniform4f(a, 1, 2, 3, 4);
  gl.uniform4f(b, 1, 2, 3, 4);
  gl.uniform4f(a, 1, 2, 3, 4);
  assert.equal(calls.length, 2);
});

test("a matrix is compared by value, not by the array it came in", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const a = {} as WebGLUniformLocation;
  const m = new Float32Array(16).fill(1);
  gl.uniformMatrix4fv(a, false, m);
  gl.uniformMatrix4fv(a, false, new Float32Array(16).fill(1));
  m[5] = 2;
  gl.uniformMatrix4fv(a, false, m);
  gl.uniformMatrix4fv(a, true, m);
  assert.equal(calls.length, 3);
});

test("a null location never reaches the context", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  gl.uniform1f(null, 3);
  assert.equal(calls.length, 0);
});

test("texture binds are skipped only on the unit that already holds the texture", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const t = {} as WebGLTexture;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.activeTexture(gl.TEXTURE0 + 1);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.activeTexture(gl.TEXTURE0 + 1);
  assert.deepEqual(
    calls.map((c) => c.split("(")[0]),
    ["bindTexture", "activeTexture", "bindTexture"],
  );
});

test("deleting a bound texture makes the next bind of that unit go through", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const t = {} as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.deleteTexture(t);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindTexture(gl.TEXTURE_2D, t);
  assert.deepEqual(
    calls.map((c) => c.split("(")[0]),
    ["bindTexture", "deleteTexture", "bindTexture", "bindTexture"],
  );
});

test("vertex arrays are skipped when already bound and rebound after delete", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const v = {} as WebGLVertexArrayObject;
  gl.bindVertexArray(v);
  gl.bindVertexArray(v);
  gl.deleteVertexArray(v);
  gl.bindVertexArray(v);
  assert.deepEqual(
    calls.map((c) => c.split("(")[0]),
    ["bindVertexArray", "deleteVertexArray", "bindVertexArray"],
  );
});

test("forgetting the cache sends every following call", () => {
  const { gl, calls } = fakeGL();
  const cache = installStateCache(gl);
  const a = {} as WebGLUniformLocation;
  const t = {} as WebGLTexture;
  gl.uniform1f(a, 1);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE0);
  cache.forget();
  gl.uniform1f(a, 1);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE0);
  assert.equal(calls.length, 7);
});

test("relinking a program drops cached uniform values", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const a = {} as WebGLUniformLocation;
  gl.uniform1i(a, 3);
  gl.linkProgram({} as WebGLProgram);
  gl.uniform1i(a, 3);
  assert.equal(calls.filter((c) => c.startsWith("uniform1i")).length, 2);
});

test("partial array uploads always go through and invalidate the location", () => {
  const { gl, calls } = fakeGL();
  installStateCache(gl);
  const a = {} as WebGLUniformLocation;
  const data = new Float32Array([1, 2, 3, 4]);
  gl.uniform4fv(a, data);
  gl.uniform4fv(a, data, 0, 4);
  gl.uniform4fv(a, data);
  assert.equal(calls.length, 3);
});
