# ShadowBit CLI — Implementation Plan

> **⚠️ SUPERSEDED** — This was the original design document. The actual
> implementation diverges significantly (and is better). Key differences:
>
> - **KDF**: PLAN says PBKDF2 → implementation uses **scrypt** (memory-hard)
> - **Storage**: PLAN says per-file encryption in a `~/.shadow-bit/data/` tree →
>   implementation uses a **single self-contained `.vault` binary file** (bundle
>   archive encrypted as one AES-256-GCM payload)
> - **Commands**: PLAN says `mount`/`unmount`/`status` → implementation uses
>   **`open`/`close`/`info`**
> - **Registry**: PLAN says `registry.json` with drive metadata → implementation
>   uses **`sessions.json`** (paths + timestamps only, no secrets)
> - **Symlinks**: PLAN says followed → implementation **silently skips** them
>   (deliberate safety choice)
> - **Password policy**: PLAN says `--no-password` is allowed → implementation
>   **enforces a minimum 8-character password** in the core
>
> Refer to `README.md`, `AGENTS.md`, and the source code for the current
> architecture. This file is kept for historical context only.

## Overview (original, superseded)

A multi-drive password-protected ShadowBit CLI built in TypeScript. Each drive is a designated directory whose contents are encrypted at rest using AES-256-GCM. Drives are "mounted" (decrypted to a temp working area) and "unmounted" (re-encrypted back) on demand. A recovery key system prevents permanent lockout when a password is forgotten.

---

## Architecture

### Storage Layout

```
~/.shadow-bit/
├── registry.json              # Master registry of all drives
├── data/{drive-name}/         # Encrypted drive files (default location)
└── sessions/{drive-name}/     # Decrypted working area (exists only while mounted)
```

- `registry.json` holds metadata only — never file contents
- `data/{drive-name}/` stores the AES-encrypted files (encrypted at rest)
- `sessions/{drive-name}/` is a temp dir created on mount, removed on unmount

### Encryption Model

A single random Master Encryption Key (MEK) is generated per drive. This MEK is the only key used to encrypt/decrypt actual files. The password never encrypts files directly.

```
Drive files ──encrypted by──▶ MEK (random 256-bit, per drive)
                                  │
                    ┌──────────────┴──────────────┐
                    ▼                              ▼
        MEK encrypted by password      MEK encrypted by recovery key
        (stored as encryptedMek)       (stored as encryptedRecoveryMek)
                    │                              │
        PBKDF2(password, salt)        SHA-256(recoveryKey) → derivedKey
        → derivedKey → AES-GCM-decrypt MEK
```

**File-level encryption:** Each file is independently encrypted with AES-256-GCM:
`[IV(16 bytes) | AuthTag(16 bytes) | Ciphertext]`

**Why this design matters:**

- **Changing the password** only re-encrypts the MEK (not every file) — instant
- **Recovery key** decrypts the MEK independently — no password needed
- **Password hash** is for authentication only (PBKDF2, 100000 iterations, SHA-512)
- **Recovery key hash** is for verification only — raw key is shown once and never stored

### Data Model (`src/types.ts`)

```typescript
interface Vault {
  name: string; // Unique identifier / directory name
  dataDir: string; // Absolute path to encrypted data
  isProtected: boolean; // Whether password protection is on
  salt?: string; // Hex salt for PBKDF2 (if protected)
  passwordHash?: string; // Hex hash for password verification
  encryptedMek?: string; // Hex MEK encrypted by password-derived key
  encryptedRecoveryMek?: string; // Hex MEK encrypted by recovery key
  recoveryKeyHash?: string; // Hex hash of recovery key for verification
  createdAt: string; // ISO timestamp
  mountedAt?: string; // ISO timestamp (set when mounted)
  mountSessionPath?: string; // Temp session path (set when mounted)
}

interface DriveRegistry {
  drives: Vault[];
}
```

---

## CLI Commands

### `shadow-bit create [name]`

| Flag                  | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `--path <dir>`        | Custom data directory (default: `~/.shadow-bit/data/{name}`) |
| `--password <pwd>`    | Supply password non-interactively                            |
| `--no-password`       | Skip password setup entirely                                 |
| `--generate-recovery` | Auto-generate recovery key (default for protected drives)    |

