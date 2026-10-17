# AGENTS.md

## What this is

TypeScript CLI + Electron desktop app for creating encrypted, shareable `.vault` files. Single package (no monorepo). `src/core/` is the shared crypto engine; `src/cli/` and `src/gui/` are the two frontends.

## Build and run

```bash
npm install
npm run build          # tsc → dist/, then copies GUI static assets
npm run cli <args>     # run CLI directly via tsx (no build needed)
npm run gui            # build + launch Electron
npm run gui:dev        # launch Electron without rebuilding
```

- `npm run build` = `tsc` + `scripts/copy-assets.js`. The copy step is required because renderer HTML/CSS/JS are plain files, not compiled by tsc.
- `tsconfig.json` excludes `src/gui/renderer/**/*.js` from compilation — those are hand-written.
- `npm run package[:mac|win|linux|dir]` builds distributable installers via electron-builder into `release/`.
- `npm run icons` regenerates app icons from `scripts/gen-icon.js` + `scripts/make-icons.sh`.

## Tests

```bash
npm test              # node:test suite in src/test/ (security + round-trip) — 99 tests
npm run test:cli-e2e  # real-subprocess CLI coverage (e2e/cli.test.ts) — 36 tests
npm run test:gui      # Electron + Playwright GUI tests (e2e/smoke.test.ts) — 26 tests
npm run test:gui:headless  # same suite, forced virtual display (Xvfb)
npm run test:a11y     # WCAG 2.2 AA + keyboard/focus/target-size (e2e/nfr.a11y.test.ts) — 38 tests
npm run test:responsive # XS/SM/MD/LG/XL reflow (e2e/nfr.responsive.test.ts) — 16 tests
npm run test:perf     # asset budget + interaction cost (e2e/nfr.performance.test.ts) — 7 tests
npm run test:site      # docs/ self-containment: no CDN, offline, file://, Q&A integrity (e2e/nfr.site.test.ts) — 10 tests
npm run test:nfr      # a11y + responsive + perf + site (headless Chromium) — 71 tests
npm run verify        # build + all of the above. Use this before shipping.
```

`npm test` and `npm run test:gui` are deliberately separate: the GUI suite
launches a real Electron window, which is the only coverage of the preload
bridge, the worker thread, and the native dialogs. **Prefer `npm run verify`**
so the GUI suite is never silently skipped.

**Electron has no headless mode on Linux, and this is not fixable with flags.**
`--headless=new` dies at `GtkStyleContext without a display connection`;
`--ozone-platform=headless` SIGSEGVs before the first window — both verified
against a _minimal_ BrowserWindow app, so neither is a ShadowBit bug. The only
thing that works is a virtual X server, so `e2e/display.ts` provisions Xvfb when
there is no `DISPLAY` and tears it down in `after()`. `npm run test:gui` auto-
detects (no behaviour change on a desktop or on macOS CI);
`npm run test:gui:headless` sets `SHADOWBIT_HEADLESS=1` to force the virtual
display even when one exists, which is how the `gui-headless` CI job proves the
path. Do not "optimise" the wait loop back into a blocking sleep: `Atomics.wait`
starves the event loop, and the child's `error`/`exit` events are exactly what
reports a missing binary — a blocking version fails by 10s timeout instead of
ENOENT immediately.

A failed `before()` hook is reported by node:test **once per top-level suite, at
the end** of the TAP stream, so the 26 per-test `cancelledByParent` lines above
it say nothing about the cause. `smoke.test.ts` therefore prints the real reason
to stderr before rethrowing. Keep that ordering.

```bash
npm run package:dir   # then, on a machine with a display:
npm run test:packaged # smoke-test the PACKAGED artifact, not dist/
```

`test:packaged` exists because every other suite drives `dist/` over a plain
Electron launch, which misses the one class of defect only packaging causes:
a file that is needed only once the app lives inside an asar. The vault worker
is the sharpest case — `vault-worker-bridge.ts` finds `dist/core/vault-worker.js`
relative to its own `__dirname`, so if that (or the bundled renderer assets,
or the preload) fell outside the `files` globs in package.json, every vault
operation would fail in a shipped build and nowhere else. It also asserts the
DevTools menu item is absent and the tightened CSP shipped. Run it before a
release, and note that it is platform-specific: it looks for `release/linux-unpacked`, `release/mac-arm64`, `release/mac` (electron-builder names the mac directory after the architecture) and `release/win-unpacked`, in that order.

