// Syncs every hand-maintained version literal with package.json.
//
// Wired as npm's `version` lifecycle script:
//
//   npm version patch|minor|major|<a.b.c>
//
// npm rewrites package.json first, then runs this, then commits and tags. So
// this must read the NEW version out of package.json and write it everywhere
// else. Run it by hand (`node scripts/bump-version.js`) only when you have
// changed package.json some other way.
//
//   node scripts/bump-version.js --check   report drift, change nothing, exit 1
//
// The drift check here and the assertion in e2e/cli.test.ts deliberately share
// scripts/version-literals.js rather than re-deriving the rules, so the two
// cannot disagree about what "in sync" means.

const path = require("path");
const {
  applyVersion,
  findStale,
  fullVersion,
  ROOT,
} = require("./version-literals");

const pkg = JSON.parse(
  require("fs").readFileSync(path.join(ROOT, "package.json"), "utf8"),
);

const args = process.argv.slice(2);
const check = args.includes("--check");

if (args.some((a) => !a.startsWith("--"))) {
  console.error(
    "usage: node scripts/bump-version.js [--check]\n" +
      "       set the version with `npm version <a.b.c>` — this script only\n" +
      "       propagates package.json to the places that cannot read it.",
  );
  process.exit(2);
}

const version = fullVersion(pkg.version);

if (check) {
  const stale = findStale(version);
  if (stale.length === 0) {
    console.log(`✓ version ${version} is in sync everywhere`);
    process.exit(0);
  }
  for (const s of stale) {
    console.error(
      `stale: ${s.file}${s.line ? `:${s.line}` : ""} — ${s.label}` +
        (s.missing
          ? " (file not found)"
          : ` is "${s.current}", want "${version}"`),
    );
  }
  process.exit(1);
}

const { changed, stale } = applyVersion(version);

for (const s of stale) {
  if (s.missing) {
    throw new Error(
      `${s.file} does not exist but ${s.label} must carry the version`,
    );
  }
  console.log(`  ${s.file}:${s.line}  ${s.current} -> ${s.want}`);
}

console.log(
  changed.length === 0
    ? `✓ version ${version} already in sync`
    : `✓ version ${version} synced into ${changed.join(", ")}`,
);
