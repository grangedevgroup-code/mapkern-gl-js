import type { Geometry, Position } from "../geo/geojson.ts";

export function assemblePolygons(rings: Position[][]): Geometry | null {
  if (rings.length === 0) return null;
  const outers: Position[][][] = [];
  const holes: Position[][] = [];
  for (const ring of rings) {
    if (ringArea(ring) < 0) outers.push([ring]);
    else holes.push(ring);
  }
  if (outers.length === 0) return { type: "Polygon", coordinates: rings };
  for (const hole of holes) {
    const [x, y] = hole[0]!;
    const owner = outers.find((poly) => ringContains(poly[0]!, x!, y!));
    if (owner) owner.push(hole);
    else outers.push([hole]);
  }
  return outers.length === 1
    ? { type: "Polygon", coordinates: outers[0]! }
    : { type: "MultiPolygon", coordinates: outers };
}

export function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j]![0]! - ring[i]![0]!) * (ring[i]![1]! + ring[j]![1]!);
  }
  return sum / 2;
}

export function ringContains(ring: Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}
