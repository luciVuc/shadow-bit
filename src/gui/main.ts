// Electron main process. Wires the renderer UI to the shared core via IPC.
//
// Every vault operation is dispatched to a worker thread. The main process
// handles no key material and performs no vault I/O; only UI concerns (window
// lifecycle, dialogs, session enumeration for the auto-lock/quit guards, and
// clipboard handling) run here.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  clipboard,
  nativeImage,
  Menu,
  screen,
} from "electron";
import * as path from "path";
import { existsSync, readFileSync } from "fs";
import { pathToFileURL } from "url";
import { loadSessions } from "../core/sessions";
import { VAULT_EXT, VAULT_EXTS, hasVaultExt } from "../core/container";
import {
  addRecentVault,
  getRecentVaults,
  removeRecentVault,
  clearRecentVaults,
  getAutoLockMinutes,
  setAutoLockMinutes,
  getTheme,
  setTheme,
  getWindowBounds,
  saveWindowBounds,
  isOnboardingDone,
  markOnboardingDone,
  getCheckForUpdates,
  setCheckForUpdates,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type Theme,
} from "../core/settings";
import { callWorker, terminateWorker } from "./vault-worker-bridge";

// When SHADOWBIT_E2E_TEST=1 is set, skip shell.openPath() calls and quit dialogs.
//
// Gated on `!app.isPackaged` as well as the env var. `app.isPackaged` is true
// only for a build produced by electron-builder, so this can be switched on by
// an E2E harness during development and cannot be switched on in a shipped
// build. Without that gate the variable was a one-env-var way to disable the
// quit guard, the auto-lock timer, and every confirmation dialog — in an app
// whose entire purpose is not leaking state.
const IS_E2E = !app.isPackaged && process.env.SHADOWBIT_E2E_TEST === "1";

// Running unpackaged (npm run gui / gui:dev) rather than from an
// electron-builder output. Gates development-only affordances such as the
// DevTools menu item.
const IS_DEV = !app.isPackaged;

app.setName("ShadowBit");

// ---------------------------------------------------------------------------
// File association: capture vault path before the window is ready
// ---------------------------------------------------------------------------
let pendingFilePath: string | null = null;

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (hasVaultExt(filePath) && existsSync(filePath)) {
    pendingFilePath = path.resolve(filePath);
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      wins[0].webContents.send("app:openVaultFile", pendingFilePath);
      pendingFilePath = null;
    }
  }
});

function getArgFilePath(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const vaultArg = args.find((a) => hasVaultExt(a) && existsSync(a));
  return vaultArg ? path.resolve(vaultArg) : null;
}

// ---------------------------------------------------------------------------
// Update checks
// ---------------------------------------------------------------------------
//
// The GUI polls the GitHub Releases API for a newer version. Detection only —
// no auto-download: the user is always sent to the release page they can read,
// in keeping with an app whose users care about provenance.
//
// The repo URL is derived from package.json's `repository` field rather than
// hardcoded, so a repo move cannot leave this file pointing somewhere else.
// The fallback constant exists for the pathological case where the file cannot
// be read; it matches the same field.

const REPO_URL = (() => {
  const FALLBACK = "https://github.com/luciVuc/shadow-bit";
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    );
    const raw = pkg?.repository?.url ?? pkg?.repository ?? "";
    const m = /^git\+?https:\/\/github\.com\/([^/]+)\/([^/.]+?)(\.git)?$/.exec(
      String(raw),
    );
    return m ? `https://github.com/${m[1]}/${m[2]}` : FALLBACK;
  } catch {
    return FALLBACK;
  }
})();

