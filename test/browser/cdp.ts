import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

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
  private readonly input: Writable;
  private readonly profile: string;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private buffer = "";

  private constructor(proc: ChildProcess, profile: string) {
    this.process = proc;
    this.profile = profile;
    this.input = proc.stdio[3] as Writable;
    const output = proc.stdio[4] as Readable;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end = this.buffer.indexOf("\0");
      while (end >= 0) {
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (text) this.onMessage(text);
        end = this.buffer.indexOf("\0");
      }
    });
  }

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const executable = options.executable ?? findChrome();
    if (!executable) throw new Error("Chrome or Chromium was not found. Set CHROME_PATH.");
    removeStaleProfiles();
    const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    const args = [
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--do-not-de-elevate",
      "--disable-gpu-shader-disk-cache",
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
    const proc = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    const browser = new Browser(proc, profile);
    try {
      await Promise.race([
        browser.send("Browser.getVersion"),
        new Promise((_, reject) => {
          proc.once("exit", () => reject(new Error(`Chrome exited before it answered: ${stderr}`)));
          setTimeout(() => reject(new Error(`Chrome did not answer on its debugging pipe: ${stderr}`)), 30000);
        }),
      ]);
    } catch (error) {
      proc.kill();
      throw error;
    }
    return browser;
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
      this.input.write(`${JSON.stringify(message)}\0`);
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
    const exited =
      this.process.exitCode !== null || this.process.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
    const wait = (ms: number) => Promise.race([exited, new Promise((r) => setTimeout(r, ms))]);
    try {
      await Promise.race([this.send("Browser.close"), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      this.process.kill();
    }
    this.input.end();
    await wait(5000);
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
      await wait(3000);
    }
    for (let i = 0; i < 40; i++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
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

  async call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const scope = await this.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression: "globalThis" });
    const result = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.callFunctionOn", {
      functionDeclaration: fn,
      objectId: scope.result.objectId,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
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

const PROFILE_PREFIX = "maplet-chrome-";

function removeStaleProfiles(): void {
  const root = tmpdir();
  const old = Date.now() - 10 * 60 * 1000;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = join(root, name);
    try {
      if (statSync(path).mtimeMs < old) rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}
