import type { CoveringTile, Transform } from "../camera/transform.ts";
import type { Rect, TileCoord } from "../geo/tile.ts";
import { childTiles, parentTile, subRect, tileKey } from "../geo/tile.ts";
import { FetchFailure, isAbortError, retryDelay } from "./fetch.ts";
import type { JobHandle, RequestScheduler } from "./scheduler.ts";
import type { TileFailure } from "./tile.ts";
import { Tile } from "./tile.ts";

export interface TileLoader<D> {
  load(tile: TileCoord, signal: AbortSignal, onDecoding: () => void): Promise<D | null>;
  needsUpload(data: D): boolean;
  upload(data: D): void;
  release(data: D): void;
  byteSize(data: D): number;
}

export interface Tiling {
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  roundZoom: boolean;
  bounds: Rect | null;
}

export interface RenderPiece<D> {
  readonly tile: Tile<D>;
  readonly wrap: number;
  readonly clip: Rect;
  readonly opacity: number;
  readonly slotZ: number;
}

export interface ManagerOptions {
  fadeDuration: number;
  backstopLevels: readonly number[];
  maxRetries: number;
  cacheBytes: number;
  failureCooldownMs: number;
  prefetchLimit: number;
}

export interface TileStats {
  tiles: number;
  ready: number;
  loading: number;
  failed: number;
  empty: number;
  refreshing: number;
  bytes: number;
  visibleSlots: number;
  pieces: number;
  fallbackPieces: number;
  requested: number;
  completed: number;
  aborted: number;
  retried: number;
  failures: number;
  evicted: number;
  blankPending: number;
  blankFailed: number;
  noData: number;
}

export interface ManagerEvents {
  changed(): void;
  failure(failure: TileFailure, tile: TileCoord): void;
  wakeAt(time: number): void;
}

const FULL: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
const LINGER_MS = 2500;
const MAX_FALLBACK_DEPTH = 2;
const BREAKER_THRESHOLD = 16;

export class TileManager<D> {
  readonly id: string;
  tiling: Tiling;
  options: ManagerOptions;
  pieces: RenderPiece<D>[] = [];
  private readonly loader: TileLoader<D>;
  private readonly scheduler: RequestScheduler;
  private readonly events: ManagerEvents;
  private readonly tiles = new Map<number, Tile<D>>();
  private readonly jobs = new Map<number, JobHandle>();
  private frame = 0;
  private generation = 0;
  private fading = false;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private destroyed = false;
  private visibleCount = 0;
  private fallbackCount = 0;
  private blankPendingArea = 0;
  private blankFailedArea = 0;
  private noDataArea = 0;
  private viewArea = 0;
  private counters = { requested: 0, completed: 0, aborted: 0, retried: 0, failures: 0, evicted: 0 };

  constructor(
    id: string,
    tiling: Tiling,
    loader: TileLoader<D>,
    scheduler: RequestScheduler,
    options: ManagerOptions,
    events: ManagerEvents,
  ) {
    this.id = id;
    this.tiling = tiling;
    this.loader = loader;
    this.scheduler = scheduler;
    this.options = options;
    this.events = events;
  }

  get isFading(): boolean {
    return this.fading;
  }

  get hasPendingUploads(): boolean {
    for (const tile of this.tiles.values()) {
      if ((tile.state === "prepared" && tile.wanted) || tile.next !== null) return true;
    }
    return false;
  }

  get isLoaded(): boolean {
    for (const tile of this.tiles.values()) {
      if (!tile.wanted || tile.priority >= 10000) continue;
      if (tile.isLoading || (this.isOutdated(tile) && tile.failure === null)) return false;
    }
    return true;
  }

  get stats(): TileStats {
    let ready = 0,
      loading = 0,
      failed = 0,
      empty = 0,
      refreshing = 0,
      bytes = 0;
    for (const tile of this.tiles.values()) {
      if (tile.state === "ready") ready++;
      else if (tile.isLoading) loading++;
      else if (tile.state === "failed") failed++;
      else if (tile.state === "empty") empty++;
      if (this.isOutdated(tile) || tile.next !== null) refreshing++;
      bytes += tile.bytes;
    }
    const area = this.viewArea > 0 ? this.viewArea : 1;
    return {
      tiles: this.tiles.size,
      ready,
      loading,
      failed,
      empty,
      refreshing,
      bytes,
      visibleSlots: this.visibleCount,
      pieces: this.pieces.length,
      fallbackPieces: this.fallbackCount,
      ...this.counters,
      blankPending: this.blankPendingArea / area,
      blankFailed: this.blankFailedArea / area,
      noData: this.noDataArea / area,
    };
  }

