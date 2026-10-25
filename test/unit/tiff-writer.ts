import { deflateSync } from "node:zlib";

export interface WriteOptions {
  little: boolean;
  big: boolean;
  width: number;
  height: number;
  tile: number | null;
  type: "f32" | "f64" | "i16";
  deflate: boolean;
  value: (x: number, y: number) => number;
  tags?: [number, number, number[]][];
}

export function writeTiff(o: WriteOptions): Uint8Array {
  const bps = o.type === "f64" ? 8 : o.type === "f32" ? 4 : 2;
  const format = o.type === "i16" ? 2 : 3;
  const bw = o.tile ?? o.width;
  const bh = o.tile ?? o.height;
  const across = Math.ceil(o.width / bw);
  const down = Math.ceil(o.height / bh);
  const blocks: Uint8Array[] = [];
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const rows = o.tile ? bh : Math.min(bh, o.height - by * bh);
      const raw = new Uint8Array(bw * rows * bps);
      const v = new DataView(raw.buffer);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < bw; c++) {
          const x = bx * bw + c;
          const y = by * bh + r;
          const value = x < o.width && y < o.height ? o.value(x, y) : 0;
          const at = (r * bw + c) * bps;
          if (o.type === "f64") v.setFloat64(at, value, o.little);
          else if (o.type === "f32") v.setFloat32(at, value, o.little);
          else v.setInt16(at, value, o.little);
        }
      }
      blocks.push(o.deflate ? new Uint8Array(deflateSync(raw)) : raw);
    }
  }
  const headerSize = o.big ? 16 : 8;
  let cursor = headerSize;
  const offsets: number[] = [];
  for (const b of blocks) {
    offsets.push(cursor);
    cursor += b.length;
  }
  type Tag = [number, number, number[]];
  const list: Tag[] = [
    [256, 4, [o.width]],
    [257, 4, [o.height]],
    [258, 3, [bps * 8]],
    [259, 3, [o.deflate ? 8 : 1]],
    [262, 3, [1]],
    [277, 3, [1]],
    [339, 3, [format]],
    ...(o.tile
      ? ([
          [322, 4, [bw]],
          [323, 4, [bh]],
          [324, o.big ? 16 : 4, offsets],
          [325, 4, blocks.map((b) => b.length)],
        ] as Tag[])
      : ([
          [273, o.big ? 16 : 4, offsets],
          [278, 4, [bh]],
          [279, 4, blocks.map((b) => b.length)],
        ] as Tag[])),
    ...(o.tags ?? []),
  ];
  const tags = list.sort((a, b) => a[0] - b[0]);
  const size: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 };
  const entrySize = o.big ? 20 : 12;
  const inline = o.big ? 8 : 4;
  const ifdOffset = cursor;
  const ifdSize = (o.big ? 8 : 2) + tags.length * entrySize + (o.big ? 8 : 4);
  let extra = ifdOffset + ifdSize;
  const extras: [number, number, number, number[]][] = [];
  for (const [tag, type, values] of tags) {
    const bytesNeeded = size[type]! * values.length;
    if (bytesNeeded > inline) {
      extras.push([extra, tag, type, values]);
      extra += bytesNeeded;
    }
  }
  const out = new Uint8Array(extra);
  const v = new DataView(out.buffer);
  out.set(o.little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  v.setUint16(2, o.big ? 43 : 42, o.little);
  if (o.big) {
    v.setUint16(4, 8, o.little);
    v.setBigUint64(8, BigInt(ifdOffset), o.little);
  } else {
    v.setUint32(4, ifdOffset, o.little);
  }
  for (let i = 0; i < blocks.length; i++) out.set(blocks[i]!, offsets[i]!);
  const put = (at: number, type: number, values: number[]) => {
    values.forEach((value, i) => {
      const p = at + i * size[type]!;
      if (type === 3) v.setUint16(p, value, o.little);
      else if (type === 4) v.setUint32(p, value, o.little);
      else if (type === 12) v.setFloat64(p, value, o.little);
      else if (type === 16) v.setBigUint64(p, BigInt(value), o.little);
      else v.setUint8(p, value);
    });
  };
  let p = ifdOffset;
  if (o.big) v.setBigUint64(p, BigInt(tags.length), o.little);
  else v.setUint16(p, tags.length, o.little);
  p += o.big ? 8 : 2;
  for (const [tag, type, values] of tags) {
    v.setUint16(p, tag, o.little);
    v.setUint16(p + 2, type, o.little);
    if (o.big) v.setBigUint64(p + 4, BigInt(values.length), o.little);
    else v.setUint32(p + 4, values.length, o.little);
    const at = extras.find((e) => e[1] === tag);
    if (at) {
      if (o.big) v.setBigUint64(p + 12, BigInt(at[0]), o.little);
      else v.setUint32(p + 8, at[0], o.little);
      put(at[0], type, values);
    } else {
      put(p + (o.big ? 12 : 8), type, values);
    }
    p += entrySize;
  }
  return out;
}
