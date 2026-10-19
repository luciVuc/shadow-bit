# ShadowBit

**Stealth containers. Enhanced privacy. Total control.**

ShadowBit creates **encrypted, shareable `.svlt` files** — a single self-contained file
you can email, drop on a USB stick, or send as an attachment. The recipient needs only
that one file plus the password to open it — nothing else, no account, no cloud, no
software installation beyond ShadowBit itself.

Available as both a **CLI** and an **Electron desktop app**, sharing the same
cryptographic core.

---

## How it works

A vault is one binary file. The header is plaintext (no secrets); the payload is
AES-256-GCM ciphertext. Everything needed to decrypt is in the file — except your
password.

```
myvault.svlt
┌─────────────────────────────────────────────────────────┐
│ HEADER (plaintext JSON)                                  │
│   magic, version, KDF params, per-vault salt             │
│   password-wrapped MEK (Master Encryption Key)           │
│   optional recovery-key-wrapped MEK                      │
│   IV + GCM auth tag    keyfileRequired?    cipher        │
│   headerMac (HMAC-SHA256 over entire header)             │
├─────────────────────────────────────────────────────────┤
│ PAYLOAD (ciphertext)                                     │
│   AES-256-GCM( deflate( bundle of all your files ) )    │
└─────────────────────────────────────────────────────────┘
```

- **Envelope encryption** — a random 256-bit MEK encrypts your files. The MEK is
  wrapped by a key derived from your password via scrypt. Changing the password only
  re-wraps the MEK — instant, regardless of vault size.
- **Authenticated encryption** — AES-256-GCM detects wrong passwords and any
  tampering or corruption as a decryption failure.
- **Authenticated header** — an HMAC-SHA256 over the entire header (derived from the
  MEK via HKDF) prevents silent header manipulation.
- **Recovery key** — an optional high-entropy Crockford Base32 key that independently
  unlocks the vault if you forget the password. Shown once at creation; stored only as
  a salted scrypt-wrapped copy of the MEK plus a verification hash.
