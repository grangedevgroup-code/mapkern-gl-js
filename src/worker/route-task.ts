import type { LngLatLike, Route, RouteOptions } from "../route/router.ts";
import { openRoutes, type RouteEngine } from "../route/service.ts";

export interface RouteRequest {
  url: string;
  points: LngLatLike[];
  options: RouteOptions;
}

const engines = new Map<string, Promise<RouteEngine>>();

function engine(url: string): Promise<RouteEngine> {
  let loading = engines.get(url);
  if (!loading) {
    loading = openRoutes(url).catch((error: unknown) => {
      engines.delete(url);
      throw error;
    });
    engines.set(url, loading);
  }
  return loading;
}

export async function routeTask(request: RouteRequest): Promise<{ result: Route | null }> {
  const e = await engine(request.url);
  return { result: await e.route(request.points, request.options) };
}

export async function routeLoadTask(request: { url: string }): Promise<{ result: true }> {
  await engine(request.url);
  return { result: true };
}
