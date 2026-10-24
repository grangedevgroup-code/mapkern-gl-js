import { MapletError } from "../core/errors.ts";
import { MBTilesArchive, registerMbtilesArchive, registerMbtilesProtocol } from "./mbtiles.ts";
import { BlobRangeSource, PMTilesArchive, registerArchive, registerPmtilesProtocol } from "./pmtiles.ts";

let opened = 0;

export async function openTileFile(file: Blob): Promise<string> {
  const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  const key = `file-${++opened}`;
  const source = new BlobRangeSource(file, key);
  if (head.startsWith("SQLite format 3")) {
    registerMbtilesProtocol();
    registerMbtilesArchive(key, new MBTilesArchive(source, key));
    return `mbtiles://${key}`;
  }
  if (head.startsWith("PMTiles")) {
    registerPmtilesProtocol();
    registerArchive(key, new PMTilesArchive(source));
    return `pmtiles://${key}`;
  }
  throw new MapletError("invalid-option", "openTileFile needs a PMTiles or MBTiles file");
}