const RELEASES_URL = `${REPO_URL}/releases/latest`;
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_URL.replace("https://github.com/", "")}/releases/latest`;

/**
 * Tolerance-free semver comparison of "current vs latest". The version read
 * via `app.getVersion()` is electron-builder's installed metadata, so it always
 * agrees with package.json.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const nums = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const a = nums(candidate);
  const b = nums(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  isNew: boolean;
  url: string;
}

/** The most recent successful check's outcome, re-pushed after every reload. */
let lastUpdateInfo: UpdateInfo | null = null;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;

const UPDATE_CHECK_FIRST_DELAY_MS = 30_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * One check against the GitHub API. Network errors are surfaced to the caller
 * (its choice whether to report them): a scheduled check must stay silent, but
 * the About dialog's button must not pretend every failure means "up to date".
 */
async function performUpdateCheck(): Promise<UpdateInfo> {
  const current = app.getVersion();
  const res = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ShadowBit",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status}.`);
  }
  const data: any = await res.json();
  const tag = typeof data?.tag_name === "string" ? data.tag_name : "";
  const latest = tag.replace(/^v/i, "") || current;
  const info: UpdateInfo = {
    current,
    latest,
    isNew: isNewerVersion(latest, current),
    url: RELEASES_URL,
  };
  if (info.isNew) {
    lastUpdateInfo = info;
    sendToRenderer("app:updateAvailable", {
      latest: info.latest,
      url: info.url,
    });
  }
  return { ...info, isNew: info.isNew };
}

/**
 * (Re)arm the scheduled check. Chained timeOuts rather than an interval, so a
 * re-arm after a settings toggle cannot stack two concurrent loops. Skipped
 * under E2E: the harness runs offline, and a request fired at window startup
 * would otherwise leak into every smoke test.
 */
function scheduleAutoUpdateCheck(delayMs = UPDATE_CHECK_FIRST_DELAY_MS): void {
  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (IS_E2E || !getCheckForUpdates()) return;
  updateCheckTimer = setTimeout(() => {
    void performUpdateCheck()
      .catch(() => undefined)
      .finally(() => scheduleAutoUpdateCheck(UPDATE_CHECK_INTERVAL_MS));
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------

/**
 * Auto-lock is an *idle* timer, so it must be reset by user activity, not only
 * by vault operations. It used to reset solely on vault IPC traffic, which
 * meant a user could be mid-way through editing files in their working folder —
 * perfectly idle as far as ShadowBit was concerned — and get locked out with
 * their unsaved changes erased. The settings control already said "after idle",
 * so this makes the behaviour match the label.
 *
 * The renderer forwards activity, throttled to one message per 20 s (see
 * renderer.js), and the window's own focus events
 * count too — regaining focus after five minutes away is exactly the case where
 * locking without warning is most surprising.
 */
let autoLockTimer: ReturnType<typeof setTimeout> | null = null;

function resetAutoLockTimer(): void {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
  if (IS_E2E) return;
  const minutes = getAutoLockMinutes();
  if (!minutes) return;
  autoLockTimer = setTimeout(() => {
    void lockOpenVaults("auto");
  }, minutes * 60_000);
}

// ---------------------------------------------------------------------------
// Clipboard auto-clear for recovery keys
// ---------------------------------------------------------------------------
let clipboardClearTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Quit guard for open vaults
// ---------------------------------------------------------------------------
let allowQuit = false;

app.on("before-quit", async (event) => {
  if (allowQuit || IS_E2E) return;
  const sessions = loadSessions().filter((s) => existsSync(s.workingDir));
  if (sessions.length === 0) return;

  event.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    allowQuit = true;
    app.quit();
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Go Back", "Quit Anyway"],
    defaultId: 0,
    cancelId: 0,
    title: "Open Vaults",
    message: `You have ${sessions.length} open vault(s).`,
    detail:
      "Quitting will leave decrypted files in temporary folders. " +
      "Close or discard them first for safety.\n\n" +
      sessions.map((s) => `• ${path.basename(s.vaultPath)}`).join("\n"),
  });
  if (response === 1) {
    allowQuit = true;
    terminateWorker();
    app.quit();
  }
});

app.on("will-quit", () => {
  terminateWorker();
  if (autoLockTimer) clearTimeout(autoLockTimer);
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
});

// ---------------------------------------------------------------------------
// Renderer command channel
// ---------------------------------------------------------------------------
// The menu is the main process's job; the UI is the renderer's. Menu items whose
// effect is a UI change (switch tab, focus a field) are forwarded as commands
// rather than implemented here, so there is exactly one code path per action
// whether it is triggered from the menu or from a button.
//
// Commands dispatched before the renderer finishes loading are buffered and
// flushed on did-finish-load — otherwise an early Cmd+N would be dropped and
// look like a broken menu.
let rendererReady = false;
const pendingCommands: Array<{ channel: string; payload: unknown }> = [];

function sendToRenderer(channel: string, payload?: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || !rendererReady) {
    pendingCommands.push({ channel, payload });
    return;
  }
  win.webContents.send(channel, payload);
}

