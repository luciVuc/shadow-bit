// Runs electron-builder with the output directory scoped to one platform.
//
// Why this exists: electron-builder's `directories.output` is a single value
// read from package.json, so without an override every platform writes into
// the same `release/`. A macOS build then drops `latest-mac.yml` next to a
// Linux `latest-linux.yml`, two different auto-update conventions sharing one
// directory, and once more than one platform has been built there is no way to
// tell which `builder-effective-config.yaml` produced which artifact. The CI
// release job uploads `release/` wholesale, so a stray file from a previous
// platform's build would ship in someone else's release.
//
// The override is passed on the command line (`--config.directories.output`)
// rather than written into package.json, so the committed config stays a single
// source of truth for *what* is built and this script only decides *where* each
// platform lands.
//
// Output is release/<platform>/<version>/, so a rebuild of an older version on
// the same machine cannot overwrite a newer build's artifacts, and no two
// platforms or versions share electron-builder's bookkeeping files
// (builder-effective-config.yaml, latest*.yml, builder-debug.yml — all of which
// are named the same regardless of what built them).
//
// Usage:
//   node scripts/package.mjs linux          # release/linux/1.2.3
//   node scripts/package.mjs mac            # release/macos/1.2.3
//   node scripts/package.mjs win            # release/windows/1.2.3
//   node scripts/package.mjs current        # release/<this platform>/<version>
//   node scripts/package.mjs linux --dir    # unpacked build, same directory
//
// Any extra arguments are forwarded to electron-builder verbatim.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Platform key -> release subdirectory. Spelled out rather than derived from
 * process.platform: its values are "darwin" and "win32", which are neither the
 * directory name nor the flag electron-builder expects, and the release
 * workflow and the docs download buttons both reason about these names.
 */
const PLATFORM_DIRS = {
  linux: "linux",
  mac: "macos",
  macos: "macos",
  win: "windows",
  windows: "windows",
};

/** Map the running OS onto the same keys, for `current`. */
function currentPlatform() {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    default:
      return "linux";
  }
}

const argv = process.argv.slice(2);
const target = argv[0] || "current";
const key = target === "current" ? currentPlatform() : target;
const dir = PLATFORM_DIRS[key];

if (!dir) {
  console.error(
    `Unknown packaging target "${target}".\n` +
      `Expected one of: ${Object.keys(PLATFORM_DIRS).join(", ")}, current.`,
  );
  process.exit(2);
}

/**
 * The app version, read from package.json rather than taken as an argument.
 *
 * The output directory names the version, so a hand-passed one could disagree
 * with the version actually being built and produce a directory that lies
 * about its contents. package.json is also what `npm version` bumps, so this
 * is the one value that cannot drift.
 */
function appVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  if (!/^\d+\.\d+\.\d+/.test(String(pkg.version))) {
    throw new Error(
      `package.json version "${pkg.version}" is not a full semver version`,
    );
  }
  return pkg.version;
}

const flags = argv.slice(1);
const outDir = path.join("release", dir, appVersion());

// A user-supplied --config.directories.output would be silently overridden by
// ours (last flag wins), which is exactly the kind of surprise that costs an
// afternoon. Refuse instead of picking one.
if (flags.some((f) => f.includes("directories.output"))) {
  console.error(
    "This script sets the output directory per platform and version. Remove " +
      "the --config.directories.output override and pass the platform as " +
      "the first argument instead.",
  );
  process.exit(2);
}

console.log(`packaging for ${key} → ${outDir}`);

// The local bin is always present after `npm install`; `npx` would re-resolve
// it and can print an install prompt in restricted environments.
const builder = path.join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);

const result = spawnSync(
  builder,
  [...flags, `--config.directories.output=${outDir}`],
  { stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