- **Extension is cosmetic** — `.svlt` exists only to name the file and claim a file
  association. Identification is by magic bytes, so any filename works: a vault
  renamed to `.vault` (this app's pre-1.0 suffix) or to no extension at all opens
  and closes normally. There is no migration, and there is no need for one.
- **Self-contained** — every parameter needed to decrypt lives inside the file. No
  registry, no side files, no external state.

Opening a vault decrypts it to a **temporary working folder** you edit with your
normal file manager. Closing re-encrypts that folder back into the file and wipes the
working directory.

---

## Setup

```bash
npm install
npm run build      # tsc → dist/, then copies GUI static assets
```

Requires Node.js 20+.

**End users do not need any of this.** The packaged desktop app is downloaded
from the [website](https://shadowbit.app) (`docs/index.html#install`), and the
CLI installs with `npm install -g shadow-bit`. Everything below this line is
contributor documentation.

---

## CLI usage

Run via the launcher (`./shadow-bit`) or `node dist/cli/index.js`.

### Core workflow

```bash
# Create a vault (prompts for password; prints a one-time recovery key)
./shadow-bit create secret

# Seed from an existing folder
./shadow-bit create secret --seed ./my-files

# Open → decrypt to a temp working folder (path is printed)
./shadow-bit open secret

# ... add / edit files in that folder ...

# Close → re-encrypt the folder back into secret.svlt, wipe temp dir
./shadow-bit close secret

# Throw away unsaved changes (wipes temp dir without saving)
./shadow-bit discard secret

# Show metadata without decrypting
./shadow-bit info secret

# List currently open vaults
./shadow-bit list
```

### Password and credential management

```bash
# Change the password (only re-wraps the MEK — instant)
./shadow-bit change-password secret

# Reset a forgotten password using the recovery key
./shadow-bit recover secret

# Generate a NEW recovery key (invalidates the old one)
./shadow-bit recovery-key secret

# Remove the recovery key (password becomes the only way in)
./shadow-bit recovery-key secret --remove

# Upgrade a legacy v1 recovery escrow to v2 salted derivation
# (same key stays valid — just re-salts the escrow)
./shadow-bit recovery-key secret --upgrade
```

### File management

```bash
# Copy files/folders into an open vault (then close to save)
./shadow-bit add secret ./report.pdf ./photos/

# Get or set plaintext metadata (name / description). Allowed on --paranoid
# vaults too, but it warns: that mode keeps the header free of plaintext.
./shadow-bit meta secret
./shadow-bit meta secret --name "Tax 2025" --description "All receipts"

# Clean up stale sessions (orphaned working dirs)
./shadow-bit clean
```

### Deletion

```bash
# Delete the vault file (requires password)
./shadow-bit delete secret

# Overwrite bytes with random data before deleting
./shadow-bit delete secret --shred
./shadow-bit shred secret              # alias

# Skip confirmation; control overwrite passes
./shadow-bit shred secret -y --passes 7
```

### Advanced security options

```bash
# Use a keyfile as a second factor (required for all future opens)
./shadow-bit create secret --keyfile ~/Documents/key.bin

# Every command that authenticates against the vault accepts --keyfile.
# `open` remembers it for the session, so `close`/`discard` find it
# automatically — but the one-shot commands need it again.
./shadow-bit open  secret --keyfile ~/Documents/key.bin
./shadow-bit close secret
./shadow-bit change-password secret --keyfile ~/Documents/key.bin
./shadow-bit recovery-key  secret --keyfile ~/Documents/key.bin --remove
./shadow-bit meta         secret --keyfile ~/Documents/key.bin --name "Tax 2026"
./shadow-bit delete secret --keyfile ~/Documents/key.bin --yes

# Choose the encryption algorithm at creation
./shadow-bit create secret --cipher chacha20-poly1305

# Paranoid mode: strip timestamps and metadata from the plaintext header
# (timestamps are set to epoch; meta.name/description are omitted)
./shadow-bit create secret --paranoid

# Non-interactive / scripting. Prefer the env var: --password is deprecated
# because it exposes the password to other users via `ps` and to your shell
# history.
./shadow-bit create backup --no-recovery
SHADOWBIT_PASSWORD="$PW" ./shadow-bit open backup
```

> **Changing a password on a keyfile vault.** `change-password` carries the
> current keyfile set over automatically, so the vault stays openable the same
> way. Pass `--new-keyfile` to change the keyfile, or `--new-keyfile` with an
> empty list to drop the keyfile requirement entirely. Never re-wrap a vault
> under a bare password while `keyfileRequired` is still set — the header would
> demand a keyfile that the new wrap never used, and the vault could be opened
> neither with nor without one.

### Hidden volumes (plausible deniability) — core API only, not shipped

The core implements VeraCrypt-style hidden volumes: a fixed-size container that
holds two independent encrypted volumes. The outer volume is shown when the
duress password is given; the inner (hidden) volume is shown only with the real
password. An attacker who compels disclosure of the outer password cannot prove
the hidden volume exists.

> **Status: not reachable from the app.** `src/core/hidden.ts` is imported by
> nothing — there is no CLI subcommand and no GUI path. It does have
> library-level tests in `src/test/core.test.ts`, so the crypto works, but
> nothing a user runs ever calls it. Treat this as unfinished work, not a
> shipped feature. See "Unreachable code" in [SECURITY.md](SECURITY.md).

```bash
# (Node API — no dedicated CLI subcommand yet; see src/core/hidden.ts)
import { createHiddenVault, openHiddenVolume } from "./src/core/hidden";

createHiddenVault({
  vaultPath: "container.svlt",
  outerPassword: "decoy-password",
  hiddenPassword: "real-password",
  totalSize: 64 * 1024 * 1024,   // 64 MiB fixed-size container
  outerSeedDir: "./decoy-files",
  hiddenSeedDir: "./real-files",
});

// Open the real data
const { header, payload } = openHiddenVolume("container.svlt", "real-password");
```

Both volumes read through the ordinary code path: `shadow-bit open
container.svlt` with the duress password unpacks the decoy files normally, and
`shadow-bit info` reads the outer header. The container declares its outer
payload length so the padding and hidden volume that follow it do not corrupt the
outer ciphertext.

Because of that, `close`, `change-password`, `recover`, `setMeta` and
`regenerate-recovery-key` **refuse** to run on a hidden container rather than
silently rewriting it without the hidden tail — which would make the hidden
volume unrecoverable and shrink the fixed-size decoy to a few hundred bytes,
itself proof that a hidden volume had existed.

### Steganography — core API only, not shipped

Embed a vault inside an image, PDF, or any binary file. Standard viewers open
the carrier normally; ShadowBit finds the vault by scanning for its magic bytes.

> **Status: not reachable from the app.** `src/core/stego.ts` is imported by
> nothing — no CLI subcommand, no GUI path. Library-level tests cover
> embed/extract, but nothing a user runs ever calls it, and it does not validate
> the carrier file's type. See "Unreachable code" in
> [SECURITY.md](SECURITY.md).

```bash
# (Node API — see src/core/stego.ts)
import { embedVault, extractVault } from "./src/core/stego";

embedVault("photo.jpg", header, payload, "photo-with-vault.jpg");
const container = extractVault("photo-with-vault.jpg");  // → { header, payload }
```

---

## Desktop app (Electron)

```bash
npm run gui        # build + launch
npm run gui:dev    # launch without rebuilding
```

**Tabs:**

| Tab             | What it does                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open**        | Browse for a `.svlt` file, enter password + optional keyfile, open. Working folder launches automatically in Finder/Explorer.                                                                       |
| **Create**      | Choose a save path, set a password, optionally seed from a folder, generate a recovery key. **Advanced options** (collapsed): cipher algorithm, keyfile second factor, paranoid mode.               |
| **Manage**      | View info, change password, recover with recovery key, regenerate or remove recovery key, delete or shred the vault.                                                                                |
| **Open Vaults** | All active sessions. Drag files/folders onto the drop zone, or use **Add Files…**. Enter password → **Close & Save** or **Discard**. Keyfiles are remembered from open time — no need to re-browse. |

**Menu:**

| Item                       | Shortcut             | What it does                                                                      |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| **File ▸ New Vault…**      | `Cmd/Ctrl+N`         | Switches to the Create tab and opens the save dialog.                             |
| **File ▸ Open Vault…**     | `Cmd/Ctrl+O`         | Switches to the Open tab and opens the file dialog.                               |
| **File ▸ Open Recent ▸ …** | `Cmd/Ctrl+Shift+1…9` | Prefills the Open tab with that vault. Also has **Clear Recent Vaults**.          |
| **File ▸ Lock All Vaults** | `Cmd/Ctrl+Shift+L`   | Erases every working folder at once (asks first). Greys out when nothing is open. |
| **View ▸ Appearance**      | —                    | Match System / Light / Dark — ticked to match the current theme.                  |
| **Settings…**              | `Cmd/Ctrl+,`         | Auto-lock duration and theme.                                                     |

`Cmd/Ctrl+R`, zoom and full screen live under **View**; DevTools is only offered
in unpackaged builds. The menu bar is built on Windows and Linux too, not just
macOS.

---

## Building distributable apps

```bash
npm run package          # current OS
npm run package:mac      # macOS .dmg + .zip
npm run package:win      # Windows NSIS installer
npm run package:linux    # Linux AppImage + .deb
npm run package:dir      # unpacked app folder (fastest, for testing)
```

Output lands in `release/<platform>/<version>/` — for example
`release/linux/1.2.3/` — rather than one flat directory. `scripts/package.mjs`
passes `--config.directories.output` to electron-builder for this; the
committed config in package.json still owns _what_ gets built, and the version
comes from package.json so the directory cannot disagree with the build inside
it.

Scoping by platform _and_ by version matters for two reasons. electron-builder
writes bookkeeping files under fixed names — `builder-effective-config.yaml`,
`latest*.yml`, `builder-debug.yml` — regardless of what produced them, so a
shared directory leaves each one ambiguous and prone to travelling with the
wrong release. And because every version gets its own directory, rebuilding or
re-testing an older version on the same machine cannot overwrite a newer
build's artifacts.

macOS builds are unsigned by default; for distribution outside your own machine
you'll need a Developer ID certificate.

The artifact names produced here are the exact names the website's download
buttons link to, so the two must agree:

Each directory holds the installers for one version of one platform:

| Platform              | Artifact                                                         |
| --------------------- | ---------------------------------------------------------------- |
| macOS (Apple Silicon) | `ShadowBit-<version>-arm64.dmg`                                  |
| macOS (Intel)         | `ShadowBit-<version>-x64.dmg`                                    |
| Windows               | `ShadowBit Setup <version>.exe`                                  |
| Linux                 | `ShadowBit-<version>.AppImage`, `shadow-bit_<version>_amd64.deb` |

Those names are version literals in `docs/data.js`, tracked by
`scripts/version-literals.js` — the same module `npm version` writes and the
CLI E2E suite checks. Run `npm run check-version` after a bump.

---

## Website (`docs/`)

The public site is a static, self-contained single page. It opens by
double-clicking `docs/index.html` — no server, no build step, and **zero
network requests at page load**, which is asserted by the site test suite.

```bash
npx --yes serve -l 9090 docs/   # optional local server
```

| Page              | Audience     | Contents                                                                                                      |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `docs/index.html` | End users    | Features, how it works, **downloads**, recipes, Q&A, CLI reference, desktop app, security model, vault format |
| `docs/dev.html`   | Contributors | Build from source, test suites, packaging, source-tree map                                                    |

### Two audiences, two pages

`docs/index.html` deliberately contains **no technology stack**: no Electron,
no Node.js, no npm, no source tree, no build instructions. Someone who came to
encrypt a folder should not have to scroll past a package.json to find the
download button. All contributor content lives on `docs/dev.html`, which is
linked from the site footer only.

This split is enforced by hand, not by tooling: keep it that way when adding a
section. The one exception is the CLI, which is a user-facing interface and is
documented on the main page.

### Cleaning up old builds

`release/` accumulates every version built on the machine. That is deliberate —
no build overwrites another — but it needs pruning eventually:

```bash
npm run clean:release -- --dry-run         # show the plan, delete nothing
npm run clean:release -- --keep 2 -y       # keep the 2 newest per platform
npm run clean:release -- --keep 1 --platform linux
```

`--keep` is required; there is no default and no accidental wipe mode. Anything
in a platform directory that isn't a version directory is reported and left
alone. Without `--yes` it prompts, and on a non-interactive terminal it refuses
rather than guessing.

Deleting local output is safe because it is only a copy: every published build
is attached to its GitHub Release by CI, and that is where the website's
download links point. Artifacts are deliberately _not_ committed to the repo
instead — git is a source store, and the Linux AppImage alone exceeds GitHub's
100 MiB per-file limit for a repository.

### The download section

`docs/data.js` declares `releases` (the published version list, newest first)
and `platforms` (per-OS artifacts and install steps). Download URLs are
**assembled at render time** in `docs/index.js`:

```
https://github.com/<repo>/releases/download/v<version>/<artifact>
```

so a version bump cannot leave a hand-written link pointing at a build that was
never uploaded. The section also:

- **Detects the visitor's platform** from the user agent and opens that tab,
  badged "your platform". It is a hint, never a filter — every tab stays
  visible and one click away.
- **Offers every published version.** Selecting an older one re-points every
  button, re-stamps the artifact file names, and rewrites the `{file}`
  placeholder in the step copy, so the Linux instructions never tell someone to
  `chmod +x` a file they did not download.

`releases.versions` is a hand-maintained list. Adding a release means adding an
entry — the site deliberately makes no GitHub API call, because it must keep
working offline over `file://`.

---

## Project layout

```
src/
├── core/                  # shared, UI-agnostic cryptographic engine
│   ├── crypto.ts          # scrypt KDF, AES-256-GCM, ChaCha20-Poly1305, MEK & recovery
│   │                      # key helpers, keyfile processing, password strength estimation
│   ├── container.ts       # .svlt binary format (magic, header, payload, atomic writes)
│   ├── bundle.ts          # dependency-free directory ↔ buffer archive
│   ├── vault.ts           # high-level orchestrator — all vault operations
│   ├── sessions.ts        # open-vault tracking (encrypted; no secrets)
│   ├── localkey.ts        # local machine key for encrypted session/settings files
│   ├── settings.ts        # user preferences (recent vaults, auto-lock, theme)
│   ├── fsutil.ts          # secure erase, copy helpers, indexing suppression,
│   │                      # filesystem timestamp scrubbing
│   ├── stego.ts           # carrier-file steganography (embed/extract vault in image)
│   ├── hidden.ts          # hidden volume creation and opening (plausible deniability)
│   ├── vault-worker.ts    # worker thread for non-blocking crypto in Electron
│   └── types.ts           # shared type definitions
├── cli/                   # command-line interface (14 commands)
│   ├── index.ts
│   └── prompts.ts
└── gui/                   # Electron desktop app
    ├── main.ts            # main process + IPC handlers
    ├── preload.ts         # secure context bridge (contextBridge)
    ├── vault-worker-bridge.ts
    └── renderer/          # vanilla HTML/CSS/JS — no framework, no bundler
        ├── index.html
        ├── renderer.js
        └── styles.css
```

---

## Security notes

### Cryptography

| Property         | Detail                                                              |
| ---------------- | ------------------------------------------------------------------- |
| Cipher           | AES-256-GCM (default) or ChaCha20-Poly1305 (selectable at creation) |
| KDF              | scrypt — N=2¹⁷ (131 072), r=8, p=1, per-vault random salt           |
| MEK              | 256-bit random master key; wrapped by password-derived key          |
| Header integrity | HMAC-SHA256 over entire header (HKDF-derived from MEK)              |
| Recovery key     | 200 bits entropy, Crockford Base32, salted scrypt escrow            |
| Keyfile          | Any file; its content is mixed into the password derivation         |
| Password minimum | 8 characters, enforced in the core (not just the UI)                |
| Payload cap      | 1.5 GiB; larger vaults are rejected with a clear error              |

### Working directory and privacy

- Decrypted files live in `$TMPDIR/shadow-bit/<vault>-<random>` (mode `0700`)
  while a vault is open. **Close or discard vaults when done** so plaintext is
  not left on disk.
- The working directory is securely erased (single overwrite pass) on close,
  discard, lock and delete. Multi-pass overwrite applies to the vault file
  itself, via `shred` / `--shred` (`--passes`, default 3). Working directory
  file timestamps are scrubbed to epoch on open.
- Vault file filesystem timestamps (atime/mtime) are reset to epoch after every
  write, preventing creation/modification-time leakage.
- OS indexing suppression is applied to the working directory. It is
  best-effort and platform-dependent — each step needs OS support, and `mdutil`
  and `xattr` often require privileges the app does not have:
  - macOS: `.metadata_never_index`, `mdutil -i off`, Time Machine exclusion xattr
  - Windows: `attrib +I /S /D` (recursive NOT_CONTENT_INDEXED)
  - Linux: `.trackerignore` (GNOME Tracker), `.noindex` (KDE Baloo), `.hidden`
- Session and settings files are encrypted with a local machine key
  (`~/.shadow-bit/.local-key`, mode 0600) — no plaintext secrets on disk.
- MEK buffers are zeroed immediately after use, minimising the window in which
  key material sits in memory. ShadowBit does **not** use `mlock` and does not
  suppress core dumps — keys remain in ordinary pageable memory for the duration
  of an operation. See "Threat model" in `SECURITY.md`.
- **Paranoid mode** (`--paranoid` / GUI checkbox): strips timestamps from the
  plaintext header (sets them to epoch) and omits `meta.name`/`meta.description`.
  Metadata can still be added later — `shadow-bit meta` allows it and warns that
  it is now in plaintext, since you may well want a description on a vault you
  made paranoid years ago.

### Limitations

- **Decrypted data on disk while open** — the working folder in `/tmp` is
  plaintext. For hard guarantees, use full-disk encryption (FileVault, BitLocker,
  LUKS) alongside ShadowBit.
- **Key material is held in pageable memory** — derived keys and the MEK live in
  the process for the duration of an operation. ShadowBit does not implement
  `mlock` or core-dump suppression, so the OS is free to page that memory to swap
  or a crash dump. **FDE is the mitigation** — it covers swap, hibernation and
  dumps in one stroke. See "Threat model" in `SECURITY.md`.
- **The payload is buffered in memory** — there is no streaming, and containers
  are capped at 1.5 GiB. A ~1 GB vault needs roughly 2 GB of RAM.
- **Secure erase is best-effort** — on SSDs, APFS, and copy-on-write filesystems
  wear-leveling and snapshots may retain copies. Rely on FDE for hard guarantees.
- **No formal audit** — ShadowBit has not undergone an independent professional
  cryptographic audit. Suitable for personal use and file sharing with a trusted
  party, not for classified or life-critical data.
- **Opening always re-verifies the password** — no auth bypass even if a session
  exists. Discarding requires the password. If the vault file was deleted first,
  discard still cleans up the stale session.

### Format versioning

The container format is **v3** (magic `SHDBIT\0\1`). v1/v2 vaults are readable,
and a write upgrades the vault to v3 — with one deliberate exception: a vault
still carrying a legacy _unsalted_ v1 recovery escrow stays at its current
version, because claiming v2 would assert a salted escrow it does not have.
Re-salt it with `shadow-bit recovery-key <vault> --upgrade` (the recovery key is
prompted **visibly** — it is 40 Base32 characters in fixed groups, and a masked
field hides exactly the one mistyped character that makes recovery fail).
Vaults written by a pre-1.0 build carry a different magic and are rejected as
corrupt (no legacy compat path).

---

## Questions

`docs/index.html` carries a Q&A section — how-to recipes for every feature a
command can actually reach, the exact wording of each error message, and a
plain account of what ShadowBit does **not** do (including why there is no
duress password and no steganography in this build). Open it by double-clicking;
it needs no server and makes no network requests.

The one-sentence version of the most important limits: an open vault's working
folder is plaintext on disk, keys sit in ordinary pageable memory, secure erase
is best-effort on SSDs, and the project has had an internal code review but no
independent audit. See [SECURITY.md](SECURITY.md) for the full threat model.

---

## Environment variables

| Variable               | Effect                                                                           |
| ---------------------- | -------------------------------------------------------------------------------- |
| `SHADOWBIT_PASSWORD`   | Supply the vault password non-interactively (scrubbed from env after first read) |
| `SHADOWBIT_CONFIG_DIR` | Override the default config directory (`~/.shadow-bit`)                          |

---

## Tests

```bash
npm run verify  # everything below — use this before shipping

npm test               # 99 unit/integration tests: crypto, round-trips, edge cases
npm run test:cli-e2e   # 36 real-subprocess CLI tests: every command, flag and error path
npm run test:gui       # 26 Electron + Playwright GUI tests (needs a display)
npm run test:nfr       # 71 non-functional tests in headless Chromium
```

The NFR group covers WCAG 2.2 AA accessibility (38), responsive reflow across
XS/SM/MD/LG/XL (16), a renderer performance/asset budget (7), and docs
self-containment and docs-site Q&A integrity (10). It drives the
real renderer with a stubbed preload bridge rather than Electron, so it runs
headless — see `AGENTS.md` for why.

---

## App icon

```bash
npm run icons   # writes build/icon.png, build/icon.ico, build/icon.icns
```

Generated from code (`scripts/gen-icon.js` + `scripts/make-icons.sh`) — no
design tools needed.
