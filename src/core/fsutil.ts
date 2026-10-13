// Filesystem helpers, including best-effort secure erasure, indexing
// suppression, and filesystem timestamp management.
//
// NOTE: On SSDs, copy-on-write filesystems (APFS, Btrfs), and journaled
// filesystems, overwriting a file in place does NOT guarantee the old data
// is gone (wear-leveling / snapshots may retain copies). This is a
// best-effort measure; for hard guarantees use full-disk encryption.
//
// NOTE: This module does NOT defend key material in memory. There is no
// mlock() and no core-dump suppression — an earlier version contained
// stubs for both that appeared to work but could not (they shelled out to
// `ulimit` in a child process, which cannot affect the parent, and to
// /proc/self/coredump_filter for the same reason). They were removed
// rather than left in place, because a stub that looks like a security
// control is worse than a documented gap. See "Threat model" in
// SECURITY.md: keys live in pageable memory for the duration of an
// operation, and full-disk encryption is the actual mitigation.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// 1. Advisory locking
// ---------------------------------------------------------------------------

/**
 * Blocking advisory file lock over a whole read-modify-write cycle.
 *
 * `fn` runs while the lock is held, so two concurrent CLI/GUI processes cannot
 * interleave a lost update on the same JSON file. Creation is O_EXCL, which is
 * atomic: exactly one process wins.
 *
 * What this does and does not guarantee:
 *
 * It does NOT provide mutual exclusion against a process that ignores the lock,
 * and a lock that cannot be acquired within the retry budget is broken as stale
 * and then ignored rather than blocking indefinitely — correctness of the *vault*
 * never depends on it, only the convenience of the on-disk registries.
 *
 * `staleMs` must comfortably exceed the longest critical section. A section that
 * outlasts it can have its lock stolen mid-write, so prefer a smaller critical
 * section over a larger timeout.
 */
export function withAdvisoryLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { retries?: number; backoffMs?: number; staleMs?: number } = {},
): T {
  const retries = opts.retries ?? 20;
  const backoffMs = opts.backoffMs ?? 150;
  const staleMs = opts.staleMs ?? 10_000;

  const acquire = (): boolean => {
    for (let i = 0; i < retries; i++) {
      try {
        fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, {
          flag: "wx",
        });
        return true;
      } catch {
        // Lock exists — check whether it is stale.
        try {
          const content = fs.readFileSync(lockPath, "utf8");
          const ts = parseInt(content.split("\n")[1] ?? "", 10);
          // SECURITY / CORRECTNESS: a lock file can legitimately be observed in
          // the window between the atomic O_EXCL create and the write of the
          // payload, when it is still zero bytes. readFileSync returns "" for
          // that (it does not throw), and parsing "" as 0 yields the epoch —
          // which made every contender treat a live, freshly-claimed lock as
          // infinitely stale, DELETE it, and enter the critical section
          // unprotected. Two concurrent read-modify-write cycles then clobber
          // each other's fields: a real, intermittent lost update.
          //
          // So: only a readable, NON-ZERO timestamp that is genuinely old makes a
          // lock stale. Anything else means someone is mid-claim — wait.
          // localkey.ts guards the same zero-length window for the same reason.
          if (Number.isFinite(ts) && ts > 0 && Date.now() - ts > staleMs) {
            try {
              fs.rmSync(lockPath, { force: true });
            } catch {
              /* ignore */
            }
            continue; // retry immediately
          }
        } catch {
          /* lock file vanished between our check and read — retry */
          continue;
        }
        // Live lock — back off. Atomics.wait parks the thread without burning
        // CPU, unlike a busy-wait loop (which starves the very process we are
        // waiting on when we are on a single-core machine).
        sleepSync(backoffMs);
      }
    }
    return false; // gave up; caller proceeds unprotected
  };

  const held = acquire();
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Block the current thread for `ms` without spinning the CPU.
 *
 * setTimeout is unavailable in the synchronous code paths that need this
 * (advisory file locks), and a busy-wait loop starves the very process we are
 * waiting on when the machine is single-core. Atomics.wait is the standard way
 * to sleep in Node without a worker.
 */
export function sleepSync(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    // SharedArrayBuffer can be unavailable under a restrictive
    // --no-harmony or in exotic sandboxes; fall back to a short busy-wait.
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      /* last-resort spin */
    }
  }
}

