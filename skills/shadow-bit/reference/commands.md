# CLI reference

Ground truth is `shadow-bit --help` and per-command `--help`. Global flag:
`-V, --version` (app version), `-h, --help` per command. If `shadow-bit`
is not on the PATH, see the availability check in SKILL.md — inside a repo
checkout, replace `shadow-bit` with `./shadow-bit` throughout this file.

Vault names: most commands accept a bare name (resolved against the current
directory) or a path. Extension is cosmetic — open works on any name.

Config location: `~/.shadow-bit/` (override with `SHADOWBIT_CONFIG_DIR`).
Sessions persist there across runs.

## create

    shadow-bit create <name>

Creates `<name>.svlt` (or uses the path/name as given). Refuses to overwrite
an existing vault. Prompts for a password (hidden). Minimum 8 chars.

| Flag                   | Meaning                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--password <pwd>`     | Supply password non-interactively. Warns: leaks via `ps`/history.                                                                                           |
| `--no-recovery`        | Do not generate a recovery key. Default behavior DOES generate one and prints it once — record it immediately; it is never shown again and never persisted. |
| `--seed <dir>`         | Seed the vault with files from a directory.                                                                                                                 |
| `--name <text>`        | Plaintext vault name metadata.                                                                                                                              |
| `--description <text>` | Plaintext description metadata.                                                                                                                             |
| `--keyfile <path...>`  | Keyfile(s) required for future opens. Any keyfile makes the vault permanently keyfile-required.                                                             |
| `--cipher <alg>`       | `aes-256-gcm` (default) or `chacha20-poly1305`.                                                                                                             |
| `--paranoid`           | Strip timestamps and metadata from the plaintext header (epoch timestamps, no name/description/salt-visible extras).                                        |

Output: confirmation plus the recovery key (grouped Base32).

## open

    shadow-bit open <name> [--password] [--keyfile <path...>]

Decrypts to a temporary working folder (under the system temp dir, in a
`shadow-bit` subdir). Prints the working-folder path. Always re-verifies the
password even if a session already exists — there is no open-without-password
bypass.

`--password <pwd>` exists but leaks via `ps`/history — prefer the prompt.

## close

    shadow-bit close <name> [--password] [--keyfile <path...>]

Re-encrypts the working folder into the vault, bumps the container version
through its compatibility ladder, securely wipes the decrypted working
folder, removes the session. **Without closing, edits are lost** — the vault
file is frozen at its last close.

## discard

    shadow-bit discard <name> [--password] [--keyfile <path...>]

Throws away the working folder WITHOUT saving changes, and removes the
session. Irreversible. Requires authentication (password/keyfile), so a
forgotten password prevents discarding. If the vault file itself was already
deleted, it still cleans up the leftover working dir.

## info

    shadow-bit info <name>

Reads only the header — no password. Shows name/description metadata,
timestamps, whether a session is currently open, keyfile-required status,
container format version. Note: the version shown is the _container format
version_, unrelated to the app version in `shadow-bit --version`.

## list

    shadow-bit list

Lists currently open vault sessions (vault path and working dir). Sessions
are shared between CLI and desktop app.

## change-password

    shadow-bit change-password <name>

Rewraps the key with a new password. The encrypted payload is NOT
re-encrypted (this is fast). Also upgrades the KDF cost to the current
default for legacy vaults.

| Flag                      | Meaning                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--password <pwd>`        | Current password (prompt preferred).                                                                                                                              |
| `--new-password <pwd>`    | DEPRECATED — explicitly labeled as leaking via `ps`. Omit for a hidden prompt.                                                                                    |
| `--keyfile <path...>`     | Keyfile(s) for the CURRENT vault.                                                                                                                                 |
| `--new-keyfile <path...>` | Keyfile(s) required after the change. Omitting keeps the current set; to DROP a keyfile requirement entirely you must pass an explicit empty list, not just omit. |

## add

    shadow-bit add <name> <files...>

Copies files/folders into the OPEN vault's working folder. The vault must be
open first (`shadow-bit open <name>`). Symlinks are rejected with an explicit
error rather than copied.

## delete

    shadow-bit delete <name> [--shred] [--passes <n>] [-y/--yes] [--password] [--keyfile <path...>]

Permanently deletes the vault file. Prompts for confirmation unless `-y`.
`--shred` overwrites the file with random data before deleting; `--passes <n>`
controls overwrite passes with `--shred`. Requires authentication when the
vault exists. Best-effort on SSDs/COW filesystems (see SECURITY.md).

## shred

    shadow-bit shred <name> [--passes <n>] [-y/--yes] [--password] [--keyfile <path...>]

Shorthand for delete with `--shred` — overwrite-then-delete. Same
confirmation, auth, and best-effort caveats.

## recover

    shadow-bit recover <name>

Resets the password using the recovery key. Prompts for the recovery key
(visibly — so a mistyped character is findable) and the new password. Flags
`--recovery-key` and `--new-password` exist but are deprecated (leak via
`ps`).

This also upgrades a legacy v1 recovery escrow to the salted version, in the
same pass.

## recovery-key

    shadow-bit recovery-key <name> [--remove | --upgrade]

Generates a NEW recovery key (`--password`/`--keyfile` authenticate; the old
key is invalidated). With `--remove`, removes the escrow instead — think
before removing: without it, a forgotten password is unrecoverable. With
`--upgrade`, re-salts a legacy (v1) escrow in place using the existing
recovery key (`--recovery-key` deprecated; omit to be prompted).

## meta

    shadow-bit meta <name> [--password] [--keyfile <path...>] [--name <text>] [--description <text>]

With no `--name`/`--description`, prints the metadata. With either flag,
sets it (authenticates first). Metadata is stored in the plaintext header —
anyone holding the file can read it. On a `--paranoid` vault, setting
metadata succeeds with a warning: it deliberately puts plaintext back into a
header that was scrubbed, so surface that tradeoff to the user before doing
it.

## clean

    shadow-bit clean

Removes stale sessions whose working dir or vault file no longer exists.
Safe; touches nothing but the session registry.
