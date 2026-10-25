import type { Transform } from "../camera/transform.ts";
import { latFromMercatorY, lngFromMercatorX } from "../geo/mercator.ts";
import type { SunPosition } from "../geo/sun.ts";
import { sunAltitude } from "../geo/sun.ts";
import type { GL, Program } from "./gl.ts";

export const nightShader = {
  name: "night",
  vertex: `
layout(location = 0) in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`,
  fragment: `
uniform mat3 u_ground;
uniform vec2 u_ref;
uniform vec3 u_sun;
uniform vec3 u_night;
uniform float u_twilight;
uniform vec3 u_sky;
out vec4 fragColor;
vec3 light(float altitude) {
  float golden = (1.0 - smoothstep(-0.0145, 0.0873, altitude)) * smoothstep(-0.0698, -0.0145, altitude);
  float night = 1.0 - smoothstep(-u_twilight, -0.0145, altitude);
  vec3 day = mix(vec3(1.0), vec3(1.0, 0.85, 0.68), golden * 0.35);
  return mix(day, u_night, night);
}
void main() {
  vec3 g = u_ground * vec3(gl_FragCoord.xy, 1.0);
  if (g.z <= 0.0) {
    fragColor = vec4(u_sky, 1.0);
    return;
  }
  vec2 w = g.xy / g.z + u_ref;
  float lng = fract(w.x) * 6.28318531 - 3.14159265;
  float lat = atan(sinh(3.14159265 * (1.0 - 2.0 * clamp(w.y, 0.0, 1.0))));
  float s = sin(lat) * u_sun.x + cos(lat) * u_sun.y * cos(lng - u_sun.z);
  fragColor = vec4(light(asin(clamp(s, -1.0, 1.0))), 1.0);
}
`,
};

export interface SunLook {
  sun: SunPosition;
  night: readonly [number, number, number];
  twilight: number;
  light: readonly [number, number, number] | null;
}

const GOLDEN = 5;

export function lightAt(look: SunLook, altitude: number): [number, number, number] {
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const golden = (1 - smooth(-0.83, GOLDEN, altitude)) * smooth(-4, -0.83, altitude) * 0.35;
  const night = 1 - smooth(-look.twilight, -0.83, altitude);
  const day = [1, 1 + (0.85 - 1) * golden, 1 + (0.68 - 1) * golden];
  return [0, 1, 2].map((i) => day[i]! + (look.night[i]! - day[i]!) * night) as [number, number, number];
}

export function nightInView(transform: Transform, look: SunLook): boolean {
  const points: [number, number][] = [
    [0, 0],
    [transform.width, 0],
    [transform.width, transform.height],
    [0, transform.height],
    [transform.width / 2, transform.height / 2],
  ];
  for (const [x, y] of points) {
    const hit = transform.unproject(x, y);
    const [wx, wy] = hit ?? transform.centerWorld;
    const lng = lngFromMercatorX(wx - Math.floor(wx));
    const lat = latFromMercatorY(Math.min(1, Math.max(0, wy)));
    if (sunAltitude(look.sun, lng, lat) < GOLDEN) return true;
  }
  return false;
}

export class NightPainter {
  private readonly gl: GL;
  private readonly ground = new Float32Array(9);

  constructor(gl: GL) {
    this.gl = gl;
  }

  draw(transform: Transform, look: SunLook, quad: WebGLVertexArrayObject | null): void {
    const g = this.gl;
    const gl = g.gl;
    const program = g.program(nightShader);
    g.use(program);
    g.setBlend("multiply");
    g.setDepth(false, false);
    const [refX, refY] = transform.centerWorld;
    transform.groundMatrix(refX, refY, gl.drawingBufferWidth, gl.drawingBufferHeight, this.ground);
    const set = (name: string) => uniform(program, name);
    const rad = Math.PI / 180;
    const [cx, cy] = transform.centerWorld;
    const center = lightAt(look, sunAltitude(look.sun, lngFromMercatorX(cx), latFromMercatorY(cy)));
    gl.uniformMatrix3fv(set("u_ground"), false, this.ground);
    gl.uniform2f(set("u_ref"), refX, refY);
    gl.uniform3f(
      set("u_sun"),
      Math.sin(look.sun.declination * rad),
      Math.cos(look.sun.declination * rad),
      look.sun.subsolarLng * rad,
    );
    gl.uniform3f(set("u_night"), look.night[0], look.night[1], look.night[2]);
    gl.uniform1f(set("u_twilight"), look.twilight * rad);
    gl.uniform3f(set("u_sky"), center[0], center[1], center[2]);
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function uniform(program: Program, name: string): WebGLUniformLocation | null {
  return program.uniforms.get(name) ?? null;
}