/**
 * Marker filenames `suppressIndexing` drops into a working directory.
 *
 * Exported so the packer can keep them OUT of the encrypted payload: these are
 * ShadowBit's own artefacts, not user content, and baking them into every vault
 * would permanently pollute the user's file list with dotfiles they never
 * created. How many appear depends on the platform — one on macOS, three on
 * Linux, none on Windows, which sets a file attribute instead — so this set is
 * the union of every marker any branch can write. They stay on disk (that is
 * the point — they suppress indexing) and are simply not treated as vault
 * content.
 */
export const INDEX_SUPPRESSION_MARKERS: ReadonlySet<string> = new Set([
  ".metadata_never_index", // macOS Spotlight
  ".trackerignore", // Linux / GNOME Tracker 3
  ".noindex", // Linux / KDE Baloo
  ".hidden", // Linux / generic file managers
]);

// ---------------------------------------------------------------------------
// 2. Indexing suppression
// ---------------------------------------------------------------------------

/**
 * Suppress OS-level indexing on a directory **and its contents**.
 * - macOS: Spotlight (.metadata_never_index), Spotlight's own index switch
 *          (`mdutil -i off`), Time Machine exclusion (xattr).
 * - Windows: FILE_ATTRIBUTE_NOT_CONTENT_INDEXED on the dir and all children.
 * - Linux: Tracker/Baloo config-drop (.trackerignore, .noindex), .hidden.
 *
 * Every platform branch is best-effort and never throws: `mdutil -i off` and
 * `xattr -w` commonly need privileges the app does not have, and failing to
 * open a vault because Spotlight suppression was denied would be absurd. Do not
 * describe this as "indexing is blocked" — it is best-effort and
 * platform-dependent (see the docs). Note that suppression is applied on every
 * open by whichever platform is running, so it does not travel with the vault
 * file: a vault opened on Linux gets Tracker/Baloo markers even if it was
 * created on Windows.
 */
