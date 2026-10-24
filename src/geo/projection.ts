export type Unproject = (x: number, y: number) => [number, number];

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

interface Ellipsoid {
  a: number;
  f: number;
}

const WGS84: Ellipsoid = { a: 6378137, f: 1 / 298.257223563 };
const DEG = Math.PI / 180;

interface WktNode {
  name: string;
  args: (string | number | WktNode)[];
}

export function projectionFromWkt(wkt: string): Unproject | null {
  const root = parseWktCrs(wkt);
  if (!root) throw new ProjectionError("The projection file could not be read");
  const name = root.name.toUpperCase();
  if (name === "GEOGCS" || name === "GEOGCRS" || name === "GEODCRS") return null;
  if (name !== "PROJCS" && name !== "PROJCRS") throw new ProjectionError(`Unsupported coordinate system ${root.name}`);
  const projection = String(find(root, "PROJECTION")?.args[0] ?? find(root, "METHOD")?.args[0] ?? "");
  const params = new Map<string, number>();
  for (const p of findAll(root, "PARAMETER")) {
    const key = String(p.args[0] ?? "").toLowerCase().replace(/\s+/g, "_");
    const value = Number(p.args[1]);
    if (Number.isFinite(value)) params.set(key, value);
  }
  const spheroid = find(root, "SPHEROID") ?? find(root, "ELLIPSOID");
  const a = Number(spheroid?.args[1]);
  const invf = Number(spheroid?.args[2]);
  const ellipsoid: Ellipsoid = Number.isFinite(a) && a > 0 ? { a, f: invf > 0 ? 1 / invf : 0 } : WGS84;
  const unitNode = root.args.filter((x): x is WktNode => typeof x === "object" && /^(UNIT|LENGTHUNIT)$/i.test(x.name)).pop();
  const unit = Number(unitNode?.args[1]) > 0 ? Number(unitNode!.args[1]) : 1;
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = params.get(k);
      if (v !== undefined) return v;
    }
    return 0;
  };
  const fe = get("false_easting") * unit;
  const fn = get("false_northing") * unit;
  const lon0 = get("central_meridian", "longitude_of_center", "longitude_of_origin", "longitude_of_natural_origin");
  const lat0 = get("latitude_of_origin", "latitude_of_center", "latitude_of_natural_origin");
  const k0 = params.get("scale_factor") ?? params.get("scale_factor_at_natural_origin") ?? 1;
  const p = projection.toLowerCase();
  let inverse: Unproject;
  if (p.includes("mercator_auxiliary_sphere") || p.includes("pseudo") || (p.includes("mercator") && /web|3857|auxiliary/i.test(wkt))) {
    inverse = webMercatorInverse(fe, fn);
  } else if (p.includes("transverse_mercator") || p.includes("transverse mercator")) {
    inverse = transverseMercatorInverse(ellipsoid, lon0, lat0, k0, fe, fn);
  } else if (p.includes("lambert_conformal_conic") || p.includes("lambert conic conformal")) {
    const sp1 = params.get("standard_parallel_1") ?? params.get("latitude_of_1st_standard_parallel");
    const sp2 = params.get("standard_parallel_2") ?? params.get("latitude_of_2nd_standard_parallel");
    inverse = lambertInverse(ellipsoid, lon0, lat0, sp1 ?? lat0, sp2 ?? sp1 ?? lat0, sp1 === undefined ? k0 : 1, fe, fn);
  } else if (p === "mercator" || p.includes("mercator_1sp") || p.includes("mercator_2sp")) {
    inverse = mercatorInverse(ellipsoid, lon0, k0, fe, fn);
  } else {
    throw new ProjectionError(`The ${projection || "unknown"} projection is not supported. Convert the data to longitude and latitude (EPSG:4326) first`);
  }
  return unit === 1 ? inverse : (x, y) => inverse(x * unit, y * unit);
}

export function projectionFromEpsg(code: number): Unproject | null {
  if (code === 4326 || code === 4269 || code === 4258 || code === 4979 || code === 0) return null;
  if (code === 3857 || code === 900913 || code === 102100) return webMercatorInverse(0, 0);
  const utm = (zone: number, south: boolean) =>
    transverseMercatorInverse(WGS84, -183 + 6 * zone, 0, 0.9996, 500000, south ? 10000000 : 0);
  if (code >= 32601 && code <= 32660) return utm(code - 32600, false);
  if (code >= 32701 && code <= 32760) return utm(code - 32700, true);
  if (code >= 25801 && code <= 25860) return utm(code - 25800, false);
  if (code >= 26901 && code <= 26923) return utm(code - 26900, false);
  throw new ProjectionError(`EPSG:${code} is not supported. Convert the data to longitude and latitude (EPSG:4326) first`);
}

function webMercatorInverse(fe: number, fn: number): Unproject {
  const r = 6378137;
  return (x, y) => [((x - fe) / r) / DEG, (2 * Math.atan(Math.exp((y - fn) / r)) - Math.PI / 2) / DEG];
}

