# Building tiles from OpenStreetMap

`maplet-tiles` turns an OpenStreetMap extract into one `.pmtiles` file with vector tiles from zoom 0 to 14. The built-in `lightStyle` is made for these tiles.

## Build a file

1. Download an extract in `.osm.pbf` format. [Geofabrik](https://download.geofabrik.de/) has one for every country and many regions. Pick the smallest one that covers your area.
2. Run the builder with the area you want, as `west,south,east,north` in degrees:

   ```sh
   npx maplet-tiles --input washington-latest.osm.pbf --bbox=-122.45,47.48,-122.22,47.74 --output seattle.pmtiles
   ```

   Write `--bbox=` with an equals sign. Without it, a bounding box that starts with a minus sign is read as an option.

3. Serve the file from any web server that supports HTTP range requests, and load it:

   ```js
   const map = new Map({ container: "map", style: lightStyle({ url: "seattle.pmtiles" }) });
   ```

In a clone of this repository, `npm run tiles -- <options>` runs the same builder.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--input` | | The `.osm.pbf` file |
| `--bbox` | | Area to build: `west,south,east,north` |
| `--output` | | The `.pmtiles` file to write |
| `--maxzoom` | 14 | Highest zoom level to build, up to 16. The map scales the last level up when you zoom in further |
| `--name` | the output file name | Name stored in the file |
| `--threads` | all cores | Threads used to read the input |

### Time and memory

The builder reads the whole input file but keeps only what falls in the area. Building the Seattle and Tacoma region (about 130 by 145 km) from the 19 GB North America extract took 13 minutes on a 4 core desktop and wrote a 137 MB file. A city from a state or country extract takes seconds to a few minutes.

Memory use grows with the number of features in the area, not with the size of the input file.

### Damaged downloads

Large downloads sometimes end up incomplete. The builder notices damaged parts of the input, prints a warning with the byte position, skips them and builds the rest. Download the file again if the warning appears.

## Using the data

The file contains these layers. Use the layer name as `sourceLayer` in your own styles.

| Layer | Geometry | From zoom | Fields |
| --- | --- | --- | --- |
| `water` | polygons | 0 | `class`: `ocean`, `lake`, `reservoir`, `basin`, `river`. `intermittent`: 1 |
| `waterway` | lines | 8 | `class`: `river`, `canal`, `stream`, `ditch`, `drain`. `name`, `name_en`, `brunnel`, `intermittent` |
| `landcover` | polygons | 5 | `class`: `wood`, `grass`, `scrub`, `wetland`, `sand`, `rock`, `ice`, `farmland`. `subclass` for wetlands |
| `landuse` | polygons | 6 | `class`: `residential`, `commercial`, `retail`, `industrial`, `railway`, `cemetery`, `military`, `quarry`, `construction`, `farmland`, `religious`, `park`, `pitch`, `golf`, `school`, `hospital`, `parking`, `airport`, `pier`, `pedestrian` |
| `park` | polygons | 5 | `class`: `national_park`, `nature_reserve`, `protected_area`. `name`, `name_en` |
| `boundary` | lines | 0 | `admin_level`: 2 (countries) to 8 (cities). `maritime`: 1 at sea. `disputed`: 1 |
| `aeroway` | lines and polygons | 10 | `class`: `runway`, `taxiway`, `apron`. `name`, `name_en` |
| `road` | lines | 4 | See [Roads](#roads) |
| `railway` | lines | 9 | `class`: `rail`, `light_rail`, `subway`, `tram`, `narrow_gauge`, `monorail`, `funicular`, `preserved`. `name`, `name_en`, `brunnel`, `service`, `layer` |
| `building` | polygons | 13 | `height` and `min_height` in meters when known. `part`: 1 for building parts |
| `place` | points | 2 | `class`: `country`, `state`, `province`, `city`, `town`, `village`, `suburb`, `quarter`, `neighbourhood`, `hamlet`, `locality`, `island`, `islet`, `isolated_dwelling`. `name`, `name_en`, `rank`, `capital`, `population` |
| `poi` | points | 8 | `class`: the OpenStreetMap key, such as `amenity`, `shop`, `tourism` or `leisure`. `subclass`: its value, such as `cafe`. `name`, `name_en`, `rank` |
| `water_name` | points | 8 | `class`: `bay`, `strait`, `sea`, `ocean` or a water class. `name`, `name_en` |
| `mountain_peak` | points | 8 | `class`: `peak`, `volcano`. `name`, `name_en`, `ele` in meters |
| `housenumber` | points | 14 | `housenumber` |

`name` is the local name. `name_en` is the English name when it is different.

`rank` orders places and points of interest by importance. Lower numbers are more important and appear at lower zooms.

`brunnel` is `bridge`, `tunnel` or `ford`.

### Roads

| Field | Values |
| --- | --- |
| `class` | `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `minor`, `service`, `track`, `path` |
| `subclass` | For `path` and `service`: `footway`, `cycleway`, `steps`, `driveway`, `parking_aisle` and other OpenStreetMap values |
| `ramp` | 1 for motorway and other links |
| `brunnel` | `bridge`, `tunnel`, `ford` |
| `oneway` | 1 or -1 |
| `layer` | -5 to 5, from the OpenStreetMap `layer` tag |
| `surface` | `paved` or `unpaved` |
| `name`, `name_en`, `ref` | Street name and route number |

Major roads appear from zoom 4. Residential streets appear from 12 and footpaths from 14.

### Detail by zoom

Features appear when they are large enough to see. Small lakes, parks and buildings are left out at low zooms, and lines and polygons are simplified to the precision of the zoom level. At zoom 14 the tiles keep full detail, so zooming further in stays sharp.

## License of the data

Tiles built from OpenStreetMap data are covered by the [Open Database License](https://www.openstreetmap.org/copyright). When you show them, credit "© OpenStreetMap contributors". The builder stores this credit in the file, and Maplet shows it in the attribution control.
