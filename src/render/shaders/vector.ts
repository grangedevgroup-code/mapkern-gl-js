import { globeChunk } from "./globe.ts";
import { demChunk } from "./terrain.ts";

export const paintChunk = `
uniform highp sampler2D u_paint;
uniform int u_paint_width;
uniform int u_paint_stride;
uniform float u_zoom_t;
vec4 paintValue(uint feature, int slot, int composite, vec4 fallback) {
  if (slot < 0) return fallback;
  int index = int(feature) * u_paint_stride + slot;
  vec4 a = texelFetch(u_paint, ivec2(index % u_paint_width, index / u_paint_width), 0);
  if (composite == 0) return a;
  int next = index + 1;
  vec4 b = texelFetch(u_paint, ivec2(next % u_paint_width, next / u_paint_width), 0);
  return mix(a, b, u_zoom_t);
}
`;

export const clipChunk = `
uniform vec4 u_clip;
uniform vec4 u_clip_ground;
uniform mat3 u_ground;
uniform int u_clip_mode;
bool outsideClip(vec2 pos) {
  if (u_clip_mode == 1) {
    vec3 g = u_ground * vec3(gl_FragCoord.xy, 1.0);
    vec2 w = g.xy / g.z;
    return w.x < u_clip_ground.x || w.y < u_clip_ground.y || w.x >= u_clip_ground.z || w.y >= u_clip_ground.w;
  }
  return pos.x < u_clip.x || pos.y < u_clip.y || pos.x >= u_clip.z || pos.y >= u_clip.w;
}
`;

export const fillPatternShader = {
  name: "fill-pattern",
  vertex: `
layout(location = 0) in vec2 a_pos;
uniform mat4 u_matrix;
uniform vec2 u_translate;
uniform float u_extent;
uniform float u_tile_size;
uniform vec4 u_pattern_origin;
out vec2 v_pos;
out vec4 v_pattern;
void main() {
  vec2 local = a_pos / u_extent * u_tile_size;
  v_pattern = vec4(local + u_pattern_origin.xy, local * 2.0 + u_pattern_origin.zw);
  v_pos = a_pos;
  gl_Position = u_matrix * vec4(a_pos + u_translate, 0.0, 1.0);
}
`,
  fragment: `
${clipChunk}
uniform sampler2D u_atlas;
uniform vec4 u_rect;
uniform float u_ratio;
uniform float u_mix;
uniform float u_opacity;
in vec2 v_pos;
in vec4 v_pattern;
out vec4 fragColor;
vec4 texel(ivec2 p, ivec2 size) {
  p = ivec2(p.x >= size.x ? p.x - size.x : p.x, p.y >= size.y ? p.y - size.y : p.y);
  return texelFetch(u_atlas, ivec2(u_rect.xy) + p, 0);
}
vec4 sampleAt(vec2 css) {
  vec2 p = mod(css * u_ratio - 0.5, u_rect.zw);
  ivec2 size = ivec2(u_rect.zw);
  ivec2 base = ivec2(floor(p));
  vec2 f = fract(p);
  vec4 top = mix(texel(base, size), texel(base + ivec2(1, 0), size), f.x);
  vec4 bottom = mix(texel(base + ivec2(0, 1), size), texel(base + ivec2(1, 1), size), f.x);
  return mix(top, bottom, f.y);
}
void main() {
  if (outsideClip(v_pos)) discard;
  fragColor = mix(sampleAt(v_pattern.xy), sampleAt(v_pattern.zw), u_mix) * u_opacity;
}
`,
};

