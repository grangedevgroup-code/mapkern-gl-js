export interface ByteRanges {
  read(offset: number, length: number, signal: AbortSignal): Promise<{ data: Uint8Array }>;
}

export type SqlValue = number | string | Uint8Array | null;

export interface SchemaRow {
  type: string;
  name: string;
  table: string;
  root: number;
  sql: string;
}

export class SqliteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteError";
  }
}

const MAGIC = "SQLite format 3\u0000";
const CACHE_PAGES = 512;

export class SqliteReader {
  private readonly ranges: ByteRanges;
  private pageSize = 0;
  private usable = 0;
  private text: TextDecoder = new TextDecoder();
  private opened: Promise<void> | null = null;
  private readonly cache = new Map<number, Promise<Uint8Array>>();

  constructor(ranges: ByteRanges) {
    this.ranges = ranges;
  }

  open(signal: AbortSignal): Promise<void> {
    if (!this.opened) {
      this.opened = (async () => {
        const { data } = await this.ranges.read(0, 100, signal);
        if (data.length < 100 || new TextDecoder().decode(data.subarray(0, 16)) !== MAGIC) {
          throw new SqliteError("The file is not an SQLite database");
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const size = view.getUint16(16, false);
        this.pageSize = size === 1 ? 65536 : size;
        this.usable = this.pageSize - data[20]!;
        const encoding = view.getUint32(56, false);
        this.text = new TextDecoder(encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8");
      })();
      this.opened.catch(() => {
        this.opened = null;
      });
    }
    return this.opened;
  }

  async schema(signal: AbortSignal): Promise<SchemaRow[]> {
    const rows: SchemaRow[] = [];
    await this.scan(1, signal, (_rowid, values) => {
      rows.push({
        type: String(values[0] ?? ""),
        name: String(values[1] ?? ""),
        table: String(values[2] ?? ""),
        root: Number(values[3] ?? 0),
        sql: typeof values[4] === "string" ? values[4] : "",
      });
    });
    return rows;
  }

  async scan(root: number, signal: AbortSignal, visit: (rowid: number, values: SqlValue[]) => void): Promise<void> {
    await this.open(signal);
    const walk = async (pageNumber: number): Promise<void> => {
      const page = await this.page(pageNumber, signal);
      const h = pageNumber === 1 ? 100 : 0;
      const type = page[h]!;
      const cells = cellOffsets(page, h);
      if (type === 0x05) {
        for (const c of cells) await walk(u32(page, c));
        await walk(u32(page, h + 8));
      } else if (type === 0x0d) {
        for (const c of cells) {
          const { rowid, values } = await this.tableLeafCell(page, c, signal);
          visit(rowid, values);
        }
      } else {
        throw new SqliteError(`Page ${pageNumber} is not a table page`);
      }
    };
    await walk(root);
  }

  async row(root: number, rowid: number, signal: AbortSignal): Promise<SqlValue[] | null> {
    await this.open(signal);
    let pageNumber = root;
    for (let depth = 0; depth < 64; depth++) {
      const page = await this.page(pageNumber, signal);
      const h = pageNumber === 1 ? 100 : 0;
      const type = page[h]!;
      const cells = cellOffsets(page, h);
      if (type === 0x05) {
        let next = u32(page, h + 8);
        for (const c of cells) {
          const [key] = varint(page, c + 4);
          if (rowid <= key) {
            next = u32(page, c);
            break;
          }
        }
        pageNumber = next;
      } else if (type === 0x0d) {
        for (const c of cells) {
          const [, afterSize] = varint(page, c);
          const [key] = varint(page, afterSize);
          if (key === rowid) return (await this.tableLeafCell(page, c, signal)).values;
        }
        return null;
      } else {
        throw new SqliteError(`Page ${pageNumber} is not a table page`);
      }
    }
    throw new SqliteError("The table is nested too deeply");
  }

  async lookup(root: number, key: SqlValue[], signal: AbortSignal): Promise<SqlValue[] | null> {
    await this.open(signal);
    let pageNumber = root;
    for (let depth = 0; depth < 64; depth++) {
      const page = await this.page(pageNumber, signal);
      const h = pageNumber === 1 ? 100 : 0;
      const type = page[h]!;
      const cells = cellOffsets(page, h);
      if (type === 0x02) {
        let next = u32(page, h + 8);
        for (const c of cells) {
          const values = await this.indexCell(page, c + 4, signal);
          const order = compareKey(values, key);
          if (order === 0) return values;
          if (order > 0) {
            next = u32(page, c);
            break;
          }
        }
        pageNumber = next;
      } else if (type === 0x0a) {
        for (const c of cells) {
          const values = await this.indexCell(page, c, signal);
          if (compareKey(values, key) === 0) return values;
        }
        return null;
      } else {
        throw new SqliteError(`Page ${pageNumber} is not an index page`);
      }
    }
    throw new SqliteError("The index is nested too deeply");
  }

  private async tableLeafCell(
    page: Uint8Array,
    cell: number,
    signal: AbortSignal,
  ): Promise<{ rowid: number; values: SqlValue[] }> {
    const [size, afterSize] = varint(page, cell);
    const [rowid, start] = varint(page, afterSize);
    const payload = await this.payload(page, start, size, this.usable - 35, signal);
    return { rowid, values: this.record(payload) };
  }

  private async indexCell(page: Uint8Array, cell: number, signal: AbortSignal): Promise<SqlValue[]> {
    const [size, start] = varint(page, cell);
    const limit = Math.floor(((this.usable - 12) * 64) / 255) - 23;
    return this.record(await this.payload(page, start, size, limit, signal));
  }

  private async payload(
    page: Uint8Array,
    start: number,
    size: number,
    maxLocal: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (size <= maxLocal) return page.subarray(start, start + size);
    const minLocal = Math.floor(((this.usable - 12) * 32) / 255) - 23;
    const k = minLocal + ((size - minLocal) % (this.usable - 4));
    const local = k <= maxLocal ? k : minLocal;
    const out = new Uint8Array(size);
    out.set(page.subarray(start, start + local));
    let filled = local;
    let next = u32(page, start + local);
    const chunk = this.usable - 4;
    while (filled < size) {
      if (next === 0) throw new SqliteError("A record runs past the end of its overflow pages");
      const run = await this.pages(next, Math.ceil((size - filled) / chunk), signal);
      let current = next;
      for (const p of run) {
        const take = Math.min(chunk, size - filled);
        out.set(p.subarray(4, 4 + take), filled);
        filled += take;
        next = u32(p, 0);
        if (filled >= size || next !== current + 1) break;
        current = next;
      }
    }
    return out;
  }

  private record(payload: Uint8Array): SqlValue[] {
    const [headerSize, first] = varint(payload, 0);
    const types: number[] = [];
    let p = first;
    while (p < headerSize) {
      const [t, next] = varint(payload, p);
      types.push(t);
      p = next;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const values: SqlValue[] = [];
    let o = headerSize;
    for (const t of types) {
      switch (t) {
        case 0:
          values.push(null);
          break;
        case 1:
          values.push(view.getInt8(o));
          o += 1;
          break;
        case 2:
          values.push(view.getInt16(o, false));
          o += 2;
          break;
        case 3:
          values.push((view.getInt8(o) << 16) | (view.getUint8(o + 1) << 8) | view.getUint8(o + 2));
          o += 3;
          break;
        case 4:
          values.push(view.getInt32(o, false));
          o += 4;
          break;
        case 5:
          values.push(view.getInt16(o, false) * 2 ** 32 + view.getUint32(o + 2, false));
          o += 6;
          break;
        case 6:
          values.push(Number(view.getBigInt64(o, false)));
          o += 8;
          break;
        case 7:
          values.push(view.getFloat64(o, false));
          o += 8;
          break;
        case 8:
          values.push(0);
          break;
        case 9:
          values.push(1);
          break;
        default:
          if (t >= 12) {
            const n = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
            const bytes = payload.subarray(o, o + n);
            values.push(t % 2 === 0 ? bytes : this.text.decode(bytes));
            o += n;
          } else {
            values.push(null);
          }
      }
    }
    return values;
  }

  private page(n: number, signal: AbortSignal): Promise<Uint8Array> {
    const hit = this.cache.get(n);
    if (hit) {
      this.cache.delete(n);
      this.cache.set(n, hit);
      return hit;
    }
    const promise = this.ranges
      .read((n - 1) * this.pageSize, this.pageSize, signal)
      .then(({ data }) => {
        if (data.length < this.pageSize) throw new SqliteError(`Page ${n} is past the end of the file`);
        return data;
      });
    promise.catch(() => this.cache.delete(n));
    this.remember(n, promise);
    return promise;
  }

  private async pages(first: number, count: number, signal: AbortSignal): Promise<Uint8Array[]> {
    if (count <= 1 || this.cache.has(first)) return [await this.page(first, signal)];
    const { data } = await this.ranges.read((first - 1) * this.pageSize, count * this.pageSize, signal);
    const out: Uint8Array[] = [];
    for (let i = 0; i + this.pageSize <= data.length; i += this.pageSize) out.push(data.subarray(i, i + this.pageSize));
    if (out.length === 0) throw new SqliteError(`Page ${first} is past the end of the file`);
    return out;
  }

  private remember(n: number, promise: Promise<Uint8Array>): void {
    this.cache.set(n, promise);
    if (this.cache.size > CACHE_PAGES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

function cellOffsets(page: Uint8Array, h: number): number[] {
  const count = (page[h + 3]! << 8) | page[h + 4]!;
  const type = page[h]!;
  const start = h + (type === 0x02 || type === 0x05 ? 12 : 8);
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = (page[start + i * 2]! << 8) | page[start + i * 2 + 1]!;
  return out;
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
}

function varint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = bytes[at + i]!;
    value = value * 128 + (b & 0x7f);
    if (b < 0x80) return [value, at + i + 1];
  }
  return [value * 256 + bytes[at + 8]!, at + 9];
}

export function compareKey(record: SqlValue[], key: SqlValue[]): number {
  for (let i = 0; i < key.length; i++) {
    const a = record[i] ?? null;
    const b = key[i] ?? null;
    const order = compareValue(a, b);
    if (order !== 0) return order;
  }
  return 0;
}

function rank(v: SqlValue): number {
  if (v === null) return 0;
  if (typeof v === "number") return 1;
  if (typeof v === "string") return 2;
  return 3;
}

function compareValue(a: SqlValue, b: SqlValue): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  }
  return 0;
}
