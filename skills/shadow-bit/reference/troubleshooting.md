# Troubleshooting

Symptom → cause → fix. Ordered roughly by likelihood.

## "Vault is not open."

Commands that operate on open sessions (`add`, or edits meant for the working
folder) fail when the vault has no session. Sessions live in
`~/.shadow-bit/sessions.json` and persist across CLI invocations — this is
almost always "forgot to open", not corruption.

Fix: `shadow-bit list` to see what IS open. If the vault is listed but the
command still fails, the path may have moved — `shadow-bit clean` removes
sessions whose files disappeared, then `shadow-bit open` again.

## "This vault requires a keyfile."

The vault was created with `--keyfile` and the command didn't forward any.
This is fail-closed: there is no password-only fallback, ever. Every
authenticated command accepts `--keyfile <path...>` — it's easy to remember
it for `open` and forget it for `close`, `change-password`, `delete`,
`shred`, `discard`, `recovery-key`, or `meta`.

Fix: pass the same keyfile(s) used at creation (or at the last
keyfile-changing operation).

## "Incorrect password or corrupt/tampered vault."

Deliberately ambiguous: header tampering (KDF downgrade, salt swap, cipher
swap) is authenticated and must not leak what failed. You cannot know,
and shouldn't claim to, whether the password was wrong or the file was
modified.

Triage: has the file been transferred, truncated, or touched by anything?
Does `shadow-bit info` still parse (header readable, size plausible)?
If info works and the password is genuinely the one they always use,
suspect a transfer truncation (email/ USB / cloud sync) — re-transfer.

## Wrong app opens the file / double-click launches something else

`.vault` is claimed by several unrelated tools (HashiCorp, Bitwarden), so
double-clicking opens someone else's app. ShadowBit renamed to `.svlt`
(which has no known association) specifically to avoid this; old
pre-rename `.vault` shortcuts may still point at the wrong handler.

Fix: open from the CLI (`shadow-bit open <path>`) rather than
double-click. Identification is by magic bytes — the suffix never matters
to ShadowBit itself, so a vault with any name opens correctly.

## "This looks corrupt" — a pre-1.0 `.vault` file

Files from pre-1.0 builds carry a different magic and are rejected as
corrupt. There is no migration and no "try harder" flag. If the user has
pre-1.0 files, they need the pre-1.0 tool (or accept they're unreadable);
version 1.0+ containers of formats v1–v3 all open with the current CLI.

## Recovery key rejected

The recovery key is 40 Base32 characters, entered in 8 fixed groups. One
wrong character fails the whole key. It is prompted visibly (not masked)
precisely so a single typo is findable. Fix: re-enter while comparing
against the recorded copy, group by group.

Also: a recovery key only matches the escrow it was generated for. If the
key was regenerated (`recovery-key <name>`), the OLD key no longer works. If
the vault predates the salted escrow (format v1) and the password was
changed by some other path first, `recovery-key --upgrade` with the old key
may still be applicable — but only if that escrow still matches.

## Min 8 chars / password rejected at create or change

Password minimum length is 8, enforced in the core on create, change and
recover — not a UI-only rule. Length is enforced; strength is only
advisory (a common password passes length checks the same as any other).
Entropy is the user's call; the scrypt cost raising guessing price is not a
substitute for a decent password.

## The working folder is gone / never shows up

The temp working folder is created on `open` (name contains `shadow-bit`)
and wiped on `close`/`discard`. If it's gone while the session still lists,
the machine was rebooted / tmp was cleared: run `shadow-bit clean`, then
`open` again. The vault file itself is untouched.

## Close failed halfway / worried the vault is broken

`close` overwrites the vault file from the working folder. If a previous
close errored, the vault file is likely still the last good version
(closed vault is replaced, not patched in place per-entry) — but treat any
fear of partial-writes with care and verify before proceeding:
`shadow-bit info <name>` (parses header?), then try a password prompt
WITHOUT overwriting anything. If the header parses and the password
verifies, the vault is intact.

## "My metadata shows information I didn't put there"

`info` name/description are stored in the PLAINTEXT header — anyone holding
the file can read them. If the user expected encryption of even the vault
name, that's by design only when `--paranoid` was used at creation. Setting
metadata on a paranoid vault re-introduces plaintext with a warning; the
user should confirm they want that leak.

## Sessions / registry oddities — `clean`

`shadow-bit clean` removes sessions pointing at a vanished working dir or
vanished vault file. It never touches vaults, working folders, or keys.
Various "phantom" session states (deleted vault, leftovers from a machine
restart) are what it exists to fix.

## What the container format version means

`shadow-bit info` reports the container format version (currently 3).
`shadow-bit --version` reports the app version. They are unrelated
numbers that both look like "version" — don't copy one over the other, and
don't treat "old format version" as "needs updating the app".

## Gotchas that look like agent mistakes but aren't

- `shadow-bit add` requires the vault be open; there is no
  add-to-closed-vault shortcut. Open, add, close.
- Symlinks are silently skipped when seeding at `create`, and explicitly
  rejected by `add`. If the user thinks a symlink got into the vault, it
  didn't — that's a deliberate safety choice, not a bug.
- `--password <pwd>` and friends leak via `ps` and shell history. The CLI
  prints that warning when relevant; prefer omitting the flag so the
  prompt reads the secret invisibly.
