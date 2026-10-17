// GUI smoke tests — launch the real Electron app and drive it with Playwright.
// These tests exercise every tab and the key vault lifecycle flows.
//
// Prerequisites: `npm run build` must have run first (tests target dist/).
// Run with: npm run test:gui
// Set SHADOWBIT_E2E_TEST=1 to prevent Finder/Explorer windows opening during tests.

import { test, before, after, describe, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, ElectronApplication, Page } from "playwright";
import type { BrowserWindow } from "electron";
import { CURRENT_VERSION } from "../src/core/container";
import { createVault } from "../src/core/vault";
import { ensureDisplay, type Display } from "./display";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const DIST_MAIN = path.resolve(__dirname, "../dist/gui/main.js");
const PASS = "smoke-test-password-abc-123!";
const NEW_PASS = "new-smoke-password-XYZ-789!";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-e2e-"));
const vaultPath = path.join(tmpDir, "smoke.svlt");

let app: ElectronApplication;
let page: Page;

// Generous timeouts: scrypt N=2^17 ≈ 200ms on modern HW; CI may be slower.
const OP_TIMEOUT = 30_000;
const UI_TIMEOUT = 8_000;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// Electron has no working headless mode on Linux, so when there is no display
// we start a virtual X server for the duration of the run. See e2e/display.ts
// for why that is not avoidable with flags.
let display: Display | null = null;

