# Switching from MapLibre or Mapbox

Mapkern ships a second entry point that speaks the MapLibre GL JS and Mapbox GL JS API. Code written for either library runs on it with the import changed, and you can move parts of an app to the native Mapkern API later, or never.

## Changing the import

```js
import maplibregl from "mapkern-gl/maplibre";
```

Mapbox code imports `mapkern-gl/mapbox` instead. Both entries are the same thing under two names, so pick whichever matches the variable your code already uses. Named imports work too: `import { Map, Popup } from "mapkern-gl/maplibre"`.

If your app imports `maplibre-gl` in many files, a bundler alias saves editing them. With Vite:

```js
export default {
  resolve: { alias: [{ find: /^maplibre-gl$/, replacement: "mapkern-gl/maplibre" }] },
};
```

Remove `import "maplibre-gl/dist/maplibre-gl.css"`, or point it at `mapkern-gl/maplibre.css`. Mapkern adds its styles to the page by itself, so the stylesheet is only there for builds that expect a CSS import.

Pages that load the library with a script tag can use `dist/maplibre.global.js`, which defines `window.maplibregl`, or `dist/mapbox.global.js`, which defines `window.mapboxgl`.

## What stays the same

Layers, sources and filters use the version 8 style format, with the same property names (`line-color`, `text-field`, `raster-opacity`). `getStyle()`, `getLayer()` and `getPaintProperty()` hand back what you gave them, in that format. Styles can be URLs or objects, `setStyle()` diffs by default and takes `transformStyle`.

`getCenter()` and `unproject()` return `LngLat`, `getBounds()` returns `LngLatBounds` and `project()` returns `Point`, with the methods and fields MapLibre code expects, `_sw` and `_ne` included. Events have the usual names (`style.load`, `sourcedata`, `webglcontextlost`) and carry `lngLat`, `point` and `features`. `on()` returns a subscription with `unsubscribe()` and can still be chained, and `once()` without a listener returns a promise. `jumpTo()` fires its move events before it returns.

`queryRenderedFeatures()` returns its results right away, for vector tiles and GeoJSON alike, and each feature carries the layer it came from. `querySourceFeatures()` works the same way.

`addProtocol()` accepts handlers in both styles, the promise one from MapLibre 4 and later and the older callback one, and they can return an `ArrayBuffer`, a `Blob`, an image, a string or a JSON object. Handlers you register win over Mapkern's own, so a `pmtiles` protocol from the pmtiles package keeps working.

Markers, popups and the standard controls take MapLibre's options. Their elements carry both the `.maplibregl-*` and `.mapboxgl-*` class names, and so do the map, canvas and control corners, so your CSS overrides still apply. Controls you write yourself get the MapLibre-style map in `onAdd`.

## What works differently

Mapkern draws Web Mercator only. `setProjection({ type: "globe" })` keeps a flat map and says so once in the console, and `GlobeControl` adds nothing.

Custom layers (`type: "custom"`) are accepted but not drawn yet. Overlays such as deck.gl's `MapboxOverlay` in its default overlaid mode work, because they draw on their own canvas.

Anything in a style that Mapkern can't draw is left out, and the reason is written to the console once, starting with "Mapkern left out". Mapbox-hosted data behind `mapbox://` addresses can't be read.

Labels use the browser's own text drawing, so Arabic, Hebrew and other right-to-left scripts come out right without a plugin. `setRTLTextPlugin()` resolves at once and does nothing. `setWorkerUrl()` and `prewarm()` do nothing either, because Mapkern carries its worker inside the library.

Properties of GeoJSON features come back from queries as they were, so nested objects stay objects instead of turning into JSON strings.

`Popup.setHTML()` puts your HTML in the popup as given, like MapLibre does, so only pass it markup you trust. The native `mapkern.Popup` cleans HTML first.

The field of view is MapLibre's 36.87 degrees, so tilted views and anything drawn over the map line up the same way. The native map uses a slightly wider default; `setVerticalFieldOfView()` changes either.

## Mixing in the native API

The native Mapkern exports are under `maplibregl.mapkern`, so you can reach things MapLibre doesn't have, such as `readFeatures()` for KML, GPX and Shapefiles or `openTileFile()` for archives the user picks. `map.native` is the Mapkern map underneath, with Mapkern's own calls and data shapes.
