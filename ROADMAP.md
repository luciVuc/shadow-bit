# ShadowBit — Project Roadmap

> Last updated: 2026-09-16 — comprehensive analysis, bug fixes, security hardening, UX overhaul, monetization  
> App version: **1.0.0** (`package.json`) · container format: **v3** (`CURRENT_VERSION`)  
> These are unrelated numbers; both appear as "Version" in `vault info` vs `--version`.  
> Stack: TypeScript · Node.js · Electron 44 · AES-256-GCM / ChaCha20-Poly1305  
> See also: `ANALYSIS_REPORT.md` (full audit), `SECURITY_AUDIT.md` (crypto audit)

---

## ⚠️ Status of this document — read first

This roadmap was written **before** much of the work it describes was done, and
the per-phase ✅/🔶/❌ markers below were never updated. Several phases marked
❌ "not started" are in fact **shipped and tested**. Do not use the markers as
a statement of current state.

Verified actual state as of the last commit:

| Phase                            | Roadmap says              | Reality                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12 — critical bug/security fixes | ❌ not started            | **Shipped.** `deleteVault` requires the password, `closeVault` has a TOCTOU header guard, `MIN_PASSWORD_LENGTH` is enforced in core, MEK buffers are zeroed, GUI quit-guard warns about open vaults. Covered by `src/test/core.test.ts`.                                                                                                                                                      |
| 13 — GUI a11y & responsiveness   | ❌ not started            | **Largely shipped.** ARIA tablist + arrow-key nav, recovery-modal ack gate, visible focus styles, light/dark/system theme, responsive layout.                                                                                                                                                                                                                                                 |
| 14 — worker thread & perf        | ❌ not started            | **Shipped.** `src/core/vault-worker.ts` + `src/gui/vault-worker-bridge.ts` move all heavy crypto off the Electron main thread. Sessions file locking shipped too.                                                                                                                                                                                                                             |
| 15 — GUI UX polish               | ❌ not started            | **Shipped.** Auto-lock timer, theme toggle, in-app file browser, drag-and-drop, window-state persistence, first-run onboarding.                                                                                                                                                                                                                                                               |
| 16 — CLI enhancements            | ❌ not started            | **Shipped.** `SHADOWBIT_PASSWORD` env var, `picocolors` output, `clean` command for orphan sessions.                                                                                                                                                                                                                                                                                          |
| 17 — advanced vault features     | ❌ not started            | **Partially shipped.** Payload compression and plaintext metadata **are** shipped. Streaming encryption and multi-user key slots are **not**.                                                                                                                                                                                                                                                 |
| 18 — distribution                | ❌ not started            | **Partially shipped.** `.github/workflows/release.yml` builds mac/win/linux and publishes a draft release. Code signing is **not** configured (secrets commented out).                                                                                                                                                                                                                        |
| 19 — extended testing            | ❌ not started            | **Largely shipped.** 232 tests: 99 core+CLI-unit, 36 CLI E2E (real subprocess), 26 GUI (Electron), 71 NFR (WCAG 2.2 AA, responsive XS–XL, perf, docs-site self-containment) — all in CI via `npm run verify`. Concurrency covered for the session registry and the local machine key. Large-vault (>1.5 GiB) coverage is **not** covered.                                                     |
| 20 — docs & monetization         | ❌ not started            | **Partially shipped.** `docs/` marketing site exists. Monetization (licensing, pricing) is **not** started.                                                                                                                                                                                                                                                                                   |
| 21 — adversarial hardening       | ❌ _(summary table only)_ | **Shipped (7/7)** — the section below marks it complete; the summary table is stale.                                                                                                                                                                                                                                                                                                          |
| 22 — competitive gap closing     | _(absent)_                | **Partially shipped (2/4).** Keyfiles and ChaCha20-Poly1305 are shipped and tested end to end. Indexing suppression is implemented and wired (`suppressIndexing`, called on the plaintext dir in `makeWorkingDir` in `sessions.ts`) but is best-effort and platform-dependent. **Hidden volumes and duress are NOT shipped** — `src/core/hidden.ts` has library tests but no CLI or GUI path. |

The phase sections below are kept as a **design record** of what was specified
and why. Where they disagree with the table above, the table above is correct.

Still genuinely open: streaming encryption (>1.5 GiB), OS keychain for the local
machine key, code signing, GUI E2E coverage beyond smoke, licensing/monetization,
and the concurrency/session-locking gaps noted in `SECURITY.md`.

**Hidden volumes and steganography are not part of that list because they are not
open work that is nearly done — they are unreachable.** `src/core/hidden.ts` and
`src/core/stego.ts` are implemented and unit-tested, but nothing in `src/cli/` or
`src/gui/` imports them, so no user can reach them. Do not read the ✅ markers on
section 21.3 as a shipping claim. Any future work here means building the command
and GUI surfaces, not just finishing the crypto.

Corrections made since the table above was first written:

- **Keyfile forwarding fixed** (`63a3087`). `delete`, `shred`, `change-password`
  and `recovery-key` were dropping the `keyfiles` argument, which made a
  keyfile vault impossible to delete, shred, or re-password — `effectivePassword()`
  throws rather than falling back. All four now accept `--keyfile` in the CLI and a
  keyfile picker in the GUI.
- **`changePassword` could brick a vault.** Re-wrapping under a bare password
  while `keyfileRequired` stayed set produced a header demanding a keyfile the new
  wrap never used: unopenable both with and without one. `newKeyfiles` now defaults
  to the current keyfile set; dropping the requirement needs an explicit empty
  array.
- **Local machine key race fixed twice.** The `O_EXCL` claim added in `e5448c9`
  treated a peer's _in-flight_ zero-length claim as corruption and overwrote it,
  re-splitting the keys under load. `getLocalKey()` now waits out the in-flight
  window, recovers only genuinely stale claims, and reads back from disk after
  writing so a claimant adopts whatever actually won. Regression test covers the
  zero-length window directly.

---

## Legend

| Symbol | Meaning                             |
| ------ | ----------------------------------- |
| ✅     | Complete and tested                 |
| 🔶     | Partially done — works but has gaps |
| ❌     | Not started                         |

> The markers below are historical and may be out of date — see the table above.

---

## Phase 1 — Core Engine `src/core/` ✅ Complete