export const fillShader = {
  name: "fill",
  vertex: `
layout(location = 0) in vec2 a_pos;
layout(location = 4) in uint a_feature;
uniform mat4 u_matrix;
uniform vec2 u_translate;
uniform vec4 u_color;
uniform int u_color_slot;
uniform int u_color_comp;
uniform float u_opacity;
uniform int u_opacity_slot;
uniform int u_opacity_comp;
${paintChunk}
out vec2 v_pos;
out vec4 v_color;
#ifdef PICK
flat out highp uint v_feature;
#endif
void main() {
#ifdef PICK
  v_feature = a_feature;
#endif
  vec4 color = paintValue(a_feature, u_color_slot, u_color_comp, u_color);
  float opacity = paintValue(a_feature, u_opacity_slot, u_opacity_comp, vec4(u_opacity)).x;
  v_color = vec4(color.rgb * color.a, color.a) * opacity;
  v_pos = a_pos;
  gl_Position = u_matrix * vec4(a_pos + u_translate, 0.0, 1.0);
}
`,
  fragment: `
${clipChunk}
in vec2 v_pos;
in vec4 v_color;
#ifdef PICK
uniform highp uint u_draw;
flat in highp uint v_feature;
out highp uvec4 pickColor;
#else
out vec4 fragColor;
#endif
void main() {
  if (outsideClip(v_pos)) discard;
#ifdef PICK
  pickColor = uvec4(u_draw, v_feature, 0u, 1u);
#else
  fragColor = v_color;
#endif
}
`,
};

export const fillOutlineShader = {
  name: "fill-outline",
  vertex: `
layout(location = 0) in vec2 a_pos;
layout(location = 4) in uint a_feature;
uniform mat4 u_matrix;
uniform vec2 u_translate;
uniform vec2 u_world;
uniform vec4 u_color;
uniform int u_color_slot;
uniform int u_color_comp;
uniform float u_opacity;
uniform int u_opacity_slot;
uniform int u_opacity_comp;
${paintChunk}
out vec2 v_pos;
out vec2 v_screen;
out vec4 v_color;
#ifdef PICK
flat out highp uint v_feature;
#endif
void main() {
#ifdef PICK
  v_feature = a_feature;
#endif
  vec4 color = paintValue(a_feature, u_color_slot, u_color_comp, u_color);
  float opacity = paintValue(a_feature, u_opacity_slot, u_opacity_comp, vec4(u_opacity)).x;
  v_color = vec4(color.rgb * color.a, color.a) * opacity;
  v_pos = a_pos;
  gl_Position = u_matrix * vec4(a_pos + u_translate, 0.0, 1.0);
  v_screen = (gl_Position.xy / gl_Position.w + 1.0) * 0.5 * u_world;
}
`,
  fragment: `
${clipChunk}
in vec2 v_pos;
in vec2 v_screen;
in vec4 v_color;
#ifdef PICK
uniform highp uint u_draw;
flat in highp uint v_feature;
out highp uvec4 pickColor;
#else
out vec4 fragColor;
#endif
void main() {
  if (outsideClip(v_pos)) discard;
  float dist = length(v_screen - gl_FragCoord.xy);
  float alpha = 1.0 - smoothstep(0.0, 1.0, dist);
#ifdef PICK
  pickColor = uvec4(u_draw, v_feature, 0u, 1u);
#else
  fragColor = v_color * alpha;
#endif
}
`,
};

