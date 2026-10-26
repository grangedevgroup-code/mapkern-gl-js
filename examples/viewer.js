import * as mapkern from "../dist/mapkern.js";

export { mapkern };

export const BASEMAPS = [
  { name: "Map", style: "https://tiles.openfreemap.org/styles/liberty" },
  {
    name: "Satellite",
    style: {
      version: 1,
      sources: {
        imagery: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          maxZoom: 19,
          attribution: "Esri, Vantor, Earthstar Geographics, and the GIS User Community",
        },
      },
      layers: [{ id: "imagery", type: "raster", source: "imagery" }],
    },
  },
];

export const TERRAIN = {
  type: "dem",
  tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"],
  tileSize: 512,
  maxZoom: 12,
  encoding: "terrarium",
  attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
};

export const SEARCH = ["world", "seattle", "olympia"].map(
  (name) => new URL(`../data/${name}.search`, import.meta.url).href,
);

export function lazyGeocoder(sources) {
  const list = Array.isArray(sources) ? sources : [sources];
  let loading = null;
  const set = () => {
    loading ??= mapkern.SearchIndexSet.load(list).catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  };
  return {
    search: async (query, options) => (await set()).search(query, options),
    reverse: async (position, options) => (await set()).reverse(position, options),
  };
}

function memory(enabled) {
  const prefix = `mapkern-viewer:${location.pathname}:`;
  return {
    get(key) {
      if (!enabled) return null;
      try {
        return localStorage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (!enabled) return;
      try {
        localStorage.setItem(prefix + key, value);
      } catch {}
    },
  };
}

function choose(basemaps, wanted) {
  if (Number.isInteger(wanted) && wanted >= 0 && wanted < basemaps.length) return wanted;
  const named = basemaps.findIndex((b) => b.name === wanted);
  return named < 0 ? 0 : named;
}

export function createViewer(options = {}) {
  const {
    container = "map",
    basemaps = BASEMAPS,
    basemap,
    terrain = TERRAIN,
    search = SEARCH,
    view,
    overlay,
    page = true,
    remember = page,
    attributionControl = true,
    ...mapOptions
  } = options;
  const stored = memory(remember);
  const remembered = stored.get("basemap");
  const selected = choose(basemaps, basemaps.some((b) => b.name === remembered) ? remembered : basemap);
  const map = new mapkern.Map({
    container,
    hash: page,
    maxPitch: 85,
    style: basemaps[selected].style,
    ...mapOptions,
    attributionControl: false,
  });
  if (attributionControl !== false) {
    const custom = typeof attributionControl === "object" ? attributionControl : {};
    map.addControl(new mapkern.AttributionControl(custom), "bottom-left");
  }
  const picker = basemaps.length > 1 ? new mapkern.BasemapControl({ basemaps, selected }) : null;
  const terrainControl = terrain ? new mapkern.TerrainControl({ source: terrain }) : null;
  if (picker) map.addControl(picker, "bottom-right");
  if (terrainControl) map.addControl(terrainControl, "bottom-right");
  map.addControl(new mapkern.NavigationControl(), "bottom-right");
  map.addControl(new mapkern.ScaleControl(), "bottom-right");
  const searchControl = search
    ? new mapkern.SearchControl({ geocoder: typeof search.search === "function" ? search : lazyGeocoder(search) })
    : null;
  if (searchControl) map.addControl(searchControl, "bottom-right");
  picker?.on("change", (event) => stored.set("basemap", event.basemap.name));
  terrainControl?.on("viewchange", (event) => stored.set("view", event.view));
  const start = stored.get("view") ?? view;
  if (terrainControl && (start === "terrain" || start === "tilted")) terrainControl.setView(start);
  if (overlay) {
    const run = () => overlay(map);
    map.on("styleload", run);
    if (map.isStyleLoaded()) run();
  }
  return {
    map,
    basemaps: picker,
    terrain: terrainControl,
    search: searchControl,
    panel: (...children) => addPanel(map, children),
  };
}

function addPanel(map, children) {
  const el = element("div", { className: "mapkern-control mapkern-viewer-panel" }, ...children);
  map.addControl({ onAdd: () => el, onRemove: () => el.remove() }, "top-left");
  return el;
}

export function element(tag, properties = {}, ...children) {
  const el = document.createElement(tag);
  Object.assign(el, properties);
  el.append(...children);
  return el;
}

export function row(...children) {
  return element("div", { className: "mapkern-viewer-row" }, ...children);
}

export function button(label, onClick) {
  const el = element("button", { type: "button", className: "mapkern-viewer-button", textContent: label });
  el.addEventListener("click", onClick);
  return el;
}

export function fileButton(label, accept, onFile, { multiple = false } = {}) {
  const input = element("input", { type: "file", multiple });
  if (accept) input.accept = accept;
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length > 0) onFile(multiple ? files : files[0]);
  });
  return element("label", { className: "mapkern-viewer-file" }, input, element("span", { textContent: label }));
}

export function beforeLabels(map) {
  return map.getStyle()?.layers?.find((layer) => layer.type === "symbol")?.id;
}
