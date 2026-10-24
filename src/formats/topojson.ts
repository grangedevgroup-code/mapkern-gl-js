import type { Feature, FeatureCollection, Geometry, Position } from "../geo/geojson.ts";

interface Topology {
  type: "Topology";
  objects: Record<string, TopoObject>;
  arcs: number[][][];
  transform?: { scale: [number, number]; translate: [number, number] };
}

interface TopoObject {
  type: string;
  id?: string | number;
  properties?: Record<string, unknown>;
  geometries?: TopoObject[];
  arcs?: unknown;
  coordinates?: unknown;
}

export function isTopology(value: unknown): value is Topology {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "Topology" &&
    typeof (value as { objects?: unknown }).objects === "object"
  );
}

export function topologyToGeoJSON(topology: Topology): FeatureCollection {
  const arcs = decodeArcs(topology);
  const point = (p: unknown): Position => {
    const [x, y] = Array.isArray(p) ? (p as number[]) : [Number.NaN, Number.NaN];
    const t = topology.transform;
    return t ? [x! * t.scale[0] + t.translate[0], y! * t.scale[1] + t.translate[1]] : [x!, y!];
  };
  const line = (indexes: unknown): Position[] => {
    const out: Position[] = [];
    if (!Array.isArray(indexes)) return out;
    for (const index of indexes as number[]) {
      const arc = arcs[index < 0 ? ~index : index];
      if (!arc) continue;
      const points = index < 0 ? [...arc].reverse() : arc;
      for (let k = out.length > 0 ? 1 : 0; k < points.length; k++) out.push(points[k]!);
    }
    return out;
  };
  const ring = (indexes: unknown): Position[] => {
    const r = line(indexes);
    if (r.length > 0) {
      const first = r[0]!;
      const last = r[r.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) r.push([first[0]!, first[1]!]);
    }
    return r;
  };
  const geometry = (o: TopoObject): Geometry | null => {
    const a = o.arcs as unknown[];
    switch (o.type) {
      case "Point":
        return { type: "Point", coordinates: point(o.coordinates) };
      case "MultiPoint":
        return { type: "MultiPoint", coordinates: ((o.coordinates as unknown[]) ?? []).map(point) };
      case "LineString":
        return { type: "LineString", coordinates: line(a) };
      case "MultiLineString":
        return { type: "MultiLineString", coordinates: (a ?? []).map(line) };
      case "Polygon":
        return { type: "Polygon", coordinates: (a ?? []).map(ring) };
      case "MultiPolygon":
        return { type: "MultiPolygon", coordinates: (a ?? []).map((p) => (p as unknown[]).map(ring)) };
      case "GeometryCollection": {
        const geometries = (o.geometries ?? []).map(geometry).filter((g): g is Geometry => g !== null);
        return { type: "GeometryCollection", geometries };
      }
      default:
        return null;
    }
  };
  const features: Feature[] = [];
  const visit = (o: TopoObject) => {
    if (o.type === "GeometryCollection" && !o.properties) {
      for (const g of o.geometries ?? []) visit(g);
      return;
    }
    const g = geometry(o);
    if (!g) return;
    const feature: Feature = { type: "Feature", properties: o.properties ?? {}, geometry: g };
    if (o.id !== undefined) feature.id = o.id;
    features.push(feature);
  };
  for (const object of Object.values(topology.objects)) visit(object);
  return { type: "FeatureCollection", features };
}

function decodeArcs(topology: Topology): Position[][] {
  const t = topology.transform;
  return (topology.arcs ?? []).map((arc) => {
    if (!t) return arc.map((p) => [p[0]!, p[1]!]);
    let x = 0;
    let y = 0;
    return arc.map((p) => {
      x += p[0]!;
      y += p[1]!;
      return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]];
    });
  });
}
