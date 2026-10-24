# Styles

A style tells Maplet what data to load and how to draw it. You pass it to the map as an object, or as the URL of a JSON file.

```js
const style = {
  version: 1,
  sources: {
    places: { type: "geojson", data: "places.geojson" },
  },
  layers: [
    { id: "background", type: "background", paint: { color: "#f4f3ef" } },
    { id: "places", type: "circle", source: "places", paint: { radius: 6, color: "#e4572e" } },
  ],
};
```

A style can also set `center`, `zoom`, `bearing` and `pitch`. The map uses them when you don't pass those options yourself.

Maplet checks the whole style before drawing it. If something is wrong you get a single `error` event that lists every problem, like `layers[2].paint.colour: "colour" is not a property of fill layers`. `validateStyle(style)` runs the same check without a map.

## Sources

### Vector tiles

```js
osm: { type: "vector", url: "seattle.pmtiles" }
roads: { type: "vector", tiles: ["https://example.com/tiles/{z}/{x}/{y}.pbf"], maxZoom: 14 }
```

`url` can point to a `.pmtiles` file or a TileJSON document. `tiles` takes one or more URL templates. Besides `{z}`, `{x}` and `{y}`, templates understand `{-y}`, `{quadkey}` and `{bbox-epsg-3857}` for servers that number tiles differently.

The other options are `minZoom` and `maxZoom` (0 and 14 unless the file says otherwise), `bounds` as `[west, south, east, north]` to skip requests outside an area, `scheme: "tms"` for tile sets numbered from the south, `attribution` for the credit line, and `promoteId` to use one of the feature's properties as its id. Anything you set in the style wins over what the file says.

When you zoom past `maxZoom`, Maplet keeps drawing the last level, scaled up.

### Raster tiles

```js
imagery: { type: "raster", tiles: ["https://example.com/imagery/{z}/{x}/{y}.jpg"], tileSize: 256, maxZoom: 19 }
```

Raster sources take the same options as vector ones, minus `promoteId`, plus `tileSize`, which is 256 unless you change it. Any image the browser can decode works. `maxZoom` defaults to 22 here.

### GeoJSON

```js
stations: { type: "geojson", data: "stations.geojson" }
```