  getTile(z: number, x: number, y: number): Tile<D> | undefined {
    return this.tiles.get(tileKey(z, x, y));
  }

  forEachTile(fn: (tile: Tile<D>) => void): void {
    for (const tile of this.tiles.values()) fn(tile);
  }

  update(transform: Transform, now: number, predicted: readonly Transform[] = []): void {
    if (this.destroyed) return;
    this.frame++;
    for (const tile of this.tiles.values()) {
      tile.wanted = false;
      tile.retained = false;
      tile.priority = Number.POSITIVE_INFINITY;
    }
    const cover = {
      tileSize: this.tiling.tileSize,
      minZoom: this.tiling.minZoom,
      maxZoom: this.tiling.maxZoom,
      round: this.tiling.roundZoom,
    };
    const ideal = transform.coveringTiles(cover);
    this.visibleCount = ideal.length;
    const inBounds: CoveringTile[] = [];
    for (let i = 0; i < ideal.length; i++) {
      const slot = ideal[i]!;
      if (!this.withinBounds(slot)) continue;
      inBounds.push(slot);
      this.want(slot.z, slot.x, slot.y, i, now);
    }
    const levels = [...this.options.backstopLevels].sort((a, b) => b - a);
    for (let l = 0; l < levels.length; l++) {
      const level = levels[l]!;
      if (level <= 0) continue;
      let order = 0;
      const base = -10000 * (levels.length - l);
      for (const slot of inBounds) {
        const z = Math.max(this.tiling.minZoom, slot.z - level);
        if (z >= slot.z) continue;
        const p = parentTile(slot, slot.z - z);
        const existing = this.tiles.get(tileKey(p.z, p.x, p.y));
        if (existing?.wanted) continue;
        this.want(p.z, p.x, p.y, base + order++, now);
      }
    }
    let prefetched = 0;
    let order = 0;
    for (const future of predicted) {
      const tiles = future.coveringTiles(cover);
      for (const level of levels) {
        if (level <= 0) continue;
        for (const slot of tiles) {
          if (!this.withinBounds(slot)) continue;
          const z = Math.max(this.tiling.minZoom, slot.z - level);
          if (z >= slot.z) continue;
          const p = parentTile(slot, slot.z - z);
          const existing = this.tiles.get(tileKey(p.z, p.x, p.y));
          if (existing?.wanted) continue;
          this.want(p.z, p.x, p.y, 9000 + order++, now);
        }
      }
      for (let i = 0; i < tiles.length && prefetched < this.options.prefetchLimit; i++) {
        const slot = tiles[i]!;
        if (!this.withinBounds(slot)) continue;
        const existing = this.tiles.get(tileKey(slot.z, slot.x, slot.y));
        if (existing?.wanted) continue;
        this.want(slot.z, slot.x, slot.y, 10000 + i, now);
        prefetched++;
      }
    }
    for (const tile of this.tiles.values()) {
      if (tile.wanted) tile.unwantedSince = Number.NaN;
      else if (Number.isNaN(tile.unwantedSince)) tile.unwantedSince = now;
    }
    this.buildPieces(transform, ideal, now);
    this.dispatch(now);
    this.evict();
  }

  uploadPending(deadline: number, now: number): boolean {
    const pending: Tile<D>[] = [];
    for (const tile of this.tiles.values()) if (tile.state === "prepared" || tile.next !== null) pending.push(tile);
    if (pending.length === 0) return false;
    pending.sort((a, b) => (a.wanted ? a.priority : 1e12) - (b.wanted ? b.priority : 1e12));
    let uploaded = false;
    for (const tile of pending) {
      if (uploaded && performance.now() > deadline) return true;
      const next = tile.next;
      if (next !== null) {
        tile.next = null;
        this.loader.upload(next);
        const previous = tile.data;
        tile.data = next;
        if (previous) this.loader.release(previous);
        tile.bytes = this.loader.byteSize(next);
        uploaded = true;
        continue;
      }
      const data = tile.data;
      if (!data) continue;
      this.loader.upload(data);
      tile.bytes = this.loader.byteSize(data);
      tile.transition("ready");
      tile.readyAt = now;
      uploaded = true;
    }
    return false;
  }