function mercatorInverse(e: Ellipsoid, lon0: number, k0: number, fe: number, fn: number): Unproject {
  const ecc = Math.sqrt(e.f * (2 - e.f));
  return (x, y) => {
    const t = Math.exp(-(y - fn) / (e.a * k0));
    return [lon0 + ((x - fe) / (e.a * k0)) / DEG, latitudeFromT(t, ecc) / DEG];
  };
}

function transverseMercatorInverse(e: Ellipsoid, lon0: number, lat0: number, k0: number, fe: number, fn: number): Unproject {
  const e2 = e.f * (2 - e.f);
  const ep2 = e2 / (1 - e2);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const arc = (phi: number) =>
    e.a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi));
  const m0 = arc(lat0 * DEG);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  return (x, y) => {
    const m = m0 + (y - fn) / k0;
    const mu = m / (e.a * (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));
    const phi1 =
      mu +
      ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
      ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
      ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
      ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
    const sin1 = Math.sin(phi1);
    const cos1 = Math.cos(phi1);
    const tan1 = Math.tan(phi1);
    const c1 = ep2 * cos1 * cos1;
    const t1 = tan1 * tan1;
    const n1 = e.a / Math.sqrt(1 - e2 * sin1 * sin1);
    const r1 = (e.a * (1 - e2)) / (1 - e2 * sin1 * sin1) ** 1.5;
    const d = (x - fe) / (n1 * k0);
    const lat =
      phi1 -
      ((n1 * tan1) / r1) *
        ((d * d) / 2 -
          ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
          ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);
    const lon =
      lon0 * DEG +
      (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
        cos1;
    return [lon / DEG, lat / DEG];
  };
}

function lambertInverse(
  e: Ellipsoid,
  lon0: number,
  lat0: number,
  sp1: number,
  sp2: number,
  k0: number,
  fe: number,
  fn: number,
): Unproject {
  const ecc = Math.sqrt(e.f * (2 - e.f));
  const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - ecc * ecc * Math.sin(phi) ** 2);
  const t = (phi: number) =>
    Math.tan(Math.PI / 4 - phi / 2) / ((1 - ecc * Math.sin(phi)) / (1 + ecc * Math.sin(phi))) ** (ecc / 2);
  const p1 = sp1 * DEG;
  const p2 = sp2 * DEG;
  const n = Math.abs(p1 - p2) < 1e-10 ? Math.sin(p1) : (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const big = m(p1) / (n * t(p1) ** n);
  const rho0 = e.a * big * k0 * t(lat0 * DEG) ** n;
  return (x, y) => {
    const dx = x - fe;
    const dy = rho0 - (y - fn);
    const sign = n < 0 ? -1 : 1;
    const rho = sign * Math.hypot(dx, dy);
    const theta = Math.atan2(sign * dx, sign * dy);
    const tt = (rho / (e.a * big * k0)) ** (1 / n);
    return [(theta / n) / DEG + lon0, latitudeFromT(tt, ecc) / DEG];
  };
}

function latitudeFromT(t: number, ecc: number): number {
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 15; i++) {
    const s = ecc * Math.sin(phi);
    const next = Math.PI / 2 - 2 * Math.atan(t * ((1 - s) / (1 + s)) ** (ecc / 2));
    if (Math.abs(next - phi) < 1e-12) return next;
    phi = next;
  }
  return phi;
}

function parseWktCrs(text: string): WktNode | null {
  let i = 0;
  const space = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const node = (): WktNode | null => {
    space();
    const start = i;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++;
    const name = text.slice(start, i);
    space();
    if (!name || (text[i] !== "[" && text[i] !== "(")) return null;
    const close = text[i] === "[" ? "]" : ")";
    i++;
    const args: (string | number | WktNode)[] = [];
    for (;;) {
      space();
      const c = text[i];
      if (c === undefined) return null;
      if (c === close) {
        i++;
        return { name, args };
      }
      if (c === ",") {
        i++;
        continue;
      }
      if (c === '"') {
        const end = text.indexOf('"', i + 1);
        if (end < 0) return null;
        args.push(text.slice(i + 1, end));
        i = end + 1;
      } else if (/[-+.\d]/.test(c)) {
        const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(i));
        if (!m) return null;
        args.push(Number(m[0]));
        i += m[0].length;
      } else {
        const child = node();
        if (!child) {
          const start = i;
          while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++;
          if (i === start) return null;
          args.push(text.slice(start, i));
        } else {
          args.push(child);
        }
      }
    }
  };
  return node();
}

function find(node: WktNode, name: string): WktNode | undefined {
  for (const arg of node.args) {
    if (typeof arg !== "object") continue;
    if (arg.name.toUpperCase() === name) return arg;
    const deeper = find(arg, name);
    if (deeper) return deeper;
  }
  return undefined;
}

function findAll(node: WktNode, name: string, out: WktNode[] = []): WktNode[] {
  for (const arg of node.args) {
    if (typeof arg !== "object") continue;
    if (arg.name.toUpperCase() === name) out.push(arg);
    else findAll(arg, name, out);
  }
  return out;
}
