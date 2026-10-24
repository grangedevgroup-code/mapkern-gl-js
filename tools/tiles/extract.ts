import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { PointRecord, RelationRecord, Result, ShareMessage, Task, WayBatch } from "./extract-worker.ts";
import type { BlobRef, Tags } from "./osm-pbf.ts";
import { indexBlobs } from "./osm-pbf.ts";

export interface RegionData {
  bbox: [number, number, number, number];
  warnings: string[];
  nodeIds: Float64Array;
  nodeLon: Int32Array;
  nodeLat: Int32Array;
  points: PointRecord[];
  wayIds: Float64Array;
  wayOffsets: Uint32Array;
  wayRefs: Float64Array;
  wayTags: (Tags | null)[];
  relations: RelationRecord[];
}

export interface ExtractOptions {
  threads?: number;
  log?: (message: string) => void;
}

type Kind = "nodes" | "ways" | "missing";

class Pool {
  private readonly workers: Worker[];
  constructor(path: string, size: number) {
    const url = new URL("./extract-worker.ts", import.meta.url);
    this.workers = Array.from({ length: size }, () => new Worker(url, { workerData: { path } }));
  }

  share(message: ShareMessage): void {
    for (const w of this.workers) w.postMessage(message);
  }

  run(
    tasks: Task[],
    onResult: (r: Result) => void,
    onProgress: (done: number) => void,
    onSkip: (index: number, message: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let next = 0;
      let done = 0;
      let failed = false;
      const listeners: (() => void)[] = [];
      const cleanup = () => {
        for (const off of listeners) off();
      };
      const feed = (w: Worker) => {
        if (failed) return;
        if (next < tasks.length) w.postMessage(tasks[next++]);
      };
      for (const w of this.workers) {
        const onMessage = (r: Result) => {
          if (failed) return;
          if (r.kind === "error") onSkip(r.index, r.message);
          else onResult(r);
          done++;
          onProgress(done);
          if (done === tasks.length) {
            cleanup();
            resolve();
          } else {
            feed(w);
          }
        };
        const onError = (e: Error) => {
          failed = true;
          cleanup();
          reject(e);
        };
        w.on("message", onMessage);
        w.on("error", onError);
        listeners.push(() => {
          w.off("message", onMessage);
          w.off("error", onError);
        });
      }
      if (tasks.length === 0) {
        resolve();
        return;
      }
      for (const w of this.workers) for (let i = 0; i < 2; i++) feed(w);
    });
  }

  async close(): Promise<void> {
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise<void>((resolve) => {
            w.once("exit", () => resolve());
            w.postMessage({ kind: "close" });
            setTimeout(() => {
              void w.terminate();
            }, 5000);
          }),
      ),
    );
  }
}

function bitmap(maxId: number): { buffer: SharedArrayBuffer; bits: Uint8Array } {
  const buffer = new SharedArrayBuffer(Math.max(1, Math.floor(maxId / 8) + 1));
  return { buffer, bits: new Uint8Array(buffer) };
}

function setBit(bits: Uint8Array, id: number): void {
  bits[Math.floor(id / 8)]! |= 1 << (id % 8);
}

function hasBit(bits: Uint8Array, id: number): boolean {
  const byte = Math.floor(id / 8);
  return byte < bits.length && (bits[byte]! & (1 << (id % 8))) !== 0;
}

function concatNodes(parts: { ids: Float64Array; lon: Int32Array; lat: Int32Array }[]) {
  let n = 0;
  for (const p of parts) n += p.ids.length;
  const ids = new Float64Array(n);
  const lon = new Int32Array(n);
  const lat = new Int32Array(n);
  let o = 0;
  for (const p of parts) {
    ids.set(p.ids, o);
    lon.set(p.lon, o);
    lat.set(p.lat, o);
    o += p.ids.length;
  }
  return sortNodes(ids, lon, lat);
}

