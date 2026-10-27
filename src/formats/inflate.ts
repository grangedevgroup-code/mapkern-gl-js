export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflateError";
  }
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Table {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function table(lengths: ArrayLike<number>, n: number): Table {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1]! + counts[i - 1]!;
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
  return { counts, symbols };
}

const FIXED_LITERALS = (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return table(lengths, 288);
})();
const FIXED_DISTANCES = table(new Uint8Array(30).fill(5), 30);

class Bits {
  private pos = 0;
  private bit = 0;
  private bits = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array, start: number) {
    this.data = data;
    this.pos = start;
  }

  get offset(): number {
    return this.pos;
  }

  need(n: number): number {
    while (this.bit < n) {
      if (this.pos >= this.data.length) throw new InflateError("compressed data ends early");
      this.bits |= this.data[this.pos++]! << this.bit;
      this.bit += 8;
    }
    const v = this.bits & ((1 << n) - 1);
    this.bits >>>= n;
    this.bit -= n;
    return v;
  }

  align(): void {
    this.bits = 0;
    this.bit = 0;
  }

  seek(pos: number): void {
    this.pos = pos;
    this.align();
  }

  decode(t: Table): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.need(1);
      const count = t.counts[len]!;
      if (code - count < first) return t.symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError("bad Huffman code");
  }
}

export function inflateSync(data: Uint8Array, zlib = true): Uint8Array {
  let start = 0;
  if (zlib) {
    if (data.length < 2 || (data[0]! & 15) !== 8 || ((data[0]! << 8) | data[1]!) % 31 !== 0)
      throw new InflateError("not zlib data");
    if (data[1]! & 32) throw new InflateError("zlib preset dictionaries are not supported");
    start = 2;
  }
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let size = 0;
  const room = (n: number) => {
    if (size + n <= out.length) return;
    let next = out.length * 2;
    while (next < size + n) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(out.subarray(0, size));
    out = grown;
  };
  const bits = new Bits(data, start);
  let last = 0;
  while (!last) {
    last = bits.need(1);
    const type = bits.need(2);
    if (type === 0) {
      bits.align();
      let at = bits.offset;
      if (at + 4 > data.length) throw new InflateError("compressed data ends early");
      const len = data[at]! | (data[at + 1]! << 8);
      at += 4;
      if (at + len > data.length) throw new InflateError("compressed data ends early");
      room(len);
      out.set(data.subarray(at, at + len), size);
      size += len;
      bits.seek(at + len);
      continue;
    }
    let literals: Table;
    let distances: Table;
    if (type === 1) {
      literals = FIXED_LITERALS;
      distances = FIXED_DISTANCES;
    } else if (type === 2) {
      const hlit = bits.need(5) + 257;
      const hdist = bits.need(5) + 1;
      const hclen = bits.need(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) codeLengths[CODE_ORDER[i]!] = bits.need(3);
      const codes = table(codeLengths, 19);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist; ) {
        const sym = bits.decode(codes);
        if (sym < 16) lengths[i++] = sym;
        else {
          let repeat = 0;
          let value = 0;
          if (sym === 16) {
            if (i === 0) throw new InflateError("bad code lengths");
            value = lengths[i - 1]!;
            repeat = 3 + bits.need(2);
          } else if (sym === 17) repeat = 3 + bits.need(3);
          else repeat = 11 + bits.need(7);
          if (i + repeat > hlit + hdist) throw new InflateError("bad code lengths");
          lengths.fill(value, i, i + repeat);
          i += repeat;
        }
      }
      literals = table(lengths.subarray(0, hlit), hlit);
      distances = table(lengths.subarray(hlit), hdist);
    } else throw new InflateError("bad block type");
    for (;;) {
      const sym = bits.decode(literals);
      if (sym < 256) {
        room(1);
        out[size++] = sym;
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new InflateError("bad length code");
        const len = LENGTH_BASE[li]! + bits.need(LENGTH_EXTRA[li]!);
        const di = bits.decode(distances);
        if (di >= 30) throw new InflateError("bad distance code");
        const dist = DIST_BASE[di]! + bits.need(DIST_EXTRA[di]!);
        if (dist > size) throw new InflateError("distance too far back");
        room(len);
        for (let k = 0; k < len; k++, size++) out[size] = out[size - dist]!;
      }
    }
  }
  return out.slice(0, size);
}
