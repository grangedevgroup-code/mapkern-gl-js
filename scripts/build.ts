import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dist, "mapkern-worker.js"), workerCode);
  const define = {
    MAPKERN_WORKER_SOURCE: JSON.stringify(workerCode),
    MAPKERN_VERSION: JSON.stringify(pkg.version),
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
    build({ ...common, format: "esm", outfile: "dist/mapkern.js", sourcemap: true }),
    build({ ...common, format: "esm", outfile: "dist/mapkern.min.js", minify: true, sourcemap: true }),
    build({
      ...common,
      format: "iife",
      globalName: "mapkern",
      outfile: "dist/mapkern.global.js",
      minify: true,
      sourcemap: true,
    }),
  ]);
  const tools = {
    absWorkingDir: root,
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    target: "node22",
    legalComments: "none" as const,
    logLevel: "warning" as const,
  };
  await Promise.all([
    build({
      ...tools,
      entryPoints: ["tools/tiles/cli.ts"],
      outfile: "dist/tiles/cli.js",
      banner: { js: "#!/usr/bin/env node" },
    }),
    build({ ...tools, entryPoints: ["tools/tiles/extract-worker.ts"], outfile: "dist/tiles/extract-worker.js" }),
  ]);
  const { CSS } = await import("../src/ui/css.ts");
  writeFileSync(join(dist, "mapkern.css"), `${CSS.trim()}\n`);
  if (options.types !== false) {
    rmSync(join(dist, "types"), { recursive: true, force: true });
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
    rewriteDeclarationImports(join(dist, "types"));
  }
  if (!options.quiet) console.log(`Built dist in ${Math.round(performance.now() - started)} ms`);
}

function rewriteDeclarationImports(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDeclarationImports(path);
    } else if (entry.name.endsWith(".d.ts")) {
      const text = readFileSync(path, "utf8");
      const next = text
        .replace(/(from\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3")
        .replace(/(import\(["'])(\.{1,2}\/[^"']+)\.ts(["']\))/g, "$1$2.js$3");
      if (next !== text) writeFileSync(path, next);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildAll({ types: !process.argv.includes("--no-types") }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