The cryptographic core is the heart of the project. It is fully implemented,
dependency-free (uses only Node's built-in `crypto` module), and thoroughly
tested.

### Container format (`container.ts`) ✅

- Binary `.vault` file format with magic bytes `SHDBIT\0\1`
- Plaintext JSON header (KDF params, salt, wrapped keys, IV/tag)
- Encrypted payload appended directly after the header
- Self-contained: a vault file holds everything needed to decrypt it
  except the password — no external registry or side files

### Cryptography (`crypto.ts`) ✅

- **AES-256-GCM** for all encryption (authenticated — detects tampering)
- **scrypt** key derivation (N=131072 / 2¹⁷, r=8, p=1) with per-vault random salt
- **Envelope MEK** — a random 256-bit Master Encryption Key encrypts the
  payload; the MEK is itself wrapped by the password-derived key
  → changing the password re-wraps only the MEK (instant), never the files
- **Recovery key** — a second independent wrapping of the MEK using a
  high-entropy human-readable key (Crockford Base32, 200 bits of entropy,
  grouped as `XXXXX-XXXXX-…`)
- Per-vault random IV; GCM auth tag stored in the header

### Bundle format (`bundle.ts`) ✅

- Dependency-free archive: `[MANIFEST_LEN 4B][JSON manifest][raw file bytes…]`
- Preserves directory structure, file modes, and nested folders
- Path-traversal guard on unpack

### Vault operations (`vault.ts`) ✅

| Operation                                          | Status |
| -------------------------------------------------- | ------ |
| `createVault`                                      | ✅     |
| `openVault` (decrypt → temp dir)                   | ✅     |
| `closeVault` (re-pack → re-encrypt → write)        | ✅     |
| `discardVault` (wipe temp dir, no save)            | ✅     |
| `addToSession` (copy files into open vault)        | ✅     |
| `changePassword` (re-wrap MEK only)                | ✅     |
| `recoverVault` (recovery key → new password)       | ✅     |
| `regenerateRecoveryKey`                            | ✅     |
| `removeRecoveryKey`                                | ✅     |
| `deleteVault` (plain remove)                       | ✅     |
| `deleteVault` with `shred` (overwrite bytes first) | ✅     |
| `getInfo` (read metadata without decrypting)       | ✅     |

### Session registry (`sessions.ts`) ✅

- Tracks open vaults in `~/.shadow-bit/sessions.json`
- Stores only paths and timestamps — never keys or passwords
- Survives process restarts (sessions survive crashes until explicitly closed)

### Filesystem utilities (`fsutil.ts`) ✅

- Secure-erase helper (overwrite with random bytes → fsync → unlink)
- Directory secure-erase (recursive)
- `copyInto` helper for adding files to an open session

---

## Phase 2 — CLI `src/cli/` ✅ Complete

All commands are implemented and working. The table below is the command list as it stood
when this was written; it lists 12 of the **14** commands that now exist and omits
several flags added since. `meta` and `clean` are missing from it, and every
command that authenticates against a vault now also takes `--keyfile`. For the
current surface, run `shadow-bit --help` or read `QUICKSTART.md`.

### Commands ✅

| Command                  | Flags                                                         | Status |
| ------------------------ | ------------------------------------------------------------- | ------ |
| `create <name>`          | `--password`, `--no-recovery`, `--seed <dir>`                 | ✅     |
| `open <name>`            | `--password`                                                  | ✅     |
| `close <name>`           | `--password`                                                  | ✅     |
| `discard <name>`         | `--password`                                                  | ✅     |
| `add <name> <files…>`    | —                                                             | ✅     |
| `info <name>`            | —                                                             | ✅     |
| `list`                   | —                                                             | ✅     |
| `change-password <name>` | `--password`, `--new-password`                                | ✅     |
| `delete <name>`          | `--shred`, `--passes <n>`, `-y`                               | ✅     |
| `shred <name>`           | `--passes <n>`, `-y`                                          | ✅     |
| `recover <name>`         | `--recovery-key`, `--new-password`                            | ✅     |
| `recovery-key <name>`    | `--password`, `--remove`, `--upgrade`, `--recovery-key <key>` | ✅     |

### Prompts (`prompts.ts`) ✅

- Hidden password input (raw TTY, masking with `*`)
- Backspace support, Ctrl-C handler
- `promptNewPassword` (prompt + confirm)
- `confirm` (yes/no)
- Piped (non-TTY) stdin fallback for scripting

---

## Phase 3 — Electron GUI `src/gui/` 🔶 Implemented, not interactively tested

### Implemented ✅

| Tab             | Features                                                               |
| --------------- | ---------------------------------------------------------------------- |
| **Open**        | Browse, password, open, auto-reveals working folder, recent vaults     |
| **Create**      | Browse, password + confirm, seed folder, recovery toggle, modal + copy |
| **Manage**      | Browse, info, change password, recover, regen/remove recovery, delete  |
| **Open Vaults** | Sessions list, drag-and-drop, Add Files, Open Folder, Close, Discard   |

- Toast notifications (success / error) ✅
- Recovery key modal with acknowledgment checkbox + copy ✅
- Secure context bridge (contextIsolation, sandbox, no nodeIntegration) ✅
- Content-Security-Policy ✅
- Navigation guards (will-navigate, setWindowOpenHandler) ✅
- Loading overlay during slow ops ✅
- Password strength indicator (Create + Change Password) ✅
- HTML-escaped vault paths (XSS prevention) ✅

---

## Phase 4 — App Icon ✅ Complete

- Procedurally generated padlock icon (pure-Node PNG encoder)
- Outputs: `build/icon.png`, `build/icon.ico`, `build/icon.icns`

---

## Phase 5 — Packaging 🔶 macOS verified; Windows & Linux untested

- macOS ✅ · Windows 🔶 (untested) · Linux 🔶 (untested) · Code signing ❌

---

## Phase 6 — Testing ✅ (232 tests across 7 runners)

- `src/test/core.test.ts` — security-focused core tests ✅ (89)
- `src/test/cli.test.ts` — CLI integration tests ✅ (10)
- `e2e/cli.test.ts` — real-subprocess CLI option matrix ✅ (36)
- `e2e/smoke.test.ts` — GUI smoke tests ✅ (26, run in CI)
- `e2e/nfr.*.test.ts` — WCAG 2.2 AA, responsive, perf, docs-site ✅ (71)

---

## Phase 7 — CI / CD 🔶 CI ✅ · release/CD pending

- `.github/workflows/ci.yml` — `npm ci` + `npm run build` + `npm test`, Node 20/22 ✅
- Release workflow (tag → build → publish) ❌

---

## Phases 8–9 — Quality of Life + Advanced Features ❌ Mostly not started

See items below folded into Phase 12+.

---

## Phase 10 — Security Hardening & Audit ✅ All shipped

All C1–C4, H1–H4, M1–M6, L1–L10 findings implemented and tested.

---

## Phase 11 — Post-Analysis Robustness & UX Polish ✅ All shipped

All P1–P8 findings implemented and tested. 27 tests total.

---

---

# Phase 12 — Critical Bug Fixes & Security Hardening ❌

> **Priority: 🔴 CRITICAL — must ship before any public release**
> **Estimated effort: 2–3 days**

Every item in this phase addresses a confirmed bug or security gap that could
cause data loss, unauthorized access, or violates a consistency guarantee the
rest of the codebase relies on.

---

### 12.1 `deleteVault` must require the password ❌

**Ref:** B1 in `ANALYSIS_REPORT.md`
**Severity:** 🔴 Critical — inconsistent with `discardVault` which requires auth
**Files:** `src/core/vault.ts` (`deleteVault`), `src/cli/index.ts`, `src/gui/main.ts`, `src/gui/preload.ts`, `src/gui/renderer/renderer.js`, `src/gui/renderer/index.html`

**Problem:** `deleteVault()` calls `readHeader(abs)` (validates it's a vault)
but never verifies the password. Any local user can permanently destroy a vault
without authentication. `discardVault()` already requires the password, so this
is an inconsistency that users — and attackers — will notice.

**Specification:**

- `deleteVault(vaultPath, password, opts)` — add `password: string` as the
  second parameter (breaking change to the core API signature).
- The function must call `unwrapMekWithPassword(header, password)` before
  proceeding. If the password is wrong, throw `WrongCredentialError` and do
  NOT delete anything.
- If the vault file is already gone (`!fs.existsSync(abs)`), fall through to
  session/working-dir cleanup only (same pattern as `discardVault`).

**Implementation steps:**

1. **`src/core/vault.ts`** — change the signature:

   ```ts
   export function deleteVault(
     vaultPath: string,
     password: string,
     opts: { shred?: boolean; passes?: number } = {},
   ): void {
     const abs = path.resolve(vaultPath);
     if (!fs.existsSync(abs)) {
       throw new Error(`Vault not found: ${abs}`);
     }
     const { header, payload: _ } = readContainer(abs);
     unwrapMekWithPassword(header, password); // ← NEW: throws on wrong pw
     // ...rest unchanged
   }
   ```

   Use `readHeader(abs)` + `unwrapMekWithPassword` (don't need the payload).

2. **`src/cli/index.ts`** — add `--password` option to `delete` and `shred`:

   ```ts
   .option("--password <pwd>", "password (omit for a hidden prompt)")
   ```

   In `runDelete()`, prompt for the password:

   ```ts
   const password = opts.password || (await promptHidden("Password: "));
   deleteVault(vaultPath, password, { shred, passes });
   ```

3. **`src/gui/main.ts`** — update the IPC handler:

   ```ts
   ipcMain.handle("vault:delete", (_e, args) =>
     wrap(() => {
       deleteVault(args.vaultPath, args.password, { shred: !!args.shred });
       removeRecentVault(args.vaultPath);
     }),
   );
   ```

4. **`src/gui/preload.ts`** — no change needed (already passes `args`).

5. **`src/gui/renderer/index.html`** — add a password input inside the
   `.danger-card`, above the "Delete Vault" button:

   ```html
   <input id="del-pass" type="password" placeholder="Password" />
   ```

6. **`src/gui/renderer/renderer.js`** — in the `del-go` onclick, read and
   pass `$("del-pass").value` as `password`:

   ```js
   const password = $("del-pass").value;
   if (!password) return err("Enter the password to delete.");
   // ...
   result(await api.deleteVault({ vaultPath, password, shred }));
   // clear after:
   $("del-pass").value = "";
   ```

7. **`src/test/core.test.ts`** — add test:

   ```ts
   test("deleteVault requires the correct password (B1)", () => {
     const vp = tmpVault("delete-auth");
     vault.createVault(vp, { password: PASS, generateRecovery: false });
     assert.throws(
       () => vault.deleteVault(vp, "wrong-password"),
       vault.WrongCredentialError,
     );
     assert.ok(fs.existsSync(vp)); // still there
     assert.doesNotThrow(() => vault.deleteVault(vp, PASS));
     assert.equal(fs.existsSync(vp), false);
   });
   ```

8. **`src/test/cli.test.ts`** — add CLI test covering `delete --password`.

9. **`AGENTS.md`** — update the `deleteVault` signature documentation.

---

### 12.2 Recursive symlink rejection in `copyInto` ❌

**Ref:** B2 in `ANALYSIS_REPORT.md`
**Severity:** 🔴 Critical — symlinks inside a copied directory are silently followed
**Files:** `src/core/fsutil.ts` (`copyInto` / `copyDirNoSymlinks`)

**Problem:** `copyInto` rejects symlinks at the top level (`lstatSync` check),
but when `src` is a directory, it uses `fs.cpSync(src, target, { recursive: true })`
which silently follows symlinks deep inside the tree. This is inconsistent with
`packDir/walk` (which skips symlinks) and can expose or duplicate files from
outside the vault.

**Specification:**

- When copying a directory recursively, the copy must NOT follow or include
  symlinks at any depth.
- Symlinks should be silently skipped (matching `packDir/walk` behavior), OR
  rejected with an error listing the offending path.
- Decision: **silently skip** (consistent with `packDir/walk`, documented in
  `AGENTS.md`). If any symlinks were skipped, return a count so the caller can
  warn the user.

**Implementation steps:**

1. **`src/core/fsutil.ts`** — replace the `fs.cpSync` call in `copyInto`
   with a recursive copy that uses `lstatSync` and skips symlinks:

   ```ts
   /** Recursively copy a directory, skipping symlinks at every level.
    *  Returns the number of symlinks that were silently skipped. */
   function copyDirNoSymlinks(src: string, dest: string): number {
     fs.mkdirSync(dest, { recursive: true });
     let skipped = 0;
     for (const name of fs.readdirSync(src)) {
       const srcChild = path.join(src, name);
       const destChild = path.join(dest, name);
       const stat = fs.lstatSync(srcChild);
       if (stat.isSymbolicLink()) {
         skipped++;
       } else if (stat.isDirectory()) {
         skipped += copyDirNoSymlinks(srcChild, destChild);
       } else if (stat.isFile()) {
         fs.copyFileSync(srcChild, destChild);
       }
       // special files (sockets, pipes, etc.) are silently skipped
     }
     return skipped;
   }

   export function copyInto(src: string, destDir: string): { skipped: number } {
     const stat = fs.lstatSync(src);
     if (stat.isSymbolicLink()) {
       throw new Error(`Symlinks cannot be added to a vault: ${src}`);
     }
     const target = path.join(destDir, path.basename(src));
     let skipped = 0;
     if (stat.isDirectory()) {
       skipped = copyDirNoSymlinks(src, target);
     } else {
       fs.copyFileSync(src, target);
     }
     return { skipped };
   }
   ```

2. **`src/core/vault.ts`** — update `addToSession` to collect and surface
   skip counts:

   ```ts
   export function addToSession(
     vaultPath: string,
     srcPaths: string[],
   ): { count: number; symlinksSkipped: number } {
     // ...
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
   ```

3. **CLI + GUI callers** — if `symlinksSkipped > 0`, show a warning:
   `"⚠ ${n} symlink(s) were skipped (symlinks cannot be stored in vaults)."`

4. **Tests** — add a test that creates a directory containing a nested symlink,
   calls `copyInto`, and verifies the symlink was skipped (not copied) while
   the regular files were copied:
   ```ts
   test("copyInto skips nested symlinks inside directories (B2)", async () => {
     const fsutilMod = await import("../core/fsutil");
     const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-nested-sym-"));
     const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-nested-dst-"));
     const subdir = path.join(srcDir, "sub");
     fs.mkdirSync(subdir);
     fs.writeFileSync(path.join(subdir, "real.txt"), "hello");
     try {
       fs.symlinkSync(
         path.join(subdir, "real.txt"),
         path.join(subdir, "link.txt"),
       );
     } catch {
       return;
     } // skip if symlinks not supported
     const { skipped } = fsutilMod.copyInto(srcDir, destDir);
     assert.equal(skipped, 1);
     assert.ok(
       fs.existsSync(
         path.join(destDir, path.basename(srcDir), "sub", "real.txt"),
       ),
     );
     assert.equal(
       fs.existsSync(
         path.join(destDir, path.basename(srcDir), "sub", "link.txt"),
       ),
       false,
     );
     fs.rmSync(srcDir, { recursive: true, force: true });
     fs.rmSync(destDir, { recursive: true, force: true });
   });
   ```

---

### 12.3 Zero MEK buffer after use ❌

**Ref:** S2 in `ANALYSIS_REPORT.md`
**Severity:** 🔴 Critical — decrypted key material lingers in heap
**Files:** `src/core/vault.ts` (every function that calls `unwrapMekWithPassword`
or `unwrapMekWithRecovery`)

**Problem:** The MEK is a `Buffer` returned by `decryptGCM`. After it's used to
encrypt/decrypt the payload, the buffer is abandoned to garbage collection. A
heap dump, core dump, or Electron crash report taken while the vault is open
would expose the MEK. Since the MEK never changes (only re-wrapping changes),
a leaked MEK compromises the vault permanently.

**Specification:**

- Every function that unwraps the MEK must zero it in a `finally` block
  after use: `mek.fill(0)`.
- This is defense-in-depth (JavaScript GC provides no hard timing guarantees),
  but it drastically reduces the window of exposure.

**Implementation steps:**

1. **`src/core/vault.ts`** — wrap every MEK usage in try/finally. There are
   **9 functions** that unwrap the MEK. Apply the pattern to each:

   ```ts
   // openVault — lines ~196–213
   export function openVault(vaultPath: string, password: string): OpenResult {
     const abs = path.resolve(vaultPath);
     const { header, payload } = readContainer(abs);
     const mek = unwrapMekWithPassword(header, password);
     try {
       const existing = findSession(abs);
       if (existing && fs.existsSync(existing.workingDir)) {
         return { vaultPath: abs, workingDir: existing.workingDir };
       }
       let plaintext: Buffer;
       try {
         plaintext = decryptPayload(
           mek,
           header.payloadIv,
           header.payloadTag,
           payload,
         );
       } catch {
         throw new WrongCredentialError();
       }
       const workingDir = makeWorkingDir(abs);
       unpackDir(plaintext, workingDir);
       addSession({
         vaultPath: abs,
         workingDir,
         openedAt: new Date().toISOString(),
       });
       return { vaultPath: abs, workingDir };
     } finally {
       mek.fill(0);
     }
   }
   ```

   Apply the same `try { ... } finally { mek.fill(0); }` pattern to:
   - `closeVault` (line ~232)
   - `discardVault` (line ~261 — if vault exists; MEK from `unwrapMekWithPassword`)
   - `changePassword` (line ~340)
   - `recoverVault` (line ~367)
   - `regenerateRecoveryKey` (line ~392)
   - `removeRecoveryKey` (line ~424)
   - `upgradeRecoveryEscrow` (line ~443)
   - `deleteVault` (after 12.1 adds the password check)

2. **Helper approach** — alternatively, add a `withMek` utility to reduce
   repetition:

   ```ts
   function withMek<T>(mek: Buffer, fn: (mek: Buffer) => T): T {
     try {
       return fn(mek);
     } finally {
       mek.fill(0);
     }
   }
   ```

3. **Tests** — add a test that verifies the MEK buffer is zeroed after
   `openVault` returns:
   ```ts
   test("MEK is zeroed after openVault returns (S2)", () => {
     // We can't directly inspect the MEK, but we can verify the pattern
     // works by testing that a manually created buffer is zeroed by fill(0).
     const buf = Buffer.from("secret-key-material-here!!");
     buf.fill(0);
     assert.ok(buf.every((b) => b === 0));
   });
   ```
   (The real verification is code review, not a unit test — add the test to
   confirm the `fill(0)` approach works, then verify by inspection that every
   `unwrapMek*` call site has the `finally` block.)

---

### 12.4 Clear clipboard after recovery key copy ❌

**Ref:** S4 in `ANALYSIS_REPORT.md`
**Severity:** 🔴 Critical — recovery key persists in system clipboard indefinitely
**Files:** `src/gui/main.ts` (`sys:copySecret`), `src/gui/preload.ts`, `src/gui/renderer/renderer.js`

**Problem:** When the user clicks "Copy" on the recovery key modal, the key is
written to the system clipboard via `clipboard.writeText(text)`. It stays there
until the user copies something else. Any application with clipboard access
(which is most apps) can read it.

**Specification:**

- After a recovery key is copied, start a 30-second timer.
- When the timer fires, check if the clipboard still contains the recovery key.
  If so, clear it. If the user has copied something else in the meantime, do
  nothing (don't destroy unrelated clipboard content).
- Show a toast: "Recovery key will be cleared from clipboard in 30 seconds."

**Implementation steps:**

1. **`src/gui/main.ts`** — add a new IPC handler:

   ```ts
   let clipboardClearTimer: ReturnType<typeof setTimeout> | null = null;

   ipcMain.handle("sys:copySecret", (_e, text: string) => {
     clipboard.writeText(text);
     // Clear any previous timer
     if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
     clipboardClearTimer = setTimeout(() => {
       // Only clear if clipboard still holds our secret
       if (clipboard.readText() === text) {
         clipboard.writeText("");
       }
       clipboardClearTimer = null;
     }, 30_000);
   });
   ```

2. **`src/gui/preload.ts`** — add the new method:

   ```ts
   copySecret: (text: string) => ipcRenderer.invoke("sys:copySecret", text),
   ```

3. **`src/gui/renderer/renderer.js`** — in `showRecoveryModal`, use
   `api.copySecret(key)` instead of `api.copy(key)`:

   ```js
   $("modal-copy").onclick = () => {
     api.copySecret(key);
     ok("Recovery key copied. Clipboard will be cleared in 30 seconds.");
   };
   ```

4. **Also clear on modal dismiss** — when the user clicks "I've saved it",
   proactively clear the clipboard if it still holds the key:
   ```js
   okBtn.onclick = () => {
     if (!ackCheck.checked) return;
     // Best-effort: clear clipboard if it still has the key
     api.copy("");
     $("modal").classList.add("hidden");
   };
   ```

---

### 12.5 Warn on quit with open vaults ❌

**Ref:** End-user analysis in `ANALYSIS_REPORT.md`
**Severity:** 🔴 Critical — plaintext persists in temp indefinitely after quit
**Files:** `src/gui/main.ts`

**Problem:** If the user quits the Electron app while vaults are open, the
decrypted working directories remain in the OS temp folder. There is no
warning, and on next launch the session file still lists them as "open". The
plaintext just sits there unprotected.

**Specification:**

- Before the app quits, check `loadSessions()`.
- If any sessions exist with an existing `workingDir`, show a blocking dialog:
  "You have N open vault(s). Quitting will leave decrypted files in temporary
  folders. Close them first, or click Quit Anyway."
- Buttons: "Go Back" (cancel quit), "Quit Anyway" (proceed).
- On macOS, also handle `Cmd+Q` and the dock "Quit" context menu.

**Implementation steps:**

1. **`src/gui/main.ts`** — add the `before-quit` handler after `createWindow()`:

   ```ts
   let allowQuit = false;

   app.on("before-quit", async (event) => {
     if (allowQuit || IS_E2E) return; // already confirmed, or in test mode
     const sessions = loadSessions().filter((s) => fs.existsSync(s.workingDir));
     if (sessions.length === 0) return; // nothing open, quit freely

     event.preventDefault();

     const win = BrowserWindow.getAllWindows()[0];
     if (!win) {
       allowQuit = true;
       app.quit();
       return;
     }

     const { response } = await dialog.showMessageBox(win, {
       type: "warning",
       buttons: ["Go Back", "Quit Anyway"],
       defaultId: 0,
       cancelId: 0,
       title: "Open Vaults",
       message: `You have ${sessions.length} open vault(s).`,
       detail:
         "Quitting will leave decrypted files in temporary folders. " +
         "Close or discard them first for safety.\n\n" +
         sessions.map((s) => `• ${path.basename(s.vaultPath)}`).join("\n"),
     });
     if (response === 1) {
       allowQuit = true;
       app.quit();
     }
   });
   ```

2. **Reset `allowQuit`** when all windows are closed but the app is not quitting
   (macOS dock reopen scenario):

   ```ts
   app.on("activate", () => {
     allowQuit = false; // reset if user reopens after dismissing quit
     if (BrowserWindow.getAllWindows().length === 0) createWindow();
   });
   ```

3. **E2E tests** — the `IS_E2E` bypass ensures GUI smoke tests don't hang on
   the dialog.

---

### 12.6 Vault integrity check before close (TOCTOU) ❌

**Ref:** S6 in `ANALYSIS_REPORT.md`
**Severity:** 🟠 High — vault file swap while open could cause data loss
**Files:** `src/core/vault.ts`, `src/core/sessions.ts`, `src/core/types.ts`

**Problem:** Between `openVault` and `closeVault`, the vault file could be
replaced by a different file (attacker, cloud sync, user accident). `closeVault`
reads the header from whatever file is at that path now, derives the MEK from
it, and re-encrypts the working directory under that (potentially foreign) MEK.
If the swap was an attacker's vault with a known password, the attacker now has
the user's plaintext encrypted under a key they know.

**Specification:**

- When opening a vault, compute a SHA-256 hash of the raw header bytes and
  store it in the session.
- Before closing, re-read the header, hash it, and compare. If the hashes
  don't match, throw an error: "The vault file has been modified since it was
  opened. Re-open it first."
- The hash covers the raw header JSON bytes (before parsing), so any change
  to the header (including password changes while open) is detected.

**Implementation steps:**

1. **`src/core/types.ts`** — add `headerHash` to `VaultSession`:

   ```ts
   export interface VaultSession {
     vaultPath: string;
     workingDir: string;
     openedAt: string;
     headerHash?: string; // SHA-256 hex of raw header bytes at open time
   }
   ```

2. **`src/core/container.ts`** — add a `readHeaderRaw` function that returns
   both the parsed header and its raw bytes:

   ```ts
   export function readHeaderRaw(filePath: string): {
     header: VaultHeader;
     rawBytes: Buffer;
   } {
     const fd = fs.openSync(filePath, "r");
     try {
       // ...same fd-based read as readHeader...
       const headerBuf = Buffer.alloc(headerLen);
       fs.readSync(fd, headerBuf, 0, headerLen, MAGIC.length + 4);
       return { header: parseHeader(headerBuf), rawBytes: headerBuf };
     } finally {
       fs.closeSync(fd);
     }
   }
   ```

3. **`src/core/vault.ts`** — in `openVault`, compute and store the hash:

   ```ts
   import * as crypto from "crypto";
   import { readHeaderRaw } from "./container";

   // in openVault:
   const { header, rawBytes } = readHeaderRaw(abs);
   // after readContainer for payload...
   const headerHash = crypto
     .createHash("sha256")
     .update(rawBytes)
     .digest("hex");
   addSession({
     vaultPath: abs,
     workingDir,
     openedAt: new Date().toISOString(),
     headerHash,
   });
   ```

4. **`src/core/vault.ts`** — in `closeVault`, verify the hash:

   ```ts
   const session = findSession(abs);
   if (!session) throw new Error("Vault is not open.");
   const { header: currentHeader, rawBytes: currentRaw } = readHeaderRaw(abs);
   if (session.headerHash) {
     const currentHash = crypto
       .createHash("sha256")
       .update(currentRaw)
       .digest("hex");
     if (currentHash !== session.headerHash) {
       throw new Error(
         "The vault file has been modified since it was opened. " +
           "Re-open the vault to pick up the current version before closing.",
       );
     }
   }
   ```

5. **Tests** — create vault, open, manually rewrite header (change password on
   disk), try to close → expect error.

---

### 12.7 Password validation in CLI `promptNewPassword` ❌

**Ref:** B5 in `ANALYSIS_REPORT.md`
**Severity:** 🟡 Medium — user types password twice before learning it's too short
**Files:** `src/cli/prompts.ts` (`promptNewPassword`)

**Implementation steps:**

1. **`src/cli/prompts.ts`** — import `MIN_PASSWORD_LENGTH` and check after
   the first prompt, BEFORE asking to confirm:
   ```ts
   import { MIN_PASSWORD_LENGTH } from "../core/vault";

   export async function promptNewPassword(
     label = "password",
   ): Promise<string> {
     const pwd = await promptHidden(`Set ${label}: `);
     if (!pwd) throw new Error("Password cannot be empty.");
     if (pwd.length < MIN_PASSWORD_LENGTH) {
       throw new Error(
         `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
       );
     }
     const confirm = await promptHidden(`Confirm ${label}: `);
     if (pwd !== confirm) throw new Error("Passwords do not match.");
     return pwd;
   }
   ```

---

### 12.8 Password length validation in GUI before submit ❌

**Ref:** B6 in `ANALYSIS_REPORT.md`
**Severity:** 🟡 Medium — user gets generic error toast instead of inline feedback
**Files:** `src/gui/renderer/renderer.js`

**Implementation steps:**

1. **`src/gui/renderer/renderer.js`** — add a constant and validation in both
   the create and change-password handlers:
   ```js
   const MIN_PASSWORD_LENGTH = 8;

   // In create-go onclick:
   if (password.length < MIN_PASSWORD_LENGTH)
     return err(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

   // In cp-go onclick:
   if (newPassword.length < MIN_PASSWORD_LENGTH)
     return err(
       `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
     );

   // In rec-go onclick:
   if (newPassword.length < MIN_PASSWORD_LENGTH)
     return err(
       `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
     );
   ```

---

## Phase 12 Tests ❌

Add regression tests for every item in Phase 12. Minimum new tests:

| Test                                                           | Validates           |
| -------------------------------------------------------------- | ------------------- |
| `deleteVault requires correct password`                        | 12.1                |
| `deleteVault with wrong password leaves vault intact`          | 12.1                |
| `copyInto skips nested symlinks`                               | 12.2                |
| `MEK buffer is zeroed after use`                               | 12.3 (pattern test) |
| `closeVault rejects when header changed on disk`               | 12.6                |
| `CLI promptNewPassword rejects short passwords before confirm` | 12.7                |

---

---

# Phase 13 — GUI Accessibility & Responsiveness ❌

> **Priority: 🟠 HIGH — blocks accessibility compliance**
> **Target: ship with Phase 12**
> **Estimated effort: 2–3 days**

---

### 13.1 ARIA attributes for tab navigation ❌

**Ref:** Accessibility analysis in `ANALYSIS_REPORT.md`
**Severity:** 🟠 High
**Files:** `src/gui/renderer/index.html`, `src/gui/renderer/renderer.js`

**Problem:** The tab buttons have no `role="tab"`, the panels no
`role="tabpanel"`, no `aria-selected`, no `aria-controls`. Screen readers
(VoiceOver, NVDA, JAWS) can't navigate the tab structure.

**Specification:** Implement the
[WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/).

**Implementation steps:**

1. **`index.html`** — add ARIA attributes to the static markup:

   ```html
   <nav class="tabs" role="tablist" aria-label="Vault operations">
     <button
       class="tab active"
       data-tab="open"
       role="tab"
       aria-selected="true"
       aria-controls="panel-open"
       id="tab-open"
     >
       Open
     </button>
     <button
       class="tab"
       data-tab="create"
       role="tab"
       aria-selected="false"
       aria-controls="panel-create"
       id="tab-create"
     >
       Create
     </button>
     <!-- same for manage, sessions -->
   </nav>
   ```

   And on each panel:

   ```html
   <section
     class="panel active"
     id="panel-open"
     role="tabpanel"
     aria-labelledby="tab-open"
     tabindex="0"
   ></section>
   ```

2. **`renderer.js`** — update the tab-switching logic:

   ```js
   document.querySelectorAll(".tab").forEach((tab) => {
     tab.addEventListener("click", () => {
       document.querySelectorAll(".tab").forEach((t) => {
         t.classList.remove("active");
         t.setAttribute("aria-selected", "false");
         t.setAttribute("tabindex", "-1");
       });
       document
         .querySelectorAll(".panel")
         .forEach((p) => p.classList.remove("active"));
       tab.classList.add("active");
       tab.setAttribute("aria-selected", "true");
       tab.setAttribute("tabindex", "0");
       const panel = $("panel-" + tab.dataset.tab);
       panel.classList.add("active");
       // ...existing refresh logic
     });
   });
   ```

3. **Keyboard navigation** — add arrow-key handling to the tablist:
   ```js
   const tabs = [...document.querySelectorAll(".tab")];
   document
     .querySelector('[role="tablist"]')
     .addEventListener("keydown", (e) => {
       const idx = tabs.indexOf(document.activeElement);
       if (idx < 0) return;
       let next = -1;
       if (e.key === "ArrowRight" || e.key === "ArrowDown") {
         next = (idx + 1) % tabs.length;
       } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
         next = (idx - 1 + tabs.length) % tabs.length;
       } else if (e.key === "Home") {
         next = 0;
       } else if (e.key === "End") {
         next = tabs.length - 1;
       }
       if (next >= 0) {
         e.preventDefault();
         tabs[next].focus();
         tabs[next].click();
       }
     });
   ```

---

### 13.2 Focus trap for recovery key modal ❌

**Severity:** 🟠 High
**Files:** `src/gui/renderer/renderer.js`

**Problem:** When the modal opens, keyboard focus is not constrained to it.
Users can Tab behind it to invisible elements.

**Implementation steps:**

1. Add a focus-trap utility (no dependency needed — ~30 lines):

   ```js
   function trapFocus(container) {
     const focusable = container.querySelectorAll(
       'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
     );
     if (!focusable.length) return () => {};
     const first = focusable[0];
     const last = focusable[focusable.length - 1];
     first.focus();
     const handler = (e) => {
       if (e.key !== "Tab") return;
       if (e.shiftKey && document.activeElement === first) {
         e.preventDefault();
         last.focus();
       } else if (!e.shiftKey && document.activeElement === last) {
         e.preventDefault();
         first.focus();
       }
     };
     container.addEventListener("keydown", handler);
     return () => container.removeEventListener("keydown", handler);
   }
   ```

2. In `showRecoveryModal`:
   ```js
   let releaseTrap;
   function showRecoveryModal(key) {
     // ...existing setup...
     $("modal").classList.remove("hidden");
     releaseTrap = trapFocus($("modal-box"));
     // in okBtn.onclick:
     okBtn.onclick = () => {
       if (!ackCheck.checked) return;
       if (releaseTrap) releaseTrap();
       $("modal").classList.add("hidden");
     };
   }
   ```

---

### 13.3 Visible focus indicators ❌

**Severity:** 🟡 Medium
**Files:** `src/gui/renderer/styles.css`

**Implementation steps:**

Add to `styles.css`:

```css
/* Focus-visible — keyboard-only focus ring */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(91, 140, 255, 0.15);
}

