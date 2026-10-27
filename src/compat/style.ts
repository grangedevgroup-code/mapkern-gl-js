import { deepClone } from "../core/clone.ts";

export type Json = Record<string, unknown>;

export interface CustomLayerInterface {
  id: string;
  type: "custom";
  renderingMode?: "2d" | "3d";
  onAdd?(map: unknown, gl: WebGL2RenderingContext): void;
  onRemove?(map: unknown, gl: WebGL2RenderingContext): void;
  prerender?(gl: WebGL2RenderingContext, ...args: unknown[]): void;
  render(gl: WebGL2RenderingContext, ...args: unknown[]): void;
}

export type ShadowLayer = Json & { id: string; type: string };

export function isCustomLayer(layer: unknown): layer is CustomLayerInterface {
  return (
    typeof layer === "object" &&
    layer !== null &&
    (layer as { type?: unknown }).type === "custom" &&
    typeof (layer as { render?: unknown }).render === "function"
  );
}

export function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneLayer(layer: ShadowLayer): ShadowLayer {
  return isCustomLayer(layer) ? layer : deepClone(layer);
}

export function cloneSource(source: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      key === "data" || key === "canvas" || value === null || typeof value !== "object" ? value : deepClone(value);
  }
  return out;
}

export class ShadowStyle {
  root: Json;
  readonly sources = new Map<string, Json>();
  layers: ShadowLayer[] = [];

  constructor(style: Json) {
    const { sources, layers, ...root } = style;
    this.root = deepClone(root);
    this.root.version = 8;
    if (isJson(sources)) {
      for (const [id, source] of Object.entries(sources)) if (isJson(source)) this.sources.set(id, cloneSource(source));
    }
    if (Array.isArray(layers)) {
      const seen = new Set<string>();
      for (const layer of layers) {
        if (!isJson(layer) || typeof layer.id !== "string" || seen.has(layer.id)) continue;
        seen.add(layer.id);
        this.layers.push(cloneLayer(layer as ShadowLayer));
      }
    }
  }

  layer(id: string): ShadowLayer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  indexOf(id: string): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  insert(layer: ShadowLayer, beforeId?: string): void {
    const index = beforeId === undefined ? -1 : this.indexOf(beforeId);
    if (index < 0) this.layers.push(layer);
    else this.layers.splice(index, 0, layer);
  }

  remove(id: string): ShadowLayer | undefined {
    const index = this.indexOf(id);
    if (index < 0) return undefined;
    return this.layers.splice(index, 1)[0];
  }

  move(id: string, beforeId?: string): boolean {
    if (id === beforeId) return false;
    const layer = this.remove(id);
    if (!layer) return false;
    this.insert(layer, beforeId);
    return true;
  }

  serialize(): Json {
    const sources: Json = {};
    for (const [id, source] of this.sources) sources[id] = cloneSource(source);
    return {
      ...deepClone(this.root),
      sources,
      layers: this.layers.filter((l) => !isCustomLayer(l)).map((l) => deepClone(l)),
    };
  }
}

export function layerView(layer: ShadowLayer): Json {
  if (isCustomLayer(layer)) {
    return { id: layer.id, type: "custom", renderingMode: layer.renderingMode ?? "2d", implementation: layer };
  }
  const view = deepClone(layer) as Json;
  view.sourceLayer = layer["source-layer"];
  view.minzoom = layer.minzoom ?? 0;
  view.maxzoom = layer.maxzoom ?? 24;
  view.visibility = (isJson(layer.layout) ? layer.layout.visibility : undefined) ?? "visible";
  view.paint ??= {};
  view.layout ??= {};
  view.serialize = () => deepClone(layer);
  return view;
}
