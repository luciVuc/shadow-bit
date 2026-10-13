// Hidden volume support for plausible deniability.
//
// Architecture:
// A vault with a hidden volume has TWO encrypted payloads in a fixed-size
// container. The outer (decoy) password decrypts the outer payload; the
// hidden password decrypts the inner (real) payload. An attacker who compels
// disclosure receives the decoy password and sees only the outer files.
//
// Container layout (hidden-enabled):
//   [MAGIC 8B] [HEADER_LEN 4B] [OUTER_HEADER JSON] [OUTER_PAYLOAD]
//   [RANDOM_PADDING ...]
//   [HIDDEN_PAYLOAD (N bytes)]
//   [ENCRYPTED_HIDDEN_BLOCK]:
//     [HIDDEN_HEADER_MAGIC 6B] [SALT 16B] [IV 12B] [TAG 16B] [GCM-encrypted blob]
//         where the blob = JSON { header: VaultHeader, payloadLen: number }
//
// The total file size is FIXED at creation. The random padding is
// cryptographically indistinguishable from encrypted data, so an attacker
// cannot determine whether a hidden volume exists.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  DEFAULT_CIPHER,
  DEFAULT_KDF_PARAMS,
  decryptGCM,
  decryptPayload,
  deriveKeyFromPassword,
  assertCipher,
  encryptGCM,
  encryptPayload,
  generateMek,
  generateSalt,
  deriveHak,
  computeHeaderMac,
  CipherAlgorithm,
} from "./crypto";
import { compressBundle, emptyBundle, packDir } from "./bundle";
import {
  HEADER_MAGIC,
  CURRENT_VERSION,
  MAX_CONTAINER_SIZE,
  writeContainer,
  readContainer,
} from "./container";
import { VaultHeader } from "./types";
import { MIN_PASSWORD_LENGTH } from "./vault";

/** Minimum total container size for a hidden volume (8 MiB). */
export const MIN_HIDDEN_CONTAINER_SIZE = 8 * 1024 * 1024;

/** Magic marker for encrypted hidden header blocks. */
const HIDDEN_HEADER_MAGIC = Buffer.from("SBHID\x00", "latin1"); // 6 bytes

/**
 * How many candidate SBHID blocks to try before giving up.
 *
 * Each attempt runs a full scrypt derivation (~134 MB, hundreds of ms), so an
 * unbounded search over a hostile file is a denial-of-service vector: a crafted
 * container with the 6-byte magic repeated throughout would make one open take
 * hours. A container written by createHiddenVault has exactly one such block, at
 * the very end, so a small cap costs nothing legitimate.
 */
const MAX_HIDDEN_BLOCK_ATTEMPTS = 8;

/** The encrypted hidden block stores a JSON object of this shape. */
interface HiddenBlob {
  header: VaultHeader;
  /** Length in bytes of the hidden ciphertext payload (immediately before this block). */
  payloadLen: number;
}

function wipeBuf(buf: Buffer): void {
  buf.fill(0);
}

/**
 * Build a header for a sub-volume (outer or hidden).
 */
function buildSubHeader(
  mek: Buffer,
  password: string,
  payloadIv: string,
  payloadTag: string,
  cipher: CipherAlgorithm = DEFAULT_CIPHER,
): VaultHeader {
  const salt = generateSalt();
  const passKey = deriveKeyFromPassword(password, salt);
  const encryptedMek = encryptGCM(passKey, mek);
  wipeBuf(passKey);

  const header: VaultHeader = {
    magic: HEADER_MAGIC,
    version: CURRENT_VERSION,
    kdf: "scrypt",
    kdfParams: { ...DEFAULT_KDF_PARAMS },
    salt: salt.toString("hex"),
    encryptedMek,
    payloadIv,
    payloadTag,
    compressed: true,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };

  if (cipher !== DEFAULT_CIPHER) {
    header.cipher = cipher;
  }

  // Attach header MAC.
  const hak = deriveHak(mek);
  const canonical = JSON.stringify(header);
  header.headerMac = computeHeaderMac(hak, canonical);
  wipeBuf(hak);

  return header;
}