.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  border-bottom-color: var(--accent);
}
```

---

### 13.4 Color contrast fix ❌

**Severity:** 🟡 Medium
**Files:** `src/gui/renderer/styles.css`

**Problem:** `--muted: #8b91a3` on `--bg: #0f1117` is ~4.8:1 contrast. Hint
text at 13px fails WCAG AA (requires 4.5:1 for normal text — borderline pass,
but "hint" class at 13px renders effectively as small text which needs 4.5:1).

**Implementation:** Lighten the muted color slightly:

```css
--muted: #9ba1b3; /* was #8b91a3 — now ~5.5:1 against #0f1117 */
```

---

### 13.5 Responsive layout ❌

**Severity:** 🟡 Medium
**Files:** `src/gui/renderer/styles.css`

**Problem:** No `@media` queries at all. The 620px max-width panel is too narrow
at 1440p+ and cramped at 640px minimum.

**Implementation steps:**

```css
/* Fluid panel width */
.panel {
  max-width: min(620px, 100% - 40px);
  margin: 0 auto;
}

/* Narrow windows: compact padding */
@media (max-width: 720px) {
  main {
    padding: 16px;
  }
  .topbar {
    padding: 12px 16px 0;
  }
  .brand h1 {
    font-size: 16px;
  }
  .tagline {
    display: none;
  }
  .tab {
    padding: 8px 10px;
    font-size: 13px;
  }
  .card {
    padding: 12px;
  }
  .session .actions {
    flex-direction: column;
  }
  .session .actions button {
    width: 100%;
  }
}

/* Wide windows: allow wider panels */
@media (min-width: 1200px) {
  .panel {
    max-width: 780px;
  }
}
```

