import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { bytesToGeoJSON, objectToGeoJSON } from "../../src/formats/convert.ts";
import { csvToGeoJSON, parseCsv } from "../../src/formats/csv.ts";
import { gpxToGeoJSON } from "../../src/formats/gpx.ts";
import { kmlToGeoJSON } from "../../src/formats/kml.ts";
import { shapefileToGeoJSON } from "../../src/formats/shapefile.ts";
import { topologyToGeoJSON } from "../../src/formats/topojson.ts";
import { parseWkt } from "../../src/formats/wkt.ts";
import { parseXml, textOf } from "../../src/formats/xml.ts";
import type { FeatureCollection } from "../../src/geo/geojson.ts";

const encode = (s: string) => new TextEncoder().encode(s);
const close = (a: number, b: number, eps: number, what = "") =>
  assert.ok(Math.abs(a - b) <= eps, `${what} ${a} is not within ${eps} of ${b}`);

test("the XML reader handles entities, CDATA, comments and namespaces", () => {
  const doc = parseXml(
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY nope "boom">]><!-- c --><kml:a k="1 &amp; 2"><b>x &lt; y &#38; &#x41;</b><c><![CDATA[<raw>]]></c><d/></kml:a>',
  );
  const a = doc.children[0]!;
  assert.equal(a.name, "a");
  assert.equal(a.attrs.k, "1 & 2");
  assert.equal(textOf(a.children[0]), "x < y & A");
  assert.equal(textOf(a.children[1]), "<raw>");
  assert.equal(a.children[2]!.name, "d");
  assert.equal(a.children[2]!.children.length, 0);
});

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <Style id="red"><LineStyle><color>ff0000ff</color><width>3</width></LineStyle><PolyStyle><color>7f00ff00</color></PolyStyle></Style>
  <StyleMap id="pair"><Pair><key>normal</key><styleUrl>#red</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#none</styleUrl></Pair></StyleMap>
  <Folder>
    <Placemark><name>Spot</name><description><![CDATA[<b>Nice</b>]]></description>
      <ExtendedData><Data name="rating"><value>5</value></Data></ExtendedData>
      <Point><coordinates>-122.3, 47.6, 10</coordinates></Point></Placemark>
    <Placemark><name>Road</name><styleUrl>#pair</styleUrl>
      <LineString><coordinates>-122.3,47.6 -122.2,47.7</coordinates></LineString></Placemark>
    <Placemark><name>Park</name>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 10,0 10,10 0,10 0,0</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>4,4 6,4 6,6 4,6 4,4</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
    <Placemark><name>Both</name><MultiGeometry><Point><coordinates>1,1</coordinates></Point><LineString><coordinates>1,1 2,2</coordinates></LineString></MultiGeometry></Placemark>
    <Placemark><name>Walk</name><gx:Track><when>2020-01-01T00:00:00Z</when><gx:coord>1 2 3</gx:coord><gx:coord>4 5 6</gx:coord></gx:Track></Placemark>
    <Placemark><name>Empty</name></Placemark>
  </Folder>
</Document>
</kml>`;

test("KML placemarks become features with their data and styles", () => {
  const fc = kmlToGeoJSON(KML);
  assert.equal(fc.features.length, 5);
  const [spot, road, park, both, walk] = fc.features;
  assert.deepEqual(spot!.geometry, { type: "Point", coordinates: [-122.3, 47.6, 10] });
  assert.equal(spot!.properties!.description, "<b>Nice</b>");
  assert.equal(spot!.properties!.rating, "5");
  assert.equal(road!.geometry!.type, "LineString");
  assert.equal(road!.properties!.stroke, "#ff0000");
  assert.equal(road!.properties!["stroke-width"], 3);
  assert.equal(road!.properties!.fill, "#00ff00");
  assert.ok(Math.abs((road!.properties!["fill-opacity"] as number) - 0.498) < 0.001);
  assert.equal(park!.geometry!.type, "Polygon");
  assert.equal((park!.geometry as { coordinates: unknown[] }).coordinates.length, 2);
  assert.equal(both!.geometry!.type, "GeometryCollection");
  assert.deepEqual(walk!.geometry, {
    type: "LineString",
    coordinates: [
      [1, 2, 3],
      [4, 5, 6],
    ],
  });
});

test("GPX waypoints, routes and tracks", () => {
  const fc = gpxToGeoJSON(`<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="47.6" lon="-122.3"><ele>12.5</ele><name>Start</name><sym>Flag</sym></wpt>
  <rte><name>Plan</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte>
  <trk><name>Ride</name>
    <trkseg><trkpt lat="1" lon="1"><time>2024-05-01T10:00:00Z</time></trkpt><trkpt lat="2" lon="2"><time>2024-05-01T10:05:00Z</time></trkpt></trkseg>
    <trkseg><trkpt lat="3" lon="3"/><trkpt lat="4" lon="4"/></trkseg>
  </trk>
