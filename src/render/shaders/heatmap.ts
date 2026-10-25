import { clipChunk, paintChunk } from "./vector.ts";

export const heatmapShader = {
  name: "heatmap",
  vertex: `
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_corner;
layout(location = 4) in uint a_feature;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_radius;
uniform int u_radius_slot;
uniform int u_radius_comp;
uniform float u_weight;
uniform int u_weight_slot;
uniform int u_weight_comp;
uniform float u_intensity;
uniform float u_scale;
${paintChunk}
out vec2 v_offset;
out float v_weight;
flat out vec2 v_pos;
void main() {
  float radius = max(paintValue(a_feature, u_radius_slot, u_radius_comp, vec4(u_radius)).x, 0.0);
  float weight = max(paintValue(a_feature, u_weight_slot, u_weight_comp, vec4(u_weight)).x, 0.0);
  v_offset = a_corner.xy;
  v_weight = weight * u_intensity * u_scale;
  v_pos = a_pos;
  vec4 center = u_matrix * vec4(a_pos, 0.0, 1.0);
  gl_Position = center + vec4(a_corner.xy * radius * 2.0 / u_viewport * center.w, 0.0, 0.0);
}
`,
  fragment: `
${clipChunk}
in vec2 v_offset;
in float v_weight;
flat in vec2 v_pos;
out vec4 fragColor;
void main() {
  if (v_pos.x < u_clip.x || v_pos.y < u_clip.y || v_pos.x >= u_clip.z || v_pos.y >= u_clip.w) discard;
  float d2 = dot(v_offset, v_offset);
  if (d2 > 1.0) discard;
  float density = v_weight * 0.3989422804 * exp(-4.5 * d2);
  fragColor = vec4(density, 0.0, 0.0, 1.0);
}
`,
};

export const heatmapColorShader = {
  name: "heatmap-color",
  vertex: `
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`,
  fragment: `
uniform sampler2D u_density;
uniform sampler2D u_ramp;
uniform float u_opacity;
uniform float u_unscale;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  float density = texture(u_density, v_uv).r * u_unscale;
  if (density <= 0.0) discard;
  vec4 color = texture(u_ramp, vec2(clamp(density, 0.0, 1.0), 0.5));
  fragColor = color * u_opacity;
}
`,
};
