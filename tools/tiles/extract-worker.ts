import { closeSync, openSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { BlobRef, BlockKinds, RelationMember, Tags } from "./osm-pbf.ts";
import { readBlob, visitBlock } from "./osm-pbf.ts";
import { isRelevantPoint, isRelevantRelation, isRelevantWay, keepTags } from "./schema.ts";

export interface PointRecord {
  id: number;
  lon: number;
  lat: number;
  tags: Tags;
}

export interface WayRecord {
  id: number;
  refs: Float64Array;
  tags: Tags | null;
}

export interface RelationRecord {
  id: number;
  tags: Tags;
  members: RelationMember[];
}

export type Task =
  | { kind: "nodes"; index: number; blob: BlobRef; bbox: [number, number, number, number] }
  | { kind: "relations"; index: number; blob: BlobRef }
  | { kind: "ways"; index: number; blob: BlobRef }
  | { kind: "missing"; index: number; blob: BlobRef };

export type Result =
  | { kind: "nodes"; index: number; kinds: BlockKinds; ids: Float64Array; lon: Int32Array; lat: Int32Array; points: PointRecord[]; maxId: number }
  | { kind: "relations"; index: number; kinds: BlockKinds; relations: RelationRecord[] }
  | { kind: "ways"; index: number; kinds: BlockKinds; ways: WayRecord[] }
  | { kind: "missing"; index: number; kinds: BlockKinds; ids: Float64Array; lon: Int32Array; lat: Int32Array }
  | { kind: "error"; index: number; message: string };

interface Shared {
  path: string;
  regionNodes: SharedArrayBuffer | null;
  memberWays: SharedArrayBuffer | null;
  missingNodes: SharedArrayBuffer | null;
}

const shared = workerData as Shared;
const fd = openSync(shared.path, "r");
let region: Uint8Array | null = null;
let members: Uint8Array | null = null;
let missing: Uint8Array | null = null;

function has(bits: Uint8Array | null, id: number): boolean {
  if (!bits || id < 0) return false;
  const byte = Math.floor(id / 8);
  if (byte >= bits.length) return false;
  return (bits[byte]! & (1 << (id % 8))) !== 0;
}

class Grow {
  ids = new Float64Array(1024);
  lon = new Int32Array(1024);
  lat = new Int32Array(1024);
  n = 0;
  push(id: number, lon: number, lat: number): void {
    if (this.n === this.ids.length) {
      const size = this.n * 2;
      const ids = new Float64Array(size);
      ids.set(this.ids);
      const lo = new Int32Array(size);
      lo.set(this.lon);
      const la = new Int32Array(size);
      la.set(this.lat);
      this.ids = ids;
      this.lon = lo;
      this.lat = la;
    }
    this.ids[this.n] = id;
    this.lon[this.n] = lon;
    this.lat[this.n] = lat;
    this.n++;
  }
  done(): { ids: Float64Array; lon: Int32Array; lat: Int32Array } {
    return { ids: this.ids.slice(0, this.n), lon: this.lon.slice(0, this.n), lat: this.lat.slice(0, this.n) };
  }
}

function run(task: Task): Result {
  const data = readBlob(fd, task.blob);
  switch (task.kind) {
    case "nodes": {
      const [minLon, minLat, maxLon, maxLat] = task.bbox;
      const grow = new Grow();
      const points: PointRecord[] = [];
      let maxId = 0;
      const kinds = visitBlock(data, {
        nodes: {
          wantTags: true,
          node(id, lon, lat, tags) {
            if (id > maxId) maxId = id;
            if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return;
            grow.push(id, lon, lat);
            if (tags && isRelevantPoint(tags)) {
              const kept = keepTags(tags);
              if (kept) points.push({ id, lon, lat, tags: kept });
            }
          },
        },
      });
      return { kind: "nodes", index: task.index, kinds, ...grow.done(), points, maxId };
    }
    case "relations": {
      const relations: RelationRecord[] = [];
      const kinds = visitBlock(data, {
        relations: {
          relation(id, m, tags) {
            if (!isRelevantRelation(tags)) return;
            const kept = keepTags(tags);
            if (!kept) return;
            relations.push({ id, tags: kept, members: m.filter((x) => x.type === 1) });
          },
        },
      });
      return { kind: "relations", index: task.index, kinds, relations };
    }
    case "ways": {
      region ??= shared.regionNodes ? new Uint8Array(shared.regionNodes) : null;
      members ??= shared.memberWays ? new Uint8Array(shared.memberWays) : null;
      const ways: WayRecord[] = [];
      const kinds = visitBlock(data, {
        ways: {
          way(id, refs, tags) {
            const member = has(members, id);
            const relevant = isRelevantWay(tags);
            if (!member && !relevant) return;
            let inside = false;
            for (let i = 0; i < refs.length; i++) {
              if (has(region, refs[i]!)) {
                inside = true;
                break;
              }
            }
            if (!inside) return;
            ways.push({ id, refs, tags: relevant ? keepTags(tags) : null });
          },
        },
      });
      return { kind: "ways", index: task.index, kinds, ways };
    }
    case "missing": {
      missing ??= shared.missingNodes ? new Uint8Array(shared.missingNodes) : null;
      const grow = new Grow();
      const kinds = visitBlock(data, {
        nodes: {
          wantTags: false,
          node(id, lon, lat) {
            if (has(missing, id)) grow.push(id, lon, lat);
          },
        },
      });
      return { kind: "missing", index: task.index, kinds, ...grow.done() };
    }
  }
}

parentPort?.on("message", (task: Task | { kind: "close" }) => {
  if (task.kind === "close") {
    closeSync(fd);
    parentPort?.close();
    return;
  }
  let result: Result;
  try {
    result = run(task);
  } catch (error) {
    result = { kind: "error", index: task.index, message: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  const transfer: ArrayBuffer[] = [];
  if (result.kind === "nodes" || result.kind === "missing") transfer.push(result.ids.buffer as ArrayBuffer, result.lon.buffer as ArrayBuffer, result.lat.buffer as ArrayBuffer);
  if (result.kind === "ways") for (const w of result.ways) transfer.push(w.refs.buffer as ArrayBuffer);
  parentPort?.postMessage(result, transfer);
});
