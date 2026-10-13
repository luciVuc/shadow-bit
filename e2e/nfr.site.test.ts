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
    // data.js is evaluated rather than JSON.parse'd: it is a script that assigns
    // a global, and a regex that strips comments to make it parseable breaks the
    // moment a string value contains "//" (a URL, say).
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(DOCS_DIR, "data.js"), "utf8"),
      sandbox,
    );
    const data = sandbox.window.APP_DATA as {
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