**Flow:**

1. Get drive name (CLI arg or prompt)
2. Determine data directory
3. If password protection: get password (flag → prompt), generate salt, derive password hash, generate MEK, encrypt MEK
4. Generate recovery key (if protected), display it in a prominent box, require user confirmation they saved it
5. Create data directory
6. Add drive to `registry.json`
7. Print success summary

### `shadow-bit mount [name]`

| Flag               | Description                       |
| ------------------ | --------------------------------- |
| `--password <pwd>` | Supply password non-interactively |

**Flow:**

1. Find drive in registry by name
2. If already mounted → inform user, exit
3. If protected: get password (flag → prompt), verify hash
4. Decrypt MEK using password
5. Create session dir: `~/.shadow-bit/sessions/{name}/`
6. Iterate files in `dataDir`, decrypt each with MEK, write to session dir
7. Update registry (`mountedAt`, `mountSessionPath`)
8. Print success: session path + reminder to `unmount` when done

### `shadow-bit unmount [name]`

**Flow:**

1. Find drive, verify it's mounted
2. If protected: get password to verify + re-derive MEK for encryption
3. Iterate session files, re-encrypt with MEK, write back to `dataDir`
4. Remove session directory
5. Clear `mountedAt` and `mountSessionPath` in registry
6. Confirm unmount

### `shadow-bit list`

**Flow:**

1. Load registry
2. Print table: Name | Path | Mounted | Protected | Created
3. If no drives: print "No vaults found."

### `shadow-bit status [name]`

**Flow:**

1. Find drive
2. Print: name, path, mounted/unmounted, session path (if mounted), protected, created date
3. If mounted: file count + total size in session dir

### `shadow-bit change-password [name]`

| Flag                   | Description                  |
| ---------------------- | ---------------------------- |
| `--password <old>`     | Current password (or prompt) |
| `--new-password <new>` | New password (or prompt)     |

**Flow:**

1. Find drive; if protected, verify current password
2. Prompt for new password (confirm x2)
3. Generate new salt, re-hash new password, re-encrypt MEK with new password
4. **Files are NOT re-encrypted** — MEK stays the same
5. Update registry
6. Confirm change

### `shadow-bit recover [name]`

| Flag                   | Description                           |
| ---------------------- | ------------------------------------- |
| `--recovery-key <key>` | Supply recovery key non-interactively |

**Flow:**

1. Find drive by name
2. Get recovery key (flag → prompt)
3. Verify recovery key hash
4. Decrypt MEK using recovery key
5. Ask user to set a NEW password (prompt x2, confirm)
6. Generate new salt, re-hash new password, re-encrypt MEK with new password
7. Update registry
8. Confirm recovery complete, remind user to save new recovery key info

### `shadow-bit delete [name]`

| Flag    | Description       |
| ------- | ----------------- |
| `--yes` | Skip confirmation |

**Flow:**

1. Find drive; if mounted → unmount first
2. Require password (if protected) as safety measure
3. Confirm deletion
4. Remove `dataDir` and `sessions/{name}/` (if exists)
5. Remove from registry
6. Confirm deletion

---

## File Structure

```
shadow-bit/
├── package.json            # Updated with tsx
├── tsconfig.json           # NEW — TypeScript config
├── shadow-bit           # Updated bash launcher
└── src/
    ├── index.ts            # Rewrite — CLI entry with commander
    ├── types.ts            # NEW — Interfaces
    ├── config.ts           # NEW — Registry load/save
    ├── crypto.ts           # NEW — Encryption primitives (MEK, AES-GCM, PBKDF2)
    ├── prompts.ts          # NEW — Password/confirmation helpers (flag + interactive)
    └── commands/
        ├── create.ts       # NEW
        ├── mount.ts        # NEW
        ├── unmount.ts      # NEW
        ├── list.ts         # NEW
        ├── status.ts       # NEW
        ├── changePassword.ts  # NEW
        ├── recover.ts      # NEW
        └── delete.ts       # NEW
```

---

## Implementation Order

