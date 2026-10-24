# API

Everything is exported from the package root. The examples here import it all as `maplet`:

```js
import * as maplet from "maplet-gl";
```

Positions are always `[longitude, latitude]`. Anywhere a position goes in, `{ lng, lat }` works too.

## Creating a map

```js
const map = new maplet.Map({
  container: "map",
  style: maplet.lightStyle({ url: "seattle.pmtiles" }),
  center: [-122.335, 47.608],
  zoom: 12,
});
```

`container` is an element or its id, and it needs a size. `style` is a [style](style.md) object or the URL of one. Everything else is optional:

| Option | Default | |
| --- | --- | --- |
| `center`, `zoom`, `bearing`, `pitch` | from the style, else 0 | Where the map starts. Bearing turns the map clockwise from north; pitch tilts it, 0 looks straight down |
| `minZoom`, `maxZoom` | 0, 22 | |
| `minPitch`, `maxPitch` | 0, 60 | |
| `interactive` | `true` | `false` ignores mouse, touch and keyboard |
| `dragPan`, `dragRotate`, `scrollZoom`, `doubleClickZoom`, `touchZoomRotate`, `touchPitch`, `keyboard` | `true` | Switch off single interactions |
| `renderWorldCopies` | `true` | Repeat the world sideways when zoomed far out |
| `pixelRatio` | the screen's, up to `maxPixelRatio` | A lower value saves battery |
| `maxPixelRatio` | 2 | |
| `antialias` | `false` | Smoother edges at the cost of memory |
| `preserveDrawingBuffer` | `false` | Keep the last frame around, for example for `canvas.toDataURL()` |
| `fadeDuration` | 200 | Fade-in for new raster tiles, in ms |
| `tileCacheSize` | 192 | Memory for tiles, in MB |
| `maxParallelRequests` | 24 | |
| `requestTimeout` | 30000 | In ms. A timed-out request is retried |
| `prefetch` | `true` | Load tiles ahead of camera animations |
| `transformRequest` | | `(url, kind) => ({ url, headers, credentials })`, for adding API keys or headers |
| `attributionControl` | `true` | `false` hides it; `{ custom: "..." }` adds your own credit |
| `workerCount` | cores minus one, up to 4 | |
| `workerUrl` | | URL of `dist/maplet-worker.js`, for sites whose Content Security Policy blocks `blob:` workers |
| `reducedMotion` | the system setting | `true` turns camera animations into jumps |
| `locale` | | Your own control labels: `{ zoomIn, zoomOut, resetNorth, map }` |

When you're done with a map, call `map.remove()`. It stops drawing and frees the workers and GPU memory.

## Moving the camera

```js
map.jumpTo({ center: [-122.35, 47.62], zoom: 14 });
map.easeTo({ zoom: 15, pitch: 45, bearing: -20, duration: 800 });
map.flyTo({ center: [-122.68, 45.52], zoom: 12 });
map.fitBounds([[-122.45, 47.48], [-122.22, 47.74]], { padding: 40 });
```

`jumpTo` moves at once, `easeTo` animates (500 ms unless you pass `duration`), and `flyTo` zooms out, travels and zooms back in. All three take `center`, `zoom`, `bearing` and `pitch`, plus `around` to zoom around a fixed point. `flyTo` also takes `speed`, `curve` and `maxDuration`. `fitBounds` accepts `[[west, south], [east, north]]` or `[west, south, east, north]`, with `padding`, `maxZoom` and `linear` if you'd rather ease than fly. `cameraForBounds()` tells you where `fitBounds` would go without moving.

There are shortcuts too: `panBy([x, y])`, `panTo(lngLat)`, `zoomTo(zoom)`, `zoomIn()`, `zoomOut()`, `rotateTo(bearing)` and `resetNorth()`. They take the same animation options: `duration`, `easing` (a function from 0..1 to 0..1) and `animate: false`.

To read the camera, use `getCenter()`, `getZoom()`, `getBearing()`, `getPitch()` and `getBounds()`, which returns `[[west, south], [east, north]]`. `setCenter()`, `setZoom()`, `setBearing()` and `setPitch()` move without animation. `isMoving()` is true during animations and gestures, and `stop()` ends an animation.

