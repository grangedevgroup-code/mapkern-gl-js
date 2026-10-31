import { GRID } from "../../terrain/mesh.ts";
import { globeChunk } from "./globe.ts";

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
#ifdef GLOBE
uniform vec3 u_tile;
${globeChunk}
#endif
layout(location = 0) in vec4 a_pos;
out vec2 v_uv;
#ifdef GLOBE
uniform vec3 u_tile_world;
out float v_pole;
out highp vec2 v_world;
out highp vec3 v_local;
#endif
void main() {
  vec2 uv = a_pos.xy / ${GRID.toFixed(1)};
  v_uv = uv;
#ifdef GLOBE
  v_pole = a_pos.w;
  v_world = u_tile_world.xy + uv * u_tile_world.z;
  float meters = u_has_dem > 0.5 ? demElevation(u_dem_rect.xy + uv * u_dem_rect.zw) * u_exaggeration : 0.0;
  meters -= a_pos.z * u_skirt;
  float pole = a_pos.w > 0.5 ? (uv.y < 0.5 ? 1.0 : -1.0) : 0.0;
  v_local = surfacePoint(u_tile.xy + uv * u_tile.z, meters, pole);
  gl_Position = u_matrix * vec4(v_local, 1.0);
#else
  float z = groundPixels(uv) - a_pos.z * u_skirt;
  gl_Position = u_matrix * vec4(uv, z, 1.0);
#endif
}
`,
  fragment: `
uniform sampler2D u_drape;
uniform vec4 u_drape_rect;
uniform vec3 u_sun_light;
uniform float u_sun_gain;
uniform sampler2D u_gradient;
uniform vec2 u_gradient_texel;
uniform float u_gradient_scale;
#ifdef GLOBE
uniform vec4 u_base;
uniform float u_cap;
uniform float u_drape_size;
uniform sampler2D u_pole;
uniform vec4 u_night_sun;
uniform vec4 u_night;
uniform vec4 u_atmo;
uniform float u_atmo_radius;
in float v_pole;
in highp vec2 v_world;
in highp vec3 v_local;
vec3 nightLight(float altitude) {
  float golden = (1.0 - smoothstep(-0.0145, 0.0873, altitude)) * smoothstep(-0.0698, -0.0145, altitude);
  float night = 1.0 - smoothstep(-u_night.a, -0.0145, altitude);
  vec3 day = mix(vec3(1.0), vec3(1.0, 0.85, 0.68), golden * 0.35);
  return mix(day, u_night.rgb, night);
}
#endif
${demChunk}
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 uv = u_drape_rect.xy + v_uv * u_drape_rect.zw;
  vec2 st = vec2(uv.x, 1.0 - uv.y);
#ifdef GLOBE
  vec4 color;
  if (u_cap > 0.5) {
    float coarse = max(log2(u_drape_size) - 3.0, 0.0);
    vec4 edge = textureLod(u_drape, st, coarse * smoothstep(0.0, 0.12, v_pole));
    vec4 pole = texture(u_pole, vec2(st.y > 0.5 ? 0.25 : 0.75, 0.5));
    color = mix(edge, pole, smoothstep(0.08, 0.7, v_pole));
  } else {
    color = texture(u_drape, st);
  }
  color += u_base * (1.0 - color.a);
  float daylit = 1.0;
  if (u_night_sun.w > 0.5) {
    float lat = atan(sinh(3.14159265 * (1.0 - 2.0 * clamp(v_world.y, 0.0, 1.0))));
    if (u_cap > 0.5) lat = mix(lat, v_world.y < 0.5 ? 1.5707963 : -1.5707963, v_pole);
    float lng = fract(v_world.x) * 6.28318531 - 3.14159265;
    float s = sin(lat) * u_night_sun.x + cos(lat) * u_night_sun.y * cos(lng - u_night_sun.z);
    color.rgb *= nightLight(asin(clamp(s, -1.0, 1.0)));
    daylit = smoothstep(-0.12, 0.25, s);
  }
  if (u_atmo.w > 0.0) {
    vec3 normal = normalize(v_local + vec3(0.0, 0.0, u_atmo_radius));
    float facing = clamp(dot(normal, normalize(u_atmo.xyz - v_local)), 0.0, 1.0);
    float haze = (pow(1.0 - facing, 2.6) * 0.8 + 0.04) * u_atmo.w;
    color.rgb = mix(color.rgb, vec3(0.56, 0.74, 1.0) * daylit * color.a, haze);
  }
#else
  vec4 color = texture(u_drape, st);
#endif
  if (u_sun_gain > 0.0 && u_has_dem > 0.5) {
    vec2 dem = u_dem_rect.xy + v_uv * u_dem_rect.zw;
    vec2 g = texture(u_gradient, dem * u_gradient_texel.x + u_gradient_texel.y).rg;
    float y = mix(u_rows.x, u_rows.y, v_uv.y);
    float k = cosh(3.14159265 * (1.0 - 2.0 * y));
    vec3 n = normalize(vec3(-g * (u_gradient_scale * k * u_exaggeration), 1.0));
    float d = dot(n, u_sun_light) - u_sun_light.z;
    color.rgb *= clamp(1.0 + d * u_sun_gain, 0.45, 1.3);
  }
  fragColor = color;
}
`,
};

export const globeSurfaceShader = { ...terrainShader, defines: ["GLOBE"] };
