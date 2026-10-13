// Local machine key management for encrypting session/settings files at rest.
//
// The key is stored in a file at ~/.shadow-bit/.local-key (mode 0600), or
// under $SHADOWBIT_CONFIG_DIR when that is set. On first use, a random 256-bit
// key is generated. If the key is lost (OS reinstall, etc.), the worst case is
// losing session/settings data — no vault data is affected, because the vault
// file itself is self-contained.
//
// Future: integrate with OS keychains (macOS Keychain, Windows Credential
// Manager, Linux libsecret) for stronger protection.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { sleepSync } from "./fsutil";

const CONFIG_DIR = process.env.SHADOWBIT_CONFIG_DIR
  ? path.resolve(process.env.SHADOWBIT_CONFIG_DIR)
  : path.join(os.homedir(), ".shadow-bit");

const KEY_FILE = path.join(CONFIG_DIR, ".local-key");
const GCM_IV_BYTES = 12;
const KEY_BYTES = 32;
// Total wait before giving up on a peer's claim: 40 x 25ms = 1s. A claim older
// than half that (500ms) is assumed to belong to a process that died between
// the create and the write, and is recovered rather than waited on forever.
const KEY_CLAIM_RETRIES = 40;
const KEY_CLAIM_BACKOFF_MS = 25;

/** Marker prepended to encrypted files so we can detect plain vs encrypted. */
const ENCRYPTED_MARKER = Buffer.from("SBENC\x00", "latin1"); // 6 bytes

let cachedKey: Buffer | null = null;

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best-effort */
  }
}

/**
 * Read an existing key file. Returns null when it is absent, unreadable, or
 * the wrong length.
 */
function readKeyFile(): Buffer | null {
  try {
    const raw = fs.readFileSync(KEY_FILE);
    return raw.length === KEY_BYTES ? raw : null;
  } catch {
    return null;
  }
}

/** Size of the key file in bytes, or null when it does not exist. */
function statKeyFileSize(): number | null {
  try {
    return fs.statSync(KEY_FILE).size;
  } catch {
    return null;
  }
}

/**
 * Get or generate the local machine key (256-bit random, stored in a key file).
 * The key is cached in memory for the process lifetime.
 *
 * First-run concurrency. Several processes (CLI + GUI, or two CLIs) can hit a
 * missing key file at the same time. Generating a key and renaming it into
 * place unconditionally is a data-loss race: every loser keeps its OWN key
 * cached in memory while the file on disk holds the winner's, so sessions the
 * loser writes can never be decrypted again — by itself or by anyone else.
 *
 * Instead the file is claimed with an O_EXCL create, the same atomic primitive
 * `sessions.ts` uses for its advisory lock. Exactly one process wins and its
 * bytes become the canonical key; the losers discard their candidate and read
 * the winner's back off disk, so every process converges on one key.
 *
 * The claim-then-write is not itself atomic, so between the winning `openSync`
 * and its `writeSync` the file exists at zero length. A process that observes
 * that state must wait, never treat it as corruption — see the loop below,
 * where overwriting a peer's in-flight file would split the keys again.
 */
