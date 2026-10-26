import { MapkernError } from "../core/errors.ts";
import type { ElevationGrid } from "../formats/elevation.ts";
import { gridBounds, readElevationFile, sampleGrid } from "../formats/elevation.ts";
import type { ProtocolRequest, ProtocolResult } from "../tiles/protocols.ts";
import { addProtocol } from "../tiles/protocols.ts";
import { encodeRawElevation } from "../worker/dem-task.ts";

interface ElevationSet {
  grids: { grid: ElevationGrid; bounds: [number, number, number, number] }[];
  bounds: [number, number, number, number];
  maxZoom: number;
}

const TILE_SAMPLES = 256;
const EARTH = 40075016.686;
const sets = new Map<string, ElevationSet>();
let opened = 0;
let registered = false;

export function elevationSet(grids: ElevationGrid[]): ElevationSet {
  const entries = grids.map((grid) => ({ grid, bounds: gridBounds(grid) }));
  const bounds: [number, number, number, number] = [
    Math.min(...entries.map((e) => e.bounds[0])),
    Math.min(...entries.map((e) => e.bounds[1])),
    Math.max(...entries.map((e) => e.bounds[2])),
    Math.max(...entries.map((e) => e.bounds[3])),
  ];
  const finest = Math.min(...grids.map((g) => g.dy)) * 111320;
  const maxZoom = Math.max(0, Math.min(15, Math.round(Math.log2(EARTH / (TILE_SAMPLES * finest)))));
  return { grids: entries, bounds, maxZoom };
}

export function renderElevationTile(set: ElevationSet, z: number, x: number, y: number): Float32Array | null {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  const touching = set.grids.filter(
    (e) => e.bounds[0] < east && e.bounds[2] > west && e.bounds[1] < north && e.bounds[3] > south,
  );
  if (touching.length === 0) return null;
  const out = new Float32Array(TILE_SAMPLES * TILE_SAMPLES).fill(Number.NaN);
  let found = false;
  for (let row = 0; row < TILE_SAMPLES; row++) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (row + 0.5) / TILE_SAMPLES)) / n))) * 180) / Math.PI;
    for (let col = 0; col < TILE_SAMPLES; col++) {
      const lon = ((x + (col + 0.5) / TILE_SAMPLES) / n) * 360 - 180;
      for (const e of touching) {
        if (lon < e.bounds[0] || lon > e.bounds[2] || lat < e.bounds[1] || lat > e.bounds[3]) continue;
        const v = sampleGrid(e.grid, lon, lat);
        if (!Number.isNaN(v)) {
          out[row * TILE_SAMPLES + col] = v;
          found = true;
          break;
        }
      }
    }
  }
  return found ? out : null;
}

const TILE = /^elevation:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

async function handleElevation(request: ProtocolRequest): Promise<ProtocolResult> {
  const m = TILE.exec(request.url);
  if (m) {
    const set = sets.get(m[1]!);
    if (!set) return null;
    const values = renderElevationTile(set, Number(m[2]), Number(m[3]), Number(m[4]));
    return values ? encodeRawElevation(values, TILE_SAMPLES) : null;
  }
  const key = request.url.slice("elevation://".length).replace(/\/+$/, "");
  const set = sets.get(key);
  if (!set) return null;
  const json = {
    tilejson: "3.0.0",
    tiles: [`elevation://${key}/{z}/{x}/{y}`],
    minzoom: 0,
    maxzoom: set.maxZoom,
    bounds: set.bounds,
  };
  return { data: new TextEncoder().encode(JSON.stringify(json)), contentType: "application/json" };
}

export async function openElevationFile(input: Blob | ArrayLike<Blob> | Iterable<Blob>): Promise<string> {
  const files = input instanceof Blob ? [input] : Array.from(input as Iterable<Blob>);
  const grids: ElevationGrid[] = [];
  for (const file of files) {
    const name = "name" in file && typeof file.name === "string" ? file.name : "";
    try {
      grids.push(...(await readElevationFile(new Uint8Array(await file.arrayBuffer()), name)));
    } catch (error) {
      throw new MapkernError("invalid-option", error instanceof Error ? error.message : String(error));
    }
  }
  if (grids.length === 0) throw new MapkernError("invalid-option", "openElevationFile needs at least one file");
  if (!registered) {
    registered = true;
    addProtocol("elevation", handleElevation);
  }
  const key = `file-${++opened}`;
  sets.set(key, elevationSet(grids));
  return `elevation://${key}`;
}
