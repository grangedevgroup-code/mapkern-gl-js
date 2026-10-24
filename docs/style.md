# Style reference

A style is a JSON object that says which data to load and how to draw it. Pass it to `new Map({ style })` or `map.setStyle()`, or pass the URL of a JSON file.

```json
{
  "version": 1,
  "center": [-122.335, 47.608],
  "zoom": 12,
  "sources": {
    "places": { "type": "geojson", "data": "places.geojson" }
  },
  "layers": [
    { "id": "background", "type": "background", "paint": { "color": "#f4f3ef" } },
    { "id": "places", "type": "circle", "source": "places", "paint": { "radius": 6, "color": "#e4572e" } }
  ]
}
```

Maplet checks the whole style before it draws anything. If something is wrong, the map emits one `error` event that lists every problem with its path, for example `layers[2].paint.colour: unknown paint property "colour"`. You can run the same check yourself with `validateStyle(style)`.

## Top level

| Key | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Required. The style format version |
| `name` | string | Optional name |
| `center` | `[lng, lat]` | Starting position, used when the map options do not set one |
| `zoom` | number | Starting zoom |
| `bearing` | number | Starting rotation in degrees, clockwise from north |
| `pitch` | number | Starting tilt in degrees, 0 looks straight down |
| `sources` | object | Data sources by id |
| `layers` | array | Layers, drawn in order from first to last |

## Sources

### `vector`

Vector tiles in the Mapbox Vector Tile format.

```json
{ "type": "vector", "url": "https://example.com/city.pmtiles" }
{ "type": "vector", "tiles": ["https://example.com/tiles/{z}/{x}/{y}.pbf"], "maxZoom": 14 }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | | A `.pmtiles` file, a `pmtiles://` URL or a TileJSON document |
| `tiles` | | One or more tile URL templates. Use `url` or `tiles` |
| `minZoom` | 0 | Lowest zoom level with tiles |
| `maxZoom` | 14 | Highest zoom level with tiles. Maplet scales up the last level when you zoom in further |
| `bounds` | whole world | `[west, south, east, north]`. No tiles are requested outside it |
| `scheme` | `"xyz"` | `"tms"` if the y axis of the tile grid points north |
| `attribution` | | Text or HTML links shown in the attribution control |
| `promoteId` | | Feature property to use as the feature id |

A PMTiles file or TileJSON can supply `minZoom`, `maxZoom`, `bounds` and `attribution`. Values in the style win.

Tile URL templates can use `{z}`, `{x}`, `{y}`, `{-y}` (the TMS row), `{quadkey}` and `{bbox-epsg-3857}` (for WMS servers).

### `raster`

Image tiles in any format the browser can decode: PNG, JPEG, WebP or AVIF.

```json
{ "type": "raster", "tiles": ["https://example.com/imagery/{z}/{x}/{y}.jpg"], "tileSize": 256, "maxZoom": 19 }
```

It takes the same keys as `vector` except `promoteId`, plus `tileSize` (default 256), the size of one tile in pixels.

### `geojson`

GeoJSON from an object or a URL. Maplet cuts it into tiles in a worker.

