import type { Geometry, Position } from "../geo/geojson.ts";

export class WktError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WktError";
  }
}

export function parseWkt(text: string): Geometry {
  const reader = new Reader(text.replace(/^\s*SRID=\d+;/i, ""));
  const geometry = reader.geometry();
  reader.space();
  if (!reader.done) throw new WktError(`Unexpected text after the geometry at ${reader.position}`);
  return geometry;
}

class Reader {
  private readonly text: string;
  private i = 0;

  constructor(text: string) {
    this.text = text;
  }

  get done(): boolean {
    return this.i >= this.text.length;
  }

  get position(): number {
    return this.i;
  }

  geometry(): Geometry {
    const type = this.word().toUpperCase();
    this.space();
    const dims = this.dimensions();
    if (this.keyword("EMPTY")) return empty(type);
    switch (type) {
      case "POINT":
        return { type: "Point", coordinates: this.wrapped(() => this.position2(dims)) };
      case "LINESTRING":
        return { type: "LineString", coordinates: this.positions(dims) };
      case "POLYGON":
        return { type: "Polygon", coordinates: this.list(() => this.positions(dims)) };
      case "MULTIPOINT":
        return {
          type: "MultiPoint",
          coordinates: this.list(() => (this.peek() === "(" ? this.wrapped(() => this.position2(dims)) : this.position2(dims))),
        };
      case "MULTILINESTRING":
        return { type: "MultiLineString", coordinates: this.list(() => this.positions(dims)) };
      case "MULTIPOLYGON":
        return { type: "MultiPolygon", coordinates: this.list(() => this.list(() => this.positions(dims))) };
      case "GEOMETRYCOLLECTION":
        return { type: "GeometryCollection", geometries: this.list(() => this.geometry()) };
      default:
        throw new WktError(`Unknown geometry type "${type}"`);
    }
  }

  private dimensions(): number {
    const save = this.i;
    const word = this.word().toUpperCase();
    if (word === "Z" || word === "M") return 3;
    if (word === "ZM") return 4;
    this.i = save;
    return 2;
  }

  private keyword(name: string): boolean {
    this.space();
    if (this.text.slice(this.i, this.i + name.length).toUpperCase() === name) {
      this.i += name.length;
      return true;
    }
    return false;
  }

  private word(): string {
    this.space();
    const start = this.i;
    while (this.i < this.text.length && /[A-Za-z]/.test(this.text[this.i]!)) this.i++;
    return this.text.slice(start, this.i);
  }

  space(): void {
    while (this.i < this.text.length && /\s/.test(this.text[this.i]!)) this.i++;
  }

  private peek(): string {
    this.space();
    return this.text[this.i] ?? "";
  }

  private expect(char: string): void {
    if (this.peek() !== char) throw new WktError(`Expected "${char}" at ${this.i}`);
    this.i++;
  }

  private wrapped<T>(read: () => T): T {
    this.expect("(");
    const value = read();
    this.expect(")");
    return value;
  }

  private list<T>(read: () => T): T[] {
    return this.wrapped(() => {
      const out = [read()];
      while (this.peek() === ",") {
        this.i++;
        out.push(read());
      }
      return out;
    });
  }

  private positions(dims: number): Position[] {
    return this.list(() => this.position2(dims));
  }

  private position2(dims: number): Position {
    const values: number[] = [];
    for (;;) {
      this.space();
      const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(this.text.slice(this.i, this.i + 40));
      if (!m) break;
      values.push(Number(m[0]));
      this.i += m[0].length;
    }
    if (values.length < 2) throw new WktError(`Expected a coordinate at ${this.i}`);
    return dims >= 3 && values.length >= 3 ? values.slice(0, 3) : values.slice(0, 2);
  }
}

function empty(type: string): Geometry {
  switch (type) {
    case "POINT":
    case "MULTIPOINT":
      return { type: "MultiPoint", coordinates: [] };
    case "LINESTRING":
    case "MULTILINESTRING":
      return { type: "MultiLineString", coordinates: [] };
    case "POLYGON":
    case "MULTIPOLYGON":
      return { type: "MultiPolygon", coordinates: [] };
    default:
      return { type: "GeometryCollection", geometries: [] };
  }
}
