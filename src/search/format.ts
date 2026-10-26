export const SEARCH_KINDS = ["place", "address", "street", "poi"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const NONE = 0xffffffff;

const MAGIC = 0x58534b4d;
const VERSION = 1;

export interface SearchData {
  bbox: [number, number, number, number];
  strings: string[];
  categories: string[];
  kind: Uint8Array;
  rank: Uint8Array;
  category: Uint16Array;
  name: Uint32Array;
  context: Uint32Array;
  number: Uint32Array;
  street: Uint32Array;
  lon: Int32Array;
  lat: Int32Array;
  shapes: Uint32Array;
  parts: Uint32Array;
  coords: Int32Array;
  terms: Uint32Array;
  termStart: Uint32Array;
  postings: Uint32Array;
}

export class SearchIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchIndexError";
  }
}

type Typed = Uint8Array | Uint16Array | Uint32Array | Int32Array;

export function encodeSearchData(data: SearchData): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    size += bytes.length;
    const pad = (4 - (bytes.length % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      size += pad;
    }
  };
  const u32 = (...values: number[]) => push(new Uint8Array(Uint32Array.from(values).buffer));
  const array = (a: Typed) => {
    u32(a.byteLength);
    push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  };
  const strings = (list: string[]) => {
    const encoded = list.map((s) => encoder.encode(s));
    const offsets = new Uint32Array(list.length + 1);
    for (let i = 0; i < encoded.length; i++) offsets[i + 1] = offsets[i]! + encoded[i]!.length;
    const bytes = new Uint8Array(offsets[list.length]!);
    for (let i = 0; i < encoded.length; i++) bytes.set(encoded[i]!, offsets[i]!);
    array(offsets);
    array(bytes);
  };
  u32(MAGIC, VERSION);
  push(new Uint8Array(Float64Array.from(data.bbox).buffer));
  strings(data.strings);
  strings(data.categories);
  for (const a of [
    data.kind,
    data.rank,
    data.category,
    data.name,
    data.context,
    data.number,
    data.street,
    data.lon,
    data.lat,
    data.shapes,
    data.parts,
    data.coords,
    data.terms,
    data.termStart,
    data.postings,
  ])
    array(a);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function decodeSearchData(input: ArrayBuffer | Uint8Array): SearchData {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const buffer = bytes.byteOffset % 8 === 0 ? bytes.buffer : bytes.slice().buffer;
  const base = bytes.byteOffset % 8 === 0 ? bytes.byteOffset : 0;
  const end = base + bytes.byteLength;
  let at = base;
  const need = (n: number) => {
    if (at + n > end) throw new SearchIndexError("the search index is truncated");
  };
  const u32 = () => {
    need(4);
    const v = new DataView(buffer, at, 4).getUint32(0, true);
    at += 4;
    return v;
  };
  const view = <T extends Typed>(make: new (b: ArrayBufferLike, o: number, n: number) => T, unit: number): T => {
    const length = u32();
    if (length % unit) throw new SearchIndexError("the search index is damaged");
    need(length);
    const a = new make(buffer, at, length / unit);
    at += length + ((4 - (length % 4)) % 4);
    return a;
  };
  const decoder = new TextDecoder();
  const strings = () => {
    const offsets = view(Uint32Array, 4);
    const text = view(Uint8Array, 1);
    const out = new Array<string>(Math.max(0, offsets.length - 1));
    for (let i = 0; i < out.length; i++) out[i] = decoder.decode(text.subarray(offsets[i]!, offsets[i + 1]!));
    return out;
  };
  if (bytes.byteLength < 16 || u32() !== MAGIC) throw new SearchIndexError("this is not a Mapkern search index");
  const version = u32();
  if (version !== VERSION) throw new SearchIndexError(`search index version ${version} is not supported`);
  need(32);
  const box = new DataView(buffer, at, 32);
  const bbox: [number, number, number, number] = [
    box.getFloat64(0, true),
    box.getFloat64(8, true),
    box.getFloat64(16, true),
    box.getFloat64(24, true),
  ];
  at += 32;
  const data: SearchData = {
    bbox,
    strings: strings(),
    categories: strings(),
    kind: view(Uint8Array, 1),
    rank: view(Uint8Array, 1),
    category: view(Uint16Array, 2),
    name: view(Uint32Array, 4),
    context: view(Uint32Array, 4),
    number: view(Uint32Array, 4),
    street: view(Uint32Array, 4),
    lon: view(Int32Array, 4),
    lat: view(Int32Array, 4),
    shapes: view(Uint32Array, 4),
    parts: view(Uint32Array, 4),
    coords: view(Int32Array, 4),
    terms: view(Uint32Array, 4),
    termStart: view(Uint32Array, 4),
    postings: view(Uint32Array, 4),
  };
  const n = data.kind.length;
  for (const a of [data.rank, data.category, data.name, data.context, data.number, data.street, data.lon, data.lat])
    if (a.length !== n) throw new SearchIndexError("the search index is damaged");
  if (data.shapes.length !== n + 1 || data.termStart.length !== data.terms.length + 1)
    throw new SearchIndexError("the search index is damaged");
  return data;
}
