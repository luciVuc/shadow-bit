// Fails the build when the website advertises a version that was never released.
//
// Why this exists: the download section offers a version chip per release and
// builds a direct asset URL for each. Every one of those was a 404 on the live
// site — not because the URLs were malformed (they were well-formed and carried
// the right version, which is all the existing tests checked) but because the
// repository had no tags and no releases at all. A link can be perfectly
// constructed and still 404, and nothing noticed.
//
// The site already follows a "content must be true" rule for capability claims.
// This applies it to versions: if the page says 1.1.2 is downloadable, 1.1.2
// must exist as a GitHub Release.
//
// Usage:
//   node scripts/check-released-versions.js           # exit 1 on drift
//   node scripts/check-released-versions.js --write   # prune the list to match
//
// Network access is required. It is wired into CI as a job that does not gate
// packaging (a GitHub outage must not block a release), and the workflow's
// `needs` graph makes that explicit rather than incidental.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "docs", "data.js");
const write = process.argv.includes("--write");

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository.url)[1];

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

/**
 * Versions that have a GitHub Release.
 *
 * Release assets are what the download buttons point at, so a tag without a
 * published release is not enough: an unpushed tag, or a draft release, still
 * 404s for a visitor. Both are reported so the message names the real cause
 * instead of a generic mismatch.
 */
async function publishedReleases() {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${repo}/releases`);
  }
  const releases = await res.json();
  const published = new Map();
  const drafts = [];
  for (const r of releases) {
    const version = r.tag_name.replace(/^v/, "");
    if (r.draft) drafts.push(version);
    else published.set(version, r);
  }
  return { published, drafts };
}

/** Read the site's advertised versions out of data.js without executing it. */
function advertised() {
  const body = fs.readFileSync(DATA, "utf8");
  const current = /version:\s*"([\d.]+)"/.exec(
    body.slice(0, body.indexOf("releases:")),
  )[1];
  const history = [...body.matchAll(/release:\s*"([\d.]+)"/g)].map((m) => m[1]);
  return { current, history };
}

const { published, drafts } = await publishedReleases();
const { current, history } = advertised();

const missing = [];
if (!published.has(current)) {
  missing.push({ version: current, kind: "current (meta.version)" });
}
for (const v of history) {
  if (!published.has(v))
    missing.push({ version: v, kind: "listed in releases.versions[]" });
}

if (missing.length === 0) {
  console.log(
    `✓ every version advertised by the site is published (${[current, ...history].join(", ")})`,
  );
  process.exit(0);
}

const lines = missing.map(
  (m) =>
    `  ${m.version} — advertised as ${m.kind}, but no published GitHub Release exists`,
);
if (drafts.length) {
  lines.push(
    `  note: draft release(s) exist for ${drafts.join(", ")}. A draft is not` +
      ` downloadable — publish it, and the links start working.`,
  );
}

if (!write) {
  console.error(`✗ the site advertises releases that do not exist:`);
  console.error(lines.join("\n"));
  console.error(
    "\nEither publish the releases (tag, then let CI publish), or remove the\n" +
      "versions from docs/data.js: APP_DATA.meta.version / releases.versions[].\n" +
      "A version bump is NOT a release: `npm version` only edits files.",
  );
  process.exit(1);
}

// --write: drop the unpublishable entries from the history list, and report
// loudly that meta.version cannot be auto-fixed.
const keep = history.filter((v) => published.has(v));
let body = fs.readFileSync(DATA, "utf8");
body = body.replace(
  /versions: \[[\s\S]*?\n(\s*)\],/,
  `versions: [\n${keep.map((v) => `      { release: "${v}" },`).join("\n")}\n    ],`,
);
fs.writeFileSync(DATA, body);
console.error(lines.join("\n"));
console.error(
  `\n✓ pruned releases.versions[] to ${keep.join(", ") || "(empty)"}`,
);
if (!published.has(current)) {
  console.error(
    `\n✗ meta.version is ${current}, which is not published, and a version\n` +
      `  bump is not a release. Set it back to a published version, or tag and\n` +
      `  publish this one before deploying the site.`,
  );
}
console.error(
  "\nNOTE: re-run prettier — the rewrite does not preserve formatting.",
);