/**
 * (Re)compute a sub-volume's headerMac after a field was added or changed.
 * Mirrors `attachHeaderMac` in vault.ts: the MAC must be taken over the header
 * *without* headerMac, with `headerMac` removed first so a stale value cannot
 * leak into the canonical JSON.
 */
function attachSubHeaderMac(header: VaultHeader, mek: Buffer): void {
  delete header.headerMac;
  const hak = deriveHak(mek);
  header.headerMac = computeHeaderMac(hak, JSON.stringify(header));
  wipeBuf(hak);
}

/**
 * Encrypt a hidden blob: magic + salt + iv + tag + GCM(JSON({header, payloadLen}))
 */
function encryptHiddenBlob(blob: HiddenBlob, hiddenPassword: string): Buffer {
  const salt = generateSalt();
  const key = deriveKeyFromPassword(hiddenPassword, salt);
  const json = Buffer.from(JSON.stringify(blob), "utf8");
  const iv = crypto.randomBytes(12);
  // Always aes-256-gcm, and deliberately not `cipherAlg`: this block is the
  // sealed pointer to the hidden volume, not its payload. Pinning it means the
  // outer container's cipher can be changed (or a future format added) without
  // changing how the tail is located — an opener only has to know this one
  // algorithm to find where the hidden payload starts.
  const cipher = crypto.createCipheriv(
    DEFAULT_CIPHER as any,
    key,
    iv,
  ) as crypto.CipherGCM;
  const data = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  wipeBuf(key);
  // Layout: [MAGIC 6B][SALT 16B][IV 12B][TAG 16B][DATA variable]
  return Buffer.concat([HIDDEN_HEADER_MAGIC, salt, iv, tag, data]);
}

/**
 * Try to decrypt a hidden blob from a buffer at a given offset.
 */