before(async () => {
  // node:test reports a failed before() hook once per top-level suite, at the
  // very end of the TAP stream — so print the reason here, first, or CI triage
  // starts by reading 26 "cancelledByParent" failures instead of the cause.
  try {
    display = await ensureDisplay();
  } catch (e) {
    console.error(
      `\n[smoke] cannot start the GUI suite: ${(e as Error).message}\n`,
    );
    throw e;
  }

  const env: Record<string, string> = {
    ...process.env,
    SHADOWBIT_CONFIG_DIR: path.join(tmpDir, "cfg"),
    SHADOWBIT_E2E_TEST: "1", // suppress shell.openPath so no Finder windows appear
  } as Record<string, string>;
  // Only override when we provisioned one: passing DISPLAY="" would be worse
  // than leaving the inherited value alone.
  if (display.ours) env.DISPLAY = display.display;

  app = await electron.launch({
    args: [DIST_MAIN],
    env,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

after(async () => {
  try {
    await app.close();
  } catch {
    /* ignore if already closed */
  }
  display?.cleanup();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set a read-only input's value via evaluate (bypasses readonly attr). */
async function setInput(id: string, value: string): Promise<void> {
  await page.evaluate(
    ([i, v]) => {
      (document.getElementById(i) as HTMLInputElement).value = v;
    },
    [id, value] as [string, string],
  );
}

/** Switch to a named tab and wait for its panel to become active. */
async function switchTab(name: string): Promise<void> {
  await page.click(`[data-tab="${name}"]`);
  await page.waitForSelector(`#panel-${name}.active`, {
    state: "visible",
    timeout: UI_TIMEOUT,
  });
}

/**
 * Wait for a pending vault operation to complete.
 * withLoading() shows #loading-overlay (removes .hidden), then hides it when done.
 * We poll the DOM until the .hidden class is back, using a 150ms initial delay
 * to let the async handler begin (which shows the overlay) before we check.
 */
async function waitForIdle(): Promise<void> {
  // Give JS one event loop turn to show the overlay
  await page.waitForTimeout(150);
  // Poll until the overlay has the .hidden class (operation complete)
  await page.waitForFunction(
    () =>
      document
        .getElementById("loading-overlay")
        ?.classList.contains("hidden") === true,
    { timeout: OP_TIMEOUT },
  );
}

/**
 * Wait for the toast to show text matching `re`, then return it.
 *
 * waitForIdle() is not enough for paths that never show the loading overlay
 * (e.g. the manage-tab worker ops): it returns while the IPC round-trip is
 * still in flight, so currentToast() then reads the *previous* test's toast.
 */
async function waitForToast(re: RegExp, timeout = OP_TIMEOUT): Promise<string> {
  await page.waitForFunction(
    (src: string) => {
      const el = document.getElementById("toast");
      if (!el || el.classList.contains("hidden")) return false;
      return new RegExp(src, "i").test(el.textContent ?? "");
    },
    re.source,
    { timeout },
  );
  return currentToast();
}

/** Force-hide the recovery modal (cleanup between tests if ack wasn't clicked). */
async function dismissModal(): Promise<void> {
  // The first-run welcome modal is a separate element from #modal, and shows
  // up on every fresh config dir — hide it too or it swallows all clicks.
  await page.evaluate(() => {
    document.getElementById("modal")?.classList.add("hidden");
    document.getElementById("welcome-modal")?.classList.add("hidden");
    // The settings modal is also an overlay; leaving it open silently swallows
    // every later click and turns one failure into a cascade.
    document.getElementById("settings-modal")?.classList.add("hidden");
  });
}

/** Return the current toast text, or "" if the toast is hidden. */
async function currentToast(): Promise<string> {
  return page.$eval("#toast", (el: HTMLElement) =>
    el.classList.contains("hidden") ? "" : (el.textContent?.trim() ?? ""),
  );
}

/**
 * Queue a "yes" response for the next native confirm dialog. Native message
 * boxes block the main process and are not reachable from the renderer page,
 * so main.ts consumes this queue instead of showing a real dialog when
 * SHADOWBIT_E2E_TEST=1. Call once per expected confirmation.
 */
async function queueConfirmYes(): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as any;
    if (!Array.isArray(g.__shadowbitConfirmQueue)) {
      g.__shadowbitConfirmQueue = [];
    }
    g.__shadowbitConfirmQueue.push(true);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ShadowBit GUI smoke tests", () => {
  // Defensive cleanup before each test — ensures any leftover modal can't block.
  beforeEach(async () => {
    await dismissModal();
  });

  // -------------------------------------------------------------------------
  test("app renders — title and Open tab active", async () => {
    const title = await page.title();
    assert.equal(title, "ShadowBit");
    assert.ok(await page.isVisible("#panel-open"), "Open panel visible");
    assert.ok(await page.isVisible(".topbar"), "topbar visible");
    assert.ok(await page.isVisible(".tabs"), "tabs visible");
  });

  // -------------------------------------------------------------------------
  test("Create tab — vault file created, strength bar populated", async () => {
    await switchTab("create");
    await setInput("create-path", vaultPath);
    await page.fill("#create-password", PASS);
    await page.fill("#create-password2", PASS);

    // Strength bar should reflect the entered password
    const fillWidth = await page.$eval(
      "#create-strength-fill",
      (el: HTMLElement) => el.style.width,
    );
    assert.notEqual(fillWidth, "0%", "strength fill must be non-zero");
    const labelText = await page.$eval(
      "#create-strength-label",
      (el: HTMLElement) => el.textContent?.trim() ?? "",
    );
    assert.ok(labelText.length > 0, "strength label must be non-empty");

    // Recovery key on by default
    const checked = await page.$eval(
      "#create-recovery",
      (el: HTMLInputElement) => el.checked,
    );
    assert.equal(checked, true);

    await page.click("#create-go");
    await waitForIdle();

    // Vault file must exist on disk
    assert.ok(fs.existsSync(vaultPath), "vault file created on disk");

    // Toast success
    await page.waitForSelector("#toast:not(.hidden)", { timeout: UI_TIMEOUT });
    const msg = await currentToast();
    assert.match(msg, /created/i);
  });

  // -------------------------------------------------------------------------
  test("Create tab — recovery modal shown, ok disabled until ack checked", async () => {
    // The modal should be visible after vault creation (previous test left it open).
    // If it got dismissed by beforeEach, re-trigger it (create another vault).
    const modalVisible = await page.isVisible("#modal:not(.hidden)");
    if (!modalVisible) {
      // Re-trigger: we need a different path since vaultPath already exists
      const vp2 = path.join(tmpDir, "smoke2.svlt");
      await switchTab("create");
      await setInput("create-path", vp2);
      await page.fill("#create-password", PASS);
      await page.fill("#create-password2", PASS);
      await page.click("#create-go");
      await waitForIdle();
      await page.waitForSelector("#modal:not(.hidden)", {
        timeout: UI_TIMEOUT,
      });
    }

    // ok button must be disabled before acknowledgment
    const disabledBefore = await page.$eval(
      "#modal-ok",
      (b: HTMLButtonElement) => b.disabled,
    );
    assert.equal(disabledBefore, true, "ok disabled before ack");

    // Recovery key matches our format
    const key = await page.$eval(
      "#modal-key",
      (el: HTMLElement) => el.textContent?.trim() ?? "",
    );
    assert.match(key, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){7}$/, "recovery key format");

    // Check the ack box → button enabled
    await page.click("#modal-ack-check");
    const disabledAfter = await page.$eval(
      "#modal-ok",
      (b: HTMLButtonElement) => b.disabled,
    );
    assert.equal(disabledAfter, false, "ok enabled after ack");

    // Dismiss
    await page.click("#modal-ok");
    // waitForSelector on a .hidden element (display:none) would never show as
    // "visible", so we use waitForFunction to check the class list directly.
    await page.waitForFunction(
      () =>
        document.getElementById("modal")?.classList.contains("hidden") === true,
      { timeout: UI_TIMEOUT },
    );
  });

  // -------------------------------------------------------------------------
  test("Open tab — vault opens, password cleared after success", async () => {
    await switchTab("open");
    await setInput("open-path", vaultPath);
    await page.fill("#open-password", PASS);

    await page.click("#open-go");
    await waitForIdle();

    const pwAfter = await page.$eval(
      "#open-password",
      (el: HTMLInputElement) => el.value,
    );
    assert.equal(pwAfter, "", "password cleared after open");

    await page.waitForSelector("#toast:not(.hidden)", { timeout: UI_TIMEOUT });
    const msg = await currentToast();
    assert.match(msg, /opened/i);
  });

  // -------------------------------------------------------------------------
  test("Open tab — wrong password shows error toast, password cleared", async () => {
    // Make sure the vault is closed first (previous test opened it)
    // We'll check by trying a second open with wrong password
    await switchTab("open");
    await setInput("open-path", vaultPath);
    await page.fill("#open-password", "definitely-wrong-password-xyz");

    await page.click("#open-go");
    await waitForIdle();

    const pwAfter = await page.$eval(
      "#open-password",
      (el: HTMLInputElement) => el.value,
    );
    assert.equal(pwAfter, "", "password cleared after failed open");

    await page.waitForSelector("#toast.err", { timeout: UI_TIMEOUT });
  });

  // -------------------------------------------------------------------------
  test("Sessions tab — open vault appears in list", async () => {
    await switchTab("sessions");
    await page.waitForSelector(".session", { timeout: UI_TIMEOUT });

    const paths = await page.$$eval(".session .path", (els: HTMLElement[]) =>
      els.map((e) => e.textContent?.trim() ?? ""),
    );
    assert.ok(
      paths.some((p) => p === vaultPath),
      `${vaultPath} must appear in sessions list`,
    );
  });

  // -------------------------------------------------------------------------
  test("Sessions tab — close vault re-encrypts and removes it from list", async () => {
    await switchTab("sessions");
    await page.waitForSelector(".session", { timeout: UI_TIMEOUT });

    const sessionEl = await page.$(".session");
    assert.ok(sessionEl, "a session card must exist");

    const pwInput = await sessionEl!.$("input[type=password]");
    assert.ok(pwInput, "password input in session card");
    await pwInput!.fill(PASS);

    const closeBtn = await sessionEl!.$(".btn-close");
    assert.ok(closeBtn);
    await closeBtn!.click();
    await waitForIdle();

    await page.waitForSelector("#toast:not(.hidden)", { timeout: UI_TIMEOUT });
    const msg = await currentToast();
    assert.match(msg, /closed/i);

    await page.waitForFunction(
      () => document.querySelectorAll(".session").length === 0,
      { timeout: UI_TIMEOUT },
    );
  });

  // -------------------------------------------------------------------------
  test("Manage tab — Show Info displays formatted vault metadata", async () => {
    await switchTab("manage");
    await setInput("manage-path", vaultPath);
    await page.click("#manage-info");

    await page.waitForSelector("#manage-info-out:not(.hidden)", {
      timeout: UI_TIMEOUT,
    });

    const info = await page.$eval(
      "#manage-info-out",
      (el: HTMLElement) => el.textContent ?? "",
    );
    // Derived from the container module so this assertion cannot drift when
    // CURRENT_VERSION is bumped (it previously hardcoded "2" and went stale
    // the moment v3 landed).
    assert.match(
      info,
      new RegExp(`Version:\\s+${CURRENT_VERSION}\\b`),
      `info must report container version ${CURRENT_VERSION}`,
    );
    assert.match(info, /Recovery key:\s+yes/i);
    assert.match(info, /Open:\s+no/i);
    // Size should be human-readable (B / KB / MB / GB), not raw bytes
    assert.match(info, /Size:\s+[\d.]+\s+(B|KB|MB|GB)/);
  });

  // -------------------------------------------------------------------------
  test("Manage tab — save metadata, and it round-trips through Show Info", async () => {
    await switchTab("manage");
    await setInput("manage-path", vaultPath);

    await page.fill("#meta-name", "Quarterly Backup");
    await page.fill("#meta-desc", "Runbook + keys");
    await page.fill("#meta-pass", PASS);
    await page.click("#meta-go");
    await waitForToast(/metadata saved/i);
    // The password must not linger in the DOM after the call.
    assert.equal(await page.inputValue("#meta-pass"), "");

    // Confirm it was actually persisted, not just reported as saved: info reads
    // the same worker-op path the renderer uses.
    await page.click("#manage-info");
    await page.waitForSelector("#manage-info-out:not(.hidden)", {
      timeout: UI_TIMEOUT,
    });
    const info = await page.$eval(
      "#manage-info-out",
      (el: HTMLElement) => el.textContent ?? "",
    );
    assert.match(info, /Quarterly Backup/);
    assert.match(info, /Runbook \+ keys/);
  });

  // -------------------------------------------------------------------------
  test("Manage tab — save metadata with the wrong password is rejected", async () => {
    await switchTab("manage");
    await setInput("manage-path", vaultPath);
    await page.fill("#meta-name", "Should Not Stick");
    await page.fill("#meta-pass", "definitely-not-the-password");
    await page.click("#meta-go");
    await waitForToast(/(incorrect|wrong|invalid|password)/i);
    assert.equal(
      await page.inputValue("#meta-pass"),
      "",
      "a failed attempt must clear the password field",
    );

    // Prove nothing was written.
    await page.click("#manage-info");
    await page.waitForSelector("#manage-info-out:not(.hidden)", {
      timeout: UI_TIMEOUT,
    });
    const info = await page.$eval(
      "#manage-info-out",
      (el: HTMLElement) => el.textContent ?? "",
    );
    assert.doesNotMatch(info, /Should Not Stick/);
  });

  // -------------------------------------------------------------------------
  test("Manage tab — metadata on a paranoid vault is saved, and warns", async () => {
    // The write is allowed and the warning is the deliverable. A paranoid vault
    // keeps its header free of optional plaintext, so the GUI has to say out
    // loud that the name it just saved is now readable in the file — a silent
    // success would defeat the mode the user chose.
    const paranoidPath = path.join(tmpDir, "smoke-paranoid.svlt");
    createVault(paranoidPath, { password: PASS, paranoid: true });

    await switchTab("manage");
    await setInput("manage-path", paranoidPath);
    await page.fill("#meta-name", "Leaked On Purpose");
    await page.fill("#meta-pass", PASS);
    await page.click("#meta-go");
    // The warning is an err()-class toast: it persists rather than auto-hiding,
    // because a 4-second message is not long enough to act on.
    await waitForToast(/paranoid/i);
    const toast = await page.$eval("#toast", (el) => el.textContent ?? "");
    assert.match(
      toast,
      /plaintext|in the clear/i,
      "the warning must say the text is readable in the file",
    );

    // And it really was written — this is a warning, not a refusal.
    await page.click("#manage-info");
    await page.waitForSelector("#manage-info-out:not(.hidden)", {
      timeout: UI_TIMEOUT,
    });
    const info = await page.$eval(
      "#manage-info-out",
      (el: HTMLElement) => el.textContent ?? "",
    );
    assert.match(info, /Leaked On Purpose/);
  });

  // -------------------------------------------------------------------------
  test("Manage tab — metadata on an ordinary vault saves without a paranoid warning", async () => {
    // The mirror: a warning that fires unconditionally is as useless as none at
    // all, because the user learns to ignore it.
    await switchTab("manage");
    await setInput("manage-path", vaultPath);
    await page.fill("#meta-name", "Ordinary Vault");
    await page.fill("#meta-pass", PASS);
    await page.click("#meta-go");
    await waitForToast(/metadata saved/i);
    const toast = await page.$eval("#toast", (el) => el.textContent ?? "");
    assert.doesNotMatch(
      toast,
      /paranoid/i,
      "an ordinary vault must not produce the paranoid warning",
    );
  });

  // -------------------------------------------------------------------------
  test("Settings modal — changes apply, and Escape closes it (WCAG 2.1.1)", async () => {
    await page.click("#settings-btn");
    await page.waitForSelector("#settings-modal:not(.hidden)", {
      timeout: UI_TIMEOUT,
    });

    // Escape must dismiss and return focus to the trigger, not just hide it.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    assert.ok(
      await page.evaluate(() =>
        document.getElementById("settings-modal")?.classList.contains("hidden"),
      ),
      "Escape should close the settings dialog",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "settings-btn",
      "focus should return to the settings button",
    );

    // Settings are committed by the Done button, not live on select, so
    // exercise the real flow: choose, commit, then confirm it persisted.
    await page.click("#settings-btn");
    await page.waitForSelector("#settings-modal:not(.hidden)");
    await page.selectOption("#theme-select", "light");
    await page.selectOption("#auto-lock-select", "15");
    await page.click("#settings-close");
    await page.waitForSelector("#settings-modal.hidden", {
      state: "attached",
      timeout: UI_TIMEOUT,
    });
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
      "light",
      "committing Light must apply data-theme=light",
    );

    // Reopen: the stored values should come back.
    await page.click("#settings-btn");
    await page.waitForSelector("#settings-modal:not(.hidden)");
    assert.equal(await page.inputValue("#theme-select"), "light");
    assert.equal(await page.inputValue("#auto-lock-select"), "15");

    // Put the theme back so later assertions are not reading a light UI.
    await page.selectOption("#theme-select", "dark");
    await page.click("#settings-close");
    await page.waitForSelector("#settings-modal.hidden", {
      state: "attached",
      timeout: UI_TIMEOUT,
    });
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
      "dark",
      "theme should be back to dark",
    );
  });

  // -------------------------------------------------------------------------
  test("Manage tab — change password: success, all password fields cleared", async () => {
    await switchTab("manage");
    await setInput("manage-path", vaultPath);

    await page.fill("#cp-old", PASS);
    await page.fill("#cp-new", NEW_PASS);
    await page.fill("#cp-new2", NEW_PASS);

    // Strength bar should update on cp-new input
    const cpFillWidth = await page.$eval(
      "#cp-strength-fill",
      (el: HTMLElement) => el.style.width,
    );
    assert.notEqual(cpFillWidth, "0%", "cp strength fill must be non-zero");

    await page.click("#cp-go");
    await waitForIdle();

    for (const id of ["#cp-old", "#cp-new", "#cp-new2"]) {
      const val = await page.$eval(id, (el: HTMLInputElement) => el.value);
      assert.equal(val, "", `${id} cleared after change-password`);
    }

    await page.waitForSelector("#toast:not(.hidden)", { timeout: UI_TIMEOUT });
    const msg = await currentToast();
    assert.match(msg, /changed/i);
  });

  // -------------------------------------------------------------------------
  test("Open tab — vault opens with the new password", async () => {
    await switchTab("open");
    await setInput("open-path", vaultPath);
    await page.fill("#open-password", NEW_PASS);

    await page.click("#open-go");
    await waitForIdle();

    await page.waitForSelector("#toast:not(.hidden)", { timeout: UI_TIMEOUT });
    const msg = await currentToast();
    assert.match(msg, /opened/i);
  });

  // -------------------------------------------------------------------------
  test("Sessions tab — discard removes session and erases working dir", async () => {
    await switchTab("sessions");
    await page.waitForSelector(".session", { timeout: UI_TIMEOUT });

    const sessionEl = await page.$(".session");
    const workingDir = await sessionEl!.$eval(
      ".wd",
      (el: HTMLElement) => el.textContent?.trim() ?? "",
    );
    assert.ok(workingDir.length > 0, "session card must show a working dir");
    const pwInput = await sessionEl!.$("input[type=password]");
    await pwInput!.fill(NEW_PASS);

    // Discard raises a native confirm dialog; answer YES via the E2E queue.
    await queueConfirmYes();
    const discardBtn = await sessionEl!.$(".btn-discard");
    await discardBtn!.click();
    await waitForIdle();

    await page.waitForSelector("#toast:not(.hidden)", { timeout: UI_TIMEOUT });
    assert.match(await currentToast(), /discard/i);

    // Session list must be empty.
    await page.waitForFunction(
      () => document.querySelectorAll(".session").length === 0,
      { timeout: UI_TIMEOUT },
    );

    // The decrypted working dir must be gone from disk...
    assert.ok(
      !fs.existsSync(workingDir),
      `working dir must be erased, still present: ${workingDir}`,
    );
    // ...but the vault file itself must survive (discard != delete).
    assert.ok(fs.existsSync(vaultPath), "vault file must survive a discard");
  });

  // -------------------------------------------------------------------------
  // The in-app file browser. Rename and delete were both non-functional:
  // Electron does not implement window.prompt (it throws "prompt() is and
  // will not be supported") and window.confirm always resolves false, so
  // rename threw on every attempt and delete silently did nothing.
  test("Sessions tab — the file browser can rename and delete inside the vault", async () => {
    // Fresh session: the previous test discarded the vault.
    await switchTab("open");
    await setInput("open-path", vaultPath);
    await page.fill("#open-password", NEW_PASS);
    await page.click("#open-go");
    await waitForIdle();
    await switchTab("sessions");
    await page.waitForSelector(".session", { timeout: UI_TIMEOUT });

    const sessionEl = (await page.$(".session"))!;
    const workingDir = await sessionEl.$eval(
      ".wd",
      (el: HTMLElement) => el.textContent?.trim() ?? "",
    );
    // A file the user "added" to the working folder.
    const target = path.join(workingDir, "notes.txt");
    fs.writeFileSync(target, "original contents");

    await (await page.$(".btn-tree"))!.click();
    await page.waitForSelector(".file-tree .tree-item", {
      timeout: UI_TIMEOUT,
    });
    assert.match(
      await page.$eval(".file-tree", (el: HTMLElement) => el.textContent ?? ""),
      /notes\.txt/,
      "the file browser must list the file on disk",
    );

    // --- rename, through the in-app prompt modal ---
    await page.click(
      '.file-tree .tree-actions button[aria-label="Rename notes.txt"]',
    );
    await page.waitForSelector("#prompt-modal:not(.hidden)", {
      timeout: UI_TIMEOUT,
    });
    // The field must be pre-filled and focused, so Enter alone commits.
    assert.equal(await page.inputValue("#prompt-input"), "notes.txt");
    await page.fill("#prompt-input", "renamed.txt");
    await page.click("#prompt-ok");
    await page.waitForSelector("#prompt-modal", {
      state: "hidden",
      timeout: UI_TIMEOUT,
    });
    await waitForIdle();

    assert.ok(
      fs.existsSync(path.join(workingDir, "renamed.txt")),
      "renamed on disk",
    );
    assert.ok(!fs.existsSync(target), "old name must be gone");
    await page.waitForSelector(
      '.file-tree .tree-actions button[aria-label="Rename renamed.txt"]',
      { timeout: UI_TIMEOUT },
    );

    // Escape must abandon the rename without touching anything.
    await page.click(
      '.file-tree .tree-actions button[aria-label="Rename renamed.txt"]',
    );
    await page.waitForSelector("#prompt-modal:not(.hidden)", {
      timeout: UI_TIMEOUT,
    });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#prompt-modal", {
      state: "hidden",
      timeout: UI_TIMEOUT,
    });
    assert.ok(
      fs.existsSync(path.join(workingDir, "renamed.txt")),
      "a cancelled rename must not change anything",
    );

    // --- delete, through the native confirm bridge ---
    await queueConfirmYes();
    await page.click(
      '.file-tree .tree-actions button[aria-label="Delete renamed.txt"]',
    );
    await waitForIdle();
    assert.ok(
      !fs.existsSync(path.join(workingDir, "renamed.txt")),
      "the file must actually be deleted",
    );

    // A second file, added behind the app's back, to prove delete is not a
    // one-shot: collapse and re-expand the browser to re-list the folder.
    fs.writeFileSync(path.join(workingDir, "keep.txt"), "keep me");
    await (await page.$(".btn-tree"))!.click(); // collapse
    await waitForIdle();
    await (await page.$(".btn-tree"))!.click(); // expand -> re-lists
    await page.waitForSelector(
      '.file-tree .tree-actions button[aria-label="Delete keep.txt"]',
      { timeout: UI_TIMEOUT },
    );
    await queueConfirmYes();
    await page.click(
      '.file-tree .tree-actions button[aria-label="Delete keep.txt"]',
    );
    await waitForIdle();
    assert.ok(
      !fs.existsSync(path.join(workingDir, "keep.txt")),
      "delete must work for every listed entry, not just the first",
    );
  });

  // -------------------------------------------------------------------------
  test("Open tab — recent vaults list shows the used vault", async () => {
    await switchTab("open");
    // The vault we created and opened should be in the recent list
    const recentVisible = await page.isVisible("#recent-section:not(.hidden)");
    assert.ok(recentVisible, "recent-section should be visible");

    const recentPaths = await page.$$eval(".recent-item", (els: Element[]) =>
      els.map((el) => (el as HTMLElement).dataset.path ?? ""),
    );
    assert.ok(
      recentPaths.some((p) => p === vaultPath),
      "vault must appear in recent list",
    );
  });

  // -------------------------------------------------------------------------
  test("Manage tab — delete vault removes file from disk", async () => {
    // First make sure the vault is closed (discard or sessions empty)
    await switchTab("sessions");
    const hasSessions = await page.isVisible(".session");
    if (hasSessions) {
      const sessionEl = await page.$(".session");
      const pwInput = await sessionEl!.$("input[type=password]");
      await pwInput!.fill(NEW_PASS);
      const closeBtn = await sessionEl!.$(".btn-close");
      await closeBtn!.click();
      await waitForIdle();
    }

    await switchTab("manage");
    await setInput("manage-path", vaultPath);
    await setInput("del-pass", NEW_PASS);
    await queueConfirmYes();
    await page.click("#del-go");
    await waitForIdle();

    await page.waitForSelector("#toast:not(.hidden)", { timeout: UI_TIMEOUT });
    assert.match(await currentToast(), /delet|shred/i);

    // The vault must actually be gone from disk. This used to be punted to
    // the CLI tests because the native confirm dialog could not be answered.
    assert.ok(
      !fs.existsSync(vaultPath),
      `vault file must be deleted, still present: ${vaultPath}`,
    );
  });
  // -------------------------------------------------------------------------
  test("window honours the 640x480 minimum size", async () => {
    // The renderer supports down to 320px (WCAG 1.4.10 reflow) and that is
    // covered by e2e/nfr.responsive.test.ts in Chromium. The Electron window
    // cannot get that narrow, so pin the clamp here — if this ever changes, the
    // responsive suite should move to the real window instead of the harness.
    const win = await app.browserWindow(page);
    const size = await win.evaluate((w: BrowserWindow) => ({
      width: w.getBounds().width,
      height: w.getBounds().height,
      min: w.getMinimumSize(),
    }));
    // The literals here are deliberate and must NOT be replaced with the
    // MIN_WINDOW_WIDTH/MIN_WINDOW_HEIGHT exports. This test pins the *value*,
    // not just that the code agrees with itself: the reason the NFR suites run
    // in Chromium instead of Electron at all is that this minimum makes the
    // XS/SM widths unreachable in a real window. Importing the constants would
    // make the assertion tautological and quietly invalidate that split.
    assert.ok(
      size.width >= 640,
      `window should be at least 640 wide, got ${size.width}`,
    );
    assert.ok(
      size.height >= 480,
      `window should be at least 480 tall, got ${size.height}`,
    );
    assert.deepEqual(
      size.min,
      [640, 480],
      "minimum window size should stay 640x480",
    );
  });
});

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
// The menu is the only entry point for vault creation, opening and locking, so
// its wiring is asserted here: labels, accelerators, the state-dependent
// enabled flag, and the main → renderer command channel. Menu items are
// clicked by reading the real application menu in the main process — the
// native menus are not part of the renderer's page and cannot be driven by
// ordinary Playwright clicks.
interface MenuItemInfo {
  label: string;
  /** Electron's built-in role, or "" for an item defined by the template. */
  role: string;
  accelerator: string;
  enabled: boolean;
  checked: boolean;
  hasSubmenu: boolean;
}

