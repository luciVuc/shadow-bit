// The app version lives in package.json. A handful of other places cannot read
// it and must carry the number as a literal — chiefly the docs site, which has
// to run over file:// and so cannot import anything outside docs/.
//
// This module is the single definition of "which literal goes where, and how is
// it shaped". Both `scripts/bump-version.js` (which WRITES them) and the
// version-consistency test in e2e/cli.test.ts (which CHECKS them) import it.
// That sharing is the whole point: if the script and the test each spelled out
// the derivation separately, a change to one would silently diverge from the
// other and reintroduce exactly the drift this exists to prevent.
//
// NOTE: nothing here touches src/core/container.ts. `CURRENT_VERSION` is the
// .svlt CONTAINER format version (3), an unrelated number that also prints as
// "Version". Bumping the app must never change it — see AGENTS.md.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * A site is defined by the literal text immediately before and after the
 * version number. That is more robust than a regex over bare version-looking
 * text, and it makes "did I find what I expected?" an exact question instead
 * of a guess: if `before` has disappeared from a file, that is a real failure
 * to report, not a silent no-op that looks like success.
 *
 * @typedef {{file: string, label: string, before: string, after: string,
 *            transform?: (v: string) => string, pattern?: RegExp}} LiteralSite
 */

/** @type {LiteralSite[]} */
const LITERAL_SITES = [
  {
    file: "docs/data.js",
    label: "docs site meta.version",
    before: '    version: "',
    after: '"',
  },
  {
    file: "docs/index.html",
    label: "docs site version badge",
    // The badge is deliberately major.minor, not the full version: it tracks
    // the release line, not the patch. Note the leading "v" lives in `before`,
    // so `transform` returns the bare digits — it fills the gap between the
    // anchors, nothing else.
    before: 'class="version-badge">v',
    after: "<",
    transform: (v) => majorMinor(v),
  },
  // Artifact names on the site's download buttons. These are the file names
  // the release actually uploads, so a stale one is a 404 on the primary call
  // to action. The `after` anchors include the arch suffix on purpose:
  // "ShadowBit-" … ".dmg" would capture "1.1.3-arm64" and silently rewrite the
  // download to ShadowBit-<v>.dmg, dropping the architecture the visitor needs.
  {
    file: "docs/data.js",
    label: "download: macOS Apple Silicon DMG name",
    before: "ShadowBit-",
    after: "-arm64.dmg",
  },
  {
    file: "docs/data.js",
    label: "download: macOS Intel DMG name",
    before: "ShadowBit-",
    after: "-x64.dmg",
  },
  {
    file: "docs/data.js",
    label: "download: Windows NSIS installer name",
    before: "ShadowBit Setup ",
    after: ".exe",
  },
  {
    file: "docs/data.js",
    label: "download: Linux AppImage name",
    before: "ShadowBit-",
    after: ".AppImage",
  },
  {
    file: "docs/data.js",
    label: "download: Linux deb name",
    before: "shadow-bit_",
    after: "_amd64.deb",
  },
  // QUICKSTART.md deliberately has NO version literal sites: its build-output
  // examples use `<version>` placeholders, so there is nothing to keep in
  // step. It previously hardcoded `release/linux/1.1.3/ShadowBit-1.1.5.AppImage`
  // — a path segment and a file version that could disagree with each other,
  // and that drifted on every bump until `npm version` rewrote the file name
  // and left the directory stale.
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} v
 * @returns {string}
 */
function majorMinor(v) {
  const parts = v.split(".");
  if (parts.length < 2) throw new Error(`not a full version: ${v}`);
  return `${parts[0]}.${parts[1]}`;
}

/**
 * Guard against writing something that is not a version. A bad regex match here
 * would silently rewrite arbitrary text in the docs.
 *
 * @param {string} v
 * @param {string} where
 */
function assertVersionLike(v, where) {
  if (!/^v?\d+\.\d+(\.\d+)?/.test(v)) {
    throw new Error(
      `${where}: "${v}" does not look like a version — refusing to rewrite it`,
    );
  }
}

/**
 * Every version literal currently on disk, each with the value it *should* hold
 * for `version`. Scanning and comparing together means a site can never be
 * discovered by one rule and judged by another.
 * @param {string} version
 * @returns {{file: string, label: string, current: string, line: number}[]}
 */
function scanLiterals(version = "0.0.0") {
  const found = [];
  for (const site of LITERAL_SITES) {
    const abs = path.join(ROOT, site.file);
    if (!fs.existsSync(abs)) {
      found.push({
        file: site.file,
        label: site.label,
        current: "",
        line: 0,
        missing: true,
        want: site.transform ? site.transform("0.0.0") : "",
      });
      continue;
    }
    const body = fs.readFileSync(abs, "utf8");
    const re = new RegExp(
      `${escapeRe(site.before)}(.+?)${escapeRe(site.after)}`,
      "g",
    );
    let m;
    while ((m = re.exec(body)) !== null) {
      found.push({
        file: site.file,
        label: site.label,
        current: m[1],
        line: body.slice(0, m.index).split("\n").length,
        missing: false,
        want: site.transform
          ? site.transform(fullVersion(version))
          : fullVersion(version),
      });
    }
  }
  return found;
}

/**
 * Sites that are not currently at `version`.
 * @param {string} version
 * @returns {{file: string, label: string, current: string, line: number}[]}
 */
function findStale(version) {
  const full = fullVersion(version);
  return scanLiterals(full).filter(
    (lit) => lit.missing || lit.current !== lit.want,
  );
}

/**
 * @param {string} version
 * @returns {string}
 */
function fullVersion(version) {
  const v = String(version).trim();
  if (!/^\d+\.\d+\.\d+/.test(v)) {
    throw new Error(`refusing to use "${v}" as the app version`);
  }
  return v;
}

/**
 * Write `version` into every literal. Returns the files changed.
 * @param {string} version
 * @returns {{changed: string[], stale: ReturnType<typeof findStale>}}
 */
function applyVersion(version) {
  const full = fullVersion(version);
  const changed = [];
  const stale = findStale(full);

  const byFile = new Map();
  for (const lit of stale) {
    if (lit.missing) continue;
    if (!byFile.has(lit.file)) byFile.set(lit.file, []);
    byFile.get(lit.file).push(lit);
  }

  for (const [file, lits] of byFile) {
    const abs = path.join(ROOT, file);
    let body = fs.readFileSync(abs, "utf8");
    for (const lit of lits) {
      const site = LITERAL_SITES.find(
        (s) => s.file === file && s.label === lit.label,
      );
      const want = site.transform ? site.transform(full) : full;
      // Re-scan per site: an earlier replacement on the same line can shift
      // nothing for these anchored literals, but rebuilding the regex keeps the
      // "did I find it" check honest instead of assuming.
      const re = new RegExp(
        `${escapeRe(site.before)}(.+?)${escapeRe(site.after)}`,
        "g",
      );
      let hits = 0;
      body = body.replace(re, (_all, cur) => {
        assertVersionLike(cur, `${file}:${lit.line} (${lit.label})`);
        hits++;
        return site.before + want + site.after;
      });
      if (hits === 0) {
        throw new Error(
          `${file}: could not rewrite "${lit.label}" at line ${lit.line}`,
        );
      }
    }
    fs.writeFileSync(abs, body);
    changed.push(file);
  }

  return { changed, stale };
}

module.exports = {
  ROOT,
  LITERAL_SITES,
  scanLiterals,
  findStale,
  applyVersion,
  fullVersion,
};
