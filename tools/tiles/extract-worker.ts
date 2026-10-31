import { closeSync, openSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { BlobRef, BlockKinds, RelationMember, Tags } from "./osm-pbf.ts";
import { readBlob, visitBlock } from "./osm-pbf.ts";
import { isRestriction, isRouteWay, routeTags } from "./route-schema.ts";
import { isRelevantPoint, isRelevantRelation, isRelevantWay, keepTags } from "./schema.ts";
import {
  isSearchPoint,
  isSearchRelation,
  isSearchWay,
  isWorldFeature,
  isWorldRelation,
  searchTags,
} from "./search-schema.ts";

export interface PointRecord {
  id: number;
  lon: number;
  lat: number;
  tags: Tags;
}

export interface WayBatch {
  ids: Float64Array;
  offsets: Uint32Array;
  refs: Float64Array;
  tags: (Tags | null)[];
}

export interface RelationRecord {
  id: number;
  tags: Tags;
  members: RelationMember[];
}

export type Task =
  | { kind: "nodes"; index: number; blob: BlobRef; bbox: [number, number, number, number] }
  | { kind: "ways"; index: number; blob: BlobRef; extra?: boolean }
  | { kind: "missing"; index: number; blob: BlobRef };

export interface ShareMessage {
  kind: "share";
  regionNodes: SharedArrayBuffer | null;
  memberWays: SharedArrayBuffer | null;
  missingNodes: SharedArrayBuffer | null;
}

export type Result =
  | {
      kind: "nodes";
      index: number;
      kinds: BlockKinds;
      ids: Float64Array;
      lon: Int32Array;
      lat: Int32Array;
      points: PointRecord[];
      relations: RelationRecord[];
      maxId: number;
    }
  | { kind: "ways"; index: number; kinds: BlockKinds; ways: WayBatch }
  | { kind: "missing"; index: number; kinds: BlockKinds; ids: Float64Array; lon: Int32Array; lat: Int32Array }
  | { kind: "error"; index: number; message: string };

export type Profile = "tiles" | "search" | "places" | "route";

const options = workerData as { path: string; profile?: Profile };
const fd = openSync(options.path, "r");
const world = options.profile === "places";
const routing = options.profile === "route";
const schema = routing
  ? { point: () => false, way: isRouteWay, relation: isRestriction, keep: routeTags }
  : options.profile === "search"
    ? { point: isSearchPoint, way: isSearchWay, relation: isSearchRelation, keep: searchTags }
    : world
      ? { point: isWorldFeature, way: isWorldFeature, relation: isWorldRelation, keep: searchTags }
      : { point: isRelevantPoint, way: isRelevantWay, relation: isRelevantRelation, keep: keepTags };
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
      const relations: RelationRecord[] = [];
      let maxId = 0;
      const kinds = visitBlock(data, {
        relations: {
          relation(id, m, tags) {
            if (!schema.relation(tags)) return;
            const kept = schema.keep(tags);
            if (!kept) return;
            if (routing) {
              const via = m.find((x) => x.type === 0 && x.role === "via");
              if (via) kept["@via"] = String(via.ref);
            }
            relations.push({ id, tags: kept, members: m.filter((x) => x.type === 1) });
          },
        },
        nodes: {
          wantTags: true,
          node(id, lon, lat, tags) {
            if (id > maxId) maxId = id;
            if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return;
            if (!world) grow.push(id, lon, lat);
            if (tags && schema.point(tags)) {
              const kept = schema.keep(tags);
              if (kept) points.push({ id, lon, lat, tags: kept });
            }
          },
        },
      });
      return { kind: "nodes", index: task.index, kinds, ...grow.done(), points, relations, maxId };
    }
    case "ways": {
      const ids: number[] = [];
      const offsets: number[] = [0];
      const tagList: (Tags | null)[] = [];
      let refBuf = new Float64Array(4096);
      let refCount = 0;
      const kinds = visitBlock(data, {
        ways: {
          way(id, refs, tags) {
            if (task.extra) {
              if (!has(members, id)) return;
            } else if (world) {
              if (!has(members, id) && !schema.way(tags)) return;
            } else {
              const member = has(members, id);
              const relevant = schema.way(tags);
              if (!member && !relevant) return;
              let inside = false;
              for (let i = 0; i < refs.length; i++) {
                if (has(region, refs[i]!)) {
                  inside = true;
                  break;
                }
              }
              if (!inside) return;
            }
            if (refCount + refs.length > refBuf.length) {
              let size = refBuf.length * 2;
              while (size < refCount + refs.length) size *= 2;
              const next = new Float64Array(size);
              next.set(refBuf.subarray(0, refCount));
              refBuf = next;
            }
            refBuf.set(refs, refCount);
            refCount += refs.length;
            ids.push(id);
            offsets.push(refCount);
            tagList.push(schema.keep(tags));
          },
        },
      });
      const ways: WayBatch = {
        ids: Float64Array.from(ids),
        offsets: Uint32Array.from(offsets),
        refs: refBuf.slice(0, refCount),
        tags: tagList,
      };
      return { kind: "ways", index: task.index, kinds, ways };
    }
    case "missing": {
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

parentPort?.on("message", (task: Task | ShareMessage | { kind: "close" }) => {
  if (task.kind === "close") {
    closeSync(fd);
    parentPort?.close();
    return;
  }
  if (task.kind === "share") {
    region = task.regionNodes ? new Uint8Array(task.regionNodes) : null;
    members = task.memberWays ? new Uint8Array(task.memberWays) : null;
    missing = task.missingNodes ? new Uint8Array(task.missingNodes) : null;
    return;
  }
  let result: Result;
  try {
    result = run(task);
  } catch (error) {
    result = {
      kind: "error",
      index: task.index,
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
  const transfer: ArrayBuffer[] = [];
  if (result.kind === "nodes" || result.kind === "missing")
    transfer.push(result.ids.buffer as ArrayBuffer, result.lon.buffer as ArrayBuffer, result.lat.buffer as ArrayBuffer);
  if (result.kind === "ways")
    transfer.push(
      result.ways.ids.buffer as ArrayBuffer,
      result.ways.offsets.buffer as ArrayBuffer,
      result.ways.refs.buffer as ArrayBuffer,
    );
  parentPort?.postMessage(result, transfer);
});
