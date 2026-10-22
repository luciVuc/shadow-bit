// Persists user preferences to ~/.shadow-bit/settings.json — separate
// from sessions.json, which only tracks active open sessions.
//
// All writes are atomic (tmp + rename) for the same reason as sessions.ts.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEncryptedJson, writeEncryptedJson } from "./localkey";
import { withAdvisoryLock } from "./fsutil";

// Mirrors the CONFIG_DIR logic in sessions.ts; both read from the same env var
// so they always point to the same directory.
const CONFIG_DIR = process.env.SHADOWBIT_CONFIG_DIR
  ? path.resolve(process.env.SHADOWBIT_CONFIG_DIR)
  : path.join(os.homedir(), ".shadow-bit");

const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
const LOCK_FILE = `${SETTINGS_FILE}.lock`;
const MAX_RECENT = 10;

/**
 * Accepted auto-lock durations, in minutes. `0` means "never lock".
 *
 * A stored value outside this set is not honoured — `getAutoLockMinutes` falls
 * back to the default rather than arming a timer with it. That is deliberate:
 * settings.json is an encrypted file any process running as the user can write,
 * and it may also predate a change to this list.
 */
export const AUTO_LOCK_CHOICES: readonly number[] = [0, 5, 15, 30, 60];
const DEFAULT_AUTO_LOCK_MINUTES = 30;

export type Theme = "dark" | "light" | "system";
const THEMES: readonly Theme[] = ["dark", "light", "system"];
const DEFAULT_THEME: Theme = "dark";

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/**
 * Window geometry bounds, mirroring the `minWidth`/`minHeight` in main.ts's
 * BrowserWindow options. A stored geometry smaller than the minimum cannot be
 * honoured anyway, and one larger than any real display is a corrupted value
 * rather than a user preference.
 */
const MAX_WINDOW_DIMENSION = 100_000;

interface AppSettings {
  recentVaults?: string[];
  autoLockMinutes?: number; // 0 = never; default 30
  theme?: Theme;
  windowBounds?: WindowBounds;
  onboardingDone?: boolean;
  checkForUpdates?: boolean; // default true
}

const DEFAULT_CHECK_FOR_UPDATES = true;

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best-effort */
  }
}

function loadSettings(): AppSettings {
  try {
    const parsed = readEncryptedJson<AppSettings>(SETTINGS_FILE);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
  } catch {
    /* fall through */
  }
  // Legacy plaintext fallback.
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as AppSettings;
  } catch {
    /* not created yet, or corrupt */
  }
  return {};
}

function saveSettings(s: AppSettings): void {
  ensureConfigDir();
  writeEncryptedJson(SETTINGS_FILE, s);
}

/**
 * Read-modify-write the settings under an advisory lock.
 *
 * Same primitive, and the same reason, as sessions.ts: the GUI writes settings
 * from several places (theme toggle, auto-lock select, window bounds on close)
 * and the CLI shares the file. Without a lock, a window-bounds save landing
 * between a theme read and its write silently reverted the theme. Every writer
 * goes through here so the critical section is always read → mutate → write.
 */
function updateSettings(mutate: (s: AppSettings) => void): void {
  ensureConfigDir();
  withAdvisoryLock(LOCK_FILE, () => {
    const s = loadSettings();
    mutate(s);
    saveSettings(s);
  });
}

// ---------------------------------------------------------------------------
// Recent vaults
// ---------------------------------------------------------------------------

/**
 * Return up to MAX_RECENT recent vault paths, filtering out deleted files.
 * Errors are swallowed — a missing/corrupt settings file is not fatal.
 */
