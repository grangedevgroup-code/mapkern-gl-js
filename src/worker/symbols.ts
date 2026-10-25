import type { VectorFeature } from "../formats/mvt.ts";
import { classifyRings, ringArea } from "../formats/mvt.ts";
import type { Compiled, EvalContext } from "../style/expression.ts";

export interface LabelCandidate {
  feature: number;
  text: string;
  icon: string;
  size: number;
  priority: number;
  line: boolean;
  anchors: Float32Array;
  path: Int32Array | null;
}

export interface SymbolLayout {
  text: Compiled<unknown>;
  icon: Compiled<unknown>;
  size: Compiled<unknown>;
  priority: Compiled<unknown>;
  placement: "point" | "line" | "line-center";
  spacing: number;
  transform: Compiled<unknown>;
}

export interface LabelInfo {
  text: string;
  icon: string;
  size: number;
  priority: number;
}

export function labelInfo(ctx: EvalContext, layout: SymbolLayout): LabelInfo | null {
  const raw = layout.text.evaluate(ctx);
  let text = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  text = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  const rawIcon = layout.icon.evaluate(ctx);
  const icon = typeof rawIcon === "string" ? rawIcon : "";
  if (text.length === 0 && icon === "") return null;
  if (text.length > 200) text = `${text.slice(0, 199)}…`;
  const transform = layout.transform.evaluate(ctx);
  if (transform === "uppercase") text = text.toLocaleUpperCase();
  else if (transform === "lowercase") text = text.toLocaleLowerCase();
  return {
    text,
    icon,
    size: numberOr(layout.size.evaluate(ctx), 14),
    priority: numberOr(layout.priority.evaluate(ctx), 0),
  };
}

export function lineLabels(
  parts: readonly Int32Array[],
  info: LabelInfo,
  index: number,
  layout: SymbolLayout,
  extent: number,
): LabelCandidate[] {
  const { text, icon, size, priority } = info;
  const spacing = Math.max(16, layout.spacing) * (extent / 512);
  const minLength = Math.min(text.length * size * 0.5, 400) * (extent / 512);
  const centered = layout.placement === "line-center";
  const out: LabelCandidate[] = [];
  for (const part of parts) {
    const length = lineLength(part);
    if (length < minLength) continue;
    const anchors: number[] = [];
    const count = centered ? 1 : Math.max(1, Math.floor(length / spacing));
    const step = length / count;
    for (let i = 0; i < count; i++) {
      const at = step * (i + 0.5);
      const p = pointAlong(part, at);
      anchors.push(p[0], p[1], at);
    }
    out.push({
      feature: index,
      text,
      icon,
      size,
      priority,
      line: true,
      anchors: Float32Array.from(anchors),
      path: part,
    });
  }
  return out;
}

export function mergeParts(parts: readonly Int32Array[]): Int32Array[] {
  if (parts.length < 2) return parts.slice();
  const key = (x: number, y: number) => x * 67108864 + y;
  const ends = new Map<number, number[]>();
  const link = (k: number, end: number) => {
    const list = ends.get(k);
    if (list) list.push(end);
    else ends.set(k, [end]);
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    link(key(p[0]!, p[1]!), i * 2);
    link(key(p[p.length - 2]!, p[p.length - 1]!), i * 2 + 1);
  }
  const used = new Uint8Array(parts.length);
  const take = (x: number, y: number): number => {
    const list = ends.get(key(x, y));
    if (!list) return -1;
    for (const end of list) if (!used[end >> 1]) return end;
    return -1;
  };
  const out: Int32Array[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const first = parts[i]!;
    if (first.length < 4) {
      out.push(first);
      continue;
    }
    const forward: number[] = Array.from(first);
    for (;;) {
      const end = take(forward[forward.length - 2]!, forward[forward.length - 1]!);
      if (end < 0) break;
      used[end >> 1] = 1;
      const next = parts[end >> 1]!;
      if ((end & 1) === 0) for (let k = 2; k < next.length; k++) forward.push(next[k]!);
      else for (let k = next.length - 4; k >= 0; k -= 2) forward.push(next[k]!, next[k + 1]!);
    }
    const heads: number[][] = [];
    let hx = forward[0]!;
    let hy = forward[1]!;
    for (;;) {
      const end = take(hx, hy);
      if (end < 0) break;
      used[end >> 1] = 1;
      const next = parts[end >> 1]!;
      const piece: number[] = [];
      if ((end & 1) === 1) for (let k = 0; k < next.length - 2; k++) piece.push(next[k]!);
      else for (let k = next.length - 2; k >= 2; k -= 2) piece.push(next[k]!, next[k + 1]!);
      heads.push(piece);
      hx = piece[0]!;
      hy = piece[1]!;
    }
    let total = forward.length;
    for (const piece of heads) total += piece.length;
    const merged = new Int32Array(total);
    let at = 0;
    for (let h = heads.length - 1; h >= 0; h--) {
      merged.set(heads[h]!, at);
      at += heads[h]!.length;
    }
    merged.set(forward, at);
    out.push(merged);
  }
  return out;
}

