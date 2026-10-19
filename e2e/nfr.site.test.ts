// Regression guards for the public marketing site in docs/.
//
// This page used to pull Tailwind from the jsDelivr CDN at runtime. That is a
// single point of failure for the project's front door: if the CDN is down,
// rate-limits, or the visitor is offline, the site renders unstyled. The
// utilities are now vendored into docs/utilities.css, and these tests exist so
// that cannot silently regress.
//
// The assertions are deliberately cheap and targeted. They are not a
// replacement for visual review; they pin the properties that actually broke
// when the CDN was removed.
//
// Static file:// serving is the other half of the contract. docs/ is published
// as a plain directory (GitHub Pages, a USB stick, a zip), so the site must
// never need fetch(), ES modules, or a server. The file:// test below is what
// catches a regression there -- an over-http test would happily pass a page
// that cannot open by double-clicking it.

import { test, before, after, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { chromium, type Browser, type Page } from "playwright";
import { LITERAL_SITES } from "../scripts/version-literals";

// data.js assigns window.APP_DATA; the page has no build step or type
// checking, so declare just the shape these assertions read.
declare global {
  interface Window {
    APP_DATA: {
      features: unknown[];
      useCases: unknown[];
      commands: unknown[];
      security: unknown[];
      qa?: {
        id: string;
        items: { q: string; a?: string[]; code?: string; note?: unknown }[];
      }[];
    };
    tailwind?: unknown;
  }
}

const DOCS_DIR = path.resolve(__dirname, "../docs");
const INDEX_HTML = path.join(DOCS_DIR, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * Evaluate docs/data.js and return the content object.
 *
 * data.js is a script that assigns a global, so it is evaluated in a sandbox
 * rather than JSON.parse'd: a regex that strips comments to make it parseable
 * breaks the moment a string value contains "//" (a URL, say). The sandbox's
 * arrays have a different Array.prototype, so compare them through Array.from
 * or JSON.stringify — assert.deepEqual fails on prototype identity alone.
 */
function readAppData() {
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(DOCS_DIR, "data.js"), "utf8"),
    sandbox,
  );
  return sandbox.window.APP_DATA as {
    meta: { version: string };
    releases: { repo: string; versions: { release: string }[] };
    platforms: { id: string; builds: { file: string }[] }[];
    cliInstall?: { code: string };
  };
}

let browser: Browser;
let page: Page;
let server: http.Server;
let origin: string;
/** Every request URL the browser attempted that was not same-origin. */
let externalRequests: string[] = [];

