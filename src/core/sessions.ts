// Tracks which vaults are currently "open" (decrypted to a temp working dir).
// This registry stores ONLY paths and timestamps — never keys or passwords.
// It lets a stateless CLI (and the GUI) find and close open sessions.
//
// Writes are protected by an advisory lock file (.lock sibling) so that
// concurrent CLI + GUI access does not produce a torn sessions.json.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { VaultSession } from "./types";
import { readEncryptedJson, writeEncryptedJson } from "./localkey";
import { suppressIndexing, withAdvisoryLock } from "./fsutil";

const CONFIG_DIR = process.env.SHADOWBIT_CONFIG_DIR
  ? path.resolve(process.env.SHADOWBIT_CONFIG_DIR)
  : path.join(os.homedir(), ".shadow-bit");
const SESSIONS_FILE = path.join(CONFIG_DIR, "sessions.json");
const LOCK_FILE = `${SESSIONS_FILE}.lock`;
// Retries x backoff = 3 s of waiting, well inside the 10 s staleness window, so
// the lock is never stolen out from under a holder that is merely slow.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 20;
const LOCK_BACKOFF_MS = 150;

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Advisory file lock
// ---------------------------------------------------------------------------

// The lock primitive itself lives in fsutil.withAdvisoryLock — settings.ts
// guards its own read-modify-write the same way, and two copies of a
// hand-rolled lock is how they drift apart.

/** Read sessions without touching the lock. Only call inside the lock, or for
 *  read-only use where a slightly stale view is acceptable. */
function readSessionsUnlocked(): VaultSession[] {
  // Try encrypted read first; falls back to plaintext and auto-migrates.
  try {
    const parsed = readEncryptedJson<unknown>(SESSIONS_FILE);
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null) return []; // parsed but not an array
  } catch {
    /* fall through to legacy read */
  }

  // Legacy plaintext read (pre-encryption or corrupt encrypted).
  let raw: string;
  try {
    raw = fs.readFileSync(SESSIONS_FILE, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    try {
      fs.renameSync(SESSIONS_FILE, `${SESSIONS_FILE}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort */
    }
    return [];
  }
}

/**
 * Run `fn` with the whole read-modify-write cycle under the advisory lock.
 * `fn` receives the currently-persisted session list so it can build the new
 * list from the freshest state rather than from a pre-lock snapshot.
 */
function withSessionsLock(fn: (current: VaultSession[]) => void): void {
  ensureConfigDir();
  withAdvisoryLock(LOCK_FILE, () => fn(readSessionsUnlocked()), {
    retries: LOCK_RETRIES,
    backoffMs: LOCK_BACKOFF_MS,
    staleMs: LOCK_STALE_MS,
  });
}

export function loadSessions(): VaultSession[] {
  return readSessionsUnlocked();
}

/** Persist the session list (atomic tmp+rename, encrypted at rest). */
function writeSessions(sessions: VaultSession[]): void {
  writeEncryptedJson(SESSIONS_FILE, sessions);
}

export function findSession(vaultPath: string): VaultSession | undefined {
  const abs = path.resolve(vaultPath);
  return loadSessions().find((s) => s.vaultPath === abs);
}

export function addSession(session: VaultSession): void {
  withSessionsLock((current) => {
    const sessions = current.filter((s) => s.vaultPath !== session.vaultPath);
    sessions.push(session);
    writeSessions(sessions);
  });
}

export function removeSession(vaultPath: string): void {
  const abs = path.resolve(vaultPath);
  withSessionsLock((current) => {
    writeSessions(current.filter((s) => s.vaultPath !== abs));
  });
}

/**
 * Update an existing session entry in place (e.g. after a header hash
 * refresh following a password change). If no session exists for the vault,
 * this is a no-op.
 */
export function updateSession(
  vaultPath: string,
  patch: Partial<VaultSession>,
): void {
  const abs = path.resolve(vaultPath);
  withSessionsLock((current) => {
    writeSessions(
      current.map((s) => (s.vaultPath === abs ? { ...s, ...patch } : s)),
    );
  });
}

/**
 * Create a fresh temp working directory for an opened vault.
 * Uses mkdtemp (exclusive creation — immune to symlink/pre-creation races)
 * inside a 0700 parent, so no other local user can read the decrypted files.
 */
export function makeWorkingDir(vaultPath: string): string {
  const base = path.basename(vaultPath).replace(/\.[^.]+$/, "");
  const parent = path.join(os.tmpdir(), "shadow-bit");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(parent, 0o700); // tighten in case it pre-existed with 0755
  } catch {
    /* best-effort */
  }
  const dir = fs.mkdtempSync(path.join(parent, `${base}-`));
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort (Windows has no POSIX perms) */
  }
  // Suppress Spotlight / Windows Search on the decrypted working dir.
  suppressIndexing(dir);
  suppressIndexing(parent);
  return dir;
}
