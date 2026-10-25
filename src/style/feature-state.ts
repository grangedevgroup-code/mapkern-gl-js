export interface FeatureTarget {
  source: string;
  sourceLayer?: string | undefined;
  id?: number | string | undefined;
}

export interface StateLookup {
  readonly version: number;
  get(id: number): Readonly<Record<string, unknown>> | undefined;
  changedSince(version: number): ReadonlySet<number> | null;
}

const LOG_LIMIT = 512;

class LayerStates implements StateLookup {
  version = 0;
  private readonly states = new Map<number, Record<string, unknown>>();
  private log: { version: number; id: number | null }[] = [];

  get(id: number): Readonly<Record<string, unknown>> | undefined {
    return this.states.get(id);
  }

  set(id: number, values: Record<string, unknown>): void {
    const current = this.states.get(id);
    let changed = false;
    const next = current ?? {};
    for (const [key, value] of Object.entries(values)) {
      if (next[key] !== value) {
        next[key] = value;
        changed = true;
      }
    }
    if (!current) this.states.set(id, next);
    if (changed) this.touch(id);
  }

  remove(id: number | undefined, key: string | undefined): void {
    if (id === undefined) {
      if (this.states.size === 0) return;
      this.states.clear();
      this.touch(null);
      return;
    }
    const current = this.states.get(id);
    if (!current) return;
    if (key === undefined) this.states.delete(id);
    else if (key in current) delete current[key];
    else return;
    this.touch(id);
  }

  changedSince(version: number): ReadonlySet<number> | null {
    if (version === this.version) return new Set();
    const first = this.log[0];
    if (!first || first.version > version + 1) return null;
    const out = new Set<number>();
    for (const entry of this.log) {
      if (entry.version <= version) continue;
      if (entry.id === null) return null;
      out.add(entry.id);
    }
    return out;
  }

  private touch(id: number | null): void {
    this.version++;
    this.log.push({ version: this.version, id });
    if (this.log.length > LOG_LIMIT) this.log = this.log.slice(-LOG_LIMIT / 2);
  }
}

export class FeatureStates {
  private readonly layers = new Map<string, LayerStates>();

  scope(source: string, sourceLayer: string | undefined): StateLookup {
    return this.layer(source, sourceLayer);
  }

  set(source: string, sourceLayer: string | undefined, id: number, values: Record<string, unknown>): void {
    this.layer(source, sourceLayer).set(id, values);
  }

  get(source: string, sourceLayer: string | undefined, id: number): Record<string, unknown> {
    return { ...(this.layers.get(key(source, sourceLayer))?.get(id) ?? {}) };
  }

  remove(source: string, sourceLayer: string | undefined, id: number | undefined, name: string | undefined): void {
    this.layers.get(key(source, sourceLayer))?.remove(id, name);
  }

  dropSource(source: string): void {
    for (const k of [...this.layers.keys()]) {
      if (k.startsWith(`${source}\u0000`)) this.layers.get(k)?.remove(undefined, undefined);
    }
  }

  private layer(source: string, sourceLayer: string | undefined): LayerStates {
    const k = key(source, sourceLayer);
    let states = this.layers.get(k);
    if (!states) {
      states = new LayerStates();
      this.layers.set(k, states);
    }
    return states;
  }
}

function key(source: string, sourceLayer: string | undefined): string {
  return `${source}\u0000${sourceLayer ?? ""}`;
}