export function labelCandidates(
  feature: VectorFeature,
  index: number,
  ctx: EvalContext,
  layout: SymbolLayout,
  extent: number,
): LabelCandidate[] {
  const info = labelInfo(ctx, layout);
  if (!info) return [];
  const { text, icon, size, priority } = info;
  const geometry = feature.geometry();
  if (geometry.length === 0) return [];
  const out: LabelCandidate[] = [];
  if (layout.placement !== "point" && (feature.type === 2 || feature.type === 3)) {
    return lineLabels(geometry, info, index, layout, extent);
  }
  if (feature.type === 1) {
    const anchors: number[] = [];
    for (const part of geometry) for (let i = 0; i < part.length; i += 2) anchors.push(part[i]!, part[i + 1]!, 0);
    out.push({
      feature: index,
      text,
      icon,
      size,
      priority,
      line: false,
      anchors: Float32Array.from(anchors),
      path: null,
    });
    return out;
  }
  if (feature.type === 2) {
    let best: Int32Array | null = null;
    let bestLength = 0;
    for (const part of geometry) {
      const length = lineLength(part);
      if (length > bestLength) {
        bestLength = length;
        best = part;
      }
    }
    if (best) {
      const p = pointAlong(best, bestLength / 2);
      out.push({
        feature: index,
        text,
        icon,
        size,
        priority,
        line: false,
        anchors: Float32Array.of(p[0], p[1], 0),
        path: null,
      });
    }
    return out;
  }
  const polygons = classifyRings(geometry);
  let bestRing: Int32Array | null = null;
  let bestArea = 0;
  for (const rings of polygons) {
    const outer = rings[0]!;
    const area = Math.abs(ringArea(outer));
    if (area > bestArea) {
      bestArea = area;
      bestRing = outer;
    }
  }
  if (bestRing) {
    const p = interiorPoint(bestRing);
    if (p[0] >= 0 && p[1] >= 0 && p[0] < extent && p[1] < extent) {
      out.push({
        feature: index,
        text,
        icon,
        size,
        priority,
        line: false,
        anchors: Float32Array.of(p[0], p[1], 0),
        path: null,
      });
    }
  }
  return out;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function lineLength(line: Int32Array): number {
  let length = 0;
  for (let i = 2; i < line.length; i += 2) length += Math.hypot(line[i]! - line[i - 2]!, line[i + 1]! - line[i - 1]!);
  return length;
}

export function pointAlong(line: Int32Array, distance: number): [number, number] {
  let remaining = distance;
  for (let i = 2; i < line.length; i += 2) {
    const ax = line[i - 2]!;
    const ay = line[i - 1]!;
    const bx = line[i]!;
    const by = line[i + 1]!;
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg >= remaining && seg > 0) {
      const t = remaining / seg;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
    remaining -= seg;
  }
  return [line[line.length - 2]!, line[line.length - 1]!];
}

function interiorPoint(ring: Int32Array): [number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const f = ring[j]! * ring[i + 1]! - ring[i]! * ring[j + 1]!;
    cx += (ring[j]! + ring[i]!) * f;
    cy += (ring[j + 1]! + ring[i + 1]!) * f;
    a += f;
  }
  if (a !== 0) {
    cx /= 3 * a;
    cy /= 3 * a;
    if (inside(cx, cy, ring)) return [cx, cy];
  }
  let y = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < ring.length; i += 2) {
    minY = Math.min(minY, ring[i]!);
    maxY = Math.max(maxY, ring[i]!);
  }
  y = (minY + maxY) / 2;
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const yi = ring[i + 1]!;
    const yj = ring[j + 1]!;
    if (yi > y !== yj > y) xs.push(ring[i]! + ((y - yi) * (ring[j]! - ring[i]!)) / (yj - yi));
  }
  xs.sort((p, q) => p - q);
  let best = 0;
  let bx = ring[0]!;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const w = xs[k + 1]! - xs[k]!;
    if (w > best) {
      best = w;
      bx = (xs[k]! + xs[k + 1]!) / 2;
    }
  }
  return [bx, y];
}

function inside(x: number, y: number, ring: Int32Array): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!,
      yi = ring[i + 1]!,
      xj = ring[j]!,
      yj = ring[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