export const lineShader = {
  name: "line",
  vertex: `
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_extrude;
layout(location = 2) in ivec4 a_side;
layout(location = 3) in float a_dist;
layout(location = 4) in uint a_feature;
uniform mat4 u_matrix;
uniform vec2 u_translate;
uniform float u_units_per_px;
uniform float u_pixel_ratio;
uniform vec4 u_color;
uniform int u_color_slot;
uniform int u_color_comp;
uniform float u_width;
uniform int u_width_slot;
uniform int u_width_comp;
uniform float u_opacity;
uniform int u_opacity_slot;
uniform int u_opacity_comp;
uniform float u_blur;
uniform int u_blur_slot;
uniform int u_blur_comp;
uniform float u_offset;
uniform int u_offset_slot;
uniform int u_offset_comp;
uniform float u_gap_width;
uniform int u_gap_width_slot;
uniform int u_gap_width_comp;
uniform float u_min_width;
${paintChunk}
out vec2 v_pos;
out vec2 v_side;
out float v_square;
out float v_half;
out float v_gap;
out float v_edge;
out float v_dist;
out vec4 v_color;
#ifdef PICK
flat out highp uint v_feature;
#endif
void main() {
#ifdef PICK
  v_feature = a_feature;
#endif
  vec4 color = paintValue(a_feature, u_color_slot, u_color_comp, u_color);
  float opacity = paintValue(a_feature, u_opacity_slot, u_opacity_comp, vec4(u_opacity)).x;
  float width = max(paintValue(a_feature, u_width_slot, u_width_comp, vec4(u_width)).x, u_min_width);
  float blur = max(paintValue(a_feature, u_blur_slot, u_blur_comp, vec4(u_blur)).x, 0.0);
  float aa = 1.0 / u_pixel_ratio;
  float half_width = width * 0.5;
  float coverage = 1.0;
  if (width < aa) {
    coverage = width / aa;
    half_width = aa * 0.5;
  }
  float edge = blur + aa;
  float gap = max(paintValue(a_feature, u_gap_width_slot, u_gap_width_comp, vec4(u_gap_width)).x, 0.0) * 0.5;
  float offset = paintValue(a_feature, u_offset_slot, u_offset_comp, vec4(u_offset)).x;
  float outset = (gap > 0.0 ? gap + half_width * 2.0 : half_width) + edge * 0.5;
  v_color = vec4(color.rgb * color.a, color.a) * opacity * coverage;
  v_half = half_width;
  v_gap = gap;
  v_edge = edge;
  int steps = a_side.z < 0 ? -a_side.z - 1 : a_side.z;
  float turn = float(a_side.w) * (3.14159265 / 128.0);
  vec2 shift = vec2(cos(turn), sin(turn)) * (float(steps) / 126.0 * 4.0);
  v_side = vec2(a_side.xy) * (1.0 / 127.0) * 2.0 * outset;
  v_square = a_side.z < 0 ? 1.0 : 0.0;
  v_dist = a_dist / u_units_per_px;
  vec2 pos = a_pos + u_translate + (a_extrude * (1.0 / 2048.0) * outset + shift * offset) * u_units_per_px;
  v_pos = pos;
  gl_Position = u_matrix * vec4(pos, 0.0, 1.0);
}
`,
  fragment: `
${clipChunk}
uniform float u_dash[8];
uniform int u_dash_count;
uniform float u_dash_total;
in vec2 v_pos;
in vec2 v_side;
in float v_square;
in float v_half;
in float v_gap;
in float v_edge;
in float v_dist;
in vec4 v_color;
#ifdef PICK
uniform highp uint u_draw;
flat in highp uint v_feature;
out highp uvec4 pickColor;
#else
out vec4 fragColor;
#endif
void main() {
  if (outsideClip(v_pos)) discard;
  float d = v_square > 0.5 ? max(abs(v_side.x), abs(v_side.y)) : length(v_side);
  float band = v_gap > 0.0 ? abs(d - v_gap - v_half) : d;
  float alpha = clamp((v_half + v_edge * 0.5 - band) / v_edge, 0.0, 1.0);
  if (u_dash_count > 0) {
    float unit = max(v_half * 2.0, 1.0);
    float t = mod(v_dist / unit, u_dash_total);
    float start = 0.0;
    float on = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= u_dash_count) break;
      float len = u_dash[i];
      if (t >= start && t < start + len) {
        float inside = min(t - start, start + len - t) * unit;
        on = (i % 2 == 0) ? clamp(inside + 0.5, 0.0, 1.0) : 1.0 - clamp(inside + 0.5, 0.0, 1.0);
        break;
      }
      start += len;
    }
    alpha *= on;
  }
#ifdef PICK
  if (alpha < 0.5) discard;
#else
  if (alpha <= 0.0) discard;
#endif
#ifdef PICK
  pickColor = uvec4(u_draw, v_feature, 0u, 1u);
#else
  fragColor = v_color * alpha;
#endif
}
`,
};

