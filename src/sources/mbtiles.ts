import type { ByteRanges, SchemaRow, SqlValue } from "../formats/sqlite.ts";
import { SqliteError, SqliteReader } from "../formats/sqlite.ts";
import type { ProtocolRequest, ProtocolResult } from "../tiles/protocols.ts";
import { addBuiltinProtocol } from "../tiles/protocols.ts";
import { HttpRangeSource } from "./pmtiles.ts";

interface TableInfo {
  root: number;
  columns: string[];
  rowidAlias: string | null;
}

interface IndexInfo {
  root: number;
  columns: string[];
}

type Layout =
  | { kind: "table"; tiles: TableInfo; index: IndexInfo }
  | { kind: "split"; map: TableInfo; mapIndex: IndexInfo; images: TableInfo; imagesIndex: IndexInfo | null };

const COORDS = ["zoom_level", "tile_column", "tile_row"];

export class MBTilesArchive {
  readonly key: string;
  private readonly db: SqliteReader;
  private layoutPromise: Promise<{ layout: Layout; metadata: Record<string, string> }> | null = null;

  constructor(ranges: ByteRanges, key: string) {
    this.db = new SqliteReader(ranges);
    this.key = key;
  }

  metadata(signal: AbortSignal): Promise<Record<string, string>> {
    return this.init(signal).then((r) => r.metadata);
  }

  async tile(z: number, x: number, y: number, signal: AbortSignal): Promise<Uint8Array | null> {
    const { layout } = await this.init(signal);
    const coords: Record<string, number> = { zoom_level: z, tile_column: x, tile_row: 2 ** z - 1 - y };
    if (layout.kind === "table") {
      const row = await this.find(layout.tiles, layout.index, coords, signal);
      return blob(row?.[layout.tiles.columns.indexOf("tile_data")]);
    }
    const mapRow = await this.find(layout.map, layout.mapIndex, coords, signal);
    if (!mapRow) return null;
    const tileId = mapRow[layout.map.columns.indexOf("tile_id")] ?? null;
    if (tileId === null) return null;
    let imageRow: SqlValue[] | null;
    if (layout.images.rowidAlias === "tile_id" && typeof tileId === "number") {
      imageRow = await this.db.row(layout.images.root, tileId, signal);
    } else if (layout.imagesIndex) {
      imageRow = await this.find(layout.images, layout.imagesIndex, { tile_id: tileId }, signal);
    } else {
      throw new SqliteError("The images table has no index on tile_id");
    }
    return blob(imageRow?.[layout.images.columns.indexOf("tile_data")]);
  }