  reload(): void {
    for (const tile of [...this.tiles.values()]) this.drop(tile);
    this.pieces = [];
  }

  refresh(): void {
    this.generation++;
    for (const tile of [...this.tiles.values()]) {
      if (!tile.wanted && !tile.retained) {
        this.drop(tile);
        continue;
      }
      if (tile.state === "ready") {
        tile.attempts = 0;
        tile.retryAt = 0;
        tile.failure = null;
      } else if (tile.state === "empty" || (tile.state === "failed" && tile.failure?.kind === "decode")) {
        tile.transition("queued");
        tile.attempts = 0;
        tile.retryAt = 0;
        tile.failure = null;
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const tile of [...this.tiles.values()]) this.drop(tile);
    this.pieces = [];
    this.scheduler.removeGroup(this.id);
  }

  private withinBounds(slot: TileCoord): boolean {
    const b = this.tiling.bounds;
    if (!b) return true;
    const n = 2 ** slot.z;
    return slot.x / n < b.x1 && (slot.x + 1) / n > b.x0 && slot.y / n < b.y1 && (slot.y + 1) / n > b.y0;
  }

  private want(z: number, x: number, y: number, priority: number, now: number): Tile<D> {
    const key = tileKey(z, x, y);
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = new Tile<D>(z, x, y);
      this.tiles.set(key, tile);
    } else if (tile.state === "failed" && now >= tile.retryAt) {
      tile.transition("queued");
      tile.attempts = 0;
      tile.failure = null;
    }
    tile.wanted = true;
    if (priority < tile.priority) tile.priority = priority;
    tile.lastUsed = this.frame;
    return tile;
  }

  private buildPieces(transform: Transform, ideal: readonly CoveringTile[], now: number): void {
    const pieces: RenderPiece<D>[] = [];
    this.fading = false;
    this.fallbackCount = 0;
    this.blankPendingArea = 0;
    this.blankFailedArea = 0;
    this.noDataArea = 0;
    this.viewArea = 0;
    for (const slot of ideal) {
      const area = slotArea(transform, slot.z, slot.x, slot.y, slot.wrap);
      this.viewArea += area;
      if (!this.withinBounds(slot)) {
        this.noDataArea += area;
        continue;
      }
      const tile = this.tiles.get(tileKey(slot.z, slot.x, slot.y));
      if (tile?.isReady) {
        const age = now - tile.readyAt;
        if (this.options.fadeDuration > 0 && age < this.options.fadeDuration) {
          this.fallback(pieces, slot, slot.wrap, slot.z, 0);
          pieces.push(this.piece(tile, slot.wrap, FULL, Math.max(0, age / this.options.fadeDuration), slot.z));
          this.fading = true;
        } else {
          pieces.push(this.piece(tile, slot.wrap, FULL, 1, slot.z));
        }
        continue;
      }
      const covered = this.fallback(pieces, slot, slot.wrap, slot.z, 0);
      if (!covered) {
        if (tile?.state === "empty") this.noDataArea += area;
        else if (tile?.state === "failed") this.blankFailedArea += area;
        else this.blankPendingArea += area;
      }
    }
    this.pieces = pieces;
  }

  private fallback(out: RenderPiece<D>[], region: TileCoord, wrap: number, slotZ: number, depth: number): boolean {
    if (depth < MAX_FALLBACK_DEPTH && region.z + 1 <= this.tiling.maxZoom) {
      const kids = childTiles(region);
      let anyReady = false;
      for (const kid of kids) {
        if (this.hasReadyDescendant(kid, MAX_FALLBACK_DEPTH - depth - 1)) {
          anyReady = true;
          break;
        }
      }
      if (anyReady) {
        let all = true;
        for (const kid of kids) {
          const tile = this.tiles.get(tileKey(kid.z, kid.x, kid.y));
          if (tile?.isReady) {
            out.push(this.piece(tile, wrap, FULL, 1, slotZ));
            this.fallbackCount++;
          } else if (!this.fallback(out, kid, wrap, slotZ, depth + 1)) {
            all = false;
          }
        }
        return all;
      }
    }
    for (let z = region.z - 1; z >= this.tiling.minZoom; z--) {
      const a = parentTile(region, region.z - z);
      const tile = this.tiles.get(tileKey(a.z, a.x, a.y));
      if (tile?.isReady) {
        out.push(this.piece(tile, wrap, subRect(a, region), 1, slotZ));
        this.fallbackCount++;
        return true;
      }
    }
    return false;
  }

