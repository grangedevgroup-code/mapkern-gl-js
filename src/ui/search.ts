import { MapkernError } from "../core/errors.ts";
import { Emitter } from "../core/events.ts";
import type { MapkernMap } from "../core/map.ts";
import type { Geocoder, SearchOptions, SearchResult } from "../search/index.ts";
import type { Control, ControlPosition } from "./controls.ts";
import { Marker } from "./marker.ts";

export interface SearchControlOptions {
  geocoder: Geocoder;
  limit?: number;
  marker?: boolean;
  flyTo?: boolean;
  proximity?: boolean;
  kinds?: SearchOptions["kinds"];
  placeholder?: string;
}

export interface SearchResultEvent {
  type: "result";
  result: SearchResult;
}

export interface SearchResultsEvent {
  type: "results";
  query: string;
  results: SearchResult[];
}

export interface SearchErrorEvent {
  type: "error";
  error: unknown;
}

export interface SearchEvents {
  result: SearchResultEvent;
  results: SearchResultsEvent;
  clear: { type: "clear" };
  error: SearchErrorEvent;
}

let instances = 0;

export class SearchControl extends Emitter<SearchEvents> implements Control {
  readonly defaultPosition: ControlPosition = "bottom-right";
  private geocoder: Geocoder;
  private readonly options: SearchControlOptions;
  private readonly id = `mapkern-search-${++instances}`;
  private map: MapkernMap | null = null;
  private element: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private toggle: HTMLButtonElement | null = null;
  private list: HTMLElement | null = null;
  private results: SearchResult[] = [];
  private active = -1;
  private sequence = 0;
  private marker: Marker | null = null;

  constructor(options: SearchControlOptions) {
    super();
    if (!options || typeof options.geocoder?.search !== "function") {
      throw new MapkernError("invalid-option", "SearchControl needs a geocoder with a search method");
    }
    this.options = { ...options };
    this.geocoder = options.geocoder;
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-search";
    const input = doc.createElement("input");
    input.type = "search";
    input.className = "mapkern-search-input";
    input.placeholder = this.options.placeholder ?? map.text("searchPlaceholder");
    input.setAttribute("aria-label", map.text("search"));
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", `${this.id}-list`);
    input.autocomplete = "off";
    input.spellcheck = false;
    input.enterKeyHint = "search";
    input.addEventListener("input", this.onInput);
    input.addEventListener("keydown", this.onKey);
    const list = doc.createElement("ul");
    list.id = `${this.id}-list`;
    list.className = "mapkern-search-results";
    list.setAttribute("role", "listbox");
    const panel = doc.createElement("div");
    panel.className = "mapkern-search-panel";
    panel.append(input, list);
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "mapkern-search-button";
    toggle.title = map.text("search");
    toggle.setAttribute("aria-label", map.text("search"));
    toggle.setAttribute("aria-expanded", "false");
    toggle.appendChild(magnifier(doc));
    toggle.addEventListener("click", () => this.open(!el.classList.contains("mapkern-expanded")));
    el.append(panel, toggle);
    this.element = el;
    this.toggle = toggle;
    this.input = input;
    this.list = list;
    doc.addEventListener("pointerdown", this.outside, true);
    return el;
  }

  open(open = true): this {
    const el = this.element;
    if (!el) return this;
    el.classList.toggle("mapkern-expanded", open);
    el.classList.toggle("mapkern-search-start", el.closest(".mapkern-top-left, .mapkern-bottom-left") !== null);
    el.classList.toggle("mapkern-search-down", el.closest(".mapkern-top-left, .mapkern-top-right") !== null);
    this.toggle?.setAttribute("aria-expanded", String(open));
    if (open) {
      this.input?.focus();
      this.input?.select();
    } else {
      this.show([]);
      if (el.contains(el.ownerDocument.activeElement)) this.input?.blur();
    }
    return this;
  }

  onRemove(map: MapkernMap): void {
    map.getContainer().ownerDocument.removeEventListener("pointerdown", this.outside, true);
    this.marker?.remove();
    this.marker = null;
    this.element?.remove();
    this.element = null;
    this.input = null;
    this.toggle = null;
    this.list = null;
    this.map = null;
  }

