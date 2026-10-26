import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "./build.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const data = process.argv[2] ? resolve(process.argv[2]) : join(root, "data", "seattle.pmtiles");
const searchDir = process.argv[3] ? resolve(process.argv[3]) : join(root, "data");

await buildAll({ types: false, quiet: true });
rmSync(out, { recursive: true, force: true });
cpSync(join(root, "site"), out, { recursive: true });
for (const dir of ["assets", "examples"]) cpSync(join(root, dir), join(out, dir), { recursive: true });
mkdirSync(join(out, "dist"));
for (const file of [
  "mapkern.js",
  "mapkern.js.map",
  "mapkern.min.js",
  "mapkern.min.js.map",
  "mapkern.css",
  "mapkern-worker.js",
]) {
  cpSync(join(root, "dist", file), join(out, "dist", file));
}
if (existsSync(data)) {
  mkdirSync(join(out, "data"));
  cpSync(data, join(out, "data", "seattle.pmtiles"));
} else {
  console.warn(`No map data at ${data}; the site will show an empty map`);
}
const indexes = existsSync(searchDir) ? readdirSync(searchDir).filter((f) => f.endsWith(".search")) : [];
mkdirSync(join(out, "data"), { recursive: true });
for (const file of indexes) cpSync(join(searchDir, file), join(out, "data", file));
if (indexes.length === 0)
  console.warn(`No search index in ${searchDir}; search on the site will say it is not available`);
console.log(`Site written to ${out}`);
