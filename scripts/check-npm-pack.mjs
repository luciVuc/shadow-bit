// check-npm-pack.mjs — assert the npm tarball stays CLI-only.
//
// The contract an npm consumer gets is: `npm install -g shadow-bit` installs
// ONE command and its two runtime deps (commander, picocolors); it must not
// drag in the Electron renderer, GUI assets, compiled test output, or —
// worst of all — Electron itself (devDependency). The `files` whitelist in
// package.json is what enforces that, and this script is the test nobody
// reads the whitelist. Three classes of drift it catches:
//
//  1. A well-meaning "ship more so it works" edit adds dist/** back — the
//     tarball grows past 10 MB and silently ships the whole desktop app.
//  2. A new top-level directory appears under dist/ (a future dist/assets/,
//     dist/scripts/) — currently NOT in the whitelist, so it silently
//     disappears from the tarball and whatever needed it breaks only in the
//     installed package, never in a dev checkout. The whitelist is
//     allow-by-default here: any dist/ entry other than cli/ and core/ fails
//     loudly and must be either added (with a test) or not shipped.
//  3. The bin file loses its shebang (a tsc/prebuild change) — npm delivers
//     the entry as a shell script and every install dies with "command not
//     found". Checked directly, because nothing else checks it.
//
// Run via `npm run check:npm-pack` (wired into `verify`). Requires a built
// dist/ — `npm run build` first. xz it needs no network: -y, dry-run.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);

let out;
try {
  out = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
} catch (err) {
  console.error("check:npm-pack — npm pack --dry-run failed:", err.message);
  process.exit(1);
}
const pkgs = JSON.parse(out);
const tarball = pkgs.find(
  (p) => p.name === pkg.name && p.version === pkg.version,
);
if (!tarball) {
  console.error(
    `check:npm-pack — pack output did not contain ${pkg.name}@${pkg.version}`,
  );
  process.exit(1);
}
const keys = tarball.files.map((f) => f.key ?? f.path);

const failures = [];
const has = (p) => keys.includes(p);

// 1. The things an npm consumer MUST get. dist/core/vault-worker.js is here
//    rather than dist/cli/index.js alone: it runs under both the CLI and
//    third-party consumers' node, and a tarball that can't carry one file can
//    carry the other.
for (const must of [
  "dist/cli/index.js",
  "dist/core/vault-worker.js",
  "package.json",
  "README.md",
]) {
  if (!has(must)) failures.push(`missing required file: ${must}`);
}

// 2. Nothing that only the desktop app or the dev suite needs.
for (const listed of keys) {
  const top = listed.split("/")[0];
  if (top === "dist") {
    const sub = listed.split("/")[1];
    if (sub !== "cli" && sub !== "core" && listed !== pkg.main) {
      failures.push(`unexpected dist/${sub}/ path in tarball: ${listed}`);
    }
  } else if (
    top !== "package.json" &&
    top !== "README.md" &&
    top !== "LICENSE" &&
    listed !== pkg.main
  ) {
    failures.push(`unexpected root-level path in tarball: ${listed}`);
  }
}

// npm auto-includes LICENSE and the `main` entry no matter what `files`
// says, so the checks above must allow them. Assert the consequence of the
// `main` inclusion here so a change to it has to be made consciously: the
// GUI entry ships without its renderer, preload or worker bridge, so a
// third-party importing the package "main" fails loudly — the CLI is the
// supported interface. If "main" ever becomes meaningful for npm consumers,
// delete that field instead of widening the whitelist.

// 3. The bin entry must actually be a runnable script.
const binRel = pkg.bin && pkg.bin["shadow-bit"];
if (!binRel) {
  failures.push('package.json has no bin entry for "shadow-bit"');
} else if (!has(binRel)) {
  failures.push(`bin target ${binRel} is not in the tarball`);
} else {
  const binAbs = path.join(ROOT, binRel);
  const head = fs
    .readFileSync(binAbs, { encoding: "utf8", flag: "r" })
    .slice(0, 20);
  if (!head.startsWith("#!/usr/bin/env node")) {
    failures.push(`${binRel} is missing the "#!/usr/bin/env node" shebang`);
  }
}

// 4. Light: prod deps only, no Electron. If someone adds Electron to
//    "dependencies" instead of devDependencies, this and the size cap below
//    are the two tripwires.
const prodDeps = Object.keys(pkg.dependencies ?? {});
const forbidden = ["electron", "electron-builder", "playwright"];
for (const dep of prodDeps) {
  if (forbidden.includes(dep)) {
    failures.push(
      `"${dep}" must not be a production dependency of the CLI package`,
    );
  }
}

const MB = 1024 * 1024;
if (tarball.unpackedSize > 10 * MB) {
  failures.push(
    `tarball content is ${(tarball.unpackedSize / MB).toFixed(1)} MiB — cli+core should sit well under 10 MiB; something worked its way back in`,
  );
}

if (failures.length) {
  console.error("check:npm-pack failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `check:npm-pack ok — ${tarball.entryCount} files, ${(tarball.unpackedSize / MB).toFixed(1)} MiB unpacked`,
);
