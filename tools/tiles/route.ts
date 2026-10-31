import type { RouteData } from "../../src/route/format.ts";
import { BIKE_BACKWARD, BIKE_FORWARD, CAR_BACKWARD, CAR_FORWARD, FOOT, ROAD_CLASSES } from "../../src/route/format.ts";
import type { RegionData } from "./extract.ts";
import { isRouteWay, maxspeedOf, restrictionModes, wayFlags } from "./route-schema.ts";

const MOVE = CAR_FORWARD | CAR_BACKWARD | BIKE_FORWARD | BIKE_BACKWARD | FOOT;
const EARTH = 6371008.8;

class Grow<T extends Int32Array | Uint32Array | Float32Array | Uint8Array | Uint16Array> {
  data: T;
  n = 0;
  private readonly make: (n: number) => T;
  constructor(make: (n: number) => T) {
    this.make = make;
    this.data = make(1024);
  }
  push(v: number): void {
    if (this.n === this.data.length) {
      const next = this.make(this.n * 2);
      next.set(this.data as never);
      this.data = next;
    }
    this.data[this.n++] = v;
  }
  done(): T {
    return this.data.slice(0, this.n) as T;
  }
}

function findNode(ids: Float64Array, id: number): number {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid]!;
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function distance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const p1 = (lat1 * 1e-7 * Math.PI) / 180;
  const p2 = (lat2 * 1e-7 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * 1e-7 * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface RouteBuildStats {
  ways: number;
  edges: number;
  nodes: number;
  restrictions: number;
  viaWaySkipped: number;
  brokenSkipped: number;
}

export function buildRouteGraph(
  region: RegionData,
  log: (message: string) => void = () => undefined,
): { data: RouteData; stats: RouteBuildStats } {
  const nodeCount = region.nodeIds.length;
  const uses = new Uint8Array(nodeCount);
  const wayFlag = new Int32Array(region.wayIds.length).fill(-1);
  let ways = 0;
  for (let w = 0; w < region.wayIds.length; w++) {
    const tags = region.wayTags[w];
    if (!tags || !isRouteWay(tags)) continue;
    const flags = wayFlags(tags);
    if ((flags & MOVE) === 0) continue;
    wayFlag[w] = flags;
    ways++;
    const start = region.wayOffsets[w]!;
    const end = region.wayOffsets[w + 1]!;
    let last = -2;
    for (let i = start; i < end; i++) {
      const n = findNode(region.nodeIds, region.wayRefs[i]!);
      if (n < 0) {
        if (last >= 0 && uses[last]! < 2) uses[last] = 2;
        last = -1;
        continue;
      }
      if (n === last) continue;
      const end1 = i === start || i === end - 1 || last === -1;
      uses[n] = Math.min(250, uses[n]! + (end1 ? 2 : 1));
      last = n;
    }
  }
  const viaNodes = new Set<number>();
  for (const rel of region.relations) {
    const via = rel.tags["@via"];
    if (rel.tags.type !== "restriction" || !via) continue;
    const n = findNode(region.nodeIds, Number(via));
    if (n >= 0) viaNodes.add(n);
  }
  for (const n of viaNodes) if (uses[n]! > 0) uses[n] = Math.max(uses[n]!, 2);
  const graphId = new Int32Array(nodeCount).fill(-1);
  const nodeLon = new Grow((n) => new Int32Array(n));
  const nodeLat = new Grow((n) => new Int32Array(n));
  const node = (n: number) => {
    let id = graphId[n]!;
    if (id < 0) {
      id = nodeLon.n;
      graphId[n] = id;
      nodeLon.push(region.nodeLon[n]!);
      nodeLat.push(region.nodeLat[n]!);
    }
    return id;
  };
  const edgeFrom = new Grow((n) => new Uint32Array(n));
  const edgeTo = new Grow((n) => new Uint32Array(n));
  const edgeLength = new Grow((n) => new Float32Array(n));
  const edgeClass = new Grow((n) => new Uint8Array(n));
  const edgeFlags = new Grow((n) => new Uint16Array(n));
  const edgeSpeed = new Grow((n) => new Uint8Array(n));
  const edgeName = new Grow((n) => new Int32Array(n));
  const edgeRef = new Grow((n) => new Int32Array(n));
  const shapeStart = new Grow((n) => new Uint32Array(n));
  const shapeLon = new Grow((n) => new Int32Array(n));
  const shapeLat = new Grow((n) => new Int32Array(n));
  const names: string[] = [];
  const nameIds = new Map<string, number>();
  const nameOf = (value: string | undefined) => {
    if (!value) return -1;
    let id = nameIds.get(value);
    if (id === undefined) {
      id = names.length;
      names.push(value);
      nameIds.set(value, id);
    }
    return id;
  };
  const wayEdges = new Map<number, { edge: number; a: number; b: number }[]>();
  for (let w = 0; w < region.wayIds.length; w++) {
    const flags = wayFlag[w]!;
    if (flags < 0) continue;
    const tags = region.wayTags[w]!;
    const highway = tags.highway!;
    const cls = ROAD_CLASSES.indexOf(highway as (typeof ROAD_CLASSES)[number]);
    const speed = maxspeedOf(tags.maxspeed, highway);
    const name = nameOf(tags.name);
    const ref = nameOf(tags.ref);
    const list: { edge: number; a: number; b: number }[] = [];
    const start = region.wayOffsets[w]!;
    const end = region.wayOffsets[w + 1]!;
    let from = -1;
    let prev = -1;
    let length = 0;
    const pendingLon: number[] = [];
    const pendingLat: number[] = [];
    const emit = (to: number) => {
      const a = node(from);
      const b = node(to);
      const id = edgeFrom.n;
      edgeFrom.push(a);
      edgeTo.push(b);
      edgeLength.push(length);
      edgeClass.push(cls);
      edgeFlags.push(flags);
      edgeSpeed.push(speed);
      edgeName.push(name);
      edgeRef.push(ref);
      shapeStart.push(shapeLon.n);
      for (let k = 0; k < pendingLon.length; k++) {
        shapeLon.push(pendingLon[k]!);
        shapeLat.push(pendingLat[k]!);
      }
      list.push({ edge: id, a, b });
    };
    for (let i = start; i < end; i++) {
      const n = findNode(region.nodeIds, region.wayRefs[i]!);
      if (n < 0) {
        if (from >= 0 && prev >= 0 && prev !== from) {
          pendingLon.pop();
          pendingLat.pop();
          emit(prev);
        }
        from = -1;
        prev = -1;
        length = 0;
        pendingLon.length = 0;
        pendingLat.length = 0;
        continue;
      }
      if (n === prev) continue;
      if (from < 0) {
        from = n;
        prev = n;
        length = 0;
        pendingLon.length = 0;
        pendingLat.length = 0;
        continue;
      }
      length += distance(region.nodeLon[prev]!, region.nodeLat[prev]!, region.nodeLon[n]!, region.nodeLat[n]!);
      prev = n;
      if (uses[n]! >= 2 || i === end - 1) {
        emit(n);
        from = n;
        length = 0;
        pendingLon.length = 0;
        pendingLat.length = 0;
      } else {
        pendingLon.push(region.nodeLon[n]!);
        pendingLat.push(region.nodeLat[n]!);
      }
    }
    wayEdges.set(region.wayIds[w]!, list);
  }
  shapeStart.push(shapeLon.n);
  log(
    `route graph: ${nodeLon.n.toLocaleString()} nodes, ${edgeFrom.n.toLocaleString()} edges from ${ways.toLocaleString()} ways`,
  );

  const resFrom = new Grow((n) => new Uint32Array(n));
  const resVia = new Grow((n) => new Uint32Array(n));
  const resTo = new Grow((n) => new Uint32Array(n));
  const resKind = new Grow((n) => new Uint8Array(n));
  const resModes = new Grow((n) => new Uint8Array(n));
  let viaWaySkipped = 0;
  let brokenSkipped = 0;
  for (const rel of region.relations) {
    if (rel.tags.type !== "restriction") continue;
    const parsed = restrictionModes(rel.tags);
    if (!parsed) continue;
    const viaTag = rel.tags["@via"];
    if (!viaTag) {
      if (rel.members.some((m) => m.role === "via")) viaWaySkipped++;
      else brokenSkipped++;
      continue;
    }
    const viaIndex = findNode(region.nodeIds, Number(viaTag));
    const via = viaIndex >= 0 ? graphId[viaIndex]! : -1;
    const fromWay = rel.members.find((m) => m.role === "from");
    const toWay = rel.members.find((m) => m.role === "to");
    if (via < 0 || !fromWay || !toWay) {
      brokenSkipped++;
      continue;
    }
    const touching = (way: number) => (wayEdges.get(way) ?? []).filter((e) => e.a === via || e.b === via);
    const froms = touching(fromWay.ref);
    const tos = touching(toWay.ref);
    if (froms.length === 0 || tos.length === 0) {
      brokenSkipped++;
      continue;
    }
    const kind = parsed.value.startsWith("only_") ? 1 : 0;
    for (const f of froms) {
      for (const t of tos) {
        if (f.edge === t.edge && !parsed.value.endsWith("u_turn")) continue;
        resFrom.push(f.edge);
        resVia.push(via);
        resTo.push(t.edge);
        resKind.push(kind);
        resModes.push(parsed.modes);
      }
    }
  }
  log(
    `turn restrictions: ${resFrom.n.toLocaleString()} kept, ${viaWaySkipped} with a via way left out, ${brokenSkipped} broken`,
  );
  const data: RouteData = {
    meta: {
      bbox: region.bbox,
      names,
      nodes: nodeLon.n,
      edges: edgeFrom.n,
      shape: shapeLon.n,
      restrictions: resFrom.n,
      created: new Date().toISOString(),
    },
    nodeLon: nodeLon.done(),
    nodeLat: nodeLat.done(),
    edgeFrom: edgeFrom.done(),
    edgeTo: edgeTo.done(),
    edgeLength: edgeLength.done(),
    edgeClass: edgeClass.done(),
    edgeFlags: edgeFlags.done(),
    edgeSpeed: edgeSpeed.done(),
    edgeName: edgeName.done(),
    edgeRef: edgeRef.done(),
    shapeStart: shapeStart.done(),
    shapeLon: shapeLon.done(),
    shapeLat: shapeLat.done(),
    resFrom: resFrom.done(),
    resVia: resVia.done(),
    resTo: resTo.done(),
    resKind: resKind.done(),
    resModes: resModes.done(),
  };
  return {
    data,
    stats: {
      ways,
      edges: edgeFrom.n,
      nodes: nodeLon.n,
      restrictions: resFrom.n,
      viaWaySkipped,
      brokenSkipped,
    },
  };
}
