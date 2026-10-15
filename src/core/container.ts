// Reads and writes the on-disk .vault container file.
//
// Binary layout:
//   [MAGIC: 8 bytes]                "SHDBIT\0\1"
//   [HEADER_LEN: 4 bytes BE]        length of the JSON header
//   [HEADER: JSON utf8]             VaultHeader (plaintext, no secrets)
//   [PAYLOAD: rest of file]         AEAD(header.cipher) of deflate(bundle)
//
// The payload's cipher is AES-256-GCM unless the header names another
// SUPPORTED_CIPHERS entry (chacha20-poly1305); "absent" is how a v1/v2 header
// stays readable by a v3 build. The payload is always the deflate-compressed
// bundle of the vault's files — the compression flag in the header records
// that, and this build writes it as true on every path.
//
// The header is plaintext and self-describing; the payload is useless
// without the password (or recovery key), which is what makes the single
// file safe to share as an attachment.
//
// "Rest of file" is the normal case but not the only one: a header that
// declares `payloadLen` pins the boundary, which is what a hidden-volume
// container needs. See `payloadEnd` below.
//
// NOTE: this magic changed with the 2.1 rebrand. Containers written by earlier
// builds are rejected rather than read — the format is a clean break, not a
// compatibility shim.

import * as fs from "fs";
import { VaultHeader } from "./types";
import { MAX_PAYLOAD_SIZE } from "./bundle";

/**
 * Filename extension for vault containers.
 *
 * The extension is cosmetic and never part of the format: identification is by
 * MAGIC bytes, and `readHeader`/`openVault` accept a path with any suffix. It
 * exists only to name the *default* output and to claim a file association.
 *
 * It is NOT `.vault`, because `.vault` is claimed by several unrelated tools
 * (HashiCorp, Bitwarden). A collision there means double-clicking opens some
 * other program, and the OS file picker groups every vault family's files
 * under one filter. `.vlt` was rejected for the same reason twice over — it is
 * WinVault's container extension *and* VLC's skin extension.
 */
export const VAULT_EXT = "svlt";
/**
 * The extension ShadowBit used before VAULT_EXT existed. Still recognised on
 * every path that decides "is this a vault file the user picked?" — a rename is
 * not a re-encryption, and refusing to open a legacy `.vault` because of a
 * cosmetic change would lose the user's data.
 */
export const LEGACY_VAULT_EXT = "vault";
/** Extensions that identify a vault file for association/filter purposes. */
export const VAULT_EXTS = [VAULT_EXT, LEGACY_VAULT_EXT] as const;

/** True if `p` ends in a current or legacy vault extension (case-insensitive). */
export function hasVaultExt(p: string): boolean {
  const lower = p.toLowerCase();
  return VAULT_EXTS.some((e) => lower.endsWith(`.${e}`));
}

export const MAGIC = Buffer.from("SHDBIT\x00\x01", "latin1"); // 8 bytes
/** The header's `magic` string field (distinct from the binary MAGIC above). */
export const HEADER_MAGIC = "SHDBIT";
/**
 * Ceiling on the JSON header's encoded length. 1 MiB is far more than any real
 * header needs (a few hundred bytes), so this only ever rejects a corrupt or
 * hostile length field — but it must be checked *before* allocating or slicing,
 * since the field itself is attacker-controlled.
 */
export const MAX_HEADER_LEN = 1024 * 1024;
export const CURRENT_VERSION = 3;
export const MIN_SUPPORTED_VERSION = 1;
export const MAX_CONTAINER_SIZE = MAX_PAYLOAD_SIZE + MAX_HEADER_LEN + 16;

export interface Container {
  header: VaultHeader;
  payload: Buffer;
}

/**
 * Parse + validate a header buffer. Throws a descriptive error on any problem.
 *
 * Exported for stego.ts, which finds a container embedded at an offset inside a
 * carrier rather than at position 0 and must apply exactly the same magic /
 * version / type checks before trusting what it found.
 */
export function parseHeader(buf: Buffer): VaultHeader {
  let parsed: any;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("Corrupt vault file (invalid header JSON).");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Corrupt vault file (invalid header).");
  }
  if (parsed.magic !== HEADER_MAGIC) {
    throw new Error("Corrupt vault file (bad header magic).");
  }
  const v = parsed.version;
  // The type check is load-bearing, not defensive noise: the range comparison
  // `v < MIN || v > CURRENT` is FALSE for NaN, so `version: {}` or
  // `version: []` sailed through and the bogus value reached `vault info`
  // output and every downstream version comparison. A header is attacker-
  // controlled input.
  if (!Number.isInteger(v)) {
    throw new Error("Corrupt vault file (invalid version field).");
  }
  if (v < MIN_SUPPORTED_VERSION || v > CURRENT_VERSION) {
    throw new Error(
      `Unsupported vault version: ${v} ` +
        `(this build supports ${MIN_SUPPORTED_VERSION}–${CURRENT_VERSION}).`,
    );
  }
  return parsed as VaultHeader;
}

