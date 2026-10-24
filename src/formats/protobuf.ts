export const VARINT = 0;
export const FIXED64 = 1;
export const BYTES = 2;
export const FIXED32 = 5;

const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtobufError";
  }
}

export class Reader {
  readonly buf: Uint8Array;
  pos: number;
  readonly end: number;
  private view: DataView | null = null;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  tag(): number {
    return this.varint();
  }

  hi = 0;
  lo = 0;

  varint(): number {
    const buf = this.buf;
    let pos = this.pos;
    let b = buf[pos++]!;
    if (b < 0x80) {
      this.pos = pos;
      this.hi = 0;
      this.lo = b;
      return b;
    }
    let value = b & 0x7f;
    b = buf[pos++]!;
    value |= (b & 0x7f) << 7;
    if (b < 0x80) {
      this.pos = pos;
      this.hi = 0;
      this.lo = value;
      return value;
    }
    b = buf[pos++]!;
    value |= (b & 0x7f) << 14;
    if (b < 0x80) {
      this.pos = pos;
      this.hi = 0;
      this.lo = value;
      return value;
    }
    b = buf[pos++]!;
    value |= (b & 0x7f) << 21;
    if (b < 0x80) {
      this.pos = pos;
      this.hi = 0;
      this.lo = value;
      return value;
    }
    if (pos >= this.end) throw new ProtobufError("Truncated varint");
    b = buf[pos++]!;
    const low = (value | ((b & 0x0f) << 28)) >>> 0;
    let high = (b & 0x7f) >> 4;
    if (b >= 0x80) {
      let shift = 3;
      for (;;) {
        if (pos >= this.end) throw new ProtobufError("Truncated varint");
        b = buf[pos++]!;
        if (shift === 31) {
          high |= (b & 0x01) << 31;
          if (b >= 0x80) throw new ProtobufError("Varint is longer than 10 bytes");
          break;
        }
        high |= (b & 0x7f) << shift;
        shift += 7;
        if (b < 0x80) break;
      }
    }
    this.pos = pos;
    this.hi = high >>> 0;
    this.lo = low;
    return this.hi * 0x100000000 + low;
  }

  int64(): number {
    const v = this.varint();
    if (this.hi < 0x80000000) return v;
    return -((0xffffffff - this.hi) * 0x100000000 + (0x100000000 - this.lo));
  }

  int32(): number {
    this.varint();
    return this.lo | 0;
  }

  svarint(): number {
    const v = this.varint();
    return this.lo & 1 ? -(v + 1) / 2 : v / 2;
  }

  bool(): boolean {
    return this.varint() !== 0;
  }

  fixed32(): number {
    const v = this.dataView().getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  sfixed32(): number {
    const v = this.dataView().getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  fixed64(): number {
    const view = this.dataView();
    const v = view.getUint32(this.pos, true) + view.getUint32(this.pos + 4, true) * 0x100000000;
    this.pos += 8;
    return v;
  }

  float(): number {
    const v = this.dataView().getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    const v = this.dataView().getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const start = this.pos;
    const end = start + len;
    if (end > this.end) throw new ProtobufError("Length-delimited field runs past the end of the message");
    this.pos = end;
    return this.buf.subarray(start, end);
  }

  string(): string {
    const b = this.bytes();
    return decodeUtf8(b);
  }

  sub(): Reader {
    const len = this.varint();
    const start = this.pos;
    const end = start + len;
    if (end > this.end) throw new ProtobufError("Embedded message runs past the end of its parent");
    this.pos = end;
    return new Reader(this.buf, start, end);
  }

  packedEnd(): number {
    const len = this.varint();
    const end = this.pos + len;
    if (end > this.end) throw new ProtobufError("Packed field runs past the end of the message");
    return end;
  }

  skip(wire: number): void {
    switch (wire) {
      case VARINT:
        while (this.buf[this.pos++]! > 0x7f) {
          if (this.pos > this.end) throw new ProtobufError("Truncated varint");
        }
        break;
      case FIXED64:
        this.pos += 8;
        break;
      case BYTES:
        this.pos += this.varint();
        break;
      case FIXED32:
        this.pos += 4;
        break;
      default:
        throw new ProtobufError(`Unsupported wire type ${wire}`);
    }
    if (this.pos > this.end) throw new ProtobufError("Field runs past the end of the message");
  }

  private dataView(): DataView {
    if (!this.view) this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    return this.view;
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length < 24) {
    let ascii = true;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i]! > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (ascii) return String.fromCharCode(...bytes);
  }
  if (!decoder) throw new ProtobufError("TextDecoder is not available");
  return decoder.decode(bytes);
}

export class Writer {
  private buf: Uint8Array;
  pos = 0;
  private view: DataView;

  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  reset(): void {
    this.pos = 0;
  }

  tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  varint(value: number): void {
    this.ensure(10);
    let v = value;
    if (v < 0) throw new ProtobufError("Negative value written as an unsigned varint");
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
  }

  svarint(value: number): void {
    this.varint(value < 0 ? -value * 2 - 1 : value * 2);
  }

  double(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, value, true);
    this.pos += 8;
  }

  float(value: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, value, true);
    this.pos += 4;
  }

  bytes(data: Uint8Array): void {
    this.varint(data.length);
    this.ensure(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
  }

  string(value: string): void {
    this.bytes(encoder.encode(value));
  }

  message(field: number, write: (w: Writer) => void): void {
    this.tag(field, BYTES);
    const lengthPos = this.pos;
    this.ensure(5);
    this.pos += 5;
    const start = this.pos;
    write(this);
    const len = this.pos - start;
    let lenBytes = 1;
    for (let v = len; v >= 0x80; v = Math.floor(v / 0x80)) lenBytes++;
    if (lenBytes !== 5) {
      this.buf.copyWithin(lengthPos + lenBytes, start, this.pos);
      this.pos -= 5 - lenBytes;
    }
    let p = lengthPos;
    let v = len;
    while (v >= 0x80) {
      this.buf[p++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[p] = v;
  }

  packedVarint(field: number, values: ArrayLike<number>): void {
    if (values.length === 0) return;
    this.message(field, (w) => {
      for (let i = 0; i < values.length; i++) w.varint(values[i]!);
    });
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
}

const encoder = new TextEncoder();
