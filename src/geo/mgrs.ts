const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const DEG = Math.PI / 180;
const N = F / (2 - F);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N3 * N;
const N5 = N4 * N;
const N6 = N5 * N;
const RECTIFY = (A / (1 + N)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
const ALPHA = [
  N / 2 - (2 * N2) / 3 + (5 * N3) / 16 + (41 * N4) / 180 - (127 * N5) / 288 + (7891 * N6) / 37800,
  (13 * N2) / 48 - (3 * N3) / 5 + (557 * N4) / 1440 + (281 * N5) / 630 - (1983433 * N6) / 1935360,
  (61 * N3) / 240 - (103 * N4) / 140 + (15061 * N5) / 26880 + (167603 * N6) / 181440,
  (49561 * N4) / 161280 - (179 * N5) / 168 + (6601661 * N6) / 7257600,
  (34729 * N5) / 80640 - (3418889 * N6) / 1995840,
  (212378941 * N6) / 319334400,
];
const BETA = [
  N / 2 - (2 * N2) / 3 + (37 * N3) / 96 - N4 / 360 - (81 * N5) / 512 + (96199 * N6) / 604800,
  N2 / 48 + N3 / 15 - (437 * N4) / 1440 + (46 * N5) / 105 - (1118711 * N6) / 3870720,
  (17 * N3) / 480 - (37 * N4) / 840 - (209 * N5) / 4480 + (5569 * N6) / 90720,
  (4397 * N4) / 161280 - (11 * N5) / 504 - (830251 * N6) / 7257600,
  (4583 * N5) / 161280 - (108847 * N6) / 3991680,
  (20648693 * N6) / 638668800,
];
const DELTA = [
  2 * N - (2 * N2) / 3 - 2 * N3 + (116 * N4) / 45 + (26 * N5) / 45 - (2854 * N6) / 675,
  (7 * N2) / 3 - (8 * N3) / 5 - (227 * N4) / 45 + (2704 * N5) / 315 + (2323 * N6) / 945,
  (56 * N3) / 15 - (136 * N4) / 35 - (1262 * N5) / 105 + (73814 * N6) / 2835,
  (4279 * N4) / 630 - (332 * N5) / 35 - (399572 * N6) / 14175,
  (4174 * N5) / 315 - (144838 * N6) / 6237,
  (601676 * N6) / 22275,
];
const ECCENTRICITY = Math.sqrt(F * (2 - F));
const BANDS = "CDEFGHJKLMNPQRSTUVWX";
const COLUMNS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
const ROWS = "ABCDEFGHJKLMNPQRSTUV";

export interface Utm {
  zone: number;
  hemisphere: "N" | "S";
  easting: number;
  northing: number;
}

export function utmZone(lng: number, lat: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  let zone = Math.min(60, Math.floor((wrapped + 180) / 6) + 1);
  if (lat >= 56 && lat < 64 && wrapped >= 3 && wrapped < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (wrapped >= 0 && wrapped < 9) zone = 31;
    else if (wrapped >= 9 && wrapped < 21) zone = 33;
    else if (wrapped >= 21 && wrapped < 33) zone = 35;
    else if (wrapped >= 33 && wrapped < 42) zone = 37;
  }
  return zone;
}

export function toUtm(lngLat: readonly [number, number], forceZone?: number): Utm | null {
  const [lng, lat] = lngLat;
  if (!(lat >= -80 && lat <= 84) || !Number.isFinite(lng)) return null;
  const zone = forceZone ?? utmZone(lng, lat);
  const phi = lat * DEG;
  let lambda = lng * DEG - ((zone - 1) * 6 - 177) * DEG;
  lambda = Math.atan2(Math.sin(lambda), Math.cos(lambda));
  const sin = Math.sin(phi);
  const tau = Math.sinh(Math.atanh(sin) - ECCENTRICITY * Math.atanh(ECCENTRICITY * sin));
  const xi0 = Math.atan2(tau, Math.cos(lambda));
  const eta0 = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + tau * tau));
  let xi = xi0;
  let eta = eta0;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1]! * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += ALPHA[j - 1]! * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  const easting = 500000 + K0 * RECTIFY * eta;
  const northing = K0 * RECTIFY * xi + (lat < 0 ? 10000000 : 0);
  return { zone, hemisphere: lat < 0 ? "S" : "N", easting, northing };
}

