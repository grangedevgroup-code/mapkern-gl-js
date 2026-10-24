import type { TileCoord } from "../geo/tile.ts";
import { tileKey } from "../geo/tile.ts";

export type TileState = "queued" | "fetching" | "decoding" | "prepared" | "ready" | "empty" | "failed" | "evicted";

export type FailureKind = "network" | "http" | "auth" | "rate-limit" | "timeout" | "decode";

export interface TileFailure {
  kind: FailureKind;
  status?: number;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

const TRANSITIONS: Readonly<Record<TileState, readonly TileState[]>> = {
  queued: ["fetching", "evicted"],
  fetching: ["decoding", "prepared", "empty", "failed", "queued", "evicted"],
  decoding: ["prepared", "empty", "failed", "queued", "evicted"],
  prepared: ["ready", "queued", "evicted"],
  ready: ["queued", "prepared", "empty", "evicted"],
  empty: ["queued", "evicted"],
  failed: ["queued", "evicted"],
  evicted: [],
};

export function canTransition(from: TileState, to: TileState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class Tile<D> implements TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly key: number;
  state: TileState = "queued";
  data: D | null = null;
  next: D | null = null;
  nextAt = 0;
  failure: TileFailure | null = null;
  attempts = 0;
  retryAt = 0;
  priority = Number.POSITIVE_INFINITY;
  wanted = false;
  unwantedSince = Number.NaN;
  retained = false;
  lastUsed = 0;
  readyAt = Number.NEGATIVE_INFINITY;
  requestedAt = 0;
  bytes = 0;
  generation = 0;
  revision = 0;
  controller: AbortController | null = null;

  constructor(z: number, x: number, y: number) {
    this.z = z;
    this.x = x;
    this.y = y;
    this.key = tileKey(z, x, y);
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  get isLoading(): boolean {
    return (
      this.state === "queued" || this.state === "fetching" || this.state === "decoding" || this.state === "prepared"
    );
  }

  get isInFlight(): boolean {
    return this.state === "fetching" || this.state === "decoding";
  }

  get isEvicted(): boolean {
    return this.state === "evicted";
  }

  get isSettled(): boolean {
    return this.state === "ready" || this.state === "empty" || this.state === "failed";
  }

  transition(next: TileState): void {
    if (this.state === next) return;
    if (!canTransition(this.state, next)) {
      throw new Error(`Invalid tile transition ${this.state} -> ${next} for ${this.z}/${this.x}/${this.y}`);
    }
    this.state = next;
  }
}
