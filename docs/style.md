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

A style can also set `center`, `zoom`, `bearing` and `pitch`. The map uses them when you don't pass those options yourself. With `terrain` it raises the ground in 3D, see [Terrain](#terrain), and `sprite` loads a sheet of icons, see [Icons](#icons).

Maplet checks the whole style before drawing it. If something is wrong you get a single `error` event that lists every problem, like `layers[2].paint.colour: "colour" is not a property of fill layers`. `validateStyle(style)` runs the same check without a map.

## Sources

### Vector tiles

```js
osm: { type: "vector", url: "seattle.pmtiles" }
roads: { type: "vector", tiles: ["https://example.com/tiles/{z}/{x}/{y}.pbf"], maxZoom: 14 }
```

`url` can point to a `.pmtiles` or `.mbtiles` file, or to a TileJSON document. Tile files are read with range requests, so the server has to support them, which nearly every static host does. `tiles` takes one or more URL templates. Besides `{z}`, `{x}` and `{y}`, templates understand `{-y}`, `{quadkey}` and `{bbox-epsg-3857}` for servers that number tiles differently.

The other options are `minZoom` and `maxZoom` (0 and 14 unless the file says otherwise), `bounds` as `[west, south, east, north]` to skip requests outside an area, `scheme: "tms"` for tile sets numbered from the south, `attribution` for the credit line, and `promoteId` to use one of the feature's properties as its id. `promoteId` is a property name, or an object such as `{ "buildings": "osm_id", "roads": "ref" }` to pick a different property in each source layer. Anything you set in the style wins over what the file says.

When you zoom past `maxZoom`, Maplet keeps drawing the last level, scaled up.

### Raster tiles

```js
imagery: { type: "raster", tiles: ["https://example.com/imagery/{z}/{x}/{y}.jpg"], tileSize: 256, maxZoom: 19 }
```

Raster sources take the same options as vector ones, minus `promoteId`, plus `tileSize`, which is 256 unless you change it. Any image the browser can decode works. `maxZoom` defaults to 22 here.

### Elevation

```js
dem: { type: "dem", url: "terrain.pmtiles" }
```

