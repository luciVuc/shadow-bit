// Deployment smoke test against the PACKAGED artifact.
//
// `npm test` and `npm run test:gui` both drive `dist/` over a plain Electron
// launch. That misses the one thing packaging can silently break: the files
// that are only needed once the app is inside an asar. The vault worker is the
// sharpest example — `vault-worker-bridge.ts` locates
// `dist/core/vault-worker.js` relative to its own `__dirname`, and if that file
// or the bundled renderer assets fell outside the `files` globs in
// package.json, every vault operation would fail only in a shipped build.
//
// Usage:
//   npm run package:dir
//   npm run test:packaged
//
// Requires a display (it launches a real window) and a prior `package:dir`.

import { _electron as electron } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASS = "correct-horse-battery";

function findPackagedBinary() {
  const candidates = [
    path.join(ROOT, "release", "linux-unpacked", "shadow-bit"),
    // electron-builder names the mac output directory after the arch, so an
    // Apple Silicon build lands in mac-arm64/ and an Intel one in mac/. Checking
    // only release/mac meant the packaged smoke test silently refused to run on
    // the machine most likely to produce a mac artifact.
    path.join(
      ROOT,
      "release",
      "mac-arm64",
      "ShadowBit.app",
      "Contents",
      "MacOS",
      "ShadowBit",
    ),
    path.join(
      ROOT,
      "release",
      "mac",
      "ShadowBit.app",
      "Contents",
      "MacOS",
      "ShadowBit",
    ),
    path.join(ROOT, "release", "win-unpacked", "ShadowBit.exe"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    "No packaged build found. Run `npm run package:dir` (or package:mac / " +
      "package:win for those platforms) first.\nLooked in:\n  " +
      candidates.join("\n  "),
  );
}

const binary = findPackagedBinary();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-packaged-"));
const cfg = path.join(tmp, "cfg");
const vaultPath = path.join(tmp, "packaged.vault");
const env = { ...process.env, SHADOWBIT_CONFIG_DIR: cfg };

// Build the fixture with the shipped CLI, so the packaged GUI is handed a file
// the real product produced.
execFileSync(
  process.execPath,
  [
    path.join(ROOT, "dist", "cli", "index.js"),
    "create",
    vaultPath,
    "--no-recovery",
  ],
  { input: `${PASS}\n${PASS}\n`, env },
);

const app = await electron.launch({
  executablePath: binary,
  args: [],
  env,
  timeout: 30_000,
});
const page = await app.firstWindow();
const step = (m) => process.stderr.write(`[step] ${m}\n`);
page.on("console", (m) => {
  if (m.type() === "error")
    process.stderr.write(`[renderer-error] ${m.text()}\n`);
});
page.on("pageerror", (e) => process.stderr.write(`[pageerror] ${e.message}\n`));
step("window");
await page.waitForLoadState("domcontentloaded");

const failures = [];
const check = (ok, what, detail = "") => {
  if (!ok) failures.push(`${what}${detail ? ` — ${detail}` : ""}`);
};

// --- the renderer booted at all ------------------------------------------------
check((await page.title()) === "ShadowBit", "window title", await page.title());
check(
  (await page.$eval(".brand h1", (e) => e.textContent.trim())) === "ShadowBit",
  "brand rendered",
);

// --- no development affordances in a shipped build -----------------------------
check(
  !(await app.evaluate(({ Menu }) =>
    (function find(items) {
      return items.some((i) =>
        i.role === "toggleDevTools"
          ? true
          : i.submenu
            ? find(i.submenu.items)
            : false,
      );
    })(Menu.getApplicationMenu().items),
  )),
  "DevTools must not be offered in a packaged build",
);

// --- the CSP actually shipped --------------------------------------------------
const csp = await page.$eval(
  'meta[http-equiv="Content-Security-Policy"]',
  (e) => e.getAttribute("content") ?? "",
);
check(csp.includes("object-src 'none'"), "CSP object-src", csp);
check(csp.includes("base-uri 'none'"), "CSP base-uri", csp);

// --- the real test: a vault operation, worker thread loaded from inside the asar
//
// Everything below drives the DOM through evaluate() rather than page.click().
// Opening a vault legitimately calls shell.openPath(), which in a PACKAGED build
// really does hand the working folder to the OS file manager — SHADOWBIT_E2E_TEST
// is deliberately inert there (see IS_E2E in main.ts). That spawns a file-manager
// window, and the app's own loading overlay then covers the UI, so a
// hit-testing click on a tab would block forever. Asserting on state rather than
// on clickability is the right way to test a window the app hands off to the OS.
await page
  .waitForSelector("#welcome-modal:not(.hidden)", { timeout: 8_000 })
  .catch(() => {});
await page
  .evaluate(() => document.getElementById("welcome-start")?.click())
  .catch(() => {});
await page.waitForTimeout(300);
step("welcome dismissed");
await page.evaluate(() => document.querySelector('[data-tab="open"]')?.click());
await page.waitForSelector("#panel-open.active");
step("on open tab");
await page.$eval("#open-path", (e, p) => (e.value = p), vaultPath);
step("path set");
await page.fill("#open-password", PASS);
step("password filled");
await page.evaluate(() => document.getElementById("open-go")?.click());
step("open clicked");

// A session card only exists if the worker thread loaded from inside the asar and
// really decrypted and unpacked the vault.
let cards = 0;
try {
  await page.waitForFunction(
    () => document.querySelectorAll(".session").length > 0,
    undefined,
    {
      timeout: 45_000,
    },
  );
  await page.evaluate(() =>
    document.querySelector('[data-tab="sessions"]')?.click(),
  );
  cards = await page.$$eval(".session", (els) => els.length);
} catch {
  cards = 0;
  step("no session card appeared");
  const diag = await page.evaluate(() => ({
    toast: document.getElementById("toast")?.textContent ?? "",
    loadingHidden: document
      .getElementById("loading-overlay")
      ?.classList.contains("hidden"),
    panel: document.querySelector(".tab.active")?.textContent?.trim(),
  }));
  process.stderr.write(`[diag] ${JSON.stringify(diag)}\n`);
}
check(
  cards === 1,
  "vault opens and renders a session card",
  `got ${cards} cards`,
);
const toast = await page.$eval("#toast", (e) => e.textContent ?? "");
check(/opened/i.test(toast) || cards === 1, "open reports success", toast);

// --- a working directory really landed on disk ---------------------------------
const wd = await page.$eval(".session .wd", (e) => e.textContent?.trim() ?? "");
check(!!wd && fs.existsSync(wd), "working dir exists on disk", wd);

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error("packaged build FAILED:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log(`packaged build OK (${path.relative(ROOT, binary)})`);