export function suppressIndexing(dir: string): void {
  try {
    if (process.platform === "darwin") {
      // .metadata_never_index tells Spotlight not to index this directory.
      fs.writeFileSync(path.join(dir, ".metadata_never_index"), "", {
        mode: 0o600,
      });
      // Exclude from Spotlight via mdutil (may require elevated privileges).
      try {
        execSync(`/usr/bin/mdutil -i off "${dir}" 2>/dev/null`, {
          stdio: "ignore",
          timeout: 3000,
        });
      } catch {
        /* best-effort */
      }
      // Exclude from Time Machine via xattr.
      try {
        execSync(
          `/usr/bin/xattr -w com.apple.metadata:com_apple_backup_excludeItem com.apple.backupd "${dir}"`,
          { stdio: "ignore", timeout: 3000 },
        );
      } catch {
        /* best-effort */
      }
    } else if (process.platform === "win32") {
      // Set NOT_CONTENT_INDEXED on the directory *and* propagate to children.
      try {
        execSync(`attrib +I "${dir}" /S /D`, {
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {
        /* best-effort */
      }
    } else {
      // Linux: create markers for multiple indexers.
      // Tracker 3 (GNOME): .trackerignore in the dir
      fs.writeFileSync(path.join(dir, ".trackerignore"), "", {
        mode: 0o600,
      });
      // Baloo (KDE): .noindex
      fs.writeFileSync(path.join(dir, ".noindex"), "", { mode: 0o600 });
      // General: .hidden hides from some file managers
      fs.writeFileSync(path.join(dir, ".hidden"), "", { mode: 0o600 });
    }
  } catch {
    /* strictly best-effort — never fail an open because indexing suppression failed */
  }
}

// ---------------------------------------------------------------------------
// 3. Filesystem-timestamp scrubbing
// ---------------------------------------------------------------------------

/**
 * Reset the atime/mtime of a file to the Unix epoch (1970-01-01).
 * This prevents the `.vault` file from leaking when it was last modified.
 * Best-effort: never throws.
 */
export function scrubTimestamps(filePath: string): void {
  try {
    const epoch = new Date(0);
    fs.utimesSync(filePath, epoch, epoch);
  } catch {
    /* best-effort — NFS mounts or permission issues may block this */
  }
}

/**
 * Reset atime/mtime on all files inside a directory (recursive).
 */
export function scrubTimestampsRecursive(dir: string): void {
  try {
    scrubTimestamps(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scrubTimestampsRecursive(abs);
      } else {
        scrubTimestamps(abs);
      }
    }
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// 4. Secure erasure
// ---------------------------------------------------------------------------

/**
 * Overwrite a regular file's bytes with random data (one or more passes), then
 * unlink it.
 *
 * SECURITY: this MUST NOT follow symlinks. `statSync`/`openSync` both resolve
 * links, so erasing a symlink named `notes.txt` would overwrite the bytes of
 * whatever it points at — irreversibly destroying an unrelated file that was
 * never in the vault. A working directory is a real folder the user browses and
 * writes into, so it can legitimately contain a link they made themselves.
 * `lstat` identifies the entry itself: a link is unlinked (the link is the only
 * thing the vault's user created) and its target is left untouched.
 */
export function secureEraseFile(filePath: string, passes = 1): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      // Unlink the link itself. The target is not ours to destroy.
      fs.unlinkSync(filePath);
      return;
    }
    if (!stat.isFile()) return; // FIFOs, sockets, devices: nothing to overwrite
    const size = stat.size;
    if (size > 0) {
      const fd = fs.openSync(filePath, "r+");
      try {
        for (let p = 0; p < passes; p++) {
          const CHUNK = 1 << 20; // 1 MiB
          let written = 0;
          while (written < size) {
            const len = Math.min(CHUNK, size - written);
            fs.writeSync(fd, crypto.randomBytes(len), 0, len, written);
            written += len;
          }
          fs.fsyncSync(fd);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    /* fall through to unlink */
  }
  fs.rmSync(filePath, { force: true });
}

/**
 * Recursively secure-erase every regular file in a directory, then remove it.
 *
 * Uses `readdirSync(..., { withFileTypes: true })` and `entry.isDirectory()`,
 * which are lstat-based and therefore do not resolve symlinks — a link to a
 * directory is unlinked rather than recursed into, so erasing a working folder
 * can never walk out of it into the user's real files.
 *
 * A child that vanishes mid-walk (another process, or the user) must not abort
 * the erase: the remaining files would stay on disk in cleartext. Individual
 * failures are therefore swallowed and the walk continues; only the final
 * removal of `dir` is reported.
 */
export function secureEraseDir(dir: string, passes = 1): void {
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(dir)) return;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        secureEraseDir(abs, passes);
      } else if (entry.isSymbolicLink()) {
        // Never follow: remove just the link.
        fs.rmSync(abs, { force: true });
      } else {
        secureEraseFile(abs, passes);
      }
    } catch {
      /* keep erasing the rest — a partial wipe is worse than a noisy one */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. Copying (symlink-safe)
// ---------------------------------------------------------------------------

/**
 * Recursively copy `src` directory into `dest`, skipping symlinks and special
 * files at every level of the tree. Returns the number of symlinks skipped.
 * Using lstatSync (not statSync) so symlinks are never silently followed —
 * consistent with packDir/walk. Unlike fs.cpSync with { recursive: true },
 * this never follows symlinks inside the directory tree.
 */
function copyDirNoSymlinks(src: string, dest: string): number {
  fs.mkdirSync(dest, { recursive: true });
  let skipped = 0;
  for (const name of fs.readdirSync(src)) {
    const srcChild = path.join(src, name);
    const destChild = path.join(dest, name);
    // lstat: a link is skipped rather than resolved, so a symlink cannot cause
    // a read (or a write) outside `src`.
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(srcChild);
    } catch {
      // Vanished between readdir and lstat (the user is still editing). Not
      // worth failing the whole add over.
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped++;
    } else if (stat.isDirectory()) {
      skipped += copyDirNoSymlinks(srcChild, destChild);
    } else if (stat.isFile()) {
      fs.copyFileSync(srcChild, destChild);
    }
    // block devices, FIFOs, sockets — intentionally skipped
  }
  return skipped;
}

/**
 * Copy a file or directory tree into destDir (used for drag-and-drop adds).
 * Uses lstatSync (not statSync) so symlinks are never silently followed.
 * A top-level symlink is rejected with an explicit error. Symlinks nested
 * inside a directory are silently skipped (consistent with packDir/walk).
 * Returns { skipped } — the number of nested symlinks that were dropped.
 */
export function copyInto(src: string, destDir: string): { skipped: number } {
  const stat = fs.lstatSync(src); // lstat: inspect the link itself, not target
  if (stat.isSymbolicLink()) {
    throw new Error(`Symlinks cannot be added to a vault: ${src}`);
  }
  const target = path.join(destDir, path.basename(src));
  let skipped = 0;
  if (stat.isDirectory()) {
    skipped = copyDirNoSymlinks(src, target);
  } else if (stat.isFile()) {
    fs.copyFileSync(src, target);
  }
  return { skipped };
}