`project(lngLat)` gives the screen position of a place in CSS pixels, and `unproject([x, y])` does the opposite. It returns `null` for points above the horizon on a tilted map.

People can drag to pan, scroll or pinch to zoom, and double-click to zoom in. Dragging with the right mouse button, or with Ctrl held, rotates and tilts. On touch screens, twisting two fingers rotates and sliding two fingers up or down tilts. With keyboard focus, the arrow keys pan, Shift with the arrows rotates and tilts, and `+` and `-` zoom.

## Changing the style

```js
map.addSource("route", { type: "geojson", data: "route.geojson" });
map.addLayer({ id: "route", type: "line", source: "route", paint: { color: "#2f6fdb", width: 5 } });
map.setPaintProperty("route", "width", 8);
map.setFilter("route", ["==", ["get", "kind"], "bike"]);
```

`addLayer(layer, beforeId)` puts the layer on top, or under `beforeId` if you give one. The rest work as you'd expect: `removeLayer`, `moveLayer`, `getLayer`, `getLayerIds`, `setLayoutProperty`, `setLayerVisibility`, `setLayerZoomRange`, `removeSource` (only once no layer uses it) and `getSource`. `setFilter(id, null)` removes a filter.

`setStyle()` swaps the whole style and `getStyle()` returns the current one as a plain object.

When an edit changes which features a layer draws, Maplet rebuilds the tiles in the background and keeps the old ones on screen until the new ones are ready.

## GeoJSON

GeoJSON sources can be updated while the map runs:

```js
const vehicles = map.getSource("vehicles");
vehicles.setData(latestPositions);
```

In TypeScript, check `vehicles?.type === "geojson"` first so the compiler knows which kind of source it is.

The current data stays on screen until the new tiles are ready, and if you call `setData` faster than Maplet can keep up, it skips straight to the newest data. You can pass a URL instead of an object, which is the better choice for big files because the parsing then happens in a worker.

