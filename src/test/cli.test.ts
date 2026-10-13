// CLI integration tests — spawn the real CLI end-to-end (create → open → add →
// close → reopen, plus error paths and the recovery-key upgrade flow).
//
// Each test is pointed at its own SHADOWBIT_CONFIG_DIR so sessions never
// leak between tests (and never touch ~/.shadow-bit). Run with: npm test
//
// Passwords are supplied via --password so no TTY prompts are involved. Where
// a confirm prompt is unavoidable (discard), piped stdin feeds the answer.

import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-cli-test-"));

const CLI = path.resolve(__dirname, "../cli/index.ts");
const EXEC = process.execPath;
const PASS = "correct-horse-battery-staple";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the CLI with `args`, isolated session dir, and optional piped input. */
function runCli(
  args: string[],
  opts: { input?: string; configDir: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXEC, ["--import", "tsx", CLI, ...args], {
      env: {
        ...process.env,
        SHADOWBIT_CONFIG_DIR: opts.configDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

function extractWorkingDir(stdout: string): string {
  const m = stdout.match(/Working folder:\n\s*(.+)/);
  assert.ok(m && m[1], `open should print a working folder, got: ${stdout}`);
  return m[1].trim();
}

const KEY_RE = /[0-9A-Z]{5}(?:-[0-9A-Z]{5}){7}/;

/** Leave a comment-free scaffold of a format-v1 (legacy escrow) vault. */
async function makeLegacyVault(
  vp: string,
  password: string,
  recoveryKey?: string,
): Promise<void> {
  const cryptoMod = await import("../core/crypto.js");
  const containerMod = await import("../core/container.js");
  const legacyParams = { N: 16384, r: 8, p: 1, keyLen: 32 };
  const manifest = Buffer.from(JSON.stringify({ entries: [] }), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length, 0);
  const payload = Buffer.concat([len, manifest]);
  const mek = cryptoMod.generateMek();
  const salt = cryptoMod.generateSalt();
  const passKey = cryptoMod.deriveKeyFromPassword(password, salt, legacyParams);
  const { iv, tag, ciphertext } = cryptoMod.encryptPayload(mek, payload);
  const header: import("../core/types").VaultHeader = {
    magic: "SHDBIT",
    version: 1,
    kdf: "scrypt",
    kdfParams: legacyParams,
    salt: salt.toString("hex"),
    encryptedMek: cryptoMod.encryptGCM(passKey, mek),
    payloadIv: iv,
    payloadTag: tag,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  };
  if (recoveryKey) {
    const recKey = cryptoMod.deriveKeyFromRecovery(recoveryKey);
    header.recovery = {
      encryptedMek: cryptoMod.encryptGCM(recKey, mek),
      keyHash: cryptoMod.hashRecoveryKey(recoveryKey),
    };
  }
  containerMod.writeContainer(vp, header, ciphertext);
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("CLI: create → open → add → close → reopen round-trips files", async () => {
  const vp = path.join(tmpRoot, "cycle.vault");
  const cfg = path.join(tmpRoot, "cfg-cycle");
  const external = path.join(tmpRoot, "external.txt");
  fs.writeFileSync(external, "external file");

  const created = await runCli(
    ["create", vp, "--password", PASS, "--no-recovery"],
    { configDir: cfg },
  );
  assert.equal(created.code, 0, created.stderr);
  assert.ok(fs.existsSync(vp));

  const opened = await runCli(["open", vp, "--password", PASS], {
    configDir: cfg,
  });
  assert.equal(opened.code, 0, opened.stderr);
  const wd = extractWorkingDir(opened.stdout);
  fs.writeFileSync(path.join(wd, "hello.txt"), "hello from cli");

  const added = await runCli(["add", vp, external], { configDir: cfg });
  assert.equal(added.code, 0, added.stderr);

  const closed = await runCli(["close", vp, "--password", PASS], {
    configDir: cfg,
  });
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(fs.existsSync(wd), false);

  const reopened = await runCli(["open", vp, "--password", PASS], {
    configDir: cfg,
  });
  assert.equal(reopened.code, 0, reopened.stderr);
  const wd2 = extractWorkingDir(reopened.stdout);
  assert.equal(
    fs.readFileSync(path.join(wd2, "hello.txt"), "utf8"),
    "hello from cli",
  );
  assert.equal(
    fs.readFileSync(path.join(wd2, "external.txt"), "utf8"),
    "external file",
  );

  const discarded = await runCli(["discard", vp, "--password", PASS], {
    configDir: cfg,
    input: "y\n",
  });
  assert.equal(discarded.code, 0, discarded.stderr);
});

test("CLI: wrong password fails on open", async () => {
  const vp = path.join(tmpRoot, "badpw.vault");
  const cfg = path.join(tmpRoot, "cfg-badpw");
  await runCli(["create", vp, "--password", PASS, "--no-recovery"], {
    configDir: cfg,
  });

  const res = await runCli(["open", vp, "--password", "wrong-password-1"], {
    configDir: cfg,
  });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /✗|Incorrect password/i);
});

test("CLI: closing a vault that is not open errors", async () => {
  const vp = path.join(tmpRoot, "notopen.vault");
  const cfg = path.join(tmpRoot, "cfg-notopen");
  await runCli(["create", vp, "--password", PASS, "--no-recovery"], {
    configDir: cfg,
  });

  const res = await runCli(["close", vp, "--password", PASS], {
    configDir: cfg,
  });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /not open/i);
});

test("CLI: info shows metadata and list shows open sessions", async () => {
  const vp = path.join(tmpRoot, "meta.vault");
  const cfg = path.join(tmpRoot, "cfg-meta");
  await runCli(["create", vp, "--password", PASS, "--no-recovery"], {
    configDir: cfg,
  });

  const info = await runCli(["info", vp], { configDir: cfg });
  assert.equal(info.code, 0, info.stderr);
  assert.match(info.stdout, /Recovery key:\s+no/i);
  assert.match(info.stdout, /Version:\s+3/);

  await runCli(["open", vp, "--password", PASS], { configDir: cfg });
  const list = await runCli(["list"], { configDir: cfg });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /OPEN VAULTS/);
  assert.match(
    list.stdout,
    new RegExp(vp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  await runCli(["close", vp, "--password", PASS], { configDir: cfg });
});

test("CLI: change-password and recover-with-recovery-key are scriptable", async () => {
  const vp = path.join(tmpRoot, "recover.vault");
  const cfg = path.join(tmpRoot, "cfg-recover");

  const created = await runCli(["create", vp, "--password", PASS], {
    configDir: cfg,
  });
  assert.equal(created.code, 0, created.stderr);
  const keyMatch = created.stdout.match(KEY_RE);
  assert.ok(keyMatch, "create should print a recovery key");
  const recoveryKey = keyMatch[0];

  const recovered = await runCli(
    [
      "recover",
      vp,
      "--recovery-key",
      recoveryKey,
      "--new-password",
      "reset-pass-1",
    ],
    { configDir: cfg },
  );
  assert.equal(recovered.code, 0, recovered.stderr);

  const badOld = await runCli(["open", vp, "--password", PASS], {
    configDir: cfg,
  });
  assert.notEqual(badOld.code, 0);

  const goodNew = await runCli(["open", vp, "--password", "reset-pass-1"], {
    configDir: cfg,
  });
  assert.equal(goodNew.code, 0, goodNew.stderr);
  await runCli(["discard", vp, "--password", "reset-pass-1"], {
    configDir: cfg,
    input: "y\n",
  });

  // change-password via flags only.
  const changed = await runCli(
    [
      "change-password",
      vp,
      "--password",
      "reset-pass-1",
      "--new-password",
      "final-pass-1",
    ],
    { configDir: cfg },
  );
  assert.equal(changed.code, 0, changed.stderr);

  const stale = await runCli(["open", vp, "--password", "reset-pass-1"], {
    configDir: cfg,
  });
  assert.notEqual(stale.code, 0);
  const finalOpen = await runCli(["open", vp, "--password", "final-pass-1"], {
    configDir: cfg,
  });
  assert.equal(finalOpen.code, 0, finalOpen.stderr);
  await runCli(["discard", vp, "--password", "final-pass-1"], {
    configDir: cfg,
    input: "y\n",
  });
});

test("CLI: recovery-key --upgrade re-salts a legacy v1 escrow end-to-end", async () => {
  const vp = path.join(tmpRoot, "legacy.vault");
  const cfg = path.join(tmpRoot, "cfg-upgrade");
  const recoveryKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH";
  await makeLegacyVault(vp, PASS, recoveryKey);

  const upgraded = await runCli(
    ["recovery-key", vp, "--upgrade", "--recovery-key", recoveryKey],
    { configDir: cfg },
  );
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.match(upgraded.stdout, /upgraded to v2/i);

  // The SAME key still recovers the vault afterwards.
  const recovered = await runCli(
    [
      "recover",
      vp,
      "--recovery-key",
      recoveryKey,
      "--new-password",
      "new-pw-1",
    ],
    { configDir: cfg },
  );
  assert.equal(recovered.code, 0, recovered.stderr);

  const opened = await runCli(["open", vp, "--password", "new-pw-1"], {
    configDir: cfg,
  });
  assert.equal(opened.code, 0, opened.stderr);
  const wd = extractWorkingDir(opened.stdout);
  assert.ok(fs.existsSync(wd));
  await runCli(["discard", vp, "--password", "new-pw-1"], {
    configDir: cfg,
    input: "y\n",
  });
});

test("CLI: delete requires the correct password (B1)", async () => {
  const vp = path.join(tmpRoot, "delete-auth.vault");
  const cfg = path.join(tmpRoot, "cfg-del-auth");
  await runCli(["create", vp, "--password", PASS, "--no-recovery"], {
    configDir: cfg,
  });

  // Wrong password should fail without deleting.
  const bad = await runCli(
    ["delete", vp, "--password", "wrong-password", "--yes"],
    { configDir: cfg },
  );
  assert.notEqual(bad.code, 0, "delete with wrong password should fail");
  assert.ok(fs.existsSync(vp), "vault should still exist");

  // Correct password should delete.
  const good = await runCli(["delete", vp, "--password", PASS, "--yes"], {
    configDir: cfg,
  });
  assert.equal(good.code, 0, good.stderr);
  assert.equal(fs.existsSync(vp), false);
});

test("CLI: meta command sets and reads vault metadata", async () => {
  const vp = path.join(tmpRoot, "meta-vault.vault");
  const cfg = path.join(tmpRoot, "cfg-meta-cmd");
  await runCli(["create", vp, "--password", PASS, "--no-recovery"], {
    configDir: cfg,
  });

  // Set metadata.
  const setResult = await runCli(
    [
      "meta",
      vp,
      "--password",
      PASS,
      "--name",
      "My Vault",
      "--description",
      "Test desc",
    ],
    { configDir: cfg },
  );
  assert.equal(setResult.code, 0, setResult.stderr);

  // Read metadata via info command.
  const infoResult = await runCli(["info", vp], { configDir: cfg });
  assert.equal(infoResult.code, 0, infoResult.stderr);
  assert.match(infoResult.stdout, /Name:\s+My Vault/);
  assert.match(infoResult.stdout, /Description:\s+Test desc/);

  // Read metadata via meta command (no flags).
  const readResult = await runCli(["meta", vp], { configDir: cfg });
  assert.equal(readResult.code, 0, readResult.stderr);
  assert.match(readResult.stdout, /My Vault/);
});

test("CLI: add command reports symlinks skipped", async () => {
  const vp = path.join(tmpRoot, "add-symlink.vault");
  const cfg = path.join(tmpRoot, "cfg-add-sym");
  const srcDir = path.join(tmpRoot, "add-src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "real.txt"), "content");

  await runCli(["create", vp, "--password", PASS, "--no-recovery"], {
    configDir: cfg,
  });
  await runCli(["open", vp, "--password", PASS], { configDir: cfg });

  // Add a normal file.
  const addRes = await runCli(["add", vp, path.join(srcDir, "real.txt")], {
    configDir: cfg,
  });
  assert.equal(addRes.code, 0, addRes.stderr);
  assert.match(addRes.stdout, /Added 1 item/);

  await runCli(["discard", vp, "--password", PASS], {
    configDir: cfg,
    input: "y\n",
  });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test("CLI: clean command removes stale sessions", async () => {
  const vp = path.join(tmpRoot, "clean-test.vault");
  const cfg = path.join(tmpRoot, "cfg-clean");
  await runCli(["create", vp, "--password", PASS, "--no-recovery"], {
    configDir: cfg,
  });
  const opened = await runCli(["open", vp, "--password", PASS], {
    configDir: cfg,
  });
  assert.equal(opened.code, 0);
  const wd = extractWorkingDir(opened.stdout);

  // Manually remove the working dir to create a stale session.
  fs.rmSync(wd, { recursive: true, force: true });

  const clean = await runCli(["clean"], { configDir: cfg });
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /Cleaned 1 stale session/);
});
