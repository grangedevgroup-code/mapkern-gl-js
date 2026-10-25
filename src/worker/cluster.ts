import type { Compiled } from "../style/expression.ts";
import { compile } from "../style/expression.ts";

export interface ClusterSettings {
  radius: number;
  maxZoom: number;
  minPoints: number;
  properties: Readonly<Record<string, unknown>>;
}

export interface ClusterLeaf {
  readonly x: number;
  readonly y: number;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface Entity {
  readonly x: number;
  readonly y: number;
  readonly count: number;
  readonly cluster: number;
  readonly leaf: number;
  readonly values: readonly unknown[];
}

export interface Cluster {
  readonly id: number;
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
  readonly count: number;
  readonly children: readonly Entity[];
  readonly values: readonly unknown[];
}

interface Aggregate {
  name: string;
  map: Compiled<unknown>;
  reduce: Compiled<unknown>;
}

export class ClusterTree {
  readonly settings: ClusterSettings;
  readonly clusters: Cluster[] = [];
  private readonly levels: Entity[][] = [];
  private readonly cells = new Map<number, Map<number, number[]>>();
  private readonly aggregates: Aggregate[];

  constructor(leaves: readonly ClusterLeaf[], settings: ClusterSettings) {
    this.settings = settings;
    this.aggregates = Object.entries(settings.properties).map(([name, spec]) => aggregate(name, spec));
    const top = settings.maxZoom;
    let current: Entity[] = leaves.map((leaf, i) => ({
      x: leaf.x,
      y: leaf.y,
      count: 1,
      cluster: -1,
      leaf: i,
      values: this.aggregates.map((a) => a.map.evaluate({ zoom: 0, feature: { properties: leaf.properties } })),
    }));
    this.levels[top + 1] = current;
    for (let z = top; z >= 0; z--) {
      current = this.cluster(current, z);
      this.levels[z] = current;
    }
  }

  get names(): readonly string[] {
    return this.aggregates.map((a) => a.name);
  }