/** Serialize header + encrypted payload to the container file on disk.
 *  Uses a write-to-tmp-then-rename strategy so a crash or full disk mid-write
 *  never leaves the vault in a partially-written (unrecoverable) state.
 *  On all supported platforms `fs.renameSync` is atomic when src and dest share
 *  the same filesystem (which they always will here).
 */
export function writeContainer(
  filePath: string,
  header: VaultHeader,
  payload: Buffer,
): void {
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(headerJson.length, 0);
  const buf = Buffer.concat([MAGIC, headerLen, headerJson, payload]);
  // Write to a sibling .tmp file first; rename is atomic so the original vault
  // is never clobbered until the new data is fully written to disk.
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
    // Scrub filesystem timestamps to avoid leaking modification times.
    try {
      const epoch = new Date(0);
      fs.utimesSync(filePath, epoch, epoch);
    } catch {
      /* best-effort — NFS mounts or permission issues may block this */
    }
  } catch (e) {
    // Best-effort cleanup — the original vault file is untouched on failure.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Read and parse a container file. Throws if it is not a valid vault. */
export function readContainer(filePath: string): Container {
  const size = fs.statSync(filePath).size;
  if (size < MAGIC.length + 4) {
    throw new Error("Not a valid vault file (too small).");
  }
  if (size > MAX_CONTAINER_SIZE) {
    throw new Error(
      `Vault exceeds the maximum supported size ` +
        `(${MAX_PAYLOAD_SIZE / (1024 * 1024 * 1024)} GiB payload).`,
    );
  }
  const buf = fs.readFileSync(filePath);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not a valid vault file (bad magic bytes).");
  }
  const headerLen = buf.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  if (headerLen > MAX_HEADER_LEN || headerEnd > buf.length) {
    throw new Error("Corrupt vault file (header length out of range).");
  }
  const header = parseHeader(buf.subarray(headerStart, headerEnd));
  const payload = buf.subarray(headerEnd, payloadEnd(buf, header, headerEnd));
  return { header, payload };
}

/**
 * Where the encrypted payload ends.
 *
 * Normally that is end-of-file, and stays that way: every ordinary vault keeps
 * working exactly as before. A header that declares `payloadLen` fixes the
 * boundary explicitly, which is what a hidden-volume container needs — it
 * appends random padding plus a second encrypted volume after the outer
 * payload, and reading to EOF would append that tail to the ciphertext and
 * break GCM authentication on every open.
 *
 * Only `hidden.ts` ever sets the field, and `vault.ts`'s `assertNoTrailingData`
 * refuses to rewrite a file that declares it — so this is the one and only
 * reader of it, and the one writer is the module that composes the whole file.
 *
 * The declared length is validated against the real file size so a truncated
 * or lying header produces "corrupt vault", never a short read that silently
 * becomes a different payload.
 */
function payloadEnd(
  buf: Buffer,
  header: VaultHeader,
  headerEnd: number,
): number {
  const len = header.payloadLen;
  if (len === undefined) return buf.length;
  if (!Number.isInteger(len) || len < 0) {
    throw new Error("Corrupt vault file (invalid payload length).");
  }
  const end = headerEnd + len;
  if (end > buf.length) {
    throw new Error("Corrupt vault file (payload length out of range).");
  }
  return end;
}

/**
 * Read just the header — cheap. Only MAGIC + length + header bytes are read
 * (via file descriptor), the payload is never touched.
 */
export function readHeader(filePath: string): VaultHeader {
  const { header } = readHeaderRaw(filePath);
  return header;
}

/**
 * Read just the header, returning both the parsed object AND the raw bytes.
 * The raw bytes are used to compute the header hash for TOCTOU protection —
 * stored in the session at open time and verified at close time.
 */
export function readHeaderRaw(filePath: string): {
  header: VaultHeader;
  rawBytes: Buffer;
} {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < MAGIC.length + 4) {
      throw new Error("Not a valid vault file (too small).");
    }
    const magicBuf = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, magicBuf, 0, MAGIC.length, 0);
    if (!magicBuf.equals(MAGIC)) {
      throw new Error("Not a valid vault file (bad magic bytes).");
    }
    const lenBuf = Buffer.alloc(4);
    fs.readSync(fd, lenBuf, 0, 4, MAGIC.length);
    const headerLen = lenBuf.readUInt32BE(0);
    if (headerLen > MAX_HEADER_LEN || MAGIC.length + 4 + headerLen > fileSize) {
      throw new Error("Corrupt vault file (header length out of range).");
    }
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, MAGIC.length + 4);
    return { header: parseHeader(headerBuf), rawBytes: headerBuf };
  } finally {
    fs.closeSync(fd);
  }
}
