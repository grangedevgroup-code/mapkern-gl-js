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
uniform vec4 u_glow;
uniform vec4 u_sky;
uniform float u_daylight;
in vec2 v_ndc;
out vec4 fragColor;
void main() {
  vec4 far = u_inverse * vec4(v_ndc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - u_camera);
  vec3 oc = u_camera + vec3(0.0, 0.0, u_radius);
  float b = dot(oc, dir);
  float closest = sqrt(max(dot(oc, oc) - b * b, 0.0));
  float above = max(closest - u_radius, 0.0) / u_radius;
  float glow = b < 0.0 ? exp(-above * 9.0) : 0.0;
  float up = clamp(dir.z * 0.5 + 0.5, 0.0, 1.0);
  vec4 space = mix(u_space, u_sky, u_daylight * smoothstep(0.35, 0.75, up));
  fragColor = mix(space, u_glow, clamp(glow, 0.0, 1.0));
}
`,
};