function sortNodes(ids: Float64Array, lon: Int32Array, lat: Int32Array) {
  let sorted = true;
  for (let i = 1; i < ids.length; i++) {
    if (ids[i]! < ids[i - 1]!) {
      sorted = false;
      break;
    }
  }
  if (sorted) return { ids, lon, lat };
  const order = Array.from({ length: ids.length }, (_, i) => i).sort((a, b) => ids[a]! - ids[b]!);
  return {
    ids: Float64Array.from(order, (i) => ids[i]!),
    lon: Int32Array.from(order, (i) => lon[i]!),
    lat: Int32Array.from(order, (i) => lat[i]!),
  };
}

function mergeNodes(
  a: { ids: Float64Array; lon: Int32Array; lat: Int32Array },
  b: { ids: Float64Array; lon: Int32Array; lat: Int32Array },
) {
  const n = a.ids.length + b.ids.length;
  const ids = new Float64Array(n);
  const lon = new Int32Array(n);
  const lat = new Int32Array(n);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.ids.length || j < b.ids.length) {
    const takeA = j >= b.ids.length || (i < a.ids.length && a.ids[i]! <= b.ids[j]!);
    if (takeA) {
      ids[k] = a.ids[i]!;
      lon[k] = a.lon[i]!;
      lat[k] = a.lat[i]!;
      i++;
    } else {
      ids[k] = b.ids[j]!;
      lon[k] = b.lon[j]!;
      lat[k] = b.lat[j]!;
      j++;
    }
    k++;
  }
  return { ids, lon, lat };
}

