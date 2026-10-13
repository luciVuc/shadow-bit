# ShadowBit — Code Audit & Production-Readiness Report

> **Historical document.** This is an internal self-review, not a professional
> security audit — nobody independent has assessed this code, and no penetration
> test, formal verification, or third-party review was performed. It is kept as
> a record of what was found and fixed.
>
> **Status as of the most recent commits.** C1 and C2 are fixed (`.env` is gone
> and `.env` is in `.gitignore`). The critical and high findings below were
> addressed over several passes. Later work added further fixes not listed here,
> including the keyfile-forwarding bug (`63a3087`, which made a keyfile vault
> impossible to delete or re-password) and the local machine key race
> (`8359fc6`, where a peer could end up with key material that decrypts
> nothing). Current suite: **232 tests** — 99 core+CLI-unit, 36 CLI E2E, 26 GUI, 71 NFR.
> The ✅/❌ markers below are frozen at the time of the review; read
> `SECURITY.md` for the current threat model and `ROADMAP.md` for real status.

**Scope:** Full review of `src/core`, `src/cli`, `src/gui`, build scripts, packaging config, and repo hygiene.
**Verdict:** The architecture is sound (envelope encryption, AES-256-GCM, scrypt, context-isolated Electron). However there are **several real bugs and security issues** that must be fixed before publishing. Below they are grouped by severity, each with an explanation and a concrete fix.

---

## 🔴 Critical

### C1. A real secret is committed to the working tree (`.env`)

`/.env` contains a live-looking recovery key:

```
RECOVERY_KEY=QVFWB-3RCZN-JG48M-Z4GTQ-XCK69-APN57-X7RWB-MNZ9W
```

- No code reads it (`grep` for `process.env` / `dotenv` / `RECOVERY_KEY` returns nothing) — it is orphaned leftover secret material.
- It is `.gitignore`d, so it is not in git history _now_, but it sits in the project folder and will be included in any zip/backup/`electron-builder` context that doesn't respect `.gitignore`.

**Fix:**

- Delete the file: `rm .env`.
- Treat that recovery key as compromised — regenerate it for any real vault that used it (`shadow-bit recovery-key <vault>`).
- Never write secrets to disk in plaintext. Add a `SECURITY.md` note that recovery keys are shown once and never persisted.

### C2. `openVault` bypasses the password check for an already-open vault

`src/core/vault.ts`:

```ts
const existing = findSession(abs);
if (existing && fs.existsSync(existing.workingDir)) {
  return { vaultPath: abs, workingDir: existing.workingDir }; // no password verified!
}
```

If a session already exists, **any password (or a wrong one) "opens" the vault** and returns the path to the decrypted working folder. On a shared/multi-user machine this lets a second actor reach the plaintext without knowing the password. The GUI immediately opens that folder.

**Fix:** Always verify the password before returning, even when reusing a session. Unwrap the MEK first (`unwrapMekWithPassword`) and only then hand back the existing `workingDir`, or refuse to reuse and require the correct password:

```ts
const { header } = readContainer(abs);
unwrapMekWithPassword(header, password); // throws WrongCredentialError on bad pw
const existing = findSession(abs);
if (existing && fs.existsSync(existing.workingDir)) {
  return { vaultPath: abs, workingDir: existing.workingDir };
}
```

### C3. Decrypted plaintext lands in a world-readable temp dir with a predictable name

`src/core/sessions.ts` → `makeWorkingDir`:

```ts
const rand = Math.random().toString(36).slice(2, 10); // NOT cryptographic, predictable
const dir = path.join(os.tmpdir(), "shadow-bit", `${base}-${rand}`);
fs.mkdirSync(dir, { recursive: true }); // default perms (often 0755)
```

Two problems:

1. **Predictable name** via `Math.random()` enables a symlink/pre-creation race in the shared `/tmp` (another user pre-creates `shadow-bit/<base>-<guess>` as a symlink to a directory they control, capturing the decrypted files).
2. **Permissions** are the process umask default (commonly world-readable `0755`), so other local users can read the decrypted files.