The three NFR suites run against the **real renderer DOM/CSS/JS** in headless
Chromium, not Electron. Two reasons: the page's strict CSP (`script-src 'self'`)
blocks injecting axe at runtime, and the Electron window has `minWidth: 640`, so
XS/SM widths are unreachable. `e2e/nfr/browser.ts` serves `src/gui/renderer/`
over HTTP with a stubbed preload bridge (`e2e/nfr/stub-bridge.js`) and loads axe
same-origin. Do not weaken the CSP to make an Electron-based axe run work —
`e2e/smoke.test.ts` pins the `640x480` minimum that justifies the split.

When asserting target size, use axe's `target-size` rule rather than a raw
`getBoundingClientRect()` comparison: 2.5.8 accepts a sub-24px target when a
24px circle around it clears every other target, and a bbox check reports those
as false positives. `.checkbox input` is 20px and relies on that exception.

CI (`.github/workflows/ci.yml`) runs on every push/PR: `build-and-test` on
ubuntu-latest across a Node 20/22 matrix (core/CLI + CLI E2E), then a
`gui-headless` job on ubuntu-latest (apt-installs Xvfb and runs
`test:gui:headless`), then a `gui-smoke` job on macos-latest that installs
Playwright and runs the GUI smoke, a11y, responsive, and performance suites.
`.github/workflows/release.yml` gates tag pushes on both jobs before packaging
(it references the job id `gui-smoke` — keep it).

When you bump a constant that a test asserts against (e.g. `CURRENT_VERSION`),
have the test import it rather than hardcoding the number — a hardcoded
version assertion is what let the GUI suite go stale for several releases.

**One derivation for the app version, shared by the writer and the checker.**
`scripts/version-literals.js` is the only place that knows which files carry a
hand-maintained version literal (docs site `meta.version`, the
`docs/index.html` badge, the AppImage/NSIS names in `docs/data.js` and
`QUICKSTART.md`) and what shape each one takes. `npm version <a.b.c>` runs
`scripts/bump-version.js` via npm's `version` lifecycle, which imports that
module; so does the consistency assertion in `e2e/cli.test.ts`. Do not
re-derive the rules in a second place — a script and a test that spell out the
rules separately will drift from each other while both look correct, which is
the bug this replaced.

- A site is defined by the literal text **immediately before and after** the
  number (`before` / `after`), and `transform` fills the gap. That is not
  decoration: the badge is `v1.0` while everything else is `1.0.0`, so a
  find-and-replace over bare version-shaped text either misses it or mangles
  it. Anchoring on both sides also makes "did I find it?" exact — a vanished
  anchor is a reported failure, not a silent no-op that looks like success.