  setGeocoder(geocoder: Geocoder): this {
    if (typeof geocoder?.search !== "function") {
      throw new MapkernError("invalid-option", "SearchControl needs a geocoder with a search method");
    }
    this.geocoder = geocoder;
    if (this.input?.value) void this.query(this.input.value);
    return this;
  }

  async query(text: string): Promise<SearchResult[]> {
    const id = ++this.sequence;
    if (this.input && this.input.value !== text) this.input.value = text;
    if (!text.trim()) {
      this.show([]);
      return [];
    }
    const options: SearchOptions = { limit: this.options.limit ?? 6 };
    if (this.options.kinds) options.kinds = this.options.kinds;
    if (this.map && this.options.proximity !== false) options.near = this.map.getCenter();
    let results: SearchResult[];
    try {
      results = await this.geocoder.search(text, options);
    } catch (error) {
      if (id === this.sequence) {
        this.show([], "searchFailed");
        this.emit("error", { type: "error", error });
      }
      return [];
    }
    if (id !== this.sequence) return results;
    this.show(results, "noResults");
    this.emit("results", { type: "results", query: text, results });
    return results;
  }

  select(result: SearchResult): this {
    const map = this.map;
    if (this.input) this.input.value = result.label;
    this.open(false);
    if (map) {
      if (this.options.flyTo !== false) map.flyTo({ center: result.center, zoom: result.zoom });
      if (this.options.marker !== false) {
        this.marker ??= new Marker({ label: result.label });
        this.marker.setLngLat(result.center).addTo(map);
      }
    }
    this.emit("result", { type: "result", result });
    return this;
  }

  clear(): this {
    this.sequence++;
    if (this.input) this.input.value = "";
    this.show([]);
    this.marker?.remove();
    this.emit("clear", { type: "clear" });
    return this;
  }

  private show(results: SearchResult[], notice: "noResults" | "searchFailed" | null = null): void {
    this.results = results;
    this.active = -1;
    const list = this.list;
    const input = this.input;
    if (!list || !input) return;
    const doc = list.ownerDocument;
    list.replaceChildren();
    if (results.length === 0 && notice && this.map) {
      const empty = doc.createElement("li");
      empty.className = "mapkern-search-empty";
      empty.textContent = this.map.text(notice);
      list.appendChild(empty);
    }
    results.forEach((r, i) => {
      const item = doc.createElement("li");
      item.id = `${this.id}-${i}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      const name = doc.createElement("span");
      name.className = "mapkern-search-name";
      name.textContent = r.name;
      item.appendChild(name);
      if (r.context) {
        const context = doc.createElement("span");
        context.className = "mapkern-search-context";
        context.textContent = r.context;
        item.appendChild(context);
      }
      item.addEventListener("pointerdown", (e) => e.preventDefault());
      item.addEventListener("click", () => this.select(r));
      list.appendChild(item);
    });
    const open = list.childElementCount > 0 && input.value.trim() !== "";
    this.element?.classList.toggle("mapkern-open", open);
    if (results.length || notice) this.element?.classList.add("mapkern-expanded");
    input.setAttribute("aria-expanded", String(open && results.length > 0));
    input.removeAttribute("aria-activedescendant");
  }

  private highlight(index: number): void {
    const list = this.list;
    if (!list || this.results.length === 0) return;
    const n = this.results.length;
    this.active = ((index % n) + n) % n;
    list.querySelectorAll("[role=option]").forEach((item, i) => {
      item.setAttribute("aria-selected", String(i === this.active));
    });
    this.input?.setAttribute("aria-activedescendant", `${this.id}-${this.active}`);
    list.querySelector(`#${this.id}-${this.active}`)?.scrollIntoView({ block: "nearest" });
  }

  private readonly onInput = () => {
    void this.query(this.input?.value ?? "");
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.highlight(this.active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.highlight(this.active - 1);
    } else if (e.key === "Enter") {
      const result = this.results[Math.max(0, this.active)];
      if (result) {
        e.preventDefault();
        this.select(result);
      }
    } else if (e.key === "Escape") {
      if (this.results.length) this.show([]);
      else this.open(false);
    }
  };

  private readonly outside = (e: Event) => {
    const el = this.element;
    if (el?.classList.contains("mapkern-expanded") && !el.contains(e.target as Node)) this.open(false);
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function magnifier(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z", "M15.5 15.5L20 20"]) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
