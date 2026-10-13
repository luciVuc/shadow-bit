// High-level vault operations shared by the CLI and the Electron GUI.
// These orchestrate crypto + container + bundle + sessions.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  DEFAULT_CIPHER,
  DEFAULT_KDF_PARAMS,
  decryptGCM,
  decryptPayload,
  assertCipher,
  deriveKeyFromPassword,
  deriveKeyFromRecovery,
  deriveRecoveryKey,
  deriveHak,
  computeHeaderMac,
  encryptGCM,
  encryptPayload,
  generateMek,
  generateRecoveryKey,
  generateSalt,
  hashRecoveryKey,
  mixKeyfileIntoPassword,
  normalizeRecoveryKey,
  processKeyfiles,
} from "./crypto";
import {
  MAX_PAYLOAD_SIZE,
  compressBundle,
  decompressBundle,
  emptyBundle,
  packDir,
  unpackDir,
} from "./bundle";
import {
  copyInto,
  secureEraseDir,
  secureEraseFile,
  scrubTimestampsRecursive,
} from "./fsutil";
import {
  CURRENT_VERSION,
  HEADER_MAGIC,
  readContainer,
  readHeader,
  readHeaderRaw,
  writeContainer,
} from "./container";
import {
  addSession,
  findSession,
  loadSessions,
  makeWorkingDir,
  removeSession,
  updateSession,
} from "./sessions";
import { AddResult, VaultHeader, VaultInfo } from "./types";

// Re-export for CLI/GUI consumers.
export { estimateStrength } from "./crypto";
export type { PasswordStrength } from "./crypto";

/** Minimum accepted password length, enforced in the core (not just the UI). */
export const MIN_PASSWORD_LENGTH = 8;

/** Error thrown when a password or recovery key is wrong. */
export class WrongCredentialError extends Error {
  constructor(msg = "Incorrect password or corrupt/tampered vault.") {
    super(msg);
    this.name = "WrongCredentialError";
  }
}

export interface CreateOptions {
  password: string;
  /** If true, generate & escrow a recovery key (returned in the result). */
  generateRecovery?: boolean;
  /** Optional: seed the new vault from an existing directory of files. */
  seedDir?: string;
  /** Optional name / description written as plaintext metadata. */
  meta?: { name?: string; description?: string };
  /** Optional keyfile paths. If any are given, they are required for all
   *  future opens (`header.keyfileRequired` is set). */
  keyfiles?: string[];
  /** Encryption algorithm. Default: aes-256-gcm. */
  cipher?: "aes-256-gcm" | "chacha20-poly1305";
  /**
   * Paranoid mode: strip all optional metadata from the plaintext header.
   * - Timestamps are set to epoch (1970-01-01T00:00:00.000Z)
   * - meta.name / meta.description are omitted even if supplied
   * - Minimizes information leakage to anyone who can read the file
   */
  paranoid?: boolean;
}

export interface CreateResult {
  vaultPath: string;
  recoveryKey?: string;
}

/** Enforce the core password policy (non-empty and long enough). */
function assertPassword(pw: unknown, label = "Password"): void {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
}

/**
 * Resolve the effective password: if keyfiles are provided, mix them into
 * the password. If the header says keyfileRequired but none are provided,
 * throws an error.
 */
function effectivePassword(
  password: string,
  keyfiles?: string[],
  header?: { keyfileRequired?: boolean },
): string {
  if (header?.keyfileRequired && (!keyfiles || keyfiles.length === 0)) {
    throw new Error(
      "This vault requires a keyfile. Provide the keyfile that was used to " +
        "create it (CLI: --keyfile <path>).",
    );
  }
  if (keyfiles && keyfiles.length > 0) {
    const kfHash = processKeyfiles(keyfiles);
    return mixKeyfileIntoPassword(password, kfHash);
  }
  return password;
}

/**
 * Zero a sensitive Buffer to minimise the window during which key material
 * is recoverable from heap dumps. Called in every finally block after use.
 */
function wipeBuf(buf: Buffer): void {
  try {
    buf.fill(0);
  } catch {
    /* best-effort */
  }
}

/**
 * Refuse to rewrite a container that carries data past its own payload.
 *
 * A hidden-volume file appends random padding plus a second encrypted volume
 * after the outer payload (see hidden.ts). Every write path here rebuilds the
 * file as `[header][payload]` from what `readContainer` returned, so without
 * this guard a `close` — or a password change, a recovery, a metadata edit —
 * would silently drop that tail: the hidden volume would become unrecoverable
 * and a fixed-size decoy would shrink to a few hundred bytes, which is itself a
 * giveaway that a hidden volume existed.
 *
 * The hidden volume is only reachable through `hidden.ts`, which composes the
 * whole file itself, so refusing here loses nothing and prevents the
 * irreversible case.
 */
