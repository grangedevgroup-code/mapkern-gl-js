export type Affiliation = "pending" | "unknown" | "assumed-friend" | "friend" | "neutral" | "suspect" | "hostile";

export type Dimension = "air" | "space" | "ground" | "equipment" | "installation" | "sea" | "subsurface";

export type Echelon =
  | "team"
  | "squad"
  | "section"
  | "platoon"
  | "company"
  | "battalion"
  | "regiment"
  | "brigade"
  | "division"
  | "corps"
  | "army"
  | "army-group"
  | "region"
  | "command";

export interface SymbolCode {
  sidc: string;
  affiliation: Affiliation;
  dimension: Dimension;
  planned: boolean;
  exercise: boolean;
  letter: string;
  icon: string;
  echelon: Echelon | null;
  headquarters: boolean;
  taskForce: boolean;
  dummy: boolean;
}

const LETTER_AFFILIATION: Record<string, [Affiliation, boolean, string]> = {
  P: ["pending", false, ""],
  U: ["unknown", false, ""],
  A: ["assumed-friend", false, ""],
  F: ["friend", false, ""],
  N: ["neutral", false, ""],
  S: ["suspect", false, ""],
  H: ["hostile", false, ""],
  G: ["pending", true, "X"],
  W: ["unknown", true, "X"],
  M: ["assumed-friend", true, "X"],
  D: ["friend", true, "X"],
  L: ["neutral", true, "X"],
  J: ["hostile", true, "J"],
  K: ["hostile", true, "K"],
};

const LETTER_ECHELON: Record<string, Echelon> = {
  A: "team",
  B: "squad",
  C: "section",
  D: "platoon",
  E: "company",
  F: "battalion",
  G: "regiment",
  H: "brigade",
  I: "division",
  J: "corps",
  K: "army",
  L: "army-group",
  M: "region",
  N: "command",
};

const NUMBER_ECHELON: Record<string, Echelon> = {
  "11": "team",
  "12": "squad",
  "13": "section",
  "14": "platoon",
  "15": "company",
  "16": "battalion",
  "17": "regiment",
  "18": "brigade",
  "21": "division",
  "22": "corps",
  "23": "army",
  "24": "army-group",
  "25": "region",
  "26": "command",
};

const NUMBER_AFFILIATION: Affiliation[] = [
  "pending",
  "unknown",
  "assumed-friend",
  "friend",
  "neutral",
  "suspect",
  "hostile",
];

const NUMBER_ICONS: Record<string, string> = {
  "121100": "infantry",
  "121102": "mechanized",
  "120500": "armor",
  "121300": "reconnaissance",
  "130300": "artillery",
  "130100": "air-defense",
  "140700": "engineer",
};

const LETTER_ICONS: [string, string][] = [
  ["UCIZ", "mechanized"],
  ["UCAA", "anti-armor"],
  ["UCVR", "rotary-wing"],
  ["UCVF", "fixed-wing"],
  ["UCI", "infantry"],
  ["UCA", "armor"],
  ["UCR", "reconnaissance"],
  ["UCF", "artillery"],
  ["UCD", "air-defense"],
  ["UCE", "engineer"],
  ["UCM", "missile"],
  ["UCV", "aviation"],
  ["UUS", "signal"],
  ["UUM", "intelligence"],
  ["UUL", "police"],
  ["UUA", "cbrn"],
  ["USM", "medical"],
  ["USS", "supply"],
  ["UST", "transport"],
  ["USX", "maintenance"],
];

export function parseSidc(input: string): SymbolCode | null {
  const sidc = String(input ?? "")
    .trim()
    .toUpperCase();
  if (/^\d{20}(\d{10})?$/.test(sidc)) return parseNumber(sidc);
  if (/^[A-Z][A-Z*-][A-Z*-][A-Z*-][A-Z0-9*-]{6}[A-Z0-9*-]{0,5}$/.test(sidc)) return parseLetters(sidc);
  return null;
}