`data` is a GeoJSON object or a URL. Maplet cuts the data into tiles in a worker, so even large files stay smooth to pan around. You can change the data later with [`setData()`](api.md#geojson).

A few options control how the tiles are made. `maxZoom` (18) is the last zoom level that gets its own tiles. `tolerance` (0.375) is how far, in pixels, lines and polygons may be simplified when zoomed out; 0 keeps every point. `buffer` (64) is how far each tile reaches past its edge, in pixels of a 512 pixel tile. Raise it if you draw very wide lines or big circles and see them cut off at tile edges. `attribution` and `promoteId` work as for vector tiles.

Polygon rings can wind either way, and shapes that cross the 180th meridian show up on both sides of it.

## Layers

Every layer has an `id` and a `type`. Layers that draw data also name a `source`, and for vector tiles a `sourceLayer`, which is the layer inside the tiles. Layers are drawn in order, so later ones end up on top.

Any layer can have a `filter` (an expression; only features where it's true get drawn), `minZoom` and `maxZoom` to hide it outside a zoom range, and `visible: false` to hide it altogether. Fill, line and circle layers can also have a `sortKey` expression: features with a higher value are drawn over the others.

Drawing settings go in `paint`, and settings that change the shape of what's drawn, like line caps or label text, go in `layout`. Most of them can be a fixed value or an [expression](#expressions). In the tables below, "per feature" means the value can come from feature data. Everything can depend on zoom.

### background

Fills the whole map with one color. It's usually the first layer.

| Paint | Default |
| --- | --- |
| `color` | `#000000` |
| `opacity` | 1 |

### raster

| Paint | Default | |
| --- | --- | --- |
| `opacity` | 1 | |
| `brightnessMin`, `brightnessMax` | 0, 1 | Squeeze the brightness range, from 0 to 1 |
| `contrast` | 0 | From -1 to 1 |
| `saturation` | 0 | From -1 (grey) to 1 |
| `hueRotate` | 0 | In degrees |
| `fadeDuration` | 200 | How long new tiles take to fade in, in ms. Fixed value only |
| `resampling` | `linear` | Or `nearest` for sharp pixels. Fixed value only |

### fill

Draws polygons.

| Paint | Default | |
| --- | --- | --- |
| `color` | `#000000` | per feature |
| `opacity` | 1 | per feature |
| `outlineColor` | the fill color | per feature. The thin line around each polygon |
| `antialias` | `true` | Draws that outline, which also smooths the edges. Fixed value only |
| `translate` | `[0, 0]` | Shift in pixels. Fixed value only |

### line

Draws lines, and the edges of polygons.

| Paint | Default | |
| --- | --- | --- |
| `color` | `#000000` | per feature |
| `width` | 1 | per feature, in pixels |
| `opacity` | 1 | per feature |
| `blur` | 0 | per feature. Softens the edges, in pixels |
| `dash` | none | A pattern like `[2, 1]`, measured in line widths. Fixed value only |

| Layout | Default | |
| --- | --- | --- |
| `cap` | `butt` | Or `round`, `square` |
| `join` | `miter` | Or `round`, `bevel` |
| `miterLimit` | 2 | Sharp corners longer than this many widths are cut off |

### circle

Draws a circle at each point.

| Paint | Default | |
| --- | --- | --- |
| `radius` | 5 | per feature, in pixels |
| `color` | `#000000` | per feature |
| `opacity` | 1 | per feature |
| `strokeColor` | `#000000` | per feature |
| `strokeWidth` | 0 | per feature, in pixels |
| `blur` | 0 | per feature. Softens the edge, in pixels |

### symbol

Draws text. When labels would overlap, the one with the lower `priority` is hidden.

| Layout | Default | |
| --- | --- | --- |
| `text` | empty | per feature. Usually `["get", "name"]` |
| `size` | 14 | per feature, in pixels |
| `priority` | 0 | per feature. Higher wins |
| `font` | `["sans-serif"]` | Font families to try in order. Labels use fonts installed on the device |
| `weight` | `normal` | Or `bold` |
| `italic` | `false` | |
| `placement` | `point` | `line` makes the text follow the line |
| `anchor` | `center` | Which side of the text sits on the point: `top`, `bottom`, `left` or `right` |
| `offset` | `[0, 0]` | Shift, measured in font sizes |
| `maxWidth` | 10 | Wrap point labels after this many font sizes |
| `letterSpacing` | 0 | Extra space between letters, in font sizes |
| `padding` | 2 | Space kept clear around the label, in pixels |
| `spacing` | 250 | Distance between repeats of a line label, in pixels |
| `allowOverlap` | `false` | Show the label even when it collides |
| `transform` | `none` | Or `uppercase`, `lowercase` |

| Paint | Default | |
| --- | --- | --- |
| `color` | `#000000` | per feature |
| `haloColor` | transparent | per feature |
| `haloWidth` | 0 | per feature |
| `opacity` | 1 | per feature |

## Colors

Anything CSS accepts: `#2f6fdb`, `#2f6fdb80`, `rgb(47, 111, 219)`, `rgba(47, 111, 219, 0.5)`, `hsl(218, 70%, 52%)`, `transparent`, or a color name like `steelblue`.

## Expressions

An expression is an array that starts with the name of an operation. Maplet works out its value for each feature and zoom level.

```js
["get", "name"]
["match", ["get", "class"], "motorway", "#e8a33d", "primary", "#f4c46a", "#ffffff"]
["interpolate", ["linear"], ["zoom"], 10, 1, 16, 8]
```

The first one reads a property. The second picks a color by road class, with white for everything else. The third makes something 1 pixel wide at zoom 10 and 8 pixels wide at zoom 16, growing smoothly in between.

`interpolate` also takes `["exponential", 1.5]` for a curve that speeds up, and `["cubic-bezier", x1, y1, x2, y2]` like a CSS easing. It works on numbers and colors. `step` jumps instead of blending:

```js
["step", ["zoom"], "#999999", 12, "#555555", 15, "#222222"]
```

Here's what else is available:

- Reading data: `get`, `has`, `properties`, `id`, `geometry-type` (`"Point"`, `"LineString"` or `"Polygon"`), `zoom`, and `literal` for arrays and objects you want used as-is.
- Decisions: `==`, `!=`, `<`, `<=`, `>`, `>=`, `all`, `any`, `none`, `!`, `in`, `match`, `case` and `coalesce`. In `match`, a label can be a list of values.
- Math: `+`, `-`, `*`, `/`, `%`, `^`, `abs`, `min`, `max`, `round`, `floor`, `ceil`, `sqrt`, `ln`, `log10`, `log2`, `sin`, `cos`, `tan`, `pi` and `e`.
- Text: `concat`, `upcase`, `downcase`, `length` and `slice`.
- Types: `to-string`, `to-number`, `to-boolean`, `to-color`, `rgb`, `rgba` and `typeof`.

A filter is just an expression that comes out true or false:

```js
{
  id: "major-roads",
  type: "line",
  source: "osm",
  sourceLayer: "road",
  filter: ["all", ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]], ["!=", ["get", "brunnel"], "tunnel"]],
  paint: { color: "#e8a33d", width: ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 10] },
}
```

## The built-in style

`lightStyle()` gives you a complete street map style for tiles made with `maplet-tiles`:

```js
const style = lightStyle({ url: "seattle.pmtiles" });
```

You can turn off parts of it with `labels: false` or `buildings: false`, choose label fonts with `font`, and replace the credit line with `attribution`. If your tiles come from a URL template instead of a file, pass `tiles` (and `maxZoom` if it isn't 14).

It returns a normal style object, so you can change it before using it:

```js
style.layers = style.layers.filter((layer) => layer.id !== "poi-label");
```
