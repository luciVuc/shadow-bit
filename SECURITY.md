# Security

## Secrets handling

- **Recovery keys are shown exactly once** and are never persisted anywhere on disk.
  They are only stored inside the `.vault` file as an encrypted copy of the MEK plus
  a verification hash — never in plaintext.
- Do **not** commit secrets (passwords, recovery keys, `.env` files) to the
  repository or ship them in zips/backups. `.env` is `.gitignore`d so it never
  ends up in `electron-builder` contexts; `.env.example` is a committed,
  placeholder-only template (no real keys).
- If a recovery key is ever committed or shared accidentally, treat it as
  compromised and regenerate it: `shadow-bit recovery-key <vault>` (requires
  the current password, and invalidates the old key).

## Threat model

This section states what ShadowBit defends against, what it does **not**, and
where the real mitigation lies. Read it before relying on the tool for anything
sensitive. If a guarantee you need is not listed here, it does not exist.

### In scope — ShadowBit does defend against these

| Threat                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone who obtains the `.vault` file (email, USB, cloud, backup) | AES-256-GCM or ChaCha20-Poly1305 payload under a random 256-bit MEK; scrypt password KDF (N=2¹⁷) with per-vault salt                                                                                                                                                                                                                                                                                           |
| Offline password guessing                                         | scrypt cost (N=2¹⁷) with a per-vault salt. Length is enforced (min 8 chars). A common-password blocklist **exists in the core but is not reachable from the UI** — see "Password strength is advisory" below                                                                                                                                                                                                   |
| Header tampering — KDF downgrade, salt swap, cipher swap          | v3 authenticated header: HMAC-SHA256 over the canonical header JSON, keyed by an HKDF-derived HAK. Verified on every open                                                                                                                                                                                                                                                                                      |
| Payload tampering or corruption                                   | AEAD auth tags; tampering surfaces as a decryption failure                                                                                                                                                                                                                                                                                                                                                     |
| Path traversal via a hostile archive                              | `unpackDir` **rejects** (does not sanitize) absolute paths, drive letters, `..` segments, and any entry whose resolved path escapes the working dir                                                                                                                                                                                                                                                            |
| Resource exhaustion from a hostile header                         | `assertKdfParams` bounds N/r/p; container and payload sizes capped; bundle entry sizes bounds-checked. `inflateSync` also gets `maxOutputLength`, because the payload cap bounds the _compressed_ size only and a highly compressible vault would otherwise inflate without limit                                                                                                                              |
| A compromised renderer reaching the filesystem                    | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, and no synchronous worker fallback. Every vault operation is dispatched to a worker thread, and no operation trusts a path from the renderer: `listWorkingDir` / `deleteFromWorkingDir` / `renameInWorkingDir` resolve the folder against the session registry first and operate on the _registry's_ path, never the caller's |
| Local shoulder-surfing of a decrypted working dir                 | `mkdtemp` under a `0700` parent, plus best-effort OS indexer suppression (Spotlight / Windows Search / Tracker / Baloo — every step needs OS support and some need privileges, so this is not a guarantee)                                                                                                                                                                                                     |
| Filesystem timestamp leakage                                      | vault atime/mtime reset to epoch on every write; unpacked file timestamps scrubbed; `--paranoid` zeroes header timestamps and drops metadata (setting metadata on such a vault later is allowed, but warns — see below)                                                                                                                                                                                        |
| Compelled disclosure (VeraCrypt-style)                            | ⚠️ Core-only, **not reachable**. `src/core/hidden.ts` implements fixed-size containers with a separately-keyed inner volume and random padding, but no CLI or GUI command calls it. Both volumes read correctly now (the outer one through the ordinary `openVault` path), and operations that would rewrite the file refuse rather than destroy the hidden tail. See "Unreachable code" below                 |
| Accidental disclosure via a plain-looking file                    | ⚠️ Core-only, **not reachable**. `src/core/stego.ts` implements appending a vault after a carrier file's EOF, but no command calls it, and it does not validate the carrier type                                                                                                                                                                                                                               |