  entitiesIn(z: number, x0: number, y0: number, x1: number, y1: number): Entity[] {
    const level = Math.max(0, Math.min(this.settings.maxZoom, Math.floor(z)));
    const entities = this.levels[level] ?? [];
    let grid = this.cells.get(level);
    const n = 2 ** level;
    if (!grid) {
      grid = new Map();
      entities.forEach((e, i) => {
        const key = Math.min(n - 1, Math.floor(e.y * n)) * n + Math.min(n - 1, Math.floor(e.x * n));
        const list = grid!.get(key);
        if (list) list.push(i);
        else grid!.set(key, [i]);
      });
      this.cells.set(level, grid);
    }
    const out: Entity[] = [];
    const cx0 = Math.max(0, Math.floor(x0 * n));
    const cx1 = Math.min(n - 1, Math.floor(x1 * n));
    const cy0 = Math.max(0, Math.floor(y0 * n));
    const cy1 = Math.min(n - 1, Math.floor(y1 * n));
    const take = (list: readonly number[]) => {
      for (const i of list) {
        const e = entities[i]!;
        if (e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1) out.push(e);
      }
    };
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > grid.size) {
      for (const [key, list] of grid) {
        const cy = Math.floor(key / n);
        const cx = key - cy * n;
        if (cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1) take(list);
      }
      return out;
    }
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = grid.get(cy * n + cx);
        if (list) take(list);
      }
    }
    return out;
  }

  properties(id: number): Record<string, unknown> {
    const c = this.clusters[id]!;
    const out: Record<string, unknown> = {
      cluster: true,
      cluster_id: id,
      point_count: c.count,
      point_count_abbreviated: abbreviate(c.count),
    };
    this.aggregates.forEach((a, k) => {
      out[a.name] = c.values[k];
    });
    return out;
  }

  expansionZoom(id: number): number {
    return Math.min(this.clusters[id]!.zoom + 1, this.settings.maxZoom + 1);
  }

  children(id: number): readonly Entity[] {
    return this.clusters[id]!.children;
  }

  leaves(id: number, limit: number, offset: number): number[] {
    const out: number[] = [];
    let skip = offset;
    const stack: Entity[] = [...this.clusters[id]!.children].reverse();
    while (stack.length > 0 && out.length < limit) {
      const e = stack.pop()!;
      if (e.cluster >= 0) {
        const children = this.clusters[e.cluster]!.children;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
        continue;
      }
      if (skip > 0) skip--;
      else out.push(e.leaf);
    }
    return out;
  }

  private cluster(points: readonly Entity[], z: number): Entity[] {
    const r = this.settings.radius / (512 * 2 ** z);
    const size = r * 2;
    const cols = Math.ceil(1 / size) + 3;
    const cells = new CellHash(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      cells.add((Math.floor(p.y / size) + 1) * cols + Math.floor(p.x / size) + 1, i);
    }
    const visited = new Uint8Array(points.length);
    const out: Entity[] = [];
    const r2 = r * r;
    const near: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const p = points[i]!;
      const gx = p.x / size;
      const gy = p.y / size;
      const cx = Math.floor(gx) + 1;
      const cy = Math.floor(gy) + 1;
      const sideX = gx - Math.floor(gx) < 0.5 ? -1 : 1;
      const sideY = gy - Math.floor(gy) < 0.5 ? -1 : 1;
      near.length = 0;
      let total = p.count;
      for (let dy = 0; dy !== sideY * 2; dy += sideY) {
        for (let dx = 0; dx !== sideX * 2; dx += sideX) {
          for (let j = cells.first((cy + dy) * cols + cx + dx); j !== -1; j = cells.next[j]!) {
            if (visited[j]) continue;
            const q = points[j]!;
            const ex = q.x - p.x;
            const ey = q.y - p.y;
            if (ex * ex + ey * ey > r2) continue;
            near.push(j);
            total += q.count;
          }
        }
      }
      if (near.length === 0 || total < this.settings.minPoints) {
        out.push(p);
        for (const j of near) {
          visited[j] = 1;
          out.push(points[j]!);
        }
        continue;
      }
      let sx = p.x * p.count;
      let sy = p.y * p.count;
      const children: Entity[] = [p];
      for (const j of near) {
        visited[j] = 1;
        const q = points[j]!;
        sx += q.x * q.count;
        sy += q.y * q.count;
        children.push(q);
      }
      const id = this.clusters.length;
      const values = this.aggregates.map((a, k) => {
        let acc = children[0]!.values[k];
        for (let c = 1; c < children.length; c++) {
          acc = a.reduce.evaluate({
            zoom: 0,
            accumulated: acc,
            feature: { properties: { [a.name]: children[c]!.values[k] } },
          });
        }
        return acc;
      });
      const cluster: Cluster = { id, zoom: z, x: sx / total, y: sy / total, count: total, children, values };
      this.clusters.push(cluster);
      out.push({ x: cluster.x, y: cluster.y, count: total, cluster: id, leaf: -1, values });
    }
    return out;
  }
}

class CellHash {
  readonly next: Int32Array;
  private readonly keys: Float64Array;
  private readonly heads: Int32Array;
  private readonly mask: number;

  constructor(count: number) {
    let capacity = 16;
    while (capacity < count * 2) capacity *= 2;
    this.mask = capacity - 1;
    this.keys = new Float64Array(capacity).fill(-1);
    this.heads = new Int32Array(capacity).fill(-1);
    this.next = new Int32Array(Math.max(1, count)).fill(-1);
  }

  add(key: number, index: number): void {
    const slot = this.slot(key);
    if (this.keys[slot] === -1) this.keys[slot] = key;
    this.next[index] = this.heads[slot]!;
    this.heads[slot] = index;
  }

  first(key: number): number {
    const slot = this.slot(key);
    return this.keys[slot] === key ? this.heads[slot]! : -1;
  }

  private slot(key: number): number {
    const lo = key % 4294967296;
    const hi = (key - lo) / 4294967296;
    let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b);
    h ^= h >>> 15;
    let slot = h & this.mask;
    for (;;) {
      const k = this.keys[slot]!;
      if (k === -1 || k === key) return slot;
      slot = (slot + 1) & this.mask;
    }
  }
}

function aggregate(name: string, spec: unknown): Aggregate {
  if (!Array.isArray(spec) || spec.length !== 2) {
    throw new Error(`clusterProperties.${name} must be [operator, expression]`);
  }
  const [operator, mapped] = spec as [unknown, unknown];
  const reducer = typeof operator === "string" ? [operator, ["accumulated"], ["get", name]] : operator;
  return {
    name,
    map: compile<unknown>(mapped, "any", null, `clusterProperties.${name}`),
    reduce: compile<unknown>(reducer, "any", null, `clusterProperties.${name}`),
  };
}

export function abbreviate(count: number): number | string {
  if (count >= 10000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${Math.round(count / 100) / 10}k`;
  return count;
}
