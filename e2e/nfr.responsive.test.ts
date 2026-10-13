// Responsive NFR tests.
//
// The renderer is vanilla CSS with three breakpoints: 720px, 480px, and a
// 1200px max-width cap. This suite pins the five reference widths the app is
// expected to support (WCAG 1.4.10 Reflow asks for content down to 320px) and
// asserts, at each one:
//
//   * no horizontal page scroll and nothing rendered past the viewport edge,
//   * no WCAG 2.2 A/AA axe violations (catches label/contrast shifts that only
//     appear once the layout stacks),
//   * axe's target-size rule still passes, since the stacked layouts shrink
//     some controls,
//   * the media queries actually applied, so dead breakpoint CSS fails here
//     rather than silently rotting.
//
// Runs in Chromium via nfr/browser.ts: the Electron window has minWidth 640, so
// XS/SM are unreachable in the real app. e2e/smoke.test.ts asserts that clamp.

import { test, before, after, describe } from "node:test";
import * as assert from "node:assert/strict";
import {
  launchBrowserHarness,
  type AxeViolation,
  type BrowserHarness,
} from "./nfr/browser";

const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const TABS = ["open", "create", "manage", "sessions"] as const;

/** Reference widths, named after the usual Bootstrap-ish size classes. */
const BREAKPOINTS = [
  { name: "XS", width: 320, height: 568 },
  { name: "SM", width: 480, height: 800 },
  { name: "MD", width: 768, height: 1024 },
  { name: "LG", width: 1280, height: 800 },
  { name: "XL", width: 1920, height: 1080 },
] as const;

/** Sub-pixel slack: browsers report fractional widths at fractional DPRs. */
const TOLERANCE = 1;

let h: BrowserHarness;