function parseLetters(sidc: string): SymbolCode | null {
  const scheme = sidc[0]!;
  if (scheme !== "S" && scheme !== "I" && scheme !== "O" && scheme !== "E") return null;
  const [affiliation, exercise, letter] = LETTER_AFFILIATION[sidc[1]!] ?? ["unknown", false, ""];
  const fn = sidc.slice(4, 10).replace(/[*-]+$/, "");
  const modifier = sidc[10] ?? "-";
  const echelon = LETTER_ECHELON[sidc[11] ?? "-"] ?? null;
  let dimension: Dimension;
  switch (sidc[2]) {
    case "P":
      dimension = "space";
      break;
    case "A":
      dimension = "air";
      break;
    case "S":
      dimension = "sea";
      break;
    case "U":
      dimension = "subsurface";
      break;
    default:
      dimension = fn.startsWith("E") ? "equipment" : fn.startsWith("I") || modifier === "H" ? "installation" : "ground";
  }
  const icon = dimension === "ground" ? (LETTER_ICONS.find(([prefix]) => fn.startsWith(prefix))?.[1] ?? "") : "";
  return {
    sidc,
    affiliation,
    dimension,
    planned: sidc[3] === "A",
    exercise,
    letter,
    icon,
    echelon,
    headquarters: "ABCD".includes(modifier) && modifier !== "-",
    taskForce: "BDEG".includes(modifier) && modifier !== "-",
    dummy: "CDFG".includes(modifier) && modifier !== "-",
  };
}

function parseNumber(sidc: string): SymbolCode | null {
  const context = Number(sidc[2]);
  const identity = Number(sidc[3]);
  const set = sidc.slice(4, 6);
  const status = sidc[6]!;
  const hq = Number(sidc[7]);
  const amplifier = sidc.slice(8, 10);
  const entity = sidc.slice(10, 16);
  const affiliation = NUMBER_AFFILIATION[identity];
  if (!affiliation) return null;
  let dimension: Dimension;
  switch (set) {
    case "01":
    case "02":
      dimension = "air";
      break;
    case "05":
    case "06":
      dimension = "space";
      break;
    case "15":
      dimension = "equipment";
      break;
    case "20":
      dimension = "installation";
      break;
    case "30":
      dimension = "sea";
      break;
    case "35":
    case "36":
      dimension = "subsurface";
      break;
    default:
      dimension = "ground";
  }
  const exercise = context === 1 || context === 2;
  return {
    sidc,
    affiliation,
    dimension,
    planned: status === "1",
    exercise,
    letter: exercise ? "X" : "",
    icon: set === "10" ? (NUMBER_ICONS[entity] ?? "") : "",
    echelon: set === "10" ? (NUMBER_ECHELON[amplifier] ?? null) : null,
    headquarters: hq === 2 || hq === 3 || hq === 6 || hq === 7,
    taskForce: hq >= 4 && hq <= 7,
    dummy: hq === 1 || hq === 3 || hq === 5 || hq === 7,
  };
}

const FILL: Record<Affiliation, string> = {
  pending: "#FFFF80",
  unknown: "#FFFF80",
  "assumed-friend": "#80E0FF",
  friend: "#80E0FF",
  neutral: "#AAFFAA",
  suspect: "#FF8080",
  hostile: "#FF8080",
};

interface Frame {
  path: string;
  closed: boolean;
  box: [number, number, number, number];
  top: number;
  bottom: number;
  left: number;
  staff: number;
}