function assertNoTrailingData(header: VaultHeader, abs: string): void {
  if (header.payloadLen === undefined) return;
  // `abs` is the user's own file, not an internal detail, so naming it helps.
  // The source path is not: it is an implementation detail that means nothing
  // to a user and would change whenever the module moves.
  throw new Error(
    "This file carries a hidden volume, which this operation cannot rewrite " +
      "without destroying it. The vault file was not modified. Manage hidden " +
      `volumes through the hidden-volume API, not the ordinary vault ` +
      `commands: ${abs}`,
  );
}

/** SHA-256 hex of a raw header buffer — used for TOCTOU protection. */
function headerHash(rawBytes: Buffer): string {
  return crypto.createHash("sha256").update(rawBytes).digest("hex");
}

/** Wrap (encrypt) a MEK under a password, producing header fields. */
function buildHeader(
  mek: Buffer,
  password: string,
  payloadIv: string,
  payloadTag: string,
  recovery?: { key: string },
  createdAt?: string,
): VaultHeader {
  const salt = generateSalt();
  const passKey = deriveKeyFromPassword(password, salt);
  const encryptedMek = encryptGCM(passKey, mek);
  wipeBuf(passKey);

  const header: VaultHeader = {
    magic: HEADER_MAGIC,
    version: CURRENT_VERSION,
    kdf: "scrypt",
    kdfParams: DEFAULT_KDF_PARAMS,
    salt: salt.toString("hex"),
    encryptedMek,
    payloadIv,
    payloadTag,
    compressed: true,
    createdAt: createdAt || new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };

  if (recovery) {
    const recSalt = generateSalt();
    const recKey = deriveRecoveryKey(recovery.key, recSalt);
    header.recovery = {
      encryptedMek: encryptGCM(recKey, mek),
      keyHash: hashRecoveryKey(recovery.key),
      salt: recSalt.toString("hex"),
    };
    wipeBuf(recKey);
  }

  // Compute and attach the header MAC (v3+).
  const hak = deriveHak(mek);
  const canonical = JSON.stringify(header); // headerMac not yet set
  header.headerMac = computeHeaderMac(hak, canonical);
  wipeBuf(hak);

  return header;
}

/**
 * Verify the header MAC if present (v3+ vaults). Throws on mismatch.
 * v1/v2 vaults without a headerMac silently pass (backward compat).
 */
function verifyHeaderMac(header: VaultHeader, mek: Buffer): void {
  if (!header.headerMac) return; // v1/v2 vault — no MAC to check
  const hak = deriveHak(mek);
  const { headerMac, ...rest } = header;
  const expected = computeHeaderMac(hak, JSON.stringify(rest));
  wipeBuf(hak);
  const a = Buffer.from(headerMac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new WrongCredentialError(
      "Header integrity check failed — the vault may have been tampered with.",
    );
  }
}

/**
 * (Re)compute and attach the headerMac to a header object.
 * Called in every write path so close/change-password/recover always produce
 * a v3 header with a valid MAC.
 */
function attachHeaderMac(header: VaultHeader, mek: Buffer): void {
  delete header.headerMac; // remove stale MAC before computing
  const hak = deriveHak(mek);
  header.headerMac = computeHeaderMac(hak, JSON.stringify(header));
  wipeBuf(hak);
}

/** Recover the MEK from a header using a password. */
function unwrapMekWithPassword(header: VaultHeader, password: string): Buffer {
  const passKey = deriveKeyFromPassword(
    password,
    Buffer.from(header.salt, "hex"),
    header.kdfParams,
  );
  try {
    const mek = decryptGCM(passKey, header.encryptedMek);
    wipeBuf(passKey);
    return mek;
  } catch {
    wipeBuf(passKey);
    throw new WrongCredentialError();
  }
}

/** Recover the MEK from a header using a recovery key. */
function unwrapMekWithRecovery(
  header: VaultHeader,
  recoveryKey: string,
): Buffer {
  if (!header.recovery) {
    throw new Error("This vault has no recovery key configured.");
  }
  // The keyHash is a friendly pre-check so a typo gets "Incorrect recovery key"
  // instead of a scrypt derivation plus a GCM failure. It is NOT the security
  // gate — the escrow's GCM tag is — but it is compared in constant time all
  // the same, because the header is public: an attacker reading the file learns
  // nothing either way, but a user pasting a key they *partly* remember should
  // not get a timing signal on the prefix. (An earlier version compared the
  // hex strings with `!==` first and only then did a timing-safe compare, which
  // made the timing-safe pass unreachable on every mismatch.)
  const expectedHash = Buffer.from(header.recovery.keyHash, "hex");
  const actualHash = Buffer.from(hashRecoveryKey(recoveryKey), "hex");
  if (
    expectedHash.length !== actualHash.length ||
    !crypto.timingSafeEqual(expectedHash, actualHash)
  ) {
    throw new WrongCredentialError("Incorrect recovery key.");
  }
  const recKey = header.recovery.salt
    ? deriveRecoveryKey(recoveryKey, Buffer.from(header.recovery.salt, "hex"))
    : deriveKeyFromRecovery(recoveryKey); // legacy v1 vaults (no salt)
  try {
    const mek = decryptGCM(recKey, header.recovery.encryptedMek);
    wipeBuf(recKey);
    return mek;
  } catch {
    wipeBuf(recKey);
    throw new WrongCredentialError("Incorrect recovery key.");
  }
}

