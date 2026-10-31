import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRoute, encodeRoute } from "../../src/route/format.ts";
import { RouteGraph, type RouteProfile } from "../../src/route/graph.ts";
import { formatRef } from "../../src/route/guidance.ts";
import { type NavigationAnnouncement, Navigator, simulateFixes, spokenDistance } from "../../src/route/navigator.ts";
import { Router } from "../../src/route/router.ts";
import { TiledRouter } from "../../src/route/tiled.ts";
import type { RegionData } from "../../tools/tiles/extract.ts";
import type { Tags } from "../../tools/tiles/osm-pbf.ts";
import { buildRouteGraph } from "../../tools/tiles/route.ts";
import { buildRouteTiles, splitArchive, writeArchive } from "../../tools/tiles/route-tiles.ts";

const STEP = 0.001;

class Town {
  nodes: [number, number, number][] = [];
  ways: { id: number; refs: number[]; tags: Tags }[] = [];
  relations: RegionData["relations"] = [];
  private grid = new Map<string, number>();
  private nextWay = 1;

  node(x: number, y: number): number {
    const key = `${x},${y}`;
    let id = this.grid.get(key);
    if (id === undefined) {
      id = this.nodes.length + 1;
      this.grid.set(key, id);
      this.nodes.push([id, Math.round(x * 1e7), Math.round(y * 1e7)]);
    }
    return id;
  }

  way(points: [number, number][], tags: Tags): number {
    const id = this.nextWay++;
    this.ways.push({ id, refs: points.map(([x, y]) => this.node(x, y)), tags });
    return id;
  }

  restrict(from: number, via: [number, number], to: number, kind: string): void {
    const node = this.node(via[0], via[1]);
    this.relations.push({
      id: this.relations.length + 1,
      tags: { type: "restriction", restriction: kind, "@via": String(node) },
      members: [
        { type: 1, ref: from, role: "from" },
        { type: 0, ref: node, role: "via" },
        { type: 1, ref: to, role: "to" },
      ],
    });
  }

  region(): RegionData {
    const nodes = this.nodes.slice().sort((a, b) => a[0] - b[0]);
    const offsets = [0];
    const refs: number[] = [];
    for (const w of this.ways) {
      refs.push(...w.refs);
      offsets.push(refs.length);
    }
    return {
      bbox: [-0.01, -0.01, 0.02, 0.02],
      warnings: [],
      nodeIds: Float64Array.from(nodes.map((n) => n[0])),
      nodeLon: Int32Array.from(nodes.map((n) => n[1])),
      nodeLat: Int32Array.from(nodes.map((n) => n[2])),
      points: [],
      wayIds: Float64Array.from(this.ways.map((w) => w.id)),
      wayOffsets: Uint32Array.from(offsets),
      wayRefs: Float64Array.from(refs),
      wayTags: this.ways.map((w) => w.tags),
      relations: this.relations,
    };
  }

  router(): Router {
    return new Router(new RouteGraph(decodeRoute(encodeRoute(buildRouteGraph(this.region()).data))));
  }

  data() {
    return buildRouteGraph(this.region()).data;
  }
}

function street(name: string, extra: Tags = {}): Tags {
  return { highway: "residential", name, ...extra };
}

function gridTown(
  n: number,
  tags: (kind: "h" | "v", i: number) => Tags = (k, i) => street(`${k}${i}`),
  step = STEP,
): Town {
  const town = new Town();
  for (let i = 0; i < n; i++) {
    const row: [number, number][] = [];
    const col: [number, number][] = [];
    for (let j = 0; j < n; j++) {
      row.push([j * step, i * step]);
      col.push([i * step, j * step]);
    }
    town.way(row, tags("h", i));
    town.way(col, tags("v", i));
  }
  return town;
}

test("a car route on a street grid follows the streets corner to corner", () => {
  const router = gridTown(5).router();
  const r = router.route(
    [
      [0, 0],
      [4 * STEP, 4 * STEP],
    ],
    { profile: "car" },
  );
  assert.ok(r);
  const manhattan = 8 * STEP * 111195;
  assert.ok(Math.abs(r.distance - manhattan) < manhattan * 0.02, `distance ${r.distance} vs ${manhattan}`);
  const steps = r.legs[0]!.steps;
  assert.equal(steps[0]!.maneuver.type, "depart");
  assert.equal(steps[steps.length - 1]!.maneuver.type, "arrive");
  assert.deepEqual(r.geometry[0], [0, 0]);
});

