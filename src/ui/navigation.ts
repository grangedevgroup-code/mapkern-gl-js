import type { MapkernMap, MapMoveEvent } from "../core/map.ts";
import { type NavigationFix, type NavigationState, Navigator } from "../route/navigator.ts";
import type { Route, RouteProfile } from "../route/router.ts";
import type { Directions } from "../route/service.ts";
import { Marker } from "./marker.ts";

export interface NavigationViewOptions {
  map: MapkernMap;
  directions: Directions;
  profile: RouteProfile;
  route: Route;
  destination: [number, number];
  demo?: number | false;
  voice?: boolean;
  units?: "metric" | "imperial";
  icon: (doc: Document, step: Route["legs"][number]["steps"][number]) => SVGSVGElement;
  onRoute: (route: Route) => void;
  onExit: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export class NavigationView {
  private readonly o: NavigationViewOptions;
  private navigator: Navigator;
  private readonly banner: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly puck: Marker;
  private frame = 0;
  private watch: number | null = null;
  private state: NavigationState | null = null;
  private shown = 0;
  private heading = 0;
  private lastFix: { along: number; time: number; speed: number } | null = null;
  private following = true;
  private voice: boolean;
  private rerouting = false;
  private demoAlong = 0;
  private demoClock = 0;
  private stopped = false;
  private readonly recenter: HTMLButtonElement;
  private readonly mute: HTMLButtonElement;

  constructor(options: NavigationViewOptions) {
    this.o = options;
    this.navigator = new Navigator(options.route, options.units ? { units: options.units } : {});
    this.voice = options.voice !== false && typeof speechSynthesis !== "undefined";
    const map = options.map;
    const doc = map.getContainer().ownerDocument;
    this.banner = doc.createElement("div");
    this.banner.className = "mapkern-control mapkern-nav-banner";
    this.banner.setAttribute("role", "status");
    this.banner.setAttribute("aria-live", "polite");
    this.footer = doc.createElement("div");
    this.footer.className = "mapkern-control mapkern-nav-footer";
    const info = doc.createElement("div");
    info.className = "mapkern-nav-info";
    const buttons = doc.createElement("div");
    buttons.className = "mapkern-nav-buttons";
    this.recenter = button(doc, map.text("recenter"), [
      "M12 3v3M12 18v3M3 12h3M18 12h3",
      "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z",
    ]);
    this.recenter.hidden = true;
    this.recenter.addEventListener("click", () => this.follow(true));
    this.mute = button(doc, "", []);
    this.mute.addEventListener("click", () => this.setVoice(!this.voice));
    const exit = button(doc, map.text("exitNavigation"), ["M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5"]);
    exit.classList.add("mapkern-nav-exit");
    exit.addEventListener("click", () => this.o.onExit());
    buttons.append(this.recenter, this.mute, exit);
    this.footer.append(info, buttons);
    map.getContainer().append(this.banner, this.footer);
    this.setVoice(this.voice);
    const puck = doc.createElement("div");
    puck.className = "mapkern-nav-puck";
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("aria-hidden", "true");
    const circle = doc.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "20");
    circle.setAttribute("cy", "20");
    circle.setAttribute("r", "17");
    const arrow = doc.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", "M20 8l9 21-9-5-9 5z");
    svg.append(circle, arrow);
    puck.appendChild(svg);
    this.puck = new Marker({
      element: puck,
      rotationAlignment: "map",
      pitchAlignment: "map",
      label: map.text("yourLocation"),
    });
    map.on("movestart", this.onMove);
    this.start();
  }

  destroy(): void {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
    this.o.map.off("movestart", this.onMove);
    this.puck.remove();
    this.banner.remove();
    this.footer.remove();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.o.map.jumpTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  }

  get current(): NavigationState | null {
    return this.state;
  }

