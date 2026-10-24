export interface Job {
  readonly group: string;
  priority: number;
  run(): Promise<void>;
}

export interface JobHandle {
  readonly job: Job;
  state: "queued" | "active" | "done" | "cancelled";
}

export class RequestScheduler {
  maxConcurrent: number;
  private readonly queued = new Set<JobHandle>();
  private readonly active = new Set<JobHandle>();
  private readonly running = new Map<string, number>();
  private readonly limits = new Map<string, number>();
  private pumpScheduled = false;
  private destroyed = false;

  constructor(maxConcurrent = 24) {
    this.maxConcurrent = maxConcurrent;
  }

  setGroupLimit(group: string, limit: number): void {
    this.limits.set(group, Math.max(1, Math.floor(limit)));
  }

  removeGroup(group: string): void {
    this.limits.delete(group);
    for (const handle of this.queued) {
      if (handle.job.group === group) {
        handle.state = "cancelled";
        this.queued.delete(handle);
      }
    }
  }

  enqueue(job: Job): JobHandle {
    const handle: JobHandle = { job, state: "queued" };
    if (this.destroyed) {
      handle.state = "cancelled";
      return handle;
    }
    this.queued.add(handle);
    this.schedulePump();
    return handle;
  }

  cancel(handle: JobHandle): void {
    if (handle.state !== "queued") return;
    handle.state = "cancelled";
    this.queued.delete(handle);
  }

  get queuedCount(): number {
    return this.queued.size;
  }

  get activeCount(): number {
    return this.active.size;
  }

  activeInGroup(group: string): number {
    return this.running.get(group) ?? 0;
  }

  queuedInGroup(group: string): number {
    let n = 0;
    for (const handle of this.queued) if (handle.job.group === group) n++;
    return n;
  }

  pump(): void {
    this.pumpScheduled = false;
    if (this.destroyed || this.queued.size === 0 || this.active.size >= this.maxConcurrent) return;
    const ordered = [...this.queued].sort((a, b) => a.job.priority - b.job.priority);
    for (const handle of ordered) {
      if (this.active.size >= this.maxConcurrent) break;
      const group = handle.job.group;
      const running = this.running.get(group) ?? 0;
      if (running >= (this.limits.get(group) ?? this.maxConcurrent)) continue;
      this.start(handle, group, running);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const handle of this.queued) handle.state = "cancelled";
    this.queued.clear();
  }

  private start(handle: JobHandle, group: string, running: number): void {
    this.queued.delete(handle);
    this.active.add(handle);
    this.running.set(group, running + 1);
    handle.state = "active";
    let promise: Promise<void>;
    try {
      promise = handle.job.run();
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise
      .catch(() => undefined)
      .finally(() => {
        handle.state = "done";
        this.active.delete(handle);
        const n = (this.running.get(group) ?? 1) - 1;
        if (n <= 0) this.running.delete(group);
        else this.running.set(group, n);
        this.schedulePump();
      });
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.destroyed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => this.pump());
  }
}
