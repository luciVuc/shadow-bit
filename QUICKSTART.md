# ShadowBit — Quick Start Guide

> **Stealth containers. Enhanced privacy. Total control.**
>
> ShadowBit encrypts all your files into a single portable `.svlt` file.
> Email it, put it on a USB drive, share it however you like.
> The recipient opens it with ShadowBit and the password you share out-of-band.
> No cloud account, no sign-up, no third party.

---

## Table of Contents

1. [What is ShadowBit?](#what-is-shadowbit)
2. [Installation](#installation)
   - [macOS](#macos)
   - [Windows](#windows)
   - [Linux](#linux)
   - [From source (all platforms)](#from-source-all-platforms)
3. [Core concept](#core-concept)
4. [GUI quick start](#gui-quick-start)
5. [CLI quick start](#cli-quick-start)
6. [Common recipes](#common-recipes)
7. [Advanced security features](#advanced-security-features)
8. [All CLI commands](#all-cli-commands)
9. [Security reference](#security-reference)

---

## What is ShadowBit?

ShadowBit is a **portable encrypted file vault**. You create a `.svlt` file,
put any files or folders inside it, and lock it with a password. The result is a
single file that looks like random bytes to anyone without the password.

**Why use ShadowBit instead of a zip with a password?**

- Zip encryption (ZipCrypto) is weak and easily cracked. ShadowBit uses
  AES-256-GCM with scrypt key derivation — the same class of cryptography used
  by professional security tools.
- Zip files leak metadata (filenames, sizes, timestamps). ShadowBit encrypts
  everything, including file names.
- ShadowBit detects tampered files — AES-GCM is _authenticated_ encryption.

**Why use ShadowBit instead of a cloud-based vault?**

- No account required. No server. No subscription. The vault is just a file.
- It works offline, air-gapped, forever — even if ShadowBit as a project ceases
  to exist (the format is documented and straightforward to implement).

---

## Installation

### macOS

**Desktop app (recommended)**

```bash
git clone https://github.com/lucianvuc/shadow-bit.git
cd shadow-bit
npm install
npm run icons
npm run package:mac
# → release/macos/mac-arm64/ShadowBit.app   (Apple Silicon)
# → release/macos/mac/ShadowBit.app         (Intel — different directory name)
```

Copy `ShadowBit.app` to `/Applications`. First launch: right-click → **Open**
to bypass Gatekeeper (unsigned app).

**CLI only (no packaging)**

```bash
git clone https://github.com/lucianvuc/shadow-bit.git
cd shadow-bit
npm install
chmod +x shadow-bit
./shadow-bit --help
# Optional: add to PATH
echo 'export PATH="$PATH:'"$(pwd)"'"' >> ~/.zshrc && source ~/.zshrc
```

---

### Windows

1. Install [Node.js 20+](https://nodejs.org/) (LTS).
2. Clone and build:
   ```powershell
   git clone https://github.com/lucianvuc/shadow-bit.git
   cd shadow-bit
   npm install
   npm run build
   ```
3. Build the installer:
   ```powershell
   npm run package:win
   # → release\windows\ShadowBit Setup 1.1.3.exe
   ```
4. Run the installer — it places the app in Program Files with a Start Menu shortcut.

**CLI without packaging:**

```powershell
node dist\cli\index.js --help
```

---

### Linux

```bash
# Install Node.js 20+ (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and build
git clone https://github.com/lucianvuc/shadow-bit.git
cd shadow-bit
npm install && npm run build

# Build AppImage
npm run package:linux
chmod +x "release/linux/ShadowBit-1.1.3.AppImage"
./release/linux/"ShadowBit-1.1.3.AppImage"
```

**CLI on Linux:**

```bash
chmod +x shadow-bit
sudo ln -s "$(pwd)/shadow-bit" /usr/local/bin/shadow-bit
shadow-bit --help
```

---

### From source (all platforms)

Skip packaging entirely. Uses `tsx` to run TypeScript directly — no build step
required for the CLI.

```bash
git clone https://github.com/lucianvuc/shadow-bit.git
cd shadow-bit
npm install

./shadow-bit create myvault    # CLI from source
npm run gui                    # GUI from source
```

---

## Core concept

A vault is **one file** — say `project.svlt`. It looks like a blob of random
bytes to anyone without the password. Inside, all your files are encrypted with
AES-256-GCM.

```
project.svlt
┌─────────────────────────────────────────────┐
│ HEADER (plaintext)                           │
│   version, KDF params, salt                 │
│   password-wrapped encryption key           │
│   optional recovery-key-wrapped copy        │
├─────────────────────────────────────────────┤
│ PAYLOAD (ciphertext)                         │
│   AES-256-GCM( all your files + folders )   │
└─────────────────────────────────────────────┘
```

**The workflow is always the same:**

```
create → open → [edit files in working folder] → close
                                                  ↓
                                         vault file updated,
                                         working folder wiped
```

The "working folder" is a temporary directory. Files there are plaintext. When
you `close`, they are re-encrypted into the vault and the folder is securely
deleted.

---

## GUI quick start

```bash
npm run gui          # from source
# or open ShadowBit.app on macOS / run the installer on Windows
```

### Create a vault

1. Click the **Create** tab.
2. Click **Browse…** next to "Save vault as" → choose where to save the `.svlt` file.
3. Enter and confirm a strong password (8+ characters).
4. _(Optional)_ Click **Browse…** next to "Seed from folder" to pre-populate the
   vault with existing files.
5. Leave "Generate a recovery key" checked (strongly recommended).
6. _(Optional)_ Click **Advanced options** to:
   - Switch the **cipher** to ChaCha20-Poly1305 (alternative to AES-256-GCM).
   - Add a **keyfile** — a second factor required to open the vault.
   - Enable **Paranoid mode** — strips timestamps and metadata from the vault header.
7. Click **Create Vault**.
8. A modal shows your **recovery key** — copy it and store it somewhere safe
   (password manager, printed paper). Click **I've saved it**.

### Open a vault

1. Click the **Open** tab.
2. Click **Browse…** → select your `.svlt` file.
3. Enter the password.
4. If the vault requires a keyfile, click **Browse** next to "Keyfile (if required)"
   and select the same file used at creation.
5. Click **Open Vault** → your working folder opens automatically in Finder/Explorer.

### Edit files

Add, edit, or delete files in the working folder using any application. The vault
stays locked — only the working copy is accessible.

### Save and close

1. Click the **Open Vaults** tab.
2. Find your vault in the list.
3. Enter the password → click **Close & Save**.
4. Files are re-encrypted, the working folder is securely wiped, the vault is updated.

> **Note:** Keyfiles are remembered from open time — you don't need to re-browse for
> the keyfile when closing.

### Add files by drag-and-drop

With the vault open, go to the **Open Vaults** tab and drag files or folders onto
the dashed drop zone. Or click **Add Files…**. Then **Close & Save** to commit.

### Manage a vault

From the **Manage** tab:

| Action                    | How                                                                        |
| ------------------------- | -------------------------------------------------------------------------- |
| View info                 | Browse → **Show Info**                                                     |
| Change password           | Enter current + new password → **Change Password**                         |
| Recover with recovery key | Paste key + new password → **Reset Password**                              |
| Generate new recovery key | Enter password → **Generate New Key**                                      |
| Remove recovery key       | Enter password → **Remove Key**                                            |
| Delete vault              | Enter password → **Delete Vault** (check "Shred" to overwrite bytes first) |

---

## CLI quick start

### 1. Create a vault

```bash
# Interactive (prompted for password; shows recovery key)
shadow-bit create project

# Pre-populate from an existing folder
shadow-bit create project --seed ./my-documents

# Skip recovery key
shadow-bit create project --no-recovery

# Non-interactive (scripting). Prefer the environment variable over the
# --password flag: a command-line argument is visible to every user on the
# machine through `ps`, and lands in your shell history.
SHADOWBIT_PASSWORD="$VAULT_PASS" shadow-bit create project
```

Example output:

```
╭─────────────────────────────────────────────────╮
│ RECOVERY KEY — save this somewhere safe!        │
│                                                 │
│ A7KX9-MP2VQ-8NW4T-YF6JB-1HR5C-D3GL0-SZ72M-...  │
│                                                 │
│ You will need this if you forget your password. │
│ It cannot be recovered later.                   │
╰─────────────────────────────────────────────────╯

Type 'saved' to confirm you stored it: saved

✓ Created vault: /Users/alice/project.svlt
```

### 2. Open a vault

```bash
shadow-bit open project
# Password: ••••••••
#
# ✓ Opened. Working folder:
#   /var/folders/.../shadow-bit/project-a1b2c3d4
#
#   Add/edit files there, then run:
#     shadow-bit close project
```

Navigate to the printed working folder path and work normally.

### 3. Add files

```bash
shadow-bit add project ./report.pdf ./photos/ ./notes.txt
# ✓ Added 3 item(s). Run 'close' to save them.
```

Or copy/move files directly into the working folder path.

### 4. Close and save

```bash
shadow-bit close project
# Password: ••••••••
# ✓ Closed. All changes re-encrypted into the vault.
```

The working folder is securely wiped. The `.svlt` file is updated.

### 5. Check status

```bash
shadow-bit list
# OPEN VAULTS:
#   /Users/alice/project.svlt
#     → /var/folders/.../project-a1b2c3d4  (opened 2025-09-09T10:30:00Z)

shadow-bit info project
# Vault:        /Users/alice/project.svlt
# Version:      3
# Size:         84.23 KB
# Recovery key: yes
# Cipher:       aes-256-gcm
# Keyfile:      not required
# Compressed:   yes
# Created:      2025-09-09T10:30:00.000Z
# Modified:     2025-09-09T10:42:11.000Z
# Open:         no
```

Note the `Version: 3` above: that is the **container format** version, not the app
version (`shadow-bit --version`, currently 1.0.0). They are unrelated numbers.

On a `--paranoid` vault the two timestamps read `1970-01-01T00:00:00.000Z`
instead — that is what the mode does, and it is also how a paranoid vault is
recognised later.

---

## Common recipes

### Share a vault with someone

```bash
# Sender
export SHADOWBIT_PASSWORD="$VAULT_PASS"

shadow-bit create shared --no-recovery
shadow-bit open shared
cp ~/Documents/contract.pdf "$(shadow-bit info shared | grep 'Working dir' | awk '{print $3}')/"
shadow-bit close shared
# Email / AirDrop / USB: shared.svlt
# Share the password out-of-band (call, Signal, etc.)

# Recipient
shadow-bit open received.svlt
# Password: agreed-password
# ✓ Opened. Working folder: ...
```

### Recover a forgotten password

```bash
shadow-bit recover project
# Recovery key: A7KX9-MP2VQ-8NW4T-...
# Set new password: ••••••••
# Confirm new password: ••••••••
# ✓ Password reset via recovery key.
```

The recovery key is prompted **visibly**, unlike every other secret — it is 40
Base32 characters in fixed groups, and a masked field would hide exactly the one
mistyped character that makes recovery fail. A wrong key reports
"Incorrect recovery key."; a right one always resets the password, because
recovery only needs the header.

### Rotate the recovery key

```bash
# Generate a brand-new key (old one is immediately invalidated)
shadow-bit recovery-key project
# Password: ••••••••
# ╭─────────────────────────────────────────────────╮
# │ NEW RECOVERY KEY — save this somewhere safe!    │
# │ B2MN7-RQ4XT-...                                 │
# ╰─────────────────────────────────────────────────╯

# Remove it entirely (password is then the only way in)
shadow-bit recovery-key project --remove
# ✓ Recovery key removed.
```

### Delete a vault

```bash
shadow-bit delete project          # plain delete
shadow-bit shred project           # overwrite bytes first (best-effort on SSDs)
shadow-bit shred project -y --passes 7   # 7 passes, no confirmation
```

### Automate with scripts

```bash
# Every command that takes a password reads SHADOWBIT_PASSWORD, and the app
# scrubs it from its own environment after the first read. Prefer it to
# --password, which is deprecated because it is visible in `ps` and lands in
# shell history.
export SHADOWBIT_PASSWORD="$VAULT_PASS"

shadow-bit create backup --no-recovery
shadow-bit open   backup
rsync -av ~/Documents/ "$(shadow-bit info backup | grep 'Working dir' | awk '{print $3}')/"
shadow-bit close  backup
```

> **Unattended recovery is the exception.** `recover` prompts for the recovery
> key and the new password, and reads neither from an environment variable. A
> fully scripted reset therefore needs the deprecated `--recovery-key` and
> `--new-password` flags, which leak through `ps`. Treat that as a reason to
> keep the recovery key out of unattended jobs, not as a reason to script it.

### Clean up stale sessions

If a vault's working directory is missing (e.g. after a crash or reboot), clean
up the orphaned session:

```bash
shadow-bit clean
# ✓ Cleaned 1 stale session(s).
```

---

## Advanced security features

### Keyfile — second factor authentication

A keyfile turns any file (an image, a PDF, a random binary) into a required
second factor. Without both the password **and** the exact keyfile, the vault
cannot be opened.

```bash
# Create with a keyfile
shadow-bit create secret --keyfile ~/keys/my.key

# Open, close, discard
shadow-bit open  secret --keyfile ~/keys/my.key
shadow-bit close secret
```

The keyfile path is stored in the session after `open`, so `close` and `discard`
find it automatically.

The one-shot commands have no session to read it from, so pass `--keyfile`
again:

```bash
shadow-bit change-password secret --keyfile ~/keys/my.key
shadow-bit recovery-key  secret --keyfile ~/keys/my.key --remove
shadow-bit delete         secret --keyfile ~/keys/my.key --yes
```

Forgetting it fails closed — the command errors out with _"This vault requires a
keyfile"_ and changes nothing, so a mistyped path can never delete a vault by
accident.

**Changing the password keeps the keyfile.** `change-password` carries the current
keyfile set over automatically. Use `--new-keyfile <path>` to change it, or an
empty `--new-keyfile` to drop the keyfile requirement. Never strip the
requirement while re-wrapping under a bare password — the header would demand a
keyfile the new wrap never used, leaving the vault unopenable either way.

> **Keep the keyfile separate from the vault.** If both are on the same drive and
> the drive is compromised, the second factor provides no additional protection.
> Store the keyfile on a USB key, a hardware token, or a different device. A lost
> keyfile means the vault is lost — the recovery key cannot substitute for it,
> because the keyfile is hashed into the derived password.

### Algorithm agility — ChaCha20-Poly1305

Choose ChaCha20-Poly1305 instead of AES-256-GCM at creation time. This is a
software-friendly cipher that may be preferable if you distrust hardware AES
acceleration or want diversity against single-algorithm cryptanalytic advances.

```bash
shadow-bit create secret --cipher chacha20-poly1305
```

The cipher is recorded in the vault header. Legacy vaults without a cipher field
are treated as AES-256-GCM (backward compatible).

### Paranoid mode — minimal header footprint

By default, the vault header contains plaintext `createdAt` and `modifiedAt`
timestamps, plus any `meta.name`/`meta.description` you set. This is useful for
vault management but leaks creation/modification timing to anyone who can read
the file.

```bash
# Strip all timing and metadata from the header
shadow-bit create secret --paranoid
```

Paranoid mode:

- Sets `createdAt` and `modifiedAt` to `1970-01-01T00:00:00.000Z` (epoch)
- Omits `meta.name` and `meta.description` even if supplied
- Persists through the vault's lifetime — close and change-password also write epoch timestamps

You can still add a name or description later with `shadow-bit meta`; it is
allowed, and warns you that the text is stored in plaintext in the header —
readable by anyone who has the file. Nothing stops you wanting a description on a
vault you made paranoid years ago.

The cipher, KDF parameters, and key material in the header are unaffected; they
are required for decryption.

> **Tip:** Combine all three for maximum privacy:
>
> ```bash
> shadow-bit create secret --keyfile ~/usb/key.bin --cipher chacha20-poly1305 --paranoid
> ```

### Hidden volumes (plausible deniability) — **not available in this build**

> **There is nothing you can run.** The cryptography exists in the core library
> and is unit-tested, but no CLI subcommand and no desktop control calls it. A
> user cannot create or open a hidden volume with any build of this app, so
> treat it as unfinished work rather than a feature to rely on. See
> "Unreachable code" in [SECURITY.md](SECURITY.md) and `ROADMAP.md` §21.3.

For the record, this is what the library does. A hidden-volume container holds
two independently keyed volumes in a **fixed-size** file: the **outer**
(decoy) volume is what the outer password opens, and the **inner** volume is
reachable only with the hidden password, behind random padding that is
indistinguishable from ciphertext.

```javascript
// Library API only — there is no `shadow-bit hidden …` command.
const { createHiddenVault, openHiddenVolume } = require("./dist/core/hidden");

createHiddenVault({
  vaultPath: "container.svlt",
  outerPassword: "decoy-password", // shown under duress
  hiddenPassword: "real-password", // only when safe
  totalSize: 64 * 1024 * 1024, // fixed size; 8 MiB minimum, 1.5 GiB maximum
  outerSeedDir: "./decoy-files",
  hiddenSeedDir: "./real-files",
});

// Open the real data
const { header, payload } = openHiddenVolume("container.svlt", "real-password");
```

### Steganography (vault inside an image) — **not available in this build**

> **Also unreachable.** `src/core/stego.ts` appends a vault after a carrier
> file's end-of-file so any viewer still opens the carrier normally, and the
> round-trip is covered by tests — but nothing in the CLI or the app imports it,
> so there is no command to embed or extract one. See "Unreachable code" in
> [SECURITY.md](SECURITY.md) and `ROADMAP.md` §21.4.

```javascript
// Library API only — there is no `shadow-bit stego …` command.
const {
  embedVault,
  extractVault,
  hasEmbeddedVault,
} = require("./dist/core/stego");

embedVault("photo.jpg", header, payload, "photo-with-vault.jpg");
// → photo-with-vault.jpg opens normally in any image viewer

hasEmbeddedVault("photo-with-vault.jpg"); // → true
extractVault("photo-with-vault.jpg"); // → { header, payload, stegoOffset }
```

> **What this build does offer.** A `.svlt` file's _contents_ are opaque, and
> `--paranoid` removes timestamps and metadata from its header. It does not
> disguise the file itself: the fixed magic bytes at offset 0 identify it, and
> its size is visible.

---

## All CLI commands

```
shadow-bit create   <name>
  --password <pwd>            supply password (or prompted)  [deprecated]
  --no-recovery               skip recovery key generation
  --seed <dir>                pre-populate from a folder
  --name <text>               plaintext vault name (metadata)
  --description <text>        plaintext description (metadata)
  --keyfile <path...>         keyfile(s) required for all future opens
  --cipher <alg>              aes-256-gcm (default) | chacha20-poly1305
  --paranoid                  strip timestamps & metadata from the header

shadow-bit open     <name>
  --password <pwd>            [deprecated]
  --keyfile <path...>         keyfile(s) for this vault

shadow-bit close    <name>
  --password <pwd>            [deprecated]
  --keyfile <path...>         (auto-read from session if not supplied)

shadow-bit discard  <name>
  --password <pwd>            [deprecated]
  --keyfile <path...>         (auto-read from session if not supplied)

shadow-bit add      <name> <files…>
  (no flags; vault must be open)

shadow-bit info     <name>
  (no password needed)

shadow-bit list
  (no flags)

shadow-bit change-password <name>
  --password <pwd>            current password (or prompted)  [deprecated]
  --new-password <pwd>        [deprecated — leaks via `ps`]
  --keyfile <path...>         keyfile(s) for the CURRENT vault
  --new-keyfile <path...>     keyfile(s) after the change (omit to keep the
                              current set; pass an empty list to drop the
                              keyfile requirement entirely)

shadow-bit recover  <name>
  --recovery-key <key>        [deprecated — prompted visibly by default]
  --new-password <pwd>        [deprecated — no env-var equivalent]

shadow-bit recovery-key <name>
  --password <pwd>            [deprecated]
  --keyfile <path...>
  --remove                    remove the recovery key
  --upgrade                   re-salt a legacy v1 escrow (key stays valid)
  --recovery-key <key>        used with --upgrade (or prompted)

shadow-bit meta     <name>
  --password <pwd>            (required only when setting metadata)  [deprecated]
  --name <text>
  --description <text>
  --keyfile <path...>

shadow-bit delete   <name>
  --password <pwd>            [deprecated]
  --keyfile <path...>
  --shred                     overwrite bytes before deleting
  --passes <n>                overwrite pass count (default: 3)
  -y / --yes                  skip confirmation

shadow-bit shred    <name>    alias for delete --shred
  --password <pwd>            [deprecated]
  --keyfile <path...>
  --passes <n>
  -y / --yes

shadow-bit clean
  (no flags — removes stale sessions)
```

> Every flag marked `[deprecated]` carries a secret as a command-line argument,
> so it is visible to every user on the machine through `ps` and is recorded in
> your shell history. Omit the flag and ShadowBit prompts invisibly — except
> `--recovery-key`, which is prompted _visibly_ on purpose: it is 40 Base32
> characters in fixed groups, and a masked field hides exactly the one mistyped
> character that makes recovery fail.

---

## Security reference

| Property                   | Detail                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cipher**                 | AES-256-GCM (default) or ChaCha20-Poly1305 — chosen at creation                                                                                                                                                                                                        |
| **KDF**                    | scrypt — N=2¹⁷ (131 072), r=8, p=1, per-vault random salt                                                                                                                                                                                                              |
| **Key size**               | 256-bit MEK (master encryption key)                                                                                                                                                                                                                                    |
| **Header integrity**       | HMAC-SHA256 over full header (HKDF from MEK, `"shadowbit-header-auth"` domain)                                                                                                                                                                                         |
| **Recovery key**           | 200 bits entropy, Crockford Base32, salted scrypt escrow                                                                                                                                                                                                               |
| **Keyfile**                | Any file; content mixed into password derivation (scrypt input)                                                                                                                                                                                                        |
| **Password change**        | Re-wraps only the MEK (instant; payload unchanged)                                                                                                                                                                                                                     |
| **Working folder**         | `$TMPDIR/shadow-bit/<name>-<random>`, mode 0700; securely wiped on close/discard                                                                                                                                                                                       |
| **File timestamps**        | Vault file atime/mtime reset to epoch after every write                                                                                                                                                                                                                |
| **Working dir timestamps** | All files scrubbed to epoch immediately after decrypt+unpack                                                                                                                                                                                                           |
| **OS indexing**            | Best-effort, platform-dependent: `.metadata_never_index` + `mdutil -i off` + Time Machine xattr (macOS); `attrib +I /S /D` (Windows); `.trackerignore` / `.noindex` / `.hidden` (Linux). Some steps need privileges the app does not have — a request, not a guarantee |
| **Session files**          | Encrypted with a 256-bit local machine key (`~/.shadow-bit/.local-key`)                                                                                                                                                                                                |
| **Payload cap**            | 1.5 GiB — larger vaults rejected with a clear error, not an OOM crash                                                                                                                                                                                                  |
| **Shred**                  | Best-effort on SSDs/APFS/Btrfs (wear-leveling may retain copies) — use FDE for hard guarantees                                                                                                                                                                         |
| **Audit**                  | Not independently audited — suitable for personal use, not classified data                                                                                                                                                                                             |

**Tips:**

- Store the recovery key in a password manager or print it. Losing both the
  password and the recovery key means permanent lockout.
- Always use `close` or `discard` — if you kill the process or reboot without
  closing, run `shadow-bit clean` to wipe orphaned working dirs.
- For maximum shred confidence on SSDs, rely on full-disk encryption (FileVault,
  BitLocker, LUKS) in addition to ShadowBit's own shred.
- Keyfiles should be stored separately from the vault (different device, USB key).
- Paranoid mode + keyfile + ChaCha20 is the highest-privacy configuration.