export const circleShader = {
  name: "circle",
  vertex: `
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_corner;
layout(location = 4) in uint a_feature;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_pixel_ratio;
uniform vec4 u_color;
uniform int u_color_slot;
uniform int u_color_comp;
uniform float u_radius;
uniform int u_radius_slot;
uniform int u_radius_comp;
uniform float u_opacity;
uniform int u_opacity_slot;
uniform int u_opacity_comp;
uniform vec4 u_stroke_color;
uniform int u_stroke_color_slot;
uniform int u_stroke_color_comp;
uniform float u_stroke_width;
uniform int u_stroke_width_slot;
uniform int u_stroke_width_comp;
uniform float u_stroke_opacity;
uniform int u_stroke_opacity_slot;
uniform int u_stroke_opacity_comp;
uniform float u_blur;
uniform int u_blur_slot;
uniform int u_blur_comp;
uniform vec2 u_translate;
uniform float u_units_per_px;
uniform float u_camera_distance;
uniform int u_pitch_align;
uniform int u_pitch_scale;
${paintChunk}
out vec2 v_offset;
out float v_radius;
out float v_stroke;
out float v_edge;
out vec4 v_fill;
out vec4 v_strokeColor;
flat out vec2 v_pos;
#ifdef PICK
flat out highp uint v_feature;
#endif
void main() {
#ifdef PICK
  v_feature = a_feature;
#endif
  vec4 color = paintValue(a_feature, u_color_slot, u_color_comp, u_color);
  vec4 stroke = paintValue(a_feature, u_stroke_color_slot, u_stroke_color_comp, u_stroke_color);
  float opacity = paintValue(a_feature, u_opacity_slot, u_opacity_comp, vec4(u_opacity)).x;
  float radius = max(paintValue(a_feature, u_radius_slot, u_radius_comp, vec4(u_radius)).x, 0.0);
  float strokeWidth = max(paintValue(a_feature, u_stroke_width_slot, u_stroke_width_comp, vec4(u_stroke_width)).x, 0.0);
  float blur = max(paintValue(a_feature, u_blur_slot, u_blur_comp, vec4(u_blur)).x, 0.0);
  float strokeOpacity = paintValue(a_feature, u_stroke_opacity_slot, u_stroke_opacity_comp, vec4(u_stroke_opacity)).x;
  float edge = blur + 1.0 / u_pixel_ratio;
  float extent = radius + strokeWidth + edge;
  v_offset = a_corner.xy * extent;
  v_radius = radius;
  v_stroke = strokeWidth;
  v_edge = edge;
  v_fill = vec4(color.rgb * color.a, color.a) * opacity;
  v_strokeColor = vec4(stroke.rgb * stroke.a, stroke.a) * strokeOpacity;
  v_pos = a_pos;
  vec2 base = a_pos + u_translate;
  if (u_pitch_align == 1) {
    gl_Position = u_matrix * vec4(base + a_corner.xy * extent * u_units_per_px, 0.0, 1.0);
  } else {
    vec4 center = u_matrix * vec4(base, 0.0, 1.0);
    float w = u_pitch_scale == 1 ? u_camera_distance : center.w;
    gl_Position = center + vec4(a_corner.xy * extent * 2.0 / u_viewport * w, 0.0, 0.0);
  }
}
`,
  fragment: `
${clipChunk}
in vec2 v_offset;
in float v_radius;
in float v_stroke;
in float v_edge;
in vec4 v_fill;
in vec4 v_strokeColor;
flat in vec2 v_pos;
#ifdef PICK
uniform highp uint u_draw;
flat in highp uint v_feature;
out highp uvec4 pickColor;
#else
out vec4 fragColor;
#endif
void main() {
  if (v_pos.x < u_clip.x || v_pos.y < u_clip.y || v_pos.x >= u_clip.z || v_pos.y >= u_clip.w) discard;
  float d = length(v_offset);
  float outer = v_radius + v_stroke;
  float alpha = clamp((outer + v_edge * 0.5 - d) / v_edge, 0.0, 1.0);
#ifdef PICK
  if (alpha < 0.5) discard;
#else
  if (alpha <= 0.0) discard;
#endif
  float t = v_stroke > 0.0 ? clamp((d - v_radius + v_edge * 0.5) / v_edge, 0.0, 1.0) : 0.0;
#ifdef PICK
  pickColor = uvec4(u_draw, v_feature, 0u, 1u);
#else
  fragColor = mix(v_fill, v_strokeColor, t) * alpha;
#endif
}
`,
};

