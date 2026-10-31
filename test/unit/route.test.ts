import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRoute, encodeRoute } from "../../src/route/format.ts";
import { RouteGraph, type RouteProfile } from "../../src/route/graph.ts";
import { formatRef } from "../../src/route/guidance.ts";
import { Router } from "../../src/route/router.ts";
import type { RegionData } from "../../tools/tiles/extract.ts";
import type { Tags } from "../../tools/tiles/osm-pbf.ts";
import { buildRouteGraph } from "../../tools/tiles/route.ts";

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
}

function street(name: string, extra: Tags = {}): Tags {
  return { highway: "residential", name, ...extra };
}

function gridTown(n: number, tags: (kind: "h" | "v", i: number) => Tags = (k, i) => street(`${k}${i}`)): Town {
  const town = new Town();
  for (let i = 0; i < n; i++) {
    const row: [number, number][] = [];
    const col: [number, number][] = [];
    for (let j = 0; j < n; j++) {
      row.push([j * STEP, i * STEP]);
      col.push([i * STEP, j * STEP]);
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
