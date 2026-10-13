// A tiny, dependency-free archive format used as the *plaintext* payload of a
// vault. It packs a directory tree (files + relative paths + modes) into a
// single Buffer, and unpacks it back to disk. Directory structure is
// preserved via POSIX-style relative paths.
//
// Layout:
//   [MANIFEST_LEN: 4 bytes BE][MANIFEST JSON][file1 bytes][file2 bytes]...
//
// The manifest lists entries in the same order their bytes are concatenated.

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { BundleEntry } from "./types";
import { INDEX_SUPPRESSION_MARKERS } from "./fsutil";

// Recommended payload ceiling (1.5 GiB). Keeping buffers comfortably under the
// Node Buffer cap (~2 GiB) avoids OOM / hard failures while opening/creating.
export const MAX_PAYLOAD_SIZE = 1.5 * 1024 * 1024 * 1024;

interface WalkedFile {
  abs: string; // absolute path on disk
  rel: string; // POSIX relative path within the vault
  mode: number; // file mode captured at walk time
}

/** Recursively collect all regular files under `root`. */
function walk(root: string, rel = ""): WalkedFile[] {
  const out: WalkedFile[] = [];
  const dir = path.join(root, rel);
  for (const name of fs.readdirSync(dir)) {
    const childRel = rel ? `${rel}/${name}` : name;
    const abs = path.join(root, childRel);
    // ShadowBit's own index-suppression markers live in the working directory
    // (see suppressIndexing) but are not vault content. Without this they would
    // be packed on every close and come back on every open, so the user would
    // permanently carry dotfiles they never created — one on macOS
    // (.metadata_never_index), three on Linux (.trackerignore, .noindex,
    // .hidden), none on Windows (it uses a file attribute).
    if (!rel && INDEX_SUPPRESSION_MARKERS.has(name)) continue;
    // lstat (not stat) so symlinks and special files are skipped rather than
    // followed — packing a symlink silently could expose or duplicate files.
    //
    // The try/catch is for entries that vanish between readdir and lstat. The
    // working directory is a live folder the user is editing, so `close` races
    // with them by nature; one deleted file should not fail the whole close and
    // leave the vault un-closable.
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walk(root, childRel));
    } else if (stat.isFile()) {
      out.push({ abs, rel: childRel, mode: stat.mode });
    }
    // symlinks / special files are intentionally skipped (documented).
  }
  return out;
}

/**
 * A valid, empty bundle: a manifest length prefix followed by a manifest with
 * zero entries.
 *
 * An empty vault still has to be a *well-formed* bundle, not an empty buffer or
 * a bare "{}", because unpackDir reads the 4-byte length prefix unconditionally
 * and rejects anything shorter. Exporting this keeps vault.ts and hidden.ts
 * byte-identical on what "no contents" means.
 */
export function emptyBundle(): Buffer {
  const manifest = Buffer.from(JSON.stringify({ entries: [] }), "utf8");
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(manifest.length, 0);
  return Buffer.concat([lenPrefix, manifest]);
}

/**
 * Deflate a plaintext bundle before encryption.
 *
 * Lives here rather than in vault.ts so the compression settings and the
 * MAX_PAYLOAD_SIZE expansion cap have exactly one definition: hidden.ts
 * compresses its sub-volumes with the same call, and a divergence between the
 * two would mean a hidden volume that inflates past the cap the outer path
 * enforces.
 */
export function compressBundle(plain: Buffer): Buffer {
  return zlib.deflateSync(plain, { level: 6 });
}

/**
 * Inflate a bundle written by `compressBundle`.
 *
 * `maxOutputLength` is mandatory, not an optimisation. The payload is
 * authenticated, but a *legitimate* vault can compress extremely well — a
 * multi-gigabyte log, dump or sparse image of zeros shrinks by three orders of
 * magnitude — and MAX_PAYLOAD_SIZE bounds the COMPRESSED size only. Without a
 * cap, opening such a vault asks Node for tens of gigabytes of Buffer in one
 * allocation and the process dies with an unhelpful heap OOM instead of an
 * error naming the vault. The limit matches MAX_PAYLOAD_SIZE so any bundle
 * this build wrote itself still opens; only an over-large expansion is refused.
 */
