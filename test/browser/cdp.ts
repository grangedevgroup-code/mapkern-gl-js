import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
}

type EventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export interface LaunchOptions {
  executable?: string;
  headless?: boolean;
  software?: boolean;
  args?: string[];
}

export function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(
      Boolean,
    ) as string[];
    for (const root of roots) {
      candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(join(root, "Chromium", "Application", "chrome.exe"));
      candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    const pw = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "";
    if (pw && existsSync(pw)) {
      for (const dir of readdirSync(pw)
        .filter((d) => d.startsWith("chromium-"))
        .sort()
        .reverse()) {
        candidates.push(join(pw, dir, "chrome-win", "chrome.exe"), join(pw, dir, "chrome-win64", "chrome.exe"));
      }
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    );
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

export class Browser {
  private readonly process: ChildProcess;
  private readonly socket: WebSocket;
  private readonly profile: string;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<EventHandler>>();

  private constructor(proc: ChildProcess, socket: WebSocket, profile: string) {
    this.process = proc;
    this.socket = socket;
    this.profile = profile;
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
  }

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const executable = options.executable ?? findChrome();
    if (!executable) throw new Error("Chrome or Chromium was not found. Set CHROME_PATH.");
    const profile = mkdtempSync(join(tmpdir(), "maplet-chrome-"));
    const args = [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      ...(options.software ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : []),
      ...(options.headless === false ? [] : ["--headless=new"]),
      ...(options.args ?? []),
      "about:blank",
    ];
    const proc = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 30000;
    let endpoint: string | null = null;
    while (Date.now() < deadline) {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        endpoint = m[1]!;
        break;
      }
      if (existsSync(portFile)) {
        const [portText, pathText] = readFileSync(portFile, "utf8").split(/\r?\n/);
        const port = Number(portText);
        if (
          Number.isInteger(port) &&
          port > 0 &&
          port < 65536 &&
          pathText &&
          /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(pathText)
        ) {
          endpoint = `ws://127.0.0.1:${port}/devtools/browser/${pathText.slice("/devtools/browser/".length)}`;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!endpoint) {
      proc.kill();
      throw new Error(`Chrome did not open a DevTools endpoint: ${stderr}`);
    }
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Chrome")), { once: true });
    });
    return new Browser(proc, socket, profile);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  async newPage(width: number, height: number, deviceScaleFactor = 1): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init(width, height, deviceScaleFactor);
    return page;
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.send("Browser.close"), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      this.process.kill();
    }
    this.socket.close();
    await new Promise((r) => setTimeout(r, 300));
    if (this.process.exitCode === null) this.process.kill();
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  private onMessage(text: string): void {
    const message = JSON.parse(text) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {}, message.sessionId);
    }
  }
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

export class Page {
  readonly console: ConsoleEntry[] = [];
  readonly errors: string[] = [];
  private readonly browser: Browser;
  private readonly sessionId: string;
  private readonly targetId: string;
  private readonly off: (() => void)[] = [];

  constructor(browser: Browser, sessionId: string, targetId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  async init(width: number, height: number, deviceScaleFactor: number): Promise<void> {
    this.off.push(
      this.browser.on("Runtime.consoleAPICalled", (params, sessionId) => {
        if (sessionId !== this.sessionId) return;
        const args = (params.args as { value?: unknown; description?: string }[]) ?? [];
        this.console.push({
          type: String(params.type),
          text: args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" "),
        });
      }),
      this.browser.on("Runtime.exceptionThrown", (params, sessionId) => {
        if (sessionId !== this.sessionId) return;
        const details = params.exceptionDetails as { exception?: { description?: string }; text?: string };
        this.errors.push(details.exception?.description ?? details.text ?? "exception");
      }),
    );
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async goto(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.browser.on("Page.loadEventFired", (_p, sessionId) => {
        if (sessionId !== this.sessionId) return;
        off();
        resolve();
      });
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed",
      );
    }
    return result.result.value as T;
  }

  async waitFor(expression: string, timeoutMs = 20000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  async screenshot(path: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  }

  async mouse(
    type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
    x: number,
    y: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  }

  async close(): Promise<void> {
    for (const off of this.off) off();
    await this.browser.send("Target.closeTarget", { targetId: this.targetId });
  }
}