**Fix:**

- Use `fs.mkdtempSync` with `crypto.randomBytes` and restrictive mode:

```ts
import * as crypto from "crypto";
const parent = path.join(os.tmpdir(), "shadow-bit");
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
const dir = fs.mkdtempSync(path.join(parent, `${base}-`));
fs.chmodSync(dir, 0o700);
```

- `mkdtemp` guarantees a fresh, exclusively-created directory (no race), and `0o700` blocks other users.

### C4. Windows path-traversal in the bundle unpacker

`src/core/bundle.ts` → `unpackDir` sanitizes only forward-slash `/` segments and only strips `..`:

```ts
const safeRel = entry.path
  .split("/")
  .filter((p) => p && p !== "..")
  .join("/");
const abs = path.join(destDir, safeRel);
```

A malicious/corrupt vault with a manifest entry like `..\\..\\..\\Windows\\System32\\evil.dll` is treated as a **single segment** (no `/` to split on, and it isn't literally `..`), passes the filter, and on Windows `path.join` interprets the backslashes → **write outside the working dir**. Absolute paths (`C:\...`, `/etc/...`) and drive letters are also not rejected.

**Fix:** normalize both separators, reject absolute paths and drive letters, and verify the resolved path stays inside `destDir`:

```ts
const cleaned = entry.path.replace(/\\/g, "/");
const safeRel = cleaned
  .split("/")
  .filter((p) => p && p !== "." && p !== "..")
  .join("/");
const abs = path.resolve(destDir, safeRel);
const rel = path.relative(destDir, abs);
if (!safeRel || rel.startsWith("..") || path.isAbsolute(rel)) {
  throw new Error(`Unsafe path in bundle: ${entry.path}`);
}
```

---

## 🟠 High

### H1. Attacker-controlled scrypt params → DoS / resource exhaustion

The header is plaintext, unauthenticated, and attacker-controlled (the whole point is that vaults are shared). `unwrapMekWithPassword` feeds `header.kdfParams` straight into `scryptSync`:

```ts
deriveKeyFromPassword(password, salt, header.kdfParams); // N/r/p from the file
```

A crafted vault can set `N`, `r`, or `p` to huge values. With the hard-coded `maxmem: 512 * 1024 * 1024`, memory-heavy values throw (mislabeled as "incorrect password"), but CPU-heavy combinations (large `p`, or `N` just under the memory ceiling) can hang the process — a denial-of-service when merely _opening_ a file someone sent you.

**Fix:** validate KDF params against sane bounds before deriving, and reject anything outside them:

```ts
function assertKdfParams(k: KdfParams) {
  const okN =
    Number.isInteger(k.N) &&
    k.N >= 16384 &&
    k.N <= 1 << 20 &&
    (k.N & (k.N - 1)) === 0;
  if (!okN || k.r < 1 || k.r > 32 || k.p < 1 || k.p > 16 || k.keyLen !== 32) {
    throw new Error("Unsupported or unsafe KDF parameters in vault header.");
  }
}
```

### H2. Header version and magic are never validated

`readContainer` parses the JSON header but never checks `header.version` against `CURRENT_VERSION`, nor `header.magic`. A future/incompatible or malformed header is processed as if valid, producing confusing failures deep in crypto instead of a clear "unsupported version" error.

**Fix:** after parsing, assert `header.version === CURRENT_VERSION` (or a supported range) and `header.magic === "SHDBIT"`; throw a descriptive error otherwise.

### H3. Recovery key derivation uses unsalted single-round SHA-256

`crypto.ts`:

```ts
export function deriveKeyFromRecovery(recoveryKey: string): Buffer {
  return crypto
    .createHash("sha256")
    .update("shadowbit-recovery-enc:" + norm)
    .digest();
}
```

The recovery key has ~200 bits of entropy so this is not _practically_ breakable, but it deviates from best practice: it is unsalted (identical recovery keys → identical wrapping keys) and derived with a fast hash. It's also inconsistent with the password path (which correctly uses scrypt).

**Fix:** derive the recovery wrapping key with a KDF and a per-vault salt (reuse `header.salt` or add `header.recovery.salt`), e.g. `scrypt(recoveryKey, salt)` or at minimum HKDF-SHA256 with the vault salt as the info/salt. Keep the current path for reading old vaults if you bump the format version.

### H4. Whole-file / whole-payload in-memory model limits size and enables OOM

- `packDir` reads every file with `readFileSync` and `Buffer.concat`s them; `openVault`/`closeVault` hold the full plaintext + ciphertext in memory. Vaults larger than a few hundred MB (Node `Buffer` cap ~2 GiB) will fail or OOM.
- `unpackDir` trusts `entry.size` and slices the buffer by offset with no bounds checking; a corrupt manifest can produce truncated/overlapping reads silently.

**Fix (short term):** document a max recommended vault size and add a guard that throws a clear error above a threshold. Validate that `offset + entry.size <= bundle.length` for every entry. **Long term:** stream to/from disk instead of buffering whole payloads.

---

## 🟡 Medium

### M1. `readHeader` reads the entire file

`container.ts` `readHeader` calls `readContainer`, which does `fs.readFileSync` of the whole file (payload included) just to return the header. `getInfo` then also `statSync`s. For large vaults, `info`/`list` become needlessly slow and memory-heavy.

**Fix:** read only `MAGIC + length + header` bytes using a file descriptor (`fs.openSync`/`fs.readSync`) and stop before the payload.

### M2. `sessions.json` has no locking or corruption recovery

Concurrent CLI/GUI operations do read-modify-write on `~/.shadow-bit/sessions.json` with no lock — interleaved runs can drop or duplicate sessions. A partially-written file is silently treated as "no sessions" (the `catch` returns `[]`), which can orphan a working directory full of plaintext.

**Fix:** write atomically (write to `sessions.json.tmp` then `rename`), and consider a simple lockfile. On parse failure, back up the bad file rather than silently discarding.

### M3. `header.magic` inconsistency

`container.ts` writes the binary magic `"SHDBIT\x00\x01"` but `vault.ts` sets `header.magic = "SHDBIT"`. Harmless today only because `header.magic` is never checked (see H2). Pick one and validate it.

### M4. No password strength / empty-password enforcement in the core

`createVault`/`changePassword` accept any string, including `""`. The CLI guards empty via `promptNewPassword`, and the GUI checks `!password`, but a caller using `--password ""` or the core API directly can create an effectively unprotected vault.

**Fix:** enforce a minimum policy (non-empty, minimum length) in the core, not just the frontends.

### M5. Piped passwords are silently trimmed

`prompts.ts` `nonTtyQuestion` does `.trim()` on each line, and `promptHidden` falls back to it for non-TTY stdin. A scripted password with leading/trailing whitespace is altered, so a vault created interactively may not open when the password is piped (and vice-versa).

**Fix:** do not trim password input. Only trim where trimming is intended (y/N confirmations, the "saved" prompt). Read password lines raw.

### M6. `discardVault` requires no authentication

Anyone with local access can `shadow-bit discard <vault>` (or click Discard in the GUI) and destroy all unsaved changes in an open session without the password. It's destructive-without-auth.

**Fix:** require confirmation (CLI already does for delete; add for discard) and/or the password before erasing session changes.

---

## 🟢 Low / Polish

- **L1. Publishing metadata missing.** `package.json` has no `license`, `repository`, `homepage`, `bugs`, or `keywords`, and there is no `LICENSE` file. `npm publish` will warn and the app has no license terms. Add `"license": "MIT"` (or chosen license) plus a `LICENSE` file.
- **L2. `author` is a placeholder** (`"shadow-bit"`). Set a real author/org.
- **L3. Electron hardening.** `webPreferences` sets `contextIsolation: true` / `nodeIntegration: false` (good) but not `sandbox: true`. Add `sandbox: true` and consider `spellcheck: false`. CSP is present and reasonable.
- **L4. No `will-navigate` / `setWindowOpenHandler` guard.** Add handlers in `main.ts` to block the renderer from navigating away or opening arbitrary external windows (defense-in-depth even with local content).
- **L5. `packDir` double-stats each file** (`lstatSync` in `walk`, then `statSync` again for mode). Reuse one stat.
- **L6. Symlinks are silently skipped** by `walk`. This is a reasonable safety choice but is undocumented and means seeding/closing silently loses symlinked content. Document it (ties into AGENTS.md "Gotchas").
- **L7. `secureEraseFile` is best-effort** on SSD/APFS/CoW (already documented) — keep the caveat prominent in user-facing docs since the `--shred` UX implies stronger guarantees than the storage layer provides.
- **L8. No automated tests.** For a crypto tool this is the biggest process risk. Add round-trip tests (create→open→close→open, wrong password, recovery flow, tamper-detection, path-traversal rejection). Even a small `node:test` suite run in CI would catch regressions in the format.
- **L9. `resolveVaultPath` forces a `.vault` suffix** even when the user passes an existing extension-less path; edge case only, but worth a note.
- **L10. GUI `create` flow** doesn't force acknowledgement of the recovery key (the CLI has the "type saved" step). Consider gating the modal's dismissal behind an explicit "I saved it" that's the only way to proceed.

---

## Suggested remediation order

1. **C1** delete `.env`, rotate the exposed key.
2. **C2, C3, C4** fix the auth-bypass, temp-dir hardening, and path-traversal (core security correctness).
3. **H1, H2, H3, H4** validate untrusted header input and harden recovery-key derivation (bump format version if you change derivation — add migration/back-compat read path).
4. **M1–M6** robustness and correctness.
5. **L1, L2, L8** licensing/metadata + a test suite before `npm publish` / `electron-builder` release.

## What's already good

- Clean envelope-encryption design; AES-256-GCM gives authenticated encryption (tamper detection).
- Password change re-wraps only the MEK (fast) — intentional and documented.
- `WrongCredentialError` deliberately conflates "wrong password" and "tampered", avoiding an oracle.
- Electron uses context isolation + preload allow-list + CSP.
- Sessions store only paths/timestamps, never secrets.
- The project builds cleanly (`tsc --noEmit` passes).

---

## Post-remediation review

A follow-up review of the implemented changes confirms the project builds
cleanly (`tsc` passes), the full build (incl. asset copy) succeeds, and the new
`npm test` suite passes **14/14**. All items above are addressed and covered by
tests:

| Area                | Status                                                                | Test coverage                                         |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| C1 `.env` secret    | ✅ deleted; ignored; documented in `SECURITY.md`                      | n/a                                                   |
| C2 auth bypass      | ✅ password verified before session reuse                             | "wrong password fails even when a session exists"     |
| C3 temp dir         | ✅ `mkdtempSync` in `0700` parent, `chmod 0700`                       | round-trip tests                                      |
| C4 path traversal   | ✅ reject absolute/drive/`..`/escaping paths                          | "path-traversal bundle entries are rejected"          |
| H1 KDF DoS          | ✅ `assertKdfParams` bounds N/r/p/keyLen                              | "unsafe/oversized scrypt params rejected"             |
| H2 version/magic    | ✅ `parseHeader` validates both                                       | "unsupported version" / "bad header magic"            |
| H3 recovery KDF     | ✅ salted scrypt (v2); legacy read path kept                          | "legacy v1 vaults still open/recover"                 |
| H4 in-memory bounds | ✅ `MAX_PAYLOAD_SIZE` + per-entry bounds checks                       | "corrupt entry sizes are rejected"                    |
| M1–M6               | ✅ all implemented                                                    | header-only read, discard-auth, password policy tests |
| L1–L10              | ✅ all addressed (LICENSE, metadata, Electron hardening, tests, docs) | —                                                     |

### Follow-up suggestions (minor, non-blocking)

These were found while reviewing the fixes. None block committing/publishing;
they are polish items to schedule afterwards.

- **F1. `discardVault` regression when the vault file is missing.** It now calls
  `readHeader(abs)` before erasing, so if the `.vault` file was moved/deleted
  while a session is open, the stale session and its plaintext temp dir can no
  longer be cleaned up via `discard` (it throws `ENOENT` before
  `removeSession`). **Fix:** if the vault file is gone, fall back to erasing the
  working dir and removing the session (there is nothing to authenticate
  against anyway), or add a `--force` escape hatch.
- **F2. Version bump without re-salting a legacy recovery escrow.**
  `changePassword`/`recoverVault` set `header.version = 2` even when the vault
  still carries a v1 (saltless, SHA-256-derived) recovery blob. It is
  functionally correct because unwrapping keys off the presence of
  `recovery.salt` rather than the version number, but a "v2" header should
  ideally not contain v1-style escrow. **Fix:** re-derive/re-salt the recovery
  escrow on upgrade, or only bump the version once the escrow is actually v2.
  At minimum, add a code comment explaining the intentional decoupling.
- **F3. Author vs. LICENSE mismatch / PII exposure.** `package.json` `author`
  is a real corporate email (`lucian.vuc@sap.com`) while `LICENSE` attributes
  copyright to "ShadowBit contributors" and is dated **2026** (future).
  Before a public `npm publish`: align the copyright holder with the author,
  fix the year, and decide whether a corporate email should appear publicly in
  the npm registry.
- **F4. `.env.example` is `.gitignore`d.** Example/template files are normally
  committed so contributors know what variables exist. Harmless today (no such
  file exists), but reconsider ignoring it if you later add one.

---

## Second follow-up (2026-09-10) — KDF cost, legacy-escrow upgrade, CLI tests, CI

The Phase 10 open items were closed in this batch. Status per item:

- **LICENSE year (F3).** ✅ Verified correct — the first commit is dated
  **2026-09-08**, so `LICENSE`'s year `2026` matches the project's actual
  copyright start year and needs **no change**.
- **`.env.example` recovery-key storage (F4).** ✅ Rewritten: the `RECOVERY_KEY`
  variable was removed entirely, and the template now carries a loud warning
  that secrets (including recovery keys) must never be persisted in env files.
  The file is committed but intentionally contains no secret variables.
- **KDF default cost (H1 follow-up).** ✅ `assertKdfParams` kept as the
  anti-DoS gate, and `DEFAULT_KDF_PARAMS.N` was raised to **2¹⁷ (131072)** —
  new vaults are written at that cost while legacy vaults keep the N stored in
  their own header (the 2¹⁴ floor in `MIN_KDF_N` still accepts them). As a
  side-effect bug fix, `changePassword`/`recoverVault` now store
  `header.kdfParams = DEFAULT_KDF_PARAMS` after re-wrapping the MEK, so a
  legacy vault's password change/recovery re-keys it at the default cost **and**
  the vault stays openable.
- **Legacy v1 recovery-escrow upgrade (F2 follow-up).** ✅ New
  `upgradeRecoveryEscrow(vaultPath, recoveryKey)` re-salts a format-v1 escrow
  in place, bumps the container to version 2, and keeps the **same** recovery
  key valid (H3's salted-scrypt derivation, retrofitted to existing v1 vaults).
  Exposed non-interactively via `recovery-key --upgrade [--recovery-key <key>]`.
- **CLI tests (L8 follow-up).** ✅ `src/test/cli.test.ts` adds 6 integration
  tests that spawn the real CLI (`node --import tsx src/cli/index.ts`) against
  an isolated `SHADOWBIT_CONFIG_DIR` — lifecycle round-trip, error paths,
  scriptable recover/change-password, and the `--upgrade` escrow flow. The
  suite is now **25 tests** (`npm test`), and `.github/workflows/ci.yml` runs
  `npm ci` + `npm run build` + `npm test` on every push/PR across Node 20/22.
- **GUI smoke tests (L10/Phase 6).** Still outstanding — no change.