export function decompressBundle(data: Buffer): Buffer {
  return zlib.inflateSync(data, { maxOutputLength: MAX_PAYLOAD_SIZE });
}

/** Pack a directory tree into a single Buffer. */
export function packDir(root: string): Buffer {
  if (!fs.existsSync(root)) {
    throw new Error(`Seed path not found: ${root}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Seed path is not a directory: ${root}`);
  }
  const files = walk(root);
  const entries: BundleEntry[] = [];
  const chunks: Buffer[] = [];
  let total = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    total += data.length;
    if (total > MAX_PAYLOAD_SIZE) {
      throw new Error(
        `Vault contents exceed the maximum supported payload size ` +
          `(${MAX_PAYLOAD_SIZE / (1024 * 1024 * 1024)} GiB).`,
      );
    }
    entries.push({ path: f.rel, size: data.length, mode: f.mode });
    chunks.push(data);
  }
  const manifest = Buffer.from(JSON.stringify({ entries }), "utf8");
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(manifest.length, 0);
  return Buffer.concat([lenPrefix, manifest, ...chunks]);
}

/** Unpack a bundle Buffer into `destDir` (created if missing). */
export function unpackDir(bundle: Buffer, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  if (bundle.length < 4) {
    throw new Error("Corrupt bundle (too small).");
  }
  const manifestLen = bundle.readUInt32BE(0);
  if (4 + manifestLen > bundle.length) {
    throw new Error("Corrupt bundle (manifest length out of range).");
  }
  const manifestJson = bundle.subarray(4, 4 + manifestLen).toString("utf8");
  let entries: BundleEntry[];
  try {
    entries =
      (JSON.parse(manifestJson) as { entries?: BundleEntry[] }).entries ?? [];
  } catch {
    throw new Error("Corrupt bundle (invalid manifest).");
  }

  let offset = 4 + manifestLen;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !Number.isInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new Error(`Corrupt bundle entry: ${JSON.stringify(entry)}`);
    }
    // Bounds-check every entry against the actual buffer (H4).
    if (offset + entry.size > bundle.length) {
      throw new Error(
        `Corrupt bundle (entry size out of range: ${entry.path}).`,
      );
    }
    const data = bundle.subarray(offset, offset + entry.size);
    offset += entry.size;

    // Path-traversal guard (C4): normalize Windows separators too, then
    // REJECT any path that is absolute, drive-lettered, contains ".."
    // segments, or resolves outside destDir. We reject rather than sanitize so
    // a malicious bundle can never silently corrupt the unpack layout.
    const cleaned = entry.path.replace(/\\/g, "/");
    if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
      throw new Error(`Unsafe path in bundle: ${entry.path}`);
    }
    const parts = cleaned
      .split("/")
      .filter((p: string) => p !== "" && p !== ".");
    if (parts.length === 0 || parts.some((p: string) => p === "..")) {
      throw new Error(`Unsafe path in bundle: ${entry.path}`);
    }
    const safeRel = parts.join("/");
    const abs = path.resolve(destDir, safeRel);
    const rel = path.relative(destDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Unsafe path in bundle: ${entry.path}`);
    }

    // Skip ShadowBit's own index-suppression markers at the top level. This
    // cleans up vaults written before they were excluded from the packer (those
    // carry the markers permanently) and stops a crafted vault from planting
    // them. A nested `docs/.noindex` is ordinary user content and is kept — so
    // this only applies at the root, mirroring walk().
    if (!safeRel.includes("/") && INDEX_SUPPRESSION_MARKERS.has(safeRel)) {
      continue;
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    if (Number.isInteger(entry.mode)) {
      try {
        fs.chmodSync(abs, entry.mode & 0o777);
      } catch {
        /* best-effort */
      }
    }
  }
}
