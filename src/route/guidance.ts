import { ROUNDABOUT } from "./format.ts";
import type { RouteGraph, RouteProfile } from "./graph.ts";
import type { PathPiece } from "./router.ts";

export type ManeuverType =
  | "depart"
  | "turn"
  | "new name"
  | "continue"
  | "fork"
  | "on ramp"
  | "off ramp"
  | "merge"
  | "roundabout"
  | "arrive";

export type ManeuverModifier =
  | "uturn"
  | "sharp right"
  | "right"
  | "slight right"
  | "straight"
  | "slight left"
  | "left"
  | "sharp left";

export interface RouteManeuver {
  type: ManeuverType;
  modifier?: ManeuverModifier;
  location: [number, number];
  bearingBefore: number;
  bearingAfter: number;
  exit?: number;
}

export interface RouteStep {
  distance: number;
  duration: number;
  name: string;
  ref: string;
  mode: RouteProfile;
  geometry: [number, number][];
  maneuver: RouteManeuver;
  instruction: string;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

export function modifierFor(delta: number): ManeuverModifier {
  const a = Math.abs(delta);
  if (a < 15) return "straight";
  if (a > 170) return "uturn";
  const side = delta > 0 ? "right" : "left";
  if (a < 45) return `slight ${side}`;
  if (a < 135) return side;
  return `sharp ${side}`;
}

function turnDelta(before: number, after: number): number {
  return ((after - before + 540) % 360) - 180;
}

function isLink(cls: string): boolean {
  return cls.endsWith("_link");
}

function isHighway(cls: string): boolean {
  return cls === "motorway" || cls === "trunk";
}

function roadLabel(name: string, ref: string): string {
  const r = formatRef(ref);
  if (name && r) return `${name} (${r})`;
  return name || r;
}

type StepText = Pick<RouteStep, "name" | "ref" | "maneuver">;

export function instructionFor(step: StepText, previous?: StepText): string {
  const m = step.maneuver;
  const road = roadLabel(step.name, step.ref);
  const stay = previous && road !== "" && road === roadLabel(previous.name, previous.ref);
  const onto = road ? ` onto ${road}` : "";
  const dir = m.modifier ?? "straight";
  switch (m.type) {
    case "depart":
      return road ? `Head ${compass(m.bearingAfter)} on ${road}` : `Head ${compass(m.bearingAfter)}`;
    case "arrive":
      return "You have arrived at your destination";
    case "roundabout": {
      const n = m.exit ?? 1;
      return `At the roundabout, take the ${ORDINALS[n - 1] ?? `${n}th`} exit${onto}`;
    }
    case "on ramp":
      return `Take the ramp${road ? ` to ${road}` : ""}`;
    case "off ramp":
      return `Take the exit${dir.includes("left") ? " on the left" : ""}${road ? ` toward ${road}` : ""}`;
    case "merge":
      return `Merge${onto}`;
    case "fork":
      return `Keep ${dir.includes("left") ? "left" : "right"}${road ? ` toward ${road}` : ""}`;
    case "new name":
    case "continue":
      return `Continue${onto}`;
    default:
      if (dir === "uturn") return `Make a U-turn${onto}`;
      if (dir === "straight") return `Continue straight${onto}`;
      return `Turn ${dir}${onto}`;
  }
}

function compass(bearing: number): string {
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return names[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

export function buildSteps(
  graph: RouteGraph,
  pieces: PathPiece[],
  profile: RouteProfile,
  _final: boolean,
): RouteStep[] {
  const steps: RouteStep[] = [];
  if (pieces.length === 0) return steps;
  const roundabout = (d: number) => (graph.data.edgeFlags[d >> 1]! & ROUNDABOUT) !== 0;
  const first = pieces[0]!;
  let current = open(graph, first, profile, {
    type: "depart",
    location: first.coords[0]!,
    bearingBefore: 0,
    bearingAfter: graph.startBearing[first.edge]!,
  });
  steps.push(current);
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1]!;
    const piece = pieces[i]!;
    const before = graph.endBearing[prev.edge]!;
    const after = graph.startBearing[piece.edge]!;
    const delta = turnDelta(before, after);
    const maneuver = classify(graph, prev.edge, piece.edge, delta, profile);
    if (roundabout(piece.edge) && !roundabout(prev.edge)) {
      let j = i;
      let exits = 0;
      while (j < pieces.length && roundabout(pieces[j]!.edge)) {
        if (j > i) exits += exitCount(graph, pieces[j - 1]!.edge, pieces[j]!.edge, profile, roundabout);
        j++;
      }
      const leaving = j < pieces.length ? pieces[j]! : pieces[j - 1]!;
      exits += j < pieces.length ? 1 : 0;
      current = open(graph, leaving, profile, {
        type: "roundabout",
        location: piece.coords[0]!,
        bearingBefore: before,
        bearingAfter: after,
        exit: Math.max(1, exits),
      });
      steps.push(current);
      for (let k = i; k < j; k++) add(current, pieces[k]!);
      if (j < pieces.length) add(current, pieces[j]!);
      i = j;
      continue;
    }
    if (maneuver) {
      current = open(graph, piece, profile, {
        type: maneuver.type,
        modifier: maneuver.modifier,
        location: piece.coords[0]!,
        bearingBefore: before,
        bearingAfter: after,
      });
      steps.push(current);
    }
    add(current, piece);
  }
  const lastPiece = pieces[pieces.length - 1]!;
  const end = lastPiece.coords[lastPiece.coords.length - 1]!;
  const arrive: RouteStep = {
    distance: 0,
    duration: 0,
    name: graph.name(lastPiece.edge >> 1),
    ref: graph.ref(lastPiece.edge >> 1),
    mode: profile,
    geometry: [end, end],
    maneuver: { type: "arrive", location: end, bearingBefore: graph.endBearing[lastPiece.edge]!, bearingAfter: 0 },
    instruction: "",
  };
  steps.push(arrive);
  const tidy = collapse(steps, profile);
  for (let i = 0; i < tidy.length; i++) tidy[i]!.instruction = instructionFor(tidy[i]!, tidy[i - 1]);
  return tidy;
}

const MIN_STEP: Record<RouteProfile, number> = { car: 12, bike: 15, foot: 25 };

function sameRoad(a: RouteStep, b: RouteStep): boolean {
  return (a.name !== "" || a.ref !== "") && a.name === b.name && a.ref === b.ref;
}

function merge(into: RouteStep, from: RouteStep): void {
  into.distance += from.distance;
  into.duration += from.duration;
  for (const c of from.geometry) {
    const last = into.geometry[into.geometry.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) into.geometry.push(c);
  }
}

function collapse(steps: RouteStep[], profile: RouteProfile): RouteStep[] {
  const out: RouteStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const prev = out[out.length - 1];
    const next = steps[i + 1];
    const type = step.maneuver.type;
    if (prev && next && type === "off ramp" && next.maneuver.type === "merge" && sameRoad(prev, next)) {
      const keep: RouteStep = { ...step, name: next.name, ref: next.ref };
      keep.maneuver = { ...step.maneuver, type: "fork", modifier: forkSide(step.maneuver.modifier) };
      merge(keep, next);
      out.push(keep);
      i++;
      continue;
    }
    const minor = type === "new name" || type === "turn" || type === "continue" || type === "fork";
    if (prev && next && minor && step.distance < MIN_STEP[profile] && next.maneuver.type !== "arrive") {
      merge(prev, step);
      continue;
    }
    if (prev && type === "new name" && sameRoad(prev, step)) {
      merge(prev, step);
      continue;
    }
    out.push(step);
  }
  return out;
}

