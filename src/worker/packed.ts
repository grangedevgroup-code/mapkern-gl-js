import type { FeatureType, PropertyValue, VectorFeature } from "../formats/mvt.ts";

export interface PackedColumn {
  key: string;
  dict: PropertyValue[];
  index: Uint32Array;
}

export interface PackedFeatures {
  count: number;
  ids: Float64Array;
  textIds: string[] | null;
  types: Uint8Array;
  sources: Uint32Array;
  columns: PackedColumn[];
}

export class FeatureTableBuilder {
  private readonly keys: readonly string[];
  private ids: number[] = [];
  private textIds: string[] | null = null;
  private types: number[] = [];
  private sources: number[] = [];
  private readonly dicts: Map<string, number>[];
  private readonly values: PropertyValue[][];
  private readonly indexes: number[][];

  constructor(keys: readonly string[]) {
    this.keys = keys;
    this.dicts = keys.map(() => new Map());
    this.values = keys.map(() => []);
    this.indexes = keys.map(() => []);
  }

  add(feature: VectorFeature, source: number): number {
    const i = this.ids.length;
    this.ids.push(feature.id ?? Number.NaN);
    if (feature.textId !== undefined && this.textIds === null) this.textIds = new Array<string>(i).fill("");
    this.textIds?.push(feature.textId ?? "");
    this.types.push(feature.type);
    this.sources.push(source);
    if (this.keys.length > 0) {
      const props = feature.properties();
      for (let k = 0; k < this.keys.length; k++) {
        const v = props[this.keys[k]!];
        if (v === undefined) {
          this.indexes[k]!.push(0);
          continue;
        }
        const dictKey = typeof v === "string" ? `s${v}` : typeof v === "number" ? `n${v}` : `b${v}`;
        let slot = this.dicts[k]!.get(dictKey);
        if (slot === undefined) {
          this.values[k]!.push(v);
          slot = this.values[k]!.length;
          this.dicts[k]!.set(dictKey, slot);
        }
        this.indexes[k]!.push(slot);
      }
    }
    return i;
  }

  get count(): number {
    return this.ids.length;
  }

  finish(): PackedFeatures {
    return {
      count: this.ids.length,
      ids: Float64Array.from(this.ids),
      textIds: this.textIds,
      types: Uint8Array.from(this.types),
      sources: Uint32Array.from(this.sources),
      columns: this.keys.map((key, k) => ({ key, dict: this.values[k]!, index: Uint32Array.from(this.indexes[k]!) })),
    };
  }
}

export function featureTransfers(p: PackedFeatures, out: Transferable[]): void {
  out.push(p.ids.buffer, p.types.buffer, p.sources.buffer);
  for (const c of p.columns) out.push(c.index.buffer);
}

export class FeatureTable {
  readonly count: number;
  private readonly packed: PackedFeatures;

  constructor(packed: PackedFeatures) {
    this.packed = packed;
    this.count = packed.count;
  }

  get keys(): string[] {
    return this.packed.columns.map((c) => c.key);
  }

  id(i: number): number | undefined {
    const v = this.packed.ids[i];
    return v === undefined || Number.isNaN(v) ? undefined : v;
  }

  idValue(i: number): number | string | undefined {
    const text = this.packed.textIds?.[i];
    return text ? text : this.id(i);
  }

  type(i: number): FeatureType {
    return (this.packed.types[i] ?? 0) as FeatureType;
  }

  source(i: number): number {
    return this.packed.sources[i] ?? 0;
  }

  fill(i: number, target: Record<string, unknown>): Record<string, unknown> {
    for (const c of this.packed.columns) {
      const slot = c.index[i] ?? 0;
      if (slot === 0) delete target[c.key];
      else target[c.key] = c.dict[slot - 1];
    }
    return target;
  }

  properties(i: number): Record<string, PropertyValue> {
    const out: Record<string, PropertyValue> = {};
    for (const c of this.packed.columns) {
      const slot = c.index[i] ?? 0;
      if (slot > 0) out[c.key] = c.dict[slot - 1]!;
    }
    return out;
  }

  get bytes(): number {
    let b = this.packed.ids.byteLength + this.packed.types.byteLength + this.packed.sources.byteLength;
    for (const text of this.packed.textIds ?? []) b += 8 + text.length * 2;
    for (const c of this.packed.columns) b += c.index.byteLength + c.dict.length * 16;
    return b;
  }
}

export interface PackedLabels {
  count: number;
  texts: string[];
  icons: string[];
  feature: Uint32Array;
  size: Float32Array;
  priority: Float32Array;
  line: Uint8Array;
  anchorStart: Uint32Array;
  anchors: Float32Array;
  pathStart: Uint32Array;
  paths: Int32Array;
}

export class LabelBuilder {
  private readonly texts: string[] = [];
  private readonly icons: string[] = [];
  private readonly feature: number[] = [];
  private readonly size: number[] = [];
  private readonly priority: number[] = [];
  private readonly line: number[] = [];
  private readonly anchorStart: number[] = [0];
  private readonly anchors: number[] = [];
  private readonly pathStart: number[] = [0];
  private paths = new Int32Array(1024);
  private pathLength = 0;

  get count(): number {
    return this.texts.length;
  }

  add(
    text: string,
    icon: string,
    feature: number,
    size: number,
    priority: number,
    line: boolean,
    anchors: ArrayLike<number>,
    path: Int32Array | null,
  ): void {
    this.texts.push(text);
    this.icons.push(icon);
    this.feature.push(feature);
    this.size.push(size);
    this.priority.push(priority);
    this.line.push(line ? 1 : 0);
    for (let i = 0; i < anchors.length; i++) this.anchors.push(anchors[i]!);
    this.anchorStart.push(this.anchors.length);
    if (path) {
      if (this.pathLength + path.length > this.paths.length) {
        let n = this.paths.length * 2;
        while (n < this.pathLength + path.length) n *= 2;
        const next = new Int32Array(n);
        next.set(this.paths.subarray(0, this.pathLength));
        this.paths = next;
      }
      this.paths.set(path, this.pathLength);
      this.pathLength += path.length;
    }
    this.pathStart.push(this.pathLength);
  }

  finish(): PackedLabels {
    return {
      count: this.texts.length,
      texts: this.texts,
      icons: this.icons,
      feature: Uint32Array.from(this.feature),
      size: Float32Array.from(this.size),
      priority: Float32Array.from(this.priority),
      line: Uint8Array.from(this.line),
      anchorStart: Uint32Array.from(this.anchorStart),
      anchors: Float32Array.from(this.anchors),
      pathStart: Uint32Array.from(this.pathStart),
      paths: this.paths.slice(0, this.pathLength),
    };
  }
}

export function labelTransfers(p: PackedLabels, out: Transferable[]): void {
  out.push(
    p.feature.buffer,
    p.size.buffer,
    p.priority.buffer,
    p.line.buffer,
    p.anchorStart.buffer,
    p.anchors.buffer,
    p.pathStart.buffer,
    p.paths.buffer,
  );
}