  private hasReadyDescendant(t: TileCoord, levels: number): boolean {
    const tile = this.tiles.get(tileKey(t.z, t.x, t.y));
    if (tile?.isReady) return true;
    if (levels <= 0 || t.z + 1 > this.tiling.maxZoom) return false;
    for (const kid of childTiles(t)) if (this.hasReadyDescendant(kid, levels - 1)) return true;
    return false;
  }

  private piece(tile: Tile<D>, wrap: number, clip: Rect, opacity: number, slotZ: number): RenderPiece<D> {
    tile.retained = true;
    tile.lastUsed = this.frame;
    return { tile, wrap, clip, opacity, slotZ };
  }

  private dispatch(now: number): void {
    let waiting = false;
    for (const [key, handle] of this.jobs) {
      const tile = this.tiles.get(key);
      if (tile?.wanted && handle.state === "queued") waiting = true;
      if (!tile && handle.state === "queued") {
        this.scheduler.cancel(handle);
        this.jobs.delete(key);
      }
    }
    for (const tile of this.tiles.values()) {
      if (this.needsJob(tile) && tile.retryAt <= now) waiting = true;
    }
    for (const [key, handle] of this.jobs) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      if (!tile.wanted) {
        const keep = tile.state === "ready";
        if (handle.state === "queued") {
          this.scheduler.cancel(handle);
          this.jobs.delete(key);
          this.counters.aborted++;
          if (!keep) this.drop(tile);
        } else if (handle.state === "active" && tile.controller) {
          const lingering = now - tile.unwantedSince;
          if (lingering > LINGER_MS || (waiting && lingering > 150)) {
            tile.controller.abort(new DOMException("Tile no longer needed", "AbortError"));
            this.counters.aborted++;
            if (!keep) this.drop(tile);
          }
        }
      } else {
        handle.job.priority = tile.priority;
      }
    }
    if (now < this.pausedUntil) {
      this.events.wakeAt(this.pausedUntil);
      return;
    }
    let nextWake = Number.POSITIVE_INFINITY;
    for (const tile of this.tiles.values()) {
      if (!this.needsJob(tile)) continue;
      if (tile.retryAt > now) {
        nextWake = Math.min(nextWake, tile.retryAt);
        continue;
      }
      this.startJob(tile);
    }
    if (nextWake < Number.POSITIVE_INFINITY) this.events.wakeAt(nextWake);
  }

  private needsJob(tile: Tile<D>): boolean {
    if (!tile.wanted || this.jobs.has(tile.key)) return false;
    return tile.state === "queued" || (this.isOutdated(tile) && tile.next === null);
  }

  private isOutdated(tile: Tile<D>): boolean {
    return tile.state === "ready" && tile.generation < this.generation;
  }

  private startJob(tile: Tile<D>): void {
    const handle: JobHandle = this.scheduler.enqueue({
      group: this.id,
      priority: tile.priority,
      run: () => this.load(tile, handle),
    });
    this.jobs.set(tile.key, handle);
  }

  private release(tile: Tile<D>, handle: JobHandle | undefined): void {
    if (handle && this.jobs.get(tile.key) === handle) this.jobs.delete(tile.key);
  }

  private async load(tile: Tile<D>, handle: JobHandle | undefined): Promise<void> {
    const refreshing = this.isOutdated(tile);
    if (this.destroyed || (tile.state !== "queued" && !refreshing)) {
      this.release(tile, handle);
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    tile.controller = controller;
    tile.attempts++;
    tile.requestedAt = performance.now();
    if (!refreshing) tile.transition("fetching");
    this.counters.requested++;
    if (tile.attempts > 1) this.counters.retried++;
    try {
      const data = await this.loader.load(tile, controller.signal, () => {
        if (tile.state === "fetching") tile.transition("decoding");
      });
      if (controller.signal.aborted || tile.isEvicted || this.destroyed) {
        if (data) this.loader.release(data);
        return;
      }
      this.consecutiveFailures = 0;
      this.counters.completed++;
      tile.failure = null;
      tile.generation = generation;
      if (refreshing) {
        this.replace(tile, data);
      } else if (data === null) {
        tile.transition("empty");
      } else {
        tile.data = data;
        tile.bytes = this.loader.byteSize(data);
        tile.transition("prepared");
        if (!this.loader.needsUpload(data)) {
          tile.transition("ready");
          tile.readyAt = performance.now();
        }
      }
    } catch (error) {
      if (controller.signal.aborted || tile.isEvicted || this.destroyed) return;
      if (isAbortError(error)) {
        if (tile.isInFlight) tile.transition("queued");
        return;
      }
      const failure: TileFailure =
        error instanceof FetchFailure
          ? error.failure
          : { kind: "decode", message: error instanceof Error ? error.message : String(error), retryable: false };
      this.counters.failures++;
      this.consecutiveFailures++;
      tile.failure = failure;
      const now = performance.now();
      const retry = failure.retryable && tile.attempts <= this.options.maxRetries;
      if (refreshing) {
        tile.retryAt = now + (retry ? retryDelay(tile.attempts, failure) : this.options.failureCooldownMs);
      } else if (retry) {
        tile.transition("queued");
        tile.retryAt = now + retryDelay(tile.attempts, failure);
      } else {
        tile.transition("failed");
        tile.retryAt = now + this.options.failureCooldownMs;
      }
      if (this.consecutiveFailures >= BREAKER_THRESHOLD) {
        const level = Math.floor(this.consecutiveFailures / BREAKER_THRESHOLD);
        this.pausedUntil = now + Math.min(60000, 2000 * 2 ** (level - 1));
      }
      this.events.failure(failure, tile);
    } finally {
      if (tile.controller === controller) tile.controller = null;
      this.release(tile, handle);
      if (!this.destroyed) this.events.changed();
    }
  }

  private drop(tile: Tile<D>): void {
    const handle = this.jobs.get(tile.key);
    if (handle) {
      this.scheduler.cancel(handle);
      this.jobs.delete(tile.key);
    }
    if (tile.controller) {
      tile.controller.abort(new DOMException("Tile dropped", "AbortError"));
      tile.controller = null;
    }
    if (tile.data) {
      this.loader.release(tile.data);
      tile.data = null;
    }
    tile.bytes = 0;
    if (tile.state !== "evicted") tile.transition("evicted");
    this.tiles.delete(tile.key);
  }

  private evict(): void {
    let bytes = 0;
    for (const tile of this.tiles.values()) bytes += tile.bytes;
    const budget = this.options.cacheBytes;
    const maxEntries = 4096;
    if (bytes <= budget && this.tiles.size <= maxEntries) return;
    const candidates: Tile<D>[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.retained || tile.wanted || this.jobs.has(tile.key)) continue;
      candidates.push(tile);
    }
    candidates.sort((a, b) => a.lastUsed - b.lastUsed || b.z - a.z);
    for (const tile of candidates) {
      if (bytes <= budget && this.tiles.size <= maxEntries) break;
      bytes -= tile.bytes;
      this.drop(tile);
      this.counters.evicted++;
    }
  }
}

function slotArea(transform: Transform, z: number, x: number, y: number, wrap: number): number {
  const n = 2 ** z;
  const x0 = wrap + x / n,
    x1 = wrap + (x + 1) / n,
    y0 = y / n,
    y1 = (y + 1) / n;
  const a = transform.project(x0, y0);
  const b = transform.project(x1, y0);
  const c = transform.project(x1, y1);
  const d = transform.project(x0, y1);
  if (a.w <= 0 || b.w <= 0 || c.w <= 0 || d.w <= 0) return 0;
  const s = a.x * b.y - b.x * a.y + (b.x * c.y - c.x * b.y) + (c.x * d.y - d.x * c.y) + (d.x * a.y - a.x * d.y);
  return Math.abs(s) / 2;
}
