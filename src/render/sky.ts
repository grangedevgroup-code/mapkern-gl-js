import type { Transform } from "../camera/transform.ts";
import type { RGBA } from "../style/color.ts";
import { parseColor, premultiply } from "../style/color.ts";
import type { Compiled } from "../style/expression.ts";
import { compile } from "../style/expression.ts";
import type { SkySpec } from "../style/types.ts";
import type { GL, Program } from "./gl.ts";

export const skyShader = {
  name: "sky",
  vertex: `
layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos * 2.0 - 1.0;
  gl_Position = vec4(v_ndc, 0.0, 1.0);
}
`,
  fragment: `
uniform mat3 u_view;
uniform vec4 u_lens;
uniform vec2 u_camera;
uniform float u_height;
uniform float u_center;
uniform vec4 u_sky;
uniform vec4 u_horizon;
uniform vec4 u_haze;
uniform vec3 u_blend;
uniform float u_wraps;
in vec2 v_ndc;
out vec4 fragColor;
void main() {
  vec3 ray = vec3((v_ndc.x + u_lens.z) / u_lens.x, (v_ndc.y + u_lens.w) / u_lens.y, -1.0);
  vec3 dir = normalize(ray * u_view);
  float down = -dir.z;
  if (down <= 0.0) {
    float up = clamp(asin(min(-down, 1.0)) / max(u_blend.z * 0.785398, 0.001), 0.0, 1.0);
    fragColor = mix(u_horizon, u_sky, smoothstep(0.0, 1.0, up));
    return;
  }
  float t = u_height / down;
  vec2 hit = u_camera + dir.xy * t;
  float edge = min(hit.y, 1.0 - hit.y);
  if (u_wraps < 0.5) edge = min(edge, min(hit.x, 1.0 - hit.x));
  vec4 haze = mix(u_horizon, u_haze, smoothstep(0.0, 0.5, down));
  if (edge <= 0.0) {
    fragColor = haze;
    return;
  }
  float toward = 1.0 - asin(min(down, 1.0)) / u_center;
  float fog = u_blend.y * smoothstep(u_blend.x, 1.0, toward);
  float fade = 1.0 - smoothstep(0.0, 0.25 * t * (1.0 - smoothstep(0.1, 0.6, down)), edge);
  float a = max(max(fog, fade), 1.0 - smoothstep(0.0, 0.12, down));
  if (a <= 0.0) discard;
  fragColor = haze * a;
}
`,
};

export interface SkyLook {
  sky: RGBA;
  horizon: RGBA;
  haze: RGBA;
  fogBlend: number;
  horizonBlend: number;
}

const LIGHT = { color: "#a7c9ec", horizonColor: "#dbe9f6", fogColor: "#f4f8fc" };
const DARK = { color: "#0b1220", horizonColor: "#1e2a3a", fogColor: "#2c3848" };
const NAMES = ["color", "horizonColor", "fogColor", "fogBlend", "horizonFogBlend", "horizonBlend"] as const;
const compiled = new WeakMap<SkySpec, Partial<Record<(typeof NAMES)[number], Compiled<unknown>>>>();