/**
 * Snapshot the application menu as { top-level label: [items] }. Runs in the
 * main process — Playwright hands the `electron` module in as the first
 * argument — so it can call Electron's own APIs rather than a stale copy.
 */
function snapshotMenu({
  Menu,
}: typeof import("electron")): Record<string, MenuItemInfo[]> {
  const out: Record<string, MenuItemInfo[]> = {};
  const menu = Menu.getApplicationMenu();
  if (!menu) return out;
  for (const top of menu.items) {
    out[top.label ?? ""] = (top.submenu?.items ?? []).map((i) => ({
      label: i.label ?? "",
      role: i.role ?? "",
      accelerator: i.accelerator ?? "",
      enabled: i.enabled,
      checked: i.checked,
      hasSubmenu: !!i.submenu,
    }));
  }
  return out;
}

/**
 * Resolve the item at `path` — e.g. ["File", "Open Recent", "Clear Recent
 * Vaults"] — by walking the submenu chain, and report its state along with the
 * labels of its own children. Returns null if any level is missing.
 */
function resolveItem(
  { Menu }: typeof import("electron"),
  path: string[],
): (MenuItemInfo & { childLabels: string[] }) | null {
  let sub = Menu.getApplicationMenu() ?? undefined;
  let item: Electron.MenuItem | undefined;
  for (const label of path) {
    item = sub?.items.find((i) => i.label === label);
    if (!item) return null;
    sub = item.submenu;
  }
  if (!item) return null;
  return {
    label: item.label ?? "",
    role: item.role ?? "",
    accelerator: item.accelerator ?? "",
    enabled: item.enabled,
    checked: item.checked,
    hasSubmenu: !!item.submenu,
    childLabels: (item.submenu?.items ?? []).map((i) => i.label ?? ""),
  };
}