function flushPendingCommands(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  rendererReady = true;
  for (const { channel, payload } of pendingCommands) {
    win.webContents.send(channel, payload);
  }
  pendingCommands.length = 0;
}

/** Send a UI command to the renderer — see the switch in renderer.js. */
function command(cmd: string, arg?: string): void {
  sendToRenderer("app:menuCommand", { cmd, arg });
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
// Built on every platform: the menu is the only place some vault operations
// live, so leaving Windows/Linux without one hides half the app. macOS gets the
// usual app menu in front. The menu is rebuilt whenever the state it reflects
// changes (recent vaults, open vaults, theme).

/** Theme choices, in menu order. `system` follows the OS light/dark setting. */
const THEME_CHOICES: Array<[Theme, string]> = [
  ["system", "Match System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/**
 * Number of open vaults, pushed by the renderer whenever it refreshes the
 * sessions list. Used only to enable/disable "Lock All Vaults" — the lock
 * itself always re-reads the session registry.
 */
let openVaultCount = 0;

function appearanceItems(): Electron.MenuItemConstructorOptions[] {
  const current = getTheme();
  return THEME_CHOICES.map(([value, label]) => ({
    label,
    type: "radio",
    checked: current === value,
    click: () => {
      setTheme(value);
      // Rebuild so the radio tick moves immediately rather than after the
      // renderer's next settings write.
      rebuildAppMenu();
      command("theme", value);
    },
  }));
}

function recentItems(): Electron.MenuItemConstructorOptions[] {
  const recents = getRecentVaults();
  if (recents.length === 0) {
    return [{ label: "No Recent Vaults", enabled: false }];
  }
  return [
    ...recents.map((p, i) => ({
      label: path.basename(p),
      sublabel: path.dirname(p),
      toolTip: p,
      accelerator: i < 9 ? `CmdOrCtrl+Shift+${i + 1}` : undefined,
      // Same channel the OS file association uses: the renderer prefills the
      // Open tab and focuses the password field.
      click: () => sendToRenderer("app:openVaultFile", p),
    })),
    { type: "separator" },
    {
      label: "Clear Recent Vaults",
      click: () => {
        clearRecentVaults();
        rebuildAppMenu();
        command("recents-changed");
      },
    },
  ];
}

function rebuildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => command("settings"),
  };

  const fileItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: "New Vault…",
      accelerator: "CmdOrCtrl+N",
      click: () => command("new-vault"),
    },
    {
      label: "Open Vault…",
      accelerator: "CmdOrCtrl+O",
      click: () => command("open-vault"),
    },
    { label: "Open Recent", submenu: recentItems() },
    { type: "separator" },
    {
      label: "Lock All Vaults",
      accelerator: "CmdOrCtrl+Shift+L",
      enabled: openVaultCount > 0,
      click: () => void lockAllVaults(),
    },
  ];
  // On macOS Settings lives in the app menu instead.
  if (!isMac) fileItems.push({ type: "separator" }, settingsItem);

  const viewItems: Electron.MenuItemConstructorOptions[] = [
    { label: "Appearance", submenu: appearanceItems() },
    { type: "separator" },
    { role: "reload" },
    { role: "forceReload" },
  ];
  // DevTools are a development affordance: the item (and the separator that
  // follows it) exists only in an unpackaged run, so a released build never
  // offers it. `app.isPackaged` is Electron's own signal for that — it is true
  // only when running from the asar inside an electron-builder output.
  if (IS_DEV) {
    viewItems.push({ role: "toggleDevTools" }, { type: "separator" });
  }
  viewItems.push(
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  );

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: "ShadowBit",
      submenu: [
        // Opened in-app rather than Electron's native about panel, so the
        // update-info surface lives in one place on every platform.
        { label: "About ShadowBit", click: () => command("about") },
        { type: "separator" },
        settingsItem,
        { type: "separator" },
        { role: "hide", label: "Hide ShadowBit" },
        { role: "hideOthers", label: "Hide Others" },
        { role: "unhide", label: "Show All" },
        { type: "separator" },
        { role: "quit", label: "Quit ShadowBit" },
      ],
    });
  }

  template.push(
    { label: "File", submenu: fileItems },
    { role: "editMenu" },
    { label: "View", submenu: viewItems },
    {
      label: "Window",
      submenu: isMac
        ? [
            { role: "close" },
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front", label: "Bring All to Front" },
          ]
        : [
            { role: "minimize" },
            { role: "zoom", label: "Maximize" },
            { type: "separator" },
            { role: "close" },
          ],
    },
    {
      // The About dialog hosts the "Check for Updates" button, so the Help
      // menu is where its manual entry point lives on Windows and Linux.
      label: "Help",
      submenu: [{ label: "About ShadowBit", click: () => command("about") }],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Lock every open vault: securely erase the working directories and drop the
 * sessions. Shared by the auto-lock timer and the "Lock All Vaults" menu item;
 * `reason` only affects the message the renderer shows.
 *
 * The erase itself runs on the worker thread. Overwriting every decrypted byte
 * of a large vault blocks for seconds, and doing it here froze the entire UI —
 * including the toast reporting that it had happened.
 */
async function lockOpenVaults(reason: "auto" | "manual"): Promise<void> {
  autoLockTimer = null;
  let count = 0;
  try {
    const n = await callWorker("lockAll", {});
    count = typeof n === "number" && Number.isFinite(n) ? n : 0;
  } catch {
    // The worker is gone. Nothing safe to do here: the caller's decision was
    // already made, and reporting success would be a lie.
    count = 0;
  }
  if (count > 0) {
    sendToRenderer("app:autoLocked", { count, reason });
  }
}

/**
 * Menu-driven lock. Unlike the auto-lock timer this asks first: locking erases
 * the working folders, so anything not yet saved to the .svlt file is lost.
 */
async function lockAllVaults(): Promise<void> {
  const sessions = loadSessions().filter((s) => existsSync(s.workingDir));
  if (sessions.length === 0) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !IS_E2E) {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Lock All"],
      defaultId: 0,
      cancelId: 0,
      title: "Lock open vaults",
      message: `Lock ${sessions.length} open vault(s)?`,
      detail:
        "Working folders are securely erased and the sessions closed. " +
        "Unsaved changes will be lost.\n\n" +
        sessions.map((s) => `• ${path.basename(s.vaultPath)}`).join("\n"),
    });
    if (response !== 1) return;
  }
  await lockOpenVaults("manual");
}

