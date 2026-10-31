# Tiles

`mapkern-tiles` turns an OpenStreetMap download into a single `.pmtiles` file with vector tiles for zoom 0 to 14. The built-in `lightStyle` is made to draw these tiles, but you can style them any way you like. It also makes [elevation tiles](#elevation) from GeoTIFF files and a [search index](#search-index) for finding places and addresses.

## Making a file

Get an extract in `.osm.pbf` format first. [Geofabrik](https://download.geofabrik.de/) has one for every country and many smaller regions, and the smallest one that covers your area will be the quickest to work with. Then give the builder the area you want as `west,south,east,north`:

```sh
npx mapkern-tiles --input washington-latest.osm.pbf --bbox=-122.45,47.48,-122.22,47.74 --output seattle.pmtiles
```

Keep the `=` after `--bbox`. Without it, a box that starts with a minus sign gets mistaken for another option.

You can also pass `--maxzoom` (14 by default, 16 at most), `--name` to label the file, and `--threads` to limit how many cores it uses. Inside a clone of this repository, `npm run tiles -- <options>` does the same thing.

Already have tiles in an MBTiles file? Mapkern can show those directly, but a PMTiles file loads faster from a web server. To convert one:

```sh
npx mapkern-tiles convert roads.mbtiles roads.pmtiles
```

The builder reads the whole download but only keeps what's inside your box, so the time depends mostly on the size of the download. A city cut from a state or country extract takes seconds to a few minutes. The Seattle and Tacoma area cut from the 19 GB North America file took 13 minutes on a 4-core desktop and came out at 137 MB. Memory use depends on how much is inside the box, not on the size of the download.

Big downloads sometimes arrive damaged. If the builder finds a broken part, it warns you with the byte position, skips that part and builds the rest. Download the file again if you see that warning.

To use the result, put it on a web server that supports range requests (most static hosts do) and load it:

```js
const map = new mapkern.Map({ container: "map", style: mapkern.lightStyle({ url: "seattle.pmtiles" }) });
```

## What's inside

Each tile has the layers below. Use the layer name as `sourceLayer` when you write your own styles. A layer only starts showing up at the zoom in the second column, and small things like ponds, parks and buildings are left out until they're big enough to see.

| Layer | From zoom | Fields |
| --- | --- | --- |
| `water` | 0 | `class` is `ocean`, `lake`, `reservoir`, `basin` or `river`. `intermittent` is 1 for seasonal water |
| `waterway` | 8 | Rivers and streams as lines. `class` is `river`, `canal`, `stream`, `ditch` or `drain`. Also `name`, `brunnel`, `intermittent` |
| `landcover` | 5 | `class` is `wood`, `grass`, `scrub`, `wetland`, `sand`, `rock`, `ice` or `farmland` |
| `landuse` | 6 | `class` is `residential`, `commercial`, `retail`, `industrial`, `railway`, `cemetery`, `military`, `quarry`, `construction`, `farmland`, `religious`, `park`, `pitch`, `golf`, `school`, `hospital`, `parking`, `airport`, `pier` or `pedestrian` |
| `park` | 5 | Protected areas. `class` is `national_park`, `nature_reserve` or `protected_area`, plus `name` |
| `boundary` | 0 | `admin_level` from 2 (countries) to 8 (cities). `maritime` and `disputed` are 1 where they apply |
| `aeroway` | 10 | `class` is `runway`, `taxiway` or `apron` |
| `road` | 4 | See below |
| `railway` | 9 | `class` is `rail`, `light_rail`, `subway`, `tram`, `narrow_gauge`, `monorail`, `funicular` or `preserved`. Also `name`, `brunnel`, `service`, `layer` |
| `building` | 12 | `height` and `min_height` in meters when OpenStreetMap has them. `part` is 1 for building parts |
| `place` | 2 | City, town and neighborhood points. `class` is the OpenStreetMap place type, plus `name`, `rank`, `capital` and `population` |
| `poi` | 8 | Shops, cafes, schools and so on. `class` is the OpenStreetMap key (`amenity`, `shop`, `tourism`...) and `subclass` its value (`cafe`, `bakery`...). Also `name` and `rank` |
| `water_name` | 8 | Points for naming lakes, bays and seas |
| `mountain_peak` | 8 | `class` is `peak` or `volcano`, plus `name` and `ele` in meters |
| `housenumber` | 14 | `housenumber` |

Anything with a name has `name`, the local name, and `name_en` when the English name is different. `rank` puts places and points of interest in order of importance, with lower numbers showing up earlier as you zoom in. `brunnel` is `bridge`, `tunnel` or `ford`.

Roads have the most fields. `class` is `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `minor`, `service`, `track` or `path`, and paths and service roads get a `subclass` such as `footway`, `cycleway`, `steps` or `driveway`. `ramp` is 1 on links and slip roads, `oneway` is 1 or -1, `layer` runs from -5 to 5, `surface` is `paved` or `unpaved`, and `name` and `ref` carry the street name and route number. Motorways show up from zoom 4, residential streets from 12 and footpaths from 14.

Lines and shapes are simplified to what each zoom level can show, and below zoom 14 the pieces of a road that share the same fields are joined into one line. To keep zoomed-out tiles small, roads and railways leave out `oneway`, `surface` and `layer` below zoom 13, and their names below zoom 12. Zoom 14 keeps everything at full detail, so the map stays sharp when you zoom in further.

## Elevation

`mapkern-tiles dem` turns elevation GeoTIFFs into a file for hillshading and 3D terrain:

```sh
npx mapkern-tiles dem rainier.tif --output terrain.pmtiles
```

Give it one file or several. Where they overlap, the first one wins. The files can be in longitude and latitude, UTM or Web Mercator, and compressed with deflate, LZW or PackBits, or not compressed. Heights in feet are converted to meters, and pixels marked as no-data stay empty, so the map knows there's nothing there.

The top zoom level is picked to match the detail in your files, and each level below it is averaged from the one above, down to zoom 0. `--maxzoom` and `--minzoom` set the range yourself, and `--name` labels the file. The tiles are 512 pixel Terrarium PNGs, which is what an elevation source reads by default:

```js
dem: { type: "dem", url: "terrain.pmtiles" }
```

A 1536 by 1536 pixel file at about 13 m per pixel takes six seconds and comes out at 3 MB.

## Search index

`mapkern-tiles search` reads the same OpenStreetMap file and writes an index for [search](api.md#search):

```sh
npx mapkern-tiles search --input washington-latest.osm.pbf --bbox=-123.05,46.95,-122.75,47.15 --output olympia.search
```

It keeps towns and neighborhoods, every address with a house number and street, named streets and paths (the pieces of one street become a single result), and named businesses, parks, schools, rivers and other places, each with its category. Every entry knows its town, state and country from the boundaries in the data, so results read like "Olympia, Washington 98501, United States". The boundaries of the states and countries around your box are read in full, even where they lie outside it.

The Olympia box above holds about 94,000 entries. Most of the time goes into reading the PBF: the whole North America file takes about twelve minutes, so a state extract is much quicker. Serve the file like any other, or let the person open it from their device, and load it with `SearchIndex.load`.

For the whole world, `--world` keeps only towns, villages, neighborhoods, islands, states and countries, airports (also found by their IATA and ICAO codes) and other places notable enough to have a Wikidata link, with every name the data has in other languages. Pass each continent file with its own `--input`; places that appear in two files are kept once:

```sh
npx mapkern-tiles search --world --input africa-latest.osm.pbf --input asia-latest.osm.pbf ... --output world.search
```

Where a file cuts through a country's border, the pieces are joined up so places near the edge still get their state and country.

## Road graph

`mapkern-tiles route` turns the same OpenStreetMap file into a road graph for [directions](api.md#directions):

```sh
npx mapkern-tiles route --input north-america-latest.osm.pbf --bbox=-123.4,46.8,-121.7,48.1 --output puget.route
```

It keeps every road, path and trail someone can drive, cycle or walk on, with which way traffic may go for each, speed limits, roundabouts, tolls, names and route numbers. Turn restrictions that turn at a junction ("no left turn", "only straight on") are kept for each kind of traffic they apply to; the rare ones that run through a whole stretch of road are left out, and the builder says how many.

The box above, from Olympia to Everett, holds 1.6 million road pieces and comes out at 45 MB, most of it the shape of each road. Serve it with gzip left as it is; Mapkern unpacks it in the browser.

## Credit

OpenStreetMap data is shared under the [Open Database License](https://www.openstreetmap.org/copyright), which asks you to credit "© OpenStreetMap contributors" wherever the map is shown. The builder stores that line in the file and Mapkern puts it in the corner of the map for you.