  private start(): void {
    const first = this.navigator.update(this.fixAt(0, 0));
    this.state = first;
    this.heading = first.heading;
    this.render();
    this.puck.setLngLat(first.position).addTo(this.o.map);
    this.o.map.easeTo({
      center: first.position,
      bearing: first.heading,
      pitch: this.pitch(),
      zoom: this.zoom(0),
      padding: this.padding(),
      duration: 900,
    });
    if (this.o.demo) {
      this.demoClock = performance.now() + 900;
    } else if (typeof navigator !== "undefined" && navigator.geolocation) {
      this.watch = navigator.geolocation.watchPosition(
        (p) =>
          this.fix({
            lng: p.coords.longitude,
            lat: p.coords.latitude,
            heading: p.coords.heading,
            speed: p.coords.speed,
            accuracy: p.coords.accuracy,
            time: p.timestamp,
          }),
        () => this.notice(this.o.map.text("locationUnavailable")),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
      );
    }
    this.speakAll();
    const loop = (now: number) => {
      if (this.stopped) return;
      this.tick(now);
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  private fixAt(along: number, speed: number): NavigationFix {
    const p = this.navigator.pointAt(along);
    return {
      lng: p[0],
      lat: p[1],
      heading: this.navigator.headingAt(along),
      speed,
      accuracy: 5,
      time: performance.now(),
    };
  }

  private demoSpeed(): number {
    const nav = this.navigator;
    const state = this.state;
    const steps = nav.route.legs.flatMap((l) => l.steps);
    const step = steps[state?.step ?? 0];
    const base = step && step.duration > 0 ? step.distance / step.duration : 12;
    return base * (typeof this.o.demo === "number" ? this.o.demo : 1);
  }

  private tick(now: number): void {
    if (this.o.demo && now >= this.demoClock) {
      const dt = Math.min(0.1, (now - (this.demoTick || now)) / 1000);
      this.demoTick = now;
      const speed = this.demoSpeed();
      this.demoAlong = Math.min(this.navigator.totalDistance, this.demoAlong + speed * dt);
      if (now - this.lastDemoFix > 1000 || this.demoAlong >= this.navigator.totalDistance) {
        this.lastDemoFix = now;
        this.fix(this.fixAt(this.demoAlong, speed / (typeof this.o.demo === "number" ? this.o.demo : 1)));
      }
      this.shown = this.demoAlong;
    } else if (this.lastFix) {
      const ahead = this.lastFix.along + (this.lastFix.speed * (now - this.lastFix.time)) / 1000;
      const target = Math.min(ahead, this.lastFix.along + this.lastFix.speed * 1.5);
      this.shown += (Math.max(this.shown, target) - this.shown) * 0.2;
    }
    const position = this.navigator.pointAt(this.shown);
    const target = this.navigator.headingAt(this.shown);
    const delta = ((target - this.heading + 540) % 360) - 180;
    this.heading = (this.heading + delta * 0.12 + 360) % 360;
    this.puck.setLngLat(position);
    this.puck.setRotation(this.heading);
    if (this.following && now >= this.demoClock) {
      this.o.map.jumpTo({
        center: position,
        bearing: this.heading,
        pitch: this.pitch(),
        zoom: this.zoom(this.lastFix?.speed ?? 0),
        padding: this.padding(),
      });
    }
  }

  private demoTick = 0;
  private lastDemoFix = 0;

  private fix(fix: NavigationFix): void {
    if (this.stopped) return;
    const state = this.navigator.update(fix);
    this.state = state;
    this.lastFix = { along: state.along, time: performance.now(), speed: Math.max(0, fix.speed ?? 0) };
    this.render();
    this.speakAll(fix.speed ?? 0);
    if (state.offRoute && !this.rerouting && !state.arrived) void this.reroute(fix);
  }

  private async reroute(fix: NavigationFix): Promise<void> {
    this.rerouting = true;
    this.notice(this.o.map.text("rerouting"));
    this.say(this.o.map.text("rerouting"));
    try {
      const route = await this.o.directions.route([[fix.lng, fix.lat], this.o.destination], {
        profile: this.o.profile,
      });
      if (route && !this.stopped) {
        this.navigator = new Navigator(route, this.o.units ? { units: this.o.units } : {});
        this.shown = 0;
        this.demoAlong = 0;
        this.o.onRoute(route);
        this.fix(fix);
      }
    } catch {
    } finally {
      this.rerouting = false;
    }
  }

  private speakAll(speed = 0): void {
    if (!this.state) return;
    for (const a of this.navigator.announcements(this.state, speed)) this.say(a.text);
  }

  private say(text: string): void {
    if (!this.voice || typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined")
      return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.o.map.getContainer().ownerDocument.documentElement.lang || "en-US";
    speechSynthesis.speak(u);
  }

  private setVoice(on: boolean): void {
    this.voice = on && typeof speechSynthesis !== "undefined";
    if (!this.voice && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    const map = this.o.map;
    const label = map.text(this.voice ? "muteVoice" : "unmuteVoice");
    this.mute.title = label;
    this.mute.setAttribute("aria-label", label);
    this.mute.setAttribute("aria-pressed", String(!this.voice));
    const doc = this.mute.ownerDocument;
    this.mute.replaceChildren(
      icon(
        doc,
        this.voice
          ? ["M4 9v6h4l5 4V5L8 9z", "M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"]
          : ["M4 9v6h4l5 4V5L8 9z", "M16 9l5 6M21 9l-5 6"],
      ),
    );
  }

  private follow(on: boolean): void {
    this.following = on;
    this.recenter.hidden = on;
  }

  private readonly onMove = (event: MapMoveEvent) => {
    if (event.originalEvent) this.follow(false);
  };

  private pitch(): number {
    return this.o.profile === "car" ? 60 : 45;
  }

  private zoom(speed: number): number {
    if (this.o.profile === "foot") return 18;
    const s = Math.max(0, speed);
    return Math.max(15.5, Math.min(17.5, 17.5 - Math.max(0, s - 10) / 10));
  }

  private padding() {
    const h = this.o.map.getContainer().clientHeight;
    return { top: Math.round(h * 0.4), bottom: 0, left: 0, right: 0 };
  }

  private notice(text: string): void {
    const el = this.banner.querySelector(".mapkern-nav-instruction");
    if (el) el.textContent = text;
  }

  private render(): void {
    const state = this.state;
    if (!state) return;
    const map = this.o.map;
    const doc = this.banner.ownerDocument;
    const steps = this.navigator.route.legs.flatMap((l) => l.steps);
    const next = state.arrived ? steps[steps.length - 1]! : (state.nextStep ?? steps[steps.length - 1]!);
    const distance = doc.createElement("div");
    distance.className = "mapkern-nav-distance";
    distance.textContent = state.arrived ? "" : shortDistance(state.distanceToManeuver, this.o.units);
    const text = doc.createElement("div");
    text.className = "mapkern-nav-instruction";
    text.textContent = next.instruction;
    const glyph = this.o.icon(doc, next);
    glyph.classList.add("mapkern-nav-icon");
    const words = doc.createElement("div");
    words.className = "mapkern-nav-words";
    words.append(distance, text);
    this.banner.replaceChildren(glyph, words);
    const then = steps[state.step + 2];
    if (!state.arrived && then && state.distanceToManeuver < 300 && (next.distance ?? 0) < 150) {
      const t = doc.createElement("div");
      t.className = "mapkern-nav-then";
      t.textContent = `${map.text("thenNext")} ${then.instruction.charAt(0).toLowerCase()}${then.instruction.slice(1)}`;
      this.banner.appendChild(t);
    }
    const info = this.footer.querySelector(".mapkern-nav-info")!;
    const time = doc.createElement("strong");
    time.textContent = state.arrived ? map.text("arrived") : minutes(state.remainingDuration);
    const rest = doc.createElement("span");
    const eta = new Date(Date.now() + state.remainingDuration * 1000);
    rest.textContent = state.arrived
      ? ""
      : `${shortDistance(state.remainingDistance, this.o.units)} · ${eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    info.replaceChildren(time, rest);
  }
}

function minutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function shortDistance(m: number, units: "metric" | "imperial" = "metric"): string {
  if (units === "imperial") {
    const feet = m * 3.28084;
    if (feet < 1000) return `${Math.max(10, Math.round(feet / (feet < 300 ? 10 : 50)) * (feet < 300 ? 10 : 50))} ft`;
    const miles = m / 1609.344;
    return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
  }
  if (m < 1000) return `${Math.max(10, Math.round(m / (m < 300 ? 10 : 50)) * (m < 300 ? 10 : 50))} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function icon(doc: Document, paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function button(doc: Document, label: string, paths: string[]): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  if (label) {
    b.title = label;
    b.setAttribute("aria-label", label);
  }
  if (paths.length) b.appendChild(icon(doc, paths));
  return b;
}
