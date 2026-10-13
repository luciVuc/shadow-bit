// Low-level cryptographic primitives for the ShadowBit container.
//
// Design (envelope encryption):
//   - A random 256-bit Master Encryption Key (MEK) encrypts the payload.
//   - The MEK is itself encrypted ("wrapped") by a key derived from the
//     password, and (optionally) by a key derived from a recovery key.
//   - Changing the password only re-wraps the MEK; the payload is untouched.
//
// All symmetric encryption uses AES-256-GCM (authenticated encryption), so
// tampering or a wrong key is detected as a decryption failure.

import * as crypto from "crypto";
import * as fs from "fs";
import { EncryptedBlob, KdfParams } from "./types";

export const DEFAULT_KDF_PARAMS: KdfParams = {
  // scrypt CPU/memory cost.
  N: 1 << 17,
  r: 8,
  p: 1,
  keyLen: 32, // 256-bit key
};

/**
 * scrypt cost floor accepted from a vault header. Default cost may rise over
 * time, but we always accept the legacy floor so old vaults keep opening.
 */
export const MIN_KDF_N = 16384;

const GCM_IV_BYTES = 12; // recommended IV size for GCM

/**
 * Bounds for scrypt cost parameters read from a (attacker-controlled) vault
 * header. Prevents CPU/memory exhaustion (DoS) when merely opening a vault.
 */
export function assertKdfParams(k: KdfParams): void {
  const okN =
    Number.isInteger(k.N) &&
    k.N >= MIN_KDF_N &&
    k.N <= 1 << 20 &&
    (k.N & (k.N - 1)) === 0;
  const ok =
    okN &&
    Number.isInteger(k.r) &&
    k.r >= 1 &&
    k.r <= 32 &&
    Number.isInteger(k.p) &&
    k.p >= 1 &&
    k.p <= 16 &&
    Number.isInteger(k.keyLen) &&
    k.keyLen === 32;
  if (!ok) {
    throw new Error("Unsupported or unsafe KDF parameters in vault header.");
  }
}

/** Generate a fresh random 256-bit Master Encryption Key. */
export function generateMek(): Buffer {
  return crypto.randomBytes(32);
}

/** Generate a random salt for password key derivation. */
export function generateSalt(): Buffer {
  return crypto.randomBytes(16);
}

// --- Keyfile support ------------------------------------------------------

/**
 * Process a keyfile: read its first 1 MiB and hash it to produce a 32-byte
 * contribution that is XOR'd into the password-derived key. This follows the
 * VeraCrypt approach: the keyfile is not a replacement for the password but
 * a second factor that strengthens it.
 *
 * The keyfile can be any file — an image, a text file, random data, etc.
 * Only the first 1 MiB is used (to bound memory/time).
 */
