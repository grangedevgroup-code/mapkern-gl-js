import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildAll } from "./build.ts";
import { startServer } from "./server.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { port: { type: "string", default: "8080" }, host: { type: "string", default: "127.0.0.1" } } });

await buildAll({ types: false });
const { url } = await startServer({ root, port: Number(values.port), host: values.host });
console.log(`Examples: ${url}/examples/`);

let timer: ReturnType<typeof setTimeout> | undefined;
let building = false;
let again = false;
const rebuild = () => {
  if (building) {
    again = true;
    return;
  }
  building = true;
  buildAll({ types: false, quiet: true })
    .then(() => console.log(`Rebuilt at ${new Date().toLocaleTimeString()}`))
    .catch((error: unknown) => console.error(error instanceof Error ? error.message : error))
    .finally(() => {
      building = false;
      if (again) {
        again = false;
        rebuild();
      }
    });
};
watch(join(root, "src"), { recursive: true }, () => {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(rebuild, 120);
});