export function fromUtm(utm: Utm): [number, number] | null {
  const { zone, hemisphere, easting, northing } = utm;
  if (!(zone >= 1 && zone <= 60) || !Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  const xi = (northing - (hemisphere === "S" ? 10000000 : 0)) / (K0 * RECTIFY);
  const eta = (easting - 500000) / (K0 * RECTIFY);
  let xi0 = xi;
  let eta0 = eta;
  for (let j = 1; j <= 6; j++) {
    xi0 -= BETA[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta0 -= BETA[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi0) / Math.cosh(eta0));
  let phi = chi;
  for (let j = 1; j <= 6; j++) phi += DELTA[j - 1]! * Math.sin(2 * j * chi);
  const lambda = Math.atan2(Math.sinh(eta0), Math.cos(xi0));
  const lng = lambda / DEG + (zone - 1) * 6 - 177;
  return [((((lng + 180) % 360) + 360) % 360) - 180, phi / DEG];
}

function band(lat: number): string {
  return BANDS[Math.min(19, Math.max(0, Math.floor((lat + 80) / 8)))]!;
}

export function toMgrs(lngLat: readonly [number, number], digits = 5): string | null {
  const utm = toUtm(lngLat);
  if (!utm) return null;
  const precision = Math.max(0, Math.min(5, Math.round(digits)));
  const column = COLUMNS[(utm.zone - 1) % 3]![Math.floor(utm.easting / 100000) - 1];
  const row = ROWS[(Math.floor(utm.northing / 100000) + (utm.zone % 2 === 0 ? 5 : 0)) % 20];
  if (!column || !row) return null;
  const scale = 10 ** (5 - precision);
  const e = Math.floor((utm.easting % 100000) / scale);
  const n = Math.floor((utm.northing % 100000) / scale);
  const pad = (v: number) => (precision === 0 ? "" : String(v).padStart(precision, "0"));
  return `${String(utm.zone).padStart(2, "0")}${band(lngLat[1])}${column}${row}${pad(e)}${pad(n)}`;
}

export interface MgrsPoint {
  lngLat: [number, number];
  precision: number;
}

export function fromMgrs(text: string): MgrsPoint | null {
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/.exec(
    String(text).toUpperCase().replace(/\s+/g, ""),
  );
  if (!m) return null;
  const zone = Number(m[1]);
  const digits = m[5]!;
  if (zone < 1 || zone > 60 || digits.length % 2 !== 0 || digits.length > 10) return null;
  const bandIndex = BANDS.indexOf(m[2]!);
  const set = (zone - 1) % 3;
  const col = COLUMNS[set]!.indexOf(m[3]!);
  const rowIndex = ROWS.indexOf(m[4]!);
  if (col < 0 || rowIndex < 0) return null;
  const precision = digits.length / 2;
  const scale = 10 ** (5 - precision);
  const e = (precision ? Number(digits.slice(0, precision)) * scale : 0) + scale / 2;
  const n = (precision ? Number(digits.slice(precision)) * scale : 0) + scale / 2;
  const easting = (col + 1) * 100000 + e;
  let northing = ((((rowIndex - (zone % 2 === 0 ? 5 : 0)) % 20) + 20) % 20) * 100000 + n;
  const south = bandIndex < 10;
  const bandSouth = -80 + bandIndex * 8;
  const floor = toUtm([(zone - 1) * 6 - 177, bandSouth], zone);
  if (!floor) return null;
  while (northing < floor.northing - 100000) northing += 2000000;
  const lngLat = fromUtm({ zone, hemisphere: south ? "S" : "N", easting, northing });
  if (!lngLat) return null;
  return { lngLat, precision };
}
