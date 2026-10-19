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
// Usage:
//   node scripts/package.mjs linux          # release/linux
//   node scripts/package.mjs mac            # release/macos
//   node scripts/package.mjs win            # release/windows
//   node scripts/package.mjs current        # release/<this platform>
//   node scripts/package.mjs linux --dir    # unpacked build, same directory
//
// Any extra arguments are forwarded to electron-builder verbatim.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const flags = argv.slice(1);
const outDir = path.join("release", dir);

// A user-supplied --config.directories.output would be silently overridden by
// ours (last flag wins), which is exactly the kind of surprise that costs an
// afternoon. Refuse instead of picking one.
if (flags.some((f) => f.includes("directories.output"))) {
  console.error(
    "This script sets the output directory per platform. Remove the " +
      "--config.directories.output override and pass the platform as the " +
      "first argument instead.",
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
