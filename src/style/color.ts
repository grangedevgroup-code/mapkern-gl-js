export type RGBA = [r: number, g: number, b: number, a: number];

const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff,
  beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd, blue: 0x0000ff,
  blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00,
  chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9,
  darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000,
  darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493,
  deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222,
  floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff,
  gold: 0xffd700, goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f, grey: 0x808080,
  honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0,
  khaki: 0xf0e68c, lavender: 0xe6e6fa, lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd,
  lightblue: 0xadd8e6, lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2,
  lightgray: 0xd3d3d3, lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6,
  magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd,
  mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee,
  mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585, midnightblue: 0x191970,
  mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080,
  oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500,
  orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb,
  plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399, red: 0xff0000,
  rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460,
  seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb,
  slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f,
  steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8, tomato: 0xff6347,
  turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5,
  yellow: 0xffff00, yellowgreen: 0x9acd32,
};

const cache = new Map<string, RGBA | null>();

export function parseColor(input: string): RGBA | null {
  const key = input.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit ? [hit[0], hit[1], hit[2], hit[3]] : null;
  const value = parse(key);
  if (cache.size > 2048) cache.clear();
  cache.set(key, value);
  return value ? [value[0], value[1], value[2], value[3]] : null;
}

function parse(s: string): RGBA | null {
  if (s === "transparent") return [0, 0, 0, 0];
  const named = NAMED[s];
  if (named !== undefined) return [((named >> 16) & 255) / 255, ((named >> 8) & 255) / 255, (named & 255) / 255, 1];
  if (s.startsWith("#")) return parseHex(s.slice(1));
  const m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!m) return null;
  const fn = m[1]!;
  const parts = m[2]!
    .replace(/\s*\/\s*/, ",")
    .split(/[\s,]+/)
    .filter((p) => p.length > 0);
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = parts.length === 4 ? parseAlpha(parts[3]!) : 1;
  if (alpha === null) return null;
  if (fn.startsWith("rgb")) {
    const rgb = parts.slice(0, 3).map(parseChannel);
    if (rgb.some((c) => c === null)) return null;
    return [rgb[0]!, rgb[1]!, rgb[2]!, alpha];
  }
  const h = Number.parseFloat(parts[0]!.replace(/deg$/, ""));
  const sat = parsePercent(parts[1]!);
  const light = parsePercent(parts[2]!);
  if (!Number.isFinite(h) || sat === null || light === null) return null;
  const [r, g, b] = hslToRgb((((h % 360) + 360) % 360) / 360, sat, light);
  return [r, g, b, alpha];
}

function parseHex(hex: string): RGBA | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const v = [...hex].map((c) => Number.parseInt(c + c, 16) / 255);
    return [v[0]!, v[1]!, v[2]!, v[3] ?? 1];
  }
  if (hex.length === 6 || hex.length === 8) {
    const v: number[] = [];
    for (let i = 0; i < hex.length; i += 2) v.push(Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    return [v[0]!, v[1]!, v[2]!, v[3] ?? 1];
  }
  return null;
}

function parseChannel(p: string): number | null {
  if (p.endsWith("%")) {
    const v = Number.parseFloat(p);
    return Number.isFinite(v) ? clamp01(v / 100) : null;
  }
  const v = Number.parseFloat(p);
  return Number.isFinite(v) ? clamp01(v / 255) : null;
}

function parseAlpha(p: string): number | null {
  const v = Number.parseFloat(p);
  if (!Number.isFinite(v)) return null;
  return clamp01(p.endsWith("%") ? v / 100 : v);
}

function parsePercent(p: string): number | null {
  const v = Number.parseFloat(p);
  return Number.isFinite(v) ? clamp01(v / 100) : null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

export function premultiply(c: RGBA, opacity = 1): RGBA {
  const a = c[3] * opacity;
  return [c[0] * a, c[1] * a, c[2] * a, a];
}

export function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

export function isColor(value: unknown): value is RGBA {
  return Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number");
}

export function colorToCss(c: RGBA): string {
  const to = (v: number) => Math.round(clamp01(v) * 255);
  return `rgba(${to(c[0])}, ${to(c[1])}, ${to(c[2])}, ${Math.round(clamp01(c[3]) * 1000) / 1000})`;
}