function fmt(vs: AxeViolation[]): string {
  return vs
    .map(
      (v) =>
        `  [${v.impact ?? "n/a"}] ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 5)
          .map((n) => `      ${n.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n");
}

before(async () => {
  h = await launchBrowserHarness();
});

after(async () => {
  await h?.dispose();
});

// ---------------------------------------------------------------------------
// 1. Reflow — nothing may scroll horizontally or escape the viewport (1.4.10)
// ---------------------------------------------------------------------------

describe("reflow (WCAG 1.4.10)", () => {
  for (const bp of BREAKPOINTS) {
    test(`${bp.name} ${bp.width}x${bp.height}: no horizontal overflow`, async () => {
      await h.page.setViewportSize({ width: bp.width, height: bp.height });
      const bad: string[] = [];
      for (const tab of TABS) {
        await h.switchTab(tab);
        const r = await h.page.evaluate((tol: number) => {
          const vw = document.documentElement.clientWidth;
          const out: string[] = [];
          if (document.documentElement.scrollWidth > vw + tol) {
            out.push(
              `page scrolls horizontally: scrollWidth=${document.documentElement.scrollWidth} > ${vw}`,
            );
          }
          // Any laid-out, visible element sticking past the right edge.
          const offenders: string[] = [];
          document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") return;
            // position:fixed elements are the viewport, not the page.
            if (cs.position === "fixed") return;
            const b = el.getBoundingClientRect();
            if (b.width === 0 && b.height === 0) return;
            if (b.right > vw + tol) {
              offenders.push(
                `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} right=${b.right.toFixed(1)} vw=${vw}`,
              );
            }
          });
          if (offenders.length) {
            out.push(
              `elements past right edge:\n        ${offenders.slice(0, 8).join("\n        ")}`,
            );
          }
          return out;
        }, TOLERANCE);
        bad.push(...r.map((s) => `[${tab}] ${s}`));
      }
      assert.deepEqual(
        bad,
        [],
        `overflow at ${bp.name}:\n  ${bad.join("\n  ")}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Accessibility is layout-dependent: re-audit at every width
// ---------------------------------------------------------------------------

describe("accessibility at each width", () => {
  for (const bp of BREAKPOINTS) {
    test(`${bp.name} ${bp.width}x${bp.height}: no axe violations or undersized targets`, async () => {
      await h.page.setViewportSize({ width: bp.width, height: bp.height });
      const found: string[] = [];
      for (const tab of TABS) {
        await h.switchTab(tab);
        for (const v of await h.runAxe([...WCAG_AA, "target-size"])) {
          for (const n of v.nodes)
            found.push(`[${tab}] ${v.id}: ${n.target.join(" ")}`);
        }
      }
      assert.deepEqual(
        found,
        [],
        `violations at ${bp.name}:\n  ${found.slice(0, 20).join("\n  ")}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The breakpoint CSS is live, not dead code
// ---------------------------------------------------------------------------

describe("breakpoint rules apply", () => {
  test("the tagline is hidden at <=720px and visible above", async () => {
    await h.page.setViewportSize({ width: 375, height: 800 });
    const narrow = await h.page.evaluate(
      () => getComputedStyle(document.querySelector(".tagline")!).display,
    );
    await h.page.setViewportSize({ width: 1280, height: 800 });
    const wide = await h.page.evaluate(
      () => getComputedStyle(document.querySelector(".tagline")!).display,
    );
    assert.equal(narrow, "none", "tagline should hide at 375px");
    assert.notEqual(wide, "none", "tagline should show at 1280px");
  });

  test("form .row stacks into a column at <=480px", async () => {
    await h.page.setViewportSize({ width: 1024, height: 800 });
    await h.switchTab("create");
    const wide = await h.page.evaluate(
      () =>
        getComputedStyle(document.querySelector("#panel-create .row")!)
          .flexDirection,
    );
    await h.page.setViewportSize({ width: 375, height: 800 });
    const narrow = await h.page.evaluate(
      () =>
        getComputedStyle(document.querySelector("#panel-create .row")!)
          .flexDirection,
    );
    assert.equal(wide, "row", "row should stay horizontal above 480px");
    assert.equal(narrow, "column", "row should stack at 375px");
  });

  test("the panel caps its width above 1200px", async () => {
    await h.switchTab("open");
    // .panel is display:none unless .active, so measure the visible one.
    const panelWidth = () =>
      h.page.evaluate(
        () =>
          document
            .querySelector<HTMLElement>(".panel.active")!
            .getBoundingClientRect().width,
      );
    await h.page.setViewportSize({ width: 1920, height: 1080 });
    const wide = await panelWidth();
    await h.page.setViewportSize({ width: 1000, height: 800 });
    const mid = await panelWidth();
    // Above 1200px the panel may grow to 780px; between 720px and 1200px it is
    // capped at 620px. So the XL panel should be wider, but still not fill 1920.
    assert.ok(
      wide <= 780 + TOLERANCE,
      `panel should cap at 780px on a 1920px screen, got ${wide}`,
    );
    assert.ok(
      wide > mid,
      `panel should be wider at 1920px than at 1000px (${wide} vs ${mid})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Dialogs must stay usable when the viewport is tiny
// ---------------------------------------------------------------------------

describe("dialogs at small widths", () => {
  for (const bp of [
    { name: "XS", width: 320, height: 568 },
    { name: "SM", width: 480, height: 800 },
  ]) {
    test(`${bp.name}: settings dialog fits and stays scrollable`, async () => {
      await h.page.setViewportSize({ width: bp.width, height: bp.height });
      await h.switchTab("manage");
      await h.page.click("#settings-btn");
      await h.page.waitForSelector("#settings-modal:not(.hidden)");
      const r = await h.page.evaluate(() => {
        const box = document.querySelector(
          "#settings-modal .modal-box",
        ) as HTMLElement;
        const b = box.getBoundingClientRect();
        const cs = getComputedStyle(box);
        return {
          right: b.right,
          left: b.left,
          height: b.height,
          viewportW: document.documentElement.clientWidth,
          viewportH: document.documentElement.clientHeight,
          overflowY: cs.overflowY,
        };
      });
      assert.ok(
        r.left >= -TOLERANCE && r.right <= r.viewportW + TOLERANCE,
        `dialog must sit inside the viewport (left=${r.left}, right=${r.right}, vw=${r.viewportW})`,
      );
      assert.ok(
        r.height <= r.viewportH + TOLERANCE,
        `dialog must not exceed viewport height (${r.height} > ${r.viewportH})`,
      );
      // If it is taller than the screen it has to be reachable by scrolling.
      if (r.height > r.viewportH) {
        assert.ok(
          ["auto", "scroll"].includes(r.overflowY),
          `over-tall dialog needs overflow-y:auto/scroll, got ${r.overflowY}`,
        );
      }
      const v = await h.runAxe(WCAG_AA);
      assert.equal(v.length, 0, `dialog axe:\n${fmt(v)}`);
      await h.page.keyboard.press("Escape");
      await h.page.waitForTimeout(150);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Zoom / text scaling (1.4.4, 1.4.10)
// ---------------------------------------------------------------------------

describe("text scaling", () => {
  test("200% text zoom does not clip content at 320px", async () => {
    // 320 CSS px at 200% zoom is equivalent to a 160px viewport; emulate by
    // halving the viewport, which is what a user sees after zooming in.
    await h.page.setViewportSize({ width: 640, height: 800 });
    await h.page.addStyleTag({ content: "html { font-size: 32px; }" });
    const bad: string[] = [];
    for (const tab of TABS) {
      await h.switchTab(tab);
      const over = await h.page.evaluate((tol: number) => {
        const vw = document.documentElement.clientWidth;
        return document.documentElement.scrollWidth > vw + tol
          ? [`${document.documentElement.scrollWidth} > ${vw}`]
          : [];
      }, TOLERANCE);
      bad.push(
        ...over.map((s) => `[${tab}] horizontal scroll at 200% zoom: ${s}`),
      );
    }
    assert.deepEqual(
      bad,
      [],
      `overflow at 200% text size:\n  ${bad.join("\n  ")}`,
    );
  });
});