### Out of scope — these are NOT defended against

- **A local attacker running as your user.** Anything that can read your files
  can read `$TMPDIR/shadow-bit/` and `~/.shadow-bit/.local-key`. ShadowBit does
  not sandbox itself against you.
- **Physical access to a running or crashed machine.** See "Keys in memory" below.
- **A compromised OS, malicious keyboard, or screen-scraping malware.**
- **Traffic analysis / metadata about _when_ you used the tool.**
- **Weak passwords.** The KDF raises the cost of guessing; it cannot save a
  password like `password1`, which is why the blocklist exists.
- **Rubber-hose attacks on the running process** beyond hidden volumes. There is
  no `mlock`, no core-dump suppression, and no anti-debug.
- **Supply-chain / dependency compromise.** Runtime dependencies are only
  `commander` and `picocolors`; `src/core/` uses Node's `crypto` and nothing else.

### Unreachable code

`src/core/hidden.ts` and `src/core/stego.ts` are implemented, but **nothing in
either frontend imports them** — no CLI subcommand, no GUI path. They have
library-level tests in `src/test/core.test.ts`, so the crypto is exercised, but
nothing a user actually runs calls them, so they are not part of the security
boundary. `README.md` states this plainly; `ROADMAP.md` records these as
"Shipped".

Treat them as unfinished work rather than mitigations you can rely on. If you
need plausible deniability or carrier-file embedding, they are not available
today — and nothing in this repository should be read as claiming otherwise.

### Keyfiles are a hard requirement, and every operation must honour them

Once a vault is created with `--keyfile`, `header.keyfileRequired` is set, and
`effectivePassword()` **throws** if an operation is asked to authenticate without
a keyfile. That is a deliberate fail-closed choice: there is no path that
silently falls back to the password alone.

It also means the flag has to reach every operation. A dropped `keyfiles`
argument does not degrade gracefully — it makes the vault undeletable,
unshreddable, unchangeable, unable to rotate its recovery key, and unable to
have its metadata edited. That is exactly what happened to `delete`, `shred`,
`change-password`, and `recovery-key` until `63a3087`; `meta` kept the same gap
long afterwards, because the flag was registered on every command _except_ that
one. It is now fixed everywhere and covered by a lifecycle test that asserts
each operation individually.

The sharp edge is `changePassword`. Re-wrapping the MEK under a bare password
while leaving `keyfileRequired` set produces a header that demands a keyfile the
new wrap never used: opening without one is refused, and opening with one derives
the wrong password. The vault is unopenable both ways. `newKeyfiles` therefore
defaults to the current keyfile set, and dropping the requirement requires an
explicitly empty array. If you add a vault operation, thread `keyfiles` through
`src/core/vault.ts` → `vault-worker.ts` → `gui/main.ts` → the renderer.

Because a keyfile's contents are hashed into the derived password, a lost
keyfile is an unrecoverable loss of that vault's key material — recovery keys do
not help. Store it separately from the vault.

### Password strength is advisory

Only `MIN_PASSWORD_LENGTH` (8 characters) is **enforced**, and it is enforced in
the core — on create, change-password, and recover. Everything beyond that is
advisory:

- The core's `estimateStrength()` consults a `BLOCKLIST` of common passwords
  and reports a score, but **no product path calls it**. The CLI has no
  strength feedback at all.
- The GUI draws a strength meter, but it is a **separate implementation** in
  `renderer.js` that computes its own character-pool entropy and never
  consults the core estimator or the blocklist.

So an 8-character password like `password` is accepted by both frontends. The
KDF is what actually raises the cost of guessing; nothing here will stop you
from picking a weak password, and the common-password list never reaches you.

### Paranoid mode is not a permanent veto on metadata

