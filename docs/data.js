// data.js — Static content for the ShadowBit documentation website.
// All user-visible text lives here. index.js renders it into the page.
window.APP_DATA = {
  meta: {
    title: "ShadowBit",
    tagline: "One encrypted file. One password. No accounts, no cloud.",
    subTagline: "Lock a folder into a single .svlt file and send it anywhere.",
    version: "1.1.4",
    // Owner is `luciVuc` — GitHub does NOT redirect on owner-name case, so the
    // lowercase spelling 404s. This was hand-transcribed from the author email
    // once and every download link on the site 404'd because of it.
    // `npm run check-repo-url` fails the build if this and package.json's
    // repository.url disagree; see scripts/sync-repo-url.js.
    github: "https://github.com/luciVuc/shadow-bit",
    license: "MIT",
  },

  // ─── Why ShadowBit? ───────────────────────────────────────────────────
  useCases: [
    {
      icon: "✉️",
      title: "Share sensitive files over email",
      desc: "Tax returns, contracts, medical records — drop them in a vault and email the single .svlt file. The recipient opens it with the password you share out-of-band. No cloud, no sign-up, no third party.",
      audience: "Freelancers, families, small businesses",
    },
    {
      icon: "💾",
      title: "Portable encrypted backups",
      desc: "Back up important documents to a USB stick or external drive as a single encrypted file. Move between computers without worrying about who reads the drive.",
      audience: "Anyone who carries files between devices",
    },
    {
      icon: "🖥️",
      title: "Protect files on shared computers",
      desc: "Keep personal files private on a family or work computer. Other users see a .svlt they cannot open without the password. Works alongside — not instead of — full-disk encryption.",
      audience: "Students, shared households, office workers",
    },
    {
      icon: "⚙️",
      title: "Automate secure archiving",
      desc: "Script vault creation in CI or cron jobs. Every command that authenticates with the vault password also reads SHADOWBIT_PASSWORD, and the app scrubs it from the environment after the first read. The --password flag still works but is deprecated — a command-line argument is visible to other users through ps and lands in your shell history.",
      audience: "DevOps, sysadmins, developers",
    },
  ],

  // ─── Features ─────────────────────────────────────────────────────────
  features: [
    {
      icon: "🔐",
      title: "AES-256-GCM Encryption",
      desc: "Authenticated encryption — a wrong password, or any tampering or corruption, fails loudly instead of returning garbage. AES-256-GCM is the default; ChaCha20-Poly1305 is available at creation time.",
    },
    {
      icon: "📦",
      title: "One Portable File",
      desc: "A vault is one .svlt file. Email it, drop it on USB, attach it to a message. The recipient needs only the file and the password — no registry, no side files, no account.",
    },
    {
      icon: "⚡",
      title: "Instant Password Changes",
      desc: "Envelope encryption: changing the password only re-wraps the master key — never the data. Password changes are instant regardless of how large the vault is.",
    },
    {
      icon: "🗝️",
      title: "Recovery Key",
      desc: "An optional high-entropy recovery key independently unlocks the vault if you forget the password. Shown once at creation; stored only as a salted scrypt-encrypted copy of the master key.",
    },
    {
      icon: "📎",
      title: "Keyfile — Second Factor",
      desc: "Any file becomes a required second factor. Without both the password and the exact keyfile, the vault stays locked. Store the keyfile separately from the vault for maximum protection.",
    },
    {
      icon: "🔀",
      title: "Algorithm Agility",
      desc: "Choose AES-256-GCM (default, hardware-accelerated) or ChaCha20-Poly1305 (software-friendly) at creation time. The choice is recorded in the vault — decryption is automatic.",
    },
    {
      icon: "🔒",
      title: "Paranoid Mode",
      desc: "Strip creation/modification timestamps and all metadata from the plaintext vault header. Combined with a keyfile and ChaCha20, this is the highest-privacy configuration.",
    },
    {
      icon: "🛡️",
      title: "Authenticated Header",
      desc: "The entire vault header is protected by an HMAC-SHA256 (HKDF-derived from the master key). Header tampering — changing KDF params, injecting fake recovery keys — is detected and rejected.",
    },
    {
      icon: "🖥️",
      title: "CLI + Desktop App",
      desc: "A desktop app for everyday use and a complete command-line interface for scripting and automation — two frontends over one encrypted vault format, so a file created in either opens in the other.",
    },
    {
      icon: "🔬",
      title: "Strong KDF",
      desc: "scrypt (N=2¹⁷, r=8, p=1) with a per-vault random salt makes brute-force attacks computationally expensive. KDF parameters are recorded in the header and validated before use.",
    },
  ],

  // ─── How it works ─────────────────────────────────────────────────────
  workflow: [
    {
      step: "01",
      title: "Create",
      icon: "✨",
      color: "cyan",
      desc: "Create a new vault file. Set a strong password. Optionally generate a recovery key, add a keyfile second factor, choose a cipher, or seed from an existing folder.",
      code: "./shadow-bit create secrets --seed ./my-docs",
    },
    {
      step: "02",
      title: "Open",
      icon: "🔓",
      color: "indigo",
      desc: "Decrypt the vault to a temporary working folder. Edit files with your normal file manager or any application. The vault file stays encrypted on disk.",
      code: "./shadow-bit open secrets",
    },
    {
      step: "03",
      title: "Edit",
      icon: "✏️",
      color: "violet",
      desc: "Add, edit, or delete files in the working folder using any tool. Use the add command to copy files in bulk from the CLI.",
      code: "./shadow-bit add secrets ./report.pdf ./photos/",
    },
    {
      step: "04",
      title: "Close",
      icon: "🔒",
      color: "emerald",
      desc: "Re-encrypt the working folder back into the vault. The temporary folder is securely wiped. The vault file is updated and its timestamps scrubbed to epoch.",
      code: "./shadow-bit close secrets",
    },
  ],

  // ─── Downloads ────────────────────────────────────────────────────────
  //
  // End-user install surface. Every artifact is a packaged desktop build
  // uploaded to the GitHub Release for its tag; the URLs are assembled at
  // render time from `releases.repo` + the tag, so a version bump never
  // leaves a hand-written URL pointing at a build that no longer exists.
  //
  // `detect` drives the "your platform" badge: it is matched against the
  // user-agent, which is the only OS signal available to a page that must run
  // over file:// with no server-side logic. It is a hint, never a filter.
  releases: {
    // The canonical repo URL. Every download link is built from this, so it is
    // the single place the casing has to be right — and it is the one that was
    // wrong. Kept in step with package.json by scripts/sync-repo-url.js.
    repo: "https://github.com/luciVuc/shadow-bit",
    /**
     * PREVIOUS releases only, newest first. The current version is NOT listed
     * here — it is `meta.version`, and the page prepends it to this list.
     *
     * v1.1.4 is the first published release, so this list starts empty: a
     * version belongs here only once its GitHub Release exists.
     * `npm run check-releases` enforces exactly that, because a well-formed
     * link to a release that does not exist is still a 404 — which is how the
     * site once advertised 1.0.0/1.1.0/1.1.2 while the repository had no
     * releases at all.
     *
     * That split is deliberate, not tidiness. `npm version` rewrites every
     * anchored version literal in this file, so a list of past releases kept in
     * the same shape as the current one would have 1.0.0 rewritten to 1.1.4 on
     * the next bump — the site would then offer a download for a version that
     * never existed and lose the real 1.0.0.
     *
     * The key is `release`, not `version`, and it has to stay that way: the
     * bump module anchors the current version on the text `version: "`, which
     * would also match a history entry spelled the same way. e2e/nfr.site.test.ts
     * replays a real bump and fails if the history moves.
     */
    // To add a release history entry: publish the release (tag + CI), then
    // add `{ release: "x.y.z", released: "YYYY-MM-DD" }` here. Adding it
    // BEFORE the release exists fails `npm run check-releases`.
    versions: [],
  },

  platforms: [
    {
      id: "macos",
      label: "macOS",
      icon: "🍎",
      detect: ["mac"],
      // Sizes are approximate and are for orientation only.
      builds: [
        {
          label: "macOS — Apple Silicon",
          file: "ShadowBit-1.1.4-arm64.dmg",
          format: ".dmg",
          size: "~99 MB",
          primary: true,
          arch: "M1 / M2 / M3 / M4",
        },
        {
          label: "macOS — Intel",
          file: "ShadowBit-1.1.4-x64.dmg",
          format: ".dmg",
          size: "~100 MB",
          arch: "Intel",
        },
      ],
      steps: [
        {
          title: "Open the downloaded disk image",
          desc: "Double-click the .dmg file. A window opens showing the ShadowBit app.",
        },
        {
          title: "Drag ShadowBit into Applications",
          desc: "Drag the app icon onto the Applications folder, then eject the disk image.",
        },
        {
          title: "Launch ShadowBit",
          desc: "Open it from Applications. Double-clicking a .svlt vault file now opens it in ShadowBit.",
        },
      ],
      note: "First launch: right-click the app in Applications → Open → Confirm. That bypasses the Gatekeeper warning the first time only.",
    },
    {
      id: "windows",
      label: "Windows",
      icon: "🪟",
      detect: ["win"],
      builds: [
        {
          label: "Windows 10 / 11",
          file: "ShadowBit Setup 1.1.4.exe",
          format: ".exe installer",
          size: "~98 MB",
          primary: true,
          arch: "64-bit",
        },
      ],
      steps: [
        {
          title: "Run the installer",
          desc: "Double-click the downloaded .exe. It is a standard installer — no scripts or command line needed.",
        },
        {
          title: "Follow the prompts",
          desc: "Choose where to install. The default is Program Files; a Start Menu shortcut is added.",
        },
        {
          title: "Launch ShadowBit",
          desc: "Open it from the Start Menu or by double-clicking any .svlt file.",
        },
      ],
      note: "If Windows SmartScreen warns about an unrecognised app, choose More info → Run anyway. This happens once, for unsigned builds.",
    },
    {
      id: "linux",
      label: "Linux",
      icon: "🐧",
      detect: ["linux", "x11"],
      builds: [
        {
          label: "Linux — AppImage",
          file: "ShadowBit-1.1.4.AppImage",
          format: ".AppImage",
          size: "~120 MB",
          primary: true,
          arch: "64-bit, any distro",
        },
        {
          label: "Linux — Debian / Ubuntu package",
          file: "shadow-bit_1.1.4_amd64.deb",
          format: ".deb",
          size: "~95 MB",
          arch: "64-bit, Debian family",
        },
      ],
      steps: [
        {
          title: "Make it executable",
          desc: "Open your Downloads folder in a terminal and mark the downloaded .AppImage as executable:",
          code: 'chmod +x "{file}"',
        },
        {
          title: "Run it",
          desc: "Double-click the file in your file manager, or launch it from that same terminal:",
          code: "./{file}",
        },
        {
          title: "Or install the .deb",
          desc: "Prefer a normal system install? Use the Debian package instead — it adds a menu entry and file association.",
        },
      ],
      note: "The AppImage runs on any modern 64-bit Linux distribution without installing anything.",
    },
  ],

  // ─── Installation: command line ────────────────────────────────────────
  //
  // The desktop app is the primary install path above. The CLI is installed
  // with a single command for people who already work in a terminal.
  cliInstall: {
    title: "Prefer the command line?",
    desc: "The CLI is the same engine the desktop app uses. Install it with one command — no build step, no dependencies to manage.",
    code: "npm install -g shadow-bit\nshadow-bit --help",
    note: "Every command that needs a password prompts for it invisibly. Nothing is stored in your shell history.",
  },

  // ─── CLI command reference ────────────────────────────────────────────
  commands: [
    {
      cmd: "create <name>",
      flags:
        "--password, --no-recovery, --seed <dir>, --name <text>, --description <text>, --keyfile <path...>, --cipher <alg>, --paranoid",
      desc: "Create a new encrypted vault. Prompts for a password and prints a one-time recovery key. Advanced: add a keyfile second factor, choose ChaCha20-Poly1305, or strip all header metadata with --paranoid (which overrides --name/--description).",
      example: "./shadow-bit create project --seed ./my-files --paranoid",
    },
    {
      cmd: "open <name>",
      flags: "--password, --keyfile <path...>",
      desc: "Decrypt the vault to a temporary working folder. The path is printed. Keyfile paths are remembered for the session duration.",
      example: "./shadow-bit open project --keyfile ~/usb/key.bin",
    },
    {
      cmd: "close <name>",
      flags: "--password, --keyfile <path...>",
      desc: "Re-encrypt the working folder back into the vault and securely wipe the temp dir. Keyfiles are auto-read from the session — no need to pass --keyfile explicitly.",
      example: "./shadow-bit close project",
    },
    {
      cmd: "discard <name>",
      flags: "--password, --keyfile <path...>",
      desc: "Throw away unsaved changes. Requires the vault password to authenticate the destructive operation, then securely wipes the working folder.",
      example: "./shadow-bit discard project",
    },
    {
      cmd: "add <name> <files…>",
      flags: "(none — vault must be open)",
      desc: "Copy files or folders into an open vault's working directory. Run close to re-encrypt and save.",
      example: "./shadow-bit add project ./report.pdf ./photos/",
    },
    {
      cmd: "info <name>",
      flags: "(none — no password needed)",
      desc: "Show vault metadata: version, size, recovery key status, cipher, whether a keyfile is required, compression, timestamps. Does not decrypt the payload and needs no password.",
      example: "./shadow-bit info project",
    },
    {
      cmd: "list",
      flags: "(none)",
      desc: "List all currently open vault sessions with their working folder paths and open times.",
      example: "./shadow-bit list",
    },
    {
      cmd: "change-password <name>",
      flags:
        "--password, --new-password, --keyfile <path...>, --new-keyfile <path...>",
      desc: "Change the vault password. Only the master key is re-wrapped — instant regardless of vault size. The payload is never re-encrypted. The current keyfile set carries over automatically; pass --new-keyfile to change it, or an empty list to drop the keyfile requirement.",
      example: "./shadow-bit change-password project --keyfile ~/usb/key.bin",
    },
    {
      cmd: "recover <name>",
      flags: "--recovery-key, --new-password",
      desc: "Reset a forgotten password using the recovery key. Both flags are deprecated (they leak through ps); omitting them prompts for the recovery key visibly — it is 40 Base32 characters in fixed groups, and a masked field hides exactly the one mistyped character that makes recovery fail. The new password is never read from an environment variable, so a fully unattended recover needs the deprecated flags.",
      example: "./shadow-bit recover project",
    },
    {
      cmd: "recovery-key <name>",
      flags:
        "--password, --keyfile <path...>, --remove, --upgrade, --recovery-key",
      desc: "Manage the recovery key: generate a new one (old key immediately invalidated), remove it entirely, or upgrade a legacy v1 escrow to the current salted v2 format (same key stays valid). Pass --keyfile on a keyfile-protected vault.",
      example: "./shadow-bit recovery-key project --remove",
    },
    {
      cmd: "meta <name>",
      flags:
        "--password, --name <text>, --description <text>, --keyfile <path...>",
      desc: "Get or set plaintext vault metadata. With no flags, shows current metadata (no password needed). With --name or --description, updates the header (requires password, plus --keyfile on a keyfile vault). Setting it on a paranoid-mode vault is allowed, but warns: that mode exists to keep the header free of optional plaintext, and this is plaintext.",
      example: "./shadow-bit meta project --name 'Tax 2025'",
    },
    {
      cmd: "delete <name>",
      flags:
        "--password, --keyfile <path...>, --shred, --passes <n>, -y / --yes",
      desc: "Permanently delete the vault file. Requires the vault password (and --keyfile on a keyfile-protected vault). Use --shred to overwrite bytes with random data first (best-effort on SSDs and copy-on-write filesystems).",
      example: "./shadow-bit delete project --shred --passes 7",
    },
    {
      cmd: "shred <name>",
      flags: "--password, --keyfile <path...>, --passes <n>, -y / --yes",
      desc: "Alias for delete --shred. Overwrites vault bytes before deleting. Best-effort on SSDs. Pass --keyfile on a keyfile-protected vault.",
      example: "./shadow-bit shred project -y",
    },
    {
      cmd: "clean",
      flags: "(none)",
      desc: "Remove stale sessions whose working directory or vault file no longer exists (e.g. after a crash or reboot). Securely erases any orphaned plaintext directories found.",
      example: "./shadow-bit clean",
    },
  ],

  // ─── Security properties ──────────────────────────────────────────────
  security: [
    {
      icon: "🔑",
      label: "Cipher",
      value: "AES-256-GCM",
      detail:
        "Default. Authenticated — detects tampering. Optional: ChaCha20-Poly1305.",
    },
    {
      icon: "⚗️",
      label: "KDF",
      value: "scrypt N=2¹⁷",
      detail: "r=8, p=1, per-vault random salt — makes brute-force expensive",
    },
    {
      icon: "🎲",
      label: "Master key",
      value: "256-bit MEK",
      detail: "Random per-vault; wrapped by password-derived key",
    },
    {
      icon: "🛡️",
      label: "Header integrity",
      value: "HMAC-SHA256",
      detail: "HKDF from MEK — prevents silent header manipulation",
    },
    {
      icon: "📜",
      label: "Recovery key",
      value: "Crockford Base32",
      detail:
        "Randomly generated; escrowed inside the vault as a salted scrypt-wrapped copy of the master key",
    },
    {
      icon: "📎",
      label: "Keyfile",
      value: "Second factor",
      detail:
        "Any file; mixed into scrypt derivation — password alone insufficient",
    },
    {
      icon: "🔒",
      label: "Paranoid mode",
      value: "Epoch timestamps",
      detail: "Strips all timing/metadata from the plaintext header",
    },
    {
      icon: "⏱️",
      label: "File timestamps",
      value: "Scrubbed to epoch",
      detail:
        "Vault atime/mtime are reset after writes; note the filesystem can still record its own metadata",
    },
    {
      icon: "🗂️",
      label: "OS indexing",
      value: "Suppressed, best-effort",
      detail:
        "Spotlight, Time Machine, Tracker, Baloo and Windows Search are each asked to skip the working folder — but every step is platform-dependent and some need privileges the app does not have, so this is a request, not a guarantee",
    },
    {
      icon: "📁",
      label: "Working folder",
      value: "Temp dir, mode 0700",
      detail: "mkdtemp; timestamps scrubbed; securely erased on close/discard",
    },
    {
      icon: "🔐",
      label: "Session files",
      value: "Encrypted at rest",
      detail:
        "Local 256-bit machine key (mode 0600) in the config dir — override with SHADOWBIT_CONFIG_DIR",
    },
    {
      icon: "🚧",
      label: "Payload cap",
      value: "1.5 GiB",
      detail:
        "Larger vaults are rejected with a clear error; the payload is buffered in memory, so a vault near the cap needs roughly twice its size in RAM",
    },
    {
      icon: "🔑",
      label: "Password policy",
      value: "8+ characters",
      detail: "Enforced in the core engine, not just the UI",
    },
  ],

  // ─── GUI tabs ─────────────────────────────────────────────────────────
  guiTabs: [
    {
      id: "open",
      label: "Open",
      icon: "🔓",
      desc: "Browse for a .svlt file, enter your password, and optionally select a keyfile. The working folder opens automatically in Finder or Explorer.",
    },
    {
      id: "create",
      label: "Create",
      icon: "✨",
      desc: "Choose a save path and set a password. Advanced options (collapsed): switch cipher, add a keyfile second factor, or enable paranoid mode to strip header metadata.",
    },
    {
      id: "manage",
      label: "Manage",
      icon: "⚙️",
      desc: "View vault info, change the password, recover with a recovery key, regenerate or remove the recovery key, edit the plaintext name and description, or delete and optionally shred the vault. Every action here authenticates, so a keyfile-protected vault asks for the keyfile too.",
    },
    {
      id: "sessions",
      label: "Open Vaults",
      icon: "📋",
      desc: "All active sessions. Drag files or folders onto a vault's drop zone or click Add Files… Then Close & Save to re-encrypt, or Discard to throw away changes. Keyfiles are remembered from open time.",
    },
  ],

  // ─── Q&A ───────────────────────────────────────────────────────────────
  // Every answer here must be true of THIS build. Where a capability exists in
  // src/core/ but no command reaches it, the answer says so plainly — see
  // docs/AGENTS.md, "Content accuracy". A security product's help section is
  // where a half-remembered capability becomes a false promise.
  qa: [
    {
      id: "basics",
      label: "Getting started",
      icon: "🚀",
      blurb:
        "What a vault actually is, where your files go, and what happens when you walk away from an open vault.",
      items: [
        {
          q: "What is a vault, and what happens to my files?",
          a: [
            "A vault is one .svlt file. Creating one packs a folder into a single encrypted bundle. Opening it decrypts that bundle into a temporary working folder you can edit with ordinary tools. Closing packs the folder back, re-encrypts, and securely wipes the working copy.",
            "The .svlt file itself is never edited in place — only the working folder is. That is why you can use Finder, Explorer or a text editor on the contents and still get them back encrypted.",
          ],
          code: "./shadow-bit create project --seed ./my-files\n./shadow-bit open project\n# edit files in the folder it printed\n./shadow-bit close project",
        },
        {
          q: "Where are my files while a vault is open?",
          a: [
            "In a temporary working folder under your system temp directory: $TMPDIR/shadow-bit/<vaultname>-<random>/, created with mode 0700 so other local accounts cannot read it. The desktop app opens it in Finder or Explorer for you; the CLI prints the path.",
            "The files there are plaintext, and they stay that way for as long as the vault is open. Close or discard the vault when you are done.",
          ],
        },
        {
          q: "Can I use the same vault on two computers?",
          a: [
            "Yes — that is the point of the format. Everything needed to decrypt a vault is inside the file, so you can copy it to a USB stick, hand it to a colleague, or open it on another machine with nothing installed but ShadowBit. There is no registry to sync and no account to sign in to.",
            "What does not travel is the session list: which vault is currently open, and where its working folder is. Each machine tracks that for itself, so the same vault can be open in two places at once, with two independent plaintext copies.",
          ],
        },
        {
          q: "What does an attacker learn from the .svlt file alone?",
          a: [
            "The header is plaintext and carries no secret — KDF parameters, a random per-vault salt, the password-wrapped master key, the recovery-wrapped copy, and the AEAD tag. Reading it tells them the file format version, the algorithm, that you use ShadowBit, how many bytes you stored, and — unless the vault was created with --paranoid — when it was created and last modified.",
            "The contents stay opaque. The payload is sealed with AES-256-GCM (or ChaCha20-Poly1305) under a random 256-bit master key that only your password — or your recovery key — unwraps.",
          ],
          note: {
            tone: "warn",
            text: "A .svlt file is recognisable. Paranoid mode hides timestamps and metadata inside the header; it does not make the file itself look like anything else.",
          },
        },
        {
          q: "Does ShadowBit ever talk to a network?",
          a: [
            "No. There is no network code in the application — no update check, no telemetry, no crash reporting, no account, no cloud. A vault is decrypted and encrypted entirely on the machine it is opened on.",
            "This page is static HTML, CSS and JavaScript with no external resources, which is why it also works offline and over file://.",
          ],
        },
        {
          q: "The desktop app locked my vault while I was busy. Why?",
          a: [
            "Auto-lock measures inactivity, not how long a vault has been open. The app counts keyboard and mouse activity in its own window, plus regaining window focus, and locks once none has arrived for the configured interval — so editing files in the working folder with another application looks exactly like doing nothing, and the lock fires.",
            "Locking overwrites and removes every open working folder. Anything you had not saved into the vault at that point is gone.",
          ],
          note: {
            tone: "info",
            text: "Settings (the gear icon, or Ctrl/Cmd+,) offers Never, 5, 15, 30 or 60 minutes; 30 is the default. File ▸ Lock All Vaults does the same thing on demand, and greys out when nothing is open.",
          },
        },
      ],
    },
    {
      id: "recipes",
      label: "How-to recipes",
      icon: "🧭",
      blurb:
        "Step-by-step for the features people actually reach for. Every command below exists in this build.",
      items: [
        {
          q: "How do I require a keyfile as well as the password?",
          a: [
            "Pass --keyfile at creation. The first 1 MiB of that file is hashed and mixed into the key derivation, so from then on both the password and the exact keyfile are required — the password alone derives a different key and opens nothing.",
            "Every command that authenticates against a vault accepts --keyfile. open remembers it for the session, so close and discard find it on their own; one-shot commands need it again.",
          ],
          code: "# Create with a keyfile second factor\n./shadow-bit create secret --keyfile ~/keys/vault.key\n\n# Open … then close (keyfile read from the session)\n./shadow-bit open  secret --keyfile ~/keys/vault.key\n./shadow-bit close secret\n\n# One-shot commands need it again\n./shadow-bit change-password secret --keyfile ~/keys/vault.key\n./shadow-bit recovery-key  secret --keyfile ~/keys/vault.key --remove\n./shadow-bit meta         secret --keyfile ~/keys/vault.key --name 'Tax 2025'\n./shadow-bit shred        secret --keyfile ~/keys/vault.key -y",
          note: {
            tone: "warn",
            text: "Keep the keyfile somewhere other than the vault — a USB stick, ideally. Losing it loses the vault: the keyfile is hashed into the derived password, so the recovery key cannot stand in for it.",
          },
        },
        {
          q: "How do I switch to ChaCha20-Poly1305?",
          a: [
            "At creation only — the algorithm is recorded in the vault header and there is no command to change it on an existing vault. Choose ChaCha20-Poly1305 if you would rather not depend on hardware AES acceleration, or want diversity against future cryptanalytic progress on a single algorithm.",
            "To move an existing vault to the other cipher, create a new one with the cipher you want and copy the files across while it is open.",
          ],
          code: "./shadow-bit create secret --cipher chacha20-poly1305",
        },
        {
          q: "How do I create a vault with no timestamps or metadata?",
          a: [
            "Paranoid mode pins the header's created and modified timestamps to 1970-01-01 and drops the name and description. It survives every later write — close, password change and recovery all keep writing epoch timestamps — and it is the smallest header footprint ShadowBit can produce.",
          ],
          code: "./shadow-bit create secret --paranoid --keyfile ~/keys/vault.key --cipher chacha20-poly1305",
          note: {
            tone: "info",
            text: "You can still add a description afterwards with 'shadow-bit meta'. It is allowed, and it warns you — the text is stored in plaintext in the header, readable by anyone who has the file.",
          },
        },
        {
          q: "How do I share a vault with someone?",
          a: [
            "Create it, put the files in, close it, send the single .svlt file, and share the password over a different channel. The recipient needs the file and the password — nothing else, and no account on your side.",
          ],
          code: "# Sender\n./shadow-bit create shared --no-recovery\n./shadow-bit open  shared\n# copy files into the working folder it printed\n./shadow-bit close shared\n\n# Send shared.svlt; give the password over a call or in person\n\n# Recipient\n./shadow-bit open received.svlt",
        },
        {
          q: "How do I automate this in a script or cron job?",
          a: [
            "Use the SHADOWBIT_PASSWORD environment variable. Prefer it over --password: a command-line argument is visible to every user on the machine through ps, and is recorded in your shell history. ShadowBit reads the variable once and then deletes it from its own environment.",
            "Both open and close are needed around whatever you want to capture — that is the only way to get plaintext into a vault from a script.",
          ],
          code: 'export SHADOWBIT_PASSWORD="$VAULT_PASS"\n\n./shadow-bit create backup --no-recovery\n./shadow-bit open backup\nWD="$(./shadow-bit info backup | awk \'/Working dir/{print $3}\')"\nrsync -av ~/Documents/ "$WD/"\n./shadow-bit close backup',
          note: {
            tone: "warn",
            text: "recover has no environment variable for the recovery key — it is always prompted, visibly. An unattended password reset needs the deprecated --recovery-key / --new-password flags, which leak through ps.",
          },
        },
        {
          q: "How do I inspect a vault without opening it?",
          a: [
            "info reads the plaintext header only: format version, file size, whether a recovery key exists, which cipher, whether a keyfile is required, and whether the vault is currently open. It needs no password and decrypts nothing.",
            "The file listing lives inside the encrypted payload, so there is nothing to show without the password — that is the point.",
          ],
          code: "./shadow-bit info project\n./shadow-bit list   # every vault currently open on this machine",
        },
        {
          q: "How do I rotate the recovery key, or remove it?",
          a: [
            "Running recovery-key with no options mints a new key and immediately invalidates the old one. --remove deletes the escrow entirely, leaving the password as the only way in — which is a real loss of recoverability, so keep it in mind.",
          ],
          code: "./shadow-bit recovery-key project          # new key; the old one stops working\n./shadow-bit recovery-key project --remove  # password is now the only way in",
        },
        {
          q: "How do I delete a vault for good?",
          a: [
            "delete removes the file; shred overwrites its bytes with random data first, --passes times (3 by default). Both authenticate with the password, and both accept --keyfile on a keyfile-protected vault, so nothing happens by accident.",
          ],
          code: "./shadow-bit shred project --passes 7\n./shadow-bit delete project",
          note: {
            tone: "warn",
            text: "Overwriting is best-effort. SSDs, APFS and other copy-on-write filesystems use wear-leveling and snapshots, so old blocks can survive. Full-disk encryption is what actually makes the old data unrecoverable.",
          },
        },
        {
          q: "How do I clean up after a crash or reboot?",
          a: [
            "Sessions live in ~/.shadow-bit/sessions.json and point at working folders in the temp directory. After a reboot those folders are gone but the entries may not be, so clean drops any session whose working folder or vault file no longer exists — and securely erases an orphaned folder if one somehow survived.",
            "Opening a vault whose stale session points at a deleted folder works anyway: ShadowBit notices the folder is missing and decrypts afresh.",
          ],
          code: "./shadow-bit list     # what ShadowBit thinks is open\n./shadow-bit clean    # drop entries whose folder or vault is gone",
        },
      ],
    },
    {
      id: "privacy",
      label: "Privacy & limits",
      icon: "🔍",
      blurb:
        "What ShadowBit does not do, stated plainly. If a guarantee is missing from here, it does not exist.",
      items: [
        {
          q: "Can I create a duress password or a decoy vault?",
          a: [
            "Not in this build. The cryptography for a VeraCrypt-style hidden volume exists in the core library — src/core/hidden.ts composes a fixed-size container holding two independently keyed volumes separated by random padding, so a decoy password opens a real working vault and the inner volume cannot be proven to exist — but no CLI command and no desktop control calls it. There is nothing for you to run.",
            "Treat it as unfinished work rather than a feature you can rely on. ROADMAP.md §21.3 tracks it.",
          ],
          note: {
            tone: "info",
            text: "What you can do today is keep a second, entirely unrelated vault and hand that password over under pressure. That is not deniability — the real vault's existence is not concealed, and this build makes no claim that it is — but it does control what a compelled disclosure reveals.",
          },
        },
        {
          q: "Can I hide a vault inside a photo or PDF (steganography)?",
          a: [
            "Not in this build either. src/core/stego.ts implements appending a vault after a carrier file's end-of-file, so any viewer still opens the carrier normally, and it round-trips correctly in the test suite — but again nothing in the CLI or the app imports it, so there is no command to embed or extract a vault.",
            "ROADMAP.md §21.4 tracks it. Today a .svlt file is opaque, but it is not disguised.",
          ],
        },
        {
          q: "Is my data encrypted on disk while the vault is open?",
          a: [
            "No. The working folder is plaintext — that is precisely what lets you edit the files with ordinary tools, and it is the central trade-off of this product rather than a defect.",
            "What ShadowBit does around it: the folder is created with mode 0700 under a private temp directory, OS indexers are asked to skip it, file timestamps are scrubbed to epoch, and the folder is overwritten and removed on close, discard, lock and delete.",
          ],
          note: {
            tone: "warn",
            text: "For a hard guarantee, run full-disk encryption (FileVault, BitLocker, LUKS) alongside ShadowBit. That also covers swap, hibernation images and crash dumps, which the vault file itself never touches.",
          },
        },
        {
          q: "How strong is the password protection in practice?",
          a: [
            "The key derivation is scrypt with N=2¹⁷, r=8, p=1 and a fresh random salt per vault, which makes each guess expensive and makes precomputed tables useless.",
            "The only password rule enforced anywhere — CLI, desktop app and core alike — is a minimum of eight characters. There is no enforced complexity requirement and no enforced blocklist of common passwords: the desktop app shows a strength meter, but it is advice, not a gate. Use a long passphrase; four or five unrelated words beats a short complex string.",
          ],
        },
        {
          q: "Are my password or recovery key stored anywhere on this machine?",
          a: [
            "Neither is ever written to disk. What lives in ~/.shadow-bit/ is housekeeping: the list of open sessions (paths and timestamps, no secrets) and app preferences (recent vaults, theme, auto-lock duration, window size). Both are encrypted at rest with a local 256-bit machine key held in .local-key with mode 0600.",
            "That key protects only that housekeeping data. Deleting the whole ~/.shadow-bit directory costs you your recent-vaults list and window position — never a vault, which is self-contained by design.",
          ],
        },
        {
          q: "What happens to keys while a vault is open?",
          a: [
            "Key material lives in ordinary process memory for the duration of an operation. ShadowBit does not use mlock and does not suppress core dumps, so the operating system is free to page key material into swap or capture it in a crash dump or hibernation image.",
            "Key buffers are zeroed immediately after use, which narrows that window without closing it. Full-disk encryption is the mitigation, and it is worth treating as a prerequisite rather than a nice-to-have.",
          ],
        },
        {
          q: "Has ShadowBit been independently audited?",
          a: [
            "No. It has been through an internal code review whose findings were fixed and covered by regression tests — 232 automated tests across crypto round-trips, the real CLI as a subprocess, the real desktop app, WCAG 2.2 AA accessibility, responsive reflow and performance budgets. Nobody outside the project has assessed it.",
            "SECURITY.md documents the threat model, including what is explicitly out of scope. For classified or life-critical data, choose a tool with outside scrutiny.",
          ],
        },
      ],
    },
    {
      id: "troubleshooting",
      label: "Troubleshooting",
      icon: "🛟",
      blurb:
        "The exact error strings you will see, and what each one actually means.",
      items: [
        {
          q: "“Incorrect password or corrupt/tampered vault.”",
          a: [
            "One message covers three causes on purpose. A wrong password, a corrupted file and a tampered payload all surface as an AEAD authentication failure, and telling them apart would hand an attacker an oracle.",
            'Work through it in this order: check the password first (caps lock, keyboard layout, a password manager that autofills a different one); then run info, which reads the header without a password and will tell you outright if the file is not a vault at all; then, if a recovery key exists, use it. Recovery only needs the header, so a wrong key still reports "Incorrect recovery key" even when the payload is the damaged part — but note it re-wraps the key rather than repairing the payload, so a vault that was already corrupt stays corrupt.',
          ],
          code: "./shadow-bit info project    # header only, no password\n./shadow-bit recover project  # needs just the recovery key",
        },
        {
          q: "“This vault requires a keyfile.”",
          a: [
            "The header records that the vault was created with a keyfile, and every authenticating operation fails closed without one — there is no path that quietly falls back to the password alone. Pass --keyfile on the command line, or pick the keyfile in the desktop app's dialog.",
            "If you opened with --keyfile, close and discard remember it for the session. One-shot commands do not, which is why they ask again.",
          ],
        },
        {
          q: "“The vault file has been modified since it was opened.”",
          a: [
            "While a vault is open, ShadowBit remembers a hash of its header and refuses to close over a file that changed underneath — the same vault opened from two places, or another tool rewriting it — because closing would silently discard whatever else was written.",
            "Re-open the vault to pick up the current version, then close. Your working folder is untouched either way, so nothing is lost.",
          ],
        },
        {
          q: "“Vault is not open.”",
          a: [
            "close and discard need an open session: a working folder on disk that ShadowBit still tracks. Open the vault first.",
            "If the session is stale — a reboot, or a working folder deleted by hand — list shows what ShadowBit believes is open, and clean drops entries whose working folder or vault file no longer exists.",
          ],
          code: "./shadow-bit list\n./shadow-bit clean",
        },
        {
          q: "“This vault expands to more than 1.5 GiB of data…”",
          a: [
            "The payload is decrypted into memory in one piece, and the 1.5 GiB limit applies to the compressed size. A vault that compresses extremely well — a sparse image, a log full of zeros — expands past what one process can hold, and ShadowBit refuses rather than dying of an out-of-memory error.",
            "The vault itself is not damaged; it just cannot be opened by this build. Split it into several vaults.",
          ],
        },
        {
          q: "“This file carries a hidden volume, which this operation cannot rewrite…”",
          a: [
            "A container built through the hidden-volume library API has a second encrypted volume appended after the outer payload. Commands that rewrite the whole file — close, change-password, recover, meta, recovery-key — refuse rather than drop that tail, because doing so would destroy the hidden volume and shrink the fixed-size decoy to a few hundred bytes, which is itself proof that one had existed.",
            "Nothing was modified. You will only meet this on a file created through that library API, which this build's CLI and app cannot do.",
          ],
        },
        {
          q: "“Not a valid vault file (bad magic bytes).”",
          a: [
            "Either the file is not a ShadowBit vault, or it was written by an older build of ShadowBit. Those older files carry a different magic and are rejected as corrupt — there is no compatibility path, and none is planned. Recover such a vault with the version of ShadowBit that created it, then re-save it.",
            "A vault written by any current build starts with the current magic, and every container of format version 1 to 3 parses and opens. (The container format version and the app version are unrelated numbers — see the CLI reference.)",
          ],
        },
        {
          q: "Can I open a vault on a machine where I only have the file?",
          a: [
            "Yes. You need the .svlt file, the password, and any keyfile it requires. Nothing has to be registered or configured first: run open on the file, or pick it in the desktop app.",
          ],
          code: "./shadow-bit open received.svlt",
        },
      ],
    },
  ],

  // ─── Developer documentation (docs/dev.html only) ──────────────────────
  //
  // Contributor-facing content lives here and is rendered by dev.html. It is
  // deliberately NOT part of index.html: the marketing page is for people who
  // want to use ShadowBit, and a source tree is noise to them.
  //
  // The architecture[] entries describing a module no command can reach
  // (hidden.ts, stego.ts) must keep saying so here, exactly as they did on the
  // main page — see docs/AGENTS.md, "Content accuracy".
  devSetup: {
    prerequisites: [
      "Node.js 20 or newer",
      "npm (ships with Node.js)",
      "No C toolchain needed — every cryptographic primitive comes from Node's own built-ins",
    ],
    steps: [
      {
        title: "Clone and install dependencies",
        code: "git clone https://github.com/luciVuc/shadow-bit.git\ncd shadow-bit\nnpm install",
      },
      {
        title: "Run the CLI straight from source (no build step)",
        code: "npm run cli -- --help\n# or, without npm:\n./shadow-bit --help",
      },
      {
        title: "Build the desktop app and launch it",
        code: "npm run gui\n# build + launch\nnpm run gui:dev\n# launch without rebuilding",
      },
      {
        title: "Run the tests",
        code: "npm run verify\n# build + core tests + CLI E2E + GUI smoke + accessibility/responsive/performance/site suites",
      },
    ],
    packaging: [
      {
        title: "Produce installers",
        code: "npm run package:mac     # .dmg + .zip  (macOS host only)\nnpm run package:win     # .exe          (needs wine on Linux)\nnpm run package:linux   # .AppImage + .deb\n\n# output lands in release/<platform>/<version>/, so builds of\n# different platforms or versions never overwrite each other",
      },
      {
        title: "Prune old builds",
        code: "npm run clean:release -- --dry-run\nnpm run clean:release -- --keep 2 -y\n\n# release/ keeps every version it ever built; this trims\n# the old ones. Published builds are safe — they live on\n# their GitHub Release, which is what the website links to.",
      },
      {
        title: "Smoke-test a packaged build",
        code: "npm run package:dir\nnpm run test:packaged\n# catches what a dist/ run cannot: a file that only\n# exists inside the packaged app layout",
      },
    ],
    note: "macOS and Windows artifacts must be built on their own OS — code signing and notarization require it. See README.md for the full developer guide.",
  },

  // ─── Architecture ─────────────────────────────────────────────────────
  architecture: [
    {
      path: "src/core/",
      desc: "Shared, UI-agnostic cryptographic engine — no UI dependencies",
      files: [
        {
          name: "crypto.ts",
          desc: "scrypt KDF, AES-256-GCM, ChaCha20-Poly1305, MEK & recovery-key helpers, keyfile processing, password strength estimation, HKDF header authentication",
        },
        {
          name: "container.ts",
          desc: ".svlt binary format (magic SHDBIT\\0\\1, plaintext header + ciphertext payload, atomic tmp+rename writes, epoch timestamp scrubbing)",
        },
        {
          name: "bundle.ts",
          desc: "Dependency-free directory ↔ buffer archive (no tar/zip dependency)",
        },
        {
          name: "vault.ts",
          desc: "High-level orchestrator — all vault operations: create, open, close, discard, change-password, recover, add, delete, setMeta, getInfo",
        },
        {
          name: "sessions.ts",
          desc: "Open-vault session tracking — paths and keyfile references, encrypted at rest via localkey",
        },
        {
          name: "localkey.ts",
          desc: "256-bit local machine key (mode 0600) for encrypting session and settings files — no plaintext secrets on disk",
        },
        {
          name: "settings.ts",
          desc: "User preferences: recent vaults, auto-lock timeout, theme, window bounds — encrypted at rest",
        },
        {
          name: "fsutil.ts",
          desc: "Secure erase, symlink-safe copies, best-effort OS indexing suppression (Spotlight/Time Machine/Tracker/Baloo/Windows Search), filesystem timestamp scrubbing",
        },
        {
          name: "stego.ts",
          desc: "Carrier-file steganography (magic SBSTEG\\0\\1). Library code only — not reachable from the CLI or desktop app yet",
        },
        {
          name: "hidden.ts",
          desc: "Outer (decoy) + inner (real) volumes in a fixed-size container. Library code only — not reachable from the CLI or desktop app yet",
        },
        {
          name: "vault-worker.ts",
          desc: "Worker thread bridge — offloads heavy scrypt/AES operations so the Electron main process stays responsive",
        },
        {
          name: "types.ts",
          desc: "Shared TypeScript type definitions: VaultHeader, VaultSession, KdfParams, VaultInfo, etc.",
        },
      ],
    },
    {
      path: "src/cli/",
      desc: "Command-line interface — 14 commands, hidden password prompts by default",
      files: [
        { name: "index.ts", desc: "All 14 CLI commands (commander)" },
        {
          name: "prompts.ts",
          desc: "Hidden password input, confirmation prompts, raw TTY handling",
        },
      ],
    },
    {
      path: "src/gui/",
      desc: "Electron desktop application",
      files: [
        {
          name: "main.ts",
          desc: "Electron main process + IPC handlers for all vault operations",
        },
        {
          name: "preload.ts",
          desc: "Secure context bridge (contextBridge) — typed window.shadowbit API",
        },
        {
          name: "vault-worker-bridge.ts",
          desc: "Dispatches heavy operations to the vault worker thread",
        },
        {
          name: "renderer/",
          desc: "Vanilla HTML/CSS/JS UI — no framework, no bundler required",
        },
      ],
    },
    {
      path: "src/test/ + e2e/",
      desc: "Test suite — 232 tests across 7 runners (node:test + Playwright)",
      files: [
        {
          name: "src/test/core.test.ts",
          desc: "89 tests: cryptographic round-trips, error cases, paranoid mode, the full keyfile lifecycle, cipher agility, timestamp scrubbing, local-key and session-lock races",
        },
        {
          name: "src/test/cli.test.ts",
          desc: "10 tests: the CLI lifecycle end to end — create, open, add, close, reopen, plus error paths and the recovery-key upgrade",
        },
        {
          name: "e2e/cli.test.ts",
          desc: "36 tests: the real CLI as a subprocess — the whole option matrix including keyfiles, shred, recovery-key rotation and cipher validation",
        },
        {
          name: "e2e/smoke.test.ts",
          desc: "26 tests: the real Electron app — tab flows, metadata, settings, dialogs and window sizing",
        },
        {
          name: "e2e/nfr.*.test.ts",
          desc: "71 tests: WCAG 2.2 AA, XS-XL responsive reflow, asset/interaction budgets against the real renderer, and docs-site self-containment plus Q&A accuracy",
        },
      ],
    },
  ],
};
