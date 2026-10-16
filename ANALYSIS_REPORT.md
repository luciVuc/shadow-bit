# ShadowBit — Comprehensive Analysis Report

> **Historical document.** This is a point-in-time audit dated 2025-07-16 and is
> kept as a record of what was found then. Several findings below were fixed
> shortly afterwards, and the version/test figures in this report are **stale**.
>
> Current state: container format **v3**, **232 tests** — 99 core+CLI-unit,
> 36 CLI E2E (real subprocess), 26 GUI, 71 NFR (a11y/responsive/perf +
> docs-site self-containment). See
> `SECURITY_AUDIT.md` for remediation status and `SECURITY.md` for the current
> threat model. Findings marked below as open may since be closed.
>
> Two claims this report made have since turned out to be wrong and were
> corrected rather than left standing: it described the hidden-volume and
> steganography code as delivered, and it reported a passing keyfile lifecycle.
> Hidden volumes and steganography are **still unreachable** from any build —
> `src/core/hidden.ts` and `src/core/stego.ts` are imported by nothing in
> `src/cli/` or `src/gui/`, so they remain unimplemented as user-facing features.
> The keyfile lifecycle, by contrast, was genuinely broken until `63a3087`:
> `delete`, `shred`, `change-password` and `recovery-key` dropped the keyfile
> argument and failed closed, making a keyfile vault impossible to delete.