- `transform` returns the version portion **only**. The badge's leading `v` is
  part of its `before`, so returning `v1.0` would emit `vv1.0`. Scan and
  compare together (`scanLiterals` carries each site's `want`) so a site
  cannot be found by one rule and judged by another.
- `assertVersionLike` refuses to rewrite anything that is not version-shaped.
  These are anchors into live docs text; a mis-anchored regex would otherwise
  rewrite arbitrary content silently.
- Nothing here touches `src/core/container.ts`. `CURRENT_VERSION` is the
  container format version, not the app version, and `npm version` must never
  move it.
- `node scripts/bump-version.js --check` (also `npm run check-version`) is a
  no-write drift check for CI; it exits 1 and names file:line.

The old test also silently missed `ShadowBit Setup <version>.exe` in
`QUICKSTART.md` — it only scanned for the AppImage name. The shared module lists
every site explicitly, so a site cannot go unchecked because someone forgot to
extend a regex.

There is no linting config and no typecheck-only script; `npm run build` runs
`tsc` and is the typecheck.

## Architecture notes

- `src/core/vault.ts` is the main orchestrator — all high-level operations (create, open, close, change-password, recover, delete, add) flow through it.
- `src/core/container.ts` handles the binary `.vault` file format (magic `SHDBIT\0\1`, plaintext header + encrypted payload). `readHeader` reads only the header via a file descriptor; magic/version are validated. The payload normally runs to end-of-file; the optional header field `payloadLen` pins it, and **only** a hidden-volume container sets it. That is what lets `openVault` read the outer volume of a hidden container — the file has padding and a second encrypted volume bolted on after the outer ciphertext, so reading to EOF hands GCM a corrupted input and the decoy password opens nothing. `parseHeader` must reject a non-integer `version`: the `v < 1 || v > 3` range test is false for `NaN`, so `version: {}` used to pass validation and propagate.
- `src/core/crypto.ts` owns the cryptographic primitives — scrypt KDF, AES-256-GCM, MEK/recovery-key derivation. It is the only place that chooses _algorithms_; `fsutil.ts`, `vault.ts`, `localkey.ts` and `hidden.ts` import `crypto` too, but only for `randomBytes`, hashing, HMAC and the AEAD wrappers it exports. KDF params from the header are clamped/validated (`assertKdfParams`) before use. `DEFAULT_KDF_PARAMS.N` is now `1 << 17` (2^17) — new vaults are written with that cost; legacy vaults keep the N stored in their own header and still open because `assertKdfParams` accepts the old 2^14 floor (`MIN_KDF_N`).
- `src/core/sessions.ts` tracks open vaults via a JSON file. Only paths are stored, never secrets. Writes are atomic (tmp+rename) and the whole read-modify-write cycle runs under an advisory `O_EXCL` lock (`withSessionsLock`) so concurrent CLI/GUI processes cannot lose an update; backoff uses `Atomics.wait` rather than spinning. Corrupt files are backed up, not silently dropped. Location overridable via `SHADOWBIT_CONFIG_DIR`.
- **A zero-byte lock file is a LIVE lock, not a stale one.** `fsutil.withAdvisoryLock` (shared by `sessions.ts` and `settings.ts`) can observe a lock in the window between the atomic `O_EXCL` create and the write of the pid/timestamp, when it is still zero bytes. `readFileSync` returns `""` for that — it does _not_ throw — so parsing it as `0` yields the epoch, every contender judges a lock that is held _right now_ to be infinitely stale, deletes it, and enters the critical section unprotected. Two concurrent read-modify-write cycles then clobber each other's fields. The rule: only a readable, **non-zero** timestamp that is genuinely old makes a lock stale; anything else means someone is mid-claim, so wait. Abandoned locks must still be reclaimed, or a process killed mid-section wedges the registry forever. This is the same zero-length window `localkey.ts` guards, for the same reason.
- `src/core/localkey.ts` owns the machine key that encrypts `sessions.json` and the settings file at rest. First-run creation is claimed with an `O_EXCL` open (`"wx"`), not an unconditional rename: with N processes starting against an empty config dir, only the winner's key goes on disk and every loser must **read the winner's key back** instead of keeping its own cached copy, otherwise it writes data nothing can ever decrypt. `getLocalKey()` is cached per process, so the race is only reachable at startup — covered by the multi-process test in `src/test/core.test.ts`, which uses a shared wall-clock barrier because staggered process boot does not reproduce it.
- `src/core/bundle.ts` is a dependency-free directory-to-buffer archive (no tar/zip dependency). It also owns `compressBundle` / `decompressBundle`, which both `vault.ts` and `hidden.ts` use — one definition of the deflate level and of the `maxOutputLength` expansion cap, so a hidden volume cannot inflate past a limit the outer path enforces. Three things to know about it:
  - `emptyBundle()` is the canonical "no contents" payload, shared by `vault.ts` and `hidden.ts`. An empty vault must still be a well-formed bundle — `unpackDir` reads a 4-byte length prefix unconditionally — so do not substitute an empty buffer or a bare `"{}"`; that is exactly the bug that made a seedless hidden volume unopenable.
  - `walk()` and `unpackDir()` skip ShadowBit's own index-suppression markers (`INDEX_SUPPRESSION_MARKERS` in `fsutil.ts`) at the top level only. `suppressIndexing` writes three of the four into the working directory on Linux (`.trackerignore`, `.noindex`, `.hidden`; macOS writes only `.metadata_never_index`, and Windows writes none because it uses a file attribute), so without this they were packed on every close and returned on every open: dotfiles no user created, permanently, in every vault. A nested `docs/.noindex` is ordinary user content and is preserved.
- `src/gui/renderer/` is vanilla HTML/CSS/JS (no framework, no bundler). The preload bridge (`src/gui/preload.ts`) exposes a typed `window.shadowbit` API via `contextBridge`.
- The application menu is built in `src/gui/main.ts` on **every** platform (macOS just gets the app menu in front) and is rebuilt whenever the state it reflects changes: recent vaults feed `File > Open Recent`, the theme feeds `View > Appearance`, and the renderer pushes the open-vault count after every sessions refresh so `File > Lock All Vaults` greys out when there is nothing to lock. Items whose effect is a UI change are forwarded to the renderer as `app:menuCommand` (buffered until `did-finish-load`, so an early `Cmd+N` is not dropped); only the operations that need no keys — locking, recents, theme — run in the main process. A menu item must never take a password: anything that authenticates belongs behind the worker like every other vault operation.
- `e2e/nfr/stub-bridge.js` must mirror the preload API surface **and its return shapes**. `renderer.js` calls the bridge at load time, so a method added to `preload.ts` and missing from the stub throws before any handler is wired up and fails the whole NFR suite for an unrelated-looking reason. The subtler failure: `main.ts` wraps every vault/settings handler in `wrap()`/`wrapWorker()`, which return `{ ok: true, value }` / `{ ok: false, error }`, and `result()` in the renderer unwraps them. A stub returning the bare value makes _every_ vault action fail with `Unknown error` — silently, because nothing asserted on it. Keep `ENVELOPED` in that file in sync with the handlers; file dialogs, listeners and fire-and-forget commands return raw values by design.
- **State the media preference; never clear the override.** `emulateMedia({ x:
null })` means "whatever the host OS reports", not "off". The macOS CI runner
  has Reduce Motion enabled, so a probe asserting motion is _present_ after a
  `null` reset found none and failed with a message pointing at the probe
  instead of the environment. `styles.css` really does neutralise motion under
  `prefers-reduced-motion: reduce`, which is why "no motion" and "broken probe"
  are indistinguishable unless the preference is stated explicitly. Reproduce
  it locally with `chromium.launch({ args: ["--force-prefers-reduced-motion"] })`
  rather than waiting for CI to tell you again.

- A test that injects DOM into the live page must clean up after itself. An un-closed modal is a full-viewport overlay that swallows the clicks `switchTab` makes, and injected markup is audited by the next test — so one failure cascades into unrelated suites and buries the real defect. `resetInjectedDom()` in `e2e/nfr.a11y.test.ts` exists for this and every `describe` calls it.
- `src/gui/main.ts` performs **no** vault I/O and handles **no** key material. Every vault operation — including `info`, `sessions`, `addFiles`, `setMeta` and the in-app file browser (`listFiles` / `deleteFile` / `renameFile`) — is dispatched to the worker thread via `vault-worker-bridge.ts`. The bridge has no synchronous fallback on purpose: falling back would put keys back on the main thread. The main thread only owns UI concerns (window lifecycle, dialogs, clipboard, and the auto-lock/quit guards, which read the session list).
- **Auto-lock measures _inactivity_, not "time since the last vault command."** The renderer forwards activity through `app:activity`, throttled to one message per 20 s, and the window's own `focus` event counts too. The timer used to reset only on vault IPC traffic, so a user editing files in their working folder — idle as far as ShadowBit was concerned — got locked out with their unsaved changes erased. The settings control already said "after idle", so this makes the behaviour match the label.
- **Lock-everything runs on the worker, not the main thread.** `vault.lockAllOpenVaults()` is dispatched as the `lockAll` op. Securely erasing working directories means overwriting every decrypted byte on disk; done in `main.ts` it froze the entire UI for the length of the wipe, including the toast reporting that it had happened.
- **Saved window bounds are clamped to a display that still exists** (`usableWindowBounds()`). A monitor can be unplugged between runs, and restoring an off-screen x/y produces a window the user cannot reach — indistinguishable from the app failing to start.
- **Every IPC handler is registered through `handle()`/`on()` in `main.ts`, which check the sender frame** against the bundled renderer's URL. `contextIsolation` + `sandbox` mean a renderer compromise cannot reach Node, but it can still call any exposed bridge method, and several handlers take a filesystem path. A blanket search-and-replace over `ipcMain.handle(` once rewrote the body of `handle()` itself into infinite recursion and silently unregistered every channel — count `^handle(` plus `^on(` in `main.ts` after any such sweep.
- **`SHADOWBIT_E2E_TEST` is inert in a packaged build** (`IS_E2E` also requires `!app.isPackaged`). Without that gate it was a one-env-var way to disable the quit guard, the auto-lock timer, and every confirmation dialog.
- **Never trust a path that came from the renderer.** `files:delete` used to `rmSync --recursive` whatever directory the renderer named, so any script running in the renderer could delete any directory the user could reach, and `files:list` could walk the whole filesystem. All three now go through `vault.listWorkingDir` / `deleteFromWorkingDir` / `renameInWorkingDir`, which call `resolveOpenWorkingDir` to match the folder against the session registry and then operate on the _registry's_ path, never the caller's. Add the same check to anything new that takes a path from the renderer.
- **Paranoid mode warns about metadata, it does not forbid it.** `createVault({paranoid})` strips `meta` and pins header timestamps to epoch. `setMeta` on such a vault _succeeds_ and returns `{ vaultPath, paranoid: true }` — the CLI prints a warning and the GUI shows a persistent one. Refusing was tried and reverted: it made a mode the user chose years ago a one-way door, and wanting a description on a paranoid vault is not a mistake. What must never happen is a silent success, because the mode exists to keep optional plaintext out of a header anyone can read. `isParanoidHeader` identifies such a vault by its epoch `createdAt` — the same signal `touchModified` uses — rather than by a flag that could disagree with the timestamps it describes. If you add a frontend, honour `paranoid` in the result; the core test and the CLI E2E test both assert it.
- **`sys:copySecret` must never be made unconditional.** It compares the clipboard against the value it wrote and only clears on a match, so "the user copied something else in the meantime" is not data loss. The recovery-key modal used to call `copy("")` on acknowledgement — wiping whatever was there — and now does not; the 30 s timer it duplicated is the only clear.
- **The sessions list must not be rebuilt when nothing changed, and must not be
  emptied before the data arrives.** `refreshSessions` used to set
  `list.innerHTML = ""` and _then_ await `api.sessions()`, so the list was empty
  for the whole round-trip, and it rebuilt unconditionally — meaning merely
  switching to the Sessions tab wiped any password the user had typed into a
  card. It now fetches first, then rebuilds only when a signature over the
  displayed fields (vaultPath, workingDir) actually changes; the count pushed to
  the main process is still sent every time, because that drives File > Lock All
  Vaults independently of the DOM. This is what makes the DOM stable enough for
  a test to hold a handle across it — but tests should use locators, not
  `page.$` handles, anyway: `$` on a detached node returns null, which is how a
  slow runner failed a `assert.ok` with no other symptom.

- **A live working directory is a moving target.** `walk()`, `listWorkingDir` and `copyDirNoSymlinks` each `lstat` an entry that may have been deleted between `readdir` and the stat, because the user is still editing the folder. All three swallow that one failure and continue; the alternative is a `close` or a file-browser listing that fails wholesale over a file the user deleted a second ago.

## Gotchas

- **The container extension is `.svlt`, and it is cosmetic — never a format input.** It was `.vault` until the 1.0.0 rebrand; `VAULT_EXT`/`LEGACY_VAULT_EXT`/`VAULT_EXTS`/`hasVaultExt` in `src/core/container.ts` are the single source of truth, and every frontend must read them rather than hardcoding a suffix. `.vault` was dropped because it is claimed by several unrelated tools (HashiCorp, Bitwarden), so the OS picker groups every vault family's files under one filter and double-click opens someone else's app; `.vlt` was rejected because it is _WinVault's_ container extension and also VLC's skin extension. `.svlt` has no known association. Identification is by MAGIC bytes, so `openVault` accepts any suffix and a pre-rename `.vault` opens, renames, and closes unchanged — there is no migration and there must never be one. `fileAssociations` in package.json registers **only** `svlt`: claiming `.vault` system-wide would recreate the exact collision the rename exists to avoid.

- **The pre-1.0 rebrand is a hard format break.** The container magic, the recovery-key domain-separation strings, the config directory, and the environment variables were all renamed for the rebrand. `.vault` files written by pre-1.0 builds are rejected as corrupt, and there is no state migration. Don't reintroduce a compat shim unless a migration is requested; if it is, gate it on the magic bytes, not the version.
- **Don't confuse "no pre-1.0 read path" with "v1 is unsupported."** Those are different things and conflating them produces false guarantees. `MIN_SUPPORTED_VERSION = 1`, so v1, v2, and v3 containers all parse and open; what pre-1.0 files lack is the _current magic_, so they fail the magic check, not the version check. A v1 container written by a 1.0+ build carries the new magic and still opens.
- Password change does **not** re-encrypt the payload — only the MEK is re-wrapped. This is intentional and fast, but means the ciphertext is unchanged. `changePassword`/`recoverVault` do re-wrap the MEK at the current default scrypt cost (`DEFAULT_KDF_PARAMS`, now N=2^17) and record `kdfParams` in the header, so a legacy vault's password change/recovery also upgrades its KDF cost.
- Secure erase is best-effort: SSDs, APFS, and copy-on-write FSes may retain old data. This is documented, not a bug.
- **Secure erase must never follow a symlink.** `secureEraseFile` used `statSync`/`openSync`, both of which resolve links, so erasing a working folder that contained a link overwrote the _link's target_ with random bytes — irreversibly destroying a file that was never in the vault. It now `lstat`s: a link is unlinked, its target untouched, and `secureEraseDir` uses `withFileTypes` so it never recurses through a linked directory. This runs on close, discard, delete and GUI auto-lock, so it is reachable without anyone thinking about symlinks.
- Sessions file persists across CLI runs. If you see "vault is not open" errors, check for stale sessions.
- The `shadow-bit` shell script at the repo root is a convenience launcher for the CLI. It prefers `node_modules/.bin/tsx src/cli/index.ts` (no build needed) and falls back to `node dist/cli/index.js`.
- **The app version and the container format version are unrelated numbers, and both appear as "Version".** `package.json` `version` is the shipped app (`1.0.0`); `CURRENT_VERSION` in `src/core/container.ts` is the `.vault` file format (`3`). They were the same number in an earlier build, which is how `shadow-bit --version` came to disagree with `package.json` — and how `npm version` nearly overwrote the format version. Do not "fix" one by copying the other.
  - The app version is `package.json`, read at runtime — **never hardcoded**. The CLI's `readAppVersion()` parses `package.json` from `__dirname/../..`, which resolves correctly from `src/cli/` (tsx) and `dist/cli/` (compiled) alike. It cannot be a static `import` because `rootDir` is `src/` and a JSON import from outside it fails the build.
  - `docs/` must run over `file://`, so it cannot read `package.json` — `meta.version` in `docs/data.js`, the `version-badge` in `docs/index.html`, the `ShadowBit-<version>.AppImage` install snippets, and the `ShadowBit Setup <version>.exe` Windows snippet (electron-builder's NSIS name includes the version) are literals kept in step by the version-consistency test in `e2e/cli.test.ts`. Bump `package.json` and that test tells you which of them to update.
  - `vault info` prints the **container** version; `e2e/cli.test.ts` asserts against `CURRENT_VERSION` (imported, not hardcoded) for that output, not against the app version.
- Container format version is now **3**. `CURRENT_VERSION = 3` in `src/core/container.ts` is the single source of truth — import it rather than hardcoding it.
  - **v3** adds the authenticated header (`header.headerMac`: HMAC-SHA256 over the canonical header JSON, keyed by a HKDF-derived HAK), the keyfile flag (`keyfileRequired`), and cipher agility (`header.cipher`, default `aes-256-gcm`). Every write path goes through `attachHeaderMac`, so all re-writes produce a valid MAC. `verifyHeaderMac` runs on open and rejects header tampering (KDF downgrade, salt swap).
  - **v2** introduced the salted scrypt recovery escrow (`header.recovery.salt`).
  - **v1** used an unsalted single-round SHA-256 recovery derivation. The code path (`deriveKeyFromRecovery` in `crypto.ts`) is retained. Pre-1.0 files carry the old magic and are rejected, but a v1 container written by a 1.0+ build _does_ reach it — so `upgradeRecoveryEscrow` is live, not vestigial. `upgradeRecoveryEscrow(vaultPath, recoveryKey)` re-salts a legacy v1 escrow in place (bumps the version, keeps the SAME recovery key valid) and is exposed as `recovery-key --upgrade [--recovery-key <key>]`.
- `maybeBumpVersion` is the only honest version-bump: it claims the current version only once nothing v1-style remains, because a header cannot claim v2/v3 while still carrying an unsalted v1 escrow. **Every** write path that rewrites the header WITHOUT replacing the escrow goes through it — `closeVault`, `changePassword`, `recoverVault`, `removeRecoveryKey`, `setMeta`. (`closeVault` used to assign `CURRENT_VERSION` unconditionally, which stamped v3 over a v1-style escrow it had just copied through untouched; it now uses `maybeBumpVersion`.) The only two that assign it directly are `regenerateRecoveryKey` and `upgradeRecoveryEscrow`, and that is correct there: both replace the escrow with a freshly salted one in the same call, so nothing v1-style can survive. **A new write path must go through `maybeBumpVersion` unless it replaces the escrow.**
- The whole payload is buffered in memory and the container is capped at `MAX_PAYLOAD_SIZE` (1.5 GiB) in `src/core/bundle.ts`. There is no streaming; a ~1 GB vault needs roughly 2 GB of RAM.
- That cap bounds the **compressed** size only, so `decompressBundle` must pass `maxOutputLength` to `zlib.inflateSync`. A legitimately compressible vault (a sparse image, a log of zeros) expands by three orders of magnitude; without the cap, opening it asks Node for tens of gigabytes in one allocation and the process dies with a heap OOM instead of an error naming the vault. Over-large expansion is reported separately from corruption, because the vault is fine.
- **Key material lives in process memory for the duration of an operation**, and an open vault's plaintext sits in `$TMPDIR/shadow-bit/`. There is no `mlock` / core-dump suppression — see "Threat model" in `SECURITY.md`. Full-disk encryption is the actual mitigation.
- Passwords are enforced in the core: minimum 8 characters (`MIN_PASSWORD_LENGTH` in `src/core/vault.ts`), enforced on create/change/recover — not just in the CLI/GUI.
- **Discard requires the password** (and CLI confirmation): `discardVault(vaultPath, password)` verifies the credential before erasing the decrypted working dir. If the vault file itself is gone, it skips auth (nothing to authenticate against) and still cleans up the stale session/dir.
- Symlinks (and special files) are **silently skipped** by `packDir`/`walk` — seeding or closing a folder containing symlinks loses them. This is a deliberate safety choice. `copyInto` (used by the `add` command and GUI drag-and-drop) **rejects** symlinks with an explicit error rather than silently dropping them. Note the asymmetry with secure erase, which _removes_ links rather than following them.
- **Electron does not implement `window.prompt`, and `window.confirm` always resolves `false`.** Verified against the shipped Electron, not assumed: `prompt()` throws "prompt() is and will not be supported", so the file browser's rename threw on every attempt, and `confirm()` silently made delete a no-op. Never reach for the browser primitives in this app — use `askConfirm()` (the native `dialog:confirm` bridge) for yes/no and `askText()` (the in-app `#prompt-modal`) for input. A modal must also be registered with `trapEscape`; `askText` manages the per-invocation `modal:dismiss` listener, but `trapEscape` is what turns the keypress into that event, and without it Escape does nothing.
- **Status toasts: errors persist, everything else auto-hides.** A failed operation used to vanish after four seconds, before a slow reader or a screen reader had finished with it. `toast(msg, "err")` stays until replaced or clicked; `toast()` sets `data-persistent`, which is also what re-enables pointer events (a fixed overlay at the bottom centre otherwise swallowed clicks on the primary button).
- **Electron is pinned to `^44`** (as of the 1.0.0 release). Do not downgrade
  without reading this: two APIs this app depends on changed shape on the way
  up, and both now sit in `main.ts` in a form that works on 32 and 44. Reverting
  either re-introduces a live bug rather than just an old style.
  - `clipboard.readText()` / `writeText()` are **async** (they mirror the W3C
    async clipboard API). The old `if (clipboard.readText() === text)` became
    `Promise === string` — always false — so the recovery-key clipboard
    auto-clear **silently never fired**. `sys:copySecret` handles both shapes with `void Promise.resolve(clipboard.readText()).then(...)`. If you
    ever "simplify" that back to a direct comparison you remove the only thing
    clearing a recovery key off the clipboard.
  - `app.dock` is typed as possibly-undefined and is macOS-only, hence
    `app.dock?.setIcon(...)`.

  To move to a newer major: bump the dep, then run `npm run verify` **and**
  `npm run package:dir && npm run test:packaged`. Expect `tsc` to surface more
  breaks — everything under `BrowserWindow`/`webContents` has tightened types
  across majors.

- **macOS and Windows artifacts cannot be built on Linux.** macOS requires a
  macOS host (Xcode toolchain for the `.app` bundle, `codesign`, notarization);
  electron-builder refuses the target otherwise. Windows NSIS is closer — it
  builds from Linux but needs `wine` for the `rcedit` icon/metadata step, which
  is not installed here. Both also need a ~100 MB+ platform-specific Electron
  download. Build and sign those on their own OS.
- **Every flag that carries a secret must warn.** `--password` warned about `ps` and shell history while `--new-password` and `--recovery-key` did not, so the tool's own privacy guidance was contradicted by three of the four secret-bearing flags. All of them route through `warnSecretFlag` in `src/cli/index.ts`. A recovery key is prompted _visibly_, via `getRecoveryKey()` → `prompt()` rather than `promptHidden()`: it is 40 Base32 characters in 8 fixed groups, and a masked field hides exactly the single mistyped character that makes recovery fail. It is still read from the prompt rather than `argv`, so it never reaches shell history.
- Opening reuses an existing session's working dir but **always re-verifies the password** first (no auth bypass).
- **Every operation that authenticates against an existing vault must accept and forward `keyfiles`.** `effectivePassword()` _throws_ when `header.keyfileRequired` is set and no keyfile is passed, so a dropped `keyfiles` argument does not degrade gracefully — it makes a keyfile vault impossible to delete, shred, re-password, rotate its recovery key, or edit its metadata. This bit `delete`, `shred`, `change-password`, and `recovery-key` in both frontends while the core already supported it; `meta` then kept the same gap in the CLI long afterwards, because the flag had been registered on every such command _except_ that one. Checking "does the core support it?" is not the same as checking "does every frontend pass it?" — a flag can be missing from one of four call sites and everything else looks correct. When you add a vault operation, thread `keyfiles` through _all_ of `src/core/vault.ts` → `vault-worker.ts` → `gui/main.ts` → the renderer card, and add it to the lifecycle test in `src/test/core.test.ts`.
- `changePassword`'s `newKeyfiles` defaults to the current `keyfiles`. Re-wrapping the MEK under a bare password while leaving `keyfileRequired` set produces a header that demands a keyfile the wrap never used — unopenable both with and without it. Dropping the requirement requires an explicitly empty array.
