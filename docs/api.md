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

`container` is an element or its id, and it needs a size. `style` is a [style](style.md) object or the URL of one, and styles written for MapLibre or Mapbox work too, see [Styles from MapLibre and Mapbox](style.md#styles-from-maplibre-and-mapbox). Leave it out and you get the whole world with OpenFreeMap's Liberty style (`maplet.DEFAULT_STYLE`), or pass `null` for an empty map. Everything else is optional:

| Option | Default | |
| --- | --- | --- |
| `center`, `zoom`, `bearing`, `pitch` | from the style, else the whole world | Where the map starts. Without a center or zoom the map fits the world from 55° south to 75° north. Bearing turns the map clockwise from north; pitch tilts it, 0 looks straight down |
| `bounds` | | Start with this area in view instead, as `[[west, south], [east, north]]`. `fitBoundsOptions` takes the same options as `fitBounds` |
| `maxBounds` | | Keep the view inside this area |
| `padding` | 0 | Space in pixels the map keeps free at its edges, as a number or `{ top, right, bottom, left }` |
| `minZoom`, `maxZoom` | -2, 22 | Zooming out also stops where the world fills the map from top to bottom |
| `minPitch`, `maxPitch` | 0, 60 | |
| `interactive` | `true` | `false` ignores mouse, touch and keyboard |
| `hash` | `false` | `true` keeps the position in the page address, like `#12.5/47.6/-122.33`, so links open the same view. A name such as `"map"` stores it as `#map=...` next to your own parameters |
| `cooperativeGestures` | `false` | For maps inside a scrolling page: zoom needs Ctrl or ⌘ with the wheel, and panning needs two fingers, so the page scrolls normally |
| `dragPan`, `dragRotate`, `scrollZoom`, `boxZoom`, `doubleClickZoom`, `touchZoomRotate`, `touchPitch`, `keyboard` | `true` | Switch off single interactions |
| `bearingSnap` | 7 | After a rotation that ends this many degrees or less from north, the map turns back to north |
| `clickTolerance` | 4 | How far in pixels the pointer may move between press and release and still count as a click |
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
| `locale` | | Your own labels for controls, hints and screen readers: `{ zoomIn, zoomOut, resetNorth, map, marker, popup, closePopup, fullscreen, exitFullscreen, geolocate, locationUnavailable, yourLocation, scrollZoomBlocker, scrollZoomBlockerMac, touchPanBlocker }` |

When you're done with a map, call `map.remove()`. It stops drawing and frees the workers and GPU memory.

## Moving the camera

```js
map.jumpTo({ center: [-122.35, 47.62], zoom: 14 });
map.easeTo({ zoom: 15, pitch: 45, bearing: -20, duration: 800 });
map.flyTo({ center: [-122.68, 45.52], zoom: 12 });
map.fitBounds([[-122.45, 47.48], [-122.22, 47.74]], { padding: 40 });
```

`jumpTo` moves at once, `easeTo` animates (500 ms unless you pass `duration`), and `flyTo` zooms out, travels and zooms back in. All three take `center`, `zoom`, `bearing` and `pitch`, plus `around` to zoom around a fixed point. `flyTo` also takes `speed`, `curve` and `maxDuration`. `fitBounds` accepts `[[west, south], [east, north]]` or `[west, south, east, north]`, with `padding`, `maxZoom` and `linear` if you'd rather ease than fly. `cameraForBounds()` tells you where `fitBounds` would go without moving.

There are shortcuts too: `panBy([x, y])`, `panTo(lngLat)`, `zoomTo(zoom)`, `zoomIn()`, `zoomOut()`, `rotateTo(bearing)` and `resetNorth()`. They take the same animation options: `duration`, `easing` (a function from 0..1 to 0..1) and `animate: false`. `fitScreenCoordinates([x1, y1], [x2, y2], bearing)` zooms to a box drawn on the screen, which is what Shift-drag does.

Padding keeps part of the map free, for example under a side panel:

```js
map.setPadding({ left: 360 });
map.easeTo({ center: [-122.33, 47.6], padding: { left: 0 }, duration: 600 });
```

The center of the map then sits in the middle of what's left, so `getCenter()`, `easeTo` and `fitBounds` all work around the panel. `jumpTo`, `easeTo` and `flyTo` take `padding` and animate it along with everything else, and `getPadding()` reads it back.

The map always fills its container. You can't pan past the poles, and zooming out stops once the world reaches from the top of the map to the bottom, so there's never empty space above or below it. Sideways the world repeats, or with `renderWorldCopies: false` you stop at its edges instead. On a tall, narrow map this stop can sit above `minZoom`, and `map.transform.lowestZoom` tells you where it is right now.

`setMaxBounds([[west, south], [east, north]])` keeps the whole view inside an area: you can't pan out of it, and zooming out stops once the area fills the screen. `setMaxBounds(null)` lifts the limit and `getMaxBounds()` reads it.

To read the camera, use `getCenter()`, `getZoom()`, `getBearing()`, `getPitch()` and `getBounds()`, which returns `[[west, south], [east, north]]`. `setCenter()`, `setZoom()`, `setBearing()` and `setPitch()` move without animation. `isMoving()` is true during animations and gestures, `isZooming()` and `isRotating()` narrow that down, and `stop()` ends an animation. `resetNorthPitch()` turns the map north and flat in one go, and `snapToNorth()` does it only when the map is already within `bearingSnap` degrees of north.

The limits have getters and setters of their own: `getMinZoom()`, `setMinZoom()`, `getMaxZoom()`, `setMaxZoom()`, `getMinPitch()`, `setMinPitch()`, `getMaxPitch()`, `setMaxPitch()`, and `getRenderWorldCopies()` with `setRenderWorldCopies()`.

`project(lngLat)` gives the screen position of a place in CSS pixels, and `unproject([x, y])` does the opposite. It returns `null` for points above the horizon on a tilted map. `screenPosition(lngLat)` is `project` with two extras for your own overlays: `visible` says whether the place is in front of the camera and close enough to be drawn, and `occluded` whether a hill is in the way.

People can drag to pan, scroll or pinch to zoom, and double-click to zoom in. Dragging with Shift held draws a box to zoom into, and Escape cancels it. Dragging with the right mouse button, or with Ctrl held, rotates and tilts. On touch screens, twisting two fingers rotates and sliding two fingers up or down tilts. With keyboard focus, the arrow keys pan, Shift with the arrows rotates and tilts, and `+` and `-` zoom.

Each of these can be switched off and on again while the map runs, for example while someone draws on the map:

```js
map.dragPan.disable();
map.scrollZoom.enable();
map.touchZoomRotate.disableRotation();
```

The switches are `dragPan`, `dragRotate`, `scrollZoom`, `boxZoom`, `doubleClickZoom`, `touchZoomRotate`, `touchPitch`, `keyboard` and `cooperativeGestures`, and each has `isEnabled()`. `touchZoomRotate.disableRotation()` keeps pinch zoom but stops the twist.

## Changing the style

```js
map.addSource("route", { type: "geojson", data: "route.geojson" });
map.addLayer({ id: "route", type: "line", source: "route", paint: { color: "#2f6fdb", width: 5 } });
map.setPaintProperty("route", "width", 8);
map.setFilter("route", ["==", ["get", "kind"], "bike"]);
```

`addLayer(layer, beforeId)` puts the layer on top, or under `beforeId` if you give one. The rest work as you'd expect: `removeLayer`, `moveLayer`, `getLayer`, `getLayerIds`, `setLayoutProperty`, `setLayerVisibility`, `setLayerZoomRange`, `removeSource` (only once no layer uses it) and `getSource`. `setFilter(id, null)` removes a filter.

To read a layer back, use `getFilter(id)`, `getPaintProperty(id, name)` and `getLayoutProperty(id, name)`. They return what the style says, or `undefined` for anything left at its default. `isSourceLoaded(id)` tells you whether a source has everything it needs for the current view, and `areTilesLoaded()` asks the same of all sources.

`setStyle()` swaps the whole style and `getStyle()` returns the current one as a plain object. Switching styles keeps whatever the two have in common. Sources that didn't change keep their tiles, layers keep their place on screen and only the properties that differ are updated, and a GeoJSON source that only got new `data` takes it the way [`setData`](#geojson) would. That makes a light and dark theme switch instant, with no reloading and no flash, and feature state on the kept sources survives too. The map ends up exactly as if it had built the new style from scratch. If you'd rather it did that, pass `{ diff: false }` as the second argument.

`styleload` fires after every `setStyle`, so a handler that adds your own layers on top of a style keeps working when you switch.

If the style has a [`transition`](style.md#transitions), `setPaintProperty` and `setStyle` fade from the old colors and sizes to the new ones instead of jumping. `setPaintProperty("roads", "colorTransition", { duration: 500 })` sets the timing for one property.

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

A [clustered](style.md#geojson) source can tell you about its clusters. Give it the `cluster_id` from a cluster's properties:

```js
map.on("click", "clusters", async (event) => {
  const cluster = event.features[0];
  const zoom = await map.getSource("stations").getClusterExpansionZoom(cluster.properties.cluster_id);
  map.easeTo({ center: cluster.geometry.coordinates, zoom });
});
```

`getClusterExpansionZoom(id)` is the zoom at which the cluster comes apart. `getClusterChildren(id)` returns the clusters and points one level down, and `getClusterLeaves(id, limit, offset)` the original points inside it, 10 at a time unless you pass another `limit` (`Infinity` for all).

## Images, video and canvases

[Image, video and canvas sources](style.md#images-video-and-canvases) can be moved and changed while the map runs:

```js
const plan = map.getSource("floorplan");
plan.setCoordinates(nextCorners);
plan.updateImage({ url: "floor-3.png" });
```

`getCoordinates()` gives you the corners back. `updateImage({ url, coordinates })` swaps the picture of an image source and keeps the old one on screen until the new one has loaded.

Video sources have `play()`, `pause()` and `getVideo()`, which hands you the `<video>` element for anything else, such as seeking. Canvas sources have `play()` and `pause()` as well, to turn the copying every frame on and off, and `getCanvas()`. Pausing copies the canvas one last time, so it's also how you show a change on a canvas with `animate: false`.

While a video plays or a canvas animates, the map keeps drawing, so it won't fire `idle` until you pause them. With terrain on, only the parts of the ground under them are redrawn each frame.

## Events

```js
map.on("click", (event) => console.log(event.lngLat, event.point));
map.on("moveend", () => console.log(map.getCenter(), map.getZoom()));
map.on("error", (event) => console.warn(event.error.message));

await map.once("idle");
```

`once` returns a promise, so you can await it. `off(type, listener)` removes a listener.

- `styleload`: a style has been applied. `event.skipped` lists anything in a MapLibre or Mapbox style that Maplet left out because it can't draw it yet. `load`: the first frame with it has been drawn.
- `idle`: everything on screen has loaded and nothing is moving.
- `render` after every frame, `resize` when the map changes size, `remove` when it's removed.
- `movestart`, `move` and `moveend` whenever the camera changes. There are also `zoom`, `rotate` and `pitch` versions of all three. `originalEvent` is the mouse, touch, wheel or keyboard event when a person caused the move, and `undefined` when your code did.
- `boxzoomstart`, `boxzoomend` and `boxzoomcancel` around a Shift-drag box zoom.
- `wheel` before the wheel zooms the map; `event.preventDefault()` stops the zoom. `dragstart`, `drag` and `dragend` around a pan with the mouse or a finger. `touchstart`, `touchmove`, `touchend` and `touchcancel` carry `points` and `lngLats` for every finger, plus `point` and `lngLat` for the middle of them.
- `styledata` when the style changes, and `data` whenever the style or a source changes, with `dataType` set to `"style"` or `"source"`.
- `click`, `dblclick`, `contextmenu`, `mousemove`, `mousedown`, `mouseup` and `mouseout` (the pointer left the map) carry `point` (`{ x, y }`) and `lngLat`. Call `event.preventDefault()` in `dblclick` to stop the zoom, or in `mousedown` to keep that press from moving the map.
- `sourcedata` when a source loads (`kind: "metadata"`), gets new data (`"content"`) or fails (`"error"`).
- `styleimagemissing` when a layer needs an [image](#images) that hasn't been added.
- `error` with a `MapletError` in `event.error`.
- `contextlost` and `contextrestored` if the browser drops the GPU context. Maplet reloads what it needs on its own.

A listener can also watch one layer, or a list of them. It only fires when the pointer is over a feature in those layers, and `event.features` lists what's there, top layer first:

```js
map.on("click", "parks", (event) => console.log(event.features[0].properties.name));
map.on("mouseenter", "parks", () => (map.getCanvas().style.cursor = "pointer"));
map.on("mouseleave", "parks", () => (map.getCanvas().style.cursor = ""));
```

`mouseenter` fires when the pointer moves onto the layers, and `mouseleave` when it moves off them or out of the map. Moving from one feature to another in the same layer fires neither; listen for `mousemove` on the layer if you need that. `mouseover` and `mouseout` are other names for the same pair. `click`, `dblclick`, `contextmenu`, `mousedown` and `mouseup` work on layers too, and `off` and `once` take the same layer argument.

`event.preventDefault()` in a layer's `mousedown` keeps the map still for that press, which is how you let people drag features around. In `dblclick` it stops the zoom. Finding the features under the pointer happens on the GPU, so layer listeners run a frame or so after the pointer event. That's too late to stop what the browser itself does with the event, but the map waits for them before it pans or zooms.

## Finding features

```js
map.on("click", async (event) => {
  const [feature] = await map.queryRenderedFeatures(event.point);
  if (feature) console.log(feature.layer, feature.properties);
});
```

`queryRenderedFeatures(point)` returns the features drawn under a point, top layer first. It sees exactly what's on screen, including line widths, circle sizes, labels and 3D buildings. Give it two points, `[[x1, y1], [x2, y2]]`, to search a box, or nothing to search the whole view, and pass `{ layers: ["roads"] }` to look at certain layers only. It returns a promise because some of the data lives in a worker.

Each result has `id`, `properties`, `geometry` in longitude and latitude, `layer`, `source`, `sourceLayer` and `state`, the feature's [state](#highlighting-features). Features from vector tiles come back cut at the tile edge; GeoJSON features come back whole.

`querySourceFeatures(sourceId, { sourceLayer, filter })` returns everything a source has loaded for the current view, drawn or not. For vector tiles that's every feature in the visible tiles, so a feature that crosses a tile edge can come back more than once, cut at each edge. For GeoJSON each feature comes back once and whole, and a clustered source returns the clusters you'd see at the current zoom. `filter` is an [expression](style.md#expressions), the same as a layer filter.

For the height of the ground, ask an elevation source: `map.getSource("dem").elevationAt(event.lngLat)` returns meters, or `null` where no elevation tile is loaded.

## Highlighting features

Feature state is a small set of values your code attaches to a feature, such as `hover` or `selected`. Paint properties read it with `["feature-state", "hover"]`, and changing it repaints the map without rebuilding any tiles, so it's the quick way to highlight things as the pointer moves.

```js
map.addSource("parks", { type: "geojson", data: "parks.geojson", generateId: true });
map.addLayer({
  id: "parks",
  type: "fill",
  source: "parks",
  paint: { color: ["case", ["boolean", ["feature-state", "hover"], false], "#2e8b57", "#9fd5a8"] },
});

let hovered;
map.on("mousemove", "parks", (event) => {
  const id = event.features[0].id;
  if (id === hovered) return;
  if (hovered !== undefined) map.setFeatureState({ source: "parks", id: hovered }, { hover: false });
  hovered = id;
  map.setFeatureState({ source: "parks", id }, { hover: true });
});
map.on("mouseleave", "parks", () => {
  if (hovered !== undefined) map.setFeatureState({ source: "parks", id: hovered }, { hover: false });
  hovered = undefined;
});
```

A feature needs an id for this. Vector tiles usually come with one. In GeoJSON, give each feature an `id`, name a property to use with `promoteId`, or set `generateId: true` to number the features in order. Ids can be numbers or strings. For vector sources, also pass the `sourceLayer`.

`getFeatureState(feature)` returns a copy of a feature's state. `removeFeatureState(feature, "hover")` removes one value, `removeFeatureState(feature)` removes them all, and `removeFeatureState({ source: "parks" })` clears the whole source. State stays until you remove it, even while the feature is off screen, and goes away with its source or when the style changes.

Only paint properties can use `feature-state`. Filters and layout properties decide how tiles are built, so the style check rejects it there.

## Terrain

```js
map.setTerrain({ source: "dem", exaggeration: 1.5 });
map.setTerrain(null);
```

`setTerrain` turns 3D terrain on with an elevation source from the style, or off again with `null`. `getTerrain()` returns the current setting. While terrain is on, `project`, `unproject`, pointer events and `queryRenderedFeatures` all work on the raised ground, so `event.lngLat` is the spot on the hillside under the pointer. [The style guide](style.md#terrain) explains what changes on screen.

## Sky

```js
map.setSky({ color: "#88c6fc", horizonColor: "#ffffff" });
map.setSky(null);
```

`setSky` sets the colors of the sky and the haze you see over the distant ground on a tilted map, and `null` goes back to the sky Maplet picks to suit the style. `getSky()` returns what the style set. [The style guide](style.md#sky) lists the settings.

## Day and night

```js
map.setSun({ time: "now" });
map.setSun({ time: new Date("2026-12-21T16:00:00Z"), twilight: 6 });
map.setSun(null);
```

`setSun` lights the map by the sun at a date and time, with night and twilight where the sun is down, and `null` turns it off. `time` takes `"now"`, a `Date`, text like `"2026-06-21T20:00:00Z"` or milliseconds. `getSun()` returns the setting. [The style guide](style.md#day-and-night) lists the options.

`sunPosition(time)` gives you where the sun is overhead at a moment, as `{ declination, subsolarLng }` in degrees, and `sunAltitude(position, lng, lat)` and `sunAzimuth(position, lng, lat)` tell you how high it stands at a place and in which direction, in degrees from north.

## Errors

Errors come with a `code`, a readable `message` and a `detail` object. If you don't listen for `error`, they're logged to the console.

`invalid-style` means the style has problems (`detail.issues` lists them all) and `invalid-option` means a bad map option or argument. `source-error` is a source that couldn't load, and `tile-error` a tile that still failed after its retries (`detail.tile` says which one). Requests fail with `network`, `http` or `auth`; 401 and 403 answers aren't retried. `decode` means data arrived but couldn't be read. `webgl-unavailable`, `shader-compile`, `context-lost` and `worker` point at the browser or GPU.

## Controls

```js
map.addControl(new maplet.NavigationControl());
map.addControl(new maplet.ScaleControl({ unit: "imperial" }), "bottom-left");
```

`NavigationControl` has zoom buttons and a compass that turns the map back north and flat. Pass `showZoom: false` or `showCompass: false` to leave one out. `ScaleControl` takes `unit` (`"metric"` or `"imperial"`) and `maxWidth` in pixels. The attribution control is added for you.

`FullscreenControl` fills the screen with the map, or with the element you pass as `container`. Browsers without the Fullscreen API, such as Safari on iPhone, get the same effect by stretching the map over the page. It fires `fullscreenstart` and `fullscreenend`, and `isFullscreen()` tells you which state it's in.

`GeolocateControl` asks the browser where the person is, flies there and marks the spot with a dot and a circle for how accurate the reading is:

```js
const locate = new maplet.GeolocateControl({ trackUserLocation: true });
map.addControl(locate);
locate.on("geolocate", ({ position }) => console.log(position.coords.latitude, position.coords.longitude));
```

With `trackUserLocation: true` the map keeps following as the person moves, until they pan away; pressing the button again brings the view back, and once more turns tracking off. `positionOptions` goes straight to the browser, `fitBoundsOptions` controls the flight (`maxZoom` is 15), and `showUserLocation: false` or `showAccuracyCircle: false` hide the markers. The control fires `geolocate`, `error`, `trackuserlocationstart` and `trackuserlocationend`, `trigger()` presses the button from code, and `getState()` returns `off`, `waiting`, `active`, `background` or `error`. Browsers only share the location over HTTPS and after asking the person.

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

## Markers and popups

```js
const popup = new maplet.Popup().setText("Pike Place Market");
new maplet.Marker().setLngLat([-122.342, 47.609]).setPopup(popup).addTo(map);
```

A marker keeps a pin, or an element of your own, on a place while the map moves. Clicking it opens its popup, and so does Enter or Space once it has keyboard focus. Pass `element` to use your own HTML instead of the pin, or `color` and `scale` to change the pin. `anchor` says which part of the marker sits on the place: `center`, `top`, `bottom`, `left`, `right` or a corner such as `bottom-left`. The pin uses `bottom` and your own elements `center`. `offset` nudges it by `[x, y]` pixels.

With `draggable: true` people can move the marker. It fires `dragstart`, `drag` and `dragend`, and `getLngLat()` tells you where it ended up. `rotation` turns it, in degrees. With `rotationAlignment: "map"` it turns along with the map, and with `pitchAlignment: "map"` it lies flat when the map tilts. When terrain hides a marker it fades to `occludedOpacity`, 0.2 unless you change it. Every option has a setter too, such as `setLngLat`, `setDraggable` or `setRotation`, and `remove()` takes the marker off the map.

A popup is a small card that points at a place. It doesn't need a marker:

```js
map.on("click", "parks", (event) => {
  new maplet.Popup()
    .setLngLat(event.lngLat)
    .setHTML(`<strong>${event.features[0].properties.name}</strong>`)
    .addTo(map);
});
```

`setText` shows plain text, `setHTML` simple formatted HTML, and `setDOMContent` an element you built. `setHTML` keeps text formatting, lists, tables, images and links, and drops scripts, styles, event handlers and anything else that could run code, so it's safe to fill with text from your data. For anything it doesn't allow, build the element yourself and use `setDOMContent`.

Popups close when someone clicks the map, presses the × button or presses Escape inside them, and when you call `remove()`. `closeOnClick: false` and `closeButton: false` switch the first two off, and `closeOnMove: true` also closes the popup when the map starts moving. A popup opens on the side with the most room unless you set `anchor`, and `offset` moves it away from the point: a number, `[x, y]`, or one value per anchor. `maxWidth` is `"240px"` unless you say otherwise. `trackPointer()` makes the popup follow the mouse instead of a place. Popups fire `open` and `close`, and `isOpen()` tells you which state they're in.

For screen readers, a marker with a popup acts as a button and a popup is a labelled dialog. Focus moves into a popup when it opens, unless you pass `focusAfterOpen: false`, and goes back to its marker when it closes. The labels come from the map's `locale` option.

## Images

```js
const image = await map.loadImage("icons/cafe.png");
map.addImage("cafe", image);
map.addLayer({ id: "cafes", type: "symbol", source: "places", layout: { icon: "cafe", text: ["get", "name"], anchor: "top", offset: [0, 1] } });
```

`addImage(name, image, options)` takes an `<img>` that has finished loading, a canvas, an `ImageBitmap`, an `ImageData`, or `{ width, height, data }` with RGBA bytes. Pass `pixelRatio: 2` for an image drawn at double resolution, and `sdf: true` for a distance field that `iconColor` can paint. For icons that stretch around their text with `iconTextFit`, `stretchX` and `stretchY` name the pixel ranges that may grow, like `[[4, 28]]`, and `content: [left, top, right, bottom]` is the part the text goes in, so the rounded corners of a road shield keep their shape. Sprite sheets can carry the same three fields for each image. `loadImage(url)` fetches an image the same way tiles are fetched, so `transformRequest` applies to it.

`updateImage(name, image)` swaps the pixels, which is how you animate an icon. `hasImage`, `removeImage` and `listImages` do what they say. Images you add stay through `setStyle`; images from a style's sprite are replaced by the new style's.

When a layer asks for an image that doesn't exist, the map fires `styleimagemissing` with the `id`. Add the image in the listener and it appears straight away, which lets you draw icons on demand:

```js
map.on("styleimagemissing", ({ id }) => {
  if (id.startsWith("dot-")) map.addImage(id, drawDot(id.slice(4)));
});
```

## Tile files from the user's computer

`maplet.openTileFile(file)` takes a PMTiles or MBTiles `File` (from a file input or a drop) and gives you back a URL to use as a source. Nothing is uploaded; tiles are read straight from the file as the map needs them.

```js
const url = await maplet.openTileFile(input.files[0]);
map.addSource("mine", { type: "vector", url });
```

Once a tile source has loaded, its `bounds` tell you the area the file covers, as `[west, south, east, north]`, so `map.fitBounds(map.getSource("mine").bounds)` takes you there. It's `null` for files that cover the whole world or don't say.

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

`map.getDiagnostics()` returns numbers for tracking down slow maps: frame times (`p50`, `p95`, `p99` and `max` over the last 240 frames), draw calls, requests in flight, worker queue length, `blankRatio` (how much of the screen is still waiting for data) and per-source tile counts with retries, cancellations and cache size. With terrain on, `terrain` says how many ground tiles are drawn, how much GPU memory their textures take and how many were redrawn in the last frame.

For a closer look at what the map is doing, set `map.showTileBoundaries = true` to outline the tiles of the first source with their `z/x/y` names, `map.showCollisionBoxes = true` to outline the space each label and icon claims, and `map.showPadding = true` to show the [padding](#moving-the-camera) and the center it leaves. They're drawn on a separate layer over the map, so turning them off leaves the map exactly as it was.

## Other helpers

`lightStyle(options)` is the built-in street style, described at the end of the [style guide](style.md#the-built-in-style). `validateStyle(style)` returns a list of `{ path, message }` problems. `distanceMeters(a, b)` measures between two positions, `metersPerPixel(latitude, zoom)` tells you how much ground one pixel covers, and `lngLatToWorld` and `worldToLngLat` convert to and from Web Mercator coordinates between 0 and 1. `version` is the library version.

A few smaller methods round things out: `getContainer()`, `getCanvas()`, `resize()` (rarely needed, since the map watches its own size), `getPixelRatio()`, `setPixelRatio()`, `triggerRepaint()`, `loaded()` and `getAttributions()`.