/** An in-memory empty bundle (manifest with zero entries). */
const EMPTY_BUNDLE = emptyBundle();

/** Update header.modifiedAt, respecting paranoid mode (epoch timestamps). */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
function touchModified(header: VaultHeader): void {
  header.modifiedAt =
    header.createdAt === EPOCH_ISO ? EPOCH_ISO : new Date().toISOString();
}

/** Create a new (optionally seeded) encrypted vault file. */
export function createVault(
  vaultPath: string,
  opts: CreateOptions,
): CreateResult {
  const abs = path.resolve(vaultPath);
  if (fs.existsSync(abs)) {
    throw new Error(`Refusing to overwrite existing file: ${abs}`);
  }
  assertPassword(opts.password);

  const pw = effectivePassword(opts.password, opts.keyfiles);
  const mek = generateMek();
  const recoveryKey = opts.generateRecovery ? generateRecoveryKey() : undefined;

  try {
    // Build the initial payload (empty, or seeded from a directory), then compress.
    const raw = opts.seedDir ? packDir(opts.seedDir) : EMPTY_BUNDLE;
    const plaintext = compressBundle(raw);

    const chosenCipher = assertCipher(opts.cipher || DEFAULT_CIPHER);
    const { iv, tag, ciphertext } = encryptPayload(
      mek,
      plaintext,
      chosenCipher,
    );
    const header = buildHeader(
      mek,
      pw,
      iv,
      tag,
      recoveryKey ? { key: recoveryKey } : undefined,
    );

    // Record the cipher only when it is not the default, so the common case
    // does not spend header bytes restating what the reader already assumes.
    if (chosenCipher !== DEFAULT_CIPHER) {
      header.cipher = chosenCipher;
    }

    // Mark the vault as requiring keyfile(s) if any were provided.
    if (opts.keyfiles && opts.keyfiles.length > 0) {
      header.keyfileRequired = true;
    }

    // Paranoid mode: strip timestamps and metadata.
    if (opts.paranoid) {
      const epoch = "1970-01-01T00:00:00.000Z";
      header.createdAt = epoch;
      header.modifiedAt = epoch;
      delete header.meta;
    } else if (opts.meta) {
      header.meta = { ...opts.meta };
      if (!header.meta.name) delete header.meta.name;
      if (!header.meta.description) delete header.meta.description;
      if (!header.meta.name && !header.meta.description) delete header.meta;
    }

    // Recompute the header MAC after all fields are finalized.
    attachHeaderMac(header, mek);

    writeContainer(abs, header, ciphertext);
    return { vaultPath: abs, recoveryKey };
  } finally {
    wipeBuf(mek);
  }
}

export interface OpenResult {
  vaultPath: string;
  workingDir: string;
}

/**
 * Open a vault: verify password, decrypt the payload, and extract it to a
 * temp working directory. Returns the working dir path.
 *
 * The password is ALWAYS verified — even when a session already exists —
 * so a wrong password can never hand back a decrypted working directory.
 */
export function openVault(
  vaultPath: string,
  password: string,
  keyfiles?: string[],
): OpenResult {
  const abs = path.resolve(vaultPath);
  // NOTE: deliberately NOT guarded by assertNoTrailingData. Opening the outer
  // volume of a hidden container is the entire point of the decoy — the
  // password you hand over under compulsion must open a real, working vault.
  // readContainer slices the outer payload using header.payloadLen, so the
  // padding and hidden tail after it are ignored rather than breaking GCM.
  const { header, payload } = readContainer(abs);
  const pw = effectivePassword(password, keyfiles, header);
  const mek = unwrapMekWithPassword(header, pw);

  // v3+: verify the header has not been tampered with (KDF downgrade, etc.).
  verifyHeaderMac(header, mek);

  try {
    const existing = findSession(abs);
    if (existing && fs.existsSync(existing.workingDir)) {
      // Session reuse: password already verified above, no need to re-decrypt.
      return { vaultPath: abs, workingDir: existing.workingDir };
    }

    // Resolve the cipher OUTSIDE the try below. `header.cipher` is
    // attacker-controlled, and an unrecognised name is a corrupt/unsupported
    // container — not a wrong password. Validating it here keeps that
    // distinction instead of letting the catch-all report "Incorrect password".
    const cipher = assertCipher(header.cipher || DEFAULT_CIPHER);

    let compressed: Buffer;
    try {
      compressed = decryptPayload(
        mek,
        header.payloadIv,
        header.payloadTag,
        payload,
        cipher,
      );
    } catch {
      // Conflate wrong-key and tampered payload (no oracle).
      throw new WrongCredentialError();
    }

    // Decompress if the vault was created with compression enabled.
    let plaintext: Buffer;
    try {
      plaintext = header.compressed ? decompressBundle(compressed) : compressed;
    } catch (e: any) {
      // An over-large expansion is a distinct, actionable condition from
      // corruption: the vault is fine, it just decompresses to more than this
      // build will hold in memory. Say so instead of calling it corrupt.
      if (
        e &&
        (e.code === "ERR_BUFFER_TOO_LARGE" ||
          /maxOutputLength/i.test(e.message ?? ""))
      ) {
        throw new Error(
          "This vault expands to more than " +
            `${MAX_PAYLOAD_SIZE / (1024 * 1024 * 1024)} GiB of data, which ` +
            "ShadowBit cannot hold in memory. It was not modified.",
        );
      }
      throw new Error("Vault payload is corrupt (decompression failed).");
    }

    const workingDir = makeWorkingDir(abs);
    unpackDir(plaintext, workingDir);

    // Scrub timestamps on the working directory so unpacked files don't leak
    // the original modification times of the decrypted content.
    scrubTimestampsRecursive(workingDir);

    // Read raw header bytes for TOCTOU protection at close time.
    const { rawBytes } = readHeaderRaw(abs);
    const hash = headerHash(rawBytes);

    addSession({
      vaultPath: abs,
      workingDir,
      openedAt: new Date().toISOString(),
      headerHash: hash,
      keyfiles: keyfiles && keyfiles.length > 0 ? keyfiles : undefined,
    });
    return { vaultPath: abs, workingDir };
  } finally {
    wipeBuf(mek);
  }
}

