import { BYTES, VARINT, Writer } from "../../src/formats/protobuf.ts";
import type { Props } from "./schema.ts";

export interface EncodedFeature {
  id: number;
  type: 1 | 2 | 3;
  parts: Int32Array[];
  props: Props;
}

export interface EncodedLayer {
  name: string;
  extent: number;
  features: EncodedFeature[];
}

const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;

function command(id: number, count: number): number {
  return (id & 0x7) | (count << 3);
}

function zigzag(v: number): number {
  return v < 0 ? -v * 2 - 1 : v * 2;
}

export function encodeGeometry(type: 1 | 2 | 3, parts: Int32Array[]): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  if (type === 1) {
    let count = 0;
    for (const p of parts) count += p.length / 2;
    out.push(command(MOVE_TO, count));
    for (const p of parts) {
      for (let i = 0; i < p.length; i += 2) {
        out.push(zigzag(p[i]! - cx), zigzag(p[i + 1]! - cy));
        cx = p[i]!;
        cy = p[i + 1]!;
      }
    }
    return out;
  }
  for (const p of parts) {
    const n = type === 3 ? p.length / 2 - 1 : p.length / 2;
    if (n < (type === 3 ? 3 : 2)) continue;
    out.push(command(MOVE_TO, 1), zigzag(p[0]! - cx), zigzag(p[1]! - cy));
    cx = p[0]!;
    cy = p[1]!;
    out.push(command(LINE_TO, n - 1));
    for (let i = 1; i < n; i++) {
      const x = p[i * 2]!;
      const y = p[i * 2 + 1]!;
      out.push(zigzag(x - cx), zigzag(y - cy));
      cx = x;
      cy = y;
    }
    if (type === 3) out.push(command(CLOSE_PATH, 1));
  }
  return out;
}

export function encodeTile(layers: EncodedLayer[]): Uint8Array {
  const w = new Writer(64 * 1024);
  for (const layer of layers) {
    if (layer.features.length === 0) continue;
    w.message(3, (lw) => writeLayer(lw, layer));
  }
  return w.finish();
}

function writeLayer(w: Writer, layer: EncodedLayer): void {
  w.tag(15, VARINT);
  w.varint(2);
  w.tag(1, BYTES);
  w.string(layer.name);
  const keys = new Map<string, number>();
  const values = new Map<string, number>();
  const valueList: (string | number | boolean)[] = [];
  const keyList: string[] = [];
  for (const f of layer.features) {
    const geometry = encodeGeometry(f.type, f.parts);
    if (geometry.length === 0) continue;
    const tags: number[] = [];
    for (const [k, v] of Object.entries(f.props)) {
      if (v === undefined || v === null || v === "") continue;
      let ki = keys.get(k);
      if (ki === undefined) {
        ki = keyList.length;
        keyList.push(k);
        keys.set(k, ki);
      }
      const vk = `${typeof v}:${String(v)}`;
      let vi = values.get(vk);
      if (vi === undefined) {
        vi = valueList.length;
        valueList.push(v);
        values.set(vk, vi);
      }
      tags.push(ki, vi);
    }
    w.message(2, (fw) => {
      if (f.id > 0) {
        fw.tag(1, VARINT);
        fw.varint(f.id);
      }
      fw.packedVarint(2, tags);
      fw.tag(3, VARINT);
      fw.varint(f.type);
      fw.packedVarint(4, geometry);
    });
  }
  for (const k of keyList) {
    w.tag(3, BYTES);
    w.string(k);
  }
  for (const v of valueList) {
    w.message(4, (vw) => {
      if (typeof v === "string") {
        vw.tag(1, BYTES);
        vw.string(v);
      } else if (typeof v === "boolean") {
        vw.tag(7, VARINT);
        vw.varint(v ? 1 : 0);
      } else if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) {
        if (v >= 0) {
          vw.tag(5, VARINT);
          vw.varint(v);
        } else {
          vw.tag(6, VARINT);
          vw.svarint(v);
        }
      } else {
        vw.tag(3, 1);
        vw.double(v);
      }
    });
  }
  w.tag(5, VARINT);
  w.varint(layer.extent);
}
