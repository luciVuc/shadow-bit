// Accessibility NFR tests — WCAG 2.2 AA.
//
// Two layers:
//   1. axe-core, automated, across every tab, both colour schemes, plus each
//      dialog.
//   2. Hand-written assertions for what axe cannot judge: keyboard operability,
//      focus order, focus visibility, dialog focus trapping and restoration,
//      and target size (WCAG 2.2 adds 2.5.8 Target Size (Minimum) at AA).
//
// Runs against the real renderer DOM/CSS/JS in Chromium — see nfr/browser.ts
// for why. axe is a floor, not proof of conformance.

import { test, before, after, afterEach, describe } from "node:test";
import * as assert from "node:assert/strict";
import {
  launchBrowserHarness,
  type AxeViolation,
  type BrowserHarness,
} from "./nfr/browser";

/** WCAG 2.2 levels A + AA (2.2's new AA rules are under the `wcag22aa` tag). */
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Tab ids in DOM order — keep in sync with index.html. */
const TABS = ["open", "create", "manage", "sessions"] as const;
const SCHEMES = ["dark", "light"] as const;

let h: BrowserHarness;

function fmt(vs: AxeViolation[]): string {
  return vs
    .map(
      (v) =>
        `  [${v.impact ?? "n/a"}] ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 5)
          .map(
            (n) =>
              `      ${n.target.join(" ")}\n        ${(n.failureSummary ?? "")
                .split("\n")
                .slice(0, 3)
                .join("\n        ")}`,
          )
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

/**
 * Reset anything a test injected into the live page.
 *
 * Without this, a test that opens a modal or builds the file-tree markup leaks
 * it into every test after it: the modal is a full-viewport overlay that
 * swallows the clicks `switchTab` makes, and the injected markup is audited by
 * the next test. Failures then cascade into unrelated suites, which is exactly
 * how a real defect gets buried under noise. A node:test hook registered at the
 * top of the file does NOT cover tests inside a `describe`, so each suite calls
 * this at its top.
 */
function resetInjectedDom() {
  afterEach(async () => {
    await h.page
      .evaluate(() => {
        for (const id of ["modal", "settings-modal", "welcome-modal"]) {
          document.getElementById(id)?.classList.add("hidden");
        }
        const list = document.getElementById("sessions-list");
        if (list) list.innerHTML = "";
        document.documentElement.removeAttribute("data-theme");
      })
      .catch(() => {
        /* page may be navigating; nothing to clean */
      });
  });
}

// ---------------------------------------------------------------------------
// 1. axe-core — WCAG 2.2 A/AA
// ---------------------------------------------------------------------------

describe("axe-core", () => {
  resetInjectedDom();
  for (const tab of TABS) {
    for (const scheme of SCHEMES) {
      test(`${tab} tab / ${scheme}: no WCAG 2.2 A/AA violations`, async () => {
        await h.page.emulateMedia({ colorScheme: scheme });
        await h.switchTab(tab);
        const v = await h.runAxe(WCAG_AA);
        assert.equal(v.length, 0, `${tab}/${scheme}:\n${fmt(v)}`);
      });
    }
  }

  test("no violations in either scheme at the default viewport", async () => {
    for (const scheme of SCHEMES) {
      await h.page.emulateMedia({ colorScheme: scheme });
      const v = await h.runAxe(WCAG_AA);
      assert.equal(v.length, 0, `${scheme}:\n${fmt(v)}`);
    }
  });

  // The two loops above drive the theme through `prefers-color-scheme`, which
  // only exercises the `@media` token block. A user who picks Light or Dark in
  // Settings gets `data-theme` on <html> instead, which is a SEPARATE block in
  // styles.css. That second block shipped its own strength ramp, and the copy in
  // it sat at ~2:1 on white — failing 1.4.3 on the strength label at every level
  // while the prefers-color-scheme sweep passed. Pin the attribute explicitly.
  for (const scheme of SCHEMES) {
    test(`data-theme="${scheme}" attribute: no WCAG 2.2 A/AA violations`, async () => {
      for (const tab of TABS) {
        await h.page.evaluate((s: string) => {
          document.documentElement.setAttribute("data-theme", s);
        }, scheme);
        await h.switchTab(tab);
        const v = await h.runAxe(WCAG_AA);
        assert.equal(v.length, 0, `data-theme=${scheme}/${tab}:\n${fmt(v)}`);
      }
      await h.page.evaluate(() =>
        document.documentElement.removeAttribute("data-theme"),
      );
    });
  }

  // The strength label only takes on a colour once a password is typed, so an
  // axe sweep of an empty form never looks at it. Walk every strength band in
  // the light theme, where the ramp has to be much darker to pass.
  test("password-strength label passes 1.4.3 at every strength band", async () => {
    // Lengths chosen to land in each band: very weak / weak / fair / strong /
    // very strong, across both themes and with a filled field.
    const samples = [
      "abc",
      "abcdefgh",
      "abcdefghijkl",
      "Abcdefghijklmnop",
      "Abcdefghijklmnopqrstuvwx",
    ];
    for (const scheme of SCHEMES) {
      for (const pw of samples) {
        await h.switchTab("create");
        await h.page.evaluate((s: string) => {
          document.documentElement.setAttribute("data-theme", s);
        }, scheme);
        await h.page.fill("#create-password", pw);
        const v = await h.runAxe(["color-contrast"]);
        assert.equal(
          v.length,
          0,
          `strength label for "${pw}" in ${scheme}:\n${fmt(v)}`,
        );
      }
    }
    await h.page.fill("#create-password", "");
    await h.page.evaluate(() =>
      document.documentElement.removeAttribute("data-theme"),
    );
  });

  test("focused-state violations: no violations while focus sits on a control", async () => {
    // Focus-dependent rules (focus-visible contrast, outline) only run on the
    // focused subtree, so a page with nothing focused would silently pass.
    await h.page.emulateMedia({ colorScheme: "dark" });
    await h.switchTab("open");
    await h.page.focus("#open-password");
    const v = await h.runAxe(WCAG_AA);
    assert.equal(v.length, 0, `focused control:\n${fmt(v)}`);
  });

  test("recovery-key modal: no violations while open", async () => {
    await h.page.emulateMedia({ colorScheme: "dark" });
    await h.switchTab("manage");
    // showRecoveryModal() is module-private and the stub's create path does not
    // reach it, so reveal the real static markup. Same DOM and CSS either way.
    await h.page.evaluate(() => {
      const m = document.getElementById("modal");
      m?.classList.remove("hidden");
      const k = document.getElementById("modal-key");
      if (k) k.textContent = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH";
    });
    await h.page.waitForTimeout(150);
    const v = await h.runAxe(WCAG_AA);
    assert.equal(v.length, 0, `recovery modal:\n${fmt(v)}`);
    await h.page.evaluate(() =>
      document.getElementById("modal")?.classList.add("hidden"),
    );
  });

  test("welcome/onboarding modal: no violations", async () => {
    await h.page.emulateMedia({ colorScheme: "dark" });
    await h.page.evaluate(() => {
      document.getElementById("welcome-modal")?.classList.remove("hidden");
    });
    await h.page.waitForTimeout(150);
    const v = await h.runAxe(WCAG_AA);
    assert.equal(v.length, 0, `welcome modal:\n${fmt(v)}`);
    await h.page.evaluate(() => {
      document.getElementById("welcome-modal")?.classList.add("hidden");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Structure and semantics
// ---------------------------------------------------------------------------

describe("structure", () => {
  resetInjectedDom();
  test("lang is declared and there is exactly one h1", async () => {
    const info = await h.page.evaluate(() => ({
      lang: document.documentElement.lang,
      h1s: document.querySelectorAll("h1").length,
    }));
    assert.equal(info.lang, "en", "html must declare a language");
    assert.equal(info.h1s, 1, "exactly one h1");
  });

  test("no duplicate ids (aria references depend on them)", async () => {
    const dupes = await h.page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll("[id]")).map(
        (e) => e.id,
      );
      return Array.from(new Set(ids.filter((id, i) => ids.indexOf(id) !== i)));
    });
    assert.deepEqual(dupes, []);
  });

  test("unique landmarks", async () => {
    const c = await h.page.evaluate(() => ({
      main: document.querySelectorAll("main").length,
      nav: document.querySelectorAll("nav").length,
      h1: document.querySelectorAll("main h1, main h2").length,
    }));
    assert.equal(c.main, 1, "exactly one <main>");
    assert.ok(c.nav >= 1, "there should be a <nav>");
  });

  test("tablist matches the WAI-ARIA authoring practices", async () => {
    const s = await h.page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return {
        count: tabs.length,
        hasList: !!document.querySelector('[role="tablist"]'),
        listNamed: !!document
          .querySelector('[role="tablist"]')
          ?.getAttribute("aria-label"),
        allControlled: tabs.every((t) => !!t.getAttribute("aria-controls")),
        selected: tabs.filter((t) => t.getAttribute("aria-selected") === "true")
          .length,
        roving: tabs.every((t) =>
          t.getAttribute("aria-selected") === "true"
            ? (t as HTMLElement).tabIndex === 0
            : (t as HTMLElement).tabIndex === -1,
        ),
      };
    });
    assert.ok(s.hasList, "tabs must live in a tablist");
    assert.ok(s.listNamed, "tablist needs an accessible name");
    assert.equal(s.count, TABS.length);
    assert.ok(s.allControlled, "each tab needs aria-controls");
    assert.equal(s.selected, 1, "exactly one tab is selected");
    assert.ok(s.roving, "roving tabindex: selected 0, others -1");
  });

  test("tabpanels are referenced by their tab", async () => {
    const ok = await h.page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="tabpanel"]')).every(
        (p) =>
          !!document.querySelector(`[role="tab"][aria-controls="${p.id}"]`),
      ),
    );
    assert.ok(ok);
  });

  test("every form control has an accessible name", async () => {
    const unnamed = await h.page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input, select, textarea").forEach((el) => {
        const id = el.id;
        const named =
          (id && !!document.querySelector(`label[for="${id}"]`)) ||
          !!el.getAttribute("aria-label") ||
          !!el.getAttribute("aria-labelledby") ||
          !!el.closest("label");
        if (!named) out.push(id || el.outerHTML.slice(0, 70));
      });
      return out;
    });
    assert.deepEqual(unnamed, [], `unnamed controls: ${unnamed.join(" | ")}`);
  });

  test("every button has an accessible name", async () => {
    const unnamed = await h.page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("button").forEach((b) => {
        const name =
          (b.textContent ?? "").trim() ||
          b.getAttribute("aria-label") ||
          b.getAttribute("title");
        if (!name) out.push(b.id || b.outerHTML.slice(0, 70));
      });
      return out;
    });
    assert.deepEqual(unnamed, [], `unnamed buttons: ${unnamed.join(" | ")}`);
  });

  test("decorative icons are hidden or labelled", async () => {
    const bad = await h.page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("svg").forEach((s) => {
        const ok =
          s.getAttribute("aria-hidden") === "true" ||
          s.getAttribute("role") === "presentation" ||
          !!s.closest("[aria-hidden='true']") ||
          !!s.getAttribute("aria-label");
        if (!ok)
          out.push(s.parentElement?.className || s.outerHTML.slice(0, 50));
      });
      return out;
    });
    assert.deepEqual(bad, [], `unhidden svgs: ${bad.join(" | ")}`);
  });

  test("status toasts use a live region", async () => {
    const live = await h.page.evaluate(() =>
      Array.from(document.querySelectorAll("[aria-live]")).map((e) => ({
        live: e.getAttribute("aria-live"),
        role: e.getAttribute("role"),
      })),
    );
    assert.ok(live.length > 0, "toasts need a live region");
    assert.ok(
      live.some((l) => l.live === "polite" || l.role === "status"),
      "a polite live region is required",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Keyboard (WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7)
// ---------------------------------------------------------------------------

describe("keyboard", () => {
  resetInjectedDom();
  test("arrow keys, Home and End move between tabs", async () => {
    await h.switchTab("open");
    await h.page.focus('[data-tab="open"]');

    await h.page.keyboard.press("ArrowRight");
    await h.page.waitForTimeout(120);
    assert.equal(
      await h.page.evaluate(() =>
        document.activeElement?.getAttribute("data-tab"),
      ),
      TABS[1],
      "ArrowRight → next tab",
    );

    await h.page.keyboard.press("End");
    await h.page.waitForTimeout(120);
    assert.equal(
      await h.page.evaluate(() =>
        document.activeElement?.getAttribute("data-tab"),
      ),
      TABS[TABS.length - 1],
      "End → last tab",
    );

    await h.page.keyboard.press("Home");
    await h.page.waitForTimeout(120);
    assert.equal(
      await h.page.evaluate(() =>
        document.activeElement?.getAttribute("data-tab"),
      ),
      TABS[0],
      "Home → first tab",
    );

    // Wraps backwards.
    await h.page.keyboard.press("ArrowLeft");
    await h.page.waitForTimeout(120);
    assert.equal(
      await h.page.evaluate(() =>
        document.activeElement?.getAttribute("data-tab"),
      ),
      TABS[TABS.length - 1],
      "ArrowLeft wraps to the last tab",
    );
  });

  test("focused input shows a visible focus indicator (2.4.7)", async () => {
    await h.switchTab("open");
    const r = await h.page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>("#open-password");
      if (!el) return null;
      el.focus();
      const cs = getComputedStyle(el);
      return {
        boxShadow: cs.boxShadow,
        outlineStyle: cs.outlineStyle,
        outlineWidth: parseFloat(cs.outlineWidth) || 0,
        borderColor: cs.borderTopColor,
      };
    });
    assert.ok(r, "#open-password must exist");
    const hasRing = r.boxShadow !== "none";
    const hasOutline = r.outlineStyle !== "none" && r.outlineWidth > 0;
    assert.ok(
      hasRing || hasOutline,
      `focused input has no indicator (box-shadow: ${r.boxShadow}, outline: ${r.outlineStyle} ${r.outlineWidth}px)`,
    );
  });

  test("buttons show a visible focus indicator (2.4.7)", async () => {
    await h.switchTab("open");
    // Reach the button with real Tab presses. A programmatic .focus() does not
    // engage :focus-visible in Chromium (it matches on keyboard interaction
    // modality), so focusing from script would report a false negative against
    // a ring that is correct for keyboard users.
    await h.page.evaluate(() => document.body.focus());
    let reached = false;
    for (let i = 0; i < 30 && !reached; i++) {
      await h.page.keyboard.press("Tab");
      reached = await h.page.evaluate(
        () => document.activeElement?.id === "open-browse",
      );
    }
    assert.ok(reached, "could not Tab to #open-browse");

    const r = await h.page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      return {
        matchedFocusVisible: el.matches(":focus-visible"),
        boxShadow: cs.boxShadow,
        outlineStyle: cs.outlineStyle,
        outlineWidth: parseFloat(cs.outlineWidth) || 0,
      };
    });
    assert.ok(
      r.matchedFocusVisible,
      ":focus-visible must match a keyboard-focused button",
    );
    const visible =
      r.boxShadow !== "none" ||
      (r.outlineStyle !== "none" && r.outlineWidth > 0);
    assert.ok(
      visible,
      `focused button has no indicator (boxShadow=${r.boxShadow}, outline=${r.outlineStyle} ${r.outlineWidth}px)`,
    );
  });

  test("no positive tabindex (2.4.3)", async () => {
    const bad = await h.page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[tabindex]"))
        .filter((e) => Number(e.getAttribute("tabindex")) > 0)
        .map((e) => e.id || e.className),
    );
    assert.deepEqual(bad, [], `positive tabindex: ${bad.join(", ")}`);
  });

  test("hidden tab panels are not focusable", async () => {
    for (const tab of TABS) {
      if (tab === "open") continue;
      const reachable = await h.page.evaluate((t) => {
        const panel = document.querySelector(`#panel-${t}`);
        if (!panel) return ["missing panel"];
        const hidden = panel.classList.contains("hidden");
        if (hidden) {
          const focusables = panel.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          return Array.from(focusables)
            .filter((e) => e.offsetParent !== null)
            .map((e) => `${t}:${e.id}`);
        }
        return [];
      }, tab);
      assert.deepEqual(
        reachable,
        [],
        `hidden panel ${tab} still exposes focusable elements`,
      );
    }
  });

  test("dialog traps focus and Escape closes it (2.1.2, 2.4.3)", async () => {
    await h.switchTab("manage");
    await h.page.click("#settings-btn");
    await h.page.waitForSelector("#settings-modal:not(.hidden)", {
      timeout: 8_000,
    });

    const insideAtOpen = await h.page.evaluate(() => {
      // Scope to #settings-modal: all three dialogs use role="dialog" and are
      // hidden by class, so a bare [role="dialog"] query matches the recovery
      // modal that comes first in the DOM.
      const d = document.getElementById("settings-modal");
      return !!d && d.contains(document.activeElement);
    });
    assert.ok(insideAtOpen, "focus should move into the dialog on open");

    let escapedAt: number | null = null;
    for (let i = 1; i <= 14; i++) {
      await h.page.keyboard.press("Tab");
      const stillIn = await h.page.evaluate(() => {
        const d = document.getElementById("settings-modal");
        return !!d && d.contains(document.activeElement);
      });
      if (!stillIn) {
        escapedAt = i;
        break;
      }
    }
    assert.equal(
      escapedAt,
      null,
      `focus escaped the dialog on Tab #${escapedAt}`,
    );

    await h.page.keyboard.press("Escape");
    await h.page.waitForTimeout(250);
    assert.ok(
      await h.page.evaluate(
        () =>
          document
            .getElementById("settings-modal")
            ?.classList.contains("hidden") !== false,
      ),
      "Escape should close the dialog",
    );
  });

  // The recovery-key modal is the one dialog whose focusable set CHANGES after
  // it opens: `#modal-ok` ships disabled and is enabled by the "I have saved it"
  // checkbox. A focus trap that snapshots first/last once excludes it, so Tab
  // from the last originally-focusable control walks straight past the new
  // button and out of a dialog that declares aria-modal="true".
  //
  // Driven through the real flow (create a vault → the recovery modal opens on
  // its own) rather than by unhiding the markup: showRecoveryModal() is
  // module-private and installs the ack handler, so a hand-built dialog would
  // never have its button enabled and the test would prove nothing.
  test("recovery-key modal still traps focus after ack enables its button", async () => {
    await h.switchTab("create");
    // `#create-path` is readonly — the real value arrives from the native save
    // dialog. Set it the way the Browse button does rather than typing it.
    await h.page.evaluate(() => {
      (document.getElementById("create-path") as HTMLInputElement).value =
        "/tmp/focus-test.svlt";
    });
    await h.page.fill("#create-password", "correct-horse-battery");
    await h.page.fill("#create-password2", "correct-horse-battery");
    await h.page.click("#create-go");
    await h.page.waitForSelector("#modal:not(.hidden)", { timeout: 8_000 });

    assert.ok(
      await h.page.isVisible("#modal-key"),
      "the recovery modal must show the key",
    );

    // The real handler only enables the button once the box is ticked.
    await h.page.check("#modal-ack-check");
    assert.ok(
      await h.page.isEnabled("#modal-ok"),
      "ticking the ack checkbox must enable the confirm button",
    );

    let escapedAt: number | null = null;
    let escapedTo = "";
    for (let i = 1; i <= 16; i++) {
      await h.page.keyboard.press("Tab");
      const state = await h.page.evaluate(() => {
        const d = document.getElementById("modal")!;
        const a = document.activeElement as HTMLElement | null;
        return {
          inside: !!a && d.contains(a),
          where: a ? `${a.tagName}#${a.id || a.className}` : "none",
        };
      });
      if (!state.inside) {
        escapedAt = i;
        escapedTo = state.where;
        break;
      }
    }
    assert.equal(
      escapedAt,
      null,
      `focus escaped the recovery modal on Tab #${escapedAt} (landed on ${escapedTo})`,
    );

    // Shift-Tab must wrap backwards too.
    await h.page.evaluate(() =>
      (document.querySelector("#modal-ack-check") as HTMLElement).focus(),
    );
    let escapedBack: number | null = null;
    for (let i = 1; i <= 16; i++) {
      await h.page.keyboard.press("Shift+Tab");
      const inside = await h.page.evaluate(() => {
        const d = document.getElementById("modal")!;
        return d.contains(document.activeElement);
      });
      if (!inside) {
        escapedBack = i;
        break;
      }
    }
    assert.equal(
      escapedBack,
      null,
      `focus escaped backwards on Shift+Tab #${escapedBack}`,
    );

    await h.page.evaluate(() =>
      document.getElementById("modal")!.classList.add("hidden"),
    );
  });

  test("every enabled control in a panel is keyboard reachable", async () => {
    for (const tab of TABS) {
      await h.switchTab(tab);
      const unreachable = await h.page.evaluate((t) => {
        const panel = document.querySelector(`#panel-${t}`);
        if (!panel) return [`${t}: missing`];
        const out: string[] = [];
        panel
          .querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
          )
          .forEach((el) => {
            const style = getComputedStyle(el);
            const invisible =
              style.display === "none" || style.visibility === "hidden";
            if (
              !invisible &&
              el.tabIndex < 0 &&
              el.getAttribute("aria-hidden") !== "true"
            ) {
              out.push(`${t}:${el.id || el.className || el.tagName}`);
            }
          });
        return out;
      }, tab);
      assert.deepEqual(
        unreachable,
        [],
        `not keyboard reachable: ${unreachable.join(", ")}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Target size — WCAG 2.2 AA (2.5.8, 24x24 CSS px)
// ---------------------------------------------------------------------------

describe("target size (WCAG 2.2 2.5.8)", () => {
  resetInjectedDom();
  // axe's target-size rule is the conformant check: it accepts a target that is
  // under 24x24 when a 24px circle centred on it does not intersect another
  // target's circle (the "spacing" exception). A raw getBoundingClientRect
  // comparison would report false positives on those, so use axe.
  for (const scheme of ["dark", "light"]) {
    test(`no undersized targets (${scheme})`, async () => {
      await h.page.evaluate((s: string) => {
        document.documentElement.setAttribute("data-theme", s);
      }, scheme);
      const violations: string[] = [];
      for (const tab of TABS) {
        await h.switchTab(tab);
        const found = await h.runAxe(["target-size"]);
        for (const v of found)
          for (const n of v.nodes)
            violations.push(
              `${tab}: ${n.target.join(" ")} :: ${n.failureSummary.replace(/\s+/g, " ")}`,
            );
      }
      assert.deepEqual(
        violations,
        [],
        `WCAG 2.2 2.5.8 target-size violations:\n  ${violations.join("\n  ")}`,
      );
    });
  }

  // The in-app file browser only exists once a vault is open, so no tab sweep
  // ever rendered it: its controls measured 15x18 / 12x18 (action buttons) and
  // 5x11 (the folder disclosure arrow). Build the real markup and audit it.
  test("file-tree controls meet 24x24 and are visible without a mouse", async () => {
    await h.switchTab("sessions");
    await h.page.evaluate(() => {
      const host = document.getElementById("sessions-list")!;
      host.innerHTML =
        '<div class="file-tree">' +
        '<div class="tree-item file">' +
        '<span class="tree-icon" aria-hidden="true">x</span>' +
        '<span class="tree-name">notes.txt</span>' +
        '<span class="tree-size">12 B</span>' +
        '<div class="tree-actions">' +
        '<button title="Open">&#8599;</button>' +
        '<button title="Rename">&#9998;</button>' +
        '<button title="Delete">&#128465;</button>' +
        "</div></div>" +
        '<div class="tree-item dir">' +
        '<button class="tree-toggle-btn" aria-label="Expand docs">&#9656;</button>' +
        '<span class="tree-icon" aria-hidden="true">d</span>' +
        '<span class="tree-name">docs</span>' +
        '<div class="tree-actions"><button title="Delete">&#128465;</button></div>' +
        "</div></div>";
    });

    const measured = await h.page.evaluate(() => {
      const out: Array<{ label: string; w: number; h: number }> = [];
      document
        .querySelectorAll<HTMLElement>("#sessions-list .file-tree button")
        .forEach((b) => {
          const r = b.getBoundingClientRect();
          out.push({
            label: b.className || b.title || b.textContent?.trim() || "button",
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        });
      return out;
    });

    assert.ok(
      measured.length >= 5,
      `expected the file tree's buttons to be rendered, got ${measured.length}`,
    );
    const undersized = measured.filter((m) => m.w < 24 || m.h < 24);
    assert.deepEqual(
      undersized,
      [],
      `file-tree controls below 24x24: ${undersized
        .map((m) => `${m.label} ${m.w}x${m.h}`)
        .join(", ")}`,
    );

    // Hover-only affordance: the action row was `opacity: 0` until :hover, so a
    // keyboard user tabbed into buttons they could not see. :focus-within must
    // reveal it.
    await h.page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>(
        "#sessions-list .tree-actions button",
      );
      btn?.focus();
    });
    // The row fades in over 150ms, so poll rather than sampling the computed
    // value mid-transition — that would read 0 and report a false failure.
    await h.page.waitForFunction(
      () => {
        const row = document.querySelector<HTMLElement>(
          "#sessions-list .tree-item .tree-actions",
        );
        return !!row && parseFloat(getComputedStyle(row).opacity) > 0.9;
      },
      undefined,
      { timeout: 3_000 },
    );
    const revealed = await h.page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(
        "#sessions-list .tree-item .tree-actions",
      )!;
      return {
        opacity: parseFloat(getComputedStyle(row).opacity),
        focusedIsInsideRow: row.contains(document.activeElement),
      };
    });
    assert.ok(
      revealed.focusedIsInsideRow,
      "the focused file-tree action must be inside the actions row",
    );
    assert.ok(
      revealed.opacity > 0.9,
      `file-tree actions stay invisible (opacity ${revealed.opacity}) while ` +
        "keyboard-focused — :focus-within must reveal them, hover is not enough",
    );

    await h.page.evaluate(() => {
      document.getElementById("sessions-list")!.innerHTML = "";
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Motion and forced colours
// ---------------------------------------------------------------------------

describe("preferences", () => {
  resetInjectedDom();
  // The infinite spinner and the decorative transitions used to run regardless
  // of prefers-reduced-motion. This asserts the app actually stops moving: an
  // infinite animation is a hard failure, and any leftover transition is a
  // failure too, so a future `@keyframes` addition cannot slip past silently.
  // (It previously asserted `offenders.length >= 0`, which can never fail.)
  test("prefers-reduced-motion stops all infinite and decorative motion", async () => {
    await h.page.emulateMedia({ reducedMotion: "reduce" });
    try {
      const offenders = await h.page.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll<HTMLElement>("*").forEach((el) => {
          const cs = getComputedStyle(el);
          const anim = parseFloat(cs.animationDuration) || 0;
          const trans = parseFloat(cs.transitionDuration) || 0;
          const iter = cs.animationIterationCount;
          const infinite = iter === "infinite" && anim > 0.01;
          // 0.01ms is the standard "effectively instant" sentinel; anything at or
          // above 20ms is a real animation the user asked us not to run.
          const live = anim > 0.02 || trans > 0.02;
          if (infinite || live) {
            out.push(
              `${el.tagName}.${el.className} anim=${cs.animationDuration}` +
                ` iter=${iter} trans=${cs.transitionDuration}`,
            );
          }
        });
        return out;
      });
      assert.deepEqual(
        offenders,
        [],
        `motion still running under prefers-reduced-motion:\n  ${offenders.join("\n  ")}`,
      );
    } finally {
      await h.page.emulateMedia({ reducedMotion: null });
    }
  });

  // Sanity check on the check above: the same probe MUST find motion when the
  // preference is off. Without this, a probe that silently stopped working
  // (bad selector, throw-and-return-empty) would make the test above pass for
  // the wrong reason.
  test("the motion probe detects motion when reduced-motion is off", async () => {
    const offenders = await h.page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const cs = getComputedStyle(el);
        if (
          (parseFloat(cs.animationDuration) || 0) > 0.01 ||
          (parseFloat(cs.transitionDuration) || 0) > 0.01
        ) {
          out.push(`${el.tagName}.${el.className}`);
        }
      });
      return out;
    });
    assert.ok(
      offenders.length > 0,
      "probe found no motion with reduced-motion off — the assertion above " +
        "would pass vacuously",
    );
  });

  test("forced-colors mode keeps a visible focus indicator", async () => {
    await h.page.emulateMedia({ forcedColors: "active" });
    try {
      await h.switchTab("open");
      // Reach the control with real Tab presses from the top of the document. A
      // programmatic .focus() does not engage :focus-visible in Chromium (it
      // matches on keyboard-interaction modality), so focusing from script would
      // report a false negative — see the "buttons show a visible focus
      // indicator" test for the same reason.
      await h.page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      let target: {
        outline: string;
        width: string;
        matched: boolean;
      } | null = null;
      for (let i = 0; i < 14; i++) {
        const info = await h.page.evaluate(() => {
          const a = document.activeElement as HTMLElement | null;
          if (!a || a.id !== "open-browse") return null;
          const cs = getComputedStyle(a);
          return {
            outline: cs.outlineStyle,
            width: cs.outlineWidth,
            matched: a.matches(":focus-visible"),
          };
        });
        if (info) {
          target = info;
          break;
        }
        await h.page.keyboard.press("Tab");
      }
      assert.ok(target, "never reached #open-browse by keyboard");
      assert.ok(
        target!.matched,
        "the focused control must match :focus-visible in forced-colors mode",
      );
      assert.notEqual(
        target!.outline,
        "none",
        "focused control lost its outline in forced-colors mode",
      );
      assert.ok(
        parseFloat(target!.width) > 0,
        `focus outline has zero width in forced-colors mode (${target!.width})`,
      );
    } finally {
      await h.page.emulateMedia({ forcedColors: null });
    }
  });
});