---

### 13.6 Show/hide password toggle ❌

**Severity:** 🟡 Medium
**Files:** `src/gui/renderer/index.html`, `src/gui/renderer/renderer.js`, `src/gui/renderer/styles.css`

**Problem:** No way to verify what was typed in password fields.

**Implementation steps:**

1. **`styles.css`** — add toggle button styles:

   ```css
   .pw-wrapper {
     position: relative;
   }
   .pw-wrapper input {
     padding-right: 40px;
   }
   .pw-toggle {
     position: absolute;
     right: 8px;
     top: 50%;
     transform: translateY(-50%);
     background: none;
     border: none;
     color: var(--muted);
     cursor: pointer;
     font-size: 16px;
     padding: 4px;
   }
   .pw-toggle:hover {
     color: var(--text);
   }
   ```

2. **`index.html`** — wrap each password input in a `.pw-wrapper`:

   ```html
   <div class="pw-wrapper">
     <input id="open-password" type="password" placeholder="Password" />
     <button
       type="button"
       class="pw-toggle"
       data-target="open-password"
       aria-label="Show password"
     >
       👁
     </button>
   </div>
   ```

3. **`renderer.js`** — wire toggle behavior:
   ```js
   document.querySelectorAll(".pw-toggle").forEach((btn) => {
     btn.addEventListener("click", () => {
       const input = $(btn.dataset.target);
       const showing = input.type === "text";
       input.type = showing ? "password" : "text";
       btn.textContent = showing ? "👁" : "🙈";
       btn.setAttribute(
         "aria-label",
         showing ? "Show password" : "Hide password",
       );
     });
   });
   ```

---

---

# Phase 14 — Worker Thread & Performance ❌

> **Priority: 🟠 HIGH — blocks usability for vaults > 50 MB**
> **Estimated effort: 3–5 days**

---

### 14.1 Move vault operations to a worker thread ❌

**Ref:** Engineering analysis in `ANALYSIS_REPORT.md`
**Severity:** 🟠 High
**Files:** new `src/core/worker.ts`, `src/gui/main.ts`

**Problem:** `scryptSync`, `readFileSync`, `encryptPayload`, `decryptPayload`
all run synchronously on the Electron main process. For large vaults or slow
hardware, this blocks the event loop → UI freezes → macOS beach ball.

**Specification:**

- Vault operations invoked from the GUI run in a `worker_threads` Worker.
- The main thread sends a message `{ op: "open", args: {...} }` and awaits a
  response `{ ok: true, value: {...} }` or `{ ok: false, error: "..." }`.
- CLI can remain synchronous (single-threaded, no UI to block).
- Future: the worker can emit progress events for a progress bar.

**Implementation steps:**

1. **Create `src/core/worker.ts`** — a worker entry point:

   ```ts
   import { parentPort, workerData } from "worker_threads";
   // Import all vault operations
   import * as vault from "./vault";

   parentPort?.on("message", (msg) => {
     try {
       let result: unknown;
       switch (msg.op) {
         case "create":
           result = vault.createVault(msg.args.vaultPath, msg.args.opts);
           break;
         case "open":
           result = vault.openVault(msg.args.vaultPath, msg.args.password);
           break;
         case "close":
           vault.closeVault(msg.args.vaultPath, msg.args.password);
           result = null;
           break;
         case "discard":
           vault.discardVault(msg.args.vaultPath, msg.args.password);
           result = null;
           break;
         case "changePassword":
           vault.changePassword(
             msg.args.vaultPath,
             msg.args.oldPassword,
             msg.args.newPassword,
           );
           result = null;
           break;
         case "recover":
           vault.recoverVault(
             msg.args.vaultPath,
             msg.args.recoveryKey,
             msg.args.newPassword,
           );
           result = null;
           break;
         case "regenRecovery":
           result = vault.regenerateRecoveryKey(
             msg.args.vaultPath,
             msg.args.password,
           );
           break;
         case "removeRecovery":
           vault.removeRecoveryKey(msg.args.vaultPath, msg.args.password);
           result = null;
           break;
         case "delete":
           vault.deleteVault(
             msg.args.vaultPath,
             msg.args.password,
             msg.args.opts,
           );
           result = null;
           break;
         case "addFiles":
           result = vault.addToSession(msg.args.vaultPath, msg.args.paths);
           break;
         default:
           throw new Error(`Unknown worker op: ${msg.op}`);
       }
       parentPort?.postMessage({ id: msg.id, ok: true, value: result });
     } catch (e: any) {
       parentPort?.postMessage({ id: msg.id, ok: false, error: e.message });
     }
   });
   ```

2. **Create `src/gui/vault-worker-bridge.ts`** — used by `main.ts`:

   ```ts
   import { Worker } from "worker_threads";
   import * as path from "path";

   let nextId = 0;
   const pending = new Map<
     number,
     { resolve: (v: any) => void; reject: (e: Error) => void }
   >();
   let worker: Worker | null = null;

   function getWorker(): Worker {
     if (!worker) {
       worker = new Worker(path.join(__dirname, "..", "core", "worker.js"));
       worker.on("message", (msg) => {
         const p = pending.get(msg.id);
         if (!p) return;
         pending.delete(msg.id);
         if (msg.ok) p.resolve(msg.value);
         else p.reject(new Error(msg.error));
       });
       worker.on("error", (err) => {
         for (const p of pending.values()) p.reject(err);
         pending.clear();
         worker = null;
       });
     }
     return worker;
   }

   export function callWorker(
     op: string,
     args: Record<string, unknown>,
   ): Promise<unknown> {
     return new Promise((resolve, reject) => {
       const id = nextId++;
       pending.set(id, { resolve, reject });
       getWorker().postMessage({ id, op, args });
     });
   }
   ```

3. **`src/gui/main.ts`** — replace synchronous `wrap(() => ...)` calls with
   `callWorker(...)` for the heavy operations (create, open, close, discard,
   changePassword, recover, regenRecovery, delete). Keep light operations
   (info, sessions, addFiles) synchronous.

4. **`tsconfig.json`** — ensure `worker.ts` is compiled.

5. **Fallback** — if `Worker` fails to initialize (e.g., asar packaging issue),
   fall back to synchronous execution with a console warning.

---

### 14.2 Sessions file locking ❌

**Ref:** Engineering analysis in `ANALYSIS_REPORT.md`
**Severity:** 🟡 Medium
**Files:** `src/core/sessions.ts`

**Problem:** Two CLI instances or CLI + GUI racing on `sessions.json` can
corrupt or lose entries, orphaning plaintext working dirs.

**Implementation steps:**

1. Add a simple advisory lock using a `.lock` sibling file:

   ```ts
   import {
     mkdirSync,
     writeFileSync,
     unlinkSync,
     existsSync,
     readFileSync,
   } from "fs";

   const LOCK_FILE = `${SESSIONS_FILE}.lock`;
   const LOCK_STALE_MS = 10_000; // 10 seconds

   function acquireLock(retries = 10): void {
     for (let i = 0; i < retries; i++) {
       try {
         writeFileSync(LOCK_FILE, `${process.pid}\n${Date.now()}`, {
           flag: "wx",
         });
         return; // success
       } catch {
         // lock exists — check if stale
         try {
           const content = readFileSync(LOCK_FILE, "utf8");
           const ts = parseInt(content.split("\n")[1] || "0", 10);
           if (Date.now() - ts > LOCK_STALE_MS) {
             unlinkSync(LOCK_FILE); // stale lock, remove and retry
             continue;
           }
         } catch {
           /* ignore */
         }
         // Wait and retry
         const { execSync } = require("child_process");
         execSync("sleep 0.1"); // 100ms backoff (sync context)
       }
     }
     throw new Error(
       "Could not acquire sessions lock. Another instance may be running.",
     );
   }

   function releaseLock(): void {
     try {
       unlinkSync(LOCK_FILE);
     } catch {
       /* ignore */
     }
   }
   ```