function forkSide(modifier: ManeuverModifier | undefined): ManeuverModifier {
  return modifier?.includes("left") ? "slight left" : "slight right";
}

export function formatRef(ref: string): string {
  return ref
    .split(";")
    .map((r) => r.trim().replace(/^([A-Z]{1,4}) (\d+[A-Z]?)$/, "$1-$2"))
    .filter(Boolean)
    .join(" / ");
}

function open(graph: RouteGraph, piece: PathPiece, profile: RouteProfile, maneuver: RouteManeuver): RouteStep {
  const step: RouteStep = {
    distance: 0,
    duration: 0,
    name: graph.name(piece.edge >> 1),
    ref: graph.ref(piece.edge >> 1),
    mode: profile,
    geometry: [],
    maneuver,
    instruction: "",
  };
  if (maneuver.type === "depart") add(step, piece);
  return step;
}

function add(step: RouteStep, piece: PathPiece): void {
  step.distance += piece.length;
  step.duration += piece.seconds;
  for (const c of piece.coords) {
    const last = step.geometry[step.geometry.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) step.geometry.push(c);
  }
}

function options(graph: RouteGraph, from: number, profile: RouteProfile): number[] {
  const node = graph.head(from);
  const out: number[] = [];
  for (let i = graph.outStart[node]!; i < graph.outStart[node + 1]!; i++) {
    const d = graph.outList[i]!;
    if (d === (from ^ 1) || !graph.allowed(d, profile) || !graph.turnAllowed(from, d, profile)) continue;
    out.push(d);
  }
  return out;
}

function exitCount(
  graph: RouteGraph,
  from: number,
  to: number,
  profile: RouteProfile,
  roundabout: (d: number) => boolean,
): number {
  return options(graph, from, profile).filter((d) => d !== to && !roundabout(d)).length > 0 ? 1 : 0;
}

function classify(
  graph: RouteGraph,
  from: number,
  to: number,
  delta: number,
  profile: RouteProfile,
): { type: ManeuverType; modifier: ManeuverModifier } | null {
  const fromCls = graph.className(from >> 1);
  const toCls = graph.className(to >> 1);
  const modifier = modifierFor(delta);
  const others = options(graph, from, profile).filter((d) => d !== to);
  const sameRoad = graph.name(from >> 1) === graph.name(to >> 1) && graph.ref(from >> 1) === graph.ref(to >> 1);
  if (to === (from ^ 1)) return { type: "turn", modifier: "uturn" };
  if (isHighway(fromCls) && isLink(toCls)) return others.length > 0 ? { type: "off ramp", modifier } : null;
  if (!isHighway(fromCls) && !isLink(fromCls) && isLink(toCls) && toCls.startsWith("motorway")) {
    return { type: "on ramp", modifier };
  }
  if (isLink(fromCls) && isHighway(toCls)) return { type: "merge", modifier };
  if (others.length === 0) return sameRoad ? null : { type: "new name", modifier };
  const close = others.filter((d) => Math.abs(turnDelta(graph.endBearing[from]!, graph.startBearing[d]!)) < 45);
  if (Math.abs(delta) < 45 && others.length === 1 && close.length === 1 && (!sameRoad || Math.abs(delta) > 10)) {
    const alt = turnDelta(graph.endBearing[from]!, graph.startBearing[close[0]!]!);
    return { type: "fork", modifier: delta < alt ? "slight left" : "slight right" };
  }
  if (Math.abs(delta) >= 35) return { type: "turn", modifier };
  if (!sameRoad) return { type: "new name", modifier };
  return null;
}