`--paranoid` strips `meta.name` / `meta.description` at creation and pins the
header timestamps to epoch. It does **not** forbid them forever: `setMeta` on a
paranoid vault succeeds and returns `paranoid: true`, which the CLI and the GUI
both surface as a warning.

That split is deliberate. Refusing outright turned a mode a user chose years ago
into a one-way door, and there is no good reason a paranoid vault cannot carry a
description. What must never happen is a _silent_ success, since the mode exists
precisely to keep optional plaintext out of a header anyone can read. So the
contract is: write it, and say so.

`isParanoidHeader` identifies such a vault by its epoch `createdAt` — the same
signal `touchModified` uses to keep not writing real timestamps. There is no
dedicated flag, and adding one would be worse: a flag can disagree with the
timestamps it is supposed to describe.

### Keys in memory — read this

**Derived keys and the Master Encryption Key live in ordinary, pageable process
memory for the duration of an operation.** ShadowBit does **not** use `mlock`
and does **not** suppress core dumps. Consequences:

- The OS may page key material to **swap**.
- A **core dump** or **hibernation image** may capture it.
- The window is therefore not "while the command runs" — a key paged out during a
  200 ms scrypt operation can still be on disk days later.

What ShadowBit _does_ do: MEK buffers are explicitly zeroed in `finally` blocks
immediately after use, which shrinks the window but cannot close it. JS strings
are immutable and cannot be zeroed at all — see the keyfile note below.

**The mitigation is full-disk encryption** (FileVault, BitLocker, LUKS). FDE
covers swap, hibernation, and core dumps in a single stroke and is the correct
answer for every item in this section. Do not treat the absence of `mlock` as a
gap you need to work around; treat FDE as a prerequisite.

> Note: `mixKeyfileIntoPassword()` returns a hex **string**, so for keyfile-backed
> vaults the effective password lands on the V8 heap where zeroing cannot reach
> it. Prefer password-only vaults if that matters to your threat model.

### Why plaintext appears in a temp directory

The core product promise is _"decrypt to a folder, edit with your normal tools,
close to re-encrypt."_ That requires the plaintext to exist on disk while the
vault is open — it is a consequence of the design, not a defect. The alternatives
(each is a different product):

| Alternative                       | Why it is not used here                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FUSE mount (VeraCrypt)            | Solves plaintext-on-disk, but needs a native driver on Windows and is a packaging problem in Electron. **It also still holds keys in RAM**, so `mlock` would remain necessary |
| Per-file encryption (Cryptomator) | A directory, not one shareable file                                                                                                                                           |
| Keep everything in RAM (KeePass)  | You could not edit a file in Notepad — that capability is the product                                                                                                         |
| Streaming, one-shot (age)         | No persistent edit session                                                                                                                                                    |

A crash or reboot can leave an orphaned working directory behind. Run
`shadow-bit clean` to erase stale sessions and their directories.

## Guarantees worth knowing

- Opening a vault always verifies the password, even if a session already exists.
- Discarding an open vault requires the password; if the vault file was already
  deleted, discard skips auth and still cleans up the stale session/dir.
- Deleting or shredding a vault requires the password.
- Payload/vault size is capped (currently 1.5 GiB) and bundle entries are
  bounds-checked and path-traversal-rejected on unpack.
- A wrong password and a payload AEAD failure both raise the same
  `WrongCredentialError` ("Incorrect password or corrupt/tampered vault"), so
  the common failure paths are indistinguishable. One exception is deliberate:
  **header tampering is caught earlier**, by the v3 header MAC, and reports
  "Header integrity check failed". So ShadowBit _is_ a mild oracle for
  "did I mistype this, or was the header edited?" — accepted because that
  diagnostic is worth more to a user than the small amount of information it
  leaks.
- Symlinks and special files are **silently skipped** when packing a directory,
  and **rejected** by the `add` command and GUI drag-and-drop. Seeding or closing
  a folder that contains symlinks loses them.

## Reporting

Report security issues privately to the maintainers — do not open public issues
about vulnerabilities.
