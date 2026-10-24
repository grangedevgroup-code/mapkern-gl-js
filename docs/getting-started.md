# Getting started

This guide builds a small map page step by step: a map with your own data, then a full basemap, then interaction.

## 1. Install

```sh
npm install github:grangedevgroup-code/maplet-gl-js
```

The package is called `maplet-gl`. It contains:

| File | Use |
| --- | --- |
| `dist/maplet.js` | ES module for bundlers and `<script type="module">` |
| `dist/maplet.min.js` | The same module, minified |
| `dist/maplet.global.js` | Classic script that defines a global `maplet` object |
| `dist/maplet.css` | Optional stylesheet for the controls. Maplet adds the same styles itself |
| `dist/tiles/cli.js` | The `maplet-tiles` command that builds tile files |

Without a bundler, copy `dist/maplet.js` next to your page and import it by path:

```js
import { Map } from "./maplet.js";
```

Pages that use modules must be served over HTTP. Any static server works, for example `python -m http.server`.

## 2. Create a map

A map needs a container element with a size, and a style. The style lists data sources and the layers drawn from them, bottom to top.

```html
<div id="map" style="width: 100%; height: 480px"></div>
<script type="module">
  import { Map } from "./maplet.js";

  const map = new Map({
    container: "map",
    center: [-122.335, 47.608],
    zoom: 12,
    style: {
      version: 1,
      sources: {
        route: {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [-122.3422, 47.6097],
                [-122.3383, 47.6148],
                [-122.3493, 47.6205],
              ],
            },
          },
        },
      },
      layers: [
        { id: "background", type: "background", paint: { color: "#f4f3ef" } },
        {
          id: "route",
          type: "line",
          source: "route",
          layout: { cap: "round", join: "round" },
          paint: { color: "#2f6fdb", width: 5 },
        },
      ],
    },
  });
</script>
```

Coordinates are always `[longitude, latitude]`.

## 3. Add a basemap

The built-in `lightStyle` draws streets, water, parks, buildings and labels from a vector tile file. Build one from OpenStreetMap data with the `maplet-tiles` command:

```sh
npx maplet-tiles --input washington-latest.osm.pbf --bbox=-122.45,47.48,-122.22,47.74 --output seattle.pmtiles
```

Then point the style at the file:

```js
import { Map, lightStyle } from "./maplet.js";

const map = new Map({
  container: "map",
  style: lightStyle({ url: "seattle.pmtiles" }),
  center: [-122.335, 47.608],
  zoom: 12,
});
```

The server that hosts the `.pmtiles` file must support HTTP range requests. Most static servers and object stores do.

To draw your own layers on top of the basemap, add them after the style loads:

```js
map.on("styleload", () => {
  map.addSource("route", { type: "geojson", data: "route.geojson" });
  map.addLayer({ id: "route", type: "line", source: "route", paint: { color: "#2f6fdb", width: 5 } });
});
```

## 4. Update data

GeoJSON sources can be replaced at any time. The old data stays on screen until the new tiles are ready.

```js
const source = map.getSource("route");
if (source?.type === "geojson") source.setData(newFeatureCollection);
```

`data` can also be a URL. Large files load faster as a URL, because the browser downloads and parses them off the main thread.

## 5. Move the camera

```js
map.easeTo({ center: [-122.35, 47.62], zoom: 14, duration: 800 });
map.flyTo({ center: [-122.68, 45.52], zoom: 12 });
map.fitBounds([[-122.45, 47.48], [-122.22, 47.74]], { padding: 40 });
map.jumpTo({ pitch: 45, bearing: -20 });
```

Users can drag to pan, scroll or pinch to zoom, drag with the right mouse button or two fingers to rotate and tilt, and use the arrow keys, `+` and `-` when the map has focus.

## 6. Listen for events

```js
map.on("click", (event) => {
  console.log("clicked at", event.lngLat);
});

map.on("moveend", () => {
  console.log("now at", map.getCenter(), "zoom", map.getZoom());
});

map.on("error", (event) => {
  console.warn(event.error.code, event.error.message);
});

await map.once("idle");
```

`idle` fires when the visible tiles have loaded and nothing is moving. Every event is listed in the [API reference](api.md#events).

## 7. Add controls

```js
import { NavigationControl, ScaleControl } from "./maplet.js";

map.addControl(new NavigationControl());
map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");
```

An attribution control is added for you. It shows the `attribution` text of each source.

## Next steps

- [Style reference](style.md) for every layer type, property and expression
- [API reference](api.md) for map options, methods and events
- [Building tiles](tiles.md) for the tile builder and its data layers