function shape(affiliation: Affiliation, dimension: Dimension): Frame {
  const family =
    affiliation === "friend" || affiliation === "assumed-friend"
      ? "friend"
      : affiliation === "hostile" || affiliation === "suspect"
        ? "hostile"
        : affiliation === "neutral"
          ? "neutral"
          : "unknown";
  const flying = dimension === "air" || dimension === "space";
  if (family === "friend") {
    if (flying)
      return {
        path: "M25,150 C25,40 175,40 175,150",
        closed: false,
        box: [50, 70, 150, 140],
        top: 68,
        bottom: 150,
        left: 25,
        staff: 150,
      };
    if (dimension === "subsurface")
      return {
        path: "M25,50 C25,160 175,160 175,50",
        closed: false,
        box: [50, 60, 150, 130],
        top: 50,
        bottom: 132,
        left: 25,
        staff: 50,
      };
    if (dimension === "equipment" || dimension === "sea")
      return {
        path: "M100,40 A60,60 0 1,1 99.99,40 Z",
        closed: true,
        box: [62, 68, 138, 132],
        top: 40,
        bottom: 160,
        left: 40,
        staff: 100,
      };
    return {
      path: "M25,50 L175,50 L175,150 L25,150 Z",
      closed: true,
      box: [25, 50, 175, 150],
      top: dimension === "installation" ? 35 : 50,
      bottom: 150,
      left: 25,
      staff: 150,
    };
  }
  if (family === "hostile") {
    if (flying)
      return {
        path: "M45,150 L45,70 L100,20 L155,70 L155,150",
        closed: false,
        box: [60, 70, 140, 140],
        top: 20,
        bottom: 150,
        left: 45,
        staff: 150,
      };
    if (dimension === "subsurface")
      return {
        path: "M45,50 L45,130 L100,180 L155,130 L155,50",
        closed: false,
        box: [60, 60, 140, 130],
        top: 50,
        bottom: 180,
        left: 45,
        staff: 50,
      };
    return {
      path: "M100,28 L172,100 L100,172 L28,100 Z",
      closed: true,
      box: [64, 72, 136, 128],
      top: dimension === "installation" ? 13 : 28,
      bottom: 172,
      left: 28,
      staff: 100,
    };
  }
  if (family === "neutral") {
    if (flying)
      return {
        path: "M45,150 L45,30 L155,30 L155,150",
        closed: false,
        box: [55, 50, 145, 140],
        top: 30,
        bottom: 150,
        left: 45,
        staff: 150,
      };
    if (dimension === "subsurface")
      return {
        path: "M45,50 L45,170 L155,170 L155,50",
        closed: false,
        box: [55, 60, 145, 150],
        top: 50,
        bottom: 170,
        left: 45,
        staff: 50,
      };
    return {
      path: "M45,45 L155,45 L155,155 L45,155 Z",
      closed: true,
      box: [45, 45, 155, 155],
      top: dimension === "installation" ? 30 : 45,
      bottom: 155,
      left: 45,
      staff: 155,
    };
  }
  if (flying)
    return {
      path: "M65,150 C10,150 15,60 65,60 C65,10 135,10 135,60 C185,60 190,150 135,150",
      closed: false,
      box: [60, 60, 140, 140],
      top: 22,
      bottom: 150,
      left: 25,
      staff: 150,
    };
  if (dimension === "subsurface")
    return {
      path: "M65,50 C10,50 15,140 65,140 C65,190 135,190 135,140 C185,140 190,50 135,50",
      closed: false,
      box: [60, 60, 140, 140],
      top: 50,
      bottom: 178,
      left: 25,
      staff: 50,
    };
  return {
    path: "M63,63 C63,20 137,20 137,63 C180,63 180,137 137,137 C137,180 63,180 63,137 C20,137 20,63 63,63 Z",
    closed: true,
    box: [55, 63, 145, 137],
    top: dimension === "installation" ? 15 : 30,
    bottom: 170,
    left: 30,
    staff: 100,
  };
}

interface Mark {
  path?: string;
  dots?: [number, number, number][];
  text?: [string, number, number, number];
}