before(async () => {
  // Serve docs/ over http so we can distinguish "the page asked the internet
  // for something" from "the page read a local file". The bytes served are the
  // real committed files; nothing is rewritten.
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(DOCS_DIR, rel === "/" ? "index.html" : rel);
    // Refuse to serve outside docs/, so a traversal can't read the repo.
    if (!file.startsWith(DOCS_DIR) || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("request", (r) => {
    const u = r.url();
    if (
      !u.startsWith(origin) &&
      !u.startsWith("data:") &&
      !u.startsWith("file:")
    ) {
      externalRequests.push(u);
    }
  });
  await page.goto(`${origin}/index.html`, { waitUntil: "load" });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("site is self-contained", () => {
  test("no CDN or other external resources are referenced", () => {
    // Source-level check: catches a CDN link added but not yet reached in
    // this session, and documents the invariant for the next person.
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    assert.ok(
      !/tailwindcss|cdn\.jsdelivr|unpkg\.com|cdnjs\./i.test(html),
      "docs/index.html references a CDN; the site must ship its own CSS",
    );
  });

  test("the page makes no external network requests", async () => {
    externalRequests = [];
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(800);
    assert.deepEqual(
      externalRequests,
      [],
      `unexpected external requests: ${externalRequests.join(", ")}`,
    );
  });

  test("renders correctly with all network access blocked", async () => {
    // The real test of "self-contained": abort anything that is not the local
    // origin, then confirm the page is still fully populated.
    const page2 = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page2.route("**/*", (route) => {
      if (route.request().url().startsWith(origin)) return route.continue();
      return route.abort();
    });
    try {
      await page2.goto(`${origin}/index.html`, { waitUntil: "load" });
      // data.js populates these at runtime; if JS or CSS were missing they stay empty.
      await page2.waitForSelector(".feature-card", { timeout: 5000 });
      const counts = await page2.evaluate(() => ({
        // Compare against what data.js *declared* rather than hardcoding a
        // number: that catches a render bug (card dropped, wrong container)
        // without going stale every time a feature is added. Hardcoded counts
        // in prose and tests are exactly how they drifted before.
        features: document.querySelectorAll("#features-grid .feature-card")
          .length,
        declaredFeatures: window.APP_DATA.features.length,
        useCases: document.querySelectorAll("#use-cases .feature-card").length,
        declaredUseCases: window.APP_DATA.useCases.length,
        cliRows: document.querySelectorAll("#cli-table .cli-row").length,
        declaredCommands: window.APP_DATA.commands.length,
        security: document.querySelectorAll("#security-grid .security-card")
          .length,
        declaredSecurity: window.APP_DATA.security.length,
        recipes: document.querySelectorAll("#workflows .recipe-card").length,
        styled:
          getComputedStyle(document.querySelector(".feature-card")).display !==
          "inline",
      }));
      assert.equal(
        counts.features,
        counts.declaredFeatures,
        "feature cards rendered != features declared in data.js",
      );
      assert.equal(
        counts.useCases,
        counts.declaredUseCases,
        "use-case cards rendered != useCases declared in data.js",
      );
      assert.equal(
        counts.cliRows,
        counts.declaredCommands,
        "CLI rows rendered != commands declared in data.js",
      );
      assert.equal(
        counts.security,
        counts.declaredSecurity,
        "security cards rendered != security declared in data.js",
      );
      assert.ok(
        counts.features >= 10,
        `only ${counts.features} feature cards rendered`,
      );
      assert.ok(
        counts.cliRows >= 14,
        `only ${counts.cliRows} CLI rows rendered`,
      );
      assert.ok(
        counts.security >= 13,
        `only ${counts.security} security cards rendered`,
      );
      assert.equal(counts.recipes, 4, "expected 4 workflow recipe cards");
      assert.ok(counts.styled, "index.css did not apply, page is unstyled");
    } finally {
      await page2.close();
    }
  });

  test("works from a plain file:// path", async () => {
    // docs/ is published as a directory. If the site ever needs fetch(),
    // modules, or a server, this fails and the failure is obvious.
    const page3 = await browser.newPage();
    const errors: string[] = [];
    page3.on("pageerror", (e) => errors.push(e.message));
    try {
      await page3.goto(pathToFileURL(INDEX_HTML).href, { waitUntil: "load" });
      await page3.waitForSelector(".feature-card", { timeout: 5000 });
      assert.deepEqual(errors, [], `file:// raised: ${errors.join(", ")}`);
      assert.equal(
        await page3.evaluate(() => typeof window.tailwind),
        "undefined",
        "window.tailwind should not exist -- the CDN is gone",
      );
    } finally {
      await page3.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q&A section
//
// Three different failure modes, one test each.
//
// 1. A render bug (a group that never appears, a question lost) is invisible in
//    prose but obvious against the declared counts.
// 2. A *false capability claim*. This is the one that matters: someone searching
//    "duress" or "steganography" lands on this section, and a recipe naming a
//    command the CLI does not have teaches a command that fails closed. The
//    commands in `APP_DATA.commands[]` are transcribed from src/cli/index.ts,
//    so cross-checking every command token a Q&A code block mentions is a real
//    guard rather than a formality.
// 3. The house rule that no markup is built as a string in JS.
// ─────────────────────────────────────────────────────────────────────────────
describe("Q&A renders and stays honest", () => {
  test("every declared question is rendered exactly once", async () => {
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".faq-item", { timeout: 5000 });
    const counts = await page.evaluate(() => ({
      groups: document.querySelectorAll("#faq-groups .faq-group").length,
      declaredGroups: window.APP_DATA.qa!.length,
      items: document.querySelectorAll("#faq-groups .faq-item").length,
      declaredItems: window.APP_DATA.qa!.reduce(
        (n, g) => n + g.items.length,
        0,
      ),
      // A question whose <details> never got an open path is broken: it would
      // show a chevron that does nothing.
      summaries: document.querySelectorAll("#faq-groups .faq-q").length,
      // Each category needs a chip, plus the "All" chip.
      chips: document.querySelectorAll("#faq-filters .faq-filter-btn").length,
    }));
    assert.equal(counts.groups, counts.declaredGroups, "Q&A groups mismatched");
    assert.equal(
      counts.items,
      counts.declaredItems,
      "Q&A questions mismatched",
    );
    assert.equal(
      counts.summaries,
      counts.declaredItems,
      "a question is missing its <summary>",
    );
    assert.equal(
      counts.chips,
      counts.declaredGroups + 1,
      "expected one chip per category plus 'All'",
    );
  });

  test("search and category filters narrow the list", async () => {
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".faq-item", { timeout: 5000 });
    const visibleCount = () =>
      page.evaluate(
        () =>
          document.querySelectorAll("#faq-groups .faq-item").length -
          document.querySelectorAll("#faq-groups .faq-item.hidden-row").length,
      );

    const total = await visibleCount();
    assert.ok(total > 20, `expected a substantial Q&A, saw ${total}`);

    // Search matches on the answer text too, not only the question line: a
    // visitor looking for "keyfile" must find the recipe, and the word appears
    // in answers as well as in one question.
    await page.fill("#faq-search", "keyfile");
    const searched = await visibleCount();
    assert.ok(
      searched > 0 && searched < total,
      `search for "keyfile" matched ${searched} of ${total}`,
    );

    await page.fill("#faq-search", "zzzz-no-such-question");
    assert.equal(
      await visibleCount(),
      0,
      "a nonsense search must match nothing",
    );
    assert.equal(
      await page.evaluate(() => !document.getElementById("faq-empty")!.hidden),
      true,
      "the empty state must appear when nothing matches",
    );

    await page.fill("#faq-search", "");
    await page.click('#faq-filters .faq-filter-btn[data-category="privacy"]');
    const filtered = await page.evaluate(() => ({
      visibleGroups: Array.from(
        document.querySelectorAll("#faq-groups .faq-group"),
      ).filter((g) => !(g as HTMLElement).hidden).length,
      pressed: document
        .querySelector('#faq-filters .faq-filter-btn[data-category="privacy"]')!
        .getAttribute("aria-pressed"),
    }));
    assert.equal(
      filtered.visibleGroups,
      1,
      "a category chip should hide the rest",
    );
    assert.equal(filtered.pressed, "true", "the chip must report aria-pressed");
  });

  test("no markup is built as a string in JS", () => {
    // docs/AGENTS.md: no innerHTML, no template literals containing tags. The
    // copy button's ✓ used to be swapped in through innerHTML; it is CSS now.
    const js = fs.readFileSync(path.join(DOCS_DIR, "index.js"), "utf8");
    const offenders = js
      .split("\n")
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(
        ({ text }) =>
          /\.innerHTML/.test(text) ||
          /`[^`]*<\/?[a-z][a-z0-9]*[\s>]/i.test(text) ||
          /insertAdjacentHTML/.test(text),
      )
      .map(({ line, text }) => `${line}: ${text.trim()}`);
    assert.deepEqual(
      offenders,
      [],
      `docs/index.js builds markup as strings:\n  ${offenders.join("\n  ")}`,
    );
  });

  test("every shadow-bit command in a Q&A recipe exists in the CLI reference", () => {
    // Cross-check the two lists that are both maintained by hand in data.js.
    // `commands[].cmd` looks like "create <name>", so the subcommand is the
    // first word of each entry.
    //
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(DOCS_DIR, "data.js"), "utf8"),
      sandbox,
    );
    const data = readAppData() as unknown as {
      commands: { cmd: string }[];
      qa?: { items: { q?: string; code?: string }[] }[];
    };

    const known = new Set(data.commands.map((c) => c.cmd.split(/\s+/)[0]));
    // Shell built-ins the recipes legitimately use alongside shadow-bit.
    const notACommand = new Set([
      "export",
      "cp",
      "rsync",
      "ls",
      "git",
      "npm",
      "cd",
      "chmod",
      "sudo",
      "ln",
      "echo",
      "curl",
      "npx",
      "node",
      "head",
      "cat",
      "mkdir",
      "dd",
    ]);

    const unknown: string[] = [];
    for (const g of data.qa ?? []) {
      for (const item of g.items) {
        for (const token of (item.code ?? "").matchAll(
          /(?:^|\s)\.\/shadow-bit\s+([a-z][a-z-]*)/g,
        )) {
          const cmd = token[1];
          if (!known.has(cmd) && !notACommand.has(cmd)) {
            unknown.push(`"${cmd}" in the recipe for: ${item.q ?? "(no q)"}`);
          }
        }
      }
    }
    assert.deepEqual(
      unknown,
      [],
      `Q&A recipes invoke commands absent from APP_DATA.commands:\n  ${unknown.join("\n  ")}`,
    );
  });
});

describe("vendored utilities behave like the Tailwind build", () => {
  test("translate utilities compose instead of collapsing to none", async () => {
    // Regression guard for a real bug found during the CDN removal.
    //
    // The vendored rule reads:
    //   transform: translate(var(--tw-translate-x), ...) rotate(var(--tw-rotate)) ...
    // If any of those custom properties is undefined, the entire declaration
    // is invalid at computed-value time and the element falls back to
    // `transform: none`. That silently un-centred .scroll-indicator (left-1/2
    // -translate-x-1/2) by 3px -- invisible in a casual look, obvious here.
    await page.reload({ waitUntil: "load" });
    const collapsed = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[class*='translate-']"),
      )
        .filter((el) => getComputedStyle(el).transform === "none")
        .map((el) => el.className.toString()),
    );
    assert.deepEqual(
      collapsed,
      [],
      `these translate utilities collapsed to transform:none: ${collapsed.join(", ")}`,
    );
  });

  test("every class used in index.html resolves to a real CSS rule", () => {
    // The failure mode this guards against: someone adds a Tailwind utility to
    // index.html that nobody vendored into utilities.css. It renders
    // unstyled and nothing else fails. Component classes live in index.css, so
    // the invariant is simply "defined in one of the two stylesheets".
    const indexHtml = fs.readFileSync(INDEX_HTML, "utf8");
    const css = ["index.css", "utilities.css"]
      .map((f) => fs.readFileSync(path.join(DOCS_DIR, f), "utf8"))
      .join("\n");

    // Every class selector in either stylesheet, unescaped.
    const defined = new Set<string>();
    for (const m of css.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)) {
      defined.add(m[1].replace(/\\(.)/g, "$1"));
    }
    const used = new Set<string>();
    for (const m of indexHtml.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }

    assert.ok(
      defined.size > 100,
      "extracted almost no selectors; check the regex",
    );
    const undefinedClasses = [...used].filter((c) => !defined.has(c)).sort();
    assert.deepEqual(
      undefinedClasses,
      [],
      `classes in index.html with no rule in index.css or utilities.css: ${undefinedClasses.join(", ")}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-user page carries no technology stack
//
// docs/index.html is the page someone lands on from a search engine with the
// intent to encrypt a folder. It once told them to `git clone` a repository,
// install Node.js 20+, and run npm scripts, because the install section was
// written for contributors. That is the wrong page for that content, and the
// split is enforced by hand — so it needs a tripwire.
//
// The contributor material lives on docs/dev.html, which is deliberately NOT
// exempt: this asserts the main page is clean, not that the dev page is
// thorough. `npm install -g shadow-bit` IS allowed, because the CLI is a
// user-facing interface, not a development detail.
// ─────────────────────────────────────────────────────────────────────────────
describe("index.html is written for end users, not contributors", () => {
  // Matched against the rendered source of the main page only. data.js is
  // shared with dev.html and legitimately still holds devSetup/architecture.
  const BANNED: [RegExp, string][] = [
    [/\belectron\b/i, "Electron"],
    [/\bnode\.?js\b/i, "Node.js"],
    [/\btypescript\b/i, "TypeScript"],
    // `npm install -g shadow-bit` is deliberately NOT matched: installing the
    // CLI is how a terminal user gets the app, not a development detail.
    [/\bnpm\s+(run|ci|install(?!\s+-g)\b)/, "an npm script/dependency install"],
    [/\bgit clone\b/i, "git clone"],
    [/\btailwind\b/i, "Tailwind"],
  ];

  test("no tech-stack vocabulary appears on the page", async () => {
    await page.reload({ waitUntil: "load" });
    const text = await page.evaluate(() => document.body.innerText);
    const hits = BANNED.filter(([re]) => re.test(text)).map(
      ([, label]) => label,
    );
    assert.deepEqual(
      hits,
      [],
      `index.html shows developer content to end users: ${hits.join(", ")}`,
    );
  });

  test("the CLI install line is the one npm command allowed", async () => {
    // Guarding the exception so the rule above does not quietly become "no npm
    // at all": installing the CLI is how a terminal user gets the app.
    await page.reload({ waitUntil: "load" });
    const cliInstall = await page.evaluate(
      () => document.querySelector("#cli-install")?.textContent ?? "",
    );
    assert.match(cliInstall, /npm install -g shadow-bit/);
  });

  test("every GitHub link in docs/ names the same repo as package.json", () => {
    // Owner-name casing is not cosmetic: GitHub does NOT redirect on it, so
    // "lucianvuc/shadow-bit" 404s while "luciVuc/shadow-bit" resolves. Every
    // download link is built from APP_DATA.releases.repo, so one wrong
    // character here takes down every download on the site -- and the live site
    // shipped exactly that, with a passing test suite, because the existing
    // assertions only checked that the URL was well-formed and carried the
    // right version.
    //
    // This is the offline half of the guard; `npm run sync-repo-url` is the
    // networked/CI half and can also rewrite the literals.
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
    );
    const expected = /github\.com[/:]([^/]+\/[^/.]+)/.exec(
      pkg.repository.url,
    )?.[1];
    assert.ok(expected, "could not read the repo owner from package.json");

    for (const file of ["data.js", "index.html", "dev.html"]) {
      const body = fs.readFileSync(path.join(DOCS_DIR, file), "utf8");
      // Any GitHub org/repo pair named in this file must be the same one.
      const found = new Set(
        [...body.matchAll(/github\.com\/([^/"\s]+\/[^/"\s.#]+)/g)].map(
          (m) => m[1],
        ),
      );
      for (const repo of found) {
        assert.equal(
          repo,
          expected,
          `docs/${file} links to ${repo}, but package.json says ${expected}. ` +
            "GitHub does not redirect on owner-name case, so these downloads " +
            "would 404.",
        );
      }
    }
  });

  test("the contributor page exists and is linked from the footer", () => {
    const devHtml = path.join(DOCS_DIR, "dev.html");
    assert.ok(fs.existsSync(devHtml), "docs/dev.html is missing");
    const index = fs.readFileSync(INDEX_HTML, "utf8");
    assert.ok(
      index.includes('href="dev.html"'),
      "index.html must offer a route to the contributor docs",
    );
    // …but not from the main navigation: a visitor who clicked Features should
    // never be offered a build tutorial.
    const nav = index.slice(index.indexOf("<nav"), index.indexOf("</nav>"));
    assert.ok(
      !nav.includes("dev.html"),
      "dev.html must stay out of the main navigation",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Downloads
//
// A download link that 404s is worse than no download section: it is the
// primary call to action and it looks fine until it is clicked. Three separate
// ways to get that wrong, one test each.
// ─────────────────────────────────────────────────────────────────────────────
describe("download links are built to survive a version bump", () => {
  test("every artifact link carries the selected version in tag and name", async () => {
    await page.reload({ waitUntil: "load" });
    // "attached", not "visible": links for the two platforms that are not the
    // open tab are inside a display:none panel, and this test reads all of them.
    await page.waitForSelector(".download-build", {
      state: "attached",
      timeout: 5000,
    });

    const check = async (version: string) => {
      await page.click(`.version-chip[data-version="${version}"]`);
      await page.waitForTimeout(150);
      return page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLAnchorElement>(".download-build"),
        ).map((a) => ({
          href: a.getAttribute("href") ?? "",
          label: a.getAttribute("aria-label") ?? "",
        })),
      );
    };

    // Read the versions from the data rather than hardcoding them: a pinned
    // "1.1.3" here went stale the moment the app reached 1.1.4 and failed this
    // suite for a reason that had nothing to do with what it checks. Probe the
    // oldest and newest listed, which is where drift would show.
    const { current, oldest } = await page.evaluate(() => {
      const chips = Array.from(
        document.querySelectorAll<HTMLElement>(".version-chip"),
      ).map((c) => c.dataset.version ?? "");
      return {
        current: chips[0],
        oldest: chips[chips.length - 1],
      };
    });
    assert.ok(current && oldest, "no version chips rendered");

    for (const version of [oldest, current]) {
      const links = await check(version);
      assert.ok(links.length >= 4, "expected links for every platform");
      for (const { href, label } of links) {
        // Both halves matter. A tag for one version with another version's
        // file name in it 404s, and that is exactly the drift this catches.
        assert.ok(
          href.includes(`/releases/download/v${version}/`),
          `link does not point at tag v${version}: ${href}`,
        );
        assert.ok(
          href.includes(encodeURIComponent(version).replace(/%20/g, " ")) ||
            href.includes(version),
          `link does not name version ${version} in the artifact: ${href}`,
        );
        // The accessible name has to name the version too, or a screen reader
        // announces a link that gives no version away.
        assert.ok(
          label.includes(version),
          `link aria-label omits the version: ${label}`,
        );
      }
    }
  });

  test("artifact file names are never hand-written URLs", () => {
    // data.js stores bare file names; index.js composes the URL. A full URL
    // pasted into data.js is the drift this rule exists to prevent, because
    // nothing rewrites a URL on `npm version` but everything rewrites a name.
    const data = fs.readFileSync(path.join(DOCS_DIR, "data.js"), "utf8");
    const inBuilds = data.slice(
      data.indexOf("platforms: ["),
      data.indexOf("cliInstall:"),
    );
    assert.ok(
      !/https?:\/\//.test(inBuilds),
      "data.js platforms[] contains a literal URL; store the file name only",
    );
  });

  test("every platform tab stays reachable — detection is a hint", async () => {
    // The page detects the OS and opens that tab. If detection ever became a
    // filter, a Linux visitor on a Mac (or a bot, whose UA says nothing) would
    // be shown a download they cannot use and no way to switch.
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".install-tab-btn", { timeout: 5000 });
    const platforms = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".install-tab-btn")).map(
        (b) => (b as HTMLElement).dataset.tab,
      ),
    );
    assert.equal(platforms.length, 3, "expected macOS / Windows / Linux tabs");
    for (const id of platforms) {
      const panelVisible = await page.evaluate((pid) => {
        const btn = document.querySelector(
          `.install-tab-btn[data-tab="${pid}"]`,
        ) as HTMLElement;
        btn.click();
        return (
          document
            .querySelector(`.install-panel[data-panel="${pid}"]`)
            ?.classList.contains("active") ?? false
        );
      }, id);
      assert.ok(panelVisible, `platform tab ${id} did not open its panel`);
    }
  });

  test("the version list leads with the current app version", () => {
    const data = readAppData();
    const versions = data.releases.versions;
    assert.ok(
      versions.length > 0,
      "expected at least one previous release listed",
    );
    // The current version must NOT be in the history array, and the history
    // must be keyed `release` rather than `version`. `npm version` anchors the
    // current version on the text `version: "`, so a history entry spelled that
    // way would be rewritten too: a bump would turn 1.0.0 into the new version
    // and the site would advertise a build that does not exist. index.js
    // prepends meta.version instead (see allVersions()).
    assert.ok(
      !versions.some((v) => v.release === data.meta.version),
      "the current version must not be duplicated in releases.versions",
    );
    for (const v of versions) {
      assert.equal(
        (v as unknown as { version?: string }).version,
        undefined,
        `history entry ${v.release} is keyed "version"; it must be "release" ` +
          "or `npm version` will rewrite it",
      );
    }
    // Sanity-check the version bump reaches the download names.
    for (const p of data.platforms) {
      for (const b of p.builds) {
        assert.ok(
          b.file.includes(data.meta.version),
          `artifact ${b.file} does not embed the current version`,
        );
      }
    }
  });

  test("npm version leaves the release history alone", () => {
    // The failure this guards is destructive and quiet. `npm version` rewrites
    // every anchored version literal in docs/data.js. If the release history
    // were listed in the same shape as the current version, the next bump would
    // rewrite 1.0.0 -> 1.1.4 as well: the site would offer a download for a
    // build that never existed, and lose the real 1.0.0 from the list.
    //
    // This replays the rewrite the real module performs, using its own site
    // definitions rather than a hand-written string replace -- a naive replace
    // is the thing that "proved" either answer depending on how it was written,
    // and would not have caught this bug.
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()[\]|\\]/g, "\\$&");
    const current = readAppData().meta.version;
    const next = "9.9.9";

    let bumped = fs.readFileSync(path.join(DOCS_DIR, "data.js"), "utf8");
    for (const site of LITERAL_SITES) {
      if (!site.file.endsWith("docs/data.js")) continue;
      const re = new RegExp(
        `${escapeRe(site.before)}(.+?)${escapeRe(site.after)}`,
        "g",
      );
      bumped = bumped.replace(
        re,
        // Re-emit the whole match, anchors included. Replacing with the bare
        // version drops `site.before`/`site.after` -- the surrounding quotes --
        // and produces a syntax error, which is exactly what happened the first
        // time this test was written.
        (_match, cur: string) => {
          const want = site.transform ? site.transform(next) : next;
          return `${site.before}${want}${site.after}`;
        },
      );
    }

    const after: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(bumped, after);
    const data = after.window.APP_DATA as ReturnType<typeof readAppData>;

    assert.equal(data.meta.version, next, "meta.version must follow the bump");
    assert.deepEqual(
      Array.from(data.releases.versions, (v) => v.release),
      Array.from(readAppData().releases.versions, (v) => v.release),
      "a version bump rewrote the release history",
    );
    for (const p of data.platforms) {
      for (const b of p.builds) {
        assert.ok(
          b.file.includes(next),
          `artifact ${b.file} did not follow the version bump`,
        );
      }
    }
  });
});
