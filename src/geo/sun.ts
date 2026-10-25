const RAD = Math.PI / 180;

export interface SunPosition {
  readonly declination: number;
  readonly subsolarLng: number;
}

export function sunPosition(time: number): SunPosition {
  const jd = time / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const meanLng = (((280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360) + 360) % 360;
  const anomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = anomaly * RAD;
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const apparent = (meanLng + center - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparent)) / RAD;
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLng * RAD;
  const equation =
    (4 / RAD) *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));
  const minutes = (((time / 60000) % 1440) + 1440) % 1440;
  const subsolarLng = wrapLng((720 - minutes - equation) / 4);
  return { declination, subsolarLng };
}

export function sunAltitude(sun: SunPosition, lng: number, lat: number): number {
  const phi = lat * RAD;
  const delta = sun.declination * RAD;
  const h = (lng - sun.subsolarLng) * RAD;
  const s = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(h);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

export function sunAzimuth(sun: SunPosition, lng: number, lat: number): number {
  const phi = lat * RAD;
  const delta = sun.declination * RAD;
  const h = (lng - sun.subsolarLng) * RAD;
  const a = Math.atan2(-Math.sin(h), Math.tan(delta) * Math.cos(phi) - Math.sin(phi) * Math.cos(h)) / RAD;
  return (a + 360) % 360;
}

function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}
