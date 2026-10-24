export const hillshadeShader = {
  name: "hillshade",
  vertex: `
uniform mat4 u_matrix;
uniform vec4 u_clip;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  vec2 p = mix(u_clip.xy, u_clip.zw, a_pos);
  v_uv = p;
  gl_Position = u_matrix * vec4(p, 0.0, 1.0);
}
`,
  fragment: `
uniform sampler2D u_gradient;
uniform sampler2D u_mask;
uniform vec2 u_texel;
uniform vec2 u_rows;
uniform float u_scale;
uniform vec3 u_light;
uniform float u_flat;
uniform vec4 u_shadow;
uniform vec4 u_highlight;
uniform vec4 u_accent;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 g = texture(u_gradient, v_uv * u_texel.x + u_texel.y).rg;
  float k = cosh(3.14159265 * (1.0 - 2.0 * mix(u_rows.x, u_rows.y, v_uv.y)));
  vec3 n = normalize(vec3(-g * (u_scale * k), 1.0));
  float d = dot(n, u_light) - u_flat;
  vec4 shade = d < 0.0 ? u_shadow * min(1.0, -d / u_flat) : u_highlight * min(1.0, d / u_flat);
  vec4 accent = u_accent * (1.0 - n.z);
  vec4 color = shade + accent * (1.0 - shade.a);
  fragColor = color * (texture(u_mask, v_uv).r * u_opacity);
}
`,
};
