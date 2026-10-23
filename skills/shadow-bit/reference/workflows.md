# Workflows

Multi-step recipes. Each one: steps in order, then where to stop and
confirm with the user. All secret flags omitted ⇒ CLI prompts; prefer
that.

## 1. Create a vault (basic)

```
shadow-bit create ~/secure/clients.svlt
```

Prompts: password (twice, hidden). Prints the recovery key once.

1. If the recovery key prints, STOP and tell the user to store it (password
   manager / paper). It is shown exactly once and never persisted anywhere;
   losing the password without it means the vault is unrecoverable. The CLI
   then asks to type `saved` to confirm it was stored — by default that's
   the user's keystroke, not yours; do not answer it on their behalf.
2. Name/description metadata is optional (`--name`, `--description`) and is
   stored plaintext — ask the user before putting anything identifying in
   it.

Variants:

- `--no-recovery` — no escrow. Warn the user clearly: forgotten password =
  vault gone, permanently.
- `--keyfile <path>` — adds a possession factor. Any keyfile makes
  keyfile-required permanent; the file becomes part of opening the vault,
  so it needs a backup story of its own.
- `--seed <dir>` — bulk-load a folder at creation (symlinks silently
  skipped).
- `--paranoid` — strips header timestamps/metadata for
  minimal-metadata operation. Warn: later `meta` sets re-add plaintext
  (with a warning).
- `--cipher chacha20-poly1305` — alternative AEAD; default AES-GCM is fine.

## 2. Open → edit → close (the core cycle)

```
shadow-bit open ~/secure/clients.svlt     # prints temp working dir path
#   ... create/edit/delete files inside that folder with normal tools ...
shadow-bit close ~/secure/clients.svlt    # re-encrypts, wipes temp, unregisters
```

Key points to convey:

- The working folder is the EDIT point; the vault file never changes until
  close.
- Closing WITHOUT saving = changes lost; `discard` explicitly drops them.
- Closing overwrites the vault file — confirm with the user before closing
  if something else may have edited the working folder.
- Between open and close, the plaintext exists on disk in a 0700 temp dir. Do
  not treat that window as secure storage; don't copy secrets out of it.

## 3. Add files to an open vault

```
shadow-bit open <name>          # first, if not already open
shadow-bit add <name> ./report.pdf ./photos/    # files or folders
shadow-bit close <name>                        # persist added files
```

`add` copies into the working folder; it does NOT touch the vault file
until close. Symlinks are rejected by add (not silently dropped).

## 4. Rotate a password

```
shadow-bit change-password <name>
```

Prompts: current password, new password (each hidden). Fast — the payload
is not re-encrypted; only the wrapping key changes. Also upgrades the KDF
cost for legacy vaults automatically.

Keyfile note: to DROP a keyfile requirement while changing the password you
must explicitly pass an empty new-keyfile list — omitting the flag keeps the
current keyfiles. This trips people; spell it out for them.

## 5. Recover a forgotten password

```
shadow-bit recover <name>
```

Prompts: the recovery key VISIBLY (so a typo can be seen and corrected) and
the new password. The old password is irrelevant — this is the
forgot-the-password path. One wrong character fails the key; re-enter
carefully in all 8 groups.

If the escrow is legacy (v1) this same call upgrades it. Don't run
`recovery-key --upgrade` separately for the same vault in the same
conversation unless the user explicitly wants the standalone re-salt.

## 6. Regenerate a recovery key

```
shadow-bit recovery-key <name>
```

Authenticates with current password/keyfile (prompts), prints a NEW
recovery key once, invalidates the old. STOP and get the user to store the
new key before doing anything else. Use when: the old key may be
compromised (was committed/shared), or as a periodic hygiene step.

## 7. Set or read metadata

```
shadow-bit meta <name>                        # read
shadow-bit meta <name> --name "Client docs" --description "2026 tax year"
```

Authenticates first (prompts for password/keyfile). Warn the user: this is
plaintext in the header — visible to whoever has the file, no password needed
to read it. On a paranoid vault it re-adds plaintext metadata with a
warning; get explicit consent.

## 8. Delete a vault (permanently)

Two forms of the same destructive action:

```
shadow-bit delete <name>            # confirmation prompt unless -y
shadow-bit shred <name>             # overwrite-then-delete (stricter)
```

Both require authentication while the vault exists and are IRREVERSIBLE.
Stop and get explicit confirmation: "delete the entire vault X, all
content, no recovery?" — if the vault is the only copy of any data, say
so before acting. `--shred`/`--passes` control overwrite passes. Caveat
for SSDs/COW filesystems: overwritten blocks may persist; deletion is
best-effort at the filesystem layer. For files whose true deletion matters
against that class of hardware, advise full-disk encryption as the actual
mitigation.

## 9. Clean stale sessions

```
shadow-bit clean
```

Sub-step of other flows; harmless. If `list` shows sessions whose vault
file was deleted externally, `clean` removes the registry entries.

## Stop-and-ask summary (where the agent must pause)

- Recovery key printed → user must store it before proceeding.
- Any of `delete` / `shred` / `discard` → explicit user confirmation of
  the exact target and consequence, every time.
- Setting metadata on a paranoid vault, or vault name/description that
  would leak identity into a shared file → flag the tradeoff first.
- Close when the working folder may have been touched by something other
  than the user's sanctioned tools → confirm before overwriting the vault.
- `--password` / `--new-password` / `--recovery-key` flags → user must
  explicitly opt into the argv tradeoff and be told why it's risky.
