export const ROUTE_MAGIC = 0x47524b4d;
export const ROUTE_VERSION = 1;

export const ROAD_CLASSES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
  "track",
  "pedestrian",
  "footway",
  "path",
  "cycleway",
  "bridleway",
  "steps",
] as const;

export type RoadClass = (typeof ROAD_CLASSES)[number];

export const CAR_FORWARD = 1;
export const CAR_BACKWARD = 2;
export const BIKE_FORWARD = 4;
export const BIKE_BACKWARD = 8;
export const FOOT = 16;
export const ROUNDABOUT = 32;
export const TOLL = 64;
export const MINOR_SERVICE = 128;
export const DESTINATION_ONLY = 256;

export const MODE_CAR = 1;
export const MODE_BIKE = 2;
export const MODE_FOOT = 4;

export const RESTRICT_NO = 0;
export const RESTRICT_ONLY = 1;

export interface RouteMeta {
  bbox: [number, number, number, number];
  names: string[];
  nodes: number;
  edges: number;
  shape: number;
  restrictions: number;
  created?: string;
}

export interface RouteData {
  meta: RouteMeta;
  nodeLon: Int32Array;
  nodeLat: Int32Array;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  edgeLength: Float32Array;
  edgeClass: Uint8Array;
  edgeFlags: Uint16Array;
  edgeSpeed: Uint8Array;
  edgeName: Int32Array;
  edgeRef: Int32Array;
  shapeStart: Uint32Array;
  shapeLon: Int32Array;
  shapeLat: Int32Array;
  resFrom: Uint32Array;
  resVia: Uint32Array;
  resTo: Uint32Array;
  resKind: Uint8Array;
  resModes: Uint8Array;
}

type Section = Exclude<keyof RouteData, "meta">;

const SECTIONS: readonly [Section, "i32" | "u32" | "f32" | "u8" | "u16", (m: RouteMeta) => number][] = [
  ["nodeLon", "i32", (m) => m.nodes],
  ["nodeLat", "i32", (m) => m.nodes],
  ["edgeFrom", "u32", (m) => m.edges],
  ["edgeTo", "u32", (m) => m.edges],
  ["edgeLength", "f32", (m) => m.edges],
  ["edgeName", "i32", (m) => m.edges],
  ["edgeRef", "i32", (m) => m.edges],
  ["shapeStart", "u32", (m) => m.edges + 1],
  ["shapeLon", "i32", (m) => m.shape],
  ["shapeLat", "i32", (m) => m.shape],
  ["resFrom", "u32", (m) => m.restrictions],
  ["resVia", "u32", (m) => m.restrictions],
  ["resTo", "u32", (m) => m.restrictions],
  ["edgeFlags", "u16", (m) => m.edges],
  ["edgeClass", "u8", (m) => m.edges],
  ["edgeSpeed", "u8", (m) => m.edges],
  ["resKind", "u8", (m) => m.restrictions],
  ["resModes", "u8", (m) => m.restrictions],
];

const SIZE = { i32: 4, u32: 4, f32: 4, u16: 2, u8: 1 } as const;

export function encodeRoute(data: RouteData): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(data.meta));
  let offset = align(12 + json.length);
  const placed: [Section, number][] = [];
  for (const [name, type, count] of SECTIONS) {
    offset = align(offset);
    placed.push([name, offset]);
    offset += count(data.meta) * SIZE[type];
  }
  const out = new Uint8Array(align(offset));
  const view = new DataView(out.buffer);
  view.setUint32(0, ROUTE_MAGIC, true);
  view.setUint32(4, ROUTE_VERSION, true);
  view.setUint32(8, json.length, true);
  out.set(json, 12);
  for (const [name, at] of placed) {
    const array = data[name];
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at);
  }
  return out;
}

export function decodeRoute(bytes: Uint8Array): RouteData {
  const buffer = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== ROUTE_MAGIC) throw new Error("Not a Mapkern route file");
  const version = view.getUint32(4, true);
  if (version !== ROUTE_VERSION) throw new Error(`Route file version ${version} is not supported`);
  const length = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(buffer.subarray(12, 12 + length))) as RouteMeta;
  let offset = align(12 + length);
  const out: Record<string, unknown> = { meta };
  for (const [name, type, count] of SECTIONS) {
    offset = align(offset);
    const n = count(meta);
    const at = buffer.byteOffset + offset;
    if (offset + n * SIZE[type] > buffer.byteLength) throw new Error("The route file is cut short");
    const b = buffer.buffer;
    out[name] =
      type === "i32"
        ? new Int32Array(b, at, n)
        : type === "u32"
          ? new Uint32Array(b, at, n)
          : type === "f32"
            ? new Float32Array(b, at, n)
            : type === "u16"
              ? new Uint16Array(b, at, n)
              : new Uint8Array(b, at, n);
    offset += n * SIZE[type];
  }
  return out as unknown as RouteData;
}

function align(n: number): number {
  return (n + 3) & ~3;
}
