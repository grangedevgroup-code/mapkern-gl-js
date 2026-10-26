import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { convertMbtiles } from "./convert.ts";
import { buildDem } from "./dem.ts";
import { extractRegion } from "./extract.ts";
import { buildFeatures, regionRect } from "./features.ts";
import { Compression, PMTilesWriter, TileType } from "./pmtiles-writer.ts";
import type { Entry } from "./search.ts";
import { collectEntries, writeSearchIndex } from "./search.ts";
import { buildTiles } from "./tiler.ts";

const FIELDS: Record<string, Record<string, string>> = {
  water: { class: "String", intermittent: "Number" },
  waterway: { class: "String", name: "String", name_en: "String", brunnel: "String", intermittent: "Number" },
  landcover: { class: "String", subclass: "String" },
  landuse: { class: "String" },
  park: { class: "String", name: "String", name_en: "String" },
  boundary: { admin_level: "Number", maritime: "Number", disputed: "Number" },
  aeroway: { class: "String", name: "String", name_en: "String" },
  road: {
    class: "String",
    subclass: "String",
    name: "String",
    name_en: "String",
    ref: "String",
    ramp: "Number",
    brunnel: "String",
    oneway: "Number",
    layer: "Number",
    surface: "String",
  },
  railway: {
    class: "String",
    name: "String",
    name_en: "String",
    brunnel: "String",
    service: "String",
    layer: "Number",
  },
  building: { height: "Number", min_height: "Number", part: "Number" },
  place: {
    class: "String",
    name: "String",
    name_en: "String",
    rank: "Number",
    capital: "Number",
    population: "Number",
  },
  poi: { class: "String", subclass: "String", name: "String", name_en: "String", rank: "Number" },
  water_name: { class: "String", name: "String", name_en: "String" },
  mountain_peak: { class: "String", name: "String", name_en: "String", ele: "Number" },
  housenumber: { housenumber: "String" },
};

const HELP = `Build a vector tile archive (.pmtiles) or a search index from an OpenStreetMap
.osm.pbf file, turn elevation GeoTIFFs into elevation tiles, or convert an MBTiles file to PMTiles.

Usage:
  mapkern-tiles --input <file.osm.pbf> --bbox=<west,south,east,north> --output <file.pmtiles>
  mapkern-tiles search --input <file.osm.pbf> --bbox=<west,south,east,north> --output <file.search>
  mapkern-tiles search --world --input <file.osm.pbf> [--input ...] --output world.search
  mapkern-tiles dem <file.tif>... --output <file.pmtiles>
  mapkern-tiles convert <file.mbtiles> <file.pmtiles>

Options:
  --input     OpenStreetMap PBF file, for example a Geofabrik extract; search takes several
  --world     search only: towns, states, countries, airports and notable places from
              the whole file, instead of everything inside --bbox
  --bbox      Area to build, in degrees: west,south,east,north.
              Write it as --bbox=-123.4,46.8,-121.7,48.1 when it starts with a minus sign.
  --output    Output .pmtiles file
  --maxzoom   Highest zoom level to build (default 14, or the detail of the files for dem)
  --minzoom   Lowest zoom level for dem (default 0)
  --name      Name stored in the archive metadata
  --threads   Worker threads for reading the PBF (default: all cores)
`;