/**
 * Close an open vault: re-pack the working dir, re-encrypt with the MEK
 * (re-derived from the password), write the container, and remove the temp
 * working directory.
 */
export function closeVault(
  vaultPath: string,
  password: string,
  keyfiles?: string[],
): void {
  const abs = path.resolve(vaultPath);
  const session = findSession(abs);
  if (!session || !fs.existsSync(session.workingDir)) {
    throw new Error("Vault is not open.");
  }

  // Fall back to keyfiles stored in the session (from open time).
  const effectiveKeyfiles = keyfiles || session.keyfiles;

  // TOCTOU guard: verify the header on disk matches what we saw at open time.
  const { header, rawBytes } = readHeaderRaw(abs);
  assertNoTrailingData(header, abs);
  if (session.headerHash) {
    const currentHash = headerHash(rawBytes);
    if (currentHash !== session.headerHash) {
      throw new Error(
        "The vault file has been modified since it was opened. " +
          "Re-open the vault to pick up the current version before closing.",
      );
    }
  }

  const mek = unwrapMekWithPassword(
    header,
    effectivePassword(password, effectiveKeyfiles, header),
  );
  try {
    const raw = packDir(session.workingDir);
    const plaintext = compressBundle(raw);
    const { iv, tag, ciphertext } = encryptPayload(
      mek,
      plaintext,
      assertCipher(header.cipher || DEFAULT_CIPHER),
    );

    header.payloadIv = iv;
    header.payloadTag = tag;
    header.compressed = true;
    touchModified(header);
    // maybeBumpVersion, not an unconditional CURRENT_VERSION: closeVault writes
    // the header back verbatim and does NOT touch the recovery escrow, so
    // stamping v3 here would claim a salted (v2) escrow that a still-legacy
    // v1 header does not have. See maybeBumpVersion for why that matters.
    maybeBumpVersion(header);
    attachHeaderMac(header, mek);

    writeContainer(abs, header, ciphertext);
  } finally {
    wipeBuf(mek);
  }

  secureEraseDir(session.workingDir);
  removeSession(abs);
}

/**
 * Discard changes and just remove the working dir without re-encrypting.
 * Requires the vault password: erasing the decrypted plaintext is destructive,
 * so it must be authenticated. If the vault file itself is gone there is
 * nothing left to authenticate against, so we still clean up the stale session
 * and its plaintext working dir (F1).
 */
export function discardVault(
  vaultPath: string,
  password: string,
  keyfiles?: string[],
): void {
  const abs = path.resolve(vaultPath);
  const session = findSession(abs);
  // Fall back to keyfiles stored in the session (from open time).
  const effectiveKeyfiles = keyfiles || session?.keyfiles;
  if (fs.existsSync(abs)) {
    const header = readHeader(abs);
    const mek = unwrapMekWithPassword(
      header,
      effectivePassword(password, effectiveKeyfiles, header),
    ); // throws on wrong pw
    wipeBuf(mek);
  }

  if (session && fs.existsSync(session.workingDir)) {
    // Securely erase the decrypted plaintext left in the temp folder.
    secureEraseDir(session.workingDir);
  }
  removeSession(abs);
}

/**
 * Copy files/folders into an open vault's working directory (used by the GUI
 * drag-and-drop and the CLI `add` command). Returns counts of items added and
 * nested symlinks that were silently skipped.
 */