export async function extractRegion(
  path: string,
  bbox: [number, number, number, number],
  options: ExtractOptions = {},
): Promise<RegionData> {
  const log = options.log ?? (() => undefined);
  const threads = Math.max(1, options.threads ?? Math.max(1, availableParallelism() - 0));
  const started = performance.now();
  const index = indexBlobs(path);
  const warnings: string[] = [];
  if (index.damagedAt !== null) {
    const lost = index.fileSize - index.damagedAt;
    const message = `the file is damaged at byte ${index.damagedAt.toLocaleString()} (${index.damage}); the last ${(lost / 1e6).toFixed(1)} MB cannot be read. Download the file again to get everything.`;
    warnings.push(message);
    log(`warning: ${message}`);
  }
  const blobs = index.blobs.filter((b) => b.type === "OSMData");
  const totalBytes = blobs.reduce((s, b) => s + b.size, 0);
  log(`${blobs.length} data blobs, ${(totalBytes / 1e9).toFixed(2)} GB compressed, ${threads} threads`);
  const fixed: [number, number, number, number] = [
    Math.round(bbox[0] * 1e7),
    Math.round(bbox[1] * 1e7),
    Math.round(bbox[2] * 1e7),
    Math.round(bbox[3] * 1e7),
  ];
  const pool = new Pool(path, threads);
  try {
    const kinds = new Array<{ nodes: boolean; ways: boolean; relations: boolean }>(blobs.length);
    const nodeParts = new Array<{ ids: Float64Array; lon: Int32Array; lat: Int32Array }>(blobs.length);
    const points: PointRecord[][] = new Array(blobs.length);
    const relationParts: RelationRecord[][] = new Array(blobs.length);
    let maxNodeId = 0;
    const skipped = new Map<string, number>();
    const onSkip = (pass: string) => (blobIndex: number, message: string) => {
      const n = (skipped.get(pass) ?? 0) + 1;
      skipped.set(pass, n);
      if (n <= 3) log(`warning: ${pass} pass skipped blob ${blobIndex}: ${message.split(/\r?\n/)[0]}`);
    };
    await runPass(
      pool,
      "nodes",
      blobs,
      (b, i) => ({ kind: "nodes", index: i, blob: b, bbox: fixed }),
      (r) => {
        if (r.kind !== "nodes") return;
        kinds[r.index] = r.kinds;
        nodeParts[r.index] = { ids: r.ids, lon: r.lon, lat: r.lat };
        points[r.index] = r.points;
        relationParts[r.index] = r.relations;
        if (r.maxId > maxNodeId) maxNodeId = r.maxId;
      },
      log,
      started,
      onSkip("nodes"),
    );
    const regionNodes = concatNodes(nodeParts.filter(Boolean));
    const relations = relationParts.filter(Boolean).flat();
    log(
      `region nodes: ${regionNodes.ids.length.toLocaleString()}, tagged points: ${points.flat().length.toLocaleString()}, relations: ${relations.length.toLocaleString()}`,
    );

    const region = bitmap(maxNodeId);
    for (const id of regionNodes.ids) setBit(region.bits, id);
    let maxWayId = 0;
    for (const rel of relations) for (const m of rel.members) if (m.ref > maxWayId) maxWayId = m.ref;
    const members = bitmap(maxWayId);
    for (const rel of relations) for (const m of rel.members) setBit(members.bits, m.ref);
    pool.share({ kind: "share", regionNodes: region.buffer, memberWays: members.buffer, missingNodes: null });

    const wayBlobs = blobs.map((b, i) => [b, i] as const).filter(([, i]) => kinds[i]?.ways);
    const wayParts: WayBatch[] = [];
    await runPass(
      pool,
      "ways",
      wayBlobs.map(([b]) => b),
      (b, i) => ({ kind: "ways", index: wayBlobs[i]![1], blob: b }),
      (r) => {
        if (r.kind === "ways") wayParts[r.index] = r.ways;
      },
      log,
      started,
      onSkip("ways"),
    );
    let ways = concatWays(wayParts.filter(Boolean));
    log(`ways kept: ${ways.ids.length.toLocaleString()}, refs: ${ways.refs.length.toLocaleString()}`);

    const extra = bitmap(maxWayId);
    let extraCount = 0;
    for (const rel of relations) {
      if (rel.tags.type === "boundary" && rel.tags.boundary === "administrative") continue;
      if (!rel.members.some((m) => sortedHas(ways.ids, m.ref))) continue;
      for (const m of rel.members) {
        if (!sortedHas(ways.ids, m.ref) && !hasBit(extra.bits, m.ref)) {
          setBit(extra.bits, m.ref);
          extraCount++;
        }
      }
    }
    if (extraCount > 0) {
      log(`member ways outside the box needed to close polygons: ${extraCount.toLocaleString()}`);
      pool.share({ kind: "share", regionNodes: null, memberWays: extra.buffer, missingNodes: null });
      const extraParts: WayBatch[] = [];
      await runPass(
        pool,
        "ways",
        wayBlobs.map(([b]) => b),
        (b, i) => ({ kind: "ways", index: wayBlobs[i]![1], blob: b, extra: true }),
        (r) => {
          if (r.kind === "ways") extraParts[r.index] = r.ways;
        },
        log,
        started,
        onSkip("closing ways"),
      );
      ways = concatWays([ways, ...extraParts.filter(Boolean)]);
      log(`ways after closing polygons: ${ways.ids.length.toLocaleString()}`);
    }

    const missingMap = bitmap(maxNodeId);
    let missingCount = 0;
    for (const ref of ways.refs) {
      if (!hasBit(region.bits, ref) && !hasBit(missingMap.bits, ref)) {
        setBit(missingMap.bits, ref);
        missingCount++;
      }
    }
    log(`nodes outside the box needed by kept ways: ${missingCount.toLocaleString()}`);
    let nodes = regionNodes;
    if (missingCount > 0) {
      pool.share({ kind: "share", regionNodes: null, memberWays: null, missingNodes: missingMap.buffer });
      const nodeBlobs = blobs.map((b, i) => [b, i] as const).filter(([, i]) => kinds[i]?.nodes);
      const missingParts: { ids: Float64Array; lon: Int32Array; lat: Int32Array }[] = [];
      await runPass(
        pool,
        "missing",
        nodeBlobs.map(([b]) => b),
        (b, i) => ({ kind: "missing", index: nodeBlobs[i]![1], blob: b }),
        (r) => {
          if (r.kind === "missing") missingParts[r.index] = { ids: r.ids, lon: r.lon, lat: r.lat };
        },
        log,
        started,
        onSkip("missing nodes"),
      );
      nodes = mergeNodes(regionNodes, concatNodes(missingParts.filter(Boolean)));
    }
    for (const [pass, n] of skipped) {
      const message = `${n.toLocaleString()} damaged blob(s) could not be read in the ${pass} pass, so some data is missing`;
      warnings.push(message);
      log(`warning: ${message}`);
    }
    log(`extract finished in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return {
      bbox,
      warnings,
      nodeIds: nodes.ids,
      nodeLon: nodes.lon,
      nodeLat: nodes.lat,
      points: points.filter(Boolean).flat(),
      wayIds: ways.ids,
      wayOffsets: ways.offsets,
      wayRefs: ways.refs,
      wayTags: ways.tags,
      relations,
    };
  } finally {
    await pool.close();
  }
}

function sortedHas(ids: Float64Array, id: number): boolean {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid]!;
    if (v === id) return true;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function concatWays(parts: WayBatch[]): WayBatch {
  let nWays = 0;
  let nRefs = 0;
  for (const p of parts) {
    nWays += p.ids.length;
    nRefs += p.refs.length;
  }
  const ids = new Float64Array(nWays);
  const offsets = new Uint32Array(nWays + 1);
  const refs = new Float64Array(nRefs);
  const tags: (Tags | null)[] = new Array(nWays);
  let w = 0;
  let r = 0;
  for (const p of parts) {
    for (let i = 0; i < p.ids.length; i++) {
      ids[w] = p.ids[i]!;
      tags[w] = p.tags[i] ?? null;
      offsets[w] = r + p.offsets[i]!;
      w++;
    }
    refs.set(p.refs, r);
    r += p.refs.length;
  }
  offsets[nWays] = r;
  let sorted = true;
  for (let i = 1; i < nWays; i++) {
    if (ids[i]! < ids[i - 1]!) {
      sorted = false;
      break;
    }
  }
  if (sorted) return { ids, offsets, refs, tags };
  const order = Array.from({ length: nWays }, (_, i) => i).sort((a, b) => ids[a]! - ids[b]!);
  const sIds = new Float64Array(nWays);
  const sOffsets = new Uint32Array(nWays + 1);
  const sRefs = new Float64Array(nRefs);
  const sTags: (Tags | null)[] = new Array(nWays);
  let o = 0;
  order.forEach((src, dst) => {
    sIds[dst] = ids[src]!;
    sTags[dst] = tags[src] ?? null;
    sOffsets[dst] = o;
    const a = offsets[src]!;
    const b = offsets[src + 1]!;
    sRefs.set(refs.subarray(a, b), o);
    o += b - a;
  });
  sOffsets[nWays] = o;
  return { ids: sIds, offsets: sOffsets, refs: sRefs, tags: sTags };
}

async function runPass(
  pool: Pool,
  kind: Kind,
  blobs: BlobRef[],
  task: (b: BlobRef, i: number) => Task,
  onResult: (r: Result) => void,
  log: (message: string) => void,
  started: number,
  onSkip: (index: number, message: string) => void = () => undefined,
): Promise<void> {
  const tasks = blobs.map(task);
  const passStart = performance.now();
  let last = passStart;
  await pool.run(tasks, onResult, (done) => {
    const now = performance.now();
    if (now - last > 5000 || done === tasks.length) {
      last = now;
      const pct = ((done / Math.max(1, tasks.length)) * 100).toFixed(1);
      log(
        `  ${kind}: ${done}/${tasks.length} blobs (${pct}%), ${((now - passStart) / 1000).toFixed(0)} s, total ${((now - started) / 1000).toFixed(0)} s`,
      );
    }
  });
}