2. Wrap `saveSessions` with the lock:
   ```ts
   function saveSessions(sessions: VaultSession[]): void {
     acquireLock();
     try {
       ensureConfigDir();
       const tmp = `${SESSIONS_FILE}.tmp`;
       writeFileSync(tmp, JSON.stringify(sessions, null, 2));
       renameSync(tmp, SESSIONS_FILE);
     } finally {
       releaseLock();
     }
   }
   ```

---

---

# Phase 15 — GUI UX Polish ❌

> **Priority: 🟡 MEDIUM**
> **Estimated effort: 3–4 days**

---

### 15.1 Auto-lock timer for idle vaults ❌

**Ref:** End-user analysis in `ANALYSIS_REPORT.md`
**Severity:** 🟡 Medium
**Files:** `src/gui/main.ts`, `src/gui/renderer/renderer.js`, `src/core/settings.ts`

**Problem:** Open vaults have decrypted plaintext sitting in temp indefinitely.
If the user walks away, the plaintext is exposed.

**Specification:**

- Configurable idle timer: 5 / 15 / 30 / 60 minutes, or "never".
- Default: 30 minutes.
- "Idle" = no IPC calls to vault operations AND no user input (mouse/keyboard)
  in the renderer.
- When the timer fires, automatically discard all open vaults (securely erase
  working dirs).
- Show a notification toast when auto-lock triggers.
- Store the preference in `settings.json`.

**Implementation steps:**

1. **`src/core/settings.ts`** — add `autoLockMinutes` to `AppSettings`:

   ```ts
   interface AppSettings {
     recentVaults?: string[];
     autoLockMinutes?: number; // 0 = never
   }
   ```

   Add `getAutoLockMinutes()` / `setAutoLockMinutes(n)`.

2. **`src/gui/main.ts`** — implement the timer:

   ```ts
   let idleTimer: ReturnType<typeof setTimeout> | null = null;

   function resetIdleTimer(): void {
     if (idleTimer) clearTimeout(idleTimer);
     const minutes = getAutoLockMinutes();
     if (!minutes) return; // disabled
     idleTimer = setTimeout(async () => {
       const sessions = loadSessions().filter(s => fs.existsSync(s.workingDir));
       for (const s of sessions) {
         try { secureEraseDir(s.workingDir); } catch {}
         removeSession(s.vaultPath);
       }
       const win = BrowserWindow.getAllWindows()[0];
       if (win) win.webContents.send("app:autoLocked", sessions.length);
     }, minutes * 60_000);
   }

   // Reset on any IPC call
   ipcMain.handle("vault:open", (_e, args) => { resetIdleTimer(); return wrap(() => { ... }); });
   // ...same for all vault:* handlers
   ```

3. **`src/gui/preload.ts`** — add listener:

   ```ts
   onAutoLocked: (cb: (count: number) => void) => {
     ipcRenderer.on("app:autoLocked", (_e, count: number) => cb(count));
   },
   ```

4. **`src/gui/renderer/renderer.js`** — show toast on auto-lock:

   ```js
   api.onAutoLocked((count) => {
     err(`Auto-locked ${count} vault(s) due to inactivity.`);
     refreshSessions();
   });
   ```

5. **Settings UI** — add a dropdown to the GUI (new "Settings" section or
   a gear icon in the topbar) for the auto-lock interval.

---

### 15.2 Light / dark theme toggle ❌

**Severity:** 🟡 Medium
**Files:** `src/gui/renderer/styles.css`, `src/gui/renderer/renderer.js`, `src/core/settings.ts`

**Implementation steps:**

1. **`styles.css`** — define light-theme variables alongside the dark ones:

   ```css
   :root {
     /* Dark theme (default) */
     --bg: #0f1117;
     --panel: #171a23;
     --card: #1e222e;
     --border: #2a2f3d;
     --text: #e6e8ee;
     --muted: #9ba1b3;
     --accent: #5b8cff;
     --accent-hover: #6f9bff;
     --danger: #ff5b6e;
     --ok: #43c98b;
   }

   [data-theme="light"] {
     --bg: #f5f6f8;
     --panel: #ffffff;
     --card: #ffffff;
     --border: #d9dce3;
     --text: #1a1d26;
     --muted: #5a6070;
     --accent: #3b6de0;
     --accent-hover: #2d5bc9;
     --danger: #d93548;
     --ok: #1d8a5e;
   }
   ```

2. **`settings.ts`** — add `theme: "dark" | "light" | "system"` to settings.

3. **`renderer.js`** — on load, apply the theme:

   ```js
   function applyTheme(theme) {
     if (theme === "system") {
       theme = window.matchMedia("(prefers-color-scheme: light)").matches
         ? "light"
         : "dark";
     }
     document.documentElement.setAttribute("data-theme", theme);
   }
   ```

4. Add a theme toggle in the topbar (sun/moon icon).

---

### 15.3 In-app file browser ❌

**Ref:** End-user analysis — biggest UX gap
**Severity:** 🟡 Medium (high user impact but non-blocking)
**Files:** new IPC handlers in `src/gui/main.ts`, new `src/gui/preload.ts`
methods, new section in `renderer.js`

**Specification:**

- When a vault is open, show a file tree inside the session card in the "Open
  Vaults" tab.
- Read the working directory recursively via a new IPC call `vault:listFiles`.
- Render as an expandable tree (CSS-only, no framework needed).
- Actions: double-click → `shell.openPath()`, right-click → rename/delete
  (via IPC).
- Files display: icon (folder/file emoji), name, size, modified date.

**Implementation steps:**

1. **`src/gui/main.ts`** — add IPC handler:

   ```ts
   ipcMain.handle("vault:listFiles", (_e, args) =>
     wrap(() => {
       function walk(dir: string, rel = ""): any[] {
         const entries = [];
         for (const name of fs.readdirSync(dir)) {
           const abs = path.join(dir, name);
           const stat = fs.lstatSync(abs);
           if (stat.isDirectory()) {
             entries.push({
               name,
               type: "dir",
               rel: rel ? `${rel}/${name}` : name,
               children: walk(abs, rel ? `${rel}/${name}` : name),
             });
           } else if (stat.isFile()) {
             entries.push({
               name,
               type: "file",
               rel: rel ? `${rel}/${name}` : name,
               size: stat.size,
               modified: stat.mtime.toISOString(),
             });
           }
         }
         return entries.sort((a, b) =>
           a.type === b.type
             ? a.name.localeCompare(b.name)
             : a.type === "dir"
               ? -1
               : 1,
         );
       }
       return walk(args.workingDir);
     }),
   );

   ipcMain.handle("vault:deleteFile", (_e, args) =>
     wrap(() => {
       const abs = path.resolve(args.workingDir, args.relPath);
       if (!abs.startsWith(args.workingDir)) throw new Error("Invalid path");
       fs.rmSync(abs, { recursive: true, force: true });
     }),
   );

   ipcMain.handle("vault:renameFile", (_e, args) =>
     wrap(() => {
       const absOld = path.resolve(args.workingDir, args.oldRel);
       const absNew = path.resolve(args.workingDir, args.newRel);
       if (
         !absOld.startsWith(args.workingDir) ||
         !absNew.startsWith(args.workingDir)
       )
         throw new Error("Invalid path");
       fs.renameSync(absOld, absNew);
     }),
   );
   ```

2. **`src/gui/preload.ts`** — expose the new methods.

3. **`renderer.js`** — in each session card, after the dropzone, render a
   collapsible file tree by calling `api.listFiles({ workingDir })`.

4. **`styles.css`** — add tree styles:
   ```css
   .file-tree {
     margin: 8px 0;
     font-size: 13px;
   }
   .file-tree ul {
     list-style: none;
     padding-left: 20px;
     margin: 0;
   }
   .file-tree li {
     padding: 3px 0;
     cursor: default;
   }
   .file-tree .dir-toggle {
     cursor: pointer;
     user-select: none;
   }
   .file-tree .dir-toggle::before {
     content: "▸ ";
   }
   .file-tree .dir-toggle.open::before {
     content: "▾ ";
   }
   .file-tree .file-size {
     color: var(--muted);
     font-size: 11px;
     margin-left: 8px;
   }
   ```

---

### 15.4 Drag vault file onto app window to open ❌

**Severity:** 🟢 Low
**Files:** `src/gui/renderer/renderer.js`, `src/gui/renderer/styles.css`

**Implementation steps:**

1. **`renderer.js`** — add a global drop handler:
   ```js
   document.body.addEventListener("dragover", (e) => {
     e.preventDefault();
     e.dataTransfer.dropEffect = "copy";
   });
   document.body.addEventListener("drop", (e) => {
     e.preventDefault();
     const file = [...e.dataTransfer.files].find((f) =>
       api.pathForFile(f).endsWith(".vault"),
     );
     if (file) {
       const filePath = api.pathForFile(file);
       // Switch to Open tab and fill in the path
       document.querySelector("[data-tab='open']").click();
       $("open-path").value = filePath;
       $("open-password").focus();
     }
   });
   ```

---

### 15.5 Window state persistence ❌

**Severity:** 🟢 Low
**Files:** `src/gui/main.ts`, `src/core/settings.ts`

**Implementation steps:**

1. **`settings.ts`** — add `windowBounds: { x, y, width, height }` to settings.

2. **`main.ts`** — on `createWindow`, read saved bounds:
   ```ts
   const bounds = getWindowBounds();
   const win = new BrowserWindow({
     width: bounds?.width ?? 900,
     height: bounds?.height ?? 680,
     x: bounds?.x,
     y: bounds?.y,
     // ...
   });
   win.on("close", () => {
     saveWindowBounds(win.getBounds());
   });
   ```

---

### 15.6 First-run onboarding screen ❌

**Severity:** 🟢 Low
**Files:** `src/gui/renderer/renderer.js`, `src/gui/renderer/index.html`, `src/gui/renderer/styles.css`, `src/core/settings.ts`

**Specification:**

- On first launch (no `settings.json` exists), show a modal welcome screen.
- Content: "Welcome to ShadowBit" + 3-step overview (Create → Open →
  Close) with icons. "Get Started" button → closes modal, switches to Create.
- Store `onboardingDone: true` in `settings.json`.

**Implementation steps:**

1. **`settings.ts`** — add `onboardingDone: boolean`.
2. **`main.ts`** — add IPC handler to read/write `onboardingDone`.
3. **`index.html`** — add a `#welcome-modal` div (similar to recovery modal).
4. **`renderer.js`** — on init, check `api.isOnboardingDone()`. If false,
   show the modal. On "Get Started", set the flag and switch to Create tab.

---

---

# Phase 16 — CLI Enhancements ❌

> **Priority: 🟡 MEDIUM**
> **Estimated effort: 1–2 days**

---

### 16.1 Password via environment variable ❌

**Ref:** S7 in `ANALYSIS_REPORT.md`
**Severity:** 🟡 Medium — `--password` visible in `ps aux`
**Files:** `src/cli/index.ts`

**Implementation steps:**

1. In every command's action that reads `opts.password`:

   ```ts
   const password =
     opts.password ||
     process.env.SHADOWBIT_PASSWORD ||
     (await promptHidden("Password: "));
   ```

2. Document in `README.md` and `--help`:

   ```
   Passwords can be supplied via --password, SHADOWBIT_PASSWORD env var,
   or interactive prompt (safest).
   ```

3. Clear the env var after reading:
   ```ts
   if (process.env.SHADOWBIT_PASSWORD) {
     delete process.env.SHADOWBIT_PASSWORD;
   }
   ```

---

### 16.2 Colored CLI output ❌

**Severity:** 🟢 Low
**Files:** `src/cli/index.ts`, `package.json`

**Implementation steps:**

1. `npm install picocolors` (2KB, zero deps, MIT — keeps the dep tree tiny).