export function skyLook(spec: SkySpec | null | undefined, zoom: number, background: RGBA): SkyLook {
  const lightness = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
  const base = background[3] > 0 && lightness < 0.35 * background[3] ? DARK : LIGHT;
  const source: SkySpec = spec ?? base;
  let fns = compiled.get(source);
  if (!fns) {
    fns = {};
    for (const name of NAMES) {
      const value = source[name];
      if (value === undefined) continue;
      const kind = name.endsWith("Color") || name === "color" ? "color" : "number";
      fns[name] = compile(value, kind, null, `sky.${name}`);
    }
    compiled.set(source, fns);
  }
  const ctx = { zoom };
  const color = (name: (typeof NAMES)[number], fallback: string): RGBA => {
    const v = fns[name]?.evaluate(ctx);
    return isColor(v) ? v : (parseColor(fallback) ?? [1, 1, 1, 1]);
  };
  const number = (name: (typeof NAMES)[number], fallback: number): number => {
    const v = fns[name]?.evaluate(ctx);
    return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  };
  const sky = color("color", base.color);
  const horizon = color("horizonColor", base.horizonColor);
  const fog = fns.fogColor ? color("fogColor", base.fogColor) : spec ? horizon : color("fogColor", base.fogColor);
  const mix = number("horizonFogBlend", 0.8);
  const haze: RGBA = [
    horizon[0] + (fog[0] - horizon[0]) * mix,
    horizon[1] + (fog[1] - horizon[1]) * mix,
    horizon[2] + (fog[2] - horizon[2]) * mix,
    horizon[3] + (fog[3] - horizon[3]) * mix,
  ];
  return {
    sky: premultiply(sky, 1),
    horizon: premultiply(horizon, 1),
    haze: premultiply(haze, 1),
    fogBlend: number("fogBlend", 0.5),
    horizonBlend: number("horizonBlend", 0.8),
  };
}

function isColor(v: unknown): v is RGBA {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number");
}

export function skyInView(transform: Transform): boolean {
  const ws = transform.worldSize;
  const camera = transform.cameraPosition;
  const height = (camera[2] - transform.centerElevationPixels) / ws;
  for (const x of [0, transform.width / 2, transform.width]) {
    const { dir } = transform.screenRay(x, 0);
    const length = Math.hypot(dir[0], dir[1], dir[2]);
    const down = -dir[2] / length;
    if (down < 0.12) return true;
    const hit = transform.unproject(x, 0);
    if (!hit) return true;
    const t = height / down;
    const edge = Math.min(hit[1], 1 - hit[1], transform.renderWorldCopies ? Infinity : Math.min(hit[0], 1 - hit[0]));
    const grazing = 1 - Math.min(1, Math.max(0, (down - 0.1) / 0.5));
    if (edge <= 0.25 * t * grazing * grazing * (3 - 2 * grazing)) return true;
  }
  return false;
}

export class SkyPainter {
  private readonly gl: GL;
  private readonly view = new Float32Array(9);

  constructor(gl: GL) {
    this.gl = gl;
  }

  draw(transform: Transform, look: SkyLook, fog: boolean, quad: WebGLVertexArrayObject | null): void {
    const g = this.gl;
    const gl = g.gl;
    const program = g.program(skyShader);
    g.use(program);
    g.setBlend("premultiplied");
    g.setDepth(false, false);
    const ws = transform.worldSize;
    const camera = transform.cameraPosition;
    const v = transform.viewMatrix;
    const m = this.view;
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[col * 3 + row] = v[col * 4 + row]!;
    const p = transform.projMatrix;
    const set = (name: string) => uniform(program, name);
    gl.uniformMatrix3fv(set("u_view"), false, m);
    gl.uniform4f(set("u_lens"), p[0]!, p[5]!, p[8]!, p[9]!);
    gl.uniform2f(set("u_camera"), camera[0] / ws, camera[1] / ws);
    gl.uniform1f(set("u_height"), (camera[2] - transform.centerElevationPixels) / ws);
    gl.uniform1f(set("u_center"), Math.max(1e-3, Math.PI / 2 - (transform.pitch * Math.PI) / 180));
    gl.uniform4f(set("u_sky"), ...look.sky);
    gl.uniform4f(set("u_horizon"), ...look.horizon);
    gl.uniform4f(set("u_haze"), ...look.haze);
    gl.uniform3f(set("u_blend"), look.fogBlend, fog ? 1 : 0, look.horizonBlend);
    gl.uniform1f(set("u_wraps"), transform.renderWorldCopies ? 1 : 0);
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function uniform(program: Program, name: string): WebGLUniformLocation | null {
  return program.uniforms.get(name) ?? null;
}
