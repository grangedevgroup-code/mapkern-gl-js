<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/maplet-logo-white.svg">
    <img src="assets/maplet-logo-black.svg" alt="Maplet" width="280">
  </picture>
</p>

# Maplet GL JS

Maplet GL JS draws interactive maps in the browser with WebGL2. It renders vector tiles, raster tiles and GeoJSON, keeps the map covered while new tiles load, and has no runtime dependencies. The whole library is about 77 KB gzipped.

![Seattle at a 50 degree tilt, drawn by Maplet](assets/screenshot-seattle.webp)

<sub>Map data © OpenStreetMap contributors</sub>

## Quick start

Install from GitHub:

```sh
npm install github:grangedevgroup-code/maplet-gl-js
```

Show a map with your own points. This needs no tile server and no API key:

```html
<div id="map" style="position: absolute; inset: 0"></div>
<script type="module">
  import { Map, NavigationControl } from "maplet-gl";

  const map = new Map({
    container: "map",
    center: [-122.335, 47.608],
    zoom: 13,
    style: {
      version: 1,
      sources: {
        stops: {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { name: "Pike Place Market" },
                geometry: { type: "Point", coordinates: [-122.3422, 47.6097] },
              },
              {
                type: "Feature",
                properties: { name: "Space Needle" },
                geometry: { type: "Point", coordinates: [-122.3493, 47.6205] },
              },
            ],
          },
        },
      },
      layers: [
        { id: "background", type: "background", paint: { color: "#eef1ef" } },
        { id: "stops", type: "circle", source: "stops", paint: { radius: 7, color: "#246a50" } },
        {
          id: "stop-names",
          type: "symbol",
          source: "stops",
          layout: { text: ["get", "name"], anchor: "top", offset: [0, 0.8] },
          paint: { color: "#10191d", haloColor: "#ffffff", haloWidth: 1.5 },
        },
      ],
    },
  });

  map.addControl(new NavigationControl());
</script>
```

Without a bundler, import `dist/maplet.js` by path instead of `"maplet-gl"`, and serve the page over HTTP. Browsers do not load modules from `file://` pages.

## Add a basemap

Maplet can build its own vector tiles from OpenStreetMap data, so you do not need a tile service.

1. Download an `.osm.pbf` extract for your region, for example from [Geofabrik](https://download.geofabrik.de/).
2. Build a tile file for the area you need. The `maplet-tiles` command comes with the package:

   ```sh
   npx maplet-tiles --input washington-latest.osm.pbf --bbox=-122.45,47.48,-122.22,47.74 --output seattle.pmtiles
   ```

3. Put `seattle.pmtiles` on any web server that supports range requests, and use the built-in style:

   ```js
   import { Map, lightStyle } from "maplet-gl";

   const map = new Map({
     container: "map",
     style: lightStyle({ url: "seattle.pmtiles" }),
     center: [-122.335, 47.608],
     zoom: 12,
   });
   ```

The light style shows `© OpenStreetMap contributors` in the corner. Keep it visible: the OpenStreetMap license requires it.

[docs/tiles.md](docs/tiles.md) covers the tile builder and the layers and fields it writes.

## What it does

- Vector tiles in the Mapbox Vector Tile format, from PMTiles archives or `{z}/{x}/{y}` URLs
- Raster tiles in PNG, JPEG or WebP
- GeoJSON, cut into tiles in a worker. `setData()` swaps the data without a blank frame
- Labels at points and along lines, with collision checks and fading
- Zoom, pan, rotation and tilt with mouse, touch and keyboard
- Smooth `easeTo` and `flyTo` camera moves
- Expressions for data-driven styling: `match`, `case`, `interpolate`, `step` and more
- A tile loader that keeps the screen covered: parent and child tiles fill in while tiles load, requests are ranked by what is on screen, failed requests are retried with backoff, and requests that are no longer needed are cancelled
- Tile decoding and geometry building in Web Workers
- `getDiagnostics()` for frame times, tile states, requests and blank screen area

3D buildings, terrain and hillshading are in progress. The API may change before version 1.0.

## Documentation

- [Getting started](docs/getting-started.md)
- [Style reference](docs/style.md)
- [API reference](docs/api.md)
- [Building tiles from OpenStreetMap](docs/tiles.md)

## Browser support

Maplet needs WebGL2. It runs in current Chrome, Edge, Firefox and Safari 16.4 or newer, on desktop and mobile.

## Development

You need Node.js 22.18 or newer.

```sh
npm install
npm run dev            # builds, watches src and serves http://127.0.0.1:8080/examples/
npm run verify         # lint, type check and unit tests
npm run test:browser   # renders test maps in Chrome and checks the pixels
npm run build          # writes dist/
npm run tiles -- --help
```

## License

MIT. See [LICENSE](LICENSE).