`setData` also takes a `File` or `Blob`, so people can open their own files. Any of the formats listed in the [style guide](style.md#geojson) work:

```js
input.addEventListener("change", () => {
  const file = input.files[0];
  if (file) map.getSource("uploads").setData(file);
});
```

The source also has `getData()`, `bounds` (`[west, south, east, north]`, or `null` when empty) and `featureCount`.

## Events

```js
map.on("click", (event) => console.log(event.lngLat, event.point));
map.on("moveend", () => console.log(map.getCenter(), map.getZoom()));
map.on("error", (event) => console.warn(event.error.message));

await map.once("idle");
```

`once` returns a promise, so you can await it. `off(type, listener)` removes a listener.

- `styleload`: a style has been applied. `load`: the first frame with it has been drawn.
- `idle`: everything on screen has loaded and nothing is moving.
- `render` after every frame, `resize` when the map changes size, `remove` when it's removed.
- `movestart`, `move` and `moveend` whenever the camera changes. There are also `zoom`, `rotate` and `pitch` versions of all three. `originalEvent` is set when a person caused the move.
- `click`, `dblclick`, `contextmenu`, `mousemove`, `mousedown`, `mouseup` and `mouseout` carry `point` (`{ x, y }`) and `lngLat`. Call `event.preventDefault()` in `dblclick` to stop the zoom.
- `sourcedata` when a source loads (`kind: "metadata"`), gets new data (`"content"`) or fails (`"error"`).
- `error` with a `MapletError` in `event.error`.
- `contextlost` and `contextrestored` if the browser drops the GPU context. Maplet reloads what it needs on its own.

## Finding features

```js
map.on("click", async (event) => {
  const [feature] = await map.queryRenderedFeatures(event.point);
  if (feature) console.log(feature.layer, feature.properties);
});
```

`queryRenderedFeatures(point)` returns the features drawn under a point, top layer first. It sees exactly what's on screen, including line widths, circle sizes, labels and 3D buildings. Give it two points, `[[x1, y1], [x2, y2]]`, to search a box, or nothing to search the whole view, and pass `{ layers: ["roads"] }` to look at certain layers only. It returns a promise because some of the data lives in a worker.

Each result has `id`, `properties`, `geometry` in longitude and latitude, `layer`, `source` and `sourceLayer`. Features from vector tiles come back cut at the tile edge; GeoJSON features come back whole.

For the height of the ground, ask an elevation source: `map.getSource("dem").elevationAt(event.lngLat)` returns meters, or `null` where no elevation tile is loaded.

## Errors

Errors come with a `code`, a readable `message` and a `detail` object. If you don't listen for `error`, they're logged to the console.

`invalid-style` means the style has problems (`detail.issues` lists them all) and `invalid-option` means a bad map option or argument. `source-error` is a source that couldn't load, and `tile-error` a tile that still failed after its retries (`detail.tile` says which one). Requests fail with `network`, `http` or `auth`; 401 and 403 answers aren't retried. `decode` means data arrived but couldn't be read. `webgl-unavailable`, `shader-compile`, `context-lost` and `worker` point at the browser or GPU.

## Controls

```js
map.addControl(new maplet.NavigationControl());
map.addControl(new maplet.ScaleControl({ unit: "imperial" }), "bottom-left");
```

`NavigationControl` has zoom buttons and a compass that turns the map back north and flat. Pass `showZoom: false` or `showCompass: false` to leave one out. `ScaleControl` takes `unit` (`"metric"` or `"imperial"`) and `maxWidth` in pixels. The attribution control is added for you.

The second argument is the corner: `"top-left"`, `"top-right"`, `"bottom-left"` or `"bottom-right"`. `removeControl()` takes it away again.

Your own control is any object with `onAdd(map)`, which returns an element, and `onRemove(map)`:

```js
class HomeButton {
  onAdd(map) {
    const button = document.createElement("button");
    button.className = "maplet-control";
    button.textContent = "Home";
    button.onclick = () => map.flyTo({ center: [-122.335, 47.608], zoom: 12 });
    return button;
  }
  onRemove() {}
}

map.addControl(new HomeButton(), "top-left");
```

## Tile files from the user's computer

`maplet.openTileFile(file)` takes a PMTiles or MBTiles `File` (from a file input or a drop) and gives you back a URL to use as a source. Nothing is uploaded; tiles are read straight from the file as the map needs them.

```js
const url = await maplet.openTileFile(input.files[0]);
map.addSource("mine", { type: "vector", url });
```

## Your own tile protocol

`addProtocol` lets you answer requests for a made-up URL scheme yourself, for example to serve tiles from IndexedDB or from a file someone picked:

```js
maplet.addProtocol("local", async (request, signal) => {
  const bytes = await readTile(request.url, signal);
  return bytes ?? null;
});

map.addSource("offline", { type: "vector", tiles: ["local://roads/{z}/{x}/{y}"] });
```

Return an `ArrayBuffer` or `Uint8Array`, or `null` when there's no tile. `maplet.removeProtocol("local")` undoes it. `pmtiles://` is built in.

## Diagnostics

`map.getDiagnostics()` returns numbers for tracking down slow maps: frame times (`p50`, `p95`, `p99` and `max` over the last 240 frames), draw calls, requests in flight, worker queue length, `blankRatio` (how much of the screen is still waiting for data) and per-source tile counts with retries, cancellations and cache size.

## Other helpers

`lightStyle(options)` is the built-in street style, described at the end of the [style guide](style.md#the-built-in-style). `validateStyle(style)` returns a list of `{ path, message }` problems. `distanceMeters(a, b)` measures between two positions, `metersPerPixel(latitude, zoom)` tells you how much ground one pixel covers, and `lngLatToWorld` and `worldToLngLat` convert to and from Web Mercator coordinates between 0 and 1. `version` is the library version.

A few smaller methods round things out: `getContainer()`, `getCanvas()`, `resize()` (rarely needed, since the map watches its own size), `getPixelRatio()`, `setPixelRatio()`, `triggerRepaint()`, `loaded()`, `getAttributions()`, `setMinZoom()`, `setMaxZoom()` and `setMaxPitch()`.