test("cars keep to oneway streets but people on foot do not", () => {
  const town = gridTown(3, (k, i) => (k === "h" && i === 0 ? street("Main", { oneway: "yes" }) : street(`${k}${i}`)));
  const router = town.router();
  const back = router.route(
    [
      [2 * STEP, 0],
      [0, 0],
    ],
    { profile: "car" },
  );
  assert.ok(back);
  assert.ok(back.distance > 3 * STEP * 111195, `car went the wrong way down Main: ${back.distance}`);
  const walk = router.route(
    [
      [2 * STEP, 0],
      [0, 0],
    ],
    { profile: "foot" },
  );
  assert.ok(walk);
  assert.ok(walk.distance < 2.1 * STEP * 111195);
});

test("a no-left-turn restriction makes the route go around", () => {
  const town = new Town();
  const south = town.way(
    [
      [STEP, 0],
      [STEP, STEP],
    ],
    street("South"),
  );
  const west = town.way(
    [
      [STEP, STEP],
      [0, STEP],
    ],
    street("West"),
  );
  town.way(
    [
      [STEP, STEP],
      [STEP, 2 * STEP],
      [0, 2 * STEP],
      [0, STEP],
    ],
    street("Loop"),
  );
  const open = town.router();
  const turn = open.route(
    [
      [STEP, 0],
      [0, STEP],
    ],
    { profile: "car" },
  );
  assert.ok(turn);
  assert.ok(turn.distance < 2.1 * STEP * 111195);
  assert.equal(turn.legs[0]!.steps[1]!.instruction, "Turn left onto West");
  town.restrict(south, [STEP, STEP], west, "no_left_turn");
  const around = town.router().route(
    [
      [STEP, 0],
      [0, STEP],
    ],
    { profile: "car" },
  );
  assert.ok(around);
  assert.ok(around.distance > 3.5 * STEP * 111195, `restriction ignored: ${around.distance}`);
});

test("a roundabout counts the exits it passes", () => {
  const town = new Town();
  const c: [number, number] = [5 * STEP, 5 * STEP];
  const r = STEP;
  const ring: [number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 + (i / 16) * 2 * Math.PI;
    ring.push([c[0] + r * Math.cos(-a), c[1] + r * Math.sin(-a)]);
  }
  ring[16] = ring[0]!;
  town.way(ring, { highway: "tertiary", junction: "roundabout", name: "Circle" });
  const arm = (i: number, name: string) => {
    const p = ring[i]!;
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    town.way([p, [c[0] + dx * 4, c[1] + dy * 4]], street(name));
  };
  arm(0, "North Arm");
  arm(4, "East Arm");
  arm(8, "South Arm");
  arm(12, "West Arm");
  const router = town.router();
  const route = router.route(
    [
      [c[0], c[1] - 3 * r],
      [c[0], c[1] + 3 * r],
    ],
    { profile: "car" },
  );
  assert.ok(route);
  const step = route.legs[0]!.steps.find((s) => s.maneuver.type === "roundabout");
  assert.ok(step, JSON.stringify(route.legs[0]!.steps.map((s) => s.instruction)));
  assert.equal(step.instruction, "At the roundabout, take the second exit onto North Arm");
});

function reference(router: Router, from: number, to: number, profile: RouteProfile): number {
  const g = router.graph;
  const costs = g.edgeCosts(profile);
  const dist = new Map<number, number>();
  const queue: [number, number][] = [];
  for (let i = g.outStart[from]!; i < g.outStart[from + 1]!; i++) {
    const d = g.outList[i]!;
    if (!g.allowed(d, profile)) continue;
    dist.set(d, costs[d >> 1]!);
    queue.push([costs[d >> 1]!, d]);
  }
  let best = Infinity;
  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0]);
    const [cost, d] = queue.shift()!;
    if (cost > (dist.get(d) ?? Infinity)) continue;
    if (g.head(d) === to) best = Math.min(best, cost);
    for (let i = g.outStart[g.head(d)]!; i < g.outStart[g.head(d) + 1]!; i++) {
      const next = g.outList[i]!;
      if (!g.allowed(next, profile)) continue;
      if (next === (d ^ 1) && !g.uTurnAllowed(d, profile)) continue;
      if (!g.turnAllowed(d, next, profile)) continue;
      const c = cost + g.turnCost(d, next, profile) + costs[next >> 1]!;
      if (c < (dist.get(next) ?? Infinity)) {
        dist.set(next, c);
        queue.push([c, next]);
      }
    }
  }
  return best;
}

