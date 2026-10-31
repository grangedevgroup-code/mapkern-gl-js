import { workerFactory } from "../worker/factory.ts";
import { WorkerPool } from "../worker/pool.ts";
import type { RouteRequest } from "../worker/route-task.ts";
import type { LngLatLike, Route, RouteOptions } from "./router.ts";
import { loadRouter } from "./router.ts";
import { TiledRouter } from "./tiled.ts";

export interface RouteEngine {
  route(points: LngLatLike[], options: RouteOptions): Route | null | Promise<Route | null>;
}

export async function openRoutes(url: string): Promise<RouteEngine> {
  if (/[.](route[.]json|json|mkroute)([?#]|$)/.test(url)) return TiledRouter.open(url);
  return loadRouter(url);
}

export interface RouterServiceOptions {
  workerUrl?: string;
}

export interface Directions {
  route(points: LngLatLike[], options?: RouteOptions & { signal?: AbortSignal }): Promise<Route | null>;
}

export class RouterService implements Directions {
  readonly url: string;
  private pool: WorkerPool | null = null;
  private local: Promise<RouteEngine> | null = null;
  private readonly workerUrl: string | undefined;

  constructor(url: string, options: RouterServiceOptions = {}) {
    this.url = new URL(url, globalThis.location?.href).href;
    this.workerUrl = options.workerUrl;
  }

  preload(): Promise<void> {
    const pool = this.workers();
    if (pool) return pool.send<boolean>("route-load", { url: this.url }).then(() => undefined);
    return this.inline().then(() => undefined);
  }

  async route(points: LngLatLike[], options: RouteOptions & { signal?: AbortSignal } = {}): Promise<Route | null> {
    const { signal, ...rest } = options;
    const plain = points.map((p): [number, number] => (Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat]));
    const pool = this.workers();
    if (pool) {
      const request: RouteRequest = { url: this.url, points: plain, options: rest };
      return pool.send<Route | null>("route", request, [], signal);
    }
    const router = await this.inline();
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return router.route(plain, rest);
  }

  destroy(): void {
    this.pool?.destroy();
    this.pool = null;
  }

  private workers(): WorkerPool | null {
    if (this.pool) return this.pool;
    const factory = workerFactory(this.workerUrl);
    if (!factory) return null;
    this.pool = new WorkerPool(1, factory);
    return this.pool;
  }

  private inline(): Promise<RouteEngine> {
    this.local ??= openRoutes(this.url).catch((error: unknown) => {
      this.local = null;
      throw error;
    });
    return this.local;
  }
}
