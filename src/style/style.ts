import { errorMessage, MapletError } from "../core/errors.ts";
import type { MapSource } from "../sources/source.ts";
import { StyleLayer } from "./layer.ts";
import type { LayerSpec, SourceSpec, StyleSpec } from "./types.ts";
import { formatIssues, validateLayer, validateSource, validateStyle } from "./validate.ts";

export type SourceFactory = (id: string, spec: SourceSpec) => MapSource;

export interface StyleEvents {
  sourceLoaded(source: MapSource): void;
  sourceFailed(source: MapSource, error: MapletError): void;
  changed(): void;
}

export class Style {
  readonly sources = new Map<string, MapSource>();
  layers: StyleLayer[] = [];
  readonly meta: Omit<StyleSpec, "sources" | "layers">;
  private readonly layerById = new Map<string, StyleLayer>();
  private readonly factory: SourceFactory;
  private readonly events: StyleEvents;
  private readonly controller = new AbortController();
  private pendingSources = 0;

  constructor(spec: StyleSpec, factory: SourceFactory, events: StyleEvents) {
    assertValid(spec);
    this.factory = factory;
    this.events = events;
    const { sources, layers, ...meta } = spec;
    this.meta = structuredClone(meta);
    for (const [id, source] of Object.entries(sources)) this.createSource(id, cloneSpec(source));
    for (const layer of layers) this.insertLayer(new StyleLayer(layer), undefined);
  }

  get loaded(): boolean {
    return this.pendingSources === 0;
  }

  getLayer(id: string): StyleLayer | undefined {
    return this.layerById.get(id);
  }

  addSource(id: string, spec: SourceSpec): void {
    if (this.sources.has(id)) throw new MapletError("invalid-option", `A source with id "${id}" already exists`);
    const issues = validateSource(id, spec);
    if (issues.length > 0) throw new MapletError("invalid-style", formatIssues(issues), { issues });
    this.createSource(id, cloneSpec(spec));
    this.events.changed();
  }

  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) throw new MapletError("invalid-option", `There is no source with id "${id}"`);
    if (this.meta.terrain?.source === id) {
      throw new MapletError("invalid-option", `Source "${id}" is used for terrain`, { terrain: true });
    }
    const users = this.layers.filter((l) => l.source === id).map((l) => l.id);
    if (users.length > 0) {
      throw new MapletError("invalid-option", `Source "${id}" is still used by layers: ${users.join(", ")}`, {
        layers: users,
      });
    }
    source.destroy();
    this.sources.delete(id);
    this.events.changed();
  }

  addLayer(spec: LayerSpec, beforeId?: string): StyleLayer {
    if (this.layerById.has(spec.id))
      throw new MapletError("invalid-option", `A layer with id "${spec.id}" already exists`);
    if (beforeId !== undefined && !this.layerById.has(beforeId)) {
      throw new MapletError("invalid-option", `There is no layer with id "${beforeId}" to insert before`);
    }
    const specs: Record<string, SourceSpec> = {};
    for (const [id, source] of this.sources) specs[id] = source.spec;
    const issues = validateLayer(spec, `layer ${spec.id}`, specs);
    if (issues.length > 0) throw new MapletError("invalid-style", formatIssues(issues), { issues });
    const layer = new StyleLayer(spec);
    this.insertLayer(layer, beforeId);
    this.events.changed();
    return layer;
  }

  removeLayer(id: string): void {
    const layer = this.layerById.get(id);
    if (!layer) throw new MapletError("invalid-option", `There is no layer with id "${id}"`);
    this.layers = this.layers.filter((l) => l !== layer);
    this.layerById.delete(id);
    this.events.changed();
  }

  moveLayer(id: string, beforeId?: string): void {
    const layer = this.layerById.get(id);
    if (!layer) throw new MapletError("invalid-option", `There is no layer with id "${id}"`);
    if (beforeId !== undefined && !this.layerById.has(beforeId)) {
      throw new MapletError("invalid-option", `There is no layer with id "${beforeId}" to move before`);
    }
    if (beforeId === id) return;
    this.layers = this.layers.filter((l) => l !== layer);
    const index = beforeId === undefined ? this.layers.length : this.layers.findIndex((l) => l.id === beforeId);
    this.layers.splice(index, 0, layer);
    this.events.changed();
  }

  serialize(): StyleSpec {
    const sources: Record<string, SourceSpec> = {};
    for (const [id, source] of this.sources) sources[id] = cloneSpec(source.spec);
    return { ...structuredClone(this.meta), sources, layers: this.layers.map((l) => l.serialize()) };
  }

  destroy(): void {
    this.controller.abort();
    for (const source of this.sources.values()) source.destroy();
    this.sources.clear();
    this.layers = [];
    this.layerById.clear();
  }

  private insertLayer(layer: StyleLayer, beforeId: string | undefined): void {
    const index = beforeId === undefined ? this.layers.length : this.layers.findIndex((l) => l.id === beforeId);
    this.layers.splice(index < 0 ? this.layers.length : index, 0, layer);
    this.layerById.set(layer.id, layer);
  }

  private createSource(id: string, spec: SourceSpec): void {
    const source = this.factory(id, spec);
    this.sources.set(id, source);
    this.pendingSources++;
    source
      .load(this.controller.signal)
      .then(() => {
        if (this.controller.signal.aborted || this.sources.get(id) !== source) return;
        this.events.sourceLoaded(source);
      })
      .catch((error: unknown) => {
        if (this.controller.signal.aborted || this.sources.get(id) !== source) return;
        const err =
          error instanceof MapletError
            ? error
            : new MapletError(
                "source-error",
                `Source "${id}" failed to load: ${errorMessage(error)}`,
                { sourceId: id },
                error,
              );
        this.events.sourceFailed(source, err);
      })
      .finally(() => {
        this.pendingSources--;
        if (!this.controller.signal.aborted) this.events.changed();
      });
  }
}

export function assertValid(spec: unknown): asserts spec is StyleSpec {
  const issues = validateStyle(spec);
  if (issues.length > 0) {
    throw new MapletError("invalid-style", `The style is not valid:\n${formatIssues(issues)}`, { issues });
  }
}

function cloneSpec(spec: SourceSpec): SourceSpec {
  if (spec.type === "canvas" && typeof spec.canvas !== "string") {
    const { canvas, ...rest } = spec;
    return { ...structuredClone(rest), canvas };
  }
  return structuredClone(spec);
}