**Date:** 2025-07-16  
**Version Analyzed:** a pre-1.0 build (container format v2)  
**Codebase:** ~4,139 lines across 34 source files  
**Status at time of audit:** Build ✅ · Tests 27/27 ✅ · npm audit 0 vulnerabilities ✅

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture & Engineering Analysis](#2-architecture--engineering-analysis)
3. [Security & Privacy Analysis](#3-security--privacy-analysis)
4. [Bug & Logic Error Audit](#4-bug--logic-error-audit)
5. [UX/UI Design Analysis](#5-uxui-design-analysis)
6. [End-User Perspective Analysis](#6-end-user-perspective-analysis)
7. [Improvement Suggestions](#7-improvement-suggestions)
8. [Monetization Strategies](#8-monetization-strategies)
9. [Prioritized Action Items](#9-prioritized-action-items)

---

## 1. Executive Summary

ShadowBit is a well-engineered, privacy-first encryption tool that creates portable `.vault` files. The cryptographic core is solid (AES-256-GCM + scrypt envelope encryption), the architecture is clean and layered, and a prior security audit has been thoroughly addressed. The project is in a **strong foundational state** with the core engine fully complete, but has several areas where targeted improvements could significantly enhance production-readiness, user experience, and commercial viability.

### Strengths

- **Excellent crypto design**: Envelope encryption, authenticated encryption, proper KDF with tunable params
- **Self-contained portability**: A single `.vault` file holds everything — genuinely useful
- **Clean separation of concerns**: Core engine is UI-agnostic; CLI + GUI are thin frontends
- **Thorough security audit** already completed with all findings addressed
- **Good test coverage** for the core (27 tests) with proper isolation
- **Atomic writes** protect against data corruption
- **Defense-in-depth** in Electron: contextIsolation, sandbox, CSP, navigation guards

### Key Gaps

- Several real bugs remain (see §4)
- GUI has UX issues and accessibility gaps
- No responsiveness in the Electron app (fixed 640px minimum, no fluid layout)
- Missing features expected by end users (in-app file browser, auto-lock, etc.)
- Documentation site is excellent but the app itself lacks onboarding
- No monetization infrastructure

---

## 2. Architecture & Engineering Analysis

### 2.1 Overall Architecture — ✅ Excellent

The layered architecture is textbook-correct:

```
src/core/   → Crypto engine (pure logic, zero UI)
src/cli/    → CLI frontend (commander + TTY prompts)
src/gui/    → Electron frontend (IPC bridge + vanilla HTML/CSS/JS)
```

**What's done well:**

- Core is dependency-free (only Node `crypto`) — minimizes supply chain risk
- Preload bridge exposes a typed, whitelisted API — no `nodeIntegration` leakage
- The binary container format is well-designed: magic bytes + versioned header + payload
- Atomic write strategy (tmp + rename) in both container and session persistence
- Forward-compatible versioning (v1 read-compat, v2 write path)

### 2.2 Engineering Concerns

| Issue                                       | Severity | Details                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Synchronous crypto on main thread**       | High     | `scryptSync`, `readFileSync`, `writeFileSync` all run on the Electron main process. For vaults > 100MB or on slower hardware, this **freezes the entire UI** (both renderer IPC and window management). The loading overlay helps visually but doesn't prevent the process from becoming unresponsive (macOS beach ball). |
| **Entire payload in memory**                | Medium   | `packDir`/`unpackDir` load the entire vault into RAM. The 1.5 GiB cap is good, but a 1 GB vault still requires ~2 GB of RAM (plaintext + ciphertext simultaneously). No streaming.                                                                                                                                        |
| **Single-process sessions file**            | Medium   | `sessions.json` has no file locking. Two CLI instances or CLI + GUI running simultaneously can race on read-modify-write, losing session entries and orphaning plaintext working dirs.                                                                                                                                    |
| **CommonJS module format**                  | Low      | `tsconfig.json` targets CommonJS. Modern Node/Electron work well with ESM. Not blocking, but limits tree-shaking and aligns with legacy patterns.                                                                                                                                                                         |
| **No structured logging**                   | Low      | All output is `console.log/error`. For a security tool, structured logging with levels would help forensic debugging.                                                                                                                                                                                                     |
| **`commander` is the only prod dependency** | ✅       | Excellent minimal dependency tree.                                                                                                                                                                                                                                                                                        |

### 2.3 Build Pipeline

The build is clean but has minor issues:

- `npm run prebuild` regenerates icons on every `npm run build` — adds 2-3 seconds of overhead. Should be `npm run icons` separately or cached.
- `scripts/copy-assets.js` is a manual CJS script when a glob copy would suffice.
- No type-check-only script (`tsc --noEmit`) for fast CI feedback.
- Source maps are generated (`sourceMap: true`) — fine for dev but should be stripped from production Electron builds.

### 2.4 Test Coverage Assessment

**Covered well:**

- Round-trip encryption/decryption
- Wrong-password rejection
- Tamper detection
- Recovery key flows (v1 legacy + v2 salted)
- Path traversal rejection
- KDF param bounds validation
- Atomic writes
- Symlink rejection
- CLI integration (6 end-to-end tests)

**Not covered:**

- GUI (E2E smoke test exists but is labeled as work-in-progress)
- Concurrent access scenarios (two CLIs on same vault)
- Large file handling / edge cases near 1.5 GiB cap
- Unicode/emoji in file paths and vault names
- Empty directory handling in bundle pack/unpack
- Cross-platform path separator handling (Windows backslash)
- `settings.ts` (recent vaults) — no tests at all
- Password with special characters (Unicode normalization edge cases)

---

## 3. Security & Privacy Analysis

### 3.1 Cryptographic Assessment — ✅ Strong

| Property                   | Implementation                                | Verdict                                       |
| -------------------------- | --------------------------------------------- | --------------------------------------------- |
| **Cipher**                 | AES-256-GCM                                   | ✅ Industry standard authenticated encryption |
| **KDF**                    | scrypt (N=2¹⁷, r=8, p=1)                      | ✅ Memory-hard, cost raised from 2¹⁴          |
| **Key management**         | Envelope encryption (random MEK)              | ✅ Password change is instant (re-wrap only)  |
| **IV generation**          | `crypto.randomBytes(12)` per encryption       | ✅ Fresh, cryptographically random            |
| **Recovery key**           | 200-bit Crockford Base32 + salted scrypt (v2) | ✅ High entropy, proper KDF                   |
| **Password normalization** | NFKC Unicode normalization                    | ✅ Prevents cross-platform inconsistencies    |
| **Anti-tamper**            | GCM auth tag in header                        | ✅ Detects modification                       |

### 3.2 Remaining Security Concerns

| ID     | Issue                                                 | Severity | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S1** | **Password lingers in Node.js string memory**         | Medium   | JavaScript strings are immutable and garbage-collected non-deterministically. The password string passed through IPC, `deriveKeyFromPassword`, and the CLI prompt functions can persist in heap memory long after use. There is no zeroing mechanism. Unlike C where you can `memset(0)`, Node.js offers no guaranteed way to clear string memory. **Mitigation**: Use `Buffer` for password handling where possible; call `global.gc()` hints; document the limitation. |
| **S2** | **MEK is a Node Buffer — better but still not wiped** | Medium   | The decrypted MEK (`Buffer`) is not explicitly zeroed after use in `openVault`/`closeVault`. Buffers are GC'd but not zeroed. A core dump or heap snapshot while the vault is open would expose the MEK. **Mitigation**: `mek.fill(0)` after use in a `try/finally`.                                                                                                                                                                                                     |
| **S3** | **Recovery key hash uses SHA-256 (pre-check only)**   | Low      | `hashRecoveryKey` uses unsalted SHA-256. Since this is only a "friendly pre-check" (the real authentication is the GCM unwrap), it's not a vulnerability, but it does leak a fast-to-brute-force hash of the recovery key in the header. Given 200-bit entropy, this is not practically exploitable, but it's a cryptographic impurity.                                                                                                                                  |
| **S4** | **Clipboard exposure of recovery key**                | Medium   | The GUI's "Copy" button writes the recovery key to the system clipboard, where it persists until overwritten. Any app with clipboard access can read it. **Mitigation**: Clear the clipboard after a timeout (e.g., 30 seconds), add a warning.                                                                                                                                                                                                                          |
| **S5** | **Working directory in OS temp**                      | Low      | Documented and mitigated (0700 mode, mkdtemp), but the OS temp dir is often on the same partition as the swap file. If the system swaps, decrypted data can end up on disk. **Mitigation**: Document; recommend encrypted swap / full-disk encryption.                                                                                                                                                                                                                   |
| **S6** | **No vault integrity check before close**             | Medium   | `closeVault` reads the header from disk, derives the MEK, and re-encrypts. If an attacker swapped the vault file while it was open (TOCTOU), the MEK is derived from the attacker's header. The working directory contents are then encrypted under a key the attacker controls. **Mitigation**: Store a header hash in the session and verify it before close.                                                                                                          |
| **S7** | **`--password` flag visible in `ps aux`**             | Low      | CLI passwords passed via `--password` are visible in the process list. This is documented ("omit the flag gives a safer hidden prompt") but many users won't read that. **Mitigation**: Accept password from environment variable or fd (like `gpg --passphrase-fd`).                                                                                                                                                                                                    |
| **S8** | **No rate limiting on password attempts**             | Low      | Scrypt's cost IS the rate limit (~200ms per attempt), but there's no lockout or exponential backoff for wrong attempts. An attacker with the vault file can brute-force offline anyway, so this is informational.                                                                                                                                                                                                                                                        |

### 3.3 Privacy

- ✅ Sessions store only paths, never secrets
- ✅ Recovery keys are shown once, never stored in plaintext
- ✅ No telemetry, no network calls
- ⚠️ Recent vaults list (`settings.json`) stores absolute paths — could reveal directory structure to someone who gains access to `~/.shadow-bit/`
- ⚠️ The `createdAt`/`modifiedAt` timestamps in the vault header are unencrypted metadata — reveals usage patterns to anyone with the file

---

## 4. Bug & Logic Error Audit

### 4.1 Confirmed Bugs

| ID     | Bug                                                             | Severity | File           | Details                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | **`deleteVault` doesn't require password**                      | Medium   | `vault.ts`     | Unlike `discardVault` (which requires the password), `deleteVault` only checks `readHeader` (valid vault) but never verifies the password. Any local user can `shadow-bit delete <vault>` without authentication. The CLI has `-y` confirmation, but the GUI just shows a native dialog — no password required. This is inconsistent with the discard flow.                                                               |
| **B2** | **`addToSession` doesn't validate paths for traversal**         | Medium   | `vault.ts`     | `copyInto` uses `path.basename(src)` which prevents direct traversal, but if `src` is a directory containing symlinks deeper inside, `fs.cpSync` (used for directories) WILL follow those symlinks. Only the top-level is checked with `lstatSync`.                                                                                                                                                                       |
| **B3** | **Race in `openVault` — session exists but dir is gone**        | Low      | `vault.ts`     | If the working dir was manually deleted after opening, `findSession` returns a session but `fs.existsSync(existing.workingDir)` is false. The code proceeds to create a new working dir and add a duplicate session entry (the old one is filtered by `addSession`'s dedup, but the decrypt + unpack step runs again unnecessarily). Not a bug per se, but the user gets no warning that their previous changes are gone. |
| **B4** | **`resolveVaultPath` adds `.vault` to non-existent files**      | Low      | `cli/index.ts` | `resolveVaultPath('foo')` checks `fs.existsSync('foo')` and if missing, appends `.vault`. But for `create`, the file doesn't exist YET, so `foo` always becomes `foo.vault`. This is correct behavior for create, but for `open foo` where the user has a file named `foo` (no extension), the code checks existence first and correctly uses `foo` — the logic is fine but confusing and undocumented.                   |
| **B5** | **Password confirm in CLI doesn't enforce minimum**             | Low      | `prompts.ts`   | `promptNewPassword` checks `if (!pwd)` (empty string) but delegates the minimum-length check to the core. If the user types a 3-character password and confirms it, `promptNewPassword` returns it, and the core throws. The error message comes from the core but the UX flow is confusing — the user typed the password twice only to be told it's too short. Better to check length at the prompt level too.           |
| **B6** | **GUI `create` doesn't validate password length before submit** | Low      | `renderer.js`  | The GUI checks `if (!password)` but not the 8-character minimum. The core will reject it, but the user gets a generic error toast rather than inline feedback.                                                                                                                                                                                                                                                            |

### 4.2 Potential Logic Issues

| Issue                                        | Details                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session orphan on crash**                  | If the process crashes between `unpackDir` and `addSession`, the working directory exists but has no session entry. It's never cleaned up.                                                                                                                                                                                                                             |
| **`closeVault` reads the entire vault file** | `closeVault` reads the header with `readHeader(abs)` (fd-based, efficient), but the old payload is never used — it's fully replaced. Yet `readContainer` was the original call. The current code is correct (uses `readHeader`), but the vault file's payload bytes are wasted disk I/O if the container is large — actually, it's only `readHeader`, so this is fine. |
| **Timestamp leaks**                          | `createdAt` and `modifiedAt` are set in plaintext. `closeVault` updates `modifiedAt` — this reveals when the vault was last re-encrypted to anyone who has the file, even without the password.                                                                                                                                                                        |

---

## 5. UX/UI Design Analysis

### 5.1 Electron GUI (Desktop App)

#### Layout & Responsiveness

| Issue                                       | Severity | Details                                                                                                                                                         |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fixed max-width panels**                  | Medium   | `.panel { max-width: 620px }` centers content. On wide screens (1440p+), the app feels sparse. On the 640px minimum width, it's cramped. No fluid scaling.      |
| **No responsive breakpoints**               | Medium   | The CSS has zero `@media` queries. Everything is a single-column fixed layout. Tab buttons don't wrap gracefully on narrow windows.                             |
| **Session cards don't wrap action buttons** | Low      | `.session .actions` uses `flex-wrap: wrap` (good), but button sizing is fixed — on narrow widths, buttons stack vertically which is acceptable but not elegant. |
| **No window state persistence**             | Low      | Window position/size isn't saved between sessions. Users must resize every launch.                                                                              |

#### Visual Design

| Issue                                  | Severity | Details                                                                                                                                   |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Dark theme only**                    | Medium   | No light theme or system-preference detection. Accessibility concern for users with certain visual conditions who need light backgrounds. |
| **No visual feedback on file browse**  | Low      | After clicking "Browse…" and selecting a file, only the text input changes. No animation, checkmark, or highlight to confirm the action.  |
| **Password strength bar is tiny**      | Low      | 4px height is barely visible. Could be 6-8px with a label that's more prominent.                                                          |
| **Toast positioning on small windows** | Low      | `position: fixed; bottom: 22px; left: 50%` — on a very small window the toast can overlap the content.                                    |
| **No empty state illustration**        | Low      | The "No open vaults" message is plain text. An illustrated empty state would be more engaging.                                            |

#### Accessibility

| Issue                                    | Severity | Details                                                                                                                                                               |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No ARIA labels on key elements**       | High     | Tab buttons have no `role="tab"`, tab panels no `role="tabpanel"`, no `aria-selected`, no `aria-controls`. Screen readers can't navigate the tab structure.           |
| **No keyboard navigation for tabs**      | High     | Tabs are `<button>` elements (focusable, good), but there's no arrow-key navigation between them (WAI-ARIA Tab Pattern).                                              |
| **No visible focus indicators**          | Medium   | `input:focus` only changes border color. No focus ring on buttons, tabs, or interactive elements.                                                                     |
| **Color contrast issues**                | Medium   | `--muted: #8b91a3` on `--bg: #0f1117` = contrast ratio ~4.8:1 for large text, but hint text at 13px fails WCAG AA (needs 4.5:1 for normal text — this is borderline). |
| **No skip-to-content link**              | Low      | Standard accessibility pattern missing.                                                                                                                               |
| **Recovery key modal has no focus trap** | Medium   | When the modal opens, keyboard focus isn't constrained to it. Users can tab behind the modal to invisible elements.                                                   |

#### Interaction Design

| Issue                                          | Severity | Details                                                                                                                                                  |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No "show password" toggle**                  | Medium   | Password fields have no eye icon to reveal the password. Users can't verify what they typed.                                                             |
| **Recovery key format not validated on input** | Low      | The "Recovery key" input in the Manage tab accepts any string — no format hint, no real-time validation that it matches `XXXXX-XXXXX-…` pattern.         |
| **No auto-focus on tab switch**                | Low      | Switching to the "Open" tab doesn't focus the vault file input or password field.                                                                        |
| **Drag-and-drop zone too small**               | Medium   | The dropzone is a thin bar with small text. Users may not notice it. It should be more prominent, perhaps with an icon and more padding.                 |
| **No undo for destructive operations**         | Medium   | "Delete Vault" and "Discard" show a confirm dialog but there's no undo. The confirm dialog is minimal — it should be more alarming for shred operations. |

### 5.2 Documentation Site (docs/)

The landing page is **polished and professional** — well above average for an open-source project. It uses Tailwind + custom CSS with smooth animations, scroll-spy, responsive layout, and a CLI reference with search.

**Issues:**

- Loads Tailwind via CDN (`cdn.tailwindcss.com`) — won't work offline and is a privacy/tracking concern for a security tool's documentation. **Closed:** the CDN is removed; utilities are vendored in `docs/utilities.css` and the site now makes zero network requests (`npm run test:site`).
- `data.js` sets `window.APP_DATA` — a global. Fine for a simple site but fragile
- The site is static HTML — no SSR, no framework — which is actually a strength for simplicity

### 5.3 CLI UX

**Done well:**

- Hidden password input with masking (`*`)
- Recovery key boxed display is attention-grabbing
- Piped stdin support for scripting
- Human-readable file sizes
- Bare vault names auto-append `.vault`

**Issues:**

- No color output (no chalk/kleur/picocolors) — success/error messages blend together
- No progress indicator for long operations (scrypt takes ~200ms, acceptable, but encrypting a large vault shows nothing)
- `shadow-bit help` doesn't show examples (only flags)
- Error messages from the core are sometimes technical ("Incorrect password or corrupt/tampered vault") — a friendlier "Wrong password. Try again?" would be better

---

## 6. End-User Perspective Analysis

### 6.1 First-Run Experience

**Problem:** There is no onboarding. A new user opening the Electron app sees four tabs with no guidance on where to start. The "Create" tab doesn't explain what a vault is or why you'd want one.

**Suggestion:** Add a first-run welcome screen or tooltip tour that explains the workflow: Create → Open → Edit → Close.

### 6.2 Key User Journeys

| Journey              | Friction Points                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create a vault**   | Must manually choose a save location via file dialog. No "create here" default. Password strength feedback is subtle. Recovery key modal is good but overwhelming.         |
| **Open a vault**     | Must browse for the file every time (recent vaults list helps). No drag-and-drop of .vault file onto the app window.                                                       |
| **Edit files**       | Opens the OS file manager — user leaves the app. No way to see what's in the vault from within the app.                                                                    |
| **Close/save**       | Must switch to "Open Vaults" tab, enter password again (UX friction — the password was already verified on open), click "Close & Save".                                    |
| **Share a vault**    | No built-in sharing mechanism. The user must manually email/transfer the file. This is intentional but a "share" button that opens the OS share sheet would be convenient. |
| **Recover password** | Must switch to "Manage" tab, browse for the vault again, enter recovery key, enter new password twice. Functional but tedious.                                             |

### 6.3 Pain Points

1. **Password re-entry on close**: The user already proved they know the password when opening. Requiring it again to close is secure but frustrating. Consider an optional "keep unlocked until close" session token.
2. **No in-app file browser**: The biggest UX gap. Opening a vault just opens Finder. Users want to see, manage, and preview their files inside the app.
3. **No vault locking on idle**: If a user opens a vault and walks away, the plaintext sits in temp indefinitely. An auto-lock timer would be a significant security improvement.
4. **No indication of vault contents**: From the GUI, there's no way to see what's inside a vault without opening it (decrypting). Even a file count or total size in the info panel would help.
5. **No notification when vault left open**: If the user quits the app with a vault open, there's no warning. The plaintext persists in temp across restarts.

---

## 7. Improvement Suggestions

### 7.1 High Priority (Ship-blockers)

| #   | Improvement                              | Impact                                                                                                                | Effort |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **Move crypto to worker thread**         | Eliminates UI freezes during open/close/create. Critical for vaults > 50MB.                                           | Medium |
| 2   | **Add ARIA attributes to GUI**           | Accessibility compliance. Tab pattern, focus traps, skip links.                                                       | Low    |
| 3   | **Auto-lock timer**                      | Security: auto-close/discard vault after configurable idle period (5/15/30 min).                                      | Medium |
| 4   | **Warn on quit with open vaults**        | `app.on('before-quit')` → show dialog if sessions exist.                                                              | Low    |
| 5   | **Password re-entry skipping for close** | Store a session token (HMAC of MEK + timestamp) in memory — verify on close without re-prompting. Clear on idle/quit. | Medium |
| 6   | **`deleteVault` requires password**      | Consistency with `discardVault`. Prevent unauthorized deletion.                                                       | Low    |

### 7.2 Medium Priority (Polish)

| #   | Improvement                           | Impact                                                                                    | Effort |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| 7   | **In-app file browser**               | Game-changer for UX. Tree view of working dir, rename/delete/preview.                     | High   |
| 8   | **Light theme / system preference**   | Accessibility + user preference. `prefers-color-scheme` media query.                      | Medium |
| 9   | **Show/hide password toggle**         | Standard UX pattern, prevents typo-related lockouts.                                      | Low    |
| 10  | **Payload compression**               | 60-80% size reduction for text-heavy vaults. `zlib.deflateSync` wrapping `packDir`.       | Low    |
| 11  | **Drag vault file onto app to open**  | Listen for drop events on the entire window, not just the dropzone.                       | Low    |
| 12  | **Colored CLI output**                | Use `picocolors` (2KB, no deps) for ✅/❌ colorization.                                   | Low    |
| 13  | **Password via environment variable** | `SHADOWBIT_PASSWORD` for scripting without `ps aux` exposure.                             | Low    |
| 14  | **Vault metadata**                    | Optional plaintext `name`/`description` in header. Useful for organizing multiple vaults. | Low    |

### 7.3 Low Priority (Advanced)

| #   | Improvement                    | Impact                                                                                                     | Effort    |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------- |
| 15  | **Streaming encryption**       | Support vaults > 1.5 GiB. Chunked payload with per-chunk IV/tag. Format v3.                                | High      |
| 16  | **Multi-user vault sharing**   | Multiple password slots (like LUKS), each wrapping the same MEK independently.                             | High      |
| 17  | **Vault sync**                 | Watch the working directory for changes and auto-close/re-encrypt on save.                                 | High      |
| 18  | **Browser-based vault opener** | WebCrypto API implementation of the vault format — open vaults in the browser without installing anything. | High      |
| 19  | **Hardware key support**       | FIDO2/WebAuthn for vault authentication.                                                                   | High      |
| 20  | **Mobile companion app**       | React Native or Capacitor app for opening vaults on iOS/Android.                                           | Very High |

---

## 8. Monetization Strategies

### 8.1 Open-Core Model (Recommended)

Keep the core engine and CLI open-source (MIT). Monetize the desktop app and premium features.

| Tier           | Price                 | Features                                                                |
| -------------- | --------------------- | ----------------------------------------------------------------------- |
| **Free (CLI)** | $0                    | Full CLI, core engine, single-vault operations                          |
| **Personal**   | $29 one-time or $5/mo | Desktop app, in-app file browser, auto-lock, light theme                |
| **Pro**        | $79 one-time or $9/mo | + Multi-user vault slots, vault metadata, compression, priority support |
| **Team**       | $19/user/mo           | + Shared vault management, audit log, admin controls, SSO               |

### 8.2 Alternative Models

| Model                      | Description                                  | Pros                              | Cons                                                            |
| -------------------------- | -------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| **Freemium desktop app**   | App is free, premium features behind paywall | Low barrier to entry              | Harder to convert free→paid                                     |
| **Paid app on app stores** | $9.99 on Mac App Store, Microsoft Store      | Simple, one-time revenue          | App Store fees (30%), limited reach                             |
| **Sponsorware**            | Open-source after funding goal met           | Community goodwill                | Unpredictable revenue                                           |
| **Cloud vault hosting**    | Encrypted vault storage + sharing service    | Recurring revenue, network effect | Requires server infrastructure, contradicts "self-hosted" ethos |
| **Enterprise licensing**   | Site licenses for organizations              | High per-deal revenue             | Long sales cycles, support burden                               |
| **Bounty/donation model**  | GitHub Sponsors, Open Collective             | Zero overhead                     | Not sustainable as primary income                               |

### 8.3 Specific Revenue Opportunities

1. **"ShadowBit Cloud"** — A companion service that stores encrypted vaults in the cloud (S3/R2). Vaults are always encrypted at rest — the server never sees plaintext. Charge for storage. This aligns with the product's security ethos because the server is zero-knowledge.

2. **Enterprise compliance package** — Audit logging, LDAP/SSO integration, admin-managed recovery keys, vault expiration policies. Target regulated industries (healthcare, finance, legal).

3. **Browser extension** — A Chrome/Firefox extension that can decrypt `.vault` attachments directly in webmail (Gmail, Outlook). Free for personal use, $5/mo for business.

4. **API/SDK licensing** — License the vault format as an SDK for other developers to embed encrypted containers in their applications.

5. **"Send Secure" service** — A web interface where someone uploads a file, sets a password, gets a shareable link that delivers a `.vault` file. Free tier: 100MB, 7-day expiry. Paid: 5GB, 30-day, custom branding.

### 8.4 Monetization Readiness Checklist

- [ ] Code signing (Apple Developer Program $99/yr, Windows EV cert ~$300/yr)
- [ ] Auto-update mechanism (electron-updater)
- [ ] License key validation system
- [ ] User analytics (privacy-respecting, opt-in)
- [ ] Landing page with pricing tiers
- [ ] Payment integration (Stripe/Gumroad/LemonSqueezy)
- [ ] Customer support channel (email/Discord)
- [ ] Terms of service + privacy policy

---

## 9. Prioritized Action Items

### 🔴 Critical (Do Before Any Release)

1. **B1**: Require password for `deleteVault` (consistency with discard)
2. **B2**: Make `copyInto` check for symlinks recursively in directory copies
3. **S2**: Zero MEK buffer after use (`mek.fill(0)` in finally blocks)
4. **S4**: Clear clipboard after recovery key copy (30-second timeout)
5. Add `beforeunload` / `before-quit` warning when vaults are open

### 🟠 High (First release)

6. Move crypto operations to a worker thread (unblock main process)
7. Add ARIA attributes for tab navigation (accessibility)
8. Add auto-lock timer for idle vaults
9. Add "show password" toggle to all password fields
10. Add password length validation in GUI before submit
11. Add first-run onboarding screen

### 🟡 Medium (Polish)

12. In-app file browser
13. Light/dark theme toggle
14. Payload compression (zlib)
15. Vault metadata (name/description)
16. Colored CLI output
17. Window state persistence (position/size)
18. Drag-and-drop vault file onto app window
19. Password via environment variable for CLI
20. CI: add Windows + Linux to the matrix

### 🟢 Low (Backlog)

21. Streaming encryption (format v3)
22. Multi-user vault slots
23. Browser-based vault opener
24. Code signing + notarization
25. Auto-update (electron-updater)
26. Vendor Tailwind for docs site (remove CDN)

---

## Appendix A: File-by-File Notes

| File             | Lines | Notes                                                                                   |
| ---------------- | ----- | --------------------------------------------------------------------------------------- |
| `crypto.ts`      | 168   | Clean, well-commented. Consider adding `mek.fill(0)` utility.                           |
| `container.ts`   | 113   | Solid. Atomic writes. `readHeader` is fd-optimized.                                     |
| `bundle.ts`      | 114   | Good traversal guard. Missing: empty dir preservation, symlink handling in directories. |
| `vault.ts`       | 298   | Well-orchestrated. `deleteVault` needs password check.                                  |
| `sessions.ts`    | 76    | No file locking — race condition with concurrent access.                                |
| `settings.ts`    | 85    | No tests. Robust error handling.                                                        |
| `fsutil.ts`      | 56    | `copyInto` doesn't recurse symlink check into directories.                              |
| `prompts.ts`     | 128   | Excellent piped-stdin handling. Password confirm could check length.                    |
| `cli/index.ts`   | 280   | Full command set. Missing colored output.                                               |
| `gui/main.ts`    | 217   | Good Electron hardening. Missing `before-quit` guard.                                   |
| `gui/preload.ts` | 53    | Minimal, typed API. No `any` leak.                                                      |
| `renderer.js`    | 342   | Functional. Missing accessibility, responsive design, theme support.                    |
| `styles.css`     | 225   | Dark-only. No media queries. No focus-visible styles.                                   |
| `index.html`     | 178   | Good CSP. Missing ARIA roles.                                                           |

## Appendix B: Competitive Landscape

| Competitor                | Model      | Difference                                                          |
| ------------------------- | ---------- | ------------------------------------------------------------------- |
| VeraCrypt                 | Free/OSS   | Full-disk/partition encryption. Complex. ShadowBit is file-level.   |
| Cryptomator               | Freemium   | Cloud vault sync. ShadowBit is local-first, self-contained.         |
| 7-Zip (encrypted archive) | Free       | No envelope encryption, no recovery key, no session management.     |
| age (CLI)                 | Free/OSS   | File-level encryption, no container/archive format, no GUI.         |
| Boxcryptor                | Paid (EOL) | Cloud encryption layer. Was acquired by Dropbox. Market gap exists. |

**ShadowBit's unique position:** Self-contained, portable, shareable vault files with a desktop GUI. Simpler than VeraCrypt, more portable than Cryptomator, more polished than age. The "email a single encrypted file" use case is underserved.

---

_Report generated from comprehensive static analysis of the full codebase, build verification, test execution, and manual GUI review._
