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
uniform float u_gain;
uniform vec4 u_shadow;
uniform vec4 u_highlight;
uniform vec4 u_accent;
uniform float u_opacity;
uniform int u_method;
uniform float u_derive;
uniform float u_azimuth;
uniform float u_intensity;
in vec2 v_uv;
out vec4 fragColor;
const float PI = 3.14159265;
void main() {
  vec2 g = texture(u_gradient, v_uv * u_texel.x + u_texel.y).rg;
  float k = cosh(PI * (1.0 - 2.0 * mix(u_rows.x, u_rows.y, v_uv.y)));
  if (u_method == 1) {
    vec2 deriv = clamp(g * u_derive, -1.0, 1.0);
    float slope = atan(1.25 * length(deriv) * k);
    float aspect = deriv.x != 0.0 ? atan(deriv.y, -deriv.x) : PI / 2.0 * (deriv.y > 0.0 ? 1.0 : -1.0);
    float base = 1.875 - u_intensity * 1.75;
    float steep = u_intensity != 0.5 ? (pow(base, slope) - 1.0) / (pow(base, PI / 2.0) - 1.0) * (PI / 2.0) : slope;
    float strength = clamp(u_intensity * 2.0, 0.0, 1.0);
    float side = abs(mod((aspect + u_azimuth + PI) / PI + 0.5, 2.0) - 1.0);
    vec4 lit = mix(u_shadow, u_highlight, side) * sin(steep) * strength;
    vec4 edge = (1.0 - cos(steep)) * u_accent * strength;
    fragColor = (edge * (1.0 - lit.a) + lit) * (texture(u_mask, v_uv).r * u_opacity);
    return;
  }
  vec3 n = normalize(vec3(-g * (u_scale * k), 1.0));
  float d = dot(n, u_light) - u_flat;
  vec4 shade = d < 0.0 ? u_shadow * min(1.0, -d * u_gain) : u_highlight * min(1.0, d * u_gain);
  vec4 accent = u_accent * min(1.0, (1.0 - n.z) * u_gain);
  vec4 color = shade + accent * (1.0 - shade.a);
  fragColor = color * (texture(u_mask, v_uv).r * u_opacity);
}
`,
};