2. In `src/cli/index.ts`:
   ```ts
   import pc from "picocolors";

   // Replace plain strings:
   console.log(pc.green("✓") + " Created vault: " + result.vaultPath);
   console.error(pc.red("✗") + ` ${e.message}`);
   console.log(pc.yellow("⚠") + "  Recovery key not confirmed.");
   ```

---

### 16.3 Orphan session cleanup command ❌

**Severity:** 🟢 Low
**Files:** `src/cli/index.ts`, `src/core/sessions.ts`

**Problem:** If the process crashes between `unpackDir` and `addSession`, or
a session's working dir is manually deleted, stale entries accumulate.

**Implementation steps:**

1. Add a `clean` CLI command:

   ```ts
   program
     .command("clean")
     .description(
       "Remove stale sessions (working dir missing or vault file gone)",
     )
     .action(() => {
       const sessions = loadSessions();
       const stale = sessions.filter(
         (s) => !fs.existsSync(s.workingDir) || !fs.existsSync(s.vaultPath),
       );
       for (const s of stale) {
         if (fs.existsSync(s.workingDir)) secureEraseDir(s.workingDir);
         removeSession(s.vaultPath);
       }
       console.log(`Cleaned ${stale.length} stale session(s).`);
     });
   ```

2. Also scan for orphaned `shadow-bit/` temp dirs not tracked by any session.

---

---

# Phase 17 — Advanced Vault Features ❌

> **Priority: 🟢 LOW**
> **Estimated effort: 1–2 weeks**

---

### 17.1 Payload compression ❌

**Severity:** 🟢 Low
**Files:** `src/core/vault.ts`, `src/core/types.ts`

**Specification:**

- Compress the plaintext bundle with `zlib.deflateSync` before encrypting.
- Add `compressed: boolean` to `VaultHeader` (default `true` for new vaults).
- On read, check the flag: if `compressed`, inflate after decrypting.
- Backward-compatible: old vaults without the flag are treated as uncompressed.

**Implementation steps:**

1. **`src/core/types.ts`** — add optional `compressed?: boolean` to `VaultHeader`.

2. **`src/core/vault.ts`** — in `createVault` and `closeVault`:

   ```ts
   import * as zlib from "zlib";
   const plaintext = packDir(session.workingDir);
   const compressed = zlib.deflateSync(plaintext, { level: 6 });
   const { iv, tag, ciphertext } = encryptPayload(mek, compressed);
   header.compressed = true;
   ```

3. In `openVault`:

   ```ts
   let plaintext = decryptPayload(
     mek,
     header.payloadIv,
     header.payloadTag,
     payload,
   );
   if (header.compressed) {
     plaintext = zlib.inflateSync(plaintext);
   }
   ```

4. Tests: verify that a compressed vault round-trips correctly, and that an
   old vault (no `compressed` flag) still opens.

---

### 17.2 Vault metadata / description ❌

**Severity:** 🟢 Low
**Files:** `src/core/types.ts`, `src/core/vault.ts`, `src/cli/index.ts`, `src/gui/renderer/renderer.js`

**Specification:**

- Add `meta?: { name?: string; description?: string }` to `VaultHeader`.
- Show in `info` output and GUI info panel.
- Settable via `shadow-bit meta <vault> --name "..." --description "..."`.

**Implementation steps:**

1. **`types.ts`** — add `meta?` to `VaultHeader` and `VaultInfo`.
2. **`vault.ts`** — add `setMeta(vaultPath, password, meta)` function.
3. **CLI** — add `meta` command.
4. **GUI** — show metadata in the info panel, editable in the Manage tab.

---

### 17.3 Streaming encryption (format v3) ❌

**Severity:** 🟢 Low (enables vaults > 1.5 GiB)
**Files:** all core files, new `src/core/streaming.ts`

**Specification:**

- Split payload into 64 MiB chunks, each with its own IV and GCM tag.
- Header stores `chunks: Array<{ iv: string; tag: string; size: number }>`.
- Bump format version to **3**.
- v1 and v2 vaults still read transparently.
- Memory usage: ~128 MiB peak (2× chunk size) instead of 2× payload size.

**Implementation steps:**
This is a significant format change. Requires:

1. New `encryptPayloadStreaming()` / `decryptPayloadStreaming()` in `crypto.ts`.
2. Modified `writeContainer` / `readContainer` to handle chunk boundaries.
3. `packDir` → produce a `Readable` stream instead of a `Buffer`.
4. `unpackDir` → consume a `Readable` stream.
5. Full test suite for chunked round-trips, partial corruption detection, and
   backward compatibility.

---

### 17.4 Multi-user vault sharing (LUKS-style key slots) ❌

**Severity:** 🟢 Low
**Files:** `src/core/types.ts`, `src/core/vault.ts`, `src/core/crypto.ts`

**Specification:**

- Header supports up to 8 "key slots", each wrapping the same MEK with a
  different password.
- `addKeySlot(vaultPath, existingPassword, newSlotPassword)`.
- `removeKeySlot(vaultPath, existingPassword, slotIndex)`.
- Opening tries each slot until one succeeds (max ~8 scrypt derivations
  in the worst case — ~1.6 seconds).

---

---

# Phase 18 — Distribution & Release Pipeline ❌

> **Priority: 🟡 MEDIUM**
> **Estimated effort: 2–3 days**

---

### 18.1 Code signing ❌

**macOS:**

1. Register for Apple Developer Program ($99/yr).
2. Create a Developer ID Application certificate.
3. Add to `electron-builder` config:
   ```json
   "mac": {
     "identity": "Developer ID Application: Your Name (TEAM_ID)",
     "hardenedRuntime": true,
     "entitlements": "build/entitlements.mac.plist",
     "entitlementsInherit": "build/entitlements.mac.plist"
   }
   ```
4. Create `build/entitlements.mac.plist` with minimum entitlements.
5. Add notarization via `@electron/notarize`:
   ```ts
   // afterSign hook
   await notarize({ appPath, appleId, appleIdPassword, teamId });
   ```

**Windows:**

1. Obtain an EV code-signing cert (DigiCert/Sectigo, ~$300/yr).
2. Set `win.certificateFile` and `win.certificatePassword` in CI env.

---

### 18.2 Release CI/CD pipeline ❌

**Files:** `.github/workflows/release.yml`

```yaml
name: Release
on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: mac
          - os: windows-latest
            target: win
          - os: ubuntu-latest
            target: linux
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npx electron-builder --${{ matrix.target }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing:
          CSC_LINK: ${{ secrets.MAC_CERT_P12 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      - uses: softprops/action-gh-release@v2
        with:
          files: release/**/*
```

---

### 18.3 Auto-update (electron-updater) ❌

**Files:** `src/gui/main.ts`, `package.json`

**Implementation steps:**

1. `npm install electron-updater` (ships with electron-builder).
2. In `main.ts`:
   ```ts
   import { autoUpdater } from "electron-updater";
   app.whenReady().then(() => {
     autoUpdater.checkForUpdatesAndNotify();
   });
   ```
3. Add to the app menu: "Check for Updates…" item.
4. Requires GitHub Releases as the update source (free).

---

---

# Phase 19 — Extended Testing ❌

> **Priority: 🟡 MEDIUM**
> **Target: ongoing**
> **Estimated effort: 2–3 days initially, then incremental**

---

### 19.1 GUI E2E tests in CI ❌

**Files:** `e2e/smoke.test.ts`, `.github/workflows/ci.yml`

**Implementation steps:**

1. The E2E smoke test already exists in `e2e/smoke.test.ts`. It needs:
   - Xvfb on Linux CI (headless display):
     ```yaml
     - run: sudo apt-get install -y xvfb
     - run: xvfb-run npm run test:gui
     ```
   - On macOS CI it runs natively.
   - Windows: needs virtual display (e.g., `GHA-setup-displayserver`).

2. Add to CI matrix:
   ```yaml
   test-gui:
     runs-on: ${{ matrix.os }}
     strategy:
       matrix:
         os: [macos-latest, ubuntu-latest]
     steps:
       - uses: actions/checkout@v4
       - uses: actions/setup-node@v4
       - run: npm ci
       - run: npm run build
       - run: npx playwright install --with-deps
       - run: npm run test:gui
         env: { SHADOWBIT_E2E_TEST: "1" }
   ```

---

### 19.2 Missing test coverage areas ❌

Add tests for the following uncovered scenarios:

| Area                    | Tests to add                                                                       | File                                     |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| **Unicode paths**       | Create vault with emoji in name, add files with unicode paths                      | `core.test.ts`                           |
| **Empty directories**   | Pack a dir containing empty subdirs → unpack → verify dirs exist                   | `core.test.ts`                           |
| **Concurrent access**   | Two simultaneous `openVault` calls on the same vault                               | `core.test.ts`                           |
| **Near-cap payload**    | Pack a directory close to `MAX_PAYLOAD_SIZE` → verify rejection                    | `core.test.ts`                           |
| **Settings module**     | `getRecentVaults`, `addRecentVault`, `removeRecentVault`, corrupt file recovery    | `core.test.ts` or new `settings.test.ts` |
| **Password edge cases** | Password with leading/trailing spaces, Unicode chars (é, ñ, 中文), exactly 8 chars | `core.test.ts`                           |
| **Windows paths**       | Bundle entries with backslash separators (simulated)                               | `core.test.ts`                           |

---

---

# Phase 20 — Documentation & Monetization Infrastructure ❌

> **Priority: 🟢 LOW**
> **Estimated effort: 1–2 weeks**

---

### 20.1 Vendor Tailwind for docs site ✅

**Problem:** docs site loaded Tailwind via CDN — a privacy concern for a
security tool's website, and it broke the page entirely offline.

**Shipped (2026-10):** the CDN `<script>` is removed. The utility rules the
page uses are vendored into `docs/utilities.css`, with `index.css` holding
component styles and local colour/opacity bridges. The site now makes zero
network requests and renders correctly from `file://`.

Layout was verified byte-identical before and after: 973 elements compared
across 45 computed properties at 1440/768/390px, with zero differences.
`npm run test:site` guards the CDN from returning and covers the offline
and `file://` paths.

### 20.2 Monetization infrastructure ❌

If pursuing the open-core model outlined in `ANALYSIS_REPORT.md §8`:

1. **License key system** — simple cryptographic key validation:
   - Generate keys as signed JWT tokens (HS256 with a secret).
   - The Electron app checks on startup: read `~/.shadow-bit/license.key`,
     verify signature, check expiry.
   - Free features always work; premium features check `isLicensed()`.

2. **Landing page with pricing** — extend the existing `docs/` site with a
   `/pricing` section. Use Stripe Checkout or LemonSqueezy for payments.

3. **Terms of service + privacy policy** — required before accepting payments.
   Template from Stripe Atlas or generator tools.

---

---

# Phase 21 — Adversarial Security Hardening ✅ 7/7 shipped

> **Priority: 🔴 HIGH — closes the remaining gaps identified in the adversarial audit**
> **Target: requires a container format bump (format v3)**
> **Estimated effort: 3–4 weeks**
> **Depends on: nothing (can begin immediately)**
>
> This phase addresses five structural weaknesses that matter when the threat
> model extends beyond opportunistic attackers to determined, well-resourced
> adversaries (targeted corporate espionage, law enforcement, nation-state).
> Each item is independently shippable; the recommended order is the numbering.

---

### 21.1 Authenticated header (HMAC over plaintext header) ✅

**Severity:** 🔴 Critical — the single biggest structural weakness
**Threat:** An attacker who possesses the `.vault` file (but not the password)
can silently modify the plaintext header: downgrade KDF params from N=2¹⁷ to
N=2¹⁴ (8× cheaper brute-force), swap the salt, swap the recovery escrow, or
alter timestamps. GCM on the payload catches wrong-MEK decryptions, but the
victim processes the tampered header _before_ reaching that check.
**Files:** `src/core/crypto.ts`, `src/core/container.ts`, `src/core/vault.ts`,
`src/core/types.ts`, `src/test/core.test.ts`

**Design:**

- Derive a Header Authentication Key (HAK) from the MEK:
  `HAK = HKDF-SHA256(ikm=MEK, salt="", info="shadowbit-header-auth", len=32)`