function iconPath(): string {
  const candidates = [
    path.join(process.resourcesPath, "icon.png"),
    path.join(__dirname, "icon.png"),
    path.join(__dirname, "..", "..", "build", "icon.png"),
    path.join(__dirname, "build", "icon.png"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
/**
 * Clamp saved window bounds to a display that still exists.
 *
 * `getWindowBounds()` returns whatever was persisted, and a monitor can be
 * unplugged, a docking station changed, or a resolution lowered between runs.
 * Restoring an x/y that is now off every work area produces a window the user
 * cannot reach — indistinguishable from the app failing to start, and with no
 * way to get the window back short of editing settings.json by hand.
 *
 * Returns undefined when the saved position is unusable, so Electron picks its
 * own default and centres the window.
 */
function usableWindowBounds(): Electron.BrowserWindowConstructorOptions {
  const saved = getWindowBounds();
  if (!saved) return {};
  // getWindowBounds has already rejected non-finite and out-of-range values, so
  // these clamps only ever raise an undersized-but-valid saved geometry up to
  // the window's own minimum. Keep them: they are what guarantee the width and
  // height handed to BrowserWindow are always real numbers.
  const width = Math.max(saved.width, MIN_WINDOW_WIDTH);
  const height = Math.max(saved.height, MIN_WINDOW_HEIGHT);
  if (saved.x === undefined || saved.y === undefined) {
    return { width, height };
  }
  const displays = screen.getAllDisplays();
  // Require the title bar to be reachable: keep at least the top-left corner of
  // the frame inside some display's work area.
  const reachable = displays.some((d) => {
    const wa = d.workArea;
    return (
      saved.x! < wa.x + wa.width &&
      saved.x! + 80 > wa.x &&
      saved.y! < wa.y + wa.height &&
      saved.y! + 40 > wa.y
    );
  });
  if (!reachable) return { width, height };
  return {
    width: Math.min(width, ...displays.map((d) => d.workArea.width)),
    height: Math.min(height, ...displays.map((d) => d.workArea.height)),
    x: saved.x,
    y: saved.y,
  };
}

function createWindow(): void {
  const bounds = usableWindowBounds();
  const win = new BrowserWindow({
    width: bounds.width ?? 900,
    height: bounds.height ?? 680,
    x: bounds.x,
    y: bounds.y,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: "ShadowBit",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.on("close", () => {
    saveWindowBounds(win.getBounds());
  });

  // Regaining focus is activity: the user came back on purpose.
  win.on("focus", () => resetAutoLockTimer());

  // Defense-in-depth: block navigation away from the bundled HTML.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (current === "" || url === current) return;
    event.preventDefault();
  });

  win.webContents.on("did-start-loading", () => {
    rendererReady = false;
  });

  win.webContents.on("did-finish-load", () => {
    rendererReady = true;
    flushPendingCommands();
    // The badged button in the topbar survives a reload only if the state is
    // re-pushed; a renderer reload clears otherwise.
    if (lastUpdateInfo && lastUpdateInfo.isNew) {
      win.webContents.send("app:updateAvailable", {
        latest: lastUpdateInfo.latest,
        url: lastUpdateInfo.url,
      });
    }
    const fp = pendingFilePath ?? getArgFilePath();
    if (fp) {
      win.webContents.send("app:openVaultFile", fp);
      pendingFilePath = null;
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  resetAutoLockTimer();
}

// One whenReady handler for all of it. These used to be two independent
// `app.whenReady().then(...)` blocks; both fire, in registration order, so
// merging them is behaviour-preserving — but the split made the startup
// sequence look accidental rather than chosen, and the menu must exist before
// the window (the window's did-finish-load can flush a buffered menu command
// into a menu item that was never built).
app.whenReady().then(() => {
  if (process.platform === "darwin") {
    const p = iconPath();
    // `app.dock` is macOS-only and typed as possibly-undefined, so it must be
    // guarded rather than assumed present on a build compiled elsewhere.
    app.dock?.setIcon(nativeImage.createFromPath(p));
  }
  rebuildAppMenu();
  createWindow();
  scheduleAutoUpdateCheck();
  app.on("activate", () => {
    allowQuit = false;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// Helper: wrap a result/error envelope for IPC handlers
// ---------------------------------------------------------------------------
function wrap<T>(
  fn: () => T,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** Wrap an async worker call, catching errors into the same envelope. */
async function wrapWorker(
  op: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  resetAutoLockTimer();
  try {
    const value = await callWorker(op, args);
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// IPC: file dialogs
// ---------------------------------------------------------------------------

/**
 * Every IPC handler is registered through here rather than `ipcMain.handle`
 * directly, so a single check covers all of them.
 *
 * `contextIsolation` + `sandbox` mean a renderer compromise cannot reach Node,
 * but it can still call any exposed bridge method. None of these handlers
 * authenticate the sender, and several of them take a filesystem path or delete
 * data, so "some script in that window" should not be enough to invoke them. A
 * frame that is not our bundled renderer document is refused outright.
 *
 * A refused call resolves to `null` — a benign no-op for the raw-value
 * channels (dialogs, listeners), and an "Unknown error" for the enveloped ones.
 * The point is that nothing happens either way.
 */
function handle(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) return null;
    return fn(event, ...args);
  });
}

/** Send events (non-invoke channels) get the same check. */
function on(
  channel: string,
  fn: (event: Electron.IpcMainEvent, ...args: any[]) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) return;
    fn(event, ...args);
  });
}

/**
 * True when the message came from a frame loading our bundled renderer.
 *
 * Compared against the exact document URL `loadFile` was given, so a frame that
 * navigated elsewhere (or a devtools extension surface) is rejected. We do not
 * trust `isTrustedSenderFrame` alone as a positive signal, but we do treat an
 * absent frame as untrusted: every legitimate call has one.
 */
function isTrustedSender(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  return frame.url === rendererUrl();
}

let cachedRendererUrl: string | null = null;
function rendererUrl(): string {
  if (!cachedRendererUrl) {
    cachedRendererUrl = pathToFileURL(
      path.join(__dirname, "renderer", "index.html"),
    ).toString();
  }
  return cachedRendererUrl;
}

/**
 * E2E hook: like the confirm-dialog hook below, native file dialogs block the
 * main process and cannot be driven by Playwright. Under SHADOWBIT_E2E_TEST=1
 * they are answered from `globalThis.__shadowbitPathQueue`, which tests push
 * via `app.evaluate`. An empty queue stands for "the user cancelled", which is
 * what every caller already handles (null, or [] for multi-select).
 */
function nextQueuedPath(): string | null {
  const queue = (globalThis as any).__shadowbitPathQueue;
  if (Array.isArray(queue) && queue.length > 0) return queue.shift() ?? null;
  return null;
}

handle("dialog:createVaultPath", async () => {
  if (IS_E2E) return nextQueuedPath();
  const res = await dialog.showSaveDialog({
    title: "Create new vault",
    defaultPath: `secret.${VAULT_EXT}`,
    filters: [{ name: "Vault", extensions: [...VAULT_EXTS] }],
  });
  return res.canceled ? null : res.filePath;
});

handle("dialog:openVaultPath", async () => {
  if (IS_E2E) return nextQueuedPath();
  const res = await dialog.showOpenDialog({
    title: "Open vault",
    properties: ["openFile"],
    filters: [{ name: "Vault", extensions: [...VAULT_EXTS] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

handle("dialog:pickDir", async () => {
  if (IS_E2E) return nextQueuedPath();
  const res = await dialog.showOpenDialog({
    title: "Choose a folder",
    properties: ["openDirectory"],
  });
  return res.canceled ? null : res.filePaths[0];
});

handle("dialog:pickFiles", async () => {
  if (IS_E2E) {
    const p = nextQueuedPath();
    return p ? [p] : [];
  }
  const res = await dialog.showOpenDialog({
    title: "Add files to vault",
    properties: ["openFile", "multiSelections"],
  });
  return res.canceled ? [] : res.filePaths;
});

// ---------------------------------------------------------------------------
// IPC: vault operations (heavy → worker thread)
// ---------------------------------------------------------------------------
handle("vault:create", async (_e, args) => {
  const result = await wrapWorker("create", {
    vaultPath: args.vaultPath,
    opts: {
      password: args.password,
      generateRecovery: args.generateRecovery,
      seedDir: args.seedDir || undefined,
      keyfiles: args.keyfiles || undefined,
      cipher: args.cipher || undefined,
      paranoid: args.paranoid || undefined,
    },
  });
  if (result.ok) {
    addRecentVault(args.vaultPath);
    rebuildAppMenu(); // the File > Open Recent list just changed
  }
  return result;
});

handle("vault:open", async (_e, args) => {
  const result = await wrapWorker("open", {
    vaultPath: args.vaultPath,
    password: args.password,
    keyfiles: args.keyfiles || undefined,
  });
  if (result.ok) {
    addRecentVault(args.vaultPath);
    rebuildAppMenu();
  }
  return result;
});

handle("vault:close", (_e, args) =>
  wrapWorker("close", {
    vaultPath: args.vaultPath,
    password: args.password,
    keyfiles: args.keyfiles || undefined,
  }),
);

handle("vault:discard", (_e, args) =>
  wrapWorker("discard", {
    vaultPath: args.vaultPath,
    password: args.password,
    keyfiles: args.keyfiles || undefined,
  }),
);

handle("vault:changePassword", (_e, args) =>
  wrapWorker("changePassword", {
    vaultPath: args.vaultPath,
    oldPassword: args.oldPassword,
    newPassword: args.newPassword,
    keyfiles: args.keyfiles || undefined,
    newKeyfiles: args.newKeyfiles || undefined,
  }),
);

handle("vault:recover", (_e, args) =>
  wrapWorker("recover", {
    vaultPath: args.vaultPath,
    recoveryKey: args.recoveryKey,
    newPassword: args.newPassword,
  }),
);

handle("vault:regenRecovery", (_e, args) =>
  wrapWorker("regenRecovery", {
    vaultPath: args.vaultPath,
    password: args.password,
    keyfiles: args.keyfiles || undefined,
  }),
);

handle("vault:removeRecovery", (_e, args) =>
  wrapWorker("removeRecovery", {
    vaultPath: args.vaultPath,
    password: args.password,
    keyfiles: args.keyfiles || undefined,
  }),
);

handle("vault:delete", async (_e, args) => {
  const result = await wrapWorker("delete", {
    vaultPath: args.vaultPath,
    password: args.password,
    opts: { shred: !!args.shred, keyfiles: args.keyfiles || undefined },
  });
  if (result.ok) {
    removeRecentVault(args.vaultPath);
    rebuildAppMenu();
  }
  return result;
});

// All vault operations run on the worker thread. `info`, `sessions`, `addFiles`
// and `setMeta` do touch the filesystem and the session registry, so they
// belong there too — keeping them on the main thread was both inconsistent and
// a path for key material to end up in the main process (setMeta takes a
// password).
handle("vault:preflight", (_e, args) =>
  wrapWorker("preflight", { vaultPath: args.vaultPath }),
);
handle("vault:info", async (_e, args) =>
  wrapWorker("info", { vaultPath: args.vaultPath }),
);
handle("vault:sessions", () => wrapWorker("sessions", {}));
handle("vault:addFiles", (_e, args) =>
  wrapWorker("addFiles", {
    vaultPath: args.vaultPath,
    paths: args.paths,
  }),
);
handle("vault:setMeta", (_e, args) =>
  wrapWorker("setMeta", {
    vaultPath: args.vaultPath,
    password: args.password,
    meta: args.meta,
    keyfiles: args.keyfiles || undefined,
  }),
);

// ---------------------------------------------------------------------------
// IPC: file browser (list, delete, rename within working dir)
// ---------------------------------------------------------------------------
//
// These run on the worker thread, like every other operation that touches
// decrypted content. They used to run here and trust a `workingDir` string
// straight from the renderer, which meant `files:delete` would `rmSync
// --recursive` whatever directory it was handed — any directory the user could
// reach — and `files:list` could walk the whole filesystem. The core now
// resolves the folder against the session registry first
// (resolveOpenWorkingDir in vault.ts), so only a vault this build actually
// opened is addressable, and the main thread stays free of vault I/O.

handle("files:list", (_e, args) =>
  wrapWorker("listFiles", { workingDir: args.workingDir }),
);
handle("files:delete", (_e, args) =>
  wrapWorker("deleteFile", {
    workingDir: args.workingDir,
    relPath: args.relPath,
  }),
);
handle("files:rename", (_e, args) =>
  wrapWorker("renameFile", {
    workingDir: args.workingDir,
    oldRel: args.oldRel,
    newName: args.newName,
  }),
);

// ---------------------------------------------------------------------------
// IPC: confirm dialog
// ---------------------------------------------------------------------------

/**
 * E2E hook: native message boxes block the main process and cannot be driven
 * by Playwright (they are not part of the renderer's page). When
 * SHADOWBIT_E2E_TEST=1 we skip the real dialog and instead consume the next
 * boolean from `globalThis.__shadowbitConfirmQueue`, which tests push via
 * `app.evaluate`. An empty queue defaults to `true` (proceed) because every
 * vault under test lives in a throwaway temp dir.
 */
handle("dialog:confirm", async (_e, args) => {
  if (IS_E2E) {
    const queue = (globalThis as any).__shadowbitConfirmQueue;
    if (Array.isArray(queue) && queue.length > 0) return !!queue.shift();
    return true;
  }
  const res = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", args.confirmLabel || "OK"],
    defaultId: 0,
    cancelId: 0,
    title: args.title || "Confirm",
    message: args.message || "Are you sure?",
    detail: args.detail,
  });
  return res.response === 1;
});

// ---------------------------------------------------------------------------
// IPC: settings (recent vaults, auto-lock, theme, onboarding)
// ---------------------------------------------------------------------------
// The renderer reports that the user did something, so the idle auto-lock timer
// measures inactivity rather than "time since the last vault command". The
// renderer throttles this, so the handler can reset the timer unconditionally.
on("app:activity", () => resetAutoLockTimer());

handle("settings:getRecent", () => wrap(() => getRecentVaults()));

// There is deliberately no `settings:addRecent` / `settings:removeRecent`.
// Recents are mutated by the main process itself, in the handlers for the
// operations that actually change them (create/open add, delete removes), and
// the renderer only ever reads the list. A renderer-writable "add this path to
// my recents" channel would also be a small but real widening of the trust
// boundary: the recent list is plaintext file paths, and a compromised renderer
// has no reason to be able to write them.

handle("settings:getAutoLock", () => wrap(() => getAutoLockMinutes()));
handle("settings:setAutoLock", (_e, minutes: number) =>
  wrap(() => {
    setAutoLockMinutes(minutes);
    resetAutoLockTimer();
  }),
);

handle("settings:getTheme", () => wrap(() => getTheme()));
handle("settings:setTheme", (_e, theme: string) =>
  wrap(() => {
    setTheme(theme as any);
    // The theme can also be changed from View > Appearance and the topbar
    // toggle, so re-sync the menu's radio group from here.
    rebuildAppMenu();
  }),
);

// The renderer reports how many vaults are open after every sessions refresh;
// the main process uses it only to enable/disable "Lock All Vaults".
on("menu:setOpenVaultCount", (_e, count: number) => {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === openVaultCount) return;
  openVaultCount = n;
  rebuildAppMenu();
});

handle("settings:isOnboardingDone", () => wrap(() => isOnboardingDone()));
handle("settings:markOnboardingDone", () => wrap(() => markOnboardingDone()));

// ---------------------------------------------------------------------------
// IPC: app info and update checks
// ---------------------------------------------------------------------------

handle("app:getVersion", () => wrap(() => app.getVersion()));

handle("settings:getCheckForUpdates", () => wrap(() => getCheckForUpdates()));
handle("settings:setCheckForUpdates", (_e, enabled: boolean) =>
  wrap(() => {
    setCheckForUpdates(enabled === true);
    // Turning the check off also clears any badge the check left behind:
    // announcing "a new version is available" from a feature that was switched
    // off is worse than not announcing it at all.
    if (!getCheckForUpdates()) {
      lastUpdateInfo = null;
      sendToRenderer("app:updateAvailable", null);
    }
    scheduleAutoUpdateCheck();
  }),
);

/**
 * One manual check (About dialog). Unlike the scheduled check, failures here
 * become an error the renderer can toast — "I clicked the button and nothing
 * said anything either way" is not an answer.
 */
handle("updates:check", async () => {
  try {
    return { ok: true, value: await performUpdateCheck() };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
});

/**
 * Open the release page in the user's default browser.
 *
 * The renderer never gets an unconditional "open whatever URL you send me"
 * primitive: `sys:openPath` already exists for local files, and reusing it with
 * a URL would be shell behaviour nobody audited. Instead this validator pins
 * the protocol to https and the host to the app's own domains.
 *
 * Under E2E the target is recorded rather than opened, so smoke tests can
 * assert on it without a browser popping up.
 */
const ALLOWED_EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "shadowbit.app",
]);

handle("sys:openExternal", async (_e, url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (
    parsed.protocol !== "https:" ||
    !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)
  ) {
    return { ok: false, error: `Refusing to open ${parsed.hostname}.` };
  }
  if (IS_E2E) {
    const opened = (globalThis as any).__shadowbitOpenUrls ?? [];
    opened.push(parsed.toString());
    (globalThis as any).__shadowbitOpenUrls = opened;
    return { ok: true, value: parsed.toString() };
  }
  await shell.openExternal(parsed.toString());
  return { ok: true, value: parsed.toString() };
});

// ---------------------------------------------------------------------------
// IPC: system helpers
// ---------------------------------------------------------------------------
handle("sys:openPath", async (_e, p: string) => {
  if (!IS_E2E) await shell.openPath(p);
});

handle("sys:copy", (_e, text: string) => {
  clipboard.writeText(text);
});

handle("sys:copySecret", (_e, text: string) => {
  clipboard.writeText(text);
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
  clipboardClearTimer = setTimeout(() => {
    // `readText()`/`writeText()` became async in Electron 44 (they now mirror
    // the W3C async clipboard API). Comparing the old return value directly —
    // `clipboard.readText() === text` — silently became `Promise === string`,
    // i.e. always false, so the recovery key was NEVER cleared from the
    // clipboard. `await` works on both shapes, so this is correct either way.
    void Promise.resolve(clipboard.readText()).then((current) => {
      // Only clear if the secret is still there: the user may have copied
      // something else in the meantime, and wiping that would be data loss.
      if (current === text) clipboard.writeText("");
      clipboardClearTimer = null;
    });
  }, 30_000);
});
