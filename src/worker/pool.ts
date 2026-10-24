import { MapletError } from "../core/errors.ts";

export interface WorkerMessage {
  id: number;
  type: string;
  payload?: unknown;
}

export interface WorkerReply {
  id: number;
  result?: unknown;
  error?: { message: string; name?: string };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  worker: number;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

export type WorkerFactory = () => Worker;

export class WorkerPool {
  readonly size: number;
  private readonly factory: WorkerFactory | null;
  private readonly workers: (Worker | null)[];
  private readonly load: number[];
  private readonly pending = new Map<number, Pending>();
  private readonly broadcasts: WorkerMessage[] = [];
  private nextId = 1;
  private destroyed = false;
  private crashes = 0;

  constructor(size: number, factory: WorkerFactory | null) {
    this.size = Math.max(1, Math.floor(size));
    this.factory = factory;
    this.workers = new Array<Worker | null>(this.size).fill(null);
    this.load = new Array<number>(this.size).fill(0);
  }

  get available(): boolean {
    return this.factory !== null && !this.destroyed;
  }

  get queueDepth(): number {
    return this.pending.size;
  }

  broadcast(type: string, payload: unknown): void {
    if (this.destroyed) return;
    const message: WorkerMessage = { id: 0, type, payload };
    const index = this.broadcasts.findIndex((m) => m.type === type);
    if (index >= 0) this.broadcasts[index] = message;
    else this.broadcasts.push(message);
    for (const worker of this.workers) worker?.postMessage(message);
  }

  send<T>(type: string, payload: unknown, transfer: Transferable[] = [], signal?: AbortSignal, affinity?: number): Promise<T> {
    if (this.destroyed) return Promise.reject(new MapletError("worker", "The worker pool has been destroyed"));
    if (!this.factory) return Promise.reject(new MapletError("worker", "Web Workers are not available"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const index = affinity === undefined ? this.leastLoaded() : Math.abs(affinity) % this.size;
    const worker = this.worker(index);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        worker: index,
        signal,
        onAbort: undefined,
      };
      if (signal) {
        entry.onAbort = () => {
          if (!this.pending.has(id)) return;
          this.finish(id);
          worker.postMessage({ id, type: "cancel" } satisfies WorkerMessage);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.load[index] = (this.load[index] ?? 0) + 1;
      worker.postMessage({ id, type, payload } satisfies WorkerMessage, transfer);
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const [id, entry] of [...this.pending]) {
      this.finish(id);
      entry.reject(new MapletError("worker", "The worker pool has been destroyed"));
    }
    for (const worker of this.workers) worker?.terminate();
    this.workers.fill(null);
  }

  private leastLoaded(): number {
    let best = 0;
    for (let i = 1; i < this.size; i++) if (this.load[i]! < this.load[best]!) best = i;
    return best;
  }

  private worker(index: number): Worker {
    const existing = this.workers[index];
    if (existing) return existing;
    const worker = this.factory!();
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.reply(event.data);
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.crash(index, event.message || "Worker error");
    };
    worker.onmessageerror = () => this.crash(index, "Worker message could not be deserialized");
    for (const message of this.broadcasts) worker.postMessage(message);
    this.workers[index] = worker;
    return worker;
  }

  private reply(message: WorkerReply): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.finish(message.id);
    if (message.error) {
      const error = new MapletError("worker", message.error.message);
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  }

  private finish(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.load[entry.worker] = Math.max(0, (this.load[entry.worker] ?? 1) - 1);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }

  private crash(index: number, message: string): void {
    const worker = this.workers[index];
    worker?.terminate();
    this.workers[index] = null;
    this.crashes++;
    for (const [id, entry] of [...this.pending]) {
      if (entry.worker !== index) continue;
      this.finish(id);
      entry.reject(new MapletError("worker", `A map worker stopped: ${message}`, { crashes: this.crashes }));
    }
  }
}