function icon(name: string, frame: Frame): Mark[] {
  const [x0, y0, x1, y1] = frame.box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const w = x1 - x0;
  const h = y1 - y0;
  const cross = `M${x0},${y0} L${x1},${y1} M${x0},${y1} L${x1},${y0}`;
  const oval = `M${cx - w * 0.3},${cy - h * 0.22} L${cx + w * 0.3},${cy - h * 0.22} A${h * 0.22},${h * 0.22} 0 0,1 ${cx + w * 0.3},${cy + h * 0.22} L${cx - w * 0.3},${cy + h * 0.22} A${h * 0.22},${h * 0.22} 0 0,1 ${cx - w * 0.3},${cy - h * 0.22} Z`;
  switch (name) {
    case "infantry":
      return [{ path: cross }];
    case "armor":
      return [{ path: oval }];
    case "mechanized":
      return [{ path: cross }, { path: oval }];
    case "reconnaissance":
      return [{ path: `M${x0},${y1} L${x1},${y0}` }];
    case "artillery":
      return [{ dots: [[cx, cy, Math.min(w, h) * 0.12]] }];
    case "air-defense":
      return [
        {
          path: `M${cx - w * 0.35},${y1} C${cx - w * 0.35},${cy - h * 0.1} ${cx + w * 0.35},${cy - h * 0.1} ${cx + w * 0.35},${y1}`,
        },
      ];
    case "engineer":
      return [
        {
          path: `M${cx - w * 0.3},${cy + h * 0.15} L${cx - w * 0.3},${cy - h * 0.15} L${cx + w * 0.3},${cy - h * 0.15} L${cx + w * 0.3},${cy + h * 0.15} M${cx},${cy - h * 0.15} L${cx},${cy + h * 0.15}`,
        },
      ];
    case "anti-armor":
      return [{ path: `M${x0},${y1} L${cx},${y0} L${x1},${y1}` }];
    case "missile":
      return [
        {
          path: `M${cx},${cy + h * 0.35} L${cx},${cy - h * 0.25} M${cx - w * 0.08},${cy - h * 0.1} L${cx},${cy - h * 0.35} L${cx + w * 0.08},${cy - h * 0.1}`,
        },
      ];
    case "aviation":
    case "rotary-wing":
      return [
        {
          path: `M${cx - w * 0.3},${cy - h * 0.2} L${cx + w * 0.3},${cy + h * 0.2} L${cx + w * 0.3},${cy - h * 0.2} L${cx - w * 0.3},${cy + h * 0.2} Z`,
        },
      ];
    case "fixed-wing":
      return [
        {
          path: `M${cx},${cy} C${cx - w * 0.15},${cy - h * 0.3} ${cx - w * 0.35},${cy - h * 0.3} ${cx - w * 0.35},${cy} C${cx - w * 0.35},${cy + h * 0.3} ${cx - w * 0.15},${cy + h * 0.3} ${cx},${cy} C${cx + w * 0.15},${cy - h * 0.3} ${cx + w * 0.35},${cy - h * 0.3} ${cx + w * 0.35},${cy} C${cx + w * 0.35},${cy + h * 0.3} ${cx + w * 0.15},${cy + h * 0.3} ${cx},${cy}`,
        },
      ];
    case "signal":
      return [{ path: `M${x0},${y0} L${cx},${y1 - h * 0.15} L${cx},${y0 + h * 0.15} L${x1},${y1}` }];
    case "medical":
      return [{ path: `M${cx},${y0} L${cx},${y1} M${x0},${cy} L${x1},${cy}` }];
    case "supply":
      return [{ path: `M${x0},${y1 - h * 0.2} L${x1},${y1 - h * 0.2}` }];
    case "transport":
      return [
        { path: `M${cx},${y0 + h * 0.1} L${cx},${y1 - h * 0.1} M${cx - w * 0.25},${cy} L${cx + w * 0.25},${cy}` },
        { dots: [[cx, cy, Math.min(w, h) * 0.06]] },
      ];
    case "maintenance":
      return [
        {
          path: `M${cx - w * 0.3},${cy} L${cx + w * 0.3},${cy} M${cx - w * 0.3},${cy - h * 0.18} A${h * 0.18},${h * 0.18} 0 0,0 ${cx - w * 0.3},${cy + h * 0.18} M${cx + w * 0.3},${cy - h * 0.18} A${h * 0.18},${h * 0.18} 0 0,1 ${cx + w * 0.3},${cy + h * 0.18}`,
        },
      ];
    case "intelligence":
      return [{ text: ["MI", cx, cy, h * 0.45] }];
    case "police":
      return [{ text: ["MP", cx, cy, h * 0.45] }];
    case "cbrn":
      return [{ text: ["CBRN", cx, cy, h * 0.3] }];
    default:
      return [];
  }
}

