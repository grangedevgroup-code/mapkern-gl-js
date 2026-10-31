import { MapkernError } from "../core/errors.ts";
import { Emitter } from "../core/events.ts";
import type { MapkernMap, MapPointerEvent } from "../core/map.ts";
import type { RouteManeuver, RouteStep } from "../route/guidance.ts";
import type { Route, RouteProfile } from "../route/router.ts";
import type { Directions } from "../route/service.ts";
import type { Geocoder, SearchResult } from "../search/index.ts";
import type { Control, ControlPosition } from "./controls.ts";
import { Marker } from "./marker.ts";

export interface DirectionsControlOptions {
  directions: Directions;
  geocoder?: Geocoder;
  profile?: RouteProfile;
  profiles?: RouteProfile[];
  fitRoute?: boolean;
  routeColor?: string;
}

export interface DirectionsPlace {
  center: [number, number];
  label: string;
}

export interface DirectionsEvents {
  route: { type: "route"; route: Route; profile: RouteProfile };
  clear: { type: "clear" };
  error: { type: "error"; error: unknown };
  open: { type: "open" };
  close: { type: "close" };
}

type End = "from" | "to";

const SOURCE = "mapkern-route";
const LAYERS = ["mapkern-route-casing", "mapkern-route-line"];
const SVG_NS = "http://www.w3.org/2000/svg";

export class DirectionsControl extends Emitter<DirectionsEvents> implements Control {
  readonly defaultPosition: ControlPosition = "bottom-right";
  private readonly options: DirectionsControlOptions;
  private map: MapkernMap | null = null;
  private button: HTMLButtonElement | null = null;
  private element: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private inputs: Record<End, HTMLInputElement> | null = null;
  private list: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private summary: HTMLElement | null = null;
  private steps: HTMLElement | null = null;
  private modes: Map<RouteProfile, HTMLButtonElement> = new Map();
  private places: Record<End, DirectionsPlace | null> = { from: null, to: null };
  private markers: Record<End, Marker | null> = { from: null, to: null };
  private focus: End = "from";
  private suggestions: { label: string; detail?: string; pick: () => void }[] = [];
  private profile: RouteProfile;
  private current: Route | null = null;
  private request: AbortController | null = null;
  private lookup = 0;

  constructor(options: DirectionsControlOptions) {
    super();
    if (!options || typeof options.directions?.route !== "function") {
      throw new MapkernError("invalid-option", "DirectionsControl needs a directions service with a route method");
    }
    this.options = { ...options };
    this.profile = options.profile ?? "car";
  }

  onAdd(map: MapkernMap): HTMLElement {
    const doc = map.getContainer().ownerDocument;
    this.map = map;
    const el = doc.createElement("div");
    el.className = "mapkern-control mapkern-directions";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "mapkern-directions-button";
    button.title = map.text("directions");
    button.setAttribute("aria-label", map.text("directions"));
    button.setAttribute("aria-expanded", "false");
    button.appendChild(icon(doc, ["M12 3l9 9-9 9-9-9z", "M9.5 13.5v-2.5h4.5", "M12.5 9l2 2-2 2"]));
    button.addEventListener("click", () => this.open(!this.isOpen()));
    el.appendChild(button);
    this.element = el;
    this.button = button;
    this.panel = this.buildPanel(doc, map);
    map.getContainer().appendChild(this.panel);
    map.on("click", this.onMapClick);
    map.on("styleload", this.onStyle);
    return el;
  }

  onRemove(map: MapkernMap): void {
    this.request?.abort();
    map.off("click", this.onMapClick);
    map.off("styleload", this.onStyle);
    this.removeLine();
    this.markers.from?.remove();
    this.markers.to?.remove();
    this.panel?.remove();
    this.element?.remove();
    this.panel = null;
    this.element = null;
    this.map = null;
  }

  isOpen(): boolean {
    return this.panel?.classList.contains("mapkern-expanded") ?? false;
  }

