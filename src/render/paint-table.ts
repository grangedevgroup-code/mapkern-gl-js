import type { RGBA } from "../style/color.ts";
import type { Compiled, EvalContext, GeometryType } from "../style/expression.ts";
import type { StateLookup } from "../style/feature-state.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { FeatureTable } from "../worker/packed.ts";
import type { GL } from "./gl.ts";

export interface PaintSlot {
  readonly slot: number;
  readonly composite: boolean;
}

export const NO_SLOT: PaintSlot = { slot: -1, composite: false };

export interface PaintBudget {
  deadline: number;
  behind: boolean;
}

const GEOMETRY: Record<number, GeometryType> = { 0: "Unknown", 1: "Point", 2: "LineString", 3: "Polygon" };
const INCREMENTAL_LIMIT = 256;

interface SlotProperty {
  slot: PaintSlot;
  property: Compiled<unknown>;
}

export class PaintTable {
  texture: WebGLTexture | null = null;
  width = 1;
  stride = 0;
  readonly slots = new Map<string, PaintSlot>();
  private revision = -1;
  private evaluatedZoom = Number.NaN;
  private hasComposite = false;
  private hasState = false;
  private stateVersion = -1;
  private textureSize = [0, 0];
  private data: Float32Array | null = null;
  private byId: Map<number, number[]> | null = null;
  private readonly scratch: Record<string, unknown> = {};
  private readonly feature: {
    properties: Record<string, unknown>;
    id: number | undefined;
    geometryType: GeometryType;
  } = { properties: this.scratch, id: undefined, geometryType: "Unknown" };
  private readonly ctx: EvalContext = { zoom: 0, feature: this.feature };

  get base(): number {
    return this.evaluatedZoom;
  }

  update(
    gl: GL,
    layer: StyleLayer,
    features: FeatureTable,
    names: readonly string[],
    zoom: number,
    budget: PaintBudget,
    states: StateLookup | null = null,
  ): void {
    const layoutChanged = layer.revision !== this.revision;
    if (layoutChanged) {
      this.revision = layer.revision;
      this.slots.clear();
      this.stride = 0;
      this.hasComposite = false;
      this.hasState = false;
      for (const name of names) {
        const c = layer.paintProperty<unknown>(name);
        if (!c.featureDependent) continue;
        const composite = c.zoomDependent;
        this.slots.set(name, { slot: this.stride, composite });
        this.stride += composite ? 2 : 1;
        if (composite) this.hasComposite = true;
        if (c.stateDependent) this.hasState = true;
      }
      this.evaluatedZoom = Number.NaN;
    }
    if (this.stride === 0) {
      this.release(gl);
      return;
    }
    const base = Math.floor(zoom);
    const zoomStale = this.hasComposite && base !== this.evaluatedZoom;
    const stateStale = this.hasState && states !== null && states.version !== this.stateVersion;
    if (!layoutChanged && !zoomStale && !stateStale && this.texture) return;
    const slots = [...this.slots].map(([name, slot]) => ({ slot, property: layer.paintProperty<unknown>(name) }));
    if (!layoutChanged && !zoomStale && stateStale && this.texture && this.data && states) {
      const changed = states.changedSince(this.stateVersion);
      if (changed && changed.size <= INCREMENTAL_LIMIT) {
        const index = this.index(features);
        for (const id of changed) {
          for (const f of index.get(id) ?? []) this.evaluate(features, f, slots, base, states, this.data);
        }
        this.stateVersion = states.version;
        this.upload(gl, this.data, this.textureSize[0]!, this.textureSize[1]!);
        return;
      }
    }
    if (!layoutChanged && this.texture && !stateStale && performance.now() > budget.deadline) {
      budget.behind = true;
      return;
    }
    this.evaluatedZoom = base;
    this.stateVersion = states?.version ?? -1;
    const total = Math.max(1, features.count * this.stride);
    const width = Math.min(total, 2048);
    const height = Math.ceil(total / width);
    const data = new Float32Array(width * height * 4);
    for (let f = 0; f < features.count; f++) this.evaluate(features, f, slots, base, states, data);
    this.data = this.hasState ? data : null;
    this.upload(gl, data, width, height);
    this.width = width;
  }

  slot(name: string): PaintSlot {
    return this.slots.get(name) ?? NO_SLOT;
  }

  get bytes(): number {
    return this.textureSize[0]! * this.textureSize[1]! * 16 + (this.data?.byteLength ?? 0);
  }

  release(gl: GL): void {
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureSize = [0, 0];
    this.data = null;
  }

  private evaluate(
    features: FeatureTable,
    f: number,
    slots: readonly SlotProperty[],
    base: number,
    states: StateLookup | null,
    data: Float32Array,
  ): void {
    const ctx = this.ctx;
    const feature = this.feature;
    features.fill(f, this.scratch);
    const id = features.id(f);
    feature.id = id;
    feature.geometryType = GEOMETRY[features.type(f)] ?? "Unknown";
    ctx.state = id !== undefined ? states?.get(id) : undefined;
    for (const { slot, property } of slots) {
      const at = (f * this.stride + slot.slot) * 4;
      ctx.zoom = base;
      write(data, at, property.evaluate(ctx));
      if (slot.composite) {
        ctx.zoom = base + 1;
        write(data, at + 4, property.evaluate(ctx));
      }
    }
  }

  private index(features: FeatureTable): Map<number, number[]> {
    if (this.byId) return this.byId;
    const index = new Map<number, number[]>();
    for (let f = 0; f < features.count; f++) {
      const id = features.id(f);
      if (id === undefined) continue;
      const list = index.get(id);
      if (list) list.push(f);
      else index.set(id, [f]);
    }
    this.byId = index;
    return index;
  }

  private upload(gl: GL, data: Float32Array, width: number, height: number): void {
    const g = gl.gl;
    if (!this.texture) this.texture = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, this.texture);
    if (this.textureSize[0] !== width || this.textureSize[1] !== height) {
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, width, height, 0, g.RGBA, g.FLOAT, data);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      this.textureSize = [width, height];
    } else {
      g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, width, height, g.RGBA, g.FLOAT, data);
    }
  }
}

function write(data: Float32Array, at: number, value: unknown): void {
  if (typeof value === "number") {
    data[at] = value;
    data[at + 1] = 0;
    data[at + 2] = 0;
    data[at + 3] = 0;
  } else if (Array.isArray(value) && value.length === 4) {
    const c = value as RGBA;
    data[at] = c[0];
    data[at + 1] = c[1];
    data[at + 2] = c[2];
    data[at + 3] = c[3];
  }
}