export function processKeyfile(keyfilePath: string): Buffer {
  if (!fs.existsSync(keyfilePath)) {
    throw new Error(`Keyfile not found: ${keyfilePath}`);
  }
  const stat = fs.statSync(keyfilePath);
  if (!stat.isFile()) {
    throw new Error(`Keyfile must be a regular file: ${keyfilePath}`);
  }
  const MAX_KEYFILE_READ = 1024 * 1024; // 1 MiB
  const fd = fs.openSync(keyfilePath, "r");
  try {
    const readSize = Math.min(stat.size, MAX_KEYFILE_READ);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    // SHA-256 the keyfile content with domain separation.
    return crypto
      .createHash("sha256")
      .update("shadowbit-keyfile:")
      .update(buf)
      .digest();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Process multiple keyfiles and combine them into a single 32-byte hash.
 * The individual keyfile hashes are XOR'd together, then the result is
 * hashed once more for uniformity.
 */
export function processKeyfiles(keyfilePaths: string[]): Buffer {
  if (keyfilePaths.length === 0) {
    throw new Error("At least one keyfile must be provided.");
  }
  let combined = Buffer.alloc(32, 0);
  for (const kf of keyfilePaths) {
    const kfHash = processKeyfile(kf);
    for (let i = 0; i < 32; i++) {
      combined[i] ^= kfHash[i];
    }
  }
  return crypto
    .createHash("sha256")
    .update("shadowbit-keyfiles-combined:")
    .update(combined)
    .digest();
}

/**
 * Mix a keyfile hash into a password string. The result is used as the
 * effective password for key derivation. This ensures that both the password
 * AND the keyfile are required to derive the same key.
 *
 * Security note: this returns a hex **string**, so the effective password is
 * interned on the V8 heap and cannot be zeroed after use — unlike the `Buffer`
 * key material elsewhere, which is wiped in `finally` blocks. For vaults that
 * use keyfiles, the composed secret is therefore readable from a core dump or
 * a heap snapshot for as long as the process lives. This is a known limitation
 * of deriving the key from a JS string; see SECURITY.md. Prefer a strong
 * standalone password over keyfiles if your threat model includes memory
 * disclosure.
 */
export function mixKeyfileIntoPassword(
  password: string,
  keyfileHash: Buffer,
): string {
  // HMAC(password, keyfileHash) → hex string used as the effective password.
  // This is a one-way binding: knowing the effective password doesn't reveal
  // either the original password or the keyfile content.
  return crypto
    .createHmac("sha256", keyfileHash)
    .update(password.normalize("NFKC"))
    .digest("hex");
}

/** Derive a 256-bit key from a password + salt using scrypt (memory-hard). */
export function deriveKeyFromPassword(
  password: string,
  salt: Buffer,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Buffer {
  // The header params come from an untrusted file: clamp them before deriving.
  assertKdfParams(params);
  return crypto.scryptSync(password.normalize("NFKC"), salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    // 512 MiB headroom: N=2^17,r=8 needs ~134 MB; 256 MB was tight and could
    // produce misleading "Incorrect password" errors on some configurations.
    maxmem: 512 * 1024 * 1024,
  });
}

/** Encrypt data with AES-256-GCM under the given 32-byte key. */
export function encryptGCM(key: Buffer, plaintext: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: data.toString("hex"),
  };
}

/**
 * Decrypt an AES-256-GCM blob. Throws if the key is wrong or the data has
 * been tampered with (GCM authentication failure).
 */
export function decryptGCM(key: Buffer, blob: EncryptedBlob): Buffer {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.data, "hex")),
    decipher.final(),
  ]);
}

// --- Algorithm-agnostic AEAD encryption -----------------------------------

export type CipherAlgorithm = "aes-256-gcm" | "chacha20-poly1305";
export const DEFAULT_CIPHER: CipherAlgorithm = "aes-256-gcm";

/** Every cipher the container format can name. */
export const SUPPORTED_CIPHERS: readonly CipherAlgorithm[] = [
  "aes-256-gcm",
  "chacha20-poly1305",
];

/** Validate a caller-supplied cipher name before it reaches OpenSSL. */
export function assertCipher(name: string): CipherAlgorithm {
  if (!(SUPPORTED_CIPHERS as readonly string[]).includes(name)) {
    throw new Error(
      `Unsupported cipher: ${name}. Supported: ${SUPPORTED_CIPHERS.join(", ")}.`,
    );
  }
  return name as CipherAlgorithm;
}

/** IV sizes for each supported AEAD cipher. */
const CIPHER_IV_BYTES: Record<CipherAlgorithm, number> = {
  "aes-256-gcm": 12,
  "chacha20-poly1305": 12, // RFC 8439: 96-bit nonce
};

/**
 * Encrypt a raw buffer payload with a MEK using the specified AEAD cipher.
 * Returns the ciphertext plus the iv/tag separately (so they can live in the header).
 */
