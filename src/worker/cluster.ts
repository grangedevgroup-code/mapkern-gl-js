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
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const i of grid.get(cy * n + cx) ?? []) {
          const e = entities[i]!;
          if (e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1) out.push(e);
        }
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
    const cols = Math.ceil(1 / r) + 3;
    const keyOf = (x: number, y: number) => (y + 1) * cols + (x + 1);
    const hash = new Map<number, number[]>();
    points.forEach((p, i) => {
      const key = keyOf(Math.floor(p.x / r), Math.floor(p.y / r));
      const list = hash.get(key);
      if (list) list.push(i);
      else hash.set(key, [i]);
    });
    const visited = new Uint8Array(points.length);
    const out: Entity[] = [];
    const r2 = r * r;
    for (let i = 0; i < points.length; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const p = points[i]!;
      const cx = Math.floor(p.x / r);
      const cy = Math.floor(p.y / r);
      const near: number[] = [];
      let total = p.count;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of hash.get(keyOf(cx + dx, cy + dy)) ?? []) {
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
