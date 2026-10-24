import assert from "node:assert/strict";
import { test } from "node:test";
import { BYTES, Reader, VARINT, Writer } from "../../src/formats/protobuf.ts";

test("varints round trip across the 32-bit boundary", () => {
  const values = [0, 1, 127, 128, 300, 2 ** 21, 2 ** 28 - 1, 2 ** 28, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 5, 13_000_000_123, 2 ** 53 - 1];
  const w = new Writer(4);
  for (const v of values) w.varint(v);
  const r = new Reader(w.finish());
  for (const v of values) assert.equal(r.varint(), v);
  assert.ok(r.done);
});

test("zigzag varints round trip", () => {
  const values = [0, -1, 1, -64, 64, -(2 ** 31), 2 ** 31, -13_000_000_123, 13_000_000_123, -(2 ** 52)];
  const w = new Writer();
  for (const v of values) w.svarint(v);
  const r = new Reader(w.finish());
  for (const v of values) assert.equal(r.svarint(), v);
});

test("negative int32 and int64 use ten-byte two's complement", () => {
  const minusOne = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
  assert.equal(new Reader(minusOne).int64(), -1);
  assert.equal(new Reader(minusOne).int32(), -1);
  const minusTwo = new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
  assert.equal(new Reader(minusTwo).int64(), -2);
  assert.equal(new Reader(minusTwo).int32(), -2);
  const big = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
  assert.equal(new Reader(big).int64(), -(2 ** 63));
});

test("truncated and oversized varints throw", () => {
  assert.throws(() => new Reader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])).varint());
  assert.throws(() => new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])).varint());
});

test("messages, strings and packed fields", () => {
  const w = new Writer(2);
  w.tag(1, BYTES);
  w.string("Puget Sound ↗");
  w.message(2, (m) => {
    m.tag(1, VARINT);
    m.varint(42);
    m.tag(2, BYTES);
    m.string("x".repeat(300));
  });
  w.packedVarint(3, [1, 2, 3, 2 ** 40]);
  const r = new Reader(w.finish());
  assert.equal(r.tag(), (1 << 3) | BYTES);
  assert.equal(r.string(), "Puget Sound ↗");
  assert.equal(r.tag() >> 3, 2);
  const sub = r.sub();
  assert.equal(sub.tag() >> 3, 1);
  assert.equal(sub.varint(), 42);
  assert.equal(sub.tag() >> 3, 2);
  assert.equal(sub.string().length, 300);
  assert.ok(sub.done);
  assert.equal(r.tag() >> 3, 3);
  const end = r.packedEnd();
  const packed: number[] = [];
  while (r.pos < end) packed.push(r.varint());
  assert.deepEqual(packed, [1, 2, 3, 2 ** 40]);
  assert.ok(r.done);
});

test("skipping fields of every wire type lands on the next tag", () => {
  const w = new Writer();
  w.tag(1, BYTES);
  w.string("y".repeat(200));
  w.tag(2, VARINT);
  w.varint(2 ** 40);
  w.tag(3, 1);
  w.double(1.5);
  w.tag(4, 5);
  w.float(2.5);
  w.tag(9, VARINT);
  w.varint(7);
  const r = new Reader(w.finish());
  for (let i = 0; i < 4; i++) {
    const tag = r.tag();
    r.skip(tag & 7);
  }
  assert.equal(r.tag() >> 3, 9);
  assert.equal(r.varint(), 7);
  assert.ok(r.done);
});

test("embedded messages cannot read past their parent", () => {
  const w = new Writer();
  w.tag(1, BYTES);
  w.varint(50);
  w.varint(1);
  const r = new Reader(w.finish());
  r.tag();
  assert.throws(() => r.sub());
});