export function encryptPayload(
  mek: Buffer,
  plaintext: Buffer,
  cipher: CipherAlgorithm = DEFAULT_CIPHER,
): {
  iv: string;
  tag: string;
  ciphertext: Buffer;
} {
  const ivLen = CIPHER_IV_BYTES[cipher];
  const iv = crypto.randomBytes(ivLen);
  // Both AES-256-GCM and ChaCha20-Poly1305 produce 16-byte auth tags by default.
  const enc = crypto.createCipheriv(cipher as any, mek, iv) as crypto.CipherGCM;
  const ciphertext = Buffer.concat([enc.update(plaintext), enc.final()]);
  const tag = enc.getAuthTag();
  return { iv: iv.toString("hex"), tag: tag.toString("hex"), ciphertext };
}

/** Decrypt a payload buffer given its iv/tag (from the header) and the MEK. */
export function decryptPayload(
  mek: Buffer,
  iv: string,
  tag: string,
  ciphertext: Buffer,
  cipher: CipherAlgorithm = DEFAULT_CIPHER,
): Buffer {
  const dec = crypto.createDecipheriv(
    cipher as any,
    mek,
    Buffer.from(iv, "hex"),
  ) as crypto.DecipherGCM;
  dec.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([dec.update(ciphertext), dec.final()]);
}

// --- Recovery key ---------------------------------------------------------

// Crockford-ish Base32 alphabet (no I, L, O, U to avoid ambiguity).
const B32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Generate a human-friendly recovery key, e.g. "A7KX9-MP2VQ-8NW4T-YF6JB-...".
 * Backed by 200 bits of entropy.
 */
export function generateRecoveryKey(): string {
  const raw = base32Encode(crypto.randomBytes(25)); // 25 bytes -> 40 chars
  return (raw.match(/.{1,5}/g) || []).join("-");
}

/** Normalize a recovery key for hashing/derivation (strip dashes/space, upper). */
export function normalizeRecoveryKey(key: string): string {
  return key.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Derive a 256-bit encryption key from a recovery key string using a salted,
 * memory-hard KDF (scrypt). This is the derivation used for vaults written by
 * format version >= 2, where each escrow carries its own random salt.
 */
export function deriveRecoveryKey(recoveryKey: string, salt: Buffer): Buffer {
  const norm = normalizeRecoveryKey(recoveryKey);
  return crypto.scryptSync(norm, salt, DEFAULT_KDF_PARAMS.keyLen, {
    N: DEFAULT_KDF_PARAMS.N,
    r: DEFAULT_KDF_PARAMS.r,
    p: DEFAULT_KDF_PARAMS.p,
    maxmem: 512 * 1024 * 1024,
  });
}

/**
 * LEGACY recovery-key derivation (format version 1): unsalted, single-round
 * SHA-256. Kept ONLY for reading old vaults; never used to write new ones.
 */
export function deriveKeyFromRecovery(recoveryKey: string): Buffer {
  const norm = normalizeRecoveryKey(recoveryKey);
  return crypto
    .createHash("sha256")
    .update("shadowbit-recovery-enc:" + norm)
    .digest();
}

/** A verification hash for a recovery key (for a friendly pre-check). */
export function hashRecoveryKey(recoveryKey: string): string {
  const norm = normalizeRecoveryKey(recoveryKey);
  return crypto
    .createHash("sha256")
    .update("shadowbit-recovery-verify:" + norm)
    .digest("hex");
}

// --- Header authentication (v3+) -----------------------------------------

/**
 * Derive a Header Authentication Key from the MEK using HKDF-SHA256.
 * Key separation: MEK is for AES-GCM encryption; HAK is for HMAC authentication.
 */
export function deriveHak(mek: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      mek,
      Buffer.alloc(0), // no salt (MEK is already high-entropy)
      "shadowbit-header-auth", // domain separation
      32,
    ),
  );
}

/**
 * HMAC-SHA256 over a canonical header JSON string, keyed by the HAK.
 * Used to detect header tampering (KDF-param downgrade, salt swap, etc.).
 */
