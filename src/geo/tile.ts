export const MAX_TILE_ZOOM = 24;

export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface TileSlot extends TileCoord {
  readonly wrap: number;
}

const SHIFT = 2 ** 24;

export function tileKey(z: number, x: number, y: number): number {
  return (z * SHIFT + y) * SHIFT + x;
}

export function slotKey(z: number, x: number, y: number, wrap: number): string {
  return `${wrap}/${z}/${x}/${y}`;
}

export function tileFromKey(key: number): TileCoord {
  const x = key % SHIFT;
  const rest = (key - x) / SHIFT;
  const y = rest % SHIFT;
  const z = (rest - y) / SHIFT;
  return { z, x, y };
}

export function isValidTile(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < 0 || z > MAX_TILE_ZOOM) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
}

export function parentTile(t: TileCoord, levels = 1): TileCoord {
  const d = Math.min(levels, t.z);
  return { z: t.z - d, x: Math.floor(t.x / 2 ** d), y: Math.floor(t.y / 2 ** d) };
}

export function childTiles(t: TileCoord): [TileCoord, TileCoord, TileCoord, TileCoord] {
  const z = t.z + 1;
  const x = t.x * 2;
  const y = t.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

export function isAncestor(ancestor: TileCoord, t: TileCoord): boolean {
  if (ancestor.z > t.z) return false;
  const d = t.z - ancestor.z;
  return Math.floor(t.x / 2 ** d) === ancestor.x && Math.floor(t.y / 2 ** d) === ancestor.y;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function tileBounds(z: number, x: number, y: number, wrap = 0): Rect {
  const n = 2 ** z;
  return { x0: wrap + x / n, y0: y / n, x1: wrap + (x + 1) / n, y1: (y + 1) / n };
}

export function subRect(ancestor: TileCoord, t: TileCoord): Rect {
  const d = t.z - ancestor.z;
  const n = 2 ** d;
  const ox = t.x - ancestor.x * n;
  const oy = t.y - ancestor.y * n;
  return { x0: ox / n, y0: oy / n, x1: (ox + 1) / n, y1: (oy + 1) / n };
}

export function tmsY(z: number, y: number): number {
  return 2 ** z - 1 - y;
}

export function quadkey(z: number, x: number, y: number): string {
  let key = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    let digit = 0;
    if (x & mask) digit += 1;
    if (y & mask) digit += 2;
    key += digit;
  }
  return key;
}
