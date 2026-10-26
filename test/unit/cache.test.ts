import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ResponseStore, StoredState } from "../../src/tiles/cache.ts";
import { cacheable, freshUntil, markServer } from "../../src/tiles/cache.ts";
import { FetchFailure, fetchBytes } from "../../src/tiles/fetch.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  markServer("https://tiles.example.com/", true);
});

const headers = (h: Record<string, string>) => new Headers(h);

class MemoryStore implements ResponseStore {
  readonly rows = new Map<string, { data: ArrayBuffer; type: string; expires: number }>();
  state(url: string): StoredState {
    const row = this.rows.get(url);
    if (!row) return "missing";
    return row.expires > Date.now() ? "fresh" : "stale";
  }
  read(url: string) {
    const row = this.rows.get(url);
    return Promise.resolve(row ? { data: row.data, type: row.type } : null);
  }
  write(url: string, data: ArrayBuffer, type: string, expires: number) {
    this.rows.set(url, { data, type, expires });
  }
}

function serve(responses: (() => Response | Promise<Response>)[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls++;
    return next();
  }) as typeof fetch;
  return () => calls;
}

const URL_A = "https://tiles.example.com/1/2/3.pbf";
const bytes = (...v: number[]) => new Uint8Array(v).buffer;
const signal = () => new AbortController().signal;

test("freshness follows the server's cache headers", () => {
  const now = 1_000_000;
  assert.equal(freshUntil(headers({ "cache-control": "public, max-age=60" }), now), now + 60_000);
  assert.equal(freshUntil(headers({ "cache-control": "max-age=60", age: "20" }), now), now + 40_000);
  assert.equal(freshUntil(headers({ "cache-control": "no-store" }), now), null);
  assert.equal(freshUntil(headers({ "cache-control": "no-cache, max-age=60" }), now), 0);
  assert.equal(
    freshUntil(headers({ expires: new Date(now + 5000).toUTCString() }), now),
    Math.floor((now + 5000) / 1000) * 1000,
  );
  assert.equal(freshUntil(headers({}), now), 0);
});

test("only remote http and https addresses are kept", () => {
  assert.equal(cacheable("https://tiles.example.com/a.pbf"), true);
  assert.equal(cacheable("http://127.0.0.1:8080/a.pbf"), false);
  assert.equal(cacheable("http://localhost/a.pbf"), false);
  assert.equal(cacheable("blob:https://x/1"), false);
  assert.equal(cacheable("data:,x"), false);
});

test("a fresh copy is used without asking the server", async () => {
  const store = new MemoryStore();
  store.write(URL_A, bytes(1, 2), "application/x-protobuf", Date.now() + 60_000);
  const calls = serve([() => new Response(bytes(9))]);
  const result = await fetchBytes({ url: URL_A }, signal(), 1000, "tile", store);
  assert.equal(calls(), 0);
  assert.deepEqual(result.kind === "data" ? [...new Uint8Array(result.data)] : null, [1, 2]);
});

test("a stale copy is refreshed from the network and saved", async () => {
  const store = new MemoryStore();
  store.write(URL_A, bytes(1), "image/png", Date.now() - 1);
  const calls = serve([
    () => new Response(bytes(7, 7), { headers: { "cache-control": "max-age=3600", "content-type": "image/png" } }),
  ]);
  const result = await fetchBytes({ url: URL_A }, signal(), 1000, "tile", store);
  assert.equal(calls(), 1);
  assert.deepEqual(result.kind === "data" ? [...new Uint8Array(result.data)] : null, [7, 7]);
  assert.equal(store.state(URL_A), "fresh");
});

test("when the network or server fails, the saved copy is used", async () => {
  for (const failure of [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => new Response("", { status: 503 }),
  ]) {
    markServer(URL_A, true);
    const store = new MemoryStore();
    store.write(URL_A, bytes(4, 5), "image/png", Date.now() - 1);
    serve([failure]);
    const result = await fetchBytes({ url: URL_A }, signal(), 1000, "tile", store);
    assert.deepEqual(result.kind === "data" ? [...new Uint8Array(result.data)] : null, [4, 5]);
  }
});

test("after a failure the server is skipped for a while, so tiles come from the cache at once", async () => {
  const store = new MemoryStore();
  store.write(URL_A, bytes(4), "image/png", Date.now() - 1);
  const calls = serve([() => Promise.reject(new TypeError("Failed to fetch"))]);
  await fetchBytes({ url: URL_A }, signal(), 1000, "tile", store);
  await fetchBytes({ url: URL_A }, signal(), 1000, "tile", store);
  assert.equal(calls(), 1);
});

test("refused access is not papered over with an old copy", async () => {
  const store = new MemoryStore();
  store.write(URL_A, bytes(4), "image/png", Date.now() - 1);
  serve([() => new Response("", { status: 403 })]);
  await assert.rejects(fetchBytes({ url: URL_A }, signal(), 1000, "tile", store), FetchFailure);
});

test("without a saved copy a failure is still a failure", async () => {
  const store = new MemoryStore();
  serve([() => Promise.reject(new TypeError("Failed to fetch"))]);
  await assert.rejects(fetchBytes({ url: URL_A }, signal(), 1000, "tile", store), FetchFailure);
});

test("no-store answers are not saved", async () => {
  const store = new MemoryStore();
  serve([() => new Response(bytes(1), { headers: { "cache-control": "no-store" } })]);
  await fetchBytes({ url: URL_A }, signal(), 1000, "tile", store);
  assert.equal(store.state(URL_A), "missing");
});
