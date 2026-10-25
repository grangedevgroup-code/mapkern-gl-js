const rasterColor = `
uniform sampler2D u_image;
uniform float u_opacity;
uniform vec2 u_brightness;
uniform float u_saturation;
uniform float u_contrast;
uniform mat3 u_hue;
out vec4 fragColor;
vec4 rasterColor(vec4 c) {
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  rgb = u_hue * rgb;
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(lum), rgb, 1.0 + u_saturation);
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  rgb = mix(vec3(u_brightness.x), vec3(u_brightness.y), clamp(rgb, 0.0, 1.0));
  return vec4(rgb * c.a, c.a) * u_opacity;
}
`;

export const rasterShader = {
  name: "raster",
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
  fragment: `${rasterColor}
in vec2 v_uv;
void main() {
  fragColor = rasterColor(texture(u_image, v_uv));
}
`,
};

export const overlayShader = {
  name: "overlay",
  vertex: `
uniform mat4 u_matrix;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec3 a_uvq;
out vec3 v_uvq;
void main() {
  v_uvq = a_uvq;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}
`,
  fragment: `${rasterColor}
in vec3 v_uvq;
void main() {
  fragColor = rasterColor(texture(u_image, v_uvq.xy / v_uvq.z));
}
`,
};

export const solidShader = {
  name: "solid",
  vertex: `
layout(location = 0) in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`,
  fragment: `
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = u_color;
}
`,
};