export function computeHeaderMac(hak: Buffer, canonicalJson: string): string {
  return crypto.createHmac("sha256", hak).update(canonicalJson).digest("hex");
}

// --- Password strength estimation -----------------------------------------

/**
 * The most common passwords (embedded, no file I/O).
 *
 * Not "top 100" — it is the 44-entry list this module has always shipped, and
 * the count is stated here so a future edit does not describe itself with a
 * number nobody verified.
 *
 * REACHABILITY: nothing in `src/cli` or `src/gui` calls `estimateStrength`, so
 * this list is only consulted by the test suite. The GUI's strength meter is an
 * independent implementation in renderer.js, and the core's own policy
 * (`assertPassword` in vault.ts) enforces length only. Treat this as a
 * reference implementation, not an enforced control — see SECURITY.md.
 */
const BLOCKLIST: ReadonlySet<string> = new Set([
  "password",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "iloveyou",
  "princess",
  "sunshine",
  "football",
  "starwars",
  "trustno1",
  "baseball",
  "whatever",
  "dragon12",
  "master12",
  "qwertyui",
  "password1",
  "superman",
  "1qaz2wsx",
  "abc12345",
  "monkey12",
  "12341234",
  "letmein1",
  "shadow12",
  "passw0rd",
  "11111111",
  "00000000",
  "abcdefgh",
  "abcd1234",
  "asdfghjk",
  "qwerty12",
  "password123",
  "admin123",
  "welcome1",
  "aa123456",
  "charlie1",
  "donald12",
  "dragon123",
  "master123",
  "michael1",
  "mustang1",
  "jennifer",
  "trustme1",
  "access14",
]);

export interface PasswordStrength {
  /** 0 = rejected, 1 = weak, 2 = fair, 3 = good, 4 = strong */
  score: number;
  /** Estimated entropy in bits (rough lower-bound). */
  entropy: number;
  /** Human-readable suggestion. */
  feedback: string;
}

/**
 * Estimate password strength based on length and character-class diversity.
 * No external dependencies; intentionally conservative.
 */
export function estimateStrength(pw: string): PasswordStrength {
  // The literal 8 is duplicated from MIN_PASSWORD_LENGTH in vault.ts rather than
  // imported: vault.ts imports this module, so importing back would be a cycle.
  // It is advisory only — the enforced policy lives in vault.ts — so the two
  // drifting would be a cosmetic bug, not a security one. If you change one,
  // change the other.
  const MIN = 8;
  if (pw.length < MIN) {
    return {
      score: 0,
      entropy: 0,
      feedback: `Too short (minimum ${MIN} characters).`,
    };
  }
  if (BLOCKLIST.has(pw.toLowerCase())) {
    return {
      score: 0,
      entropy: 0,
      feedback: "This is a commonly used password.",
    };
  }

  // Count character classes
  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^a-zA-Z0-9]/.test(pw);
  const classes = +hasLower + +hasUpper + +hasDigit + +hasSymbol;

  // Pool size → bits per char
  let pool = 0;
  if (hasLower) pool += 26;
  if (hasUpper) pool += 26;
  if (hasDigit) pool += 10;
  if (hasSymbol) pool += 32; // conservative estimate
  const bitsPerChar = pool > 0 ? Math.log2(pool) : 0;
  const entropy = Math.floor(bitsPerChar * pw.length);

  let score: number;
  let feedback: string;

  if (pw.length >= 16 && classes >= 3) {
    score = 4;
    feedback = "Strong.";
  } else if ((pw.length >= 12 && classes >= 2) || pw.length >= 16) {
    score = 3;
    feedback = "Good. Consider adding more character variety.";
  } else if ((pw.length >= 8 && classes >= 2) || pw.length >= 12) {
    score = 2;
    feedback = "Fair. A longer password with mixed characters is safer.";
  } else {
    score = 1;
    feedback = "Weak. Use a longer passphrase with mixed character types.";
  }

  return { score, entropy, feedback };
}
