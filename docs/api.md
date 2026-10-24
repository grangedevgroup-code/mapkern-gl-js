# API reference

Everything below is exported from the package root:

```js
import { Map, NavigationControl, ScaleControl, lightStyle, addProtocol } from "maplet-gl";
```

Positions are `[longitude, latitude]` arrays. Methods that take a position also accept `{ lng, lat }`.

## Map

```js
const map = new Map(options);
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `container` | | Required. An element or the id of one. It needs a width and height |
| `style` | | A [style](style.md) object or the URL of a style JSON file |
| `center` | `[0, 0]` | Starting position. Falls back to the style's `center` |
| `zoom` | 0 | Starting zoom. Falls back to the style's `zoom` |
| `bearing` | 0 | Rotation in degrees, clockwise from north |
| `pitch` | 0 | Tilt in degrees, 0 looks straight down |
| `minZoom`, `maxZoom` | 0, 22 | Zoom limits |
| `minPitch`, `maxPitch` | 0, 60 | Tilt limits |
| `renderWorldCopies` | `true` | Repeat the world to the east and west when zoomed out |
| `interactive` | `true` | `false` turns off all mouse, touch and keyboard handling |
| `dragPan`, `dragRotate`, `scrollZoom`, `doubleClickZoom`, `touchZoomRotate`, `touchPitch`, `keyboard` | `true` | Turn single interactions off |
| `pixelRatio` | the screen's | Drawing resolution. Use a lower value to save power |
| `maxPixelRatio` | 2 | Upper limit for the screen's pixel ratio |
| `antialias` | `false` | Multisample antialiasing. Costs memory and power |
| `preserveDrawingBuffer` | `false` | Keep the last frame so it can be read back, for example with `canvas.toDataURL()` |
| `fadeDuration` | 200 | Fade-in time for new raster tiles, in milliseconds |
| `tileCacheSize` | 192 | Memory for decoded tiles, in megabytes. The minimum is 16 |
| `maxParallelRequests` | 24 | Tile requests in flight at once |
| `requestTimeout` | 30000 | Milliseconds before a request is given up and retried |
| `prefetch` | `true` | Load tiles along camera moves before they are needed |
| `transformRequest` | | `(url, kind) => ({ url, headers, credentials })`. Changes requests, for example to add an API key. `kind` is `"style"`, `"source"`, `"tile"`, `"glyphs"` or `"image"` |
| `attributionControl` | `true` | `false` removes it. `{ custom: "text" }` adds your own credit |
| `workerCount` | cores minus one, at most 4 | Number of Web Workers |
| `workerUrl` | | URL of `dist/maplet-worker.js`. Use it when your Content Security Policy does not allow `blob:` workers |
| `reducedMotion` | the system setting | `true` makes camera animations jump |
| `locale` | | Replaces control labels: `{ zoomIn, zoomOut, resetNorth, map }` |

### Camera

| Method | Meaning |
| --- | --- |
| `getCenter()` | `[lng, lat]` |
| `getZoom()`, `getBearing()`, `getPitch()` | Current values |
| `getBounds()` | `[[west, south], [east, north]]` of the visible area |
| `setCenter(lngLat)`, `setZoom(zoom)`, `setBearing(degrees)`, `setPitch(degrees)` | Move without animation |
| `jumpTo({ center, zoom, bearing, pitch, around })` | Change several values at once without animation |
| `easeTo({ center, zoom, bearing, pitch, around, duration, easing })` | Animate. `duration` defaults to 500 ms |
| `flyTo({ center, zoom, bearing, pitch, speed, curve, duration, maxDuration })` | Zoom out, move and zoom in again along a smooth path |
| `panBy([x, y], options)`, `panTo(lngLat, options)` | Move by pixels or to a position |
| `zoomTo(zoom, options)`, `zoomIn(options)`, `zoomOut(options)` | Animated zoom |
| `rotateTo(degrees, options)`, `resetNorth(options)` | Animated rotation |
| `fitBounds(bounds, { padding, maxZoom, bearing, pitch, linear, duration })` | Show a box. `bounds` is `[[west, south], [east, north]]` or `[west, south, east, north]` |
| `cameraForBounds(bounds, options)` | The camera that `fitBounds` would use, without moving |
| `stop()` | End any animation |
| `isMoving()` | `true` during animations and gestures |
| `setMinZoom(zoom)`, `setMaxZoom(zoom)`, `setMaxPitch(degrees)`, `getMinZoom()`, `getMaxZoom()` | Limits |
| `project(lngLat)` | Screen position `{ x, y }` in CSS pixels |
| `unproject([x, y])` | `[lng, lat]` under a screen position, or `null` above the horizon |

Animation options are `duration` in milliseconds, `easing` (a function from 0..1 to 0..1) and `animate: false` to jump.

### Style, sources and layers

| Method | Meaning |
| --- | --- |
| `setStyle(style)` | Replace the style. Takes an object or a URL |
| `getStyle()` | The current style as a plain object |
| `isStyleLoaded()` | `true` when every source has loaded its metadata |
| `addSource(id, source)`, `removeSource(id)` | A source can only be removed when no layer uses it |
| `getSource(id)` | The source object. See [GeoJSON sources](#geojson-sources) |
| `addLayer(layer, beforeId)` | Adds on top, or below the layer `beforeId` |
| `removeLayer(id)`, `moveLayer(id, beforeId)` | |
| `getLayer(id)`, `getLayerIds()` | |
| `setPaintProperty(layerId, name, value)`, `setLayoutProperty(layerId, name, value)` | |
| `setFilter(layerId, filter)` | `null` removes the filter |
| `setLayerVisibility(layerId, visible)` | |
| `setLayerZoomRange(layerId, minZoom, maxZoom)` | |
| `getAttributions()` | Credits of the current sources |

Style edits that change which features are drawn rebuild the affected tiles in the background. The old tiles stay on screen until the new ones are ready.

### Controls

| Method | Meaning |
| --- | --- |
| `addControl(control, position)` | `position` is `"top-left"`, `"top-right"`, `"bottom-left"` or `"bottom-right"` |
| `removeControl(control)` | |

### Other

| Method | Meaning |
| --- | --- |
| `getContainer()`, `getCanvas()`, `getCanvasContainer()` | DOM elements |
| `resize()` | Call after the container changes size, if you need it before the next frame. Maplet watches the size itself |
| `getPixelRatio()`, `setPixelRatio(ratio)` | `setPixelRatio(undefined)` goes back to the screen's ratio |
| `triggerRepaint()` | Draw one more frame |
| `loaded()` | `true` when the style and visible tiles have loaded |
| `getDiagnostics()` | See [Diagnostics](#diagnostics) |
| `remove()` | Stops the map and frees its memory, workers and GPU resources |
| `on(type, listener)`, `off(type, listener)` | Events |
| `once(type, listener)` | Listens once. Returns a promise for the event, so `await map.once("idle")` works |

## Events

| Event | When |
| --- | --- |
| `styleload` | A style has been applied |
| `load` | The first frame with the style has been drawn |
| `idle` | Visible tiles have loaded and nothing is moving |
| `render` | After each frame |
| `resize` | The map changed size |
| `remove` | `remove()` was called |
| `movestart`, `move`, `moveend` | The camera moved. `originalEvent` is set when a person caused it |
| `zoomstart`, `zoom`, `zoomend`, `rotatestart`, `rotate`, `rotateend`, `pitchstart`, `pitch`, `pitchend` | The same, for each kind of change |
| `click`, `dblclick`, `contextmenu`, `mousemove`, `mousedown`, `mouseup`, `mouseout` | Pointer events with `point` (`{ x, y }`) and `lngLat`. Call `preventDefault()` in `dblclick` to stop the zoom |
| `sourcedata` | A source loaded (`kind: "metadata"`), got new data (`kind: "content"`) or failed (`kind: "error"`). Has `sourceId` |
| `error` | Something failed. `event.error` is a `MapletError` |
| `contextlost`, `contextrestored` | The browser dropped and restored the WebGL context. Maplet reloads what it needs |

## GeoJSON sources

`map.getSource(id)` returns a GeoJSON source for `type: "geojson"`.

```js
const source = map.getSource("vehicles");
if (source?.type === "geojson") {
  source.setData(latestPositions);
}
```

| Member | Meaning |
| --- | --- |
| `setData(data)` | Replace the data with a GeoJSON object or a URL. The current data stays on screen until the new tiles are ready. Calls in quick succession are merged |
| `getData()` | The data or URL last passed in |
| `bounds` | `[west, south, east, north]` of the data, or `null` when it is empty |
| `featureCount` | Number of features |

A `sourcedata` event with `kind: "content"` fires when new data has been applied.

## Controls

```js
map.addControl(new NavigationControl({ showZoom: true, showCompass: true }), "top-right");
map.addControl(new ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");
```

| Control | Options |
| --- | --- |
| `NavigationControl` | `showZoom`, `showCompass`. The compass resets the bearing and tilt |
| `ScaleControl` | `maxWidth` in pixels, `unit` `"metric"` or `"imperial"` |
| `AttributionControl` | `custom`: extra credit text. Added by default |

A custom control is any object with `onAdd(map)`, which returns an element, and `onRemove(map)`:

```js
class HomeButton {
  onAdd(map) {
    const button = document.createElement("button");
    button.textContent = "Home";
    button.className = "maplet-control";
    button.onclick = () => map.flyTo({ center: [-122.335, 47.608], zoom: 12 });
    return button;
  }
  onRemove() {}
}
map.addControl(new HomeButton(), "top-left");
```

## Custom protocols

`addProtocol(scheme, handler)` lets a source URL like `mytiles://roads/{z}/{x}/{y}` be answered by your own code, for example from IndexedDB or a file the user picked.

```js
addProtocol("mytiles", async (request, signal) => {
  const bytes = await readTileFromSomewhere(request.url, signal);
  return bytes ?? null;
});
```

The handler receives `{ url, kind, headers, credentials }` and an `AbortSignal`. It returns an `ArrayBuffer`, a `Uint8Array`, `{ data, contentType }`, or `null` when there is no tile. `removeProtocol(scheme)` removes it. The `pmtiles://` protocol is built in.

## Errors

Errors arrive as `error` events carrying a `MapletError` with a `code`, a readable `message` and a `detail` object. Without an `error` listener, Maplet logs them to the console.

| Code | Meaning |
| --- | --- |
| `webgl-unavailable` | The browser cannot create a WebGL2 context |
| `shader-compile` | A shader did not compile. Please report it with your browser and GPU |
| `invalid-option` | A map option or method argument is wrong |
| `invalid-style` | The style has problems. `detail.issues` lists them |
| `source-error` | A source could not load its metadata or data |
| `tile-error` | A tile failed after its retries. `detail.tile` says which |
| `network`, `http` | A request failed |
| `auth` | The server answered 401 or 403. These are not retried |
| `decode` | Data arrived but could not be read |
| `context-lost` | The WebGL context was lost |
| `worker` | A Web Worker failed |

## Diagnostics

`map.getDiagnostics()` returns numbers that help find performance problems:

| Field | Meaning |
| --- | --- |
| `frames` | Frames drawn so far |
| `frameTime` | `p50`, `p95`, `p99` and `max` time spent on the map per frame, in milliseconds, over the last 240 frames |
| `longFrames` | Frames that took more than 50 ms |
| `drawCalls`, `renderedPieces` | Work in the last frame |
| `requests` | Requests `active` and `queued` |
| `workers` | Worker pool `size` and `queued` tasks |
| `sources` | Tile counts per source: ready, loading, failed, cached bytes, retries, cancelled requests and blank area |
| `blankRatio` | Share of the screen with no data drawn yet, 0 to 1 |
| `canvas` | Size and pixel ratio |
| `contextLost` | `true` while the WebGL context is lost |

## Helpers

| Function | Meaning |
| --- | --- |
| `lightStyle(options)` | The built-in style. See the [style reference](style.md#the-built-in-style) |
| `validateStyle(style)` | Returns a list of `{ path, message }` problems, empty when the style is valid |
| `distanceMeters(a, b)` | Great circle distance between two positions |
| `metersPerPixel(latitude, zoom)` | Ground size of one CSS pixel |
| `lngLatToWorld(lng, lat)`, `worldToLngLat(x, y)` | Convert to and from Web Mercator coordinates from 0 to 1 |
| `version` | The library version |