export function getLocalKey(): Buffer {
  if (cachedKey) return cachedKey;

  ensureConfigDir();

  for (let attempt = 0; attempt < KEY_CLAIM_RETRIES; attempt++) {
    // Fast path: a complete key is already on disk.
    const existing = readKeyFile();
    if (existing) {
      cachedKey = existing;
      return cachedKey;
    }

    // Try to claim the file atomically. "wx" fails with EEXIST if a peer won.
    let fd: number | null = null;
    try {
      fd = fs.openSync(KEY_FILE, "wx", 0o600);
      fs.writeSync(fd, crypto.randomBytes(KEY_BYTES));
      fs.closeSync(fd);
      fd = null;
      const written = readKeyFile();
      if (!written) {
        throw new Error(
          `local key at ${KEY_FILE} vanished after being written`,
        );
      }
      cachedKey = written;
      return cachedKey;
    } catch (e) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        // We created the file but failed to fill it. Remove it only if it is
        // still empty; if a peer already replaced it, leave their bytes alone.
        if (statKeyFileSize() === 0) {
          try {
            fs.rmSync(KEY_FILE, { force: true });
          } catch {
            /* ignore */
          }
        }
        throw e;
      }
      // EEXIST: a peer claimed it and may still be writing. Fall through and
      // retry the read on the next iteration.
    }

    const size = statKeyFileSize();

    if (size === null) {
      // The peer's file vanished (e.g. its write failed). Retry the claim.
      continue;
    }

    if (size === 0) {
      // In-flight claim: the winner has not written its bytes yet. Wait.
      //
      // If the file is *still* empty after half the retry budget, the claiming
      // process died between the create and the write. Unlinking it is safe
      // even then: the winner re-reads after writing (see above), so it adopts
      // whatever ends up on disk rather than trusting its own candidate, and
      // the next iteration re-claims atomically. Both sides still converge.
      if (attempt >= KEY_CLAIM_RETRIES / 2) {
        try {
          fs.rmSync(KEY_FILE, { force: true });
        } catch {
          /* ignore */
        }
      }
      sleepSync(KEY_CLAIM_BACKOFF_MS);
      continue;
    }

    // Non-empty but the wrong length. One retry first, to rule out a peer
    // mid-write on a filesystem where the write is not atomic. Only after that
    // do we accept that the file is genuinely corrupt and unlink it — the next
    // iteration then re-claims it atomically, so even several processes
    // recovering at once converge on a single winner.
    if (attempt > 0) {
      try {
        fs.rmSync(KEY_FILE, { force: true });
      } catch {
        /* ignore */
      }
    }
    sleepSync(KEY_CLAIM_BACKOFF_MS);
  }

  throw new Error(`local key at ${KEY_FILE} could not be established; retry`);
}

/**
 * Encrypt a UTF-8 string with the local machine key (AES-256-GCM).
 * Returns a Buffer: [ENCRYPTED_MARKER][IV 12B][AUTH_TAG 16B][CIPHERTEXT].
 */
export function encryptLocal(plaintext: string): Buffer {
  const key = getLocalKey();
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTED_MARKER, iv, tag, data]);
}

/**
 * Decrypt a Buffer produced by encryptLocal. Returns the UTF-8 plaintext.
 * Returns null if decryption fails (wrong key, tampered data, or not encrypted).
 */
export function decryptLocal(buf: Buffer): string | null {
  if (buf.length < ENCRYPTED_MARKER.length + GCM_IV_BYTES + 16) return null;
  if (!buf.subarray(0, ENCRYPTED_MARKER.length).equals(ENCRYPTED_MARKER)) {
    return null; // not encrypted — return null so callers can fall back to plain
  }
  const key = getLocalKey();
  const offset = ENCRYPTED_MARKER.length;
  const iv = buf.subarray(offset, offset + GCM_IV_BYTES);
  const tag = buf.subarray(offset + GCM_IV_BYTES, offset + GCM_IV_BYTES + 16);
  const data = buf.subarray(offset + GCM_IV_BYTES + 16);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null; // wrong key or corrupted
  }
}

/**
 * Read a JSON file that may be encrypted or plaintext.
 * - If encrypted (starts with ENCRYPTED_MARKER): decrypt, parse JSON.
 * - If plaintext JSON: parse directly, then re-encrypt and overwrite.
 * - If unreadable/corrupt: return null.
 */
export function readEncryptedJson<T>(filePath: string): T | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return null; // not found or unreadable
  }

  // Try decrypting first.
  const decrypted = decryptLocal(raw);
  if (decrypted !== null) {
    try {
      return JSON.parse(decrypted) as T;
    } catch {
      return null;
    }
  }

  // Not encrypted — try as plaintext JSON (migration from unencrypted).
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as T;
    // Migrate: re-write as encrypted.
    try {
      writeEncryptedJson(filePath, parsed);
    } catch {
      /* best-effort migration — don't fail the read */
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write a value as encrypted JSON to a file (atomic: tmp + rename).
 */
export function writeEncryptedJson<T>(filePath: string, data: T): void {
  ensureConfigDir();
  const json = JSON.stringify(data, null, 2);
  const encrypted = encryptLocal(json);
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, encrypted);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Clear the cached key (for testing). */
export function _clearCachedKey(): void {
  cachedKey = null;
}
