export const globeChunk = `
uniform vec4 u_globe;
uniform vec3 u_globe_center;
vec3 surfacePoint(vec2 rel, float meters, float pole) {
  float y = u_globe_center.x + rel.y;
  float m = 3.14159265 * (1.0 - 2.0 * y);
  float coshM = cosh(m);
  vec3 flatPoint = vec3(rel * u_globe.z, meters * u_globe.z * coshM / 40075016.686);
  float sinLat = tanh(m);
  float cosLat = 1.0 / coshM;
  if (pole != 0.0) {
    sinLat = pole;
    cosLat = 0.0;
  }
  float lng = 6.28318531 * (rel.x - floor(rel.x + 0.5));
  float cosLng = cos(lng);
  float east = cosLat * sin(lng);
  float north = sinLat * u_globe_center.z - cosLat * u_globe_center.y * cosLng;
  float up = sinLat * u_globe_center.y + cosLat * u_globe_center.z * cosLng;
  float r = u_globe.y + meters * u_globe.z * u_globe.w / 40075016.686;
  vec3 sphere = vec3(r * east, -r * north, r * up - u_globe.y);
  return mix(flatPoint, sphere, u_globe.x);
}
`;

export const poleShader = {
  name: "pole",
  vertex: `
uniform float u_target;
void main() {
  gl_Position = vec4(u_target, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`,
  fragment: `
uniform sampler2D u_drape;
uniform vec4 u_drape_rect;
uniform float u_row;
uniform float u_lod;
uniform float u_weight;
out vec4 fragColor;
void main() {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    vec2 uv = u_drape_rect.xy + vec2((float(i) + 0.5) / 8.0, u_row) * u_drape_rect.zw;
    sum += textureLod(u_drape, vec2(uv.x, 1.0 - uv.y), u_lod);
  }
  fragColor = sum * (u_weight / 8.0);
}
`,
};

export const atmosphereShader = {
  name: "atmosphere",
  vertex: `
layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos * 2.0 - 1.0;
  gl_Position = vec4(v_ndc, 0.0, 1.0);
}
`,
  fragment: `
uniform mat4 u_inverse;
uniform vec3 u_camera;
uniform float u_radius;
uniform vec4 u_space;
uniform vec4 u_sky;
uniform float u_daylight;
uniform vec4 u_sun;
in vec2 v_ndc;
out vec4 fragColor;
void main() {
  vec4 far = u_inverse * vec4(v_ndc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - u_camera);
  vec3 oc = u_camera + vec3(0.0, 0.0, u_radius);
  float b = dot(oc, dir);
  vec3 closest = oc - dir * min(b, 0.0);
  float r = length(closest);
  float scale = 0.011 * u_radius;
  float height = max(r - u_radius, 0.0);
  float depth = b < 0.0 ? exp(-height / scale) * sqrt(r / scale) * 0.09 : 0.0;
  float lit = 1.0;
  vec3 tint = vec3(1.0);
  if (u_sun.w > 0.5) {
    float facing = dot(closest / r, u_sun.xyz);
    lit = smoothstep(-0.32, 0.12, facing);
    tint = mix(vec3(1.0, 0.62, 0.38), vec3(1.0), smoothstep(-0.12, 0.3, facing));
  }
  vec3 scatter = (1.0 - exp(-depth * vec3(0.38, 0.62, 1.0) * 2.4)) * vec3(0.62, 0.8, 1.0) * tint * lit;
  float up = clamp(dir.z * 0.5 + 0.5, 0.0, 1.0);
  vec4 space = mix(u_space, u_sky, u_daylight * smoothstep(0.35, 0.75, up));
  fragColor = vec4(min(space.rgb + scatter * (1.0 - 0.6 * u_daylight), vec3(1.0)), 1.0);
}
`,
};