  open(open = true): this {
    const panel = this.panel;
    if (!panel || open === this.isOpen()) return this;
    panel.classList.toggle("mapkern-expanded", open);
    this.button?.setAttribute("aria-expanded", String(open));
    this.button?.classList.toggle("mapkern-active", open);
    if (open) {
      const empty: End = this.places.from ? "to" : "from";
      this.inputs?.[this.places.to && !this.places.from ? "from" : empty].focus();
      this.emit("open", { type: "open" });
    } else {
      this.show([]);
      this.emit("close", { type: "close" });
    }
    return this;
  }

  setProfile(profile: RouteProfile): this {
    this.profile = profile;
    for (const [p, b] of this.modes) b.setAttribute("aria-checked", String(p === profile));
    void this.update();
    return this;
  }

  getProfile(): RouteProfile {
    return this.profile;
  }

  setOrigin(place: DirectionsPlace | null): this {
    return this.set("from", place);
  }

  setDestination(place: DirectionsPlace | null): this {
    return this.set("to", place);
  }

  getRoute(): Route | null {
    return this.current;
  }

  clear(): this {
    this.request?.abort();
    this.places = { from: null, to: null };
    for (const end of ["from", "to"] as const) {
      this.markers[end]?.remove();
      if (this.inputs) this.inputs[end].value = "";
    }
    this.current = null;
    this.removeLine();
    this.render(null);
    this.emit("clear", { type: "clear" });
    return this;
  }

  private set(end: End, place: DirectionsPlace | null): this {
    this.places[end] = place;
    if (this.inputs) this.inputs[end].value = place?.label ?? "";
    const map = this.map;
    if (place && map) {
      this.markers[end] ??= new Marker({
        color: end === "from" ? "#1a7f37" : "#d1242f",
        scale: end === "from" ? 0.8 : 1,
        label: place.label,
        className: `mapkern-directions-${end}`,
      });
      this.markers[end]!.setLngLat(place.center).addTo(map);
    } else {
      this.markers[end]?.remove();
    }
    void this.update();
    return this;
  }