```json
{ "type": "geojson", "data": "https://example.com/stations.geojson" }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `data` | | Required. A GeoJSON object or a URL |
| `maxZoom` | 18 | Tiles are cut up to this zoom. Above it, the last level is scaled up |
| `tolerance` | 0.375 | How much lines and polygons are simplified at lower zooms, in pixels. 0 keeps every point |
| `buffer` | 64 | How far each tile reaches past its edge, in pixels of a 512 pixel tile. Raise it for very wide lines or large circles |
| `attribution` | | Text shown in the attribution control |
| `promoteId` | | Feature property to use as the feature id |

Maplet accepts `FeatureCollection`, `Feature`, bare geometries and `GeometryCollection`. Polygon rings can wind either way. Features that cross the 180th meridian are drawn on both sides of it.

To change the data later, call `setData()` on the source. See the [API reference](api.md#geojson-sources).

## Layers

Every layer has an `id` and a `type`. Layers that draw data also have a `source`.

| Key | Meaning |
| --- | --- |
| `id` | Unique name |
| `type` | `background`, `raster`, `fill`, `line`, `circle` or `symbol` |
| `source` | Id of the source to draw from |
| `sourceLayer` | For vector tile sources, the layer inside the tiles. Not used with GeoJSON |
| `filter` | An expression. Only features where it is true are drawn |
| `minZoom` | The layer is hidden below this zoom |
| `maxZoom` | The layer is hidden at and above this zoom |
| `visible` | `false` hides the layer. Default `true` |
| `paint` | Colours, widths and other drawing properties |
| `layout` | Properties that change the geometry, such as line caps or label text |
| `sortKey` | `fill`, `line` and `circle` only. An expression; features with a higher value are drawn on top |

Most paint and layout values can be a constant or an [expression](#expressions). The tables below mark which properties can use feature data. All of them can depend on zoom.

### `background`

Fills the whole map. It is drawn below everything else in the layer list.

| Paint | Default |
| --- | --- |
| `color` | `"#000000"` |
| `opacity` | 1 |

### `raster`

| Paint | Default | Meaning |
| --- | --- | --- |
| `opacity` | 1 | |
| `brightnessMin` | 0 | Maps black to this brightness, 0 to 1 |
| `brightnessMax` | 1 | Maps white to this brightness, 0 to 1 |
| `contrast` | 0 | -1 to 1 |
| `saturation` | 0 | -1 to 1. -1 is greyscale |
| `hueRotate` | 0 | Degrees |
| `fadeDuration` | 200 | Fade-in time for new tiles in milliseconds. Constant only |
| `resampling` | `"linear"` | `"linear"` or `"nearest"`. Constant only |

### `fill`

Draws polygons.

| Paint | Default | Feature data | Meaning |
| --- | --- | --- | --- |
| `color` | `"#000000"` | yes | |
| `opacity` | 1 | yes | |
| `outlineColor` | none | yes | Draws a one pixel outline in this colour |
| `translate` | `[0, 0]` | | Offset in pixels. Constant only |
| `antialias` | `true` | | Smooths the outline. Constant only |

### `line`

Draws lines, and the outlines of polygons.

| Paint | Default | Feature data | Meaning |
| --- | --- | --- | --- |
| `color` | `"#000000"` | yes | |
| `width` | 1 | yes | Pixels |
| `opacity` | 1 | yes | |
| `blur` | 0 | yes | Softens the edges, in pixels |
| `dash` | none | | Dash pattern in multiples of the line width, for example `[2, 1]`. Constant only |

| Layout | Default | Values |
| --- | --- | --- |
| `cap` | `"butt"` | `"butt"`, `"round"`, `"square"` |
| `join` | `"miter"` | `"miter"`, `"round"`, `"bevel"` |
| `miterLimit` | 2 | Sharp corners longer than this many widths become bevels |

### `circle`

Draws a circle at every point.

| Paint | Default | Feature data | Meaning |
| --- | --- | --- | --- |
| `radius` | 5 | yes | Pixels |
| `color` | `"#000000"` | yes | |
| `opacity` | 1 | yes | |
| `strokeColor` | `"#000000"` | yes | |
| `strokeWidth` | 0 | yes | Pixels |
| `blur` | 0 | yes | Softens the edge, in pixels |

### `symbol`

Draws text labels. Labels that would overlap are hidden, starting with the lowest `priority`.

| Layout | Default | Feature data | Meaning |
| --- | --- | --- | --- |
| `text` | `""` | yes | The label. Usually `["get", "name"]` |
| `size` | 14 | yes | Font size in pixels |
| `priority` | 0 | yes | Higher values win when labels collide |
| `font` | `["sans-serif"]` | | Font families in order of preference. Maplet uses fonts installed on the device |
| `weight` | `"normal"` | | `"normal"` or `"bold"` |
| `italic` | `false` | | |
| `placement` | `"point"` | | `"point"` or `"line"`. Line labels follow the line |
| `anchor` | `"center"` | | Which part of the label sits on the point: `"center"`, `"top"`, `"bottom"`, `"left"`, `"right"` |
| `offset` | `[0, 0]` | | Shift in multiples of the font size |
| `maxWidth` | 10 | | Wrap point labels after this many font sizes |
| `letterSpacing` | 0 | | Extra space between letters, in multiples of the font size |
| `padding` | 2 | | Empty space kept around the label, in pixels |
| `spacing` | 250 | | Distance between repeated line labels, in pixels |
| `allowOverlap` | `false` | | Draw the label even when it collides |
| `transform` | `"none"` | | `"none"`, `"uppercase"`, `"lowercase"` |

| Paint | Default | Feature data |
| --- | --- | --- |
| `color` | `"#000000"` | yes |
| `haloColor` | transparent | yes |
| `haloWidth` | 0 | yes |
| `opacity` | 1 | yes |

## Colors

Colors are CSS color strings: `"#2f6fdb"`, `"#2f6fdb80"`, `"rgb(47, 111, 219)"`, `"rgba(47, 111, 219, 0.5)"`, `"hsl(218, 70%, 52%)"`, `"transparent"` and the CSS color names such as `"steelblue"`.

## Expressions

An expression is an array whose first item names an operation. Expressions compute a value from the zoom level and the feature being drawn.

```json
["get", "name"]
["match", ["get", "class"], "motorway", "#e8a33d", "primary", "#f4c46a", "#ffffff"]
["interpolate", ["linear"], ["zoom"], 10, 1, 16, 8]
```

### Data

| Expression | Result |
| --- | --- |
| `["get", key]` | The value of a feature property |
| `["has", key]` | `true` if the feature has the property |
| `["properties"]` | All properties as an object |
| `["id"]` | The feature id |
| `["geometry-type"]` | `"Point"`, `"LineString"` or `"Polygon"` |
| `["zoom"]` | The current zoom level |
| `["literal", value]` | The value as written, for arrays and objects |

### Decisions

| Expression | Result |
| --- | --- |
| `["==", a, b]`, `["!=", a, b]` | Equality |
| `["<", a, b]`, `["<=", a, b]`, `[">", a, b]`, `[">=", a, b]` | Comparison |
| `["all", ...]`, `["any", ...]`, `["none", ...]` | And, or, neither |
| `["!", value]` | Not |
| `["in", value, list]` | `true` if the list or string contains the value |
| `["match", input, label, output, ..., fallback]` | The output for the first label equal to the input. A label can be a list of values |
| `["case", condition, output, ..., fallback]` | The output for the first true condition |
| `["coalesce", a, b, ...]` | The first value that is not null |

### Ramps

`interpolate` blends between stops. `step` jumps from one stop to the next.

```json
["interpolate", ["linear"], ["zoom"], 5, 0.5, 12, 2, 16, 6]
["interpolate", ["exponential", 1.5], ["zoom"], 10, 1, 18, 20]
["interpolate", ["cubic-bezier", 0.4, 0, 0.6, 1], ["get", "population"], 0, 4, 1000000, 12]
["step", ["zoom"], "#999999", 12, "#555555", 15, "#222222"]
```

Colors interpolate too.

### Math

`+`, `-`, `*`, `/`, `%`, `^`, `abs`, `min`, `max`, `round`, `floor`, `ceil`, `sqrt`, `ln`, `log10`, `log2`, `sin`, `cos`, `tan`, `pi`, `e`

### Text

`concat`, `upcase`, `downcase`, `length`, `slice`

### Types

`to-string`, `to-number`, `to-boolean`, `to-color`, `rgb`, `rgba`, `typeof`, `string`, `number`, `boolean`, `color`

`["string", value, fallback]` and the other type checks return the first argument that has the right type.

## Filters

A filter is an expression that returns `true` or `false`.

```json
{
  "id": "major-roads",
  "type": "line",
  "source": "osm",
  "sourceLayer": "road",
  "filter": ["all", ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]], ["!=", ["get", "brunnel"], "tunnel"]],
  "paint": { "color": "#e8a33d", "width": ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 10] }
}
```

## The built-in style

`lightStyle(options)` returns a complete style for tiles made by `maplet-tiles`.

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | | A `.pmtiles` file or TileJSON URL |
| `tiles` | | Tile URL templates, instead of `url` |
| `maxZoom` | 14 | Highest zoom level in the tiles |
| `attribution` | `© OpenStreetMap contributors` | Credit shown in the corner |
| `labels` | `true` | Include place, road, water and point of interest labels |
| `buildings` | `true` | Include buildings |
| `font` | system sans-serif fonts | Font families for labels |

The result is a plain style object, so you can change it before you use it:

```js
const style = lightStyle({ url: "seattle.pmtiles" });
style.layers = style.layers.filter((layer) => layer.id !== "poi-label");
const map = new Map({ container: "map", style });
```