</gpx>`);
  assert.equal(fc.features.length, 3);
  const [wpt, rte, trk] = fc.features;
  assert.deepEqual(wpt!.geometry, { type: "Point", coordinates: [-122.3, 47.6, 12.5] });
  assert.equal(wpt!.properties!.name, "Start");
  assert.equal(wpt!.properties!.ele, 12.5);
  assert.equal(rte!.geometry!.type, "LineString");
  assert.equal(trk!.geometry!.type, "MultiLineString");
  assert.equal(trk!.properties!.start, "2024-05-01T10:00:00Z");
  assert.equal(trk!.properties!.end, "2024-05-01T10:05:00Z");
});

test("CSV rows with quotes, other delimiters and coordinate columns", () => {
  assert.deepEqual(parseCsv('a,"b,c","say ""hi""",\n"multi\nline",2,3,4\n'), [
    ["a", "b,c", 'say "hi"', ""],
    ["multi\nline", "2", "3", "4"],
  ]);
  const fc = csvToGeoJSON("Name;Latitude;Longitude;Code;Count\nOffice;47.6;-122.3;007;12\nBad;x;y;1;2\n");
  assert.equal(fc.features.length, 1);
  const f = fc.features[0]!;
  assert.deepEqual(f.geometry, { type: "Point", coordinates: [-122.3, 47.6] });
  assert.equal(f.properties!.Code, "007");
  assert.equal(f.properties!.Count, 12);
  const wkt = csvToGeoJSON('id,wkt\n1,"LINESTRING (0 0, 1 1)"\n');
  assert.equal(wkt.features[0]!.geometry!.type, "LineString");
  assert.throws(() => csvToGeoJSON("a,b\n1,2\n"), /latitude and longitude/);
});

test("WKT in all its shapes", () => {
  assert.deepEqual(parseWkt("POINT (1 2)"), { type: "Point", coordinates: [1, 2] });
  assert.deepEqual(parseWkt("SRID=4326;POINT Z (1 2 3)"), { type: "Point", coordinates: [1, 2, 3] });
  assert.deepEqual(parseWkt("MULTIPOINT ((1 2), (3 4))"), {
    type: "MultiPoint",
    coordinates: [
      [1, 2],
      [3, 4],
    ],
  });
  assert.deepEqual(parseWkt("MULTIPOINT (1 2, 3 4)").type, "MultiPoint");
  const poly = parseWkt("POLYGON ((0 0, 4 0, 4 4, 0 0), (1 1, 2 1, 2 2, 1 1))");
  assert.equal(poly.type, "Polygon");
  assert.equal((poly as { coordinates: unknown[] }).coordinates.length, 2);
  assert.equal(parseWkt("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))").type, "MultiPolygon");
  assert.equal(parseWkt("GEOMETRYCOLLECTION (POINT (1 1), LINESTRING (0 0, 1 1))").type, "GeometryCollection");
  assert.equal(parseWkt("LINESTRING EMPTY").type, "MultiLineString");
  assert.throws(() => parseWkt("CIRCLE (1 2)"), /Unknown geometry type/);
  assert.throws(() => parseWkt("POINT (1 2) junk"), /Unexpected text/);
});

test("TopoJSON arcs are decoded, shared and reversed", () => {
  const topology = {
    type: "Topology" as const,
    transform: { scale: [0.5, 0.5] as [number, number], translate: [10, 20] as [number, number] },
    arcs: [
      [
        [0, 0],
        [2, 0],
        [0, 2],
      ],
      [
        [2, 2],
        [-2, 0],
        [0, -2],
      ],
    ],
    objects: {
      places: {
        type: "GeometryCollection",
        geometries: [
          { type: "Polygon", arcs: [[0, 1]], properties: { name: "square" } },
          { type: "LineString", arcs: [~0], properties: { name: "edge" } },
          { type: "Point", coordinates: [4, 4], id: 7 },
        ],
      },
    },
  };
  const fc = topologyToGeoJSON(topology);
  assert.equal(fc.features.length, 3);
  const square = fc.features[0]!.geometry as { coordinates: number[][][] };
  assert.deepEqual(square.coordinates[0], [
    [10, 20],
    [11, 20],
    [11, 21],
    [10, 21],
    [10, 20],
  ]);
  const edge = fc.features[1]!.geometry as { coordinates: number[][] };
  assert.deepEqual(edge.coordinates, [
    [11, 21],
    [11, 20],
    [10, 20],
  ]);
  assert.deepEqual(fc.features[2]!.geometry, { type: "Point", coordinates: [12, 22] });
  assert.equal(fc.features[2]!.id, 7);
  assert.equal((objectToGeoJSON(topology) as FeatureCollection).features.length, 3);
});

function zip(files: Record<string, Uint8Array>, deflate = true): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encode(name);
    const body = deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, deflate ? 8 : 0, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    chunks.push(local, body);
    central.push(dir);
    offset += local.length + body.length;
  }
  const dirSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

test("KMZ files are unzipped and read", async () => {
  for (const deflate of [true, false]) {
    const fc = (await bytesToGeoJSON(zip({ "doc.kml": encode(KML) }, deflate), "places.kmz")) as FeatureCollection;
    assert.equal(fc.features.length, 5);
  }
});

function shp(type: number, shapes: { parts: number[][][] }[]): Uint8Array {
  const records: Uint8Array[] = [];
  for (let r = 0; r < shapes.length; r++) {
    const parts = shapes[r]!.parts;
    const points = parts.flat();
    const content =
      type === 1 ? 20 : 44 + parts.length * 4 + points.length * 16;
    const rec = new Uint8Array(8 + content);
    const v = new DataView(rec.buffer);
    v.setInt32(0, r + 1, false);
    v.setInt32(4, content / 2, false);
    v.setInt32(8, type, true);
    if (type === 1) {
      v.setFloat64(12, points[0]![0]!, true);
      v.setFloat64(20, points[0]![1]!, true);
    } else {
      v.setInt32(44, parts.length, true);
      v.setInt32(48, points.length, true);
      let start = 0;
      parts.forEach((part, i) => {
        v.setInt32(52 + i * 4, start, true);
        start += part.length;
      });
      const at = 52 + parts.length * 4;
      points.forEach((p, i) => {
        v.setFloat64(at + i * 16, p[0]!, true);
        v.setFloat64(at + i * 16 + 8, p[1]!, true);
      });
    }
    records.push(rec);
  }
  const length = 100 + records.reduce((s, r) => s + r.length, 0);
  const out = new Uint8Array(length);
  const v = new DataView(out.buffer);
  v.setInt32(0, 9994, false);
  v.setInt32(24, length / 2, false);
  v.setInt32(28, 1000, true);
  v.setInt32(32, type, true);
  let p = 100;
  for (const r of records) {
    out.set(r, p);
    p += r.length;
  }
  return out;
}

function dbf(fields: { name: string; type: string; length: number }[], rows: string[][]): Uint8Array {
  const headerSize = 32 + fields.length * 32 + 1;
  const recordSize = 1 + fields.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(headerSize + rows.length * recordSize + 1);
  const v = new DataView(out.buffer);
  out[0] = 3;
  v.setUint32(4, rows.length, true);
  v.setUint16(8, headerSize, true);
  v.setUint16(10, recordSize, true);
  fields.forEach((f, i) => {
    out.set(encode(f.name), 32 + i * 32);
    out[32 + i * 32 + 11] = f.type.charCodeAt(0);
    out[32 + i * 32 + 16] = f.length;
  });
  out[headerSize - 1] = 0x0d;
  rows.forEach((row, r) => {
    const start = headerSize + r * recordSize;
    out[start] = 0x20;
    let o = start + 1;
    row.forEach((value, i) => {
      const bytes = encode(value.padEnd(fields[i]!.length, " ").slice(0, fields[i]!.length));
      out.set(bytes, o);
      o += fields[i]!.length;
    });
  });
  out[out.length - 1] = 0x1a;
  return out;
}

test("shapefile points keep their attributes", () => {
  const fc = shapefileToGeoJSON({
    shp: shp(1, [{ parts: [[[-122.3, 47.6]]] }, { parts: [[[2, 3]]] }]),
    dbf: dbf(
      [
        { name: "NAME", type: "C", length: 10 },
        { name: "POP", type: "N", length: 8 },
        { name: "OPEN", type: "L", length: 1 },
        { name: "SINCE", type: "D", length: 8 },
      ],
      [
        ["Seattle", "750000", "T", "18690102"],
        ["Elsewhere", "", "F", "20000101"],
      ],
    ),
  });
  assert.equal(fc.features.length, 2);
  assert.deepEqual(fc.features[0]!.geometry, { type: "Point", coordinates: [-122.3, 47.6] });
  assert.deepEqual(fc.features[0]!.properties, { NAME: "Seattle", POP: 750000, OPEN: true, SINCE: "1869-01-02" });
  assert.equal(fc.features[1]!.properties!.POP, null);
});

test("shapefile polygons group holes with the ring around them", () => {
  const outerA = [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
    [0, 0],
  ];
  const hole = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ];
  const outerB = [
    [20, 0],
    [20, 5],
    [25, 5],
    [25, 0],
    [20, 0],
  ];
  const fc = shapefileToGeoJSON({ shp: shp(5, [{ parts: [outerA, hole, outerB] }]) });
  const g = fc.features[0]!.geometry as { type: string; coordinates: number[][][][] };
  assert.equal(g.type, "MultiPolygon");
  assert.equal(g.coordinates.length, 2);
  assert.equal(g.coordinates[0]!.length, 2);
  assert.equal(g.coordinates[1]!.length, 1);
});

const UTM10 =
  'PROJCS["WGS_1984_UTM_Zone_10N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-123.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

function utmForward(lon: number, lat: number): [number, number] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const phi = (lat * Math.PI) / 180;
  const lam = ((lon + 123) * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const aa = lam * Math.cos(phi);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const m =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi));
  const x =
    k0 * n * (aa + ((1 - t + c) * aa ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * aa ** 5) / 120) + 500000;
  const y =
    k0 *
    (m +
      n *
        Math.tan(phi) *
        ((aa * aa) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * aa ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * aa ** 6) / 720));
  return [x, y];
}

test("projected shapefiles are converted to longitude and latitude", () => {
  const places: [number, number][] = [
    [-123, 0],
    [-123, 45],
    [-122.3493, 47.6205],
    [-121.2, 46.1],
    [-125.5, 49.8],
  ];
  const shapes = places.map(([lon, lat]) => ({ parts: [[utmForward(lon, lat)]] }));
  const fc = shapefileToGeoJSON({ shp: shp(1, shapes), prj: UTM10 });
  fc.features.forEach((f, i) => {
    const [lon, lat] = (f.geometry as { coordinates: number[] }).coordinates;
    close(lon!, places[i]![0], 1e-6, "longitude");
    close(lat!, places[i]![1], 1e-6, "latitude");
  });
  assert.throws(() => shapefileToGeoJSON({ shp: shp(1, [{ parts: [[[548000, 5274000]]] }]) }), /projection/);
});

test("zipped shapefiles are found inside the archive", async () => {
  const archive = zip({
    "data/roads.shp": shp(3, [
      {
        parts: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
    ]),
    "data/roads.dbf": dbf([{ name: "KIND", type: "C", length: 8 }], [["main"]]),
    "data/roads.cpg": encode("UTF-8"),
  });
  const fc = (await bytesToGeoJSON(archive, "roads.zip")) as FeatureCollection;
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0]!.properties!.KIND, "main");
  assert.equal(fc.features[0]!.geometry!.type, "LineString");
});

class FlatBuffer {
  bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }

  u32(v: number): void {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }

  f64(v: number): void {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    for (const x of b) this.u8(x);
  }

  setU32(at: number, v: number): void {
    this.bytes[at] = v & 0xff;
    this.bytes[at + 1] = (v >> 8) & 0xff;
    this.bytes[at + 2] = (v >> 16) & 0xff;
    this.bytes[at + 3] = (v >>> 24) & 0xff;
  }

  table(fields: (["u8" | "u16" | "u32" | "u64", number] | ["ref"] | null)[]): { at: number; refs: Map<number, number> } {
    const sizes = fields.map((f) => (f === null ? 0 : f[0] === "u8" ? 1 : f[0] === "u16" ? 2 : f[0] === "u64" ? 8 : 4));
    const vtableSize = 4 + fields.length * 2;
    const tableSize = 4 + sizes.reduce((s, x) => s + x, 0);
    const vt = this.length;
    this.u16(vtableSize);
    this.u16(tableSize);
    let offset = 4;
    for (const size of sizes) {
      this.u16(size === 0 ? 0 : offset);
      offset += size;
    }
    const at = this.length;
    this.u32(at - vt);
    const refs = new Map<number, number>();
    fields.forEach((f, i) => {
      if (f === null) return;
      if (f[0] === "ref") {
        refs.set(i, this.length);
        this.u32(0);
      } else if (f[0] === "u8") this.u8(f[1]);
      else if (f[0] === "u16") this.u16(f[1]);
      else if (f[0] === "u64") {
        this.u32(f[1]);
        this.u32(0);
      } else this.u32(f[1]);
    });
    return { at, refs };
  }

  point(ref: number, target: number): void {
    this.setU32(ref, target - ref);
  }

  string(s: string): number {
    const at = this.length;
    const b = encode(s);
    this.u32(b.length);
    for (const x of b) this.u8(x);
    this.u8(0);
    return at;
  }

  doubles(values: number[]): number {
    const at = this.length;
    this.u32(values.length);
    for (const v of values) this.f64(v);
    return at;
  }

  uints(values: number[]): number {
    const at = this.length;
    this.u32(values.length);
    for (const v of values) this.u32(v);
    return at;
  }

  ubytes(values: number[]): number {
    const at = this.length;
    this.u32(values.length);
    for (const v of values) this.u8(v);
    return at;
  }

  vectorOfRefs(count: number): { at: number; slots: number[] } {
    const at = this.length;
    this.u32(count);
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      slots.push(this.length);
      this.u32(0);
    }
    return { at, slots };
  }
}

function fgbHeader(columns: [string, number][], geometryType: number, count: number, epsg: number | null): Uint8Array {
  const b = new FlatBuffer();
  b.u32(0);
  const header = b.table([
    null,
    null,
    ["u8", geometryType],
    null,
    null,
    null,
    null,
    ["ref"],
    ["u64", count],
    ["u16", 0],
    epsg === null ? null : ["ref"],
  ]);
  b.setU32(0, header.at);
  const cols = b.vectorOfRefs(columns.length);
  b.point(header.refs.get(7)!, cols.at);
  columns.forEach(([name, type], i) => {
    const col = b.table([["ref"], ["u8", type]]);
    b.point(cols.slots[i]!, col.at);
    b.point(col.refs.get(0)!, b.string(name));
  });
  if (epsg !== null) {
    const crs = b.table([null, ["u32", epsg]]);
    b.point(header.refs.get(10)!, crs.at);
  }
  return Uint8Array.from(b.bytes);
}

function fgbFeature(type: number, xy: number[], ends: number[] | null, props: number[]): Uint8Array {
  const b = new FlatBuffer();
  b.u32(0);
  const feature = b.table([["ref"], props.length > 0 ? ["ref"] : null]);
  b.setU32(0, feature.at);
  const geometry = b.table([ends ? ["ref"] : null, ["ref"], null, null, null, null, ["u8", type]]);
  b.point(feature.refs.get(0)!, geometry.at);
  if (ends) b.point(geometry.refs.get(0)!, b.uints(ends));
  b.point(geometry.refs.get(1)!, b.doubles(xy));
  if (props.length > 0) b.point(feature.refs.get(1)!, b.ubytes(props));
  return Uint8Array.from(b.bytes);
}

function fgbFile(header: Uint8Array, features: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00)];
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, header.length, true);
  parts.push(size, header);
  for (const f of features) {
    const s = new Uint8Array(4);
    new DataView(s.buffer).setUint32(0, f.length, true);
    parts.push(s, f);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function props(entries: [number, "string" | "int" | "double" | "bool", string | number | boolean][]): number[] {
  const out: number[] = [];
  for (const [column, kind, value] of entries) {
    out.push(column & 0xff, column >> 8);
    if (kind === "string") {
      const b = encode(String(value));
      out.push(b.length & 0xff, (b.length >> 8) & 0xff, 0, 0, ...b);
    } else if (kind === "int") {
      const v = new Uint8Array(new Int32Array([Number(value)]).buffer);
      out.push(...v);
    } else if (kind === "double") {
      out.push(...new Uint8Array(new Float64Array([Number(value)]).buffer));
    } else {
      out.push(value ? 1 : 0);
    }
  }
  return out;
}

test("FlatGeobuf features, properties and polygons with holes", async () => {
  const header = fgbHeader(
    [
      ["name", 11],
      ["floors", 5],
      ["height", 10],
      ["open", 2],
    ],
    0,
    2,
    null,
  );
  const point = fgbFeature(
    1,
    [-122.3, 47.6],
    null,
    props([
      [0, "string", "Tower"],
      [1, "int", 40],
      [2, "double", 123.5],
      [3, "bool", true],
    ]),
  );
  const polygon = fgbFeature(3, [0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 4, 4, 6, 4, 6, 6, 4, 4], [5, 9], []);
  const fc = (await bytesToGeoJSON(fgbFile(header, [point, polygon]), "")) as FeatureCollection;
  assert.equal(fc.features.length, 2);
  assert.deepEqual(fc.features[0]!.geometry, { type: "Point", coordinates: [-122.3, 47.6] });
  assert.deepEqual(fc.features[0]!.properties, { name: "Tower", floors: 40, height: 123.5, open: true });
  const g = fc.features[1]!.geometry as { type: string; coordinates: number[][][] };
  assert.equal(g.type, "Polygon");
  assert.equal(g.coordinates.length, 2);
  assert.equal(g.coordinates[1]!.length, 4);
});

test("FlatGeobuf in Web Mercator comes out in longitude and latitude", async () => {
  const header = fgbHeader([], 1, 1, 3857);
  const point = fgbFeature(1, [20037508.342789244, 0], null, []);
  const fc = (await bytesToGeoJSON(fgbFile(header, [point]), "")) as FeatureCollection;
  const [lon, lat] = (fc.features[0]!.geometry as { coordinates: number[] }).coordinates;
  close(lon!, 180, 1e-9, "longitude");
  close(lat!, 0, 1e-9, "latitude");
});

test("formats are recognized from their content", async () => {
  const csv = (await bytesToGeoJSON(encode("lat,lon\n1,2\n"), "data")) as FeatureCollection;
  assert.equal(csv.features.length, 1);
  const kml = (await bytesToGeoJSON(encode(KML), "")) as FeatureCollection;
  assert.equal(kml.features.length, 5);
  const gpx = (await bytesToGeoJSON(encode('<gpx><wpt lat="1" lon="2"/></gpx>'), "")) as FeatureCollection;
  assert.equal(gpx.features.length, 1);
  const wkt = (await bytesToGeoJSON(encode("POINT (1 2)\nPOINT (3 4)\n"), "")) as FeatureCollection;
  assert.equal(wkt.features.length, 2);
  const json = (await bytesToGeoJSON(encode('{"type":"Point","coordinates":[1,2]}'), "")) as { type: string };
  assert.equal(json.type, "Point");
  await assert.rejects(bytesToGeoJSON(encode("{ broken"), "x.json"), /not valid JSON/);
  await assert.rejects(bytesToGeoJSON(zip({ "readme.txt": encode("hi") }), "empty.zip"), /no map data/);
});
