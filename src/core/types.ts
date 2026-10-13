// Shared type definitions for the ShadowBit container format.

/** An AES-256-GCM encrypted blob. All fields are hex-encoded. */
export interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

/** scrypt key-derivation parameters. */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

/**
 * The plaintext header embedded at the start of every .vault container.
 * It contains everything required to decrypt the payload EXCEPT the
 * password (or recovery key). This is what makes a vault self-contained
 * and shareable as a single file.
 */
export interface VaultHeader {
  magic: string; // format identifier
  version: number; // container format version
  kdf: "scrypt"; // key-derivation function
  kdfParams: KdfParams; // scrypt cost params
  salt: string; // hex: per-vault salt for password KDF
  encryptedMek: EncryptedBlob; // MEK encrypted with the password-derived key
  recovery?: {
    // optional recovery-key escrow of the MEK
    encryptedMek: EncryptedBlob;
    /**
     * Domain-separated, UNSALTED SHA-256 of the recovery key, for a friendly
     * pre-check only — so a typo reports "Incorrect recovery key" instead of a
     * full scrypt derivation plus a GCM failure. It is not the security gate
     * (the escrow's GCM tag is) and it is public: it lives in a plaintext
     * header anyone can read. That is acceptable because the key carries 200
     * bits of entropy, so there is nothing to guess; it is never used to
     * decrypt anything.
     */
    keyHash: string;
    // hex: per-escrow salt for the recovery-key KDF (v2+). Absent on a legacy
    // v1 escrow, whose wrapping key came from a single-round, unsalted (but
    // domain-separated) SHA-256 of the recovery key rather than scrypt.
    salt?: string;
  };
  payloadIv: string; // hex: IV used to encrypt the file payload
  payloadTag: string; // hex: GCM auth tag of the encrypted payload
  /**
   * Optional: exact byte length of the encrypted payload. When absent, the
   * payload is "everything from the end of the header to end of file", which is
   * every ordinary vault. Hidden-volume containers append random padding and a
   * second encrypted volume after the outer payload, so they must declare the
   * boundary — without it the reader hands GCM a payload with a tail bolted on
   * and every open fails authentication.
   *
   * Additive and backwards compatible: a reader that ignores the field behaves
   * exactly as before on every vault that lacks it. It is covered by headerMac,
   * so the boundary cannot be truncated by an attacker.
   */
  payloadLen?: number;
  createdAt: string; // ISO timestamp
  modifiedAt: string; // ISO timestamp
  compressed?: boolean; // true → payload bundle was deflated before encryption
  headerMac?: string; // hex: HMAC-SHA256 over canonical header (v3+)
  keyfileRequired?: boolean; // true → keyfile was used during creation (v3+)
  cipher?: "aes-256-gcm" | "chacha20-poly1305"; // encryption algorithm (v3+, default: aes-256-gcm)
  meta?: {
    // optional user-visible metadata (plaintext)
    name?: string;
    description?: string;
  };
}

/** One file inside the (decrypted) bundle. */
export interface BundleEntry {
  path: string; // POSIX relative path within the vault
  size: number; // byte length
  mode: number; // unix file mode
}

/** Metadata about an open vault session (contains NO secrets). */
export interface VaultSession {
  vaultPath: string; // absolute path to the .vault file
  workingDir: string; // absolute path to the decrypted temp dir
  openedAt: string; // ISO timestamp
  headerHash?: string; // SHA-256 hex of raw header bytes at open time (TOCTOU guard)
  keyfiles?: string[]; // keyfile paths used to open (needed for close/discard)
}

/** Summary info about a vault, obtained without decrypting the payload. */
export interface VaultInfo {
  vaultPath: string;
  version: number;
  hasRecoveryKey: boolean;
  createdAt: string;
  modifiedAt: string;
  fileSize: number;
  isOpen: boolean;
  workingDir?: string;
  compressed?: boolean;
  /** Cipher the payload was encrypted with. Absent means the v3 default. */
  cipher?: string;
  /** True when the vault cannot be opened without at least one keyfile. */
  keyfileRequired?: boolean;
  meta?: { name?: string; description?: string };
}

/** Result returned by addToSession, including symlink skip count. */
export interface AddResult {
  count: number;
  symlinksSkipped: number;
}
