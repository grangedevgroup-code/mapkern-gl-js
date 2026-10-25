import { GRID } from "../../terrain/mesh.ts";

export const demChunk = `
uniform highp sampler2D u_dem;
uniform vec4 u_dem_rect;
uniform float u_dem_size;
uniform float u_has_dem;
uniform vec2 u_rows;
uniform float u_world;
uniform float u_exaggeration;
float demElevation(vec2 uv) {
  vec2 p = uv * u_dem_size + 1.5;
  vec2 f = floor(p);
  vec2 t = p - f;
  ivec2 i = ivec2(f);
  float a = texelFetch(u_dem, i, 0).r;
  float b = texelFetch(u_dem, i + ivec2(1, 0), 0).r;
  float c = texelFetch(u_dem, i + ivec2(0, 1), 0).r;
  float d = texelFetch(u_dem, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
float groundPixels(vec2 uv) {
  if (u_has_dem < 0.5) return 0.0;
  float y = mix(u_rows.x, u_rows.y, uv.y);
  float pixelsPerMeter = u_world * cosh(3.14159265 * (1.0 - 2.0 * y)) / 40075016.686;
  return demElevation(u_dem_rect.xy + uv * u_dem_rect.zw) * u_exaggeration * pixelsPerMeter;
}
`;

export const terrainShader = {
  name: "terrain",
  vertex: `
uniform mat4 u_matrix;
uniform float u_skirt;
${demChunk}
layout(location = 0) in vec4 a_pos;
out vec2 v_uv;
void main() {
  vec2 uv = a_pos.xy / ${GRID.toFixed(1)};
  float z = groundPixels(uv) - a_pos.z * u_skirt;
  v_uv = uv;
  gl_Position = u_matrix * vec4(uv, z, 1.0);
}
`,
  fragment: `
uniform sampler2D u_drape;
uniform vec4 u_drape_rect;
uniform vec3 u_sun_light;
uniform float u_sun_gain;
uniform float u_dem_meters;
${demChunk}
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 uv = u_drape_rect.xy + v_uv * u_drape_rect.zw;
  vec4 color = texture(u_drape, vec2(uv.x, 1.0 - uv.y));
  if (u_sun_gain > 0.0 && u_has_dem > 0.5) {
    vec2 dem = u_dem_rect.xy + v_uv * u_dem_rect.zw;
    float step = 1.0 / u_dem_size;
    float hx = demElevation(dem + vec2(step, 0.0)) - demElevation(dem - vec2(step, 0.0));
    float hy = demElevation(dem + vec2(0.0, step)) - demElevation(dem - vec2(0.0, step));
    float y = mix(u_rows.x, u_rows.y, v_uv.y);
    float meters = 2.0 * u_dem_meters / cosh(3.14159265 * (1.0 - 2.0 * y));
    vec3 n = normalize(vec3(-hx * u_exaggeration, -hy * u_exaggeration, meters));
    float d = dot(n, u_sun_light) - u_sun_light.z;
    color.rgb *= clamp(1.0 + d * u_sun_gain, 0.45, 1.3);
  }
  fragColor = color;
}
`,
};