async function main(): Promise<void> {
  if (process.argv[2] === "dem") {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(3),
      allowPositionals: true,
      options: {
        output: { type: "string" },
        minzoom: { type: "string" },
        maxzoom: { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help || positionals.length === 0 || !values.output) {
      console.log(HELP);
      process.exit(values.help ? 0 : 1);
    }
    const zoom = (value: string | undefined, flag: string) => {
      if (value === undefined) return undefined;
      const z = Number(value);
      if (!Number.isInteger(z) || z < 0 || z > 18) throw new Error(`${flag} must be an integer from 0 to 18`);
      return z;
    };
    const started = performance.now();
    const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
    const output = resolve(values.output);
    mkdirSync(dirname(output), { recursive: true });
    await buildDem({
      inputs: positionals.map((p) => resolve(p)),
      output,
      minZoom: zoom(values.minzoom, "--minzoom"),
      maxZoom: zoom(values.maxzoom, "--maxzoom"),
      name: values.name,
      log,
    });
    log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return;
  }
  if (process.argv[2] === "search") {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        input: { type: "string", multiple: true },
        bbox: { type: "string" },
        world: { type: "boolean", default: false },
        output: { type: "string" },
        threads: { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help || !values.input?.length || !(values.bbox || values.world) || !values.output) {
      console.log(HELP);
      process.exit(values.help ? 0 : 1);
    }
    const bbox: [number, number, number, number] = values.bbox ? parseBbox(values.bbox) : [-180, -90, 180, 90];
    const output = resolve(values.output);
    mkdirSync(dirname(output), { recursive: true });
    const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
    const started = performance.now();
    const seen = new Set<number>();
    const entries: Entry[] = [];
    for (const file of values.input) {
      const input = resolve(file);
      log(`reading ${input} (${(statSync(input).size / 1e9).toFixed(2)} GB) for ${bbox.join(", ")}`);
      const region = await extractRegion(input, bbox, {
        threads: values.threads ? Number(values.threads) : availableParallelism(),
        log,
        profile: values.world ? "places" : "search",
      });
      for (const entry of collectEntries(region, log)) {
        if (seen.has(entry.osm)) continue;
        seen.add(entry.osm);
        entries.push(entry);
      }
    }
    const bytes = writeSearchIndex(bbox, entries, log);
    writeFileSync(output, bytes);
    log(`wrote ${output}: ${(bytes.length / 1e6).toFixed(1)} MB`);
    log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return;
  }
  if (process.argv[2] === "convert") {
    const [input, output] = process.argv.slice(3);
    if (!input || !output) {
      console.log(HELP);
      process.exit(1);
    }
    const started = performance.now();
    const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
    log(`converting ${resolve(input)}`);
    const result = await convertMbtiles(resolve(input), resolve(output), log);
    log(`wrote ${resolve(output)}: ${result.tiles.toLocaleString()} tiles, ${(result.bytes / 1e6).toFixed(1)} MB`);
    log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return;
  }
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      bbox: { type: "string" },
      output: { type: "string" },
      maxzoom: { type: "string", default: "14" },
      name: { type: "string" },
      threads: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.input || !values.bbox || !values.output) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const bbox = parseBbox(values.bbox);
  const maxZoom = Number(values.maxzoom);
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 16)
    throw new Error("--maxzoom must be an integer from 0 to 16");
  const threads = values.threads ? Number(values.threads) : availableParallelism();
  const input = resolve(values.input);
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const started = performance.now();
  log(`reading ${input} (${(statSync(input).size / 1e9).toFixed(2)} GB) for ${bbox.join(", ")}`);
  const data = await extractRegion(input, bbox, { threads, log });
  log("building features");
  const { features, stats } = buildFeatures(data, maxZoom, log);
  log(`features: ${stats.features.toLocaleString()} ${JSON.stringify(stats.byLayer)}`);
  if (stats.missingRefs > 0) log(`warning: ${stats.missingRefs.toLocaleString()} node references had no coordinates`);
  const writer = new PMTilesWriter();
  log("cutting tiles");
  const tileStats = buildTiles(features, {
    minZoom: 0,
    maxZoom,
    extent: 4096,
    maxZoomExtent: 8192,
    buffer: 64,
    bounds: regionRect(bbox),
    onTile: (z, x, y, tile) => writer.add(z, x, y, gzipSync(tile, { level: 6 })),
    log,
  });
  log(
    `tiles: ${tileStats.tiles.toLocaleString()}, ${(tileStats.bytes / 1e6).toFixed(1)} MB raw, largest ${tileStats.maxTile} at ${(tileStats.maxTileBytes / 1024).toFixed(0)} KB, per zoom ${tileStats.byZoom.join(" ")}`,
  );
  const vectorLayers = Object.entries(FIELDS)
    .filter(([id]) => (stats.byLayer[id] ?? 0) > 0)
    .map(([id, fields]) => ({ id, fields, minzoom: 0, maxzoom: maxZoom }));
  const center: [number, number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, Math.min(maxZoom, 10)];
  const result = writer.write(output, {
    tileType: TileType.mvt,
    tileCompression: Compression.gzip,
    minZoom: 0,
    maxZoom,
    bounds: bbox,
    center,
    metadata: {
      name: values.name ?? basename(output, ".pmtiles"),
      description: `OpenStreetMap data from ${basename(input)}`,
      attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
      type: "baselayer",
      version: "1.0.0",
      format: "pbf",
      scheme: "mapkern-osm-1",
      bounds: bbox,
      center,
      minzoom: 0,
      maxzoom: maxZoom,
      vector_layers: vectorLayers,
    },
  });
  log(
    `wrote ${output}: ${(result.bytes / 1e6).toFixed(1)} MB, ${result.entries.toLocaleString()} entries, ${result.contents.toLocaleString()} unique tiles, leaf directories ${(result.leaves / 1024).toFixed(0)} KB`,
  );
  log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

function parseBbox(value: string): [number, number, number, number] {
  const bbox = value.split(",").map(Number) as [number, number, number, number];
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error("--bbox must be west,south,east,north with west < east and south < north");
  }
  return bbox;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
