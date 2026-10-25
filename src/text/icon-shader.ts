export const ICON_SDF_RADIUS = 8;

export const iconShader = {
  name: "icon",
  vertex: `
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_halo;
layout(location = 4) in vec4 a_params;
uniform vec2 u_viewport;
uniform vec2 u_atlas_size;
out vec2 v_uv;
out vec4 v_color;
out vec4 v_halo;
out vec4 v_params;
void main() {
  v_uv = a_uv * 0.25 / u_atlas_size;
  v_color = a_color;
  v_halo = a_halo;
  v_params = a_params;
  gl_Position = vec4(a_pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - a_pos.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`,
  fragment: `
uniform sampler2D u_atlas;
uniform int u_pass;
uniform float u_pixel_ratio;
uniform float u_radius;
in vec2 v_uv;
in vec4 v_color;
in vec4 v_halo;
in vec4 v_params;
out vec4 fragColor;
void main() {
  vec4 texel = texture(u_atlas, v_uv);
  float opacity = v_params.x;
  if (v_params.w < 0.5) {
    if (u_pass == 0) discard;
    fragColor = texel * opacity;
    return;
  }
  float d = texel.a;
  float scale = max(v_params.y, 0.05);
  float gamma = 0.8 / (u_radius * scale * u_pixel_ratio);
  float edge = 0.75;
  if (u_pass == 0) {
    float halo = v_params.z;
    if (halo <= 0.0 || v_halo.a <= 0.0) discard;
    float haloEdge = max(0.05, edge - halo / (u_radius * scale));
    float a = smoothstep(haloEdge - gamma, haloEdge + gamma, d);
    if (a <= 0.0) discard;
    fragColor = v_halo * a * opacity;
  } else {
    float a = smoothstep(edge - gamma, edge + gamma, d);
    if (a <= 0.0) discard;
    fragColor = v_color * a * opacity;
  }
}
`,
};
