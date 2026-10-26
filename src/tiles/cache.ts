export interface StoredResponse {
  data: ArrayBuffer;
  type: string;
}

export type StoredState = "fresh" | "stale" | "missing" | "unknown";

export interface ResponseStore {
  state(url: string): StoredState;
  read(url: string): Promise<StoredResponse | null>;
  write(url: string, data: ArrayBuffer, type: string, expires: number): void;
}

interface HeaderSource {
  get(name: string): string | null;
}

export function freshUntil(headers: HeaderSource, now: number): number | null {
  const control = (headers.get("cache-control") ?? "").toLowerCase();
  if (/(?:^|,)\s*no-store\b/.test(control)) return null;
  if (/(?:^|,)\s*no-cache\b/.test(control)) return 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/.exec(control);
  if (maxAge) {
    const age = Number(headers.get("age")) || 0;
    return now + Math.max(0, Number(maxAge[1]) - age) * 1000;
  }
  const expires = headers.get("expires");
  if (expires) {
    const time = Date.parse(expires);
    return Number.isNaN(time) ? 0 : time;
  }
  return 0;
}

export function cacheable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, typeof location === "undefined" ? undefined : location.href);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost"));
}

export function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

const DOWN_MS = 30000;
const down = new Map<string, number>();

function origin(url: string): string {
  try {
    return new URL(url, typeof location === "undefined" ? undefined : location.href).origin;
  } catch {
    return "";
  }
}

export function serverDown(url: string, now = Date.now()): boolean {
  const until = down.get(origin(url));
  return until !== undefined && until > now;
}

export function markServer(url: string, ok: boolean, now = Date.now()): void {
  const key = origin(url);
  if (ok) down.delete(key);
  else down.set(key, now + DOWN_MS);
}

interface IndexRow {
  url: string;
  size: number;
  used: number;
  expires: number;
}

interface Pending {
  url: string;
  data: ArrayBuffer;
  type: string;
  expires: number;
}

const DB_NAME = "mapkern-cache";
const DATA = "data";
const INDEX = "index";
const FLUSH_MS = 400;
const TOUCH_MS = 60 * 60 * 1000;