  async forEachTile(
    visit: (z: number, x: number, y: number, data: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { layout } = await this.init(signal);
    const table = layout.kind === "table" ? layout.tiles : layout.map;
    const z = table.columns.indexOf("zoom_level");
    const x = table.columns.indexOf("tile_column");
    const y = table.columns.indexOf("tile_row");
    const pending: { z: number; x: number; y: number; id: SqlValue }[] = [];
    await this.db.scan(table.root, signal, (rowid, values) => {
      const zoom = Number(values[z]);
      const column = Number(values[x]);
      const row = 2 ** zoom - 1 - Number(values[y]);
      if (layout.kind === "table") {
        const data = blob(values[layout.tiles.columns.indexOf("tile_data")]);
        if (data) visit(zoom, column, row, data);
      } else {
        const idIndex = layout.map.columns.indexOf("tile_id");
        pending.push({
          z: zoom,
          x: column,
          y: row,
          id: layout.map.rowidAlias === "tile_id" ? rowid : values[idIndex]!,
        });
      }
    });
    if (layout.kind !== "split") return;
    for (const p of pending) {
      let imageRow: SqlValue[] | null = null;
      if (layout.images.rowidAlias === "tile_id" && typeof p.id === "number") {
        imageRow = await this.db.row(layout.images.root, p.id, signal);
      } else if (layout.imagesIndex) {
        imageRow = await this.find(layout.images, layout.imagesIndex, { tile_id: p.id }, signal);
      }
      const data = blob(imageRow?.[layout.images.columns.indexOf("tile_data")]);
      if (data) visit(p.z, p.x, p.y, data);
    }
  }

  private async find(
    table: TableInfo,
    index: IndexInfo,
    values: Record<string, SqlValue>,
    signal: AbortSignal,
  ): Promise<SqlValue[] | null> {
    const key = index.columns.map((c) => values[c] ?? null);
    const entry = await this.db.lookup(index.root, key, signal);
    if (!entry) return null;
    const rowid = entry[entry.length - 1];
    if (typeof rowid !== "number") return null;
    const row = await this.db.row(table.root, rowid, signal);
    if (row && table.rowidAlias) row[table.columns.indexOf(table.rowidAlias)] = rowid;
    return row;
  }

  private init(signal: AbortSignal) {
    if (!this.layoutPromise) {
      this.layoutPromise = (async () => {
        const schema = await this.db.schema(signal);
        const layout = findLayout(schema);
        const metadata: Record<string, string> = {};
        const meta = schema.find((r) => r.type === "table" && r.name.toLowerCase() === "metadata");
        if (meta) {
          await this.db.scan(meta.root, signal, (_rowid, values) => {
            if (typeof values[0] === "string") metadata[values[0]] = values[1] === null ? "" : String(values[1]);
          });
        }
        return { layout, metadata };
      })();
      this.layoutPromise.catch(() => {
        this.layoutPromise = null;
      });
    }
    return this.layoutPromise;
  }
}

function blob(value: SqlValue | undefined): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length > 0 ? value : null;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return null;
}

function findLayout(schema: SchemaRow[]): Layout {
  const table = (name: string) => schema.find((r) => r.type === "table" && r.name.toLowerCase() === name);
  const tiles = table("tiles");
  if (tiles) {
    const info = tableInfo(tiles);
    const index = coveringIndex(schema, tiles, COORDS);
    if (!index) throw new SqliteError("The tiles table has no index on zoom_level, tile_column and tile_row");
    return { kind: "table", tiles: info, index };
  }
  const map = table("map");
  const images = table("images");
  if (map && images) {
    const mapIndex = coveringIndex(schema, map, COORDS);
    if (!mapIndex) throw new SqliteError("The map table has no index on zoom_level, tile_column and tile_row");
    return {
      kind: "split",
      map: tableInfo(map),
      mapIndex,
      images: tableInfo(images),
      imagesIndex: coveringIndex(schema, images, ["tile_id"]),
    };
  }
  throw new SqliteError("The file is not an MBTiles archive: it has no tiles table");
}

function tableInfo(row: SchemaRow): TableInfo {
  const defs = splitDefinitions(row.sql);
  const columns: string[] = [];
  let rowidAlias: string | null = null;
  for (const def of defs) {
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(def)) continue;
    const name = cleanName(def.split(/\s+/)[0] ?? "");
    columns.push(name);
    if (/^\S+\s+integer\s+primary\s+key/i.test(def)) rowidAlias = name;
  }
  return { root: row.root, columns, rowidAlias };
}

function coveringIndex(schema: SchemaRow[], table: SchemaRow, wanted: string[]): IndexInfo | null {
  const tableName = table.name.toLowerCase();
  const constraints = uniqueConstraints(table.sql);
  for (const row of schema) {
    if (row.type !== "index" || row.table.toLowerCase() !== tableName) continue;
    let columns: string[] | undefined;
    if (row.sql) {
      const m = /\(([^)]*)\)\s*(where\b.*)?$/is.exec(row.sql.trim());
      columns = m?.[1]?.split(",").map((c) => cleanName(c.trim().split(/\s+/)[0] ?? ""));
    } else {
      const n = Number(/_(\d+)$/.exec(row.name)?.[1] ?? "0");
      columns = constraints[n - 1];
    }
    if (!columns || columns.length < wanted.length) continue;
    const head = columns.slice(0, wanted.length);
    if (wanted.every((w) => head.includes(w))) return { root: row.root, columns: head };
  }
  return null;
}