export function getRecentVaults(): string[] {
  try {
    return (loadSettings().recentVaults ?? []).filter((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Push a vault path to the front of the recent list (deduplicated, capped at
 * MAX_RECENT). Errors are swallowed — recent-list updates are best-effort.
 */
export function addRecentVault(vaultPath: string): void {
  const abs = path.resolve(vaultPath);
  try {
    updateSettings((s) => {
      const current = s.recentVaults ?? [];
      s.recentVaults = [abs, ...current.filter((p) => p !== abs)].slice(
        0,
        MAX_RECENT,
      );
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Remove a vault from the recent list — call this when a vault is deleted.
 * Errors are swallowed.
 */
export function removeRecentVault(vaultPath: string): void {
  const abs = path.resolve(vaultPath);
  try {
    updateSettings((s) => {
      s.recentVaults = (s.recentVaults ?? []).filter((p) => p !== abs);
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Empty the recent list (the GUI menu's "Clear Recent Vaults"). Unlike
 * removeRecentVault it also drops entries whose file is already gone —
 * getRecentVaults() filters those out, so looping it would leave them behind.
 * Errors are swallowed.
 */
export function clearRecentVaults(): void {
  try {
    updateSettings((s) => {
      s.recentVaults = [];
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Auto-lock
// ---------------------------------------------------------------------------

/**
 * Returns the configured auto-lock duration in minutes (0 = never).
 *
 * The stored value is validated, not trusted: settings.json is an encrypted
 * file on disk that any process running as the user can write, and it may also
 * predate a change to the accepted set. A negative or non-numeric value used to
 * flow straight into `setTimeout(minutes * 60_000)`, arming a timer that fired
 * immediately (or never).
 */
export function getAutoLockMinutes(): number {
  try {
    const v = loadSettings().autoLockMinutes;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return DEFAULT_AUTO_LOCK_MINUTES;
    }
    const n = Math.floor(v);
    if (!AUTO_LOCK_CHOICES.includes(n)) return DEFAULT_AUTO_LOCK_MINUTES;
    return n;
  } catch {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
}

/**
 * The window minimums, exported so `main.ts` uses the same numbers for the
 * BrowserWindow's `minWidth`/`minHeight` that the saved geometry is validated
 * against. Two copies of "640x480" is how the clamp and the constraint drift.
 */
export const MIN_WINDOW_WIDTH = 640;
export const MIN_WINDOW_HEIGHT = 480;

/** Persist the auto-lock duration. Must be one of AUTO_LOCK_CHOICES. */
export function setAutoLockMinutes(minutes: number): void {
  const n = Math.floor(Number(minutes));
  if (!AUTO_LOCK_CHOICES.includes(n)) return;
  try {
    updateSettings((s) => {
      s.autoLockMinutes = n;
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Update checks
// ---------------------------------------------------------------------------

/**
 * Whether the GUI should periodically poll GitHub for a newer release.
 *
 * Read-validated like every other setting: anything that is not an explicit
 * `false` counts as enabled, so a corrupt value can never silently turn the
 * check OFF — the failure mode is one extra network request, not a user living
 * in the belief they will be told about an update.
 */
export function getCheckForUpdates(): boolean {
  try {
    return loadSettings().checkForUpdates !== false;
  } catch {
    return DEFAULT_CHECK_FOR_UPDATES;
  }
}

export function setCheckForUpdates(value: boolean): void {
  try {
    updateSettings((s) => {
      s.checkForUpdates = value === true;
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * The persisted theme. Validated on read: an unrecognised string used to be
 * returned as-is and then applied as `data-theme="<junk>"`, which matches
 * neither theme block and silently leaves the app on the system default.
 */
export function getTheme(): Theme {
  try {
    const t = loadSettings().theme;
    return THEMES.includes(t as Theme) ? (t as Theme) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function setTheme(theme: Theme): void {
  if (!THEMES.includes(theme)) return;
  try {
    updateSettings((s) => {
      s.theme = theme;
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Window bounds
// ---------------------------------------------------------------------------

/**
 * The last saved window geometry, validated.
 *
 * The other settings getters validate on read, and this one has to as well:
 * settings.json is an encrypted file any process running as the user can write,
 * and `main.ts`'s `usableWindowBounds()` does `Math.max(saved.width, MIN_WINDOW_WIDTH)`. A
 * stored `"width": "abc"` makes that `NaN`, and `NaN ?? 900` is `NaN` — not the
 * 900 fallback — so the window would be constructed with a NaN dimension rather
 * than falling back to Electron's default. Reject anything that is not a finite
 * number within a sane range instead.
 */
export function getWindowBounds(): WindowBounds | undefined {
  try {
    const b = loadSettings().windowBounds;
    if (!b || typeof b !== "object") return undefined;
    const width = Number(b.width);
    const height = Number(b.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
    if (width < MIN_WINDOW_WIDTH || width > MAX_WINDOW_DIMENSION) {
      return undefined;
    }
    if (height < MIN_WINDOW_HEIGHT || height > MAX_WINDOW_DIMENSION) {
      return undefined;
    }
    const out: WindowBounds = {
      width: Math.floor(width),
      height: Math.floor(height),
    };
    // x/y are optional, and each must be independently usable: one bad
    // coordinate is discarded rather than sinking the whole saved geometry,
    // since a window with only a size is still worth restoring.
    const x = Number(b.x);
    const y = Number(b.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out.x = Math.floor(x);
      out.y = Math.floor(y);
    }
    return out;
  } catch {
    return undefined;
  }
}

export function saveWindowBounds(bounds: WindowBounds): void {
  try {
    updateSettings((s) => {
      s.windowBounds = bounds;
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export function isOnboardingDone(): boolean {
  try {
    return loadSettings().onboardingDone === true;
  } catch {
    return false;
  }
}

export function markOnboardingDone(): void {
  try {
    updateSettings((s) => {
      s.onboardingDone = true;
    });
  } catch {
    /* best-effort */
  }
}
