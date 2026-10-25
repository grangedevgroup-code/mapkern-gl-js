import { MapletError } from "../core/errors.ts";

export type Anchor =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type Offset = [number, number];

export type OffsetLike = number | [number, number] | { x: number; y: number };

export type AnchorOffsets = Record<Anchor, Offset>;

export const ANCHORS: readonly Anchor[] = [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const SHIFT: Record<Anchor, Offset> = {
  center: [-0.5, -0.5],
  top: [-0.5, 0],
  bottom: [-0.5, -1],
  left: [0, -0.5],
  right: [-1, -0.5],
  "top-left": [0, 0],
  "top-right": [-1, 0],
  "bottom-left": [0, -1],
  "bottom-right": [-1, -1],
};

export function isAnchor(value: unknown): value is Anchor {
  return typeof value === "string" && (ANCHORS as readonly string[]).includes(value);
}

export function anchorShift(anchor: Anchor): Offset {
  return SHIFT[anchor];
}

export function toOffset(value: unknown, name: string): Offset {
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return [value[0], value[1]];
  if (typeof value === "object" && value !== null) {
    const { x, y } = value as { x?: unknown; y?: unknown };
    if (Number.isFinite(x) && Number.isFinite(y)) return [x as number, y as number];
  }
  throw new MapletError("invalid-option", `${name} must be [x, y] or { x, y } in pixels`);
}

export function anchorOffsets(offset: OffsetLike | Partial<Record<Anchor, OffsetLike>> | undefined): AnchorOffsets {
  const out = {} as AnchorOffsets;
  if (offset === undefined || typeof offset === "number") {
    const n = offset ?? 0;
    if (!Number.isFinite(n)) throw new MapletError("invalid-option", "offset must be a finite number of pixels");
    const d = n / Math.SQRT2;
    out.center = [0, 0];
    out.top = [0, n];
    out.bottom = [0, -n];
    out.left = [n, 0];
    out.right = [-n, 0];
    out["top-left"] = [d, d];
    out["top-right"] = [-d, d];
    out["bottom-left"] = [d, -d];
    out["bottom-right"] = [-d, -d];
    return out;
  }
  if (Array.isArray(offset) || ("x" in offset && "y" in offset)) {
    const same = toOffset(offset, "offset");
    for (const a of ANCHORS) out[a] = [same[0], same[1]];
    return out;
  }
  const byAnchor = offset as Partial<Record<Anchor, OffsetLike>>;
  for (const a of ANCHORS) {
    const v = byAnchor[a];
    out[a] = v === undefined ? [0, 0] : typeof v === "number" ? anchorOffsets(v)[a] : toOffset(v, `offset.${a}`);
  }
  return out;
}

export function chooseAnchor(
  point: Offset,
  size: Offset,
  view: Offset,
  offsets: AnchorOffsets,
): Exclude<Anchor, "center" | "left" | "right"> {
  const [x, y] = point;
  const [w, h] = size;
  const fitsAbove = y + offsets.bottom[1] - h >= 0;
  const fitsBelow = y + offsets.top[1] + h <= view[1];
  const vertical = fitsAbove || !fitsBelow ? "bottom" : "top";
  const tooFarLeft = x - w / 2 < 0;
  const tooFarRight = x + w / 2 > view[0];
  if (tooFarLeft && !tooFarRight) return `${vertical}-left`;
  if (tooFarRight && !tooFarLeft) return `${vertical}-right`;
  return vertical;
}

export interface Body {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  round: boolean;
}

export function bodyOffsets(body: Body): AnchorOffsets {
  const { cx, cy, rx, ry } = body;
  const kx = body.round ? rx / Math.SQRT2 : rx;
  const ky = body.round ? ry / Math.SQRT2 : ry;
  return {
    center: [cx, cy],
    top: [cx, cy + ry],
    bottom: [cx, cy - ry],
    left: [cx + rx, cy],
    right: [cx - rx, cy],
    "top-left": [cx + kx, cy + ky],
    "top-right": [cx - kx, cy + ky],
    "bottom-left": [cx + kx, cy - ky],
    "bottom-right": [cx - kx, cy - ky],
  };
}
