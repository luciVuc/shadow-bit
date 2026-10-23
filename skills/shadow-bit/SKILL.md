---
name: shadow-bit
description: Use when the user mentions ShadowBit, a .svlt vault file, an encrypted vault container, container encryption, vault recovery, recovery keys, or keyfiles — or asks to create/open/close/share an encrypted vault, archive a folder securely, lock up or retrieve files with password protection, check vault info, rotate a vault password, troubleshoot a vault error, or run the shadow-bit CLI. Covers what the app is, every CLI command with flags, troubleshooting, and step-by-step workflows. Also trigger for "secure archive", "encrypted shareable folder", or questions about how the vault format works.
---

# ShadowBit

ShadowBit creates encrypted, portable, shareable vault containers
(`.svlt` files). A vault is a single file that holds a whole folder of
content under AES-256-GCM or ChaCha20-Poly1305 encryption. The workflow:
**open** decrypts the vault to a temporary working folder, you edit those
files with any tools, **close** re-encrypts the working folder back into
the vault and securely wipes the decrypted copy. Send the `.svlt` file by
any channel; the recipient opens it with the password.

Two frontends exist: a desktop app (Electron) and a CLI (`shadow-bit`).
This skill covers the CLI, which is also what an assistant driving a
terminal uses.

## Availability check (do this first)

Don't assume the CLI is installed. Probe once per session:
`shadow-bit --version`. On "command not found", the user may have the CLI
only inside a project checkout, or no CLI at all (desktop-app-only user):

- Repo checkout: a `./shadow-bit` launcher at the repo root runs the CLI
  from source (`./shadow-bit --version`); it only works from that
  directory. A `package.json` with a `bin` entry named `shadow-bit` is the
  giveaway you're in the project itself.
- No CLI anywhere: the desktop app alone can't be driven from a terminal.
  `npm install -g shadow-bit` requires Node.js 20+; suggest it and let the
  user decide — don't install things unprompted.
- Never run bare `npx shadow-bit` speculatively for real vault
  operations: on a machine without the package it fetches the CLI from the
  npm registry mid-task, which the user should explicitly opt into.

## Before you act

1. **Secrets never go in argv by default.** Flags like `--password`,
   `--new-password`, and `--recovery-key` leak via shell history and `ps`.
   The CLI prompts for every secret when the flag is omitted, so prefer
   letting the user type it into the prompt. Use the flag form only when
   the user explicitly chooses that tradeoff — and name the risk when they
   do. (Read their choice once per session, don't re-litigate every
   command.)
2. **Destructive actions stop for explicit confirmation.** `delete`,
   `shred`, and `discard` are irreversible; the CLI may prompt again but
   that prompt is a last guard, not an invitation. Get the user's clear
   go-ahead first, in their own words. `close` also overwrites the vault
   file — apologize and confirm before closing if the working folder was
   edited by anything the user didn't sanction.
3. **Keyfile vaults need `--keyfile` on every authenticated command.** If
   a vault was created with a keyfile, every password-prompting command
   (`open`, `close`, `discard`, `change-password`, `delete`, `shred`,
   `recovery-key`, `meta`) throws without it — it does not fall back to
   password-only. Check `shadow-bit info` for whether a vault is
   keyfile-protected before running password commands.
4. **Never guess a vault's identity by its extension.** Files are
   identified by magic bytes; a vault named `notes.txt` opens fine. The
   `.svlt` suffix is convention (renamed from `.vault` for good reasons —
   see troubleshooting).
5. **A password that "fails" is ambiguous on purpose.** The error reads
   "Incorrect password or corrupt/tampered vault" — wrong password and
   tampering are deliberately indistinguishable. Don't assert which one it
   was.

## Command cheat-sheet

```
shadow-bit create <name>            # create; prompts password; see flags below
shadow-bit open <name>              # decrypt to a temp working folder
shadow-bit close <name>             # save changes back & wipe working folder
shadow-bit discard <name>           # throw away working changes (needs password)
shadow-bit info <name>              # header metadata & open state, no password
shadow-bit list                     # currently open sessions (paths only)
shadow-bit clean                    # prune stale sessions
shadow-bit add <name> <files...>    # copy into an OPEN vault's working folder
shadow-bit change-password <name>   # rewrap only; payload not re-encrypted
shadow-bit recover <name>           # reset password using the recovery key
shadow-bit recovery-key <name>      # new key / --remove / --upgrade
shadow-bit meta <name> [--name t] [--description t]   # plaintext metadata
shadow-bit delete <name> [--shred]  # permanently delete the vault file
shadow-bit shred <name>             # delete with overwrite passes (safer delete)
```

Password minimum is 8 characters, enforced everywhere. `open` always
re-verifies the password even if the vault already appears open.

## Troubleshooting first-drafts

Before diving deep, the common ones:

- **"Vault is not open"** — the session registry (`~/.shadow-bit/sessions.json`)
  doesn't show it. Run `shadow-bit list`, then `shadow-bit open`, then retry.
  Stale leftover sessions are fixed by `shadow-bit clean`.
- **"This vault requires a keyfile"** — pass `--keyfile <path>` (the same
  file(s) used at creation).
- **Opening a pre-1.0 `.vault` file** — rejected as corrupt; there is no
  backward migration. Confirm which app made the file.
- **Recovery key rejected** — it is 40 Base32 characters in 8 fixed groups;
  one wrong character fails the whole key. It is prompted visibly so a
  typo is findable — ask the user to re-enter it while looking at it.

These and the rest — including ".vault opened by someone else's
app", what a deleted working folder does and doesn't mean, and the
plaintext-metadata tradeoffs — are in `reference/troubleshooting.md`.

## Workflows

For multi-step operations use the recipe, don't improvise:
`reference/workflows.md` covers creating a vault (plain, keyfile,
paranoid, seeded), the open→edit→close cycle, password rotation,
recovery, metadata changes, and safe permanent deletion. Each recipe
lists where to stop and confirm with the user.

## Full command reference

Exact flags per command: `reference/commands.md`.