| Step | File                             | Purpose                                                                           |
| ---- | -------------------------------- | --------------------------------------------------------------------------------- |
| 1    | `tsconfig.json`                  | Project TypeScript configuration                                                  |
| 2    | `package.json`                   | Add `tsx` as dev dependency, update scripts                                       |
| 3    | `src/types.ts`                   | Define `Vault`, `DriveRegistry` interfaces                                        |
| 4    | `src/config.ts`                  | Registry persistence functions                                                    |
| 5    | `src/crypto.ts`                  | All encryption: MEK generation, file encrypt/decrypt, password hash, recovery key |
| 6    | `src/prompts.ts`                 | `askPassword(flagValue?)` — flag-or-prompt pattern, confirmation prompts          |
| 7    | `src/commands/create.ts`         | Create command (with recovery key display)                                        |
| 8    | `src/commands/mount.ts`          | Mount command                                                                     |
| 9    | `src/commands/unmount.ts`        | Unmount command                                                                   |
| 10   | `src/commands/list.ts`           | List drives (table output)                                                        |
| 11   | `src/commands/status.ts`         | Single drive status                                                               |
| 12   | `src/commands/changePassword.ts` | Change password (MEK re-encrypted only)                                           |
| 13   | `src/commands/recover.ts`        | Recovery via key → set new password                                               |
| 14   | `src/commands/delete.ts`         | Delete drive with confirmation                                                    |
| 15   | `src/index.ts`                   | Rewrite CLI entry point wiring all commands                                       |
| 16   | `shadow-bit`                     | Update bash launcher script                                                       |

---

## Key Design Decisions

**Why MEK instead of direct password-based encryption:**
Changing a password re-encrypts the MEK only (~16 bytes of work). Without MEK, you'd need to re-encrypt every file.

**Why AES-GCM over AES-CBC (existing code):**
GCM provides authenticated encryption — detects tampering. CBC is vulnerable to padding oracle attacks.

**Why per-file IVs:**
Each file gets its own random IV (nonce), preventing identical plaintexts from producing identical ciphertexts across files.

**Why recovery key uses SHA-256 → MEK encryption:**
The recovery key is displayed to the user as a readable string. We derive a key from it using SHA-256, then use that to AES-GCM encrypt the MEK. This keeps the stored form secure while allowing the user to recover with just the key string.

**Why password flag falls back to prompt:**
`--password mypass` is convenient for scripting but risky (shell history). When omitted, an interactive hidden prompt is used. This gives the user control over their threat model.

**What files get encrypted:**
Only regular files in the data directory are encrypted. Subdirectories are preserved structurally (created but not encrypted as directories). Symlinks are followed.

---

## Example Session

```bash
# Create a protected drive
$ ./shadow-bit create mywork
? Password: ********
? Confirm password: ********
╭──────────────────────────────────────────────╮
│  RECOVERY KEY — Save this somewhere safe!   │
│                                              │
│  a7Kx9mP2vQ8nW4tYf6Jb1hR5cD3gL0sZ          │
│                                              │
│  You will need this if you forget your      │
│  password. It cannot be recovered later.    │
╰──────────────────────────────────────────────╯
? Type 'saved' to confirm: saved
✓ Created drive 'mywork' at ~/.shadow-bit/data/mywork

# Mount and work
$ ./shadow-bit mount mywork
? Password: ********
✓ Mounted 'mywork' → /tmp/shadow-bit-sessions/mywork
  Copy your files into this directory, then run 'unmount mywork'

# ... copy files, edit, etc ...

# Unmount (re-encrypts everything)
$ ./shadow-bit unmount mywork
? Password: ********
✓ Unmounted 'mywork'. Files re-encrypted.

# List all drives
$ ./shadow-bit list
  NAME     PATH                           MOUNTED  PROTECTED
  mywork   ~/.shadow-bit/data/mywork   No       Yes

# Change password (while mounted)
$ ./shadow-bit mount mywork
? Password: ********
✓ Mounted 'mywork'

$ ./shadow-bit change-password mywork
? Current password: ********
? New password: ********
? Confirm new password: ********
✓ Password changed for 'mywork'

# Recovery if password forgotten
$ ./shadow-bit recover mywork
? Recovery key: a7Kx9mP2vQ8nW4tYf6Jb1hR5cD3gL0sZ
? New password: ********
? Confirm new password: ********
✓ Password recovered. Drive 'mywork' now has a new password.
```