function echelonMarks(echelon: Echelon, top: number): Mark[] {
  const base = top - 8;
  const dots = (n: number): Mark[] => [
    {
      dots: Array.from(
        { length: n },
        (_, i) => [100 + (i - (n - 1) / 2) * 20, base - 8, 7] as [number, number, number],
      ),
    },
  ];
  const bars = (n: number): Mark[] => [
    {
      path: Array.from(
        { length: n },
        (_, i) => `M${100 + (i - (n - 1) / 2) * 14},${base} L${100 + (i - (n - 1) / 2) * 14},${base - 26}`,
      ).join(" "),
    },
  ];
  const crosses = (n: number): Mark[] => [
    {
      path: Array.from({ length: n }, (_, i) => {
        const x = 100 + (i - (n - 1) / 2) * 24;
        return `M${x - 10},${base} L${x + 10},${base - 26} M${x - 10},${base - 26} L${x + 10},${base}`;
      }).join(" "),
    },
  ];
  switch (echelon) {
    case "team":
      return [{ path: `M100,${base - 26} A13,13 0 1,1 99.99,${base - 26} Z M86,${base} L114,${base - 26}` }];
    case "squad":
      return dots(1);
    case "section":
      return dots(2);
    case "platoon":
      return dots(3);
    case "company":
      return bars(1);
    case "battalion":
      return bars(2);
    case "regiment":
      return bars(3);
    case "brigade":
      return crosses(1);
    case "division":
      return crosses(2);
    case "corps":
      return crosses(3);
    case "army":
      return crosses(4);
    case "army-group":
      return crosses(5);
    case "region":
      return crosses(6);
    case "command":
      return [
        { path: `M80,${base - 13} L120,${base - 13} M100,${base} L100,${base - 26}` },
        { path: `M135,${base - 13} L165,${base - 13} M150,${base} L150,${base - 26}` },
      ];
  }
}

export interface SymbolOptions {
  size?: number;
  label?: string;
  fill?: boolean;
}

export interface DrawnSymbol {
  code: SymbolCode;
  width: number;
  height: number;
  svg: string;
  draw(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pixelRatio: number): void;
}

const STROKE = 4;
const MIN_LINE = 1.25;
const MIN_DOT = 1.4;
const INK = "#000000";