test("the router finds the same cheapest time as a plain search on random towns", () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const kinds = ["primary", "secondary", "residential", "service", "tertiary"];
  for (let round = 0; round < 12; round++) {
    const town = gridTown(6, (k, i) => {
      const tags: Tags = { highway: kinds[Math.floor(rand() * kinds.length)]!, name: `${k}${i}` };
      if (rand() < 0.3) tags.oneway = rand() < 0.5 ? "yes" : "-1";
      return tags;
    });
    const router = town.router();
    const g = router.graph;
    for (let trial = 0; trial < 6; trial++) {
      const a = [Math.floor(rand() * 6) * STEP, Math.floor(rand() * 6) * STEP] as [number, number];
      const b = [Math.floor(rand() * 6) * STEP, Math.floor(rand() * 6) * STEP] as [number, number];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const route = router.route([a, b], { profile: "car" });
      const nodeAt = (p: [number, number]) => {
        for (let n = 0; n < g.nodes; n++) {
          if (g.data.nodeLon[n] === Math.round(p[0] * 1e7) && g.data.nodeLat[n] === Math.round(p[1] * 1e7)) return n;
        }
        return -1;
      };
      const expected = reference(router, nodeAt(a), nodeAt(b), "car");
      if (!Number.isFinite(expected)) continue;
      assert.ok(route, `no route ${a} -> ${b} though one exists`);
      assert.ok(
        Math.abs(route.duration - expected) < 1e-3,
        `round ${round}: router ${route.duration.toFixed(3)} s differs from the best ${expected.toFixed(3)} s`,
      );
    }
  }
});

test("route refs read the way road signs write them", () => {
  assert.equal(formatRef("I 5"), "I-5");
  assert.equal(formatRef("US 101;SR 8"), "US-101 / SR-8");
  assert.equal(formatRef("A1"), "A1");
});

test("a simulated drive hears every turn before it, stays on route and arrives", () => {
  const router = gridTown(6).router();
  const route = router.route(
    [
      [0, 0],
      [5 * STEP, 3 * STEP],
    ],
    { profile: "car" },
  );
  assert.ok(route);
  const nav = new Navigator(route);
  const heard: NavigationAnnouncement[] = [];
  let state = null as ReturnType<Navigator["update"]> | null;
  let lastStep = 0;
  for (const fix of simulateFixes(nav, () => 12, 2)) {
    state = nav.update(fix);
    assert.equal(state.offRoute, false, `off route at ${state.along.toFixed(0)} m`);
    assert.ok(state.step >= lastStep, "steps went backwards");
    lastStep = state.step;
    for (const a of nav.announcements(state, fix.speed ?? 0)) {
      if (a.stage !== "start") assert.ok(a.step > state.step || state.arrived, `${a.text} came after the turn`);
      heard.push(a);
    }
  }
  assert.ok(state?.arrived, "never arrived");
  const turns = route.legs[0]!.steps.filter((s) => s.maneuver.type === "turn").length;
  const spokenTurns = new Set(heard.filter((a) => a.stage === "now").map((a) => a.step)).size;
  assert.ok(spokenTurns >= turns, `heard ${spokenTurns} maneuvers for ${turns} turns`);
  assert.equal(heard[heard.length - 1]!.text, "You have arrived at your destination");
});

test("driving away from the route is noticed on the second fix", () => {
  const router = gridTown(4).router();
  const route = router.route(
    [
      [0, 0],
      [3 * STEP, 0],
    ],
    { profile: "car" },
  );
  assert.ok(route);
  const nav = new Navigator(route);
  assert.equal(nav.update({ lng: STEP, lat: 0, speed: 10, accuracy: 5 }).offRoute, false);
  assert.equal(nav.update({ lng: STEP, lat: 0.0015, speed: 10, accuracy: 5 }).offRoute, false);
  assert.equal(nav.update({ lng: STEP, lat: 0.0016, speed: 10, accuracy: 5 }).offRoute, true);
});

test("spoken distances round the way people say them", () => {
  assert.equal(spokenDistance(430), "450 meters");
  assert.equal(spokenDistance(1460), "1.5 kilometers");
  assert.equal(spokenDistance(160, "imperial"), "500 feet");
  assert.equal(spokenDistance(800, "imperial"), "half a mile");
});

