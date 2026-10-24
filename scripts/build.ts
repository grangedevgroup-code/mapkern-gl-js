import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

export interface BuildOptions {
  types?: boolean;
  quiet?: boolean;
}

export async function buildAll(options: BuildOptions = {}): Promise<void> {
  const started = performance.now();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  mkdirSync(dist, { recursive: true });
  const worker = await build({
    absWorkingDir: root,
    entryPoints: ["src/worker/entry.ts"],
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
  });
  const workerCode = worker.outputFiles[0]!.text;
  writeFileSync(join(dist, "maplet-worker.js"), workerCode);
  const define = {
    MAPLET_WORKER_SOURCE: JSON.stringify(workerCode),
    MAPLET_VERSION: JSON.stringify(pkg.version),
  };
  const common = {
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    bundle: true,
    target: "es2022",
    define,
    legalComments: "none" as const,
    logLevel: "warning" as const,
  };
  await Promise.all([
    build({ ...common, format: "esm", outfile: "dist/maplet.js", sourcemap: true }),
    build({ ...common, format: "esm", outfile: "dist/maplet.min.js", minify: true, sourcemap: true }),
    build({ ...common, format: "iife", globalName: "maplet", outfile: "dist/maplet.global.js", minify: true, sourcemap: true }),
  ]);
  const { CSS } = await import("../src/ui/css.ts");
  writeFileSync(join(dist, "maplet.css"), `${CSS.trim()}\n`);
  if (options.types !== false) {
    rmSync(join(dist, "types"), { recursive: true, force: true });
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
  }
  if (!options.quiet) console.log(`Built dist in ${Math.round(performance.now() - started)} ms`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildAll({ types: !process.argv.includes("--no-types") }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
