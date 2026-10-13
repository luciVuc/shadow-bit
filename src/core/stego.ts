// Carrier-file steganography: embed/extract a vault inside an innocent-looking
// file (JPEG, PNG, PDF, ZIP, etc.) by appending vault data after the carrier's
// natural EOF. Standard viewers display the carrier normally; ShadowBit finds
// the vault by scanning for the stego magic bytes.
//
// Layout:
//   [CARRIER FILE bytes (valid image/doc)]
//   [STEGO_MAGIC 8B]     "SBSTEG\x00\x01"
//   [HEADER_LEN 4B BE]   length of the JSON header
//   [HEADER JSON]         VaultHeader (same as a normal .vault)
//   [PAYLOAD bytes]       AES-256-GCM ciphertext
//
// Detection needs no carrier-format parsing: locate STEGO_MAGIC and read the
// container from there. The search is bounded by SCAN_WINDOW (the largest vault
// this build can write plus header headroom), so a carrier larger than that
// still only costs one bounded pass — but note the payload runs to end-of-file,
// so extracting a vault inherently buffers the whole tail in memory, exactly
// like opening any other vault.

import * as fs from "fs";
import * as path from "path";
import { VaultHeader } from "./types";
import { MAX_PAYLOAD_SIZE } from "./bundle";
import { MAX_HEADER_LEN, parseHeader } from "./container";

export const STEGO_MAGIC = Buffer.from("SBSTEG\x00\x01", "latin1"); // 8 bytes

/** Maximum carrier file size (500 MB — practical limit for images/docs). */
const MAX_CARRIER_SIZE = 500 * 1024 * 1024;

/** How far from the end of the file to scan for the magic (covers any vault). */
const SCAN_WINDOW = MAX_PAYLOAD_SIZE + 2 * 1024 * 1024; // payload + header headroom

export interface StegoContainer {
  header: VaultHeader;
  payload: Buffer;
  /** Byte offset where the stego magic starts (carrier ends here). */
  stegoOffset: number;
}

/**
 * Embed a vault (header + payload) inside a carrier file.
 * The carrier is copied verbatim; the vault is appended after it.
 * The output file has the carrier's extension and opens normally in viewers.
 */
export function embedVault(
  carrierPath: string,
  header: VaultHeader,
  payload: Buffer,
  outputPath: string,
): void {
  if (!fs.existsSync(carrierPath)) {
    throw new Error(`Carrier file not found: ${carrierPath}`);
  }
  const carrierSize = fs.statSync(carrierPath).size;
  if (carrierSize > MAX_CARRIER_SIZE) {
    throw new Error(
      `Carrier file too large (${(carrierSize / 1024 / 1024).toFixed(0)} MB, max ${MAX_CARRIER_SIZE / 1024 / 1024} MB).`,
    );
  }
  // Writing the carrier over itself would destroy it: the tmp+rename below
  // renames onto outputPath, so the source would already be gone by then.
  if (path.resolve(carrierPath) === path.resolve(outputPath)) {
    throw new Error("Output path must differ from the carrier file.");
  }

  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(headerJson.length, 0);

  // The carrier is streamed in chunks rather than read whole. MAX_CARRIER_SIZE
  // is 500 MB and the payload can be 1.5 GiB, so a readFileSync + Buffer.concat
  // would hold roughly three times the final size on the heap at once — on the
  // largest inputs that is the difference between fitting in RAM and an OOM.
  const tmp = `${outputPath}.tmp`;
  try {
    const src = fs.openSync(carrierPath, "r");
    const dst = fs.openSync(tmp, "w");
    try {
      const CHUNK = 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let copied = 0;
      while (copied < carrierSize) {
        const read = fs.readSync(src, buf, 0, CHUNK, copied);
        if (read <= 0) break;
        fs.writeSync(dst, buf, 0, read);
        copied += read;
      }
      fs.writeSync(dst, STEGO_MAGIC);
      fs.writeSync(dst, headerLen);
      fs.writeSync(dst, headerJson);
      fs.writeSync(dst, payload);
      fs.fsyncSync(dst);
    } finally {
      fs.closeSync(src);
      fs.closeSync(dst);
    }
    fs.renameSync(tmp, outputPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Extract a vault from a carrier file. Returns null if no embedded vault found.
 *
 * The magic is located with `indexOf`, not a hand-rolled byte loop: the window
 * is up to MAX_PAYLOAD_SIZE wide, so a JS loop with a `subarray().equals()` per
 * offset allocates a Buffer per byte and takes minutes on a large vault, where
 * `indexOf` is a native memmem.
 *
 * Every candidate offset is tried, not just the first. The carrier is arbitrary
 * user content, so it may legitimately contain the 8 magic bytes — in a JPEG's
 * compressed scan data, say — and stopping at the first match would report "no
 * vault" for a carrier that has one appended right after it.
 */
export function extractVault(filePath: string): StegoContainer | null {
  if (!fs.existsSync(filePath)) return null;
  const size = fs.statSync(filePath).size;
  if (size < STEGO_MAGIC.length + 4) return null;

  // Read the tail of the file (or the whole file if small).
  const readStart = Math.max(0, size - SCAN_WINDOW);
  const fd = fs.openSync(filePath, "r");
  try {
    const tailSize = size - readStart;
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, readStart);

    for (
      let magicIdx = tail.indexOf(STEGO_MAGIC);
      magicIdx !== -1;
      magicIdx = tail.indexOf(STEGO_MAGIC, magicIdx + 1)
    ) {
      const parsed = parseVaultAt(tail, magicIdx);
      if (parsed) {
        return { ...parsed, stegoOffset: readStart + magicIdx };
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse the container that begins at `magicIdx`, or null if it is not one. */
function parseVaultAt(
  tail: Buffer,
  magicIdx: number,
): { header: VaultHeader; payload: Buffer } | null {
  const afterMagic = magicIdx + STEGO_MAGIC.length;
  if (afterMagic + 4 > tail.length) return null;

  const headerLen = tail.readUInt32BE(afterMagic);
  const headerStart = afterMagic + 4;
  const headerEnd = headerStart + headerLen;
  // A header is a few hundred bytes. An implausible length means this is a
  // coincidental magic match in the carrier, not a container — and bounding the
  // read stops a crafted 4-byte length from making JSON.parse chew on gigabytes.
  if (headerLen > MAX_HEADER_LEN || headerEnd > tail.length) return null;

  let header: VaultHeader;
  try {
    header = parseHeader(tail.subarray(headerStart, headerEnd));
  } catch {
    // Not a container: wrong magic, unsupported version, malformed JSON, or a
    // coincidental magic match inside the carrier. Either way, keep scanning.
    return null;
  }
  return { header, payload: tail.subarray(headerEnd) };
}

/**
 * Quick check: does this file contain an embedded vault?
 *
 * Reads only the last 64 KB rather than the whole SCAN_WINDOW, so it stays a
 * cheap sniff for "is this a carrier?" — but that makes it a heuristic, not a
 * prefilter for `extractVault`: the magic can sit further back than 64 KB in a
 * carrier with a lot of trailing padding. Callers must treat a `false` as "not
 * near the end", not as "no vault".
 */
export function hasEmbeddedVault(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const size = fs.statSync(filePath).size;
  if (size < STEGO_MAGIC.length) return false;

  const readSize = Math.min(size, 64 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    return buf.indexOf(STEGO_MAGIC) !== -1;
  } finally {
    fs.closeSync(fd);
  }
}