const WIDE = 0.01;

function widetown(): Town {
  return gridTown(
    9,
    (k, i) => {
      if (i % 4 === 0) return { highway: "primary", name: `${k} Highway ${i}` };
      return { highway: "residential", name: `${k} Street ${i}`, ...(i % 3 === 1 ? { oneway: "yes" } : {}) };
    },
    WIDE,
  );
}

function trips(count: number): [number, number][][] {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: [number, number][][] = [];
  while (out.length < count) {
    const a: [number, number] = [Math.floor(rand() * 9) * WIDE, Math.floor(rand() * 9) * WIDE];
    const b: [number, number] = [Math.floor(rand() * 9) * WIDE, Math.floor(rand() * 9) * WIDE];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([a, b]);
  }
  return out;
}

test("route tiles split a graph into many small tiles and route exactly like the whole graph", async () => {
  const town = widetown();
  const data = town.data();
  const build = buildRouteTiles(data, { tileEdges: 40 });
  assert.ok(build.detail.length >= 4, `only ${build.detail.length} tiles`);
  assert.ok(build.overview.length >= 1, "no highway layer");
  const bytes = writeArchive(build.meta, build.detail, build.overview);
  const full = new Router(new RouteGraph(data));
  for (const profile of ["car", "foot"] as const) {
    for (const pts of trips(12)) {
      const expected = full.route(pts, { profile });
      const tiled = await TiledRouter.open(bytes);
      tiled.longRoute = Number.POSITIVE_INFINITY;
      const got = await tiled.route(pts, { profile });
      assert.equal(Boolean(got), Boolean(expected), `${profile} ${JSON.stringify(pts)}`);
      if (got && expected) {
        assert.ok(
          Math.abs(got.duration - expected.duration) < 1e-3 * expected.duration + 0.01,
          `${profile} ${JSON.stringify(pts)}: tiled ${got.duration} vs ${expected.duration}`,
        );
      }
    }
  }
});

test("long car routes use the highway layer away from both ends and stay close to the best time", async () => {
  const town = widetown();
  const data = town.data();
  const build = buildRouteTiles(data, { tileEdges: 40 });
  const bytes = writeArchive(build.meta, build.detail, build.overview);
  const full = new Router(new RouteGraph(data));
  const pts: [number, number][] = [
    [0, 0],
    [8 * WIDE, 8 * WIDE],
  ];
  const expected = full.route(pts, { profile: "car" });
  assert.ok(expected);
  const tiled = await TiledRouter.open(bytes);
  tiled.near = 1500;
  tiled.longRoute = 3000;
  const got = await tiled.route(pts, { profile: "car" });
  assert.ok(got, "no route with the highway layer");
  assert.ok(got.duration >= expected.duration - 1e-3, "faster than the best route is impossible");
  assert.ok(got.duration <= expected.duration * 1.3, `${got.duration} is far slower than ${expected.duration}`);
  assert.ok(tiled.tilesLoaded < build.detail.length, `loaded every detail tile (${tiled.tilesLoaded})`);
});

test("a route set split into parts behind a manifest routes the same as one file", async () => {
  const town = widetown();
  const build = buildRouteTiles(town.data(), { tileEdges: 40 });
  const single = writeArchive(build.meta, build.detail, build.overview);
  const { manifest, files } = splitArchive(build, "town", 1200);
  assert.ok(files.length >= 3, `only ${files.length} parts`);
  const served = new Map(files.map((f) => [`https://example.test/routes/${f.file}`, f.bytes]));
  served.set("https://example.test/routes/town.route.json", new TextEncoder().encode(JSON.stringify(manifest)));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = served.get(url);
    if (!body) return new Response(null, { status: 404 });
    const range = new Headers(init?.headers).get("range");
    const m = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
    if (!m) return new Response(body as unknown as BodyInit, { status: 200 });
    const part = body.slice(Number(m[1]), Number(m[2]) + 1);
    return new Response(part as unknown as BodyInit, {
      status: 206,
      headers: { "content-range": `bytes ${m[1]}-${m[2]}/${body.length}` },
    });
  }) as typeof fetch;
  try {
    for (const pts of trips(8)) {
      const a = await (await TiledRouter.open(single)).route(pts, { profile: "car" });
      const b = await (await TiledRouter.open("https://example.test/routes/town.route.json")).route(pts, {
        profile: "car",
      });
      assert.equal(b?.duration, a?.duration, JSON.stringify(pts));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
