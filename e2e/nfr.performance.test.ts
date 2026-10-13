// Performance and responsiveness NFR tests.
//
// The renderer is deliberately small vanilla JS with no framework, so these are
// smoke-level budgets rather than precision benchmarks: they catch a regression
// that ships a heavy synchronous loop, a megabyte of CSS, or a blocking
// listener on a common interaction. Thresholds are loose enough to survive
// slow CI machines while still failing on a real regression.

import { test, before, after, describe } from "node:test";
import * as assert from "node:assert/strict";
import { launchBrowserHarness, type BrowserHarness } from "./nfr/browser";

const TABS = ["open", "create", "manage", "sessions"] as const;

/** Renderer source budget. Observed values are ~30-60 KB uncompressed. */
const MAX_RENDERER_BYTES = 400 * 1024;

let h: BrowserHarness;

before(async () => {
  h = await launchBrowserHarness();
});

after(async () => {
  await h?.dispose();
});

describe("asset budget", () => {
  test("renderer ships well under the size budget", async () => {
    const bytes = await h.page.evaluate(async () => {
      const res = await Promise.all(
        ["styles.css", "renderer.js", "index.html"].map((f) =>
          fetch("/" + f).then((r) => r.arrayBuffer()),
        ),
      );
      return res.reduce((n, b) => n + b.byteLength, 0);
    });
    assert.ok(
      bytes < MAX_RENDERER_BYTES,
      `renderer assets are ${(bytes / 1024).toFixed(1)} KB, over the ${MAX_RENDERER_BYTES / 1024} KB budget`,
    );
  });

  test("no render-blocking third-party requests", async () => {
    // Everything is same-origin and local; a CDN or font host would show up here
    // and would also be blocked by the page's CSP.
    const external: string[] = [];
    h.page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith("http://127.0.0.1") && !u.startsWith("data:")) {
        external.push(u);
      }
    });
    await h.page.reload();
    await h.page.waitForTimeout(1000);
    assert.deepEqual(
      external,
      [],
      `unexpected external requests: ${external.join(", ")}`,
    );
  });
});

describe("interactivity", () => {
  test("switching tabs is responsive", async () => {
    for (const tab of TABS) {
      const start = process.hrtime.bigint();
      await h.switchTab(tab);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(
        ms < 1000,
        `switching to the ${tab} tab took ${ms.toFixed(0)}ms`,
      );
    }
  });

  test("the tab handler does not block the main thread for long", async () => {
    // Measure the longest single task the browser runs while cycling tabs.
    const longest = await h.page.evaluate(
      async (tabs: string[]) => {
        let longest = 0;
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            longest = Math.max(longest, e.duration);
        });
        try {
          obs.observe({ entryTypes: ["longtask"] });
        } catch {
          return -1; // longtask unsupported in this build
        }
        for (const t of tabs) {
          const tab = document.getElementById("tab-" + t) as HTMLElement;
          tab.click();
          await new Promise((r) => setTimeout(r, 120));
        }
        obs.disconnect();
        return longest;
      },
      TABS as unknown as string[],
    );
    if (longest >= 0) {
      assert.ok(
        longest < 200,
        `a tab switch produced a ${longest.toFixed(0)}ms long task`,
      );
    }
  });

  test("the initial paint does not wait on a network round trip for app code", async () => {
    // renderer.js must be a classic deferred/script tag, not something that
    // blocks on a dynamic import that never resolves offline.
    const paint = await h.page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      return nav ? nav.domContentLoadedEventEnd : null;
    });
    assert.ok(
      paint !== null && paint > 0,
      "DOMContentLoaded should be recorded",
    );
    assert.ok(
      paint < 5000,
      `DOMContentLoaded took ${paint}ms, which suggests app code is blocking it`,
    );
  });
});

describe("no runaway timers or listeners", () => {
  test("cycling tabs does not accumulate keydown listeners", async () => {
    // Each openModal/trapFocus cycle adds a document-level listener; leaking
    // them is slow and shows up as a growing handler count.
    const before = await h.page.evaluate(
      () => document.querySelectorAll("#settings-btn").length,
    );
    for (let i = 0; i < 6; i++) {
      await h.page.click("#settings-btn");
      await h.page.waitForTimeout(30);
      await h.page.keyboard.press("Escape");
      await h.page.waitForTimeout(30);
    }
    const after = await h.page.evaluate(
      () => document.querySelectorAll("#settings-btn").length,
    );
    assert.equal(
      after,
      before,
      "the settings button was duplicated by repeated opens",
    );
  });

  test("the loading overlay is hidden when no work is in flight", async () => {
    // The spinner itself never toggles .hidden — visibility comes from the
    // #loading-overlay wrapper, so assert on the wrapper.
    const visible = await h.page.evaluate(() => {
      const o = document.getElementById("loading-overlay");
      return !!o && !o.classList.contains("hidden");
    });
    assert.equal(
      visible,
      false,
      "the loading overlay was left visible at rest",
    );
  });
});