  private async update(): Promise<void> {
    this.request?.abort();
    const { from, to } = this.places;
    if (!from || !to) {
      this.current = null;
      this.removeLine();
      this.render(null);
      return;
    }
    const controller = new AbortController();
    this.request = controller;
    this.render(null, "findingRoute");
    let route: Route | null;
    try {
      route = await this.options.directions.route([from.center, to.center], {
        profile: this.profile,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.render(null, "routeFailed");
      this.emit("error", { type: "error", error });
      return;
    }
    if (controller.signal.aborted) return;
    this.current = route;
    if (!route) {
      this.removeLine();
      this.render(null, "noRoute");
      return;
    }
    this.drawLine(route);
    this.render(route);
    if (this.options.fitRoute !== false) this.fit(route);
    this.emit("route", { type: "route", route, profile: this.profile });
  }

  private fit(route: Route): void {
    const map = this.map;
    if (!map || route.geometry.length < 2) return;
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const [x, y] of route.geometry) {
      w = Math.min(w, x);
      s = Math.min(s, y);
      e = Math.max(e, x);
      n = Math.max(n, y);
    }
    const panel = this.panel;
    const wide = panel && map.getContainer().clientWidth > 640;
    const pad = 48;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        padding: {
          top: !wide && this.isOpen() && panel ? panel.offsetHeight + pad : pad,
          bottom: pad,
          right: pad,
          left: wide && this.isOpen() && panel ? panel.offsetWidth + pad + 16 : pad,
        },
        maxZoom: 17,
      },
    );
  }

  private drawLine(route: Route): void {
    const map = this.map;
    if (!map || !map.isStyleLoaded()) return;
    const data = {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "LineString" as const, coordinates: route.geometry },
    };
    const source = map.getSource(SOURCE) as { setData?: (d: unknown) => void } | undefined;
    if (source?.setData) {
      source.setData(data);
      return;
    }
    map.addSource(SOURCE, { type: "geojson", data });
    const width = (base: number) => ["interpolate", ["linear"], ["zoom"], 8, base * 0.6, 14, base, 18, base * 2.2];
    map.addLayer({
      id: LAYERS[0]!,
      type: "line",
      source: SOURCE,
      layout: { cap: "round", join: "round" },
      paint: { color: "#ffffff", width: width(9) as never },
    } as never);
    map.addLayer({
      id: LAYERS[1]!,
      type: "line",
      source: SOURCE,
      layout: { cap: "round", join: "round" },
      paint: { color: this.options.routeColor ?? "#2f6fdb", width: width(6) as never },
    } as never);
  }

  private removeLine(): void {
    const map = this.map;
    if (!map || !map.isStyleLoaded()) return;
    for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  }

  private readonly onStyle = () => {
    if (this.current) this.drawLine(this.current);
  };

  private readonly onMapClick = (event: MapPointerEvent) => {
    if (!this.isOpen() || !event.lngLat) return;
    const center: [number, number] = [event.lngLat[0], event.lngLat[1]];
    const end = this.focus;
    const label = `${center[1].toFixed(5)}, ${center[0].toFixed(5)}`;
    this.set(end, { center, label });
    if (end === "from" && !this.places.to) this.focus = "to";
    void this.name(end, center);
  };

  private async name(end: End, center: [number, number]): Promise<void> {
    const geocoder = this.options.geocoder;
    if (!geocoder?.reverse) return;
    try {
      const found = await geocoder.reverse(center, { limit: 1 });
      const place = this.places[end];
      const hit = found[0];
      if (!hit || !place || place.center !== center) return;
      place.label = hit.label;
      if (this.inputs) this.inputs[end].value = hit.label;
    } catch {}
  }

  private async suggest(end: End, text: string): Promise<void> {
    const id = ++this.lookup;
    const items: typeof this.suggestions = [];
    if (end === "from" && !text.trim() && typeof navigator !== "undefined" && navigator.geolocation) {
      items.push({ label: this.map?.text("yourLocation") ?? "Your location", pick: () => this.locate() });
    }
    const geocoder = this.options.geocoder;
    if (geocoder && text.trim()) {
      try {
        const results: SearchResult[] = await geocoder.search(text, {
          limit: 6,
          ...(this.map ? { near: this.map.getCenter() } : {}),
        });
        if (id !== this.lookup) return;
        for (const r of results) {
          items.push({
            label: r.name,
            ...(r.context ? { detail: r.context } : {}),
            pick: () => this.set(end, { center: r.center, label: r.label }),
          });
        }
      } catch {}
    }
    if (id === this.lookup) this.show(items);
  }

  private locate(): void {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        this.set("from", {
          center: [p.coords.longitude, p.coords.latitude],
          label: this.map?.text("yourLocation") ?? "",
        }),
      () => this.render(this.current, "locationUnavailable"),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  private show(items: typeof this.suggestions): void {
    this.suggestions = items;
    const list = this.list;
    if (!list) return;
    const doc = list.ownerDocument;
    list.replaceChildren();
    for (const item of items) {
      const li = doc.createElement("li");
      li.setAttribute("role", "option");
      const name = doc.createElement("span");
      name.className = "mapkern-search-name";
      name.textContent = item.label;
      li.appendChild(name);
      if (item.detail) {
        const detail = doc.createElement("span");
        detail.className = "mapkern-search-context";
        detail.textContent = item.detail;
        li.appendChild(detail);
      }
      li.addEventListener("pointerdown", (e) => e.preventDefault());
      li.addEventListener("click", () => {
        this.show([]);
        item.pick();
      });
      list.appendChild(li);
    }
    list.hidden = items.length === 0;
  }

  private render(route: Route | null, notice: Parameters<MapkernMap["text"]>[0] | null = null): void {
    const map = this.map;
    if (!map || !this.status || !this.summary || !this.steps) return;
    this.status.textContent = notice ? map.text(notice) : "";
    this.status.hidden = !notice;
    this.summary.replaceChildren();
    this.steps.replaceChildren();
    this.summary.hidden = !route;
    this.steps.hidden = !route;
    if (!route) return;
    const doc = this.summary.ownerDocument;
    const time = doc.createElement("strong");
    time.textContent = formatDuration(route.duration);
    const dist = doc.createElement("span");
    dist.textContent = formatDistance(route.distance);
    this.summary.append(time, dist);
    const via = mainRoad(route);
    if (via) {
      const v = doc.createElement("span");
      v.className = "mapkern-directions-via";
      v.textContent = `via ${via}`;
      this.summary.appendChild(v);
    }
    for (const leg of route.legs) {
      for (const step of leg.steps) {
        const li = doc.createElement("li");
        li.appendChild(maneuverIcon(doc, step.maneuver));
        const text = doc.createElement("span");
        text.className = "mapkern-directions-text";
        text.textContent = step.instruction;
        li.appendChild(text);
        if (step.distance > 0) {
          const d = doc.createElement("span");
          d.className = "mapkern-directions-distance";
          d.textContent = formatDistance(step.distance);
          li.appendChild(d);
        }
        li.tabIndex = 0;
        const go = () => map.flyTo({ center: step.maneuver.location, zoom: 17 });
        li.addEventListener("click", go);
        li.addEventListener("keydown", (e) => {
          if (e.key === "Enter") go();
        });
        this.steps.appendChild(li);
      }
    }
  }

  private buildPanel(doc: Document, map: MapkernMap): HTMLElement {
    const panel = doc.createElement("div");
    panel.className = "mapkern-control mapkern-directions-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", map.text("directions"));
    const head = doc.createElement("div");
    head.className = "mapkern-directions-head";
    const modes = doc.createElement("div");
    modes.className = "mapkern-directions-modes";
    modes.setAttribute("role", "radiogroup");
    const names: Record<RouteProfile, Parameters<MapkernMap["text"]>[0]> = {
      car: "byCar",
      bike: "byBike",
      foot: "onFoot",
    };
    for (const p of this.options.profiles ?? (["car", "bike", "foot"] as RouteProfile[])) {
      const b = doc.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(p === this.profile));
      b.title = map.text(names[p]);
      b.setAttribute("aria-label", map.text(names[p]));
      b.appendChild(icon(doc, PROFILE_ICONS[p]));
      b.addEventListener("click", () => this.setProfile(p));
      this.modes.set(p, b);
      modes.appendChild(b);
    }
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "mapkern-directions-close";
    close.title = map.text("closeDirections");
    close.setAttribute("aria-label", map.text("closeDirections"));
    close.appendChild(icon(doc, ["M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5"]));
    close.addEventListener("click", () => this.open(false));
    head.append(modes, close);
    const fields = doc.createElement("div");
    fields.className = "mapkern-directions-fields";
    const make = (end: End) => {
      const row = doc.createElement("label");
      row.className = `mapkern-directions-field mapkern-directions-${end}-field`;
      const dot = doc.createElement("span");
      dot.className = "mapkern-directions-dot";
      dot.setAttribute("aria-hidden", "true");
      const input = doc.createElement("input");
      input.type = "search";
      input.className = "mapkern-search-input";
      input.placeholder = map.text(end === "from" ? "chooseStart" : "chooseDestination");
      input.setAttribute("aria-label", map.text(end === "from" ? "routeFrom" : "routeTo"));
      input.autocomplete = "off";
      input.spellcheck = false;
      input.addEventListener("focus", () => {
        this.focus = end;
        void this.suggest(end, input.value === this.places[end]?.label ? "" : input.value);
      });
      input.addEventListener("input", () => {
        if (!input.value && this.places[end]) this.set(end, null);
        void this.suggest(end, input.value);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && this.suggestions[0]) {
          e.preventDefault();
          const first = this.suggestions.find((s) => s.detail !== undefined) ?? this.suggestions[0];
          this.show([]);
          first.pick();
        } else if (e.key === "Escape") {
          this.show([]);
        }
      });
      input.addEventListener("blur", () => setTimeout(() => this.show([]), 0));
      row.append(dot, input);
      return { row, input };
    };
    const from = make("from");
    const to = make("to");
    const swap = doc.createElement("button");
    swap.type = "button";
    swap.className = "mapkern-directions-swap";
    swap.title = map.text("swapEnds");
    swap.setAttribute("aria-label", map.text("swapEnds"));
    swap.appendChild(icon(doc, ["M8 4v16M8 4l-3.5 3.5M8 4l3.5 3.5", "M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"]));
    swap.addEventListener("click", () => {
      const { from: a, to: b } = this.places;
      this.places = { from: null, to: null };
      this.set("from", b);
      this.set("to", a);
    });
    fields.append(from.row, to.row, swap);
    this.inputs = { from: from.input, to: to.input };
    const list = doc.createElement("ul");
    list.className = "mapkern-search-results mapkern-directions-suggestions";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    const status = doc.createElement("p");
    status.className = "mapkern-directions-status";
    status.setAttribute("role", "status");
    status.hidden = true;
    const summary = doc.createElement("div");
    summary.className = "mapkern-directions-summary";
    summary.hidden = true;
    const steps = doc.createElement("ol");
    steps.className = "mapkern-directions-steps";
    steps.hidden = true;
    panel.append(head, fields, list, status, summary, steps);
    this.list = list;
    this.status = status;
    this.summary = summary;
    this.steps = steps;
    return panel;
  }
}