export class DiskCache implements ResponseStore {
  maxBytes: number;
  private db: IDBDatabase | null = null;
  private readonly entries = new Map<string, IndexRow>();
  private total = 0;
  private loaded = false;
  private broken = false;
  private readonly pending = new Map<string, Pending>();
  private readonly touched = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reads = new Map<string, ((value: StoredResponse | null) => void)[]>();
  private readScheduled = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
    this.open();
  }

  state(url: string): StoredState {
    const now = Date.now();
    const queued = this.pending.get(url);
    if (queued) return queued.expires > now ? "fresh" : "stale";
    if (this.broken) return "missing";
    if (!this.loaded) return "unknown";
    const row = this.entries.get(url);
    if (!row) return "missing";
    return row.expires > now ? "fresh" : "stale";
  }

  read(url: string): Promise<StoredResponse | null> {
    const queued = this.pending.get(url);
    if (queued) return Promise.resolve({ data: queued.data.slice(0), type: queued.type });
    if (this.broken) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiting = this.reads.get(url);
      if (waiting) waiting.push(resolve);
      else this.reads.set(url, [resolve]);
      if (!this.readScheduled) {
        this.readScheduled = true;
        setTimeout(() => this.flushReads(), 0);
      }
    });
  }

  write(url: string, data: ArrayBuffer, type: string, expires: number): void {
    if (this.broken || data.byteLength > this.maxBytes / 8) return;
    this.pending.set(url, { url, data, type, expires });
    this.schedule();
  }

  clear(): Promise<void> {
    this.pending.clear();
    this.touched.clear();
    this.entries.clear();
    this.total = 0;
    const db = this.db;
    if (!db) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([DATA, INDEX], "readwrite");
        tx.objectStore(DATA).clear();
        tx.objectStore(INDEX).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  private open(): void {
    if (typeof indexedDB === "undefined") {
      this.broken = true;
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      this.broken = true;
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
      if (!db.objectStoreNames.contains(INDEX)) {
        db.createObjectStore(INDEX, { keyPath: "url" }).createIndex("used", "used");
      }
    };
    request.onerror = () => {
      this.broken = true;
      this.failReads();
    };
    request.onblocked = () => {
      this.broken = true;
      this.failReads();
    };
    request.onsuccess = () => {
      const db = request.result;
      this.db = db;
      db.onversionchange = () => {
        db.close();
        this.db = null;
        this.broken = true;
      };
      try {
        const rows = db.transaction(INDEX, "readonly").objectStore(INDEX).getAll();
        rows.onsuccess = () => {
          for (const row of rows.result as IndexRow[]) {
            this.entries.set(row.url, row);
            this.total += row.size;
          }
          this.loaded = true;
        };
        rows.onerror = () => {
          this.loaded = true;
        };
      } catch {
        this.broken = true;
      }
      if (this.reads.size > 0) this.flushReads();
    };
  }

  private failReads(): void {
    const reads = this.reads;
    this.reads = new Map();
    this.readScheduled = false;
    for (const list of reads.values()) for (const resolve of list) resolve(null);
  }

  private flushReads(): void {
    this.readScheduled = false;
    const db = this.db;
    if (!db) {
      if (this.broken) this.failReads();
      return;
    }
    const reads = this.reads;
    this.reads = new Map();
    const done = (url: string, value: StoredResponse | null) => {
      for (const resolve of reads.get(url) ?? []) resolve(value);
      reads.delete(url);
    };
    let tx: IDBTransaction;
    try {
      tx = db.transaction(DATA, "readonly");
    } catch {
      for (const url of [...reads.keys()]) done(url, null);
      return;
    }
    const store = tx.objectStore(DATA);
    for (const url of [...reads.keys()]) {
      const request = store.get(url);
      request.onsuccess = () => {
        const value = request.result as StoredResponse | undefined;
        done(url, value ? { data: value.data, type: value.type } : null);
        if (value) this.touch(url);
      };
      request.onerror = () => done(url, null);
    }
    tx.onabort = () => {
      for (const url of [...reads.keys()]) done(url, null);
    };
  }

  private touch(url: string): void {
    const row = this.entries.get(url);
    if (!row || Date.now() - row.used < TOUCH_MS) return;
    row.used = Date.now();
    this.touched.add(url);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushWrites();
    }, FLUSH_MS);
  }

  private flushWrites(): void {
    const db = this.db;
    if (!db) {
      if (!this.broken) this.schedule();
      return;
    }
    const writes = [...this.pending.values()];
    const touched = [...this.touched];
    this.touched.clear();
    if (writes.length === 0 && touched.length === 0) return;
    const now = Date.now();
    let tx: IDBTransaction;
    try {
      tx = db.transaction([DATA, INDEX], "readwrite", { durability: "relaxed" });
    } catch {
      return;
    }
    const data = tx.objectStore(DATA);
    const index = tx.objectStore(INDEX);
    for (const w of writes) {
      const row: IndexRow = { url: w.url, size: w.data.byteLength, used: now, expires: w.expires };
      const old = this.entries.get(w.url);
      this.total += row.size - (old?.size ?? 0);
      this.entries.set(w.url, row);
      data.put({ data: w.data, type: w.type }, w.url);
      index.put(row);
    }
    for (const url of touched) {
      const row = this.entries.get(url);
      if (row) index.put(row);
    }
    if (this.total > this.maxBytes) {
      const target = this.maxBytes * 0.9;
      const oldest = [...this.entries.values()].sort((a, b) => a.used - b.used);
      for (const row of oldest) {
        if (this.total <= target) break;
        this.entries.delete(row.url);
        this.total -= row.size;
        data.delete(row.url);
        index.delete(row.url);
      }
    }
    tx.oncomplete = () => {
      for (const w of writes) if (this.pending.get(w.url) === w) this.pending.delete(w.url);
    };
    tx.onabort = () => {
      for (const w of writes) {
        if (this.pending.get(w.url) === w) this.pending.delete(w.url);
        const row = this.entries.get(w.url);
        if (row) {
          this.entries.delete(w.url);
          this.total -= row.size;
        }
      }
    };
  }
}

let shared: DiskCache | null | undefined;

export function sharedDiskCache(maxBytes: number): DiskCache | null {
  if (shared === undefined) shared = typeof indexedDB === "undefined" ? null : new DiskCache(maxBytes);
  else if (shared && maxBytes > shared.maxBytes) shared.maxBytes = maxBytes;
  return shared;
}

export function clearDiskCache(): Promise<void> {
  if (shared) return shared.clear();
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
