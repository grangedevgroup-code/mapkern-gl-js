import type { RGBA } from "../style/color.ts";
import type { EvalContext, GeometryType } from "../style/expression.ts";
import type { StyleLayer } from "../style/layer.ts";
import type { FeatureRecord } from "../worker/vector-task.ts";
import type { GL } from "./gl.ts";

export interface PaintSlot {
  readonly slot: number;
  readonly composite: boolean;
}

export const NO_SLOT: PaintSlot = { slot: -1, composite: false };

const GEOMETRY: Record<number, GeometryType> = { 0: "Unknown", 1: "Point", 2: "LineString", 3: "Polygon" };

export class PaintTable {
  texture: WebGLTexture | null = null;
  width = 1;
  stride = 0;
  readonly slots = new Map<string, PaintSlot>();
  private revision = -1;
  private evaluatedZoom = Number.NaN;
  private hasComposite = false;
  private textureSize = [0, 0];

  update(gl: GL, layer: StyleLayer, features: readonly FeatureRecord[], names: readonly string[], zoom: number): void {
    const layoutChanged = layer.revision !== this.revision;
    if (layoutChanged) {
      this.revision = layer.revision;
      this.slots.clear();
      this.stride = 0;
      this.hasComposite = false;
      for (const name of names) {
        const c = layer.paintProperty<unknown>(name);
        if (!c.featureDependent) continue;
        const composite = c.zoomDependent;
        this.slots.set(name, { slot: this.stride, composite });
        this.stride += composite ? 2 : 1;
        if (composite) this.hasComposite = true;
      }
      this.evaluatedZoom = Number.NaN;
    }
    if (this.stride === 0) {
      this.release(gl);
      return;
    }
    const base = Math.floor(zoom);
    if (!layoutChanged && (!this.hasComposite || base === this.evaluatedZoom) && this.texture) return;
    this.evaluatedZoom = base;
    const total = Math.max(1, features.length * this.stride);
    const width = Math.min(total, 2048);
    const height = Math.ceil(total / width);
    const data = new Float32Array(width * height * 4);
    const ctx: EvalContext = { zoom: base };
    const feature = {
      properties: {} as Readonly<Record<string, unknown>>,
      id: undefined as number | undefined,
      geometryType: "Unknown" as GeometryType,
    };
    ctx.feature = feature;
    for (const [name, slot] of this.slots) {
      const c = layer.paintProperty<unknown>(name);
      for (let f = 0; f < features.length; f++) {
        const record = features[f]!;
        feature.properties = record.props;
        feature.id = record.id;
        feature.geometryType = GEOMETRY[record.type] ?? "Unknown";
        const at = (f * this.stride + slot.slot) * 4;
        ctx.zoom = base;
        write(data, at, c.evaluate(ctx));
        if (slot.composite) {
          ctx.zoom = base + 1;
          write(data, at + 4, c.evaluate(ctx));
        }
      }
    }
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
    this.width = width;
  }

  slot(name: string): PaintSlot {
    return this.slots.get(name) ?? NO_SLOT;
  }

  get bytes(): number {
    return this.textureSize[0]! * this.textureSize[1]! * 16;
  }

  release(gl: GL): void {
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureSize = [0, 0];
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
