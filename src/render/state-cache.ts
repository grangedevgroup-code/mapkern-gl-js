type Values = number[];

export interface StateCache {
  forget(): void;
}

const SCALAR_UNIFORMS = [
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
] as const;

const VECTOR_UNIFORMS = [
  "uniform1fv",
  "uniform2fv",
  "uniform3fv",
  "uniform4fv",
  "uniform1iv",
  "uniform2iv",
  "uniform3iv",
  "uniform4iv",
] as const;

const MATRIX_UNIFORMS = ["uniformMatrix2fv", "uniformMatrix3fv", "uniformMatrix4fv"] as const;

type Writable = Record<string, (...args: never[]) => unknown>;

function sameValues(a: Values, b: ArrayLike<number>, offset: number): boolean {
  if (a.length !== b.length + offset) return false;
  for (let i = 0; i < b.length; i++) if (a[i + offset] !== b[i]) return false;
  return true;
}

export function installStateCache(gl: WebGL2RenderingContext): StateCache {
  const target = gl as unknown as Writable;
  let uniforms = new WeakMap<WebGLUniformLocation, Values>();
  let unit = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  let unitKnown = true;
  const textures = new Map<number, WebGLTexture | null>();
  let vao: WebGLVertexArrayObject | null = null;
  let vaoKnown = false;

  const remember = (location: WebGLUniformLocation, values: Values): boolean => {
    const previous = uniforms.get(location);
    if (previous && sameValues(previous, values, 0)) return false;
    uniforms.set(location, values);
    return true;
  };

  for (const name of SCALAR_UNIFORMS) {
    const raw = gl[name].bind(gl) as (location: WebGLUniformLocation | null, ...values: number[]) => void;
    target[name] = ((location: WebGLUniformLocation | null, ...values: number[]) => {
      if (location === null) return;
      if (remember(location, values)) raw(location, ...values);
    }) as never;
  }

  for (const name of VECTOR_UNIFORMS) {
    const raw = gl[name].bind(gl) as (
      location: WebGLUniformLocation | null,
      data: ArrayLike<number>,
      ...rest: number[]
    ) => void;
    target[name] = ((location: WebGLUniformLocation | null, data: ArrayLike<number>, ...rest: number[]) => {
      if (location === null) return;
      if (rest.length > 0) {
        uniforms.delete(location);
        raw(location, data, ...rest);
        return;
      }
      if (remember(location, Array.from(data))) raw(location, data);
    }) as never;
  }

  for (const name of MATRIX_UNIFORMS) {
    const raw = gl[name].bind(gl) as (
      location: WebGLUniformLocation | null,
      transpose: boolean,
      data: ArrayLike<number>,
      ...rest: number[]
    ) => void;
    target[name] = ((
      location: WebGLUniformLocation | null,
      transpose: boolean,
      data: ArrayLike<number>,
      ...rest: number[]
    ) => {
      if (location === null) return;
      if (rest.length > 0) {
        uniforms.delete(location);
        raw(location, transpose, data, ...rest);
        return;
      }
      const previous = uniforms.get(location);
      const flag = transpose ? 1 : 0;
      if (previous && previous[0] === flag && sameValues(previous, data, 1)) return;
      const values = [flag];
      for (let i = 0; i < data.length; i++) values.push(data[i]!);
      uniforms.set(location, values);
      raw(location, transpose, data);
    }) as never;
  }

  const rawActive = gl.activeTexture.bind(gl);
  target.activeTexture = ((texture: number) => {
    if (unitKnown && texture === unit) return;
    unit = texture;
    unitKnown = true;
    rawActive(texture);
  }) as never;

  const rawBindTexture = gl.bindTexture.bind(gl);
  target.bindTexture = ((kind: number, texture: WebGLTexture | null) => {
    if (!unitKnown) {
      rawBindTexture(kind, texture);
      return;
    }
    const key = (unit - gl.TEXTURE0) * 0x10000 + kind;
    if (textures.has(key) && textures.get(key) === texture) return;
    textures.set(key, texture);
    rawBindTexture(kind, texture);
  }) as never;

  const rawDeleteTexture = gl.deleteTexture.bind(gl);
  target.deleteTexture = ((texture: WebGLTexture | null) => {
    if (texture) for (const [key, bound] of textures) if (bound === texture) textures.delete(key);
    rawDeleteTexture(texture);
  }) as never;

  const rawBindVao = gl.bindVertexArray.bind(gl);
  target.bindVertexArray = ((array: WebGLVertexArrayObject | null) => {
    if (vaoKnown && array === vao) return;
    vao = array;
    vaoKnown = true;
    rawBindVao(array);
  }) as never;

  const rawDeleteVao = gl.deleteVertexArray.bind(gl);
  target.deleteVertexArray = ((array: WebGLVertexArrayObject | null) => {
    if (array && array === vao) vaoKnown = false;
    rawDeleteVao(array);
  }) as never;

  const rawDeleteProgram = gl.deleteProgram.bind(gl);
  target.deleteProgram = ((program: WebGLProgram | null) => {
    uniforms = new WeakMap();
    rawDeleteProgram(program);
  }) as never;

  const rawLinkProgram = gl.linkProgram.bind(gl);
  target.linkProgram = ((program: WebGLProgram) => {
    uniforms = new WeakMap();
    rawLinkProgram(program);
  }) as never;

  return {
    forget() {
      uniforms = new WeakMap();
      unitKnown = false;
      textures.clear();
      vaoKnown = false;
    },
  };
}
