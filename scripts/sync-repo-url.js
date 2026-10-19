// Keeps the GitHub URLs hardcoded in docs/ in step with package.json.
//
// Why this exists: every download link on the site is built from
// `APP_DATA.releases.repo`, and that string was hand-written as
// "lucianvuc/shadow-bit" while the repo is "luciVuc". GitHub does NOT redirect
// on owner-name case, so every download button on the live site pointed at a
// 404 — and nothing caught it, because a well-formed URL with the right
// version in it looks completely correct in a test.
//
// The site runs over file:// and cannot import package.json, so the value has
// to be a literal in docs/. What this script removes is the chance for that
// literal to disagree with the remote.
//
// Usage:
//   node scripts/sync-repo-url.js           # check only, exit 1 on drift
//   node scripts/sync-repo-url.js --write   # rewrite the literals in place
//
// Wired into CI so drift fails the build rather than shipping.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");

/**
 * The canonical repo URL, from package.json. This is the same value the git
 * remote uses and the same one `npm version` reads, so it cannot drift.
 */
function canonicalRepo() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const url = pkg.repository?.url;
  if (!url) throw new Error("package.json has no repository.url");
  const m = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`cannot parse a GitHub repo out of "${url}"`);
  return { owner: m[1], url: `https://github.com/${m[1]}` };
}

/** Every place docs/ names the repo. */
const SITES = [
  {
    file: "docs/data.js",
    label: "APP_DATA.meta.github",
    before: '    github: "https://github.com/',
    after: '",',
  },
  {
    file: "docs/data.js",
    label: "APP_DATA.releases.repo",
    before: '    repo: "https://github.com/',
    after: '",',
  },
  {
    file: "docs/data.js",
    label: "clone URL in devSetup",
    before: "git clone https://github.com/",
    after: ".git",
  },
  {
    file: "docs/dev.html",
    label: "README link",
    before: 'href="https://github.com/',
    after: '#readme"',
  },
  {
    file: "docs/dev.html",
    label: "SECURITY.md link",
    before: 'href="https://github.com/',
    after: '/blob/master/SECURITY.md"',
  },
  {
    file: "docs/dev.html",
    label: "AGENTS.md link",
    before: 'href="https://github.com/',
    after: '/blob/master/AGENTS.md"',
  },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const { owner, url } = canonicalRepo();
const drift = [];

for (const site of SITES) {
  const abs = path.join(ROOT, site.file);
  if (!fs.existsSync(abs)) {
    drift.push({ ...site, found: "<file missing>" });
    continue;
  }
  let body = fs.readFileSync(abs, "utf8");
  const re = new RegExp(
    `${escapeRe(site.before)}(.+?)${escapeRe(site.after)}`,
    "g",
  );
  let hits = 0;
  body = body.replace(re, (_all, found) => {
    hits++;
    if (found !== owner) {
      drift.push({ ...site, found, line: 0 });
    }
    return `${site.before}${write ? owner : found}${site.after}`;
  });
  if (hits === 0) {
    drift.push({ ...site, found: "<anchor not found>" });
    continue;
  }
  if (write) fs.writeFileSync(abs, body);
}

if (drift.length === 0) {
  console.log(`✓ repo URL "${owner}" is consistent across docs/`);
  process.exit(0);
}

if (!write) {
  console.error(
    `✗ docs/ names the repo differently from package.json (${url}):`,
  );
  for (const d of drift) {
    console.error(`  ${d.file} — ${d.label}: found "${d.found}"`);
  }
  console.error("\nFix with: npm run sync-repo-url -- --write");
  process.exit(1);
}

console.log(`✓ rewrote ${drift.length} repo URL(s) in docs/ to "${owner}"`);
