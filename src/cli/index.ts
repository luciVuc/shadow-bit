#!/usr/bin/env node
// shadow-bit CLI — create, open, close, and manage encrypted, shareable
// stealth vault containers.

import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import pc from "picocolors";
import {
  addToSession,
  changePassword,
  closeVault,
  createVault,
  deleteVault,
  discardVault,
  getInfo,
  openVault,
  recoverVault,
  regenerateRecoveryKey,
  removeRecoveryKey,
  setMeta,
  upgradeRecoveryEscrow,
} from "../core/vault";
import { loadSessions, removeSession } from "../core/sessions";
import { secureEraseDir } from "../core/fsutil";
import { confirm, prompt, promptHidden, promptNewPassword } from "./prompts";

const program = new Command();

// package.json is the single source of truth for the app version, so read it at
// runtime instead of hardcoding. It cannot be a static `import` because
// tsconfig's rootDir is src/, and a JSON import from outside that root fails the
// build. `__dirname/../..` resolves to the project root from both src/cli/ (tsx)
// and dist/cli/ (compiled), and from the packaged app root inside the asar.
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(3)} GB`;
}

function resolveVaultPath(name: string): string {
  // Accept either a path or a bare name. A bare name with no extension gets
  // the .vault suffix; existing files are always used exactly as given even
  // if they have no extension (L9).
  let p = name;
  const base = path.basename(p);
  if (!fs.existsSync(p) && !base.includes(".")) p += ".vault";
  return path.resolve(p);
}

function box(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const top = "╭" + "─".repeat(width + 2) + "╮";
  const bot = "╰" + "─".repeat(width + 2) + "╯";
  const body = lines.map((l) => `│ ${l.padEnd(width)} │`).join("\n");
  return `${top}\n${body}\n${bot}`;
}

/**
 * Read a secret from a flag, the SHADOWBIT_PASSWORD env var, or a hidden prompt.
 *
 * `--password` is DEPRECATED and warns on stderr. A command-line argument is
 * visible to anyone who can run `ps aux` on the machine while the command
 * runs, and it is captured verbatim in shell history and in `~/.bash_history`.
 * The env var is also visible to same-user processes via /proc on Linux, so it
 * is only marginally better — but it is not in your shell history, and this
 * helper scrubs it from the environment immediately after reading it. The
 * hidden prompt is the right default.
 *
 * `hidden: false` is for secrets the user must be able to SEE while typing or
 * verifying — a recovery key is 44 characters of Base32 in fixed groups, and a
 * single mistyped character means a failed recovery, so masking it actively
 * hurts. It is still never echoed to a log the user does not control by
 * accident, and `--flag` usage for it still warns (see warnSecretFlag).
 */
async function getPassword(
  flagValue: string | undefined,
  promptText = "Password: ",
  hidden = true,
): Promise<string> {
  if (flagValue) {
    warnSecretFlag("--password");
    return flagValue;
  }
  // Env var: read once, then scrub it so it doesn't linger in memory.
  const envPw = process.env.SHADOWBIT_PASSWORD;
  if (envPw) {
    delete process.env.SHADOWBIT_PASSWORD;
    return envPw;
  }
  return hidden ? promptHidden(promptText) : prompt(promptText);
}

/**
 * Warn that a secret was passed as a command-line argument.
 *
 * Every flag that carries a secret must go through this, not just --password.
 * --new-password and --recovery-key were accepted with no warning at all, which
 * is worse than not deprecating anything: the guidance said "don't put your
 * password on the command line" while three of the four secret-bearing flags
 * silently did exactly that, into shell history, and into `ps` output.
 */
function warnSecretFlag(flag: string): void {
  process.stderr.write(
    `warning: ${flag} is deprecated and exposes the secret to other users ` +
      "via `ps`, and to your shell history.\n" +
      "         Prefer the hidden prompt (omit the flag) or " +
      "SHADOWBIT_PASSWORD.\n",
  );
}

/**
 * Resolve a recovery key from its flag or a prompt.
 *
 * The prompt is visible on purpose (see getPassword), but --recovery-key gets
 * the same deprecation warning as every other secret-bearing flag.
 */
async function getRecoveryKey(
  flagValue: string | undefined,
  promptText = "Recovery key: ",
): Promise<string> {
  if (flagValue) {
    warnSecretFlag("--recovery-key");
    return flagValue;
  }
  return prompt(promptText);
}

program
  .name("shadow-bit")
  .description("Stealth containers. Enhanced privacy. Total control.")
  .version(readAppVersion());

// --- create ---------------------------------------------------------------
program
  .command("create")
  .argument("<name>", "vault name or path (e.g. secret or secret.vault)")
  .description("Create a new encrypted vault container")
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--no-recovery", "do not generate a recovery key")
  .option("--seed <dir>", "seed the vault with files from a directory")
  .option("--name <text>", "optional plaintext vault name (metadata)")
  .option("--description <text>", "optional plaintext description (metadata)")
  .option("--keyfile <path...>", "keyfile(s) required for future opens")
  .option(
    "--cipher <alg>",
    "encryption algorithm: aes-256-gcm (default) or chacha20-poly1305",
  )
  .option("--paranoid", "strip timestamps and metadata from the vault header")
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const password = await getPassword(opts.password, "Set password: ");
      if (opts.seed && !fs.existsSync(opts.seed)) {
        throw new Error(`Seed directory not found: ${opts.seed}`);
      }
      const result = createVault(vaultPath, {
        password,
        generateRecovery: opts.recovery !== false,
        seedDir: opts.seed,
        keyfiles: opts.keyfile,
        cipher: opts.cipher,
        paranoid: opts.paranoid,
        meta:
          opts.name || opts.description
            ? { name: opts.name, description: opts.description }
            : undefined,
      });

      // --paranoid strips every metadata field, so --name/--description cannot
      // be honoured. Say so instead of silently writing them back.
      if (opts.paranoid && (opts.name || opts.description)) {
        console.log(
          pc.yellow("⚠") +
            "  --paranoid strips all metadata; --name/--description were ignored.",
        );
      }

      if (result.recoveryKey) {
        console.log(
          "\n" +
            box([
              "RECOVERY KEY — save this somewhere safe!",
              "",
              result.recoveryKey,
              "",
              "You will need this if you forget your password.",
              "It cannot be recovered later.",
            ]),
        );
        const ans = await prompt("\nType 'saved' to confirm you stored it: ");
        if (ans.trim().toLowerCase() !== "saved") {
          console.log(
            pc.yellow("⚠") +
              "  Recovery key not confirmed, but the vault was created.",
          );
        }
      }
      console.log("\n" + pc.green("✓") + ` Created vault: ${result.vaultPath}`);
      console.log("  Share this single file as an attachment; the recipient");
      console.log("  opens it with:  shadow-bit open <file>");
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- open -----------------------------------------------------------------
program
  .command("open")
  .argument("<name>", "vault name or path")
  .description("Decrypt a vault to a temporary working folder")
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--keyfile <path...>", "keyfile(s) for this vault")
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const password = await getPassword(opts.password);
      const { workingDir } = openVault(vaultPath, password, opts.keyfile);
      console.log(pc.green("✓") + ` Opened. Working folder:\n  ${workingDir}`);
      console.log("\n  Add/edit files there, then run:");
      console.log(`    shadow-bit close ${name}`);
      console.log("  (or  shadow-bit discard  to throw away changes)");
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- close ----------------------------------------------------------------
program
  .command("close")
  .argument("<name>", "vault name or path")
  .description("Re-encrypt the working folder back into the vault")
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--keyfile <path...>", "keyfile(s) for this vault")
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const password = await getPassword(opts.password);
      closeVault(vaultPath, password, opts.keyfile);
      console.log(
        pc.green("✓") + " Closed. All changes re-encrypted into the vault.",
      );
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- discard --------------------------------------------------------------
program
  .command("discard")
  .argument("<name>", "vault name or path")
  .description("Discard the working folder WITHOUT saving changes")
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--keyfile <path...>", "keyfile(s) for this vault")
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    if (!(await confirm("Discard all unsaved changes?"))) return;
    try {
      const password = await getPassword(opts.password);
      discardVault(vaultPath, password, opts.keyfile);
      console.log(pc.green("✓") + " Working folder discarded.");
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- info -----------------------------------------------------------------
program
  .command("info")
  .argument("<name>", "vault name or path")
  .description("Show vault metadata (no password needed)")
  .action((name) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const info = getInfo(vaultPath);
      console.log(`Vault:        ${info.vaultPath}`);
      console.log(`Version:      ${info.version}`);
      console.log(`Size:         ${formatBytes(info.fileSize)}`);
      console.log(`Recovery key: ${info.hasRecoveryKey ? "yes" : "no"}`);
      console.log(`Cipher:       ${info.cipher}`);
      console.log(
        `Keyfile:      ${info.keyfileRequired ? "required" : "not required"}`,
      );
      console.log(`Compressed:   ${info.compressed ? "yes" : "no"}`);
      if (info.meta?.name) console.log(`Name:         ${info.meta.name}`);
      if (info.meta?.description)
        console.log(`Description:  ${info.meta.description}`);
      console.log(`Created:      ${info.createdAt}`);
      console.log(`Modified:     ${info.modifiedAt}`);
      console.log(`Open:         ${info.isOpen ? "yes" : "no"}`);
      if (info.workingDir) console.log(`Working dir:  ${info.workingDir}`);
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- list -----------------------------------------------------------------
program
  .command("list")
  .description("List currently open vault sessions")
  .action(() => {
    const sessions = loadSessions();
    if (sessions.length === 0) {
      console.log("No open vaults.");
      return;
    }
    console.log(pc.cyan("OPEN VAULTS:"));
    for (const s of sessions) {
      console.log(`  ${s.vaultPath}`);
      console.log(`    → ${s.workingDir}  (opened ${s.openedAt})`);
    }
  });

// --- change-password ------------------------------------------------------
program
  .command("change-password")
  .argument("<name>", "vault name or path")
  .description("Change the vault password (payload is not re-encrypted)")
  .option("--password <pwd>", "current password (omit for a hidden prompt)")
  .option(
    "--new-password <pwd>",
    "new password — DEPRECATED, leaks via `ps`; omit for a hidden prompt",
  )
  .option("--keyfile <path...>", "keyfile(s) for the CURRENT vault")
  .option(
    "--new-keyfile <path...>",
    "keyfile(s) required after the change (omit to keep the current set)",
  )
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const oldPassword = await getPassword(
        opts.password,
        "Current password: ",
      );
      if (opts.newPassword) warnSecretFlag("--new-password");
      const newPassword =
        opts.newPassword || (await promptNewPassword("new password"));
      changePassword(vaultPath, oldPassword, newPassword, {
        keyfiles: opts.keyfile,
        newKeyfiles: opts.newKeyfile,
      });
      console.log(pc.green("✓") + " Password changed.");
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- add ------------------------------------------------------------------
program
  .command("add")
  .argument("<name>", "vault name or path (must be open)")
  .argument("<files...>", "files or folders to copy into the open vault")
  .description("Copy files/folders into an open vault working folder")
  .action((name, files) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const { count, symlinksSkipped } = addToSession(vaultPath, files);
      console.log(
        pc.green("✓") + ` Added ${count} item(s). Run 'close' to save them.`,
      );
      if (symlinksSkipped > 0) {
        console.log(
          pc.yellow("⚠") +
            `  ${symlinksSkipped} symlink(s) were skipped (symlinks cannot be stored in vaults).`,
        );
      }
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- delete ---------------------------------------------------------------
program
  .command("delete")
  .argument("<name>", "vault name or path")
  .description("Permanently delete a vault file")
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--keyfile <path...>", "keyfile(s) for this vault")
  .option("--shred", "overwrite the file with random data before deleting")
  .option("--passes <n>", "number of overwrite passes (with --shred)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (name, opts) => {
    await runDelete(
      name,
      !!opts.shred,
      opts.yes,
      opts.passes,
      opts.password,
      opts.keyfile,
    );
  });

// --- shred ----------------------------------------------------------------
program
  .command("shred")
  .argument("<name>", "vault name or path")
  .description("Permanently delete a vault, overwriting its bytes first")
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--keyfile <path...>", "keyfile(s) for this vault")
  .option("--passes <n>", "number of overwrite passes")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (name, opts) => {
    await runDelete(
      name,
      true,
      opts.yes,
      opts.passes,
      opts.password,
      opts.keyfile,
    );
  });

/** Overwrite passes used when `--passes` is not given. */
const DEFAULT_SHRED_PASSES = 3;

/**
 * Validate a `--passes` value.
 *
 * `parseInt(x, 10) || 3` used to be the whole of this, and it quietly accepted
 * three things a user did not ask for: `--passes 0` and `--passes abc` both fell
 * back to 3 (0 is falsy, and parseInt of "abc" is NaN), and `--passes 2.5`
 * became a silent 2. On a shred the pass count is the only difference between
 * "overwrote before unlinking" and "deleted", so a typo must be an error rather
 * than a substituted number.
 */
function parsePasses(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHRED_PASSES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--passes must be a positive whole number.");
  }
  return n;
}

async function runDelete(
  name: string,
  shred: boolean,
  yes: boolean,
  passesRaw: string | undefined,
  passwordFlag?: string,
  keyfiles?: string[],
): Promise<void> {
  const vaultPath = resolveVaultPath(name);
  try {
    // Parse inside the try so a bad --passes reports as a normal "✗ message"
    // rather than an unhandled rejection from the action handler.
    const passes = parsePasses(passesRaw);
    if (!yes) {
      const action = shred ? "SHRED (unrecoverable)" : "permanently delete";
      if (!(await confirm(`${action} ${vaultPath}?`))) {
        console.log("Cancelled.");
        return;
      }
    }
    const password = await getPassword(passwordFlag);
    deleteVault(vaultPath, password, { shred, passes, keyfiles });
    console.log(
      pc.green("✓") + (shred ? " Vault shredded." : " Vault deleted."),
    );
    if (shred) {
      console.log(
        pc.yellow("  Note:") +
          " shred is best-effort on SSDs/APFS/copy-on-write filesystems.",
      );
    }
  } catch (e: any) {
    console.error(pc.red("✗") + ` ${e.message}`);
    process.exit(1);
  }
}

// --- recover --------------------------------------------------------------
program
  .command("recover")
  .argument("<name>", "vault name or path")
  .description("Reset the password using the recovery key")
  .option(
    "--recovery-key <key>",
    "recovery key — DEPRECATED, leaks via `ps`; omit for a prompt",
  )
  .option(
    "--new-password <pwd>",
    "new password — DEPRECATED, leaks via `ps`; omit for a hidden prompt",
  )
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const recoveryKey = await getRecoveryKey(opts.recoveryKey);
      if (opts.newPassword) warnSecretFlag("--new-password");
      const newPassword =
        opts.newPassword || (await promptNewPassword("new password"));
      recoverVault(vaultPath, recoveryKey, newPassword);
      console.log(pc.green("✓") + " Password reset via recovery key.");
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- recovery-key ---------------------------------------------------------
program
  .command("recovery-key")
  .argument("<name>", "vault name or path")
  .description(
    "Generate a NEW recovery key, remove the existing one, or upgrade a legacy escrow to v2",
  )
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--keyfile <path...>", "keyfile(s) for this vault")
  .option("--remove", "remove the recovery key instead of regenerating it")
  .option(
    "--upgrade",
    "re-salt a legacy (v1) recovery escrow in place (requires the recovery key)",
  )
  .option(
    "--recovery-key <key>",
    "recovery key — DEPRECATED, leaks via `ps` (used with --upgrade; omit to be prompted)",
  )
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    try {
      const info = getInfo(vaultPath);
      if (opts.upgrade) {
        const recoveryKey = await getRecoveryKey(opts.recoveryKey);
        upgradeRecoveryEscrow(vaultPath, recoveryKey);
        console.log(
          pc.green("✓") +
            " Recovery escrow upgraded to v2 (the same recovery key still works).",
        );
        return;
      }
      const password = await getPassword(opts.password);
      if (opts.remove) {
        removeRecoveryKey(vaultPath, password, opts.keyfile);
        console.log(
          pc.green("✓") +
            " Recovery key removed. The password is now the only way in.",
        );
        return;
      }
      const newKey = regenerateRecoveryKey(vaultPath, password, opts.keyfile);
      if (info.hasRecoveryKey) {
        console.log(
          pc.yellow("⚠") + "  The previous recovery key is now INVALID.",
        );
      }
      console.log(
        "\n" +
          box([
            "NEW RECOVERY KEY — save this somewhere safe!",
            "",
            newKey,
            "",
            "This replaces any earlier recovery key.",
            "It cannot be recovered later.",
          ]),
      );
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- meta -----------------------------------------------------------------
program
  .command("meta")
  .argument("<name>", "vault name or path")
  .description("Get or set plaintext vault metadata (name / description)")
  .option("--password <pwd>", "password (omit for a hidden prompt)")
  .option("--name <text>", "set the vault name")
  .option("--description <text>", "set the vault description")
  .option("--keyfile <path...>", "keyfile(s) for this vault")
  .action(async (name, opts) => {
    const vaultPath = resolveVaultPath(name);
    try {
      // Read-only: no flags → just show current metadata.
      if (!opts.name && !opts.description) {
        const info = getInfo(vaultPath);
        if (!info.meta?.name && !info.meta?.description) {
          console.log("No metadata set for this vault.");
        } else {
          if (info.meta?.name) console.log(`Name:        ${info.meta.name}`);
          if (info.meta?.description)
            console.log(`Description: ${info.meta.description}`);
        }
        return;
      }
      const password = await getPassword(opts.password);
      // `meta` authenticates against an existing vault, so it must accept
      // keyfiles like every other such command: `effectivePassword` throws when
      // the header sets keyfileRequired and none is supplied, which without
      // this made a keyfile vault's metadata uneditable from the CLI.
      const res = setMeta(
        vaultPath,
        password,
        {
          name: opts.name,
          description: opts.description,
        },
        opts.keyfile,
      );
      console.log(pc.green("✓") + " Metadata updated.");
      // The write is allowed on a paranoid vault, but say plainly what was just
      // done: that vault was created to keep its header free of optional
      // plaintext, and a name and description are exactly that. Silently
      // succeeding here would defeat the mode the user chose.
      if (res.paranoid) {
        console.log(
          pc.yellow("⚠") +
            "  This vault was created with --paranoid. The name and" +
            " description are stored in PLAINTEXT in the vault header," +
            " readable by anyone who has the file.",
        );
      }
    } catch (e: any) {
      console.error(pc.red("✗") + ` ${e.message}`);
      process.exit(1);
    }
  });

// --- clean ----------------------------------------------------------------
program
  .command("clean")
  .description(
    "Remove stale sessions whose working dir or vault file no longer exists",
  )
  .action(() => {
    const sessions = loadSessions();
    let cleaned = 0;
    for (const s of sessions) {
      const wdGone = !fs.existsSync(s.workingDir);
      const vaultGone = !fs.existsSync(s.vaultPath);
      if (wdGone || vaultGone) {
        // Securely erase any orphaned working dir if it still exists.
        if (!wdGone) {
          try {
            secureEraseDir(s.workingDir);
          } catch {
            /* best-effort */
          }
        }
        removeSession(s.vaultPath);
        cleaned++;
      }
    }
    if (cleaned === 0) {
      console.log("No stale sessions found.");
    } else {
      console.log(pc.green("✓") + ` Cleaned ${cleaned} stale session(s).`);
    }
  });

program.parseAsync(process.argv);
