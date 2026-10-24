import assert from "node:assert/strict";
import { test } from "node:test";
import { Transform } from "../../src/camera/transform.ts";
import type { Rect, TileCoord } from "../../src/geo/tile.ts";
import { FetchFailure } from "../../src/tiles/fetch.ts";
import type { ManagerOptions, RenderPiece, TileLoader } from "../../src/tiles/manager.ts";
import { TileManager } from "../../src/tiles/manager.ts";
import { RequestScheduler } from "../../src/tiles/scheduler.ts";

interface Pending {
  coord: TileCoord;
  signal: AbortSignal;
  resolve: (v: string | null) => void;
  reject: (e: unknown) => void;
}

class FakeLoader implements TileLoader<string> {
  pending: Pending[] = [];
  released: string[] = [];
  load(coord: TileCoord, signal: AbortSignal): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.pending.push({ coord: { z: coord.z, x: coord.x, y: coord.y }, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  }
  needsUpload(): boolean {
    return false;
  }
  upload(): void {}
  release(data: string): void {
    this.released.push(data);
  }
  byteSize(): number {
    return 1000;
  }
  take(filter: (c: TileCoord) => boolean): Pending[] {
    const out = this.pending.filter((p) => filter(p.coord));
    this.pending = this.pending.filter((p) => !filter(p.coord));
    return out;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const options: ManagerOptions = {
  fadeDuration: 0,
  backstopLevels: 2,
  maxRetries: 2,
  cacheBytes: 1e9,
  failureCooldownMs: 60000,
  prefetchLimit: 0,
};

function setup(zoom: number, opts: Partial<ManagerOptions> = {}) {
  const transform = new Transform();
  transform.resize(800, 600);
  transform.setCenter(10, 20);
  transform.setZoom(zoom);
  const loader = new FakeLoader();
  const scheduler = new RequestScheduler(64);
  const failures: string[] = [];
  const manager = new TileManager(
    "test",
    { tileSize: 512, minZoom: 0, maxZoom: 14, roundZoom: false, bounds: null },
    loader,
    scheduler,
    { ...options, ...opts },
    { changed() {}, failure: (f) => failures.push(f.kind), wakeAt() {} },
  );
  return { transform, loader, scheduler, manager, failures };
}

function pieceWorldRect(p: RenderPiece<string>): Rect {
  const n = 2 ** p.tile.z;
  const x0 = p.wrap + (p.tile.x + p.clip.x0) / n;
  const x1 = p.wrap + (p.tile.x + p.clip.x1) / n;
  const y0 = (p.tile.y + p.clip.y0) / n;
  const y1 = (p.tile.y + p.clip.y1) / n;
  return { x0, y0, x1, y1 };
}

function assertDisjoint(pieces: RenderPiece<string>[]): void {
  const rects = pieces.map(pieceWorldRect);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-12 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1e-12;
      assert.ok(!overlap, `pieces ${i} and ${j} overlap`);
    }
  }
}

function coveredArea(pieces: RenderPiece<string>[]): number {
  return pieces.map(pieceWorldRect).reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
}

async function resolveAll(loader: FakeLoader, filter: (c: TileCoord) => boolean = () => true) {
  for (const p of loader.take(filter)) p.resolve(`${p.coord.z}/${p.coord.x}/${p.coord.y}`);
  await flush();
}

test("requests visible tiles plus a coarse backstop, nothing drawn yet", async () => {
  const { transform, loader, manager } = setup(4);
  manager.update(transform, 0);
  await flush();
  const zooms = new Set(loader.pending.map((p) => p.coord.z));
  assert.ok(zooms.has(4) && zooms.has(2));
  assert.equal(manager.pieces.length, 0);
  assert.ok(manager.stats.blankPending > 0.99);
});

test("backstop ancestors cover every slot until detail arrives", async () => {
  const { transform, loader, manager } = setup(4);
  manager.update(transform, 0);
  await flush();
  await resolveAll(loader, (c) => c.z === 2);
  manager.update(transform, 1);
  const pieces = manager.pieces;
  assert.ok(pieces.length > 0);
  for (const p of pieces) assert.equal(p.tile.z, 2);
  assertDisjoint(pieces);
  assert.equal(manager.stats.blankPending, 0);
  assert.equal(pieces.length, manager.stats.visibleSlots);
});

test("detailed tiles replace fallback as they arrive without overlap", async () => {
  const { transform, loader, manager } = setup(4);
  manager.update(transform, 0);
  await flush();
  await resolveAll(loader, (c) => c.z === 2);
  const first = loader.take((c) => c.z === 4).slice(0, 3);
  for (const p of first) p.resolve("detail");
  await flush();
  manager.update(transform, 2);
  const pieces = manager.pieces;
  assertDisjoint(pieces);
  assert.equal(pieces.filter((p) => p.tile.z === 4).length, 3);
  assert.equal(manager.stats.blankPending, 0);
});

test("zooming out draws loaded children inside the coarser slot", async () => {
  const { transform, loader, manager } = setup(4);
  manager.update(transform, 0);
  await flush();
  await resolveAll(loader);
  manager.update(transform, 1);
  const before = coveredArea(manager.pieces);
  transform.setZoom(3);
  manager.update(transform, 2);
  await flush();
  const pieces = manager.pieces;
  assertDisjoint(pieces);
  assert.ok(pieces.some((p) => p.tile.z === 4), "children should stand in for missing z3 tiles");
  assert.ok(coveredArea(pieces) >= before - 1e-12);
});

test("failed child keeps the parent visible and retries are bounded", async () => {
  const { transform, loader, manager, failures } = setup(3, { maxRetries: 1 });
  manager.update(transform, 0);
  await flush();
  await resolveAll(loader, (c) => c.z === 1);
  for (const p of loader.take((c) => c.z === 3)) {
    p.reject(new FetchFailure({ kind: "http", status: 500, message: "HTTP 500", retryable: true }));
  }
  await flush();
  manager.update(transform, performance.now());
  assert.ok(manager.pieces.length > 0);
  for (const p of manager.pieces) assert.equal(p.tile.z, 1);
  const tile = manager.getTile(manager.pieces[0]!.slotZ, 0, 0);
  assert.ok(tile === undefined || tile.state === "queued" || tile.state === "failed");
  manager.update(transform, performance.now() + 60000);
  await flush();
  for (const p of loader.take((c) => c.z === 3)) {
    p.reject(new FetchFailure({ kind: "http", status: 500, message: "HTTP 500", retryable: true }));
  }
  await flush();
  manager.update(transform, performance.now() + 60001);
  await flush();
  assert.equal(loader.pending.filter((p) => p.coord.z === 3).length, 0, "no third attempt before cooldown");
  assert.ok(failures.length > 0);
  assert.ok(manager.stats.failed > 0);
  assert.equal(manager.stats.blankFailed, 0);
});

test("missing data uses the ancestor and counts as no-data without one", async () => {
  const { transform, loader, manager } = setup(3);
  manager.update(transform, 0);
  await flush();
  for (const p of loader.take(() => true)) p.resolve(null);
  await flush();
  manager.update(transform, 1);
  assert.equal(manager.pieces.length, 0);
  assert.ok(manager.stats.noData > 0.99);
  assert.equal(manager.stats.blankPending, 0);
});

test("tiles that leave the view are aborted and released", async () => {
  const { transform, loader, manager } = setup(6);
  manager.update(transform, 0);
  await flush();
  const inflight = loader.pending.slice();
  assert.ok(inflight.length > 0);
  transform.setCenter(-120, -40);
  manager.update(transform, 1);
  await flush();
  assert.ok(inflight.every((p) => p.signal.aborted));
  assert.ok(manager.stats.aborted > 0);
});

test("cache evicts least recently used tiles over budget but keeps visible ones", async () => {
  const { transform, loader, manager } = setup(5, { cacheBytes: 20000 });
  manager.update(transform, 0);
  await flush();
  await resolveAll(loader);
  manager.update(transform, 1);
  const visible = manager.pieces.length;
  transform.setCenter(100, -30);
  manager.update(transform, 2);
  await flush();
  await resolveAll(loader);
  manager.update(transform, 3);
  const stats = manager.stats;
  assert.ok(stats.evicted > 0);
  assert.ok(stats.ready >= manager.pieces.length);
  assert.ok(visible > 0);
  assert.ok(loader.released.length > 0);
});

test("scheduler honours priority and concurrency", async () => {
  const scheduler = new RequestScheduler(2);
  const started: number[] = [];
  const gates: (() => void)[] = [];
  for (const priority of [5, 1, 3, 0]) {
    scheduler.enqueue({
      group: "g",
      priority,
      run: () =>
        new Promise<void>((resolve) => {
          started.push(priority);
          gates.push(resolve);
        }),
    });
  }
  await flush();
  assert.deepEqual(started, [0, 1]);
  gates.shift()!();
  await flush();
  assert.deepEqual(started, [0, 1, 3]);
});
