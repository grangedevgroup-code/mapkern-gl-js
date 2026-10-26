import type { CoveringTile, Transform } from "../camera/transform.ts";
import { EARTH_CIRCUMFERENCE } from "../geo/mercator.ts";
import type { Rect } from "../geo/tile.ts";
import type { DemSource, DemTile } from "../sources/dem.ts";
import type { Tile } from "../tiles/tile.ts";
import { sampleElevation } from "./dem.ts";

export interface TerrainSlot {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly wrap: number;
  readonly key: string;
  readonly dem: Tile<DemTile> | null;
  readonly rect: Rect;
}

const FULL: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
const MAX_SLOT_ZOOM = 22;

export function highestClearZoom(requested: number, lowest: number, clear: (zoom: number) => boolean): number | null {
  const step = 1 / 32;
  let above = requested;
  while (above > lowest) {
    const z = Math.max(lowest, above - step);
    if (clear(z)) {
      let low = z;
      let high = above;
      for (let i = 0; i < 6; i++) {
        const mid = (low + high) / 2;
        if (clear(mid)) low = mid;
        else high = mid;
      }
      return low;
    }
    above = z;
  }
  return null;
}

export function metersToWorld(meters: number, worldY: number): number {
  return (meters * Math.cosh(Math.PI * (1 - 2 * worldY))) / EARTH_CIRCUMFERENCE;
}

export class Terrain {
  readonly source: DemSource;
  exaggeration: number;
  relief = 0;
  slots: TerrainSlot[] = [];
  private lowest = 0;

  constructor(source: DemSource, exaggeration: number) {
    this.source = source;
    this.exaggeration = exaggeration;
  }

  get ground(): number {
    return this.lowest;
  }

  update(transform: Transform): void {
    const cover = transform.coveringTiles({
      tileSize: 512,
      minZoom: 0,
      maxZoom: Math.min(MAX_SLOT_ZOOM, Math.ceil(transform.maxZoom)),
      round: true,
    });
    const slots: TerrainSlot[] = [];
    let lowest = Number.POSITIVE_INFINITY;
    for (const c of cover) {
      const slot = this.slot(c);
      slots.push(slot);
      const grid = slot.dem?.data?.grid;
      if (grid) lowest = Math.min(lowest, grid.min * this.exaggeration);
    }
    this.slots = slots;
    this.lowest = Number.isFinite(lowest) ? lowest : 0;
  }

  elevationAt(x: number, y: number): number | null {
    const wx = x - Math.floor(x);
    if (y < 0 || y > 1) return null;
    const manager = this.source.manager;
    if (!manager) return null;
    for (let z = manager.tiling.maxZoom; z >= manager.tiling.minZoom; z--) {
      const n = 2 ** z;
      const tx = Math.min(n - 1, Math.floor(wx * n));
      const ty = Math.min(n - 1, Math.floor(y * n));
      const tile = manager.getTile(z, tx, ty);
      if (tile?.isReady && tile.data) {
        const meters = sampleElevation(tile.data.grid, wx * n - tx, y * n - ty);
        return meters === null ? null : meters * this.exaggeration;
      }
    }
    return null;
  }

  surfaceAt(x: number, y: number): number {
    return this.elevationAt(x, y) ?? 0;
  }

  heightAt(x: number, y: number): number {
    return metersToWorld(this.surfaceAt(x, y), y);
  }

  hidden(camera: readonly number[], x: number, y: number, z: number): boolean {
    const dx = camera[0]! - x;
    const dy = camera[1]! - y;
    const dz = camera[2]! - z;
    const steps = 32;
    for (let i = 1; i < steps; i++) {
      const t = (i / steps) ** 2;
      if (t < 0.002) continue;
      const px = x + dx * t;
      const py = y + dy * t;
      if (this.heightAt(px, py) > z + dz * t) return true;
    }
    return false;
  }

  raycast(origin: readonly number[], dir: readonly number[], maxDistance: number): [number, number, number] | null {
    const length = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
    if (!(length > 0)) return null;
    const dx = dir[0]! / length;
    const dy = dir[1]! / length;
    const dz = dir[2]! / length;
    const height = (t: number) => {
      const x = origin[0]! + dx * t;
      const y = origin[1]! + dy * t;
      return origin[2]! + dz * t - metersToWorld(this.surfaceAt(x, y), y);
    };
    let h = height(0);
    if (h <= 0) return null;
    const step = Math.max(maxDistance / 4096, 1e-12);
    const climb = Math.abs(dz) + 3 * Math.max(1, this.exaggeration) * Math.hypot(dx, dy);
    let t = 0;
    while (t < maxDistance) {
      const next = Math.min(maxDistance, t + Math.max(step, h / climb));
      const hn = height(next);
      if (hn <= 0) {
        let lo = t;
        let hi = next;
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (height(mid) > 0) lo = mid;
          else hi = mid;
        }
        return [origin[0]! + dx * hi, origin[1]! + dy * hi, origin[2]! + dz * hi];
      }
      t = next;
      h = hn;
    }
    return null;
  }

  demFor(z: number, x: number, y: number): { tile: Tile<DemTile>; rect: Rect } | null {
    const manager = this.source.manager;
    if (!manager) return null;
    const top = Math.min(z, manager.tiling.maxZoom);
    for (let dz = top; dz >= manager.tiling.minZoom; dz--) {
      const shift = z - dz;
      const tx = Math.floor(x / 2 ** shift);
      const ty = Math.floor(y / 2 ** shift);
      const tile = manager.getTile(dz, tx, ty);
      if (!tile?.isReady || !tile.data) continue;
      if (shift === 0) return { tile, rect: FULL };
      const n = 2 ** shift;
      const x0 = (x - tx * n) / n;
      const y0 = (y - ty * n) / n;
      return { tile, rect: { x0, y0, x1: x0 + 1 / n, y1: y0 + 1 / n } };
    }
    return null;
  }

  private slot(c: CoveringTile): TerrainSlot {
    const key = `${c.z}/${c.x}/${c.y}/${c.wrap}`;
    const found = this.demFor(c.z, c.x, c.y);
    return { ...c, key, dem: found?.tile ?? null, rect: found?.rect ?? FULL };
  }
}