Elevation tiles are PNG or WebP images with a height for every pixel, packed into the red, green and blue channels. Maplet uses them to shade hills with a [hillshade](#hillshade) layer. `encoding` says how the heights are packed. The two common ways are `"terrarium"`, the default, and `"mapbox"`. For anything else, give the numbers yourself: `{ red, green, blue, offset }` means height in meters = red × R + green × G + blue × B + offset, with R, G and B from 0 to 255. Terrarium is `{ red: 256, green: 1, blue: 1 / 256, offset: -32768 }` and mapbox is `{ red: 6553.6, green: 25.6, blue: 0.1, offset: -10000 }`.

Fully transparent pixels mean there's no data, and so do heights below -11,000 m, deeper than any place on Earth. That catches Terrarium files that mark missing data as black. Heights are used as they're stored, usually meters above sea level, and Maplet doesn't convert between vertical datums.

The other options work as for raster tiles, except that `tileSize` is 512 and `maxZoom` 15 unless you say otherwise. Tiles have to be square.

`map.getSource("dem").elevationAt([lng, lat])` gives you the height at a place, in meters. It reads the tiles that are loaded at that moment, so it returns `null` for places off screen or without data.

### GeoJSON

```js
stations: { type: "geojson", data: "stations.geojson" }
```

`data` is a GeoJSON object or a URL. Maplet cuts the data into tiles in a worker, so the page stays responsive while it works. You can change the data later with [`setData()`](api.md#geojson).

A few options control how the tiles are made. `maxZoom` (18) is the last zoom level that gets its own tiles. `tolerance` (0.375) is how far, in pixels, lines and polygons may be simplified when zoomed out; 0 keeps every point. `buffer` (64) is how far each tile reaches past its edge, in pixels of a 512 pixel tile. Raise it if you draw very wide lines or big circles and see them cut off at tile edges. `attribution` and `promoteId` work as for vector tiles, except that `promoteId` is always a single property name here. `generateId: true` numbers the features 0, 1, 2 and so on, in the order they appear, which is handy for [feature state](api.md#highlighting-features) when the data has no ids of its own.

Polygon rings can wind either way, and shapes that cross the 180th meridian show up on both sides of it.

With `cluster: true`, points that are close together on screen join into one point that stands for all of them, and come apart again as you zoom in:

```js
stations: { type: "geojson", data: "stations.geojson", cluster: true, clusterRadius: 50, clusterMaxZoom: 14 }
```

A cluster has the properties `cluster` (true), `cluster_id`, `point_count` and `point_count_abbreviated`, such as `"1.2k"`, so you style clusters and single points as separate layers by filtering on `["has", "point_count"]`. `clusterRadius` (50) is how close, in pixels, points have to be to join. `clusterMaxZoom` is the last zoom level that has clusters, one below the source's `maxZoom` unless you say otherwise. `clusterMinPoints` (2) is the smallest group that becomes a cluster. Lines and polygons in the same data aren't clustered and draw as usual.

`clusterProperties` adds up values from the points in each cluster. Each entry is an operator and an expression for a single point:

```js
clusterProperties: {
  riders: ["+", ["get", "riders"]],
  busiest: ["max", ["get", "riders"]],
}
```

The operator can be any expression that combines two values, written with `["accumulated"]` for the total so far and `["get", name]` for the next value, such as `[["concat", ["accumulated"], ", ", ["get", "names"]], ["get", "name"]]`.

Despite the name, a GeoJSON source reads other formats too: KML and KMZ, GPX, CSV, TopoJSON, Shapefiles (zipped together with their `.dbf`, `.prj` and `.cpg` files), FlatGeobuf and WKT. Maplet works out the format from the file itself, so `data: "trails.gpx"` or `data: "parcels.zip"` just works. If it guesses wrong, set `format` to one of `geojson`, `topojson`, `kml`, `kmz`, `gpx`, `csv`, `shapefile`, `flatgeobuf` or `wkt`.

A few notes on what comes through:

- KML styles become `stroke`, `stroke-width`, `fill`, `fill-opacity` and `marker-color` properties, so you can use them in paint expressions like `["get", "stroke"]`.
- CSV files need a header row and either latitude and longitude columns (`lat`/`latitude`/`y` and `lon`/`lng`/`longitude`/`x`) or a WKT column. Numbers come through as numbers, unless they have leading zeros.
- Shapefiles and FlatGeobuf files in UTM, a Transverse Mercator or Lambert state plane zone, or Web Mercator are converted to longitude and latitude using the `.prj` file or the EPSG code. Other projections are reported as errors. Datum shifts aren't applied, which can move data in older datums such as NAD27 by up to about 100 m.

## Layers

Every layer has an `id` and a `type`: `background`, `raster`, `hillshade`, `fill`, `line`, `circle`, `extrusion` or `symbol`. Layers that draw data also name a `source`, and for vector tiles a `sourceLayer`, which is the layer inside the tiles. Layers are drawn in order, so later ones end up on top.

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

### hillshade

Shades the ground from an [elevation](#elevation) source as if it were lit from one side, so hills and valleys stand out.

```js
{ id: "hills", type: "hillshade", source: "dem", paint: { exaggeration: 0.4 } }
```

| Paint | Default | |
| --- | --- | --- |
| `exaggeration` | 0.5 | How strong the shading is, from 0 to 1 |
| `shadowColor` | `#000000` | For slopes that face away from the light |
| `highlightColor` | `#ffffff` | For slopes that face the light |
| `accentColor` | `#000000` | Darkens steep slopes, whichever way they face |
| `illuminationDirection` | 335 | Where the light comes from, in degrees clockwise from the top of the screen. 335 is the top left. Fixed value only |
| `illuminationAnchor` | `viewport` | `viewport` keeps the light on the same side of the screen when you rotate the map, `map` turns it with the map, so 0 is north. Fixed value only |

Flat ground stays clear, so the layer works on top of land and water fills. Put it below roads and labels. When you zoom out, slopes are steepened a little so mountain ranges stay visible.

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

### extrusion

Raises polygons into 3D shapes, usually buildings. Walls are shaded by the direction they face, and the light stays put relative to the screen while you rotate the map.

```js
{
  id: "buildings-3d",
  type: "extrusion",
  source: "osm",
  sourceLayer: "building",
  minZoom: 15,
  paint: {
    color: "#e3dfd7",
    height: ["coalesce", ["get", "height"], 6],
    base: ["coalesce", ["get", "min_height"], 0],
  },
}
```

| Paint | Default | |
| --- | --- | --- |
| `color` | `#000000` | per feature |
| `height` | 0 | per feature, in meters |
| `base` | 0 | per feature. Where the shape starts, in meters, for things like overhangs and building parts |
| `opacity` | 1 | For the whole layer. Below 1 you see the map through the buildings, but not their inside walls |

Put extrusion layers after your roads and point layers, so buildings hide what's behind them. Labels drawn later stay on top.

### symbol

Draws text, icons, or both. When symbols would overlap, the one with the lower `priority` is hidden.

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
| `optional` | `false` | With an icon, show the icon alone when the text doesn't fit |
| `icon` | none | per feature. The name of an [image](#icons), such as `"cafe"` or `["get", "kind"]` |
| `iconSize` | 1 | per feature. Scales the image |
| `iconRotate` | 0 | per feature, in degrees clockwise |
| `iconAnchor` | `center` | Which part of the icon sits on the point: `top`, `bottom`, `left`, `right` or a corner like `bottom-left` |
| `iconOffset` | `[0, 0]` | Shift in pixels, before `iconSize` |
| `iconPadding` | 2 | Space kept clear around the icon, in pixels |
| `iconAllowOverlap` | `false` | Show the icon even when it collides |
| `iconOptional` | `false` | Show the text alone when the icon doesn't fit |
| `iconRotationAlignment` | `auto` | `map` turns icons with the map, `viewport` keeps them upright. `auto` means `map` on lines and `viewport` on points |

| Paint | Default | |
| --- | --- | --- |
| `color` | `#000000` | per feature |
| `haloColor` | transparent | per feature |
| `haloWidth` | 0 | per feature |
| `opacity` | 1 | per feature |
| `iconOpacity` | 1 | per feature |
| `iconColor` | `#000000` | per feature, for SDF icons only |
| `iconHaloColor` | transparent | per feature, for SDF icons only |
| `iconHaloWidth` | 0 | per feature, in pixels, for SDF icons only |

A symbol with both an icon and text needs room for both, unless you set `optional` or `iconOptional`. On lines, icons sit at each repeat and turn with the line, which is how one-way arrows are drawn.

## Icons

Icons come from images you add with [`map.addImage`](api.md#images), or from a sprite: one PNG holding many icons, with a JSON file that says where each one is.

```js
{ version: 1, sprite: "https://example.com/sprites/streets", sources: { ... }, layers: [ ... ] }
```

Maplet loads `streets.json` and `streets.png`, or `streets@2x.json` and `streets@2x.png` on high-density screens when they exist. The JSON maps each name to `{ x, y, width, height, pixelRatio, sdf }`. To use several sheets, give a list instead, `[{ id: "roads", url: "..." }, { id: "poi", url: "..." }]`, and refer to icons as `roads:shield` or `poi:cafe`. A sheet with the id `default` keeps plain names.

The `image` expression checks that an image exists, which is handy for a fallback: `["coalesce", ["image", ["get", "kind"]], ["image", "dot"]]` shows a generic dot for kinds you have no icon for.

SDF icons are stored as a distance field instead of colors. They stay sharp at any size, and `iconColor` and `iconHaloColor` paint them, so one image can serve many colors.

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

`interpolate-lab` and `interpolate-hcl` blend colors the way people see them, so a ramp from yellow to blue doesn't go muddy grey in the middle. `interpolate-hcl` keeps colors saturated by going around the color wheel.

Here's what else is available:

- Reading data: `get`, `has`, `properties`, `id`, `geometry-type` (`"Point"`, `"LineString"` or `"Polygon"`), `zoom`, `feature-state`, and `literal` for arrays and objects you want used as-is.
- Decisions: `==`, `!=`, `<`, `<=`, `>`, `>=`, `all`, `any`, `none`, `!`, `in`, `match`, `case` and `coalesce`. In `match`, a label can be a list of values.
- Math: `+`, `-`, `*`, `/`, `%`, `^`, `abs`, `min`, `max`, `round`, `floor`, `ceil`, `sqrt`, `ln`, `log10`, `log2`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `pi`, `e` and `ln2`.
- Text: `concat`, `upcase`, `downcase`, `length`, `slice`, `index-of`, `split` and `number-format`.
- Lists: `at`, `index-of`, `length` and `slice`.
- Types: `to-string`, `to-number`, `to-boolean`, `to-color`, `typeof`, and `number`, `string`, `boolean`, `array` and `object`, which return the first of their arguments that has that type, or `null`.
- Images: `image`, which returns the name of an [icon](#icons) when it exists and `null` when it doesn't.
- Colors: `rgb`, `rgba`, `hsl`, `hsla`, `to-rgba` and `to-hsla`.
- Names: `let` and `var`, for working something out once and using it twice.

A few of these deserve an example:

```js
["let", "area", ["*", ["get", "width"], ["get", "depth"]], ["case", [">", ["var", "area"], 500], 1, ["/", ["var", "area"], 500]]]
["number-format", ["get", "price"], { "locale": "en-US", "currency": "USD" }]
["case", ["boolean", ["feature-state", "selected"], false], "#d33", "#888"]
```

`number-format` also takes `min-fraction-digits` and `max-fraction-digits`, and leaves out `locale` to use the reader's own. `feature-state` reads the state your code [sets on a feature](api.md#highlighting-features), and works in paint properties only. `is-supported-script` is there for styles written for other map libraries and always returns `true`, since Maplet draws every script the browser can.

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

## Terrain

Add `terrain` to a style and the ground rises in 3D, using an [elevation](#elevation) source:

```js
const style = {
  version: 1,
  sources: {
    dem: { type: "dem", url: "terrain.pmtiles" },
    osm: { type: "vector", url: "seattle.pmtiles" },
  },
  terrain: { source: "dem", exaggeration: 1.2 },
  layers: [],
};
```

`exaggeration` stretches the heights and is 1 unless you set it. You can also turn terrain on and off while the map runs with [`setTerrain()`](api.md#terrain).

Everything flat gets drawn onto the ground: fills, lines, circles, rasters and hillshading. Labels and 3D buildings stand on it, and labels behind a hill are hidden. Where there's no elevation data the ground stays flat at sea level.

When you drag the map over mountains, the camera keeps its height, so the zoom level changes a little as the ground in the middle of the map rises and falls. `jumpTo`, `easeTo` and `flyTo` end at exactly the zoom you ask for, measured from the ground.

On steep slopes the roofs of 3D buildings follow the slope instead of staying flat.

## The built-in style

`lightStyle()` gives you a complete street map style for tiles made with `maplet-tiles`:

```js
const style = maplet.lightStyle({ url: "seattle.pmtiles" });
```

Tall buildings stand up in 3D from zoom 12, and all the others join them at zoom 13. Pass `buildings: "flat"` to keep them flat or `buildings: false` to leave them out, and `labels: false` to drop the labels. Give it `elevation` with the URL of an elevation file to shade the hills, and add `terrain: true`, or an exaggeration like `terrain: 1.5`, to raise them in 3D. You can choose label fonts with `font`, and replace the credit line with `attribution`. If your tiles come from a URL template instead of a file, pass `tiles` (and `maxZoom` if it isn't 14).

It returns a normal style object, so you can change it before using it:

```js
style.layers = style.layers.filter((layer) => layer.id !== "poi-label");
```