export const extrusionShader = {
  name: "extrusion",
  vertex: `
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_normal;
layout(location = 4) in uint a_feature;
uniform mat4 u_matrix;
uniform float u_pixels_per_meter;
uniform vec3 u_light;
uniform float u_opacity;
uniform vec4 u_color;
uniform int u_color_slot;
uniform int u_color_comp;
uniform float u_height;
uniform int u_height_slot;
uniform int u_height_comp;
uniform float u_base;
uniform int u_base_slot;
uniform int u_base_comp;
${paintChunk}
#ifdef TERRAIN
uniform float u_extent;
${demChunk}
#endif
#ifdef GLOBE
uniform vec3 u_tile;
${globeChunk}
#endif
out vec2 v_pos;
out vec4 v_color;
#ifdef PICK
flat out highp uint v_feature;
#endif
void main() {
#ifdef PICK
  v_feature = a_feature;
#endif
  vec4 color = paintValue(a_feature, u_color_slot, u_color_comp, u_color);
  float height = max(paintValue(a_feature, u_height_slot, u_height_comp, vec4(u_height)).x, 0.0);
  float base = clamp(paintValue(a_feature, u_base_slot, u_base_comp, vec4(u_base)).x, 0.0, height);
  bool top = a_normal.w > 0.5;
  float lambert = max(dot(a_normal.xyz, u_light), 0.0);
  float shade = a_normal.z > 0.5 ? 1.0 : (0.66 + 0.3 * lambert) * (top ? 1.0 : 0.86);
  v_color = vec4(color.rgb * shade * color.a, color.a) * u_opacity;
  v_pos = a_pos;
#ifdef GLOBE
  float meters = top ? height : base;
#ifdef TERRAIN
  if (u_has_dem > 0.5) {
    vec2 ground = clamp(a_pos / u_extent, 0.0, 1.0);
    meters += demElevation(u_dem_rect.xy + ground * u_dem_rect.zw) * u_exaggeration;
  }
#endif
  gl_Position = u_matrix * vec4(surfacePoint(u_tile.xy + a_pos * u_tile.z, meters, 0.0), 1.0);
#else
  float z = (top ? height : base) * u_pixels_per_meter;
#ifdef TERRAIN
  z += groundPixels(clamp(a_pos / u_extent, 0.0, 1.0));
#endif
  gl_Position = u_matrix * vec4(a_pos, z, 1.0);
#endif
}
`,
  fragment: `
${clipChunk}
in vec2 v_pos;
in vec4 v_color;
#ifdef PICK
uniform highp uint u_draw;
flat in highp uint v_feature;
out highp uvec4 pickColor;
#else
out vec4 fragColor;
#endif
void main() {
#ifndef WHOLE
  if (v_pos.x < u_clip.x || v_pos.y < u_clip.y || v_pos.x >= u_clip.z || v_pos.y >= u_clip.w) discard;
#endif
#ifdef PICK
  pickColor = uvec4(u_draw, v_feature, 0u, 1u);
#else
  fragColor = v_color;
#endif
}
`,
};
