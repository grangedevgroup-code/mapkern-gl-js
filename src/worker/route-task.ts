import type { LngLatLike, Route, RouteOptions } from "../route/router.ts";
import { loadRouter, type Router } from "../route/router.ts";

export interface RouteRequest {
  url: string;
  points: LngLatLike[];
  options: RouteOptions;
}

const routers = new Map<string, Promise<Router>>();

function router(url: string): Promise<Router> {
  let loading = routers.get(url);
  if (!loading) {
    loading = loadRouter(url).catch((error: unknown) => {
      routers.delete(url);
      throw error;
    });
    routers.set(url, loading);
  }
  return loading;
}

export async function routeTask(request: RouteRequest): Promise<{ result: Route | null }> {
  const r = await router(request.url);
  return { result: r.route(request.points, request.options) };
}

export async function routeLoadTask(request: { url: string }): Promise<{ result: true }> {
  await router(request.url);
  return { result: true };
}
