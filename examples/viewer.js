import * as maplet from "../dist/maplet.js";

export { maplet };

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

const CSS = `
.maplet-viewer-page {
  position: absolute;
  inset: 0;
}
.maplet-bottom-right > .maplet-scale {
  position: absolute;
  right: calc(100% + var(--maplet-margin));
  bottom: 0;
}
.maplet-viewer-panel {
  display: grid;
  gap: 6px;
  max-width: min(300px, calc(100vw - 96px));
  padding: 10px 12px;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--maplet-ink, #10191d);
}
.maplet-viewer-panel h1 {
  margin: 0;
  font-size: 15px;
}
.maplet-viewer-panel p {
  margin: 0;
  color: #3d474b;
}
.maplet-viewer-panel output {
  font-variant-numeric: tabular-nums;
}
.maplet-viewer-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.maplet-viewer-panel .maplet-viewer-button,
.maplet-viewer-file span {
  display: inline-block;
  padding: 5px 10px;
  border: 1px solid #b9bdb7;
  border-radius: 6px;
  background: #ffffff;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.maplet-viewer-file {
  position: relative;
}
.maplet-viewer-file input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.maplet-viewer-file input:focus-visible + span,
.maplet-viewer-panel .maplet-viewer-button:focus-visible {
  outline: 2px solid var(--maplet-focus, #2f6fdb);
}
`;

const PAGE_CSS = `
html,
body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: #11191f;
}
`;

let styled = false;

function addStyles(page) {
  if (styled) return;
  styled = true;
  const style = document.createElement("style");
  style.textContent = page ? PAGE_CSS + CSS : CSS;
  document.head.appendChild(style);
}

function memory(enabled) {
  const prefix = `maplet-viewer:${location.pathname}:`;
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
  if (typeof wanted === "number" && Number.isInteger(wanted) && wanted >= 0 && wanted < basemaps.length) return wanted;
  const named = basemaps.findIndex((b) => b.name === wanted);
  return named < 0 ? 0 : named;
}

export function createViewer(options = {}) {
  const {
    container = "map",
    basemaps = BASEMAPS,
    basemap,
    terrain = TERRAIN,
    view,
    overlay,
    page = true,
    remember = page,
    ...mapOptions
  } = options;
  addStyles(page);
  const element = typeof container === "string" ? document.getElementById(container) : container;
  if (page && element) element.classList.add("maplet-viewer-page");
  const stored = memory(remember);
  const remembered = stored.get("basemap");
  const selected = choose(
    basemaps,
    remembered !== null && basemaps.some((b) => b.name === remembered) ? remembered : basemap,
  );
  const map = new maplet.Map({
    container: element ?? container,
    hash: page,
    maxPitch: 85,
    style: basemaps[selected].style,
    ...mapOptions,
  });
  const picker = basemaps.length > 1 ? new maplet.BasemapControl({ basemaps, selected }) : null;
  const terrainControl = terrain ? new maplet.TerrainControl({ source: terrain }) : null;
  if (picker) map.addControl(picker, "bottom-right");
  if (terrainControl) map.addControl(terrainControl, "bottom-right");
  map.addControl(new maplet.NavigationControl(), "bottom-right");
  map.addControl(new maplet.ScaleControl(), "bottom-right");
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
    panel: (...children) => addPanel(map, children),
  };
}

function addPanel(map, children) {
  const el = document.createElement("div");
  el.className = "maplet-control maplet-viewer-panel";
  el.append(...children);
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
  return element("div", { className: "maplet-viewer-row" }, ...children);
}

export function button(label, onClick) {
  const el = element("button", { type: "button", className: "maplet-viewer-button", textContent: label });
  el.addEventListener("click", onClick);
  return el;
}

export function fileButton(label, accept, onFile) {
  const input = element("input", { type: "file" });
  if (accept) input.accept = accept;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) onFile(file);
  });
  return element("label", { className: "maplet-viewer-file" }, input, element("span", { textContent: label }));
}

export function beforeLabels(map) {
  return map.getStyle()?.layers?.find((layer) => layer.type === "symbol")?.id;
}