function uniqueConstraints(sql: string): string[][] {
  const out: string[][] = [];
  for (const def of splitDefinitions(sql)) {
    const table = /^(?:constraint\s+\S+\s+)?(?:primary\s+key|unique)\s*\(([^)]*)\)/i.exec(def);
    if (table) {
      out.push(table[1]!.split(",").map((c) => cleanName(c.trim().split(/\s+/)[0] ?? "")));
      continue;
    }
    if (/^(constraint|check|foreign)\b/i.test(def)) continue;
    if (/\bprimary\s+key\b/i.test(def) && !/^\S+\s+integer\s+primary\s+key/i.test(def)) {
      out.push([cleanName(def.split(/\s+/)[0] ?? "")]);
    } else if (/\bunique\b/i.test(def)) {
      out.push([cleanName(def.split(/\s+/)[0] ?? "")]);
    }
  }
  return out;
}

function splitDefinitions(sql: string): string[] {
  const start = sql.indexOf("(");
  const end = sql.lastIndexOf(")");
  if (start < 0 || end <= start) return [];
  const body = sql.slice(start + 1, end);
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of body) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function cleanName(name: string): string {
  return name.replace(/^["'`[]|["'`\]]$/g, "").toLowerCase();
}

const archives = new Map<string, MBTilesArchive>();

export function registerMbtilesArchive(key: string, archive: MBTilesArchive): void {
  archives.set(key, archive);
}

function archiveFor(location: string, request: ProtocolRequest): MBTilesArchive {
  let archive = archives.get(location);
  if (!archive) {
    archive = new MBTilesArchive(new HttpRangeSource(location, request.headers, request.credentials), location);
    archives.set(location, archive);
    if (archives.size > 32) {
      const first = archives.keys().next().value;
      if (first !== undefined && first !== location) archives.delete(first);
    }
  }
  return archive;
}

const TILE_SUFFIX = /\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?$/;

export async function handleMbtiles(request: ProtocolRequest, signal: AbortSignal): Promise<ProtocolResult> {
  const rest = request.url.slice("mbtiles://".length);
  const m = TILE_SUFFIX.exec(rest);
  if (request.kind === "tile" && m) {
    const archive = archiveFor(rest.slice(0, m.index), request);
    return archive.tile(Number(m[1]), Number(m[2]), Number(m[3]), signal);
  }
  const archive = archiveFor(rest, request);
  const meta = await archive.metadata(signal);
  const numbers = (value: string | undefined) => (value ? value.split(",").map(Number) : undefined);
  const tileJson: Record<string, unknown> = { tilejson: "3.0.0", tiles: [`mbtiles://${rest}/{z}/{x}/{y}`] };
  if (meta.name) tileJson.name = meta.name;
  if (meta.description) tileJson.description = meta.description;
  if (meta.attribution) tileJson.attribution = meta.attribution;
  if (meta.format) tileJson.format = meta.format;
  if (meta.minzoom !== undefined && meta.minzoom !== "") tileJson.minzoom = Number(meta.minzoom);
  if (meta.maxzoom !== undefined && meta.maxzoom !== "") tileJson.maxzoom = Number(meta.maxzoom);
  const bounds = numbers(meta.bounds);
  if (bounds?.length === 4 && bounds.every(Number.isFinite)) tileJson.bounds = bounds;
  const center = numbers(meta.center);
  if (center && center.length >= 2 && center.every(Number.isFinite)) tileJson.center = center;
  if (meta.json) {
    try {
      const extra = JSON.parse(meta.json) as Record<string, unknown>;
      if (Array.isArray(extra.vector_layers)) tileJson.vector_layers = extra.vector_layers;
    } catch {
      tileJson.vector_layers = [];
    }
  }
  return { data: new TextEncoder().encode(JSON.stringify(tileJson)), contentType: "application/json" };
}

let registered = false;

export function registerMbtilesProtocol(): void {
  if (registered) return;
  registered = true;
  addBuiltinProtocol("mbtiles", handleMbtiles);
}
