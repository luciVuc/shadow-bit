// Prunes old build output from release/ on a build machine.
//
// Why this is safe to run: release/ is gitignored and holds only locally
// rebuilt artifacts. The durable copy of every published build lives on its
// GitHub Release (attached by the `publish` job in .github/workflows/release.yml)
// under a CDN, and the website's download links point at those Release assets
// rather than at anything served from docs/. Deleting a local directory
// therefore removes a copy, not the artifact.
//
// Note that artifacts are deliberately NOT committed to the repository instead.
// Git is a source store, not an artifact store: the Linux AppImage alone is
// ~119 MiB, over GitHub's 100 MiB hard limit for a file in a repository, so the
// push would be rejected outright — and every version ever committed would be
// stored forever and cloned by everyone.
//
// Usage:
//   npm run clean:release                      # keep the 3 newest per platform
//   npm run clean:release -- --keep 1# only what you'd rebuild next
//   npm run clean:release -- --platform linux  # one platform
//   npm run clean:release -- --dry-run         # print, delete nothing
//
// Deletion requires an explicit --keep. There is deliberately no "delete
// everything" mode reachable by accident: a blind `rm -rf release/*` is how a
// 40-minute build disappears.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = path.join(ROOT, "release");

/** The directories scripts/package.mjs writes. Anything else is left alone. */
const PLATFORMS = ["linux", "macos", "windows"];

/** Matches a full semver-ish version directory: 1.2.3, optionally with a tag. */
const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// ─── arguments ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { keep: null, platform: null, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--keep") opts.keep = Number(argv[++i]);
    else if (arg.startsWith("--keep=")) opts.keep = Number(arg.slice(7));
    else if (arg === "--platform") opts.platform = argv[++i];
    else if (arg.startsWith("--platform=")) opts.platform = arg.slice(11);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else return { error: `Unknown argument: ${arg}` };
  }
  if (opts.keep !== null && (!Number.isInteger(opts.keep) || opts.keep < 0)) {
    return { error: "--keep must be a non-negative integer" };
  }
  if (opts.platform && !PLATFORMS.includes(opts.platform)) {
    return {
      error: `Unknown platform "${opts.platform}". Expected one of: ${PLATFORMS.join(", ")}`,
    };
  }
  return { opts };
}

/** Dotted-version compare, newest last. */
function compareVersions(a, b) {
  const pa = a.split(/[.+-]/).map((n) => Number(n) || 0);
  const pb = b.split(/[.+-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Total bytes under a directory, for the savings figure. */
function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* a file vanished mid-walk; not worth failing the cleanup over */
        }
      }
    }
  };
  walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const USAGE = `Usage: npm run clean:release -- [options]

  --keep <n>          Keep the n newest version directories per platform.
                      Required — there is no accidental wipe mode.
  --platform <name>   Restrict to one of: ${PLATFORMS.join(", ")}.
  --dry-run, -n       Report what would be deleted; delete nothing.
  --yes, -ySkip the confirmation prompt.
  --help, -h          This message.

Examples:
  npm run clean:release -- --dry-run
  npm run clean:release -- --keep 2 -y
  npm run clean:release -- --keep 1 --platform linux
`;

// ─── plan ───────────────────────────────────────────────────────────────────

/**
 * Decide what to delete. Returns { platform, keep, remove } so the plan can be
 * printed in full before anything is touched.
 */
function plan(opts) {
  const platforms = opts.platform ? [opts.platform] : PLATFORMS;
  const result = [];
  for (const platform of platforms) {
    const dir = path.join(RELEASE, platform);
    if (!fs.existsSync(dir)) continue;

    const versions = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
      .map((e) => e.name)
      .sort(compareVersions);

    // Anything in the platform directory that is NOT a version directory is
    // reported and kept: this script only removes what it can prove is a
    // version-scoped build output.
    const unknown = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !VERSION_DIR.test(e.name))
      .map((e) => e.name);

    // Guard the --keep 0 case explicitly: `slice(-0)` is `slice(0)`, which
    // returns the WHOLE array. Left unguarded it makes every version appear
    // under both "keep" and "remove", which is a contradiction the reader has
    // to notice rather than something the tool should print.
    const keepCount = Math.min(opts.keep, versions.length);
    const keep =
      keepCount > 0 ? versions.slice(versions.length - keepCount) : [];
    const remove = versions.slice(0, Math.max(0, versions.length - keepCount));
    result.push({
      platform,
      versions,
      keep,
      remove: remove.map((v) => ({ version: v, dir: path.join(dir, v) })),
      unknown,
    });
  }
  return result;
}

// ─── main ───────────────────────────────────────────────────────────────────

const { opts, error } = parseArgs(process.argv.slice(2));

if (error) {
  console.error(error);
  console.error(`\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

// No policy supplied: report the state and exit non-zero rather than guessing.
// Deleting based on an assumed retention is how the wrong build gets dropped.
if (opts.keep === null) {
  const probe = plan({ keep: Number.MAX_SAFE_INTEGER });
  console.log("No --keep given, so nothing was deleted. Current state:\n");
  if (!probe.length) console.log("  release/ contains no build output.");
  for (const p of probe) {
    console.log(`  ${p.platform}: ${p.versions.join(", ") || "(none)"}`);
  }
  console.error(`\n${USAGE}`);
  process.exit(2);
}

if (!fs.existsSync(RELEASE)) {
  console.log("release/ does not exist — nothing to clean.");
  process.exit(0);
}

const result = plan(opts);
const removable = result.flatMap((p) => p.remove);

if (!removable.length) {
  console.log(
    `Nothing to clean: every platform already has at most ${opts.keep} version director${opts.keep === 1 ? "y" : "ies"}.`,
  );
  for (const p of result) {
    if (p.keep.length)
      console.log(`  ${p.platform}: keeping ${p.keep.join(", ")}`);
  }
  process.exit(0);
}

// Print the whole plan before touching anything.
let freed = 0;
for (const p of result) {
  console.log(`${p.platform}:`);
  for (const v of p.keep) console.log(`  keep    ${v}`);
  for (const r of p.remove) {
    const size = dirSize(r.dir);
    freed += size;
    console.log(`  remove  ${r.version}  (${mb(size)})`);
  }
  if (p.unknown.length) {
    console.log(
      `  note: leaving alone (not a version directory): ${p.unknown.join(", ")}`,
    );
  }
}
console.log(
  `\n${removable.length} version director${removable.length === 1 ? "y" : "ies"}, ${mb(freed)} to reclaim.`,
);

if (opts.dryRun) {
  console.log("\nDry run — nothing was deleted.");
  process.exit(0);
}

if (!opts.yes) {
  // Confirm on the same terminal. Skipped when there is no TTY (CI) only if
  // --yes was passed; a non-interactive run must opt in explicitly rather than
  // delete on a guess.
  if (!process.stdin.isTTY) {
    console.error(
      "\nRefusing to delete without confirmation on a non-interactive " +
        "terminal. Re-run with --yes.",
    );
    process.exit(2);
  }
  process.stdout.write("\nDelete these directories? [y/N] ");
  const answer = await new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => resolve(chunk.trim().toLowerCase()));
  });
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted — nothing was deleted.");
    process.exit(0);
  }
}

for (const r of removable) {
  fs.rmSync(r.dir, { recursive: true, force: true });
}

console.log(`\nDone. Reclaimed ${mb(freed)}.`);
console.log(
  "Published builds are unaffected — they live on their GitHub Release, " +
    "which is where the website's download links point.",
);