const PROFILE_ICONS: Record<RouteProfile, string[]> = {
  car: ["M5 16v-4l2-5h10l2 5v4z", "M5 12h14", "M7 16v2M17 16v2", "M8 14h.01M16 14h.01"],
  bike: [
    "M6 17.5a3 3 0 1 0 0-.01z",
    "M18 17.5a3 3 0 1 0 0-.01z",
    "M6 17.5l4-7h5l3 7M10 10.5L8.5 7H7M15 10.5l-1.5-3H16",
  ],
  foot: ["M13 4.5a1.5 1.5 0 1 0 0-.01z", "M10 21l2-6 2.5 2V21M9 12l2-4.5 3 1 1.5 3.5 2 .5M11 7.5l-1 4.5"],
};

function icon(doc: Document, paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function maneuverIcon(doc: Document, m: RouteManeuver): SVGSVGElement {
  const svg = icon(doc, maneuverPaths(m));
  svg.classList.add("mapkern-directions-icon");
  return svg;
}

function maneuverPaths(m: RouteManeuver): string[] {
  if (m.type === "depart") return ["M12 20V5M12 5l-4 4M12 5l4 4"];
  if (m.type === "arrive") return ["M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z", "M12 8.5a2 2 0 1 0 0 .01z"];
  if (m.type === "roundabout") return ["M12 14a3 3 0 1 0 0-.01z", "M12 21v-4M12 11V4M12 4l-3 3M12 4l3 3"];
  switch (m.modifier) {
    case "uturn":
      return ["M8 20V9a4 4 0 0 1 8 0v7M16 16l-3-3M16 16l3-3"];
    case "sharp left":
      return ["M16 20V9L7 17M7 17v-5M7 17h5"];
    case "left":
      return ["M16 20v-9a2 2 0 0 0-2-2H6M6 9l4-4M6 9l4 4"];
    case "slight left":
      return ["M15 20v-7L9 6M9 6v5M9 6h5"];
    case "sharp right":
      return ["M8 20V9l9 8M17 17v-5M17 17h-5"];
    case "right":
      return ["M8 20v-9a2 2 0 0 1 2-2h8M18 9l-4-4M18 9l-4 4"];
    case "slight right":
      return ["M9 20v-7l6-7M15 6v5M15 6h-5"];
    default:
      return ["M12 20V5M12 5l-4 4M12 5l4 4"];
  }
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatDistance(meters: number): string {
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 9500 ? 1 : 0)} km`;
}

function mainRoad(route: Route): string {
  let best: RouteStep | null = null;
  for (const leg of route.legs)
    for (const s of leg.steps) if ((s.name || s.ref) && (!best || s.distance > best.distance)) best = s;
  if (!best) return "";
  const step = best as RouteStep;
  return step.ref ? step.ref.replace(/^([A-Z]{1,4}) (\d+[A-Z]?)$/, "$1-$2") : step.name;
}