/** Fire a menu item's click handler from the main process. */
function clickMenuPath(
  { Menu }: typeof import("electron"),
  path: string[],
): void {
  let sub = Menu.getApplicationMenu() ?? undefined;
  for (const label of path) {
    const entry = sub?.items.find((i) => i.label === label);
    entry?.click();
    sub = entry?.submenu;
  }
}

describe("ShadowBit application menu", () => {
  const isMac = process.platform === "darwin";
  const recentVaultPath = path.join(tmpDir, "menu-recent.svlt");
  const lockVaultPath = path.join(tmpDir, "menu-lock.svlt");

  const at = (
    ...path: string[]
  ): Promise<(MenuItemInfo & { childLabels: string[] }) | null> =>
    app.evaluate(resolveItem, path);

  /** Click a menu item, e.g. click("File", "Open Vault…"). */
  async function click(...path: string[]): Promise<void> {
    const info = await at(...path);
    assert.ok(info, `menu item "${path.join(" > ")}" must exist`);
    assert.ok(info.enabled, `"${path.join(" > ")}" must be enabled to click`);
    await app.evaluate(clickMenuPath, path);
  }

  /**
   * The renderer reports the open-vault count to the main process after every
   * sessions refresh and the menu is rebuilt from it, so the enabled flag
   * flips asynchronously. Poll instead of asserting immediately.
   */
  async function waitForLockEnabled(
    expected: boolean,
    timeout = UI_TIMEOUT,
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const item = await at("File", "Lock All Vaults");
      if (item?.enabled === expected) return;
      if (Date.now() > deadline) {
        assert.fail(
          `"Lock All Vaults" enabled should be ${expected}, got ${item?.enabled}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Answer the next native path dialog with `p`. Native dialogs block the main
   * process, so under SHADOWBIT_E2E_TEST=1 main.ts consumes this queue
   * instead; an empty queue means "the user cancelled".
   */
  async function queuePath(p: string): Promise<void> {
    await app.evaluate((_electron: unknown, value: string) => {
      const g = globalThis as any;
      if (!Array.isArray(g.__shadowbitPathQueue)) {
        g.__shadowbitPathQueue = [];
      }
      g.__shadowbitPathQueue.push(value);
    }, p);
  }

  /** Drive File > Open Vault… and unlock the vault at `vaultPath`. */
  async function openFromMenu(vaultPath: string): Promise<void> {
    await queuePath(vaultPath);
    await click("File", "Open Vault…");
    await page.waitForFunction(
      (expected) =>
        (document.getElementById("open-path") as HTMLInputElement).value ===
        expected,
      vaultPath,
      { timeout: UI_TIMEOUT },
    );
    await page.fill("#open-password", PASS);
    await page.click("#open-go");
    await waitForIdle();
    await waitForToast(/open/i);
  }

  /** Close the first open session through the Sessions tab. */
  async function closeFirstSession(): Promise<void> {
    await switchTab("sessions");
    await page.waitForSelector(".session", { timeout: UI_TIMEOUT });
    const card = await page.$(".session");
    assert.ok(card, "a session card must exist");
    const pw = await card!.$("input[type=password]");
    assert.ok(pw, "password input in session card");
    await pw!.fill(PASS);
    await card!.$eval(".btn-close", (el: HTMLElement) => el.click());
    await waitForIdle();
    await page.waitForFunction(
      () => document.querySelectorAll(".session").length === 0,
      undefined,
      { timeout: UI_TIMEOUT },
    );
  }

  test("menu exposes the app's vault operations", async () => {
    const snapshot = await app.evaluate(snapshotMenu);
    assert.deepEqual(
      Object.keys(snapshot),
      // macOS leads with the app menu; other platforms start at File.
      isMac
        ? ["ShadowBit", "File", "Edit", "View", "Window"]
        : ["File", "Edit", "View", "Window"],
    );

    const file = snapshot["File"].map((i) => i.label);
    for (const label of [
      "New Vault…",
      "Open Vault…",
      "Open Recent",
      "Lock All Vaults",
    ]) {
      assert.ok(file.includes(label), `File menu must have "${label}"`);
    }
    assert.ok(
      snapshot["View"].some((i) => i.label === "Appearance" && i.hasSubmenu),
      "View menu must have an Appearance submenu",
    );
    assert.ok(
      snapshot["Window"].some((i) => i.label === "Close"),
      "Window menu must have Close",
    );

    // Settings sits in the app menu on macOS, at the bottom of File elsewhere.
    const settingsHost = isMac ? snapshot["ShadowBit"] : snapshot["File"];
    assert.ok(
      settingsHost.some((i) => i.label === "Settings…"),
      "Settings… must be reachable from the menu",
    );

    assert.equal((await at("File", "New Vault…"))?.accelerator, "CmdOrCtrl+N");
    assert.equal((await at("File", "Open Vault…"))?.accelerator, "CmdOrCtrl+O");
    assert.equal(
      (await at("File", "Lock All Vaults"))?.accelerator,
      "CmdOrCtrl+Shift+L",
    );
  });

  test("View offers DevTools only in an unpackaged run", async () => {
    // Matched on the role, not the label: Electron localises role-derived
    // labels, so "Toggle Developer Tools" is not a stable string. Electron also
    // lower-cases the role it reports back.
    const view = (await app.evaluate(snapshotMenu))["View"];
    const packaged = await app.evaluate(({ app: a }) => a.isPackaged);
    const devtoolsAt = view.findIndex((i) => i.role === "toggledevtools");
    assert.equal(
      devtoolsAt >= 0,
      !packaged,
      `DevTools item should be present iff unpackaged (packaged=${packaged})`,
    );

    // Gating the item must not leave a stray separator behind, or the released
    // menu would show "Force Reload" / "Actual Size" split by a blank line.
    if (!packaged) {
      // A single separator sits between DevTools and the zoom group.
      assert.equal(
        view[devtoolsAt + 1]?.role,
        "",
        "a separator must follow the DevTools item",
      );
      assert.equal(
        view[devtoolsAt + 2]?.role,
        "resetzoom",
        "the separator after DevTools must not be duplicated",
      );
    } else {
      const forceReload = view.findIndex((i) => i.role === "forcereload");
      assert.equal(
        view[forceReload + 1]?.role,
        "resetzoom",
        "no dangling separator where DevTools used to be",
      );
    }
  });

  test("File > New Vault… starts the Create flow with the chosen path", async () => {
    const target = path.join(tmpDir, "from-menu.svlt");
    await queuePath(target);
    await click("File", "New Vault…");
    await page.waitForSelector("#panel-create.active", { timeout: UI_TIMEOUT });
    await page.waitForFunction(
      (expected) =>
        (document.getElementById("create-path") as HTMLInputElement).value ===
        expected,
      target,
      { timeout: UI_TIMEOUT },
    );
    // The menu starts the flow; it must not create anything by itself.
    assert.ok(!fs.existsSync(target), "menu must not create a vault by itself");
  });

  test("Open Recent lists the last used vault and can be cleared", async () => {
    // Created on disk directly: this test is about the recent list, and the
    // UI create flow would pop the recovery-key modal.
    createVault(recentVaultPath, { password: PASS });

    // The main suite left other vaults in the list, so assert only that ours
    // is not in there yet.
    const before = (await at("File", "Open Recent"))?.childLabels ?? [];
    assert.ok(
      !before.includes(path.basename(recentVaultPath)),
      `recent list should not yet contain the vault under test, got ${JSON.stringify(before)}`,
    );

    await openFromMenu(recentVaultPath);
    const labels = (await at("File", "Open Recent"))?.childLabels ?? [];
    assert.ok(
      labels.includes(path.basename(recentVaultPath)),
      `Open Recent must list the vault just opened, got ${JSON.stringify(labels)}`,
    );
    assert.ok(
      labels.includes("Clear Recent Vaults"),
      "Open Recent must offer Clear Recent Vaults",
    );

    await click("File", "Open Recent", "Clear Recent Vaults");
    await page.waitForFunction(
      () =>
        document.getElementById("recent-section")?.classList.contains("hidden"),
      undefined,
      { timeout: UI_TIMEOUT },
    );
    assert.deepEqual(
      (await at("File", "Open Recent"))?.childLabels,
      ["No Recent Vaults"],
      "clearing must empty the list in both the menu and the Open tab",
    );

    // Leave no session behind: the next test asserts nothing is open.
    await closeFirstSession();
  });

  test("View > Appearance switches the theme and moves the radio", async () => {
    /** Whether `label` is the checked radio in View > Appearance. */
    const checkedTheme = async (label: string): Promise<boolean> => {
      const item = await at("View", "Appearance", label);
      assert.ok(item, `Appearance must offer "${label}"`);
      return item.checked;
    };

    await click("View", "Appearance", "Light");
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-theme") === "light",
      undefined,
      { timeout: UI_TIMEOUT },
    );
    assert.ok(await checkedTheme("Light"), "Light must be the checked radio");
    assert.ok(
      !(await checkedTheme("Dark")),
      "Dark must no longer be checked after switching to Light",
    );

    // Put it back so the theme assertions elsewhere are not affected.
    await click("View", "Appearance", "Dark");
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-theme") === "dark",
      undefined,
      { timeout: UI_TIMEOUT },
    );
    assert.ok(await checkedTheme("Dark"), "Dark must be checked again");
  });

  test("Lock All Vaults tracks open vaults and erases the working dir", async () => {
    createVault(lockVaultPath, { password: PASS });

    // Nothing open, so there is nothing to lock.
    await waitForLockEnabled(false);

    await openFromMenu(lockVaultPath);
    await switchTab("sessions");
    await page.waitForSelector(".session", { timeout: UI_TIMEOUT });
    const workingDir = await page.$eval(".session .wd", (el) =>
      (el.textContent ?? "").trim(),
    );
    assert.ok(fs.existsSync(workingDir), "working dir should exist once open");

    // The renderer reported the session count, which enables the item.
    await waitForLockEnabled(true);

    // SHADOWBIT_E2E_TEST=1 skips the confirmation, so this locks immediately.
    await click("File", "Lock All Vaults");
    await waitForToast(/locked/i);
    await page.waitForFunction(
      () => document.querySelectorAll(".session").length === 0,
      undefined,
      { timeout: UI_TIMEOUT },
    );
    assert.ok(
      !fs.existsSync(workingDir),
      `working dir must be erased by the lock, still present: ${workingDir}`,
    );
    await waitForLockEnabled(false);
    // Locking is not deleting: the vault itself must survive.
    assert.ok(fs.existsSync(lockVaultPath), "vault file must survive a lock");
  });
});