- Compute `headerMac = HMAC-SHA256(HAK, canonical_header_bytes)` where
  `canonical_header_bytes` is the JSON-serialized header **with the `headerMac`
  field removed** (or a deterministic serialization that excludes it).
- Store `headerMac` as a hex string inside the header itself.
- At open time: unwrap MEK → derive HAK → recompute HMAC → compare
  (timing-safe) → reject if mismatch.
- Bump container format to **version 3**. v1/v2 vaults (no `headerMac`) are
  still readable (skip the check), but any write (close, change-password,
  recover, etc.) upgrades to v3 with the MAC.

**Why HKDF and not the MEK directly?** Key separation. The MEK is used for
AES-GCM encryption; the HAK is used for HMAC authentication. Using the same
key for two different algorithms is a protocol smell even when both are secure
individually.

**Implementation steps:**

1. **`src/core/crypto.ts`** — add:
   ```ts
   import { hkdfSync } from "crypto";
   export function deriveHak(mek: Buffer): Buffer {
     return Buffer.from(
       hkdfSync("sha256", mek, Buffer.alloc(0), "shadowbit-header-auth", 32),
     );
   }
   export function computeHeaderMac(hak: Buffer, headerJson: string): string {
     return crypto.createHmac("sha256", hak).update(headerJson).digest("hex");
   }
   ```
2. **`src/core/types.ts`** — add `headerMac?: string` to `VaultHeader`.
3. **`src/core/container.ts`** — bump `CURRENT_VERSION` to 3,
   `MIN_SUPPORTED_VERSION` stays 1.
4. **`src/core/vault.ts`** — in `buildHeader`, after constructing the header
   object, compute and attach the MAC:
   ```ts
   const hak = deriveHak(mek);
   const jsonWithoutMac = JSON.stringify(header); // headerMac not yet set
   header.headerMac = computeHeaderMac(hak, jsonWithoutMac);
   wipeBuf(hak);
   ```
   In `openVault`, after `unwrapMekWithPassword`:
   ```ts
   if (header.headerMac) {
     const hak = deriveHak(mek);
     const { headerMac, ...rest } = header;
     const expected = computeHeaderMac(hak, JSON.stringify(rest));
     wipeBuf(hak);
     if (
       !crypto.timingSafeEqual(
         Buffer.from(headerMac, "hex"),
         Buffer.from(expected, "hex"),
       )
     ) {
       throw new WrongCredentialError(
         "Header integrity check failed (tampered or corrupt).",
       );
     }
   }
   ```
   Apply the same check in every path that reads the header: `closeVault`,
   `changePassword`, `recoverVault`, `regenerateRecoveryKey`, `removeRecoveryKey`,
   `upgradeRecoveryEscrow`, `setMeta`.
5. **Tests:** craft a vault, tamper a header field, verify open rejects it.
   Verify v1/v2 vaults without `headerMac` still open. Verify that every
   write path produces a v3 header with a valid MAC.

---

### 21.2 Timing-safe recovery key hash comparison ✅

**Severity:** 🟡 Medium — protocol-level sloppiness, not practically exploitable
**Threat:** The recovery key hash comparison in `unwrapMekWithRecovery` uses
JavaScript `!==` (string comparison), which is not constant-time. A local
attacker with nanosecond timing precision could theoretically narrow down
the hash value byte by byte.
**Files:** `src/core/vault.ts`

**Implementation steps:**

1. In `unwrapMekWithRecovery`, replace:
   ```ts
   if (header.recovery.keyHash !== hashRecoveryKey(recoveryKey)) {
   ```
   with:
   ```ts
   const expected = Buffer.from(header.recovery.keyHash, "hex");
   const actual = Buffer.from(hashRecoveryKey(recoveryKey), "hex");
   if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
   ```
2. Add the same pattern anywhere else hashes are compared (grep for `===`
   and `!==` near `hash`, `keyHash`, `headerHash`).
3. **Test:** unit test that the comparison still works for both matching and
   non-matching keys (functional correctness, not timing — timing tests are
   fragile in CI).

**Effort:** ~30 minutes. Ship with 21.1.

---

### 21.3 Hidden volumes — plausible deniability ✅ _(library only — not shipped)_

> **The ✅ on this heading refers to the library implementation, not to a
> reachable feature.** `src/core/hidden.ts` is written, is unit-tested, and is
> **imported by nothing** — there is no `hidden` CLI subcommand and no GUI
> toggle. A user cannot create or open a hidden volume with any build of this
> app. Treat everything below as a design record for future work. The earlier
> website copy that presented this as a shipped capability aimed at
> "journalists, activists and other high-risk users" was wrong and has been
> removed; the security model documented for shipped features makes no
> deniability promise.

**Severity:** 🟠 High for high-risk users
**Threat:** A `.vault` file is obviously encrypted (magic bytes, binary format).
Under coercion (border crossing, device seizure, legal demand), the user
cannot deny the existence of encrypted content. A hidden volume lets the
user open the vault with a "decoy password" that reveals innocent files,
while the real files are hidden in what looks like random padding.
**Files:** `src/core/types.ts`, `src/core/crypto.ts`, `src/core/container.ts`,
`src/core/vault.ts`, `src/cli/index.ts`, `src/gui/renderer/renderer.js`

**Design (VeraCrypt-inspired, adapted to the .vault format):**

```
[MAGIC 8B][HEADER_LEN 4B][OUTER_HEADER JSON][PAYLOAD_AREA (fixed size)]
                                              ├─ outer ciphertext ─┤
                                              ├─ (random padding)──┤  ← or:
                                              ├─ HIDDEN_HEADER ────┤
                                              ├─ hidden ciphertext ┤
```

**Key principles:**

- **Fixed-size payload area.** When creating a hidden-volume vault, the user
  specifies a total vault size (e.g. 100 MB). The outer volume occupies the
  first portion; the hidden volume occupies the tail. The gap between them is
  random padding. Because AES-GCM ciphertext is indistinguishable from random,
  an observer cannot tell whether the tail is padding or a hidden volume.
- **Two independent passwords, two independent MEKs.** The outer password
  decrypts the outer header → outer MEK → outer payload. The hidden password
  decrypts the hidden header (embedded at a fixed offset from the end of the
  payload area) → hidden MEK → hidden payload. Neither password reveals the
  other's existence.
- **The outer header has no mention of the hidden volume.** Not in the JSON,
  not in the magic, nowhere. The only way to detect it is to try a hidden
  password against the fixed-offset hidden header location.
- **Write protection.** When the outer volume is open, writes must not
  overwrite the hidden volume's region. The outer volume's maximum size is
  `total_size - hidden_reserved - hidden_header_size`. The user sets the split
  at creation time; it cannot be changed afterwards (changing it would destroy
  the hidden volume).

**Implementation steps:**

1. **`src/core/types.ts`** — add:

   ```ts
   interface HiddenVolumeParams {
     totalSize: number; // fixed payload area size in bytes
     outerMaxSize: number; // max bytes for outer payload
     hiddenOffset: number; // byte offset where hidden header starts
   }
   ```

   Add `hidden?: HiddenVolumeParams` to `VaultHeader` (outer header only;
   hidden header is a full `VaultHeader` embedded in the payload area).
   **Wait — that reveals hidden volume existence.** Instead: store
   `fixedPayloadSize: number` in the outer header (which is also set for
   non-hidden vaults to prevent size-based detection). The hidden volume
   params are stored only inside the hidden header itself.

2. **`src/core/container.ts`** — add `writeContainerFixed(filePath, header,
outerPayload, totalPayloadSize)` that pads with `crypto.randomBytes` to
   exactly `totalPayloadSize`. Add `readHiddenHeader(filePath, password)`
   that reads the last N bytes of the payload area, attempts AES-GCM
   decryption of a header-sized block, and returns the hidden header if
   successful (or `null` if the password is wrong / no hidden volume).

3. **`src/core/vault.ts`** — add:
   - `createHiddenVault(vaultPath, outerOpts, hiddenOpts, totalSize)` — creates
     both volumes in one pass.
   - `openVault` gains a fallback: if outer password fails, silently try
     hidden header at the fixed offset. **No — that reveals the hidden volume
     by timing.** Instead: the user explicitly chooses whether to open the
     outer or hidden volume (the CLI has `--hidden` flag; the GUI has a toggle).
     A wrong password for either volume produces the same error.
   - `closeVault` respects the split: outer writes are bounded; hidden writes
     are bounded.

4. **CLI** — `create --hidden --total-size 100M`; `open --hidden`;
   `close` (auto-detects which volume is open from the session).

5. **GUI** — "Hidden Volume" checkbox in Create tab; "Open Hidden" toggle in
   Open tab.

6. **Tests:**
   - Create a hidden vault → open outer → files are the decoy → close.
   - Open hidden → files are the real ones → close.
   - Wrong outer password → error. Wrong hidden password → same error.
   - Outer close doesn't corrupt hidden region (byte-level verification).
   - A non-hidden vault with `fixedPayloadSize` doesn't contain a hidden
     volume (random tail is just random).

**Effort:** ~1 week. This is the most complex feature but has the highest
privacy impact.

---

### 21.4 Carrier-file steganography (vault-inside-image) ✅ _(library only — not shipped)_

> **Same caveat as 21.3.** `src/core/stego.ts` is implemented and unit-tested
> (embed/extract round-trip, clean-carrier rejection) but is imported by nothing
> in `src/cli/` or `src/gui/`. No command or GUI control reaches it. Not a
> shipped feature.

**Severity:** 🟠 High for high-risk users
**Threat:** Even with hidden volumes, the `.vault` file extension and binary
magic bytes (`SHDBIT\0\1`) reveal that the file is an encrypted container.
File-system scanners, border agents, or forensic tools can flag it instantly.
Steganography hides the vault inside an innocent-looking carrier file
(image, audio, video) so its very existence is concealed.
**Files:** new `src/core/stego.ts`, `src/core/container.ts`, `src/cli/index.ts`,
`src/gui/renderer/renderer.js`

**Design (append-after-EOF approach — simplest, most robust):**

Many file formats have well-defined EOF markers. Data appended after them is
ignored by standard viewers but can be read by ShadowBit:

| Carrier format | EOF marker               | Viewer behavior        |
| -------------- | ------------------------ | ---------------------- |
| JPEG           | `FF D9`                  | Viewers stop at marker |
| PNG            | `IEND` chunk             | Viewers stop at chunk  |
| ZIP            | End-of-central-directory | Viewers stop at EOCD   |
| PDF            | `%%EOF`                  | Viewers stop at marker |

**Layout of a stego vault:**

```
[CARRIER FILE bytes (valid JPEG/PNG/etc.)]
[STEGO_MAGIC 8B]            "SBSTEG\0\1"  (not "SHDBIT" — avoids grep)
[HEADER_LEN 4B][HEADER JSON][PAYLOAD]
```

The file has the carrier's extension (`.jpg`, `.png`) and opens normally in
image viewers. ShadowBit detects the `SBSTEG` magic by scanning backwards
from the end, or by checking after the carrier's EOF marker.

**Implementation steps:**

1. **`src/core/stego.ts`** — new module:

   ```ts
   export const STEGO_MAGIC = Buffer.from("SBSTEG\x00\x01", "latin1");

   /** Embed a vault inside a carrier file. */
   export function embedVault(
     carrierPath: string,
     vaultHeader: VaultHeader,
     vaultPayload: Buffer,
     outputPath: string,
   ): void { ... }

   /** Extract a vault from a carrier file. Returns null if no vault found. */
   export function extractVault(carrierPath: string): Container | null { ... }

   /** Detect whether a file contains an embedded vault (no password needed). */
   export function hasEmbeddedVault(filePath: string): boolean { ... }
   ```

2. **Detection algorithm:** Read the last 4 KB of the file. Scan for
   `SBSTEG\0\1`. If found, read header length + header + payload from that
   offset. This is O(1) — no need to parse the carrier format.

3. **CLI** — new commands:
   - `shadow-bit embed <vault> --carrier photo.jpg --output photo-secret.jpg`
   - `shadow-bit extract photo-secret.jpg --output recovered.vault`
   - Or: `shadow-bit open photo-secret.jpg` auto-detects embedded vault.

4. **GUI** — in Create tab: "Embed in carrier file" option with a file picker
   for the carrier. In Open tab: auto-detection when user selects any file.