function tryDecryptHiddenBlob(
  buf: Buffer,
  offset: number,
  password: string,
): HiddenBlob | null {
  const minLen = HIDDEN_HEADER_MAGIC.length + 16 + 12 + 16 + 1; // magic+salt+iv+tag+>=1 byte data
  if (offset + minLen > buf.length) return null;

  // Check magic.
  if (
    !buf
      .subarray(offset, offset + HIDDEN_HEADER_MAGIC.length)
      .equals(HIDDEN_HEADER_MAGIC)
  ) {
    return null;
  }

  let pos = offset + HIDDEN_HEADER_MAGIC.length;
  const salt = buf.subarray(pos, pos + 16);
  pos += 16;
  const iv = buf.subarray(pos, pos + 12);
  pos += 12;
  const tag = buf.subarray(pos, pos + 16);
  pos += 16;
  const data = buf.subarray(pos);

  const key = deriveKeyFromPassword(password, Buffer.from(salt));
  try {
    const decipher = crypto.createDecipheriv(
      DEFAULT_CIPHER as any,
      key,
      iv,
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    wipeBuf(key);
    return JSON.parse(decrypted.toString("utf8")) as HiddenBlob;
  } catch {
    wipeBuf(key);
    return null;
  }
}

export interface HiddenVolumeOptions {
  vaultPath: string;
  outerPassword: string;
  hiddenPassword: string;
  /** Total fixed container size in bytes (>= 8 MiB). */
  totalSize: number;
  outerSeedDir?: string;
  hiddenSeedDir?: string;
  cipher?: CipherAlgorithm;
}

/**
 * Create a vault with a hidden volume inside a fixed-size container.
 */
export function createHiddenVault(opts: HiddenVolumeOptions): void {
  const abs = path.resolve(opts.vaultPath);
  if (fs.existsSync(abs)) {
    throw new Error(`Refusing to overwrite existing file: ${abs}`);
  }
  if (opts.totalSize < MIN_HIDDEN_CONTAINER_SIZE) {
    throw new Error(
      `Total container size must be at least ${MIN_HIDDEN_CONTAINER_SIZE / (1024 * 1024)} MiB.`,
    );
  }
  // Cap at what an ordinary vault may occupy. The fixed size is the whole point
  // of a hidden volume, so an unconstrained one could be made arbitrarily large;
  // MAX_CONTAINER_SIZE is the same ceiling readContainer enforces, and exceeding
  // it here would produce a file that openVault then refuses to open at all.
  if (opts.totalSize > MAX_CONTAINER_SIZE) {
    throw new Error(
      `Total container size must be at most ` +
        `${MAX_CONTAINER_SIZE / (1024 * 1024 * 1024)} GiB.`,
    );
  }
  // The same MIN_PASSWORD_LENGTH the rest of the core enforces — importing it
  // rather than repeating "8" is what keeps a future policy change from
  // silently applying to every command except hidden volumes.
  if (opts.outerPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Outer password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (opts.hiddenPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Hidden password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (opts.outerPassword === opts.hiddenPassword) {
    throw new Error("Outer and hidden passwords must be different.");
  }

  // Validated for the same reason vault.ts createVault validates: an unknown
  // name must fail loudly rather than reach createCipheriv.
  const cipherAlg = assertCipher(opts.cipher || DEFAULT_CIPHER);

  // --- Outer volume ---
  const outerMek = generateMek();
  const outerRaw = opts.outerSeedDir
    ? packDir(opts.outerSeedDir)
    : emptyBundle();
  const outerPlaintext = compressBundle(outerRaw);
  const outerEnc = encryptPayload(outerMek, outerPlaintext, cipherAlg);
  const outerHeader = buildSubHeader(
    outerMek,
    opts.outerPassword,
    outerEnc.iv,
    outerEnc.tag,
    cipherAlg,
  );

  // --- Hidden volume ---
  const hiddenMek = generateMek();
  const hiddenRaw = opts.hiddenSeedDir
    ? packDir(opts.hiddenSeedDir)
    : emptyBundle();
  const hiddenPlaintext = compressBundle(hiddenRaw);
  const hiddenEnc = encryptPayload(hiddenMek, hiddenPlaintext, cipherAlg);
  const hiddenHeader = buildSubHeader(
    hiddenMek,
    opts.hiddenPassword,
    hiddenEnc.iv,
    hiddenEnc.tag,
    cipherAlg,
  );

  const hiddenBlob: HiddenBlob = {
    header: hiddenHeader,
    payloadLen: hiddenEnc.ciphertext.length,
  };
  const encryptedHiddenBlock = encryptHiddenBlob(
    hiddenBlob,
    opts.hiddenPassword,
  );
  wipeBuf(hiddenMek);

  // --- Compose the fixed-size container ---
  try {
    // Step 1: Write the outer container normally.
    //
    // `payloadLen` is what makes the outer volume readable at all. Everything
    // after the outer ciphertext (random padding, the hidden payload, the sealed
    // hidden header) is appended below, so a reader that treated "the rest of
    // the file" as the payload would hand GCM a ciphertext with a tail bolted
    // on and fail authentication — meaning the decoy password would open
    // nothing. That defeats the whole point of a hidden volume and is worse
    // than having none, because it reads as corruption. Declaring the length
    // keeps the normal openVault()/getInfo() path working on the outer volume
    // while the file stays fixed-size on disk.
    outerHeader.payloadLen = outerEnc.ciphertext.length;
    attachSubHeaderMac(outerHeader, outerMek);
    writeContainer(abs, outerHeader, outerEnc.ciphertext);
    const outerFileSize = fs.statSync(abs).size;

    // Step 2: Calculate padding between outer and hidden.
    const hiddenTailSize =
      hiddenEnc.ciphertext.length + encryptedHiddenBlock.length;
    const paddingNeeded = opts.totalSize - outerFileSize - hiddenTailSize;

    if (paddingNeeded < 0) {
      fs.rmSync(abs, { force: true });
      throw new Error(
        `Total container size (${opts.totalSize} bytes) too small. ` +
          `Need at least ${outerFileSize + hiddenTailSize} bytes.`,
      );
    }

    // Step 3: Append padding + hidden payload + encrypted hidden block.
    const fd = fs.openSync(abs, "a");
    try {
      const CHUNK = 1024 * 1024;
      let remaining = paddingNeeded;
      while (remaining > 0) {
        const len = Math.min(CHUNK, remaining);
        fs.writeSync(fd, crypto.randomBytes(len));
        remaining -= len;
      }
      fs.writeSync(fd, hiddenEnc.ciphertext);
      fs.writeSync(fd, encryptedHiddenBlock);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    wipeBuf(outerMek);
  }
}

/**
 * Open a hidden volume. Scans the tail of the file for the encrypted
 * hidden header block and decrypts the hidden payload.
 *
 * Returns { header, payload } just like readContainer.
 * Throws if no hidden volume found with this password.
 */
export function openHiddenVolume(
  vaultPath: string,
  hiddenPassword: string,
): { header: VaultHeader; payload: Buffer } {
  const abs = path.resolve(vaultPath);
  const fileBuf = fs.readFileSync(abs);
  let attempts = 0;

  // Find candidate SBHID blocks newest-first — the real one is at the very end of
  // the file. `lastIndexOf` is a native memmem; the obvious alternative, a
  // per-offset `subarray().equals()` loop, allocates a Buffer per byte and
  // turns opening a multi-gigabyte fixed-size container into a multi-minute
  // operation.
  for (
    let offset = fileBuf.lastIndexOf(HIDDEN_HEADER_MAGIC);
    offset >= 0;
    offset = fileBuf.lastIndexOf(HIDDEN_HEADER_MAGIC, offset - 1)
  ) {
    // Every candidate costs a full scrypt derivation. The magic is 6 random
    // bytes, so incidental hits in the padding are vanishingly rare — but a
    // hostile file could be crafted with thousands of them and turn an open
    // into a CPU-exhaustion loop. Bound the work; a legitimately-created
    // container needs exactly one.
    if (attempts++ >= MAX_HIDDEN_BLOCK_ATTEMPTS) break;

    const blob = tryDecryptHiddenBlob(fileBuf, offset, hiddenPassword);
    if (!blob) continue;

    // Success! The hidden payload is the `payloadLen` bytes immediately
    // before this encrypted block.
    const payloadEnd = offset;
    const payloadStart = payloadEnd - blob.payloadLen;
    if (payloadStart < 0) continue; // corrupt or wrong match

    const payload = fileBuf.subarray(payloadStart, payloadEnd);

    // Verify the payload actually decrypts (GCM will reject if it's the wrong slice).
    const header = blob.header;
    const cipher = assertCipher(header.cipher || DEFAULT_CIPHER);
    const passKey = deriveKeyFromPassword(
      hiddenPassword,
      Buffer.from(header.salt, "hex"),
      header.kdfParams,
    );
    let mek: Buffer | null = null;
    try {
      mek = decryptGCM(passKey, header.encryptedMek);
      decryptPayload(mek, header.payloadIv, header.payloadTag, payload, cipher);
      return { header, payload };
    } catch {
      continue; // wrong match, keep scanning
    } finally {
      // Wipe on BOTH paths: the early `return` above is the success path, and
      // leaving the MEK in a live Buffer on the scan-and-reject path would keep
      // it recoverable from the heap for the rest of the process.
      if (mek) wipeBuf(mek);
      wipeBuf(passKey);
    }
  }

  throw new Error(
    "No hidden volume found with this password, or the password is incorrect.",
  );
}

/**
 * Check if opening the outer volume works (for the "duress" scenario).
 * Returns true if the password successfully opens the outer (standard) container.
 */
export function isOuterPassword(vaultPath: string, password: string): boolean {
  try {
    const { header } = readContainer(path.resolve(vaultPath));
    const passKey = deriveKeyFromPassword(
      password,
      Buffer.from(header.salt, "hex"),
      header.kdfParams,
    );
    const mek = decryptGCM(passKey, header.encryptedMek);
    wipeBuf(mek);
    wipeBuf(passKey);
    return true;
  } catch {
    return false;
  }
}
