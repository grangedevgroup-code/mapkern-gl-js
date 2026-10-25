import type { LayerSpec } from "./types.ts";

export interface LayerUpdate {
  paint: [string, unknown][];
  layout: [string, unknown][];
  filter: boolean;
  zoom: boolean;
  visible: boolean;
}

const STRUCTURE = ["type", "source", "sourceLayer", "sortKey"] as const;

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  return changedKeys(a as Record<string, unknown>, b as Record<string, unknown>).length === 0;
}

export function changedKeys(a: object, b: object): string[] {
  const before = a as Record<string, unknown>;
  const after = b as Record<string, unknown>;
  const out: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameValue(before[key], after[key])) out.push(key);
  }
  return out;
}

export function layerUpdate(before: LayerSpec, after: LayerSpec): LayerUpdate | null {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  for (const key of STRUCTURE) if (!sameValue(a[key], b[key])) return null;
  return {
    paint: changedEntries(a.paint, b.paint),
    layout: changedEntries(a.layout, b.layout),
    filter: !sameValue(a.filter, b.filter),
    zoom: (before.minZoom ?? 0) !== (after.minZoom ?? 0) || (before.maxZoom ?? 24) !== (after.maxZoom ?? 24),
    visible: (before.visible !== false) !== (after.visible !== false),
  };
}

function changedEntries(before: unknown, after: unknown): [string, unknown][] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  return changedKeys(a, b).map((key) => [key, b[key]]);
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
