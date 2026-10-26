import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const android = join(root, "android");
const out = join(root, "out", "android");
const args = process.argv.slice(2);
const install = args.includes("--install") || args.includes("--run");
const run = args.includes("--run");
const windows = process.platform === "win32";
const PACKAGE = "com.grangedevgroup.maplet";

function sdkRoot(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"),
    join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"),
  ];
  const found = candidates.find((dir): dir is string => !!dir && existsSync(join(dir, "platform-tools")));
  if (!found) throw new Error("No Android SDK found. Install it with Android Studio or set ANDROID_HOME.");
  return found;
}

function latest(dir: string): string {
  const versions = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  const number = (name: string) => name.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  versions.sort((a, b) => {
    const x = number(a);
    const y = number(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++)
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
  const last = versions.pop();
  if (!last) throw new Error(`Nothing installed in ${dir}`);
  return join(dir, last);
}

function tool(dir: string, name: string): string {
  for (const file of windows ? [`${name}.exe`, `${name}.bat`] : [name]) {
    if (existsSync(join(dir, file))) return join(dir, file);
  }
  throw new Error(`${name} is missing from ${dir}`);
}

function java(name: string): string {
  const home = process.env.JAVA_HOME;
  if (home) {
    const file = join(home, "bin", windows ? `${name}.exe` : name);
    if (existsSync(file)) return file;
  }
  return name;
}

function exec(file: string, list: string[], cwd = root): string {
  const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] } as const;
  if (!file.endsWith(".bat")) return execFileSync(file, list, options);
  const quote = (arg: string) => `"${arg.replace(/"/g, '""')}"`;
  return execFileSync(quote(file), list.map(quote), { ...options, shell: true });
}

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (name.endsWith(".java") || name.endsWith(".class")) found.push(path);
  }
  return found;
}

const sdk = sdkRoot();
const buildTools = latest(join(sdk, "build-tools"));
const platform = join(latest(join(sdk, "platforms")), "android.jar");
const adb = tool(join(sdk, "platform-tools"), "adb");

exec(process.execPath, [join(root, "scripts", "site.ts")]);
rmSync(out, { recursive: true, force: true });
const assets = join(out, "assets", "site");
mkdirSync(assets, { recursive: true });
cpSync(join(root, "_site"), assets, { recursive: true });
cpSync(join(android, "app.html"), join(assets, "app.html"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const commit = exec("git", ["rev-parse", "--short", "HEAD"]).trim();
const count = exec("git", ["rev-list", "--count", "HEAD"]).trim();
const manifest = join(out, "AndroidManifest.xml");
writeFileSync(
  manifest,
  readFileSync(join(android, "AndroidManifest.xml"), "utf8")
    .replace("@VERSION_CODE@", count)
    .replace("@VERSION_NAME@", `${pkg.version} (${commit})`),
);

const aapt2 = tool(buildTools, "aapt2");
const resources = join(out, "resources.zip");
exec(aapt2, ["compile", "--dir", join(android, "res"), "-o", resources]);
const unsigned = join(out, "unsigned.apk");
exec(aapt2, [
  "link",
  "-o",
  unsigned,
  "--manifest",
  manifest,
  "-I",
  platform,
  "--min-sdk-version",
  "26",
  "--target-sdk-version",
  "36",
  "-A",
  join(out, "assets"),
  "-0",
  "pmtiles",
  resources,
]);

const classes = join(out, "classes");
mkdirSync(classes, { recursive: true });
exec(java("javac"), [
  "--release",
  "11",
  "-classpath",
  platform,
  "-d",
  classes,
  "-Xlint:-options",
  ...sources(join(android, "src")),
]);
const dex = join(out, "dex");
mkdirSync(dex, { recursive: true });
exec(tool(buildTools, "d8"), ["--release", "--min-api", "26", "--lib", platform, "--output", dex, ...sources(classes)]);
exec(java("jar"), ["uf", unsigned, "-C", dex, "classes.dex"]);

const aligned = join(out, "aligned.apk");
exec(tool(buildTools, "zipalign"), ["-f", "-p", "4", unsigned, aligned]);
const keystore = join(homedir(), ".android", "debug.keystore");
if (!existsSync(keystore)) {
  mkdirSync(dirname(keystore), { recursive: true });
  exec(java("keytool"), [
    "-genkeypair",
    "-keystore",
    keystore,
    "-storepass",
    "android",
    "-alias",
    "androiddebugkey",
    "-keypass",
    "android",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-dname",
    "CN=Android Debug,O=Android,C=US",
  ]);
}
const apk = join(out, "maplet-demo.apk");
exec(tool(buildTools, "apksigner"), [
  "sign",
  "--ks",
  keystore,
  "--ks-pass",
  "pass:android",
  "--key-pass",
  "pass:android",
  "--out",
  apk,
  aligned,
]);
console.log(`${apk} (${(statSync(apk).size / 1048576).toFixed(1)} MB, ${pkg.version} ${commit})`);

if (install) {
  const devices = exec(adb, ["devices"])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial!);
  const wanted = args.find((arg) => arg.startsWith("--device="))?.slice(9);
  const targets = wanted ? devices.filter((serial) => serial === wanted) : devices;
  if (targets.length === 0) throw new Error("No Android device is connected");
  for (const serial of targets) {
    exec(adb, ["-s", serial, "install", "-r", apk]);
    exec(adb, ["-s", serial, "shell", "pm", "clear", PACKAGE]);
    if (run) exec(adb, ["-s", serial, "shell", "am", "start", "-n", `${PACKAGE}/.MainActivity`]);
    console.log(`Installed on ${serial}`);
  }
}