export function addToSession(vaultPath: string, srcPaths: string[]): AddResult {
  const abs = path.resolve(vaultPath);
  const session = findSession(abs);
  if (!session || !fs.existsSync(session.workingDir)) {
    throw new Error("Vault is not open.");
  }
  let count = 0;
  let symlinksSkipped = 0;
  for (const src of srcPaths) {
    if (!fs.existsSync(src)) continue;
    const { skipped } = copyInto(src, session.workingDir);
    count++;
    symlinksSkipped += skipped;
  }
  return { count, symlinksSkipped };
}

/**
 * Permanently delete a vault file. Requires the current password to
 * authenticate the operation (consistent with discardVault). If `shred` is
 * true, the file bytes are overwritten with random data before removal
 * (best-effort; see fsutil). Any open working directory for the vault is
 * securely erased too.
 */
export function deleteVault(
  vaultPath: string,
  password: string,
  opts: { shred?: boolean; passes?: number; keyfiles?: string[] } = {},
): void {
  const abs = path.resolve(vaultPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Vault not found: ${abs}`);
  }
  // Validate the pass count. `secureEraseFile`'s overwrite loop is
  // `for (p = 0; p < passes; p++)`, so a 0 or negative value skips the
  // overwrite entirely and unlinks the file — while the caller has every
  // reason to believe `shred` overwrote it first. Reject rather than silently
  // downgrade to a plain delete.
  const passes = opts.passes ?? 3;
  if (!Number.isInteger(passes) || passes < 1) {
    throw new Error("Overwrite passes must be a positive whole number.");
  }
  // Sanity check: make sure it is actually a vault.
  const header = readHeader(abs);
  // Require password authentication before deleting.
  const mek = unwrapMekWithPassword(
    header,
    effectivePassword(password, opts.keyfiles, header),
  );
  wipeBuf(mek);

  const session = findSession(abs);
  if (session && fs.existsSync(session.workingDir)) {
    // One pass on the working directory even under --shred: it holds the
    // decrypted copy, which is about to become unreachable anyway, and it can
    // be orders of magnitude larger than the container. The vault file itself
    // is what shred is for.
    secureEraseDir(session.workingDir, 1);
  }
  removeSession(abs);

  if (opts.shred) {
    secureEraseFile(abs, passes);
  } else {
    fs.rmSync(abs, { force: true });
  }
}

/**
 * Bump the header to the current container format. Deliberately conservative:
 * a legacy v1 recovery escrow (saltless, SHA-256-derived) cannot be re-salted
 * without the recovery key itself, so we only claim the current version once
 * nothing v1-style remains (or there is no recovery escrow at all). This keeps
 * the declared version honest without touching the payload (F2).
 *
 * Use this on any write path that rewrites the header WITHOUT replacing the
 * escrow: `closeVault`, `changePassword`, `recoverVault`, `removeRecoveryKey`,
 * `setMeta`. The two that DO write a fresh salted escrow — regenerateRecoveryKey
 * and upgradeRecoveryEscrow — may assign CURRENT_VERSION directly, because by
 * then no v1-style escrow can survive in the header.
 */
function maybeBumpVersion(header: VaultHeader): void {
  if (!header.recovery || header.recovery.salt) {
    header.version = CURRENT_VERSION;
  }
}

/**
 * After any operation that re-writes the vault header while a session is open,
 * refresh the stored headerHash so the next closeVault does not falsely fail
 * the TOCTOU check.
 */
function refreshSessionHash(abs: string): void {
  try {
    const { rawBytes } = readHeaderRaw(abs);
    updateSession(abs, { headerHash: headerHash(rawBytes) });
  } catch {
    /* best-effort — a missing/unreadable file here is not fatal */
  }
}

/** Change a vault's password. Only the MEK is re-wrapped; payload untouched. */
export function changePassword(
  vaultPath: string,
  oldPassword: string,
  newPassword: string,
  opts: { keyfiles?: string[]; newKeyfiles?: string[] } = {},
): void {
  const abs = path.resolve(vaultPath);
  const { header, payload } = readContainer(abs);
  assertNoTrailingData(header, abs);
  const mek = unwrapMekWithPassword(
    header,
    effectivePassword(oldPassword, opts.keyfiles, header),
  );
  try {
    assertPassword(newPassword, "New password");

    // Default to KEEPING the current keyfile set. Re-wrapping under a bare
    // password while leaving `keyfileRequired` set would produce a header that
    // demands a keyfile the new wrap never used: opening without one is
    // refused, and opening with one derives the wrong password. That bricks
    // the vault. Callers must opt in to dropping the requirement by passing an
    // explicitly empty array.
    const newKeyfiles =
      opts.newKeyfiles !== undefined ? opts.newKeyfiles : opts.keyfiles;
    const newPw = effectivePassword(newPassword, newKeyfiles);

    // Re-wrap MEK with the new password (new salt), preserving recovery escrow.
    const salt = generateSalt();
    const passKey = deriveKeyFromPassword(newPw, salt);
    header.salt = salt.toString("hex");
    header.kdfParams = { ...DEFAULT_KDF_PARAMS };
    header.encryptedMek = encryptGCM(passKey, mek);
    wipeBuf(passKey);
    // Update keyfileRequired flag.
    if (newKeyfiles && newKeyfiles.length > 0) {
      header.keyfileRequired = true;
    } else if (!newKeyfiles) {
      // Not specified — keep existing flag.
    } else {
      delete header.keyfileRequired; // explicitly empty → remove requirement.
    }
    maybeBumpVersion(header);
    touchModified(header);
    attachHeaderMac(header, mek);

    writeContainer(abs, header, payload);
    // Refresh the session hash so closeVault does not fail TOCTOU check.
    refreshSessionHash(abs);
  } finally {
    wipeBuf(mek);
  }
}

/**
 * Recover a vault using its recovery key and set a brand-new password.
 * The MEK is unwrapped via the recovery escrow, then re-wrapped with the
 * new password.
 */
export function recoverVault(
  vaultPath: string,
  recoveryKey: string,
  newPassword: string,
): void {
  const abs = path.resolve(vaultPath);
  const { header, payload } = readContainer(abs);
  assertNoTrailingData(header, abs);
  const mek = unwrapMekWithRecovery(header, normalizeRecoveryKey(recoveryKey));
  try {
    assertPassword(newPassword, "New password");

    const salt = generateSalt();
    const passKey = deriveKeyFromPassword(newPassword, salt);
    header.salt = salt.toString("hex");
    header.kdfParams = { ...DEFAULT_KDF_PARAMS };
    header.encryptedMek = encryptGCM(passKey, mek);
    wipeBuf(passKey);
    maybeBumpVersion(header);
    touchModified(header);
    attachHeaderMac(header, mek);

    writeContainer(abs, header, payload);
    refreshSessionHash(abs);
  } finally {
    wipeBuf(mek);
  }
}

/**
 * Generate a NEW recovery key for a vault (invalidating any previous one).
 * Requires the current password to unwrap the MEK. Returns the new key,
 * which is shown once and never stored in plaintext.
 */
export function regenerateRecoveryKey(
  vaultPath: string,
  password: string,
  keyfiles?: string[],
): string {
  const abs = path.resolve(vaultPath);
  const { header, payload } = readContainer(abs);
  assertNoTrailingData(header, abs);
  const mek = unwrapMekWithPassword(
    header,
    effectivePassword(password, keyfiles, header),
  );
  try {
    const newKey = generateRecoveryKey();
    const recSalt = generateSalt();
    const recKey = deriveRecoveryKey(newKey, recSalt);
    header.recovery = {
      encryptedMek: encryptGCM(recKey, mek),
      keyHash: hashRecoveryKey(newKey),
      salt: recSalt.toString("hex"),
    };
    wipeBuf(recKey);
    // Unconditional, unlike the other write paths: the escrow above was just
    // replaced with a freshly salted one, so no v1-style escrow survives and
    // the current version is honest.
    header.version = CURRENT_VERSION;
    touchModified(header);
    attachHeaderMac(header, mek);

    writeContainer(abs, header, payload);
    refreshSessionHash(abs);
    return newKey;
  } finally {
    wipeBuf(mek);
  }
}

/**
 * Remove the recovery escrow from a vault (password becomes the only way in).
 * Requires the current password.
 */
export function removeRecoveryKey(
  vaultPath: string,
  password: string,
  keyfiles?: string[],
): void {
  const abs = path.resolve(vaultPath);
  const { header, payload } = readContainer(abs);
  assertNoTrailingData(header, abs);
  const mek = unwrapMekWithPassword(
    header,
    effectivePassword(password, keyfiles, header),
  );

  try {
    if (!header.recovery) {
      throw new Error("This vault has no recovery key to remove.");
    }
    delete header.recovery;
    maybeBumpVersion(header);
    touchModified(header);
    attachHeaderMac(header, mek);
    writeContainer(abs, header, payload);
    refreshSessionHash(abs);
  } finally {
    wipeBuf(mek);
  }
}

/**
 * Re-salt a legacy (v1) recovery escrow in place, keeping the SAME recovery
 * key valid but deriving its wrapping key with a per-escrow scrypt salt (v2).
 */
export function upgradeRecoveryEscrow(
  vaultPath: string,
  recoveryKey: string,
): void {
  const abs = path.resolve(vaultPath);
  const { header, payload } = readContainer(abs);
  assertNoTrailingData(header, abs);
  const mek = unwrapMekWithRecovery(header, normalizeRecoveryKey(recoveryKey));
  try {
    if (header.recovery!.salt) {
      throw new Error("Recovery escrow is already up to date (salted, v2).");
    }

    const recSalt = generateSalt();
    const recKey = deriveRecoveryKey(recoveryKey, recSalt);
    header.recovery = {
      encryptedMek: encryptGCM(recKey, mek),
      keyHash: hashRecoveryKey(recoveryKey),
      salt: recSalt.toString("hex"),
    };
    wipeBuf(recKey);
    // Unconditional for the same reason as regenerateRecoveryKey: the escrow
    // was just re-salted, so nothing v1-style remains in the header.
    header.version = CURRENT_VERSION;
    touchModified(header);
    attachHeaderMac(header, mek);

    writeContainer(abs, header, payload);
    refreshSessionHash(abs);
  } finally {
    wipeBuf(mek);
  }
}

/**
 * Resolve a renderer-supplied working directory to an actually-open session.
 *
 * SECURITY: this is the trust boundary for every in-vault file operation. The
 * GUI's file browser used to hand `main.ts` a plain directory string that it
 * then `rmSync`'d recursively — so anything able to run script in the renderer
 * could ask the main process to delete or enumerate any directory the user can
 * reach, and `files:list` could walk the whole filesystem. Requiring the
 * directory to appear in the session registry means only a decrypted vault this
 * build actually opened is addressable, no matter what the caller claims.
 *
 * Returns the resolved absolute path from the registry — never the raw
 * argument — so a caller cannot smuggle a different path past the check.
 */
function resolveOpenWorkingDir(workingDir: string): string {
  if (typeof workingDir !== "string" || workingDir.length === 0) {
    throw new Error("No working directory given.");
  }
  const requested = path.resolve(workingDir);
  const sessions = loadSessions();
  const match = sessions.find((s) => path.resolve(s.workingDir) === requested);
  if (!match) {
    throw new Error("That folder is not an open vault.");
  }
  if (!fs.existsSync(match.workingDir)) {
    throw new Error("That vault's working folder no longer exists.");
  }
  return path.resolve(match.workingDir);
}

/** One entry in the in-app file browser. */
export interface WorkingDirEntry {
  name: string;
  type: "dir" | "file";
  /** POSIX path relative to the working directory. */
  rel: string;
  size?: number;
  modified?: string;
  children?: WorkingDirEntry[];
}

/**
 * Depth cap on the in-app file browser.
 *
 * The walk is recursive and the whole tree is shipped in one IPC message, so an
 * unbounded depth is a stack-overflow risk and an unbounded width is a freeze.
 * A vault that legitimately nests deeper is still fully reachable through the
 * working folder in the OS file manager — this cap only limits the preview.
 */
const MAX_TREE_DEPTH = 12;

/**
 * Hard ceiling on entries returned in one listing.
 *
 * The whole tree crosses the worker -> main -> renderer boundary as one
 * structured-clone message, and the renderer then builds a DOM node per entry,
 * so a vault holding 100k files serialised all of it before the first row
 * appeared. The cap keeps that bounded; the working folder itself is untouched
 * and remains fully reachable from the OS file manager.
 */
const MAX_TREE_ENTRIES = 5000;

/** Enumerate an open vault's working directory for the in-app file browser. */
export function listWorkingDir(workingDir: string): WorkingDirEntry[] {
  const root = resolveOpenWorkingDir(workingDir);
  let budget = MAX_TREE_ENTRIES;
  const walk = (dir: string, rel: string, depth: number): WorkingDirEntry[] => {
    const out: WorkingDirEntry[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out; // unreadable subdirectory: show nothing rather than fail
    }
    for (const name of names) {
      if (budget <= 0) return out; // cap reached — stop walking
      const abs = path.join(dir, name);
      const entryRel = rel ? `${rel}/${name}` : name;
      // lstat, never stat: do not follow a symlink out of the vault, and do not
      // let one masquerade as a directory we would then recurse into.
      //
      // Guarded because the working folder is live: an entry removed between
      // readdir and lstat must not abort the whole listing the user is looking
      // at in the file browser.
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        budget--;
        out.push({
          name,
          type: "dir",
          rel: entryRel,
          children:
            depth < MAX_TREE_DEPTH ? walk(abs, entryRel, depth + 1) : [],
        });
      } else if (stat.isFile()) {
        budget--;
        out.push({
          name,
          type: "file",
          rel: entryRel,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    }
    return out.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
  };
  return walk(root, "", 0);
}

/**
 * Delete a file or folder from an open vault's working directory.
 *
 * `relPath` is resolved against the validated working directory and rejected if
 * it escapes — both the parent path and the final path are checked, so neither
 * `../../etc` nor a sibling directory that happens to share a prefix can be
 * reached.
 */
export function deleteFromWorkingDir(
  workingDir: string,
  relPath: string,
): void {
  const root = resolveOpenWorkingDir(workingDir);
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("No path given.");
  }
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid path: outside the vault's working folder.");
  }
  // lstat first: refuse to recurse through a symlink, which would delete the
  // link's target instead of the entry inside the vault.
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(abs);
    return;
  }
  fs.rmSync(abs, { recursive: true, force: true });
}

/** Rename an entry inside an open vault's working directory (same folder only). */
export function renameInWorkingDir(
  workingDir: string,
  oldRel: string,
  newName: string,
): void {
  const root = resolveOpenWorkingDir(workingDir);
  if (typeof oldRel !== "string" || oldRel.length === 0) {
    throw new Error("No path given.");
  }
  // basename() strips any directory component a caller might have supplied, so a
  // rename can never move an entry to a different folder.
  if (typeof newName !== "string" || newName.trim().length === 0) {
    throw new Error("Enter a new name.");
  }
  const safeName = path.basename(newName);
  if (safeName === "." || safeName === "..") {
    throw new Error("Invalid name.");
  }
  const absOld = path.resolve(root, oldRel);
  const absNew = path.join(path.dirname(absOld), safeName);
  for (const abs of [absOld, absNew]) {
    const rel = path.relative(root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid path: outside the vault's working folder.");
    }
  }
  if (fs.existsSync(absNew)) {
    throw new Error(`A file named "${safeName}" already exists here.`);
  }
  fs.renameSync(absOld, absNew);
}

/**
 * Lock every open vault: securely erase its working directory and drop its
 * session. Returns how many were locked.
 *
 * This lives in the core (and therefore on the worker thread) because erasing a
 * working directory means overwriting every decrypted byte on disk. Done on the
 * main thread — which is what the auto-lock timer and File > Lock All Vaults
 * used to do — it blocks the event loop for the length of the wipe, freezing the
 * UI on a large vault. The main thread no longer touches vault I/O at all; it
 * only reads the session list for the quit guard, which is allowed.
 */
export function lockAllOpenVaults(): number {
  const sessions = loadSessions();
  let locked = 0;
  for (const s of sessions) {
    try {
      if (fs.existsSync(s.workingDir)) secureEraseDir(s.workingDir);
    } catch {
      /* best-effort: a failed erase must not strand the session entry */
    }
    removeSession(s.vaultPath);
    locked++;
  }
  return locked;
}

/** Read summary info about a vault without decrypting its payload. */
export function getInfo(vaultPath: string): VaultInfo {
  const abs = path.resolve(vaultPath);
  const header = readHeader(abs);
  const session = findSession(abs);
  const isOpen = !!(session && fs.existsSync(session.workingDir));
  return {
    vaultPath: abs,
    version: header.version,
    hasRecoveryKey: !!header.recovery,
    createdAt: header.createdAt,
    modifiedAt: header.modifiedAt,
    fileSize: fs.statSync(abs).size,
    isOpen,
    workingDir: isOpen ? session!.workingDir : undefined,
    compressed: header.compressed ?? false,
    cipher: header.cipher ?? DEFAULT_CIPHER,
    keyfileRequired: !!header.keyfileRequired,
    meta: header.meta,
  };
}

/** Outcome of a `setMeta` call. */
export interface SetMetaResult {
  vaultPath: string;
  /**
   * True when the vault was created in `--paranoid` mode, so the metadata just
   * written is plaintext in a header that otherwise carries nothing optional.
   *
   * Frontends must surface this as a warning rather than treating a successful
   * `setMeta` as an unqualified success. The write is allowed — metadata is
   * legitimate content, and refusing it made a one-way door out of a mode the
   * user may have chosen years earlier and now wants a description on.
   */
  paranoid: boolean;
}

/**
 * True when a header was written by paranoid mode.
 *
 * Paranoid mode is identified by its epoch `createdAt` rather than a dedicated
 * flag, because that is what `create --paranoid` sets and what `touchModified`
 * preserves across writes. That also means it is the honest test: a vault whose
 * timestamps are epoch is one whose header is meant to carry no timestamps, and
 * so none of the other plaintext fields either.
 */
export function isParanoidHeader(header: VaultHeader): boolean {
  return header.createdAt === EPOCH_ISO;
}

/**
 * Set plaintext metadata (name / description) on a vault. Requires the
 * current password to authenticate. The payload is NOT re-encrypted.
 */
export function setMeta(
  vaultPath: string,
  password: string,
  meta: { name?: string; description?: string },
  keyfiles?: string[],
): SetMetaResult {
  const abs = path.resolve(vaultPath);
  const { header, payload } = readContainer(abs);
  assertNoTrailingData(header, abs);
  const mek = unwrapMekWithPassword(
    header,
    effectivePassword(password, keyfiles, header),
  );

  try {
    header.meta = { ...header.meta, ...meta };
    // Remove keys explicitly set to undefined / empty string
    if (!header.meta.name) delete header.meta.name;
    if (!header.meta.description) delete header.meta.description;
    if (!header.meta.name && !header.meta.description) delete header.meta;

    touchModified(header);
    attachHeaderMac(header, mek);
    writeContainer(abs, header, payload);
    refreshSessionHash(abs);
    // The write is allowed even on a paranoid vault — refusing outright was the
    // wrong call, because metadata is a legitimate thing to want to add later
    // and the user knows what their vault is. But the caller must be told, since
    // the whole point of `--paranoid` was a header with nothing optional in it
    // and `meta` is plaintext: anyone with the file reads it.
    return { vaultPath: abs, paranoid: isParanoidHeader(header) };
  } finally {
    wipeBuf(mek);
  }
}