export function drawSymbol(sidc: string, options: SymbolOptions = {}): DrawnSymbol | null {
  const code = parseSidc(sidc);
  if (!code) return null;
  const frame = shape(code.affiliation, code.dimension);
  const marks: Mark[] = icon(code.icon, frame);
  let top = frame.top;
  if (code.dimension === "installation") {
    marks.push({ path: `M85,${frame.top - 2} L115,${frame.top - 2} L115,${frame.top + 15} L85,${frame.top + 15} Z` });
  }
  if (code.echelon) {
    marks.push(...echelonMarks(code.echelon, top));
    top -= 36;
  }
  if (code.taskForce) {
    marks.push({ path: `M66,${frame.top} L66,${top - 6} L134,${top - 6} L134,${frame.top}` });
    top -= 10;
  }
  if (code.dummy) {
    marks.push({ path: `M40,${top - 4} L100,${top - 44} L160,${top - 4}` });
    top -= 48;
  }
  let bottom = frame.bottom;
  if (code.headquarters) {
    marks.push({ path: `M${frame.left},${frame.staff} L${frame.left},${frame.staff + 100}` });
    bottom = Math.max(bottom, frame.staff + 100);
  }
  if (code.letter) marks.push({ text: [code.letter, 172, Math.max(top, frame.top) + 4, 34] });
  const label = options.label?.trim() ?? "";
  const labelWidth = label ? label.length * 22 + 12 : 0;
  const unit = (options.size ?? 16) / 100;
  const stroke = Math.max(STROKE, MIN_LINE / unit);
  const dot = (r: number) => Math.max(r, MIN_DOT / unit);
  const half = Math.max(100 - top, bottom - 100, 80) + stroke;
  const sideHalf = Math.max(100 + labelWidth, 100) + stroke;
  const width = Math.ceil(sideHalf * 2 * unit);
  const height = Math.ceil(half * 2 * unit);
  const offsetX = sideHalf - 100;
  const offsetY = half - 100;
  if (label) marks.push({ text: [label, 186 + labelWidth / 2, 100, 36] });
  const fill = options.fill === false ? "none" : FILL[code.affiliation];
  const dash =
    code.planned ||
    code.affiliation === "pending" ||
    code.affiliation === "assumed-friend" ||
    code.affiliation === "suspect";
  const dashes = [stroke * 4, stroke * 2.5];
  const dashArray = dash ? dashes.join(" ") : "";
  const parts: string[] = [];
  if (frame.closed && fill !== "none") parts.push(`<path d="${frame.path}" fill="${fill}" stroke="none"/>`);
  if (!frame.closed && fill !== "none") parts.push(`<path d="${frame.path} Z" fill="${fill}" stroke="none"/>`);
  parts.push(
    `<path d="${frame.path}" fill="none" stroke="${INK}" stroke-width="${stroke}"${dash ? ` stroke-dasharray="${dashArray}"` : ""}/>`,
  );
  for (const mark of marks) {
    if (mark.path) parts.push(`<path d="${mark.path}" fill="none" stroke="${INK}" stroke-width="${stroke}"/>`);
    for (const [x, y, r] of mark.dots ?? []) parts.push(`<circle cx="${x}" cy="${y}" r="${dot(r)}" fill="${INK}"/>`);
    if (mark.text) {
      const [text, x, y, size] = mark.text;
      parts.push(
        `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="bold" text-anchor="middle" dominant-baseline="central" fill="${INK}">${escapeXml(text)}</text>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${-offsetX} ${-offsetY} ${sideHalf * 2} ${half * 2}">${parts.join("")}</svg>`;
  const draw = (context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pixelRatio: number) => {
    const scale = unit * pixelRatio;
    context.save();
    context.setTransform(scale, 0, 0, scale, offsetX * scale, offsetY * scale);
    context.lineWidth = stroke;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.strokeStyle = INK;
    if (fill !== "none") {
      context.fillStyle = fill;
      context.fill(new Path2D(frame.closed ? frame.path : `${frame.path} Z`));
    }
    context.setLineDash(dash ? dashes : []);
    context.stroke(new Path2D(frame.path));
    context.setLineDash([]);
    context.fillStyle = INK;
    for (const mark of marks) {
      if (mark.path) context.stroke(new Path2D(mark.path));
      for (const [x, y, r] of mark.dots ?? []) {
        context.beginPath();
        context.arc(x, y, dot(r), 0, Math.PI * 2);
        context.fill();
      }
      if (mark.text) {
        const [text, x, y, size] = mark.text;
        context.font = `bold ${size}px Arial, Helvetica, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(text, x, y);
      }
    }
    context.restore();
  };
  return { code, width, height, svg, draw };
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface MilitarySymbolsOptions extends SymbolOptions {
  prefix?: string;
}

interface SymbolMap {
  on(type: "styleimagemissing", listener: (event: { id: string }) => void): unknown;
  off(type: "styleimagemissing", listener: (event: { id: string }) => void): unknown;
  hasImage(id: string): boolean;
  addImage(id: string, image: HTMLCanvasElement | OffscreenCanvas, options: { pixelRatio: number }): unknown;
  getPixelRatio(): number;
}

export function militarySymbols(map: SymbolMap, options: MilitarySymbolsOptions = {}): () => void {
  const prefix = options.prefix ?? "sidc:";
  const handler = (event: { id: string }) => {
    if (!event.id.startsWith(prefix) || map.hasImage(event.id)) return;
    const drawn = drawSymbol(event.id.slice(prefix.length), options);
    if (!drawn) return;
    const ratio = Math.max(1, Math.min(4, Math.ceil(map.getPixelRatio())));
    const canvas = symbolCanvas(drawn.width * ratio, drawn.height * ratio);
    const context = canvas?.getContext("2d", { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!canvas || !context) return;
    drawn.draw(context, ratio);
    map.addImage(event.id, canvas, { pixelRatio: ratio });
  };
  map.on("styleimagemissing", handler);
  return () => map.off("styleimagemissing", handler);
}

function symbolCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