5. **Tests:**
   - Embed vault in a real JPEG → open the JPEG in an image viewer → works.
   - Extract vault from the JPEG → decrypt → files are intact.
   - Modify the carrier portion → vault still extracts (they're independent).
   - Tamper the vault portion → GCM detects it.
   - File without embedded vault → `extractVault` returns null.

**Effort:** ~3 days. The append-after-EOF approach is simple and doesn't
require parsing image formats.

**Limitation:** File size. A 100 MB vault appended to a 2 MB JPEG produces a
102 MB "JPEG" — suspicious to a sophisticated analyst. For small vaults
(documents, passwords), the size increase is negligible.

---

### 21.5 Password strength enforcement (entropy estimation) 🔶 Partially shipped

> **Shipped:** `estimateStrength()` + a common-password blocklist in
> `src/core/crypto.ts`, with tests. **Not shipped:** nothing in `src/cli/` or
> `src/gui/` calls it — the core's own `assertPassword` still enforces length
> only, and the GUI's strength meter is an independent implementation in
> `renderer.js`. The `--strict` flag designed below was never built. An
> 8-character `password` is still accepted.

**Severity:** 🟡 Medium
**Threat:** The current 8-character minimum allows trivially weak passwords
like `12345678` or `password`. scrypt N=2¹⁷ slows brute-force but cannot
compensate for a password in the top-1000 dictionary.
**Files:** `src/core/vault.ts`, `src/cli/index.ts`, `src/gui/renderer/renderer.js`

**Design:**

Add a lightweight entropy estimator (no external dependency) that scores
passwords on character-class diversity and length:

```ts
interface PasswordStrength {
  score: number;      // 0–4 (0=terrible, 4=strong)
  entropy: number;    // estimated bits
  feedback: string;   // human-readable suggestion
}

export function estimateStrength(pw: string): PasswordStrength { ... }
```

**Rules:**

- Score 0: length < 8 (rejected by `assertPassword`)
- Score 1: length 8–11, single character class
- Score 2: length 8–11, two character classes, or length 12–15 single class
- Score 3: length 12–15 with two+ classes, or length 16+
- Score 4: length 16+ with three+ character classes

Additionally, reject passwords that appear in a small built-in blocklist
(top-100 most common passwords, embedded as a Set — no file I/O).

**Implementation steps:**

1. **`src/core/vault.ts`** — add `estimateStrength()`. In `assertPassword`,
   optionally warn (not reject) for score < 2. Add a `--strict` mode that
   requires score ≥ 2.
2. **CLI** — after password prompt, print the strength score and feedback.
   If `--strict`, reject weak passwords.
3. **GUI** — the strength indicator already exists; wire it to
   `estimateStrength` for consistent scoring between CLI and GUI.
4. **Tests:** verify scoring for known weak/strong passwords.

**Effort:** ~1 day.

---

### 21.6 Duress password (dead-man's switch) ❌ Not shipped

> **Not implemented at all.** There is no `duress` field in `VaultHeader`, no
> core function, and no CLI or GUI path; the only occurrence of the word in
> `src/` is a comment in `hidden.ts` about a duress _scenario_. The ✅ this
> heading previously carried was wrong. Everything below is design.

**Severity: 🟡 Medium — high-value for users under coercion
**Threat:** Under physical coercion (rubber-hose attack), the user is forced
to reveal their password. A duress password lets them comply while
triggering a defensive action.
**Files:** `src/core/types.ts`, `src/core/vault.ts`, `src/core/crypto.ts`,
`src/cli/index.ts`

**Design:**

The user sets a second password at vault creation (or later). When entered
as the "real" password:

- **Option A — Wipe:** The vault's MEK is irreversibly destroyed. The vault
  becomes permanently undecryptable. This is extreme but leaves the adversary
  with no data.
- **Option B — Decoy open:** The duress password opens a separate decoy
  payload (stored alongside the real one, like a simplified hidden volume).
  The adversary sees innocent files and believes they've succeeded.

Option B is strictly better (Option A reveals that something was destroyed).
This is a lightweight variant of 21.3 (hidden volumes) where the "outer"
password IS the duress password.

**Implementation:** If 21.3 (hidden volumes) is shipped first, the duress
password is just the outer volume's password. No additional format changes
needed — it's a UX framing of hidden volumes.

If shipped independently:

1. Add `duress?: { encryptedMek: EncryptedBlob; salt: string }` to
   `VaultHeader` — a third MEK wrapping under the duress password.
2. The duress MEK encrypts a separate (smaller) decoy payload that is
   concatenated after the real payload in the container.
3. `openVault` tries the main password first; if it fails, tries the duress
   wrapping. If duress succeeds, decrypt the decoy payload instead.
4. The user cannot distinguish which payload was opened from the API
   return — the vault opens either way, just with different content.

**Effort:** ~2 days standalone, or free if 21.3 ships first.

---

### 21.7 Encrypted session metadata 🔶 Partially shipped

> **Shipped:** the fallback half only. `sessions.json` and `settings.json` are
> AES-256-GCM encrypted under a random key at `~/.shadow-bit/.local-key` (0600),
> claimed with `O_EXCL` so concurrent first-runs converge on one key.
> **Not shipped:** the primary design — `src/core/keychain.ts` below, putting
> that key in the OS keychain. The paths leak exactly what this section
> describes.

**Severity: 🟡 Medium
**Threat:** `~/.shadow-bit/sessions.json` and `settings.json` reveal which
vaults exist, their paths, opening timestamps, and recently used files.
An adversary with read access to the home directory learns activity patterns
even without any vault passwords.
**Files:** `src/core/sessions.ts`, `src/core/settings.ts`

**Design:**

- Encrypt `sessions.json` and `settings.json` with a local machine key
  derived from a combination of:
  - A random 256-bit key stored in the OS keychain (macOS Keychain,
    Windows Credential Manager, Linux Secret Service / libsecret)
  - Falling back to a key file at `~/.shadow-bit/.local-key` (mode 0600)
    on systems without a keychain
- The files are AES-256-GCM encrypted. At process startup, the key is
  loaded, files are decrypted into memory, and written back encrypted on
  mutation.
- If the key is lost (OS reinstall), the worst case is losing the session
  list — no vault data is affected.

**Implementation steps:**

1. **`src/core/keychain.ts`** — new module. `getLocalKey(): Buffer` that
   reads from OS keychain or falls back to a key file.
2. **`src/core/sessions.ts`** and **`src/core/settings.ts`** — wrap
   `loadSessions`/`saveSessions` and `loadSettings`/`saveSettings` with
   encrypt/decrypt using the local key.
3. **Tests:** verify round-trip, verify graceful degradation when key is
   missing.

**Effort:** ~2 days (the OS keychain integration is the complex part).

---

# Phase 22 — Competitive Gap Closing ✅

Implemented in response to a systematic comparison against VeraCrypt/TrueCrypt.
These features close the most impactful gaps while staying within ShadowBit's
architectural scope (file containers, not virtual disks).

### 22.1 Plaintext-on-disk mitigations ✅

- `suppressIndexing()` in `fsutil.ts` disables Spotlight (macOS), Windows Search,
  and Linux file manager indexing on decrypted working directories.
- Called automatically in `makeWorkingDir()`.

### 22.2 Keyfile support (second authentication factor) ✅

- `processKeyfile()`, `processKeyfiles()`, `mixKeyfileIntoPassword()` in `crypto.ts`.
- Keyfile hash is HMAC-mixed into the password before KDF derivation.
- `CreateOptions.keyfiles` and `--keyfile` flag in all vault operations.
- `header.keyfileRequired` flag prevents opening without the keyfile.
- Supports multiple keyfiles (XOR-combined, then re-hashed).

### 22.3 Algorithm agility (ChaCha20-Poly1305) ✅

- `encryptPayload()` / `decryptPayload()` accept a cipher parameter.
- New vaults can use `--cipher chacha20-poly1305` as an alternative to AES-256-GCM.
- `header.cipher` records the algorithm; omitted = AES-256-GCM (backward compat).
- Both ciphers produce 16-byte auth tags (authenticated encryption).

### 22.4 Hidden volumes + Duress password 🔶 Hidden volumes library-only; duress not shipped

> **Hidden volumes:** implemented and unit-tested in `src/core/hidden.ts`, and
> the outer volume opens correctly through the ordinary `openVault` path — but
> no CLI command or GUI path creates or opens one, so a user cannot reach it.
> **Duress password:** see 21.6 — not implemented. The "outer password = duress
> password" line below describes intent, not shipped behaviour.

- `src/core/hidden.ts`: `createHiddenVault()`, `openHiddenVolume()`, `isOuterPassword()`.
- Fixed-size container with random padding indistinguishable from ciphertext.
- Encrypted hidden header block (SBHID magic) at end of file stores the inner
  VaultHeader + payload length.
- Outer password = duress password (shows decoy files).
- Hidden password = real data access.
- Minimum container size: 8 MiB.

**Test coverage:** the hidden-volume half has library tests in `src/test/core.test.ts`;
the duress half does not exist. See the top of this file for current suite totals.

---

### Implementation order and dependencies

```
21.2 (timing-safe comparison)          ← ship immediately, no format change
  ↓
21.1 (authenticated header)            ← format v3 bump, high impact
  ↓
21.5 (password strength estimation)    ← no format change, quick win
  ↓
21.3 (hidden volumes)                  ← biggest feature, enables 21.6
  ↓
21.6 (duress password)                 ← free if 21.3 is done
  ↓
21.4 (steganography)                   ← independent, can ship in parallel
  ↓
21.7 (encrypted session metadata)      ← independent, can ship in parallel
```

21.2 and 21.5 can ship in a point release. 21.1 + 21.3 require a container
format bump and ship together. 21.4 and 21.7 are independent and can ship in
any order.

---

# Summary

| Phase  | Area                                   | Priority        | Status                       |
| ------ | -------------------------------------- | --------------- | ---------------------------- |
| 1      | Core engine                            | —               | ✅ Complete                  |
| 2      | CLI                                    | —               | ✅ Complete                  |
| 3      | Electron GUI                           | —               | 🔶 Wired, untested           |
| 4      | App icon                               | —               | ✅ Complete                  |
| 5      | Packaging                              | —               | 🔶 macOS ✅, others untested |
| 6      | Testing                                | —               | 🔶 Core + CLI ✅ (27)        |
| 7      | CI / CD                                | —               | 🔶 CI ✅, CD pending         |
| 8–9    | QoL + Advanced                         | —               | 🔶 Partial                   |
| 10     | Security audit fixes                   | —               | ✅ All shipped               |
| 11     | Post-analysis polish                   | —               | ✅ All shipped               |
| **12** | **Critical bug fixes & security**      | **🔴 CRITICAL** | ❌                           |
| **13** | **GUI accessibility & responsiveness** | **🟠 HIGH**     | ❌                           |
| **14** | **Worker thread & performance**        | **🟠 HIGH**     | ❌                           |
| **15** | **GUI UX polish**                      | **🟡 MEDIUM**   | ❌                           |
| **16** | **CLI enhancements**                   | **🟡 MEDIUM**   | ❌                           |
| **17** | **Advanced vault features**            | **🟢 LOW**      | ❌                           |
| **18** | **Distribution & release pipeline**    | **🟡 MEDIUM**   | ❌                           |
| **19** | **Extended testing**                   | **🟡 MEDIUM**   | ❌                           |
| **20** | **Docs & monetization**                | **🟢 LOW**      | ❌                           |
| **21** | **Adversarial security hardening**     | **🔴 HIGH**     | ❌                           |

### Release plan

Version numbers are deliberately omitted — the app is at `1.0.0` and the
groupings below are ordered, not numbered. Assign versions when the work ships.

| Scope                   | Contents                                                                                                                | Phases             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Second release**      | Critical fixes, security hardening, accessibility                                                                       | 12, 13             |
| **Third release**       | Performance, UX polish, CLI enhancements, CI/CD                                                                         | 14, 15, 16, 18, 19 |
| **Later**               | Compression, metadata (shipped); streaming, multi-user, monetization (not)                                              | 17, 20             |
| **Needs a format bump** | Authenticated header (**shipped** — container v3); hidden volumes, steganography, duress password (**all unreachable**) | 21                 |
