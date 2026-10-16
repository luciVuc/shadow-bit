// CLI end-to-end tests — spawn the real CLI as a subprocess and drive the
// complete command surface.
//
// This is the "does the product work" suite. src/test/cli.test.ts covers the
// happy-path lifecycle; this file covers the *option matrix* — keyfiles,
// cipher agility, paranoid mode, seeding, shredding, recovery-key lifecycle —
// plus the rejection paths a user will actually hit.
//
// Every test gets its own SHADOWBIT_CONFIG_DIR so sessions never leak between
// tests and ~/.shadow-bit is never touched.

import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { CURRENT_VERSION, readHeader } from "../src/core/container";
// CommonJS module shared with scripts/bump-version.js — see that file.
import { findStale } from "../scripts/version-literals";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-cli-e2e-"));
const CLI = path.resolve(__dirname, "../src/cli/index.ts");
const EXEC = process.execPath;
const PASS = "correct-horse-battery-staple";
const PASS2 = "another-perfectly-fine-password";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let seq = 0;
/** Isolated config dir + vault path per test. */
function fixture(name: string): { cfg: string; vault: string } {
  const dir = path.join(tmpRoot, `${seq++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return { cfg: path.join(dir, "cfg"), vault: path.join(dir, `${name}.svlt`) };
}

/**
 * Pull a recovery key out of `create` output. It is drawn inside a box, so it
 * is surrounded by box-drawing characters on its own line; the Crockford-ish
 * Base32 alphabet excludes I, L, O and U, which is what makes the pattern
 * unambiguous against the box borders and the surrounding prose.
 */
function matchRecoveryKey(stdout: string): string {
  const m = stdout.match(/[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){7}/);
  assert.ok(m, `no recovery key in create output:\n${stdout}`);
  return m![0];
}

function runCli(
  args: string[],
  cfg: string,
  input?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXEC, ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfg },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function extractWorkingDir(stdout: string): string {
  const m = stdout.match(/Working folder:\n\s*(.+)/);
  assert.ok(m && m[1], `expected a working folder, got: ${stdout}`);
  return m[1].trim();
}

const KEY_RE = /[0-9A-Z]{5}(?:-[0-9A-Z]{5}){7}/;

function extractRecoveryKey(stdout: string): string {
  const m = stdout.match(KEY_RE);
  assert.ok(m, `expected a recovery key in output, got: ${stdout}`);
  return m[0];
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Version consistency
// ---------------------------------------------------------------------------

test("CLI e2e: --version matches package.json, and the docs site agrees", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
  ) as { version: string };
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, "package.json needs a semver");

  const cli = await runCli(["--version"], path.join(tmpRoot, "version-cfg"));
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(
    cli.stdout.trim(),
    pkg.version,
    "CLI --version must be derived from package.json, not hardcoded",
  );

  // The docs site cannot import package.json (it must run over file://), so its
  // version is a literal. Rather than restate each rule here, ask the same
  // module `npm version` uses to write them — a second derivation in this file
  // could disagree with the script and pass while the docs are stale.
  const stale = findStale(pkg.version);
  assert.deepEqual(
    stale.map((s) => `${s.file}:${s.line} ${s.label} is "${s.current}"`),
    [],
    `version literals are out of sync with package.json ${pkg.version}; ` +
      `run \`node scripts/bump-version.js\``,
  );
});

// ---------------------------------------------------------------------------
// Option matrix
// ---------------------------------------------------------------------------

test("CLI e2e: keyfile vault cannot be opened without the keyfile", async () => {
  const { cfg, vault } = fixture("keyfile");
  const kf = path.join(path.dirname(vault), "secret.keyfile");
  fs.writeFileSync(kf, "high-entropy-keyfile-material\n");

  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery", "--keyfile", kf],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);
  assert.ok(fs.existsSync(vault), "vault file should exist");
  assert.equal(readHeader(vault).keyfileRequired, true);

  // Missing keyfile → refused with a clear message, and no session created.
  const noKey = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(noKey.code, 1, "opening without the keyfile must fail");
  assert.match(noKey.stderr, /requires a keyfile/i);

  const list = await runCli(["list"], cfg);
  assert.match(list.stdout, /No open vaults/);

  // Wrong keyfile → still refused (the keyfile is mixed into the password).
  const badKey = await runCli(
    ["open", vault, "--password", PASS, "--keyfile", path.join(cfg, "nope")],
    cfg,
  );
  assert.equal(badKey.code, 1, "a missing keyfile path must fail");

  // Correct keyfile → opens.
  const ok = await runCli(
    ["open", vault, "--password", PASS, "--keyfile", kf],
    cfg,
  );
  assert.equal(ok.code, 0, ok.stderr);
  const wd = extractWorkingDir(ok.stdout);
  assert.ok(fs.existsSync(wd), "working dir should exist after open");

  const closed = await runCli(
    ["close", vault, "--password", PASS, "--keyfile", kf],
    cfg,
  );
  assert.equal(closed.code, 0, closed.stderr);
});

test("CLI e2e: chacha20-poly1305 cipher round-trips and is recorded", async () => {
  const { cfg, vault } = fixture("chacha");
  const seedDir = path.join(path.dirname(vault), "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, "note.txt"), "chacha payload");

  const created = await runCli(
    [
      "create",
      vault,
      "--password",
      PASS,
      "--no-recovery",
      "--cipher",
      "chacha20-poly1305",
      "--seed",
      seedDir,
    ],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  const header = readHeader(vault);
  assert.equal(header.cipher, "chacha20-poly1305", "cipher should be recorded");

  const opened = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(opened.code, 0, opened.stderr);
  const wd = extractWorkingDir(opened.stdout);
  assert.equal(
    fs.readFileSync(path.join(wd, "note.txt"), "utf8"),
    "chacha payload",
    "chacha payload should decrypt intact",
  );

  // Tampering must still be caught by the AEAD tag.
  const closed = await runCli(["close", vault, "--password", PASS], cfg);
  assert.equal(closed.code, 0, closed.stderr);

  const raw = fs.readFileSync(vault);
  const before = raw.toString("hex");
  const idx = before.indexOf("chacha payload");
  assert.equal(idx, -1, "plaintext must not appear in the vault");
  // Flip a byte deep in the ciphertext region (past the header).
  raw[raw.length - 32] ^= 0x01;
  fs.writeFileSync(vault, raw);
  const tampered = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(tampered.code, 1, "tampered chacha payload must be rejected");
});

test("CLI e2e: unsupported cipher is rejected at create", async () => {
  const { cfg, vault } = fixture("badcipher");
  const res = await runCli(
    ["create", vault, "--password", PASS, "--cipher", "rot13"],
    cfg,
  );
  assert.equal(res.code, 1, "an unknown cipher must be rejected");
});

test("CLI e2e: --paranoid strips timestamps and metadata", async () => {
  const { cfg, vault } = fixture("paranoid");
  const res = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery", "--paranoid"],
    cfg,
  );
  assert.equal(res.code, 0, res.stderr);

  const header = readHeader(vault);
  assert.equal(
    header.createdAt,
    "1970-01-01T00:00:00.000Z",
    "createdAt scrubbed",
  );
  assert.equal(
    header.modifiedAt,
    "1970-01-01T00:00:00.000Z",
    "modifiedAt scrubbed",
  );
  assert.equal(header.meta, undefined, "metadata should be stripped");

  const info = await runCli(["info", vault], cfg);
  assert.equal(info.code, 0, info.stderr);
  assert.match(
    info.stdout,
    /1970-01-01/,
    "info should report the epoch timestamp",
  );
});

test("CLI e2e: --seed copies a directory into the vault", async () => {
  const { cfg, vault } = fixture("seed");
  const seedDir = path.join(path.dirname(vault), "seeddir");
  fs.mkdirSync(path.join(seedDir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "top.txt"), "top level");
  fs.writeFileSync(path.join(seedDir, "nested", "deep.txt"), "nested file");

  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery", "--seed", seedDir],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  const opened = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(opened.code, 0, opened.stderr);
  const wd = extractWorkingDir(opened.stdout);
  assert.equal(fs.readFileSync(path.join(wd, "top.txt"), "utf8"), "top level");
  assert.equal(
    fs.readFileSync(path.join(wd, "nested", "deep.txt"), "utf8"),
    "nested file",
    "nested structure should be preserved",
  );
});

test("CLI e2e: --seed with a missing directory errors", async () => {
  const { cfg, vault } = fixture("badseed");
  const res = await runCli(
    [
      "create",
      vault,
      "--password",
      PASS,
      "--no-recovery",
      "--seed",
      "/does/not/exist",
    ],
    cfg,
  );
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Seed directory not found/i);
  assert.ok(
    !fs.existsSync(vault),
    "a failed create must not leave a vault behind",
  );
});

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

test("CLI e2e: short password is rejected on create", async () => {
  const { cfg, vault } = fixture("shortpw");
  const res = await runCli(["create", vault, "--password", "short"], cfg);
  assert.equal(res.code, 1, "a 5-char password must be rejected");
  assert.match(res.stderr, /at least 8 characters/i);
});

test("CLI e2e: only length is enforced — the common-password blocklist is advisory", async () => {
  // Documents a real gap rather than an intended behaviour. The core has a
  // BLOCKLIST, but it is only consulted by estimateStrength(), which is itself
  // never called by the CLI. The GUI reimplements a different estimator in the
  // renderer and never calls the core one either, so the blocklist is
  // unreachable in the product as a whole.
  // See: "Password strength checking is advisory, and the blocklist never
  // reaches the user" in the findings report.
  const { cfg, vault } = fixture("weakpw");
  const res = await runCli(
    ["create", vault, "--password", "password", "--no-recovery"],
    cfg,
  );
  assert.equal(res.code, 0, "an 8-char common password is currently accepted");
  assert.ok(fs.existsSync(vault), "vault is created despite being blocklisted");

  // The blocklist itself does work when called directly.
  const { estimateStrength } = await import("../src/core/crypto");
  assert.equal(
    estimateStrength("password").score,
    0,
    "the core estimator does flag it",
  );
  assert.equal(
    estimateStrength("password").feedback,
    "This is a commonly used password.",
  );
});

// ---------------------------------------------------------------------------
// Recovery-key lifecycle
// ---------------------------------------------------------------------------

test("CLI e2e: recovery key is issued once, then regenerating invalidates the old one", async () => {
  const { cfg, vault } = fixture("recycle");
  const created = await runCli(["create", vault, "--password", PASS], cfg);
  assert.equal(created.code, 0, created.stderr);
  const firstKey = extractRecoveryKey(created.stdout);
  assert.equal(readHeader(vault).recovery !== undefined, true);

  // Regenerate with the password.
  const regen = await runCli(["recovery-key", vault, "--password", PASS], cfg);
  assert.equal(regen.code, 0, regen.stderr);
  const secondKey = extractRecoveryKey(regen.stdout);
  assert.notEqual(secondKey, firstKey, "regeneration must issue a new key");

  // Old key no longer recovers; new key does.
  const stale = await runCli(
    ["recover", vault, "--recovery-key", firstKey, "--new-password", PASS2],
    cfg,
  );
  assert.equal(stale.code, 1, "the superseded recovery key must fail");

  const good = await runCli(
    ["recover", vault, "--recovery-key", secondKey, "--new-password", PASS2],
    cfg,
  );
  assert.equal(good.code, 0, good.stderr);

  const opened = await runCli(["open", vault, "--password", PASS2], cfg);
  assert.equal(opened.code, 0, `new password should work: ${opened.stderr}`);
});

test("CLI e2e: recovery-key --remove revokes recovery entirely", async () => {
  const { cfg, vault } = fixture("recremove");
  const created = await runCli(["create", vault, "--password", PASS], cfg);
  const key = extractRecoveryKey(created.stdout);

  const removed = await runCli(
    ["recovery-key", vault, "--password", PASS, "--remove"],
    cfg,
  );
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(
    readHeader(vault).recovery,
    undefined,
    "recovery escrow removed",
  );
  assert.equal(
    readHeader(vault).hasRecoveryKey,
    undefined,
    "hasRecoveryKey is derived in getInfo, not stored on the header",
  );

  // The previously valid key must now be worthless.
  const res = await runCli(
    ["recover", vault, "--recovery-key", key, "--new-password", PASS2],
    cfg,
  );
  assert.equal(res.code, 1, "a revoked recovery key must not work");
});

test("CLI e2e: --no-recovery creates a vault with no escrow", async () => {
  const { cfg, vault } = fixture("norec");
  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery"],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);
  assert.equal(readHeader(vault).recovery, undefined);

  const info = await runCli(["info", vault], cfg);
  assert.match(info.stdout, /Recovery key:\s*no/);

  // Regenerating on a vault that has no escrow is allowed: it simply adds
  // one. That is the sensible reading of "generate a NEW recovery key".
  const regen = await runCli(["recovery-key", vault, "--password", PASS], cfg);
  assert.equal(regen.code, 0, regen.stderr);
  extractRecoveryKey(regen.stdout);
  assert.ok(readHeader(vault).recovery, "an escrow should now exist");

  // --remove then works; a second --remove has nothing to remove.
  assert.equal(
    (await runCli(["recovery-key", vault, "--password", PASS, "--remove"], cfg))
      .code,
    0,
  );
  const again = await runCli(
    ["recovery-key", vault, "--password", PASS, "--remove"],
    cfg,
  );
  assert.equal(again.code, 1, "--remove with no escrow should fail cleanly");
});

test("CLI e2e: recover restores access after the password is lost", async () => {
  const { cfg, vault } = fixture("recoverlost");
  const created = await runCli(["create", vault, "--password", PASS], cfg);
  const key = extractRecoveryKey(created.stdout);

  const res = await runCli(
    ["recover", vault, "--recovery-key", key, "--new-password", PASS2],
    cfg,
  );
  assert.equal(res.code, 0, res.stderr);

  const oldPw = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(oldPw.code, 1, "the old password must stop working");

  const newPw = await runCli(["open", vault, "--password", PASS2], cfg);
  assert.equal(newPw.code, 0, newPw.stderr);
  extractWorkingDir(newPw.stdout);
});

test("CLI e2e: recover rejects a weak new password", async () => {
  const { cfg, vault } = fixture("recoverweak");
  const created = await runCli(["create", vault, "--password", PASS], cfg);
  const key = extractRecoveryKey(created.stdout);

  const res = await runCli(
    ["recover", vault, "--recovery-key", key, "--new-password", "abc"],
    cfg,
  );
  assert.equal(res.code, 1, "recovery must enforce the password policy");
  // The old password must still work — a rejected recovery changes nothing.
  const opened = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(opened.code, 0, "a rejected recovery must not alter the vault");
});

// ---------------------------------------------------------------------------
// Destruction paths
// ---------------------------------------------------------------------------

test("CLI e2e: shred destroys the file and needs the password", async () => {
  const { cfg, vault } = fixture("shred");
  await runCli(["create", vault, "--password", PASS, "--no-recovery"], cfg);
  assert.ok(fs.existsSync(vault));

  const wrongPw = await runCli(
    ["shred", vault, "--password", "wrong-password-x", "-y"],
    cfg,
  );
  assert.equal(wrongPw.code, 1, "shred must require the correct password");
  assert.ok(fs.existsSync(vault), "a failed shred must leave the file intact");

  const res = await runCli(["shred", vault, "--password", PASS, "-y"], cfg);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!fs.existsSync(vault), "shred must remove the file");
});

test("CLI e2e: delete --shred -y removes the file without prompting", async () => {
  const { cfg, vault } = fixture("delshred");
  await runCli(["create", vault, "--password", PASS, "--no-recovery"], cfg);

  const res = await runCli(
    ["delete", vault, "--password", PASS, "--shred", "--passes", "1", "-y"],
    cfg,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!fs.existsSync(vault), "delete --shred must remove the file");
});

test("CLI e2e: an invalid --passes is refused rather than silently substituted", async () => {
  // `parseInt(x, 10) || 3` used to accept --passes 0 (falsy) and --passes abc
  // (NaN) as a silent 3, and truncated 2.5 to 2. The pass count is the only
  // difference between overwriting the bytes before unlinking and not doing it,
  // so a typo must be an error — and must not destroy anything on the way.
  for (const bad of ["0", "-1", "abc", "2.5", ""]) {
    const { cfg, vault } = fixture(`passes-${bad || "empty"}`);
    const created = await runCli(
      ["create", vault, "--password", PASS, "--no-recovery"],
      cfg,
    );
    assert.equal(created.code, 0, created.stderr);

    const res = await runCli(
      ["shred", vault, "--password", PASS, "--passes", bad, "-y"],
      cfg,
    );
    assert.equal(res.code, 1, `--passes "${bad}" must be refused`);
    assert.match(res.stderr, /positive whole number/i);
    assert.equal(
      fs.existsSync(vault),
      true,
      `--passes "${bad}" must leave the vault in place`,
    );
  }
});

test("CLI e2e: delete without -y prompts, and 'n' aborts", async () => {
  const { cfg, vault } = fixture("delprompt");
  await runCli(["create", vault, "--password", PASS, "--no-recovery"], cfg);

  const aborted = await runCli(
    ["delete", vault, "--password", PASS],
    cfg,
    "n\n",
  );
  assert.equal(aborted.code, 0, aborted.stderr);
  assert.ok(fs.existsSync(vault), "answering 'n' must not delete the vault");

  const confirmed = await runCli(
    ["delete", vault, "--password", PASS],
    cfg,
    "y\n",
  );
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.ok(!fs.existsSync(vault), "answering 'y' must delete the vault");
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test("CLI e2e: opening a non-existent vault errors", async () => {
  const { cfg, vault } = fixture("missing");
  const res = await runCli(
    ["open", path.join(cfg, "nope.svlt"), "--password", PASS],
    cfg,
  );
  assert.equal(res.code, 1);
  assert.ok(res.stderr.length > 0, "should print an error to stderr");
});

test("CLI e2e: a corrupt file is reported as corrupt, not as a wrong password", async () => {
  const { cfg, vault } = fixture("corrupt");
  fs.writeFileSync(vault, Buffer.from("this is definitely not a vault file"));
  const res = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(res.code, 1);
  assert.ok(res.stderr.length > 0);
});

test("CLI e2e: info on a vault with metadata reports name and description", async () => {
  const { cfg, vault } = fixture("meta");
  await runCli(
    [
      "create",
      vault,
      "--password",
      PASS,
      "--no-recovery",
      "--name",
      "Tax Records 2026",
      "--description",
      "Archived returns",
    ],
    cfg,
  );
  const info = await runCli(["info", vault], cfg);
  assert.equal(info.code, 0, info.stderr);
  assert.match(info.stdout, /Name:\s+Tax Records 2026/);
  assert.match(info.stdout, /Description:\s+Archived returns/);
  // CURRENT_VERSION, not a literal: `vault info` prints the container format
  // version, and hardcoding "3" is how this assertion kept passing for several
  // releases after the format moved on.
  assert.match(
    info.stdout,
    new RegExp(`Version:\\s+${CURRENT_VERSION}`),
    `v${CURRENT_VERSION} container expected`,
  );
});

test("CLI e2e: add reports success and close persists the added file", async () => {
  const { cfg, vault } = fixture("addclose");
  await runCli(["create", vault, "--password", PASS, "--no-recovery"], cfg);

  const src = path.join(path.dirname(vault), "src.txt");
  fs.writeFileSync(src, "added via CLI");

  const opened = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(opened.code, 0, opened.stderr);

  const added = await runCli(["add", vault, src], cfg);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /Added \d+ item/);

  const closed = await runCli(["close", vault, "--password", PASS], cfg);
  assert.equal(closed.code, 0, closed.stderr);

  const reopened = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(reopened.code, 0, reopened.stderr);
  const wd = extractWorkingDir(reopened.stdout);
  assert.equal(
    fs.readFileSync(path.join(wd, "src.txt"), "utf8"),
    "added via CLI",
    "the added file should survive close/reopen",
  );
});

test("CLI e2e: --password emits a deprecation warning on stderr", async () => {
  const { cfg, vault } = fixture("deprwarn");
  const res = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery"],
    cfg,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /--password is deprecated/i);
  // The warning must not contaminate machine-readable stdout.
  assert.ok(
    !/deprecated/i.test(res.stdout),
    "the warning belongs on stderr, not stdout",
  );
});

test("CLI e2e: SHADOWBIT_PASSWORD avoids the deprecation warning", async () => {
  const { cfg, vault } = fixture("envpw");
  const child = spawn(
    EXEC,
    ["--import", "tsx", CLI, "create", vault, "--no-recovery"],
    {
      env: {
        ...process.env,
        SHADOWBIT_CONFIG_DIR: cfg,
        SHADOWBIT_PASSWORD: PASS,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const code: number = await new Promise((res) =>
    child.on("close", (c) => res(c ?? -1)),
  );
  child.stdin.end();
  assert.equal(code, 0, stderr);
  assert.ok(
    !/--password is deprecated/i.test(stderr),
    "the env-var path should not warn",
  );
  assert.ok(
    fs.existsSync(vault),
    "vault should be created from the env password",
  );
});

// ---------------------------------------------------------------------------
// Keyfile lifecycle across the authenticated command surface.
//
// Regression guard for a data-lifecycle dead end: `delete`, `shred`,
// `change-password`, and `recovery-key` originally had no --keyfile flag, so
// `effectivePassword()` threw "requires a keyfile" and a keyfile vault could
// not be deleted, shredded, re-passworded, or have its recovery key rotated.
// Every command that authenticates against an existing vault must accept it.
//
// `meta` kept the same gap much longer — the flag was registered on every such
// command *except* that one — which is why it is asserted separately below
// rather than folded into this test.
// ---------------------------------------------------------------------------

test("CLI e2e: a keyfile vault can be rotated, re-passworded and deleted", async () => {
  const { cfg, vault } = fixture("keyfile-lifecycle");
  const kf = path.join(path.dirname(vault), "life.keyfile");
  fs.writeFileSync(kf, "high-entropy-keyfile-material\n");

  const created = await runCli(
    ["create", vault, "--password", PASS, "--keyfile", kf],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  // The recovery key must be rotated with the keyfile present.
  const regen = await runCli(
    ["recovery-key", vault, "--password", PASS, "--keyfile", kf],
    cfg,
  );
  assert.equal(regen.code, 0, regen.stderr);
  assert.match(regen.stdout, /NEW RECOVERY KEY/);

  // Changing the password must not drop the keyfile requirement (and must not
  // brick the vault by re-wrapping under a bare password).
  const cp = await runCli(
    [
      "change-password",
      vault,
      "--password",
      PASS,
      "--new-password",
      PASS2,
      "--keyfile",
      kf,
    ],
    cfg,
  );
  assert.equal(cp.code, 0, cp.stderr);
  assert.equal(readHeader(vault).keyfileRequired, true);

  // Still openable with the keyfile after the rotation.
  const opened = await runCli(
    ["open", vault, "--password", PASS2, "--keyfile", kf],
    cfg,
  );
  assert.equal(opened.code, 0, opened.stderr);
  const closed = await runCli(
    ["close", vault, "--password", PASS2, "--keyfile", kf],
    cfg,
  );
  assert.equal(closed.code, 0, closed.stderr);

  // And finally it can be deleted — the operation that used to be impossible.
  const del = await runCli(
    ["delete", vault, "--password", PASS2, "--keyfile", kf, "--yes"],
    cfg,
  );
  assert.equal(del.code, 0, del.stderr);
  assert.equal(fs.existsSync(vault), false);
});

test("CLI e2e: meta accepts --keyfile, so keyfile vaults are not uneditable", async () => {
  // `meta` authenticates against an existing vault, so it needs --keyfile like
  // every other such command. Without the flag registered, commander rejected
  // it as an unknown option and a keyfile vault's name/description could not be
  // read or written from the CLI at all — while the core, the worker and the
  // GUI all threaded keyfiles through correctly.
  const { cfg, vault } = fixture("keyfile-meta");
  const kf = path.join(path.dirname(vault), "meta.keyfile");
  fs.writeFileSync(kf, "high-entropy-keyfile-material\n");

  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery", "--keyfile", kf],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  const withoutKeyfile = await runCli(
    ["meta", vault, "--password", PASS, "--name", "Nope"],
    cfg,
  );
  assert.equal(
    withoutKeyfile.code,
    1,
    "meta without the keyfile must still fail closed",
  );
  assert.match(withoutKeyfile.stderr, /requires a keyfile/i);

  const withKeyfile = await runCli(
    ["meta", vault, "--password", PASS, "--keyfile", kf, "--name", "Tax 2026"],
    cfg,
  );
  assert.equal(withKeyfile.code, 0, withKeyfile.stderr);
  assert.equal(readHeader(vault).meta?.name, "Tax 2026");

  // And the read-only form works too (it needs no credentials).
  const shown = await runCli(["meta", vault, "--keyfile", kf], cfg);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Tax 2026/);
});

test("CLI e2e: deleting a keyfile vault without the keyfile fails safely", async () => {
  const { cfg, vault } = fixture("keyfile-nodel");
  const kf = path.join(path.dirname(vault), "keep.keyfile");
  fs.writeFileSync(kf, "high-entropy-keyfile-material\n");

  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery", "--keyfile", kf],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  const del = await runCli(["delete", vault, "--password", PASS, "--yes"], cfg);
  assert.equal(del.code, 1, "delete without the keyfile must be refused");
  assert.match(del.stderr, /requires a keyfile/i);
  assert.equal(
    fs.existsSync(vault),
    true,
    "vault must survive a refused delete",
  );
});

test("CLI e2e: create --paranoid --name does not leak the plaintext name", async () => {
  const { cfg, vault } = fixture("paranoid-name");

  const created = await runCli(
    [
      "create",
      vault,
      "--password",
      PASS,
      "--no-recovery",
      "--paranoid",
      "--name",
      "PLAINTEXT-NAME",
      "--description",
      "PLAINTEXT-DESC",
    ],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);
  // The user is told their metadata was dropped rather than silently ignored.
  assert.match(created.stdout, /--paranoid strips all metadata/);

  const raw = fs.readFileSync(vault);
  assert.ok(
    !raw.includes(Buffer.from("PLAINTEXT-NAME")),
    "the vault bytes must not contain the requested plaintext name",
  );
  assert.ok(
    !raw.includes(Buffer.from("PLAINTEXT-DESC")),
    "the vault bytes must not contain the requested plaintext description",
  );
  const h = readHeader(vault);
  assert.equal(h.meta, undefined);
  assert.equal(h.createdAt, "1970-01-01T00:00:00.000Z");
});

test("CLI e2e: meta on a paranoid vault writes it but warns it is plaintext", async () => {
  // The write is allowed — metadata is legitimate content and a user who chose
  // --paranoid years ago is entitled to add a description. What is not allowed is
  // silence: the whole point of paranoid mode is a header carrying nothing
  // optional in plaintext, so the CLI has to say so out loud.
  const { cfg, vault } = fixture("paranoid-setmeta");

  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery", "--paranoid"],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);
  assert.equal(readHeader(vault).meta, undefined);

  const meta = await runCli(
    ["meta", vault, "--password", PASS, "--name", "Tax 2026"],
    cfg,
  );
  assert.equal(meta.code, 0, meta.stderr);
  assert.match(meta.stdout, /Metadata updated/);
  // The warning is the whole point of this test — a silent success would defeat
  // the mode the user chose.
  assert.match(
    meta.stdout,
    /paranoid/i,
    "a paranoid-vault metadata write must warn",
  );
  assert.match(
    meta.stdout,
    /plaintext|in the clear/i,
    "the warning must say the metadata is readable in the file",
  );

  // The metadata really was written, and the vault is still usable.
  assert.equal(readHeader(vault).meta?.name, "Tax 2026");
  const reopened = await runCli(["open", vault, "--password", PASS], cfg);
  assert.equal(reopened.code, 0, reopened.stderr);
});

test("CLI e2e: meta on an ordinary vault does not warn", async () => {
  // The mirror of the paranoid case: a warning that fires unconditionally is as
  // useless as no warning at all, because the user learns to ignore it.
  const { cfg, vault } = fixture("meta-nowarn");
  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery"],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  const meta = await runCli(
    ["meta", vault, "--password", PASS, "--name", "Tax 2026"],
    cfg,
  );
  assert.equal(meta.code, 0, meta.stderr);
  assert.match(meta.stdout, /Metadata updated/);
  assert.doesNotMatch(meta.stdout, /paranoid/i);
});

test("CLI e2e: info reports the cipher and whether a keyfile is required", async () => {
  const { cfg, vault } = fixture("info-facts");
  const kf = path.join(path.dirname(vault), "info.keyfile");
  fs.writeFileSync(kf, "high-entropy-keyfile-material\n");

  const created = await runCli(
    [
      "create",
      vault,
      "--password",
      PASS,
      "--no-recovery",
      "--cipher",
      "chacha20-poly1305",
      "--keyfile",
      kf,
    ],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  const info = await runCli(["info", vault], cfg);
  assert.equal(info.code, 0, info.stderr);
  assert.match(info.stdout, /Cipher:\s+chacha20-poly1305/);
  assert.match(info.stdout, /Keyfile:\s+required/);
});

test("CLI e2e: an unknown --cipher is rejected with a readable message", async () => {
  const { cfg, vault } = fixture("bad-cipher");

  const res = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery", "--cipher", "rot13"],
    cfg,
  );
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Unsupported cipher: rot13/);
  assert.match(res.stderr, /aes-256-gcm, chacha20-poly1305/);
  assert.equal(fs.existsSync(vault), false, "no vault should be written");
});

// ---------------------------------------------------------------------------
// Every secret-bearing flag must warn.
//
// --password warned about `ps` and shell history, but --new-password and
// --recovery-key did not — so the tool's own privacy guidance ("don't put your
// password on the command line") was contradicted by three of the four flags
// that do exactly that. A recovery key is the highest-value secret in the
// product: it bypasses the password entirely.
// ---------------------------------------------------------------------------

test("CLI e2e: --new-password emits a deprecation warning on stderr", async () => {
  const { cfg, vault } = fixture("deprwarn-newpw");
  const created = await runCli(
    ["create", vault, "--password", PASS, "--no-recovery"],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);

  const res = await runCli(
    [
      "change-password",
      vault,
      "--password",
      PASS,
      "--new-password",
      "a-brand-new-password",
    ],
    cfg,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(
    res.stderr,
    /--new-password is deprecated/i,
    `--new-password must warn like --password does (stderr: ${res.stderr})`,
  );
  assert.ok(
    !/deprecated/i.test(res.stdout),
    "the warning belongs on stderr, not stdout",
  );
});

test("CLI e2e: --recovery-key emits a deprecation warning on stderr", async () => {
  const { cfg, vault } = fixture("deprwarn-reckey");
  // Recovery generation is ON (the default): the key printed here is what the
  // recover command below is checked against. "saved" answers the ack prompt.
  const created = await runCli(
    ["create", vault, "--password", PASS],
    cfg,
    "saved\n",
  );
  assert.equal(created.code, 0, created.stderr);
  const recoveryKey = matchRecoveryKey(created.stdout);

  const res = await runCli(
    [
      "recover",
      vault,
      "--recovery-key",
      recoveryKey,
      "--new-password",
      "yet-another-password",
    ],
    cfg,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(
    res.stderr,
    /--recovery-key is deprecated/i,
    `--recovery-key must warn (stderr: ${res.stderr})`,
  );
  assert.match(res.stderr, /--new-password is deprecated/i);
});

test("CLI e2e: recovery-key --upgrade warns when --recovery-key is passed", async () => {
  const { cfg, vault } = fixture("deprwarn-upgrade");
  const created = await runCli(
    ["create", vault, "--no-recovery", "--password", PASS],
    cfg,
  );
  assert.equal(created.code, 0, created.stderr);
  // A vault with no escrow at all: the warning must still fire before the
  // operation is attempted, and the command must still fail cleanly.
  const res = await runCli(
    ["recovery-key", vault, "--upgrade", "--recovery-key", "AAAAA-BBBBB"],
    cfg,
  );
  assert.match(
    res.stderr,
    /--recovery-key is deprecated/i,
    "the --upgrade path must warn too",
  );
  assert.equal(res.code, 1, "no escrow to upgrade, so it should fail");
});

test("CLI e2e: the recovery key is read from a visible prompt, not a flag", async () => {
  // A 44-character Base32 recovery key in fixed groups is transcribed by many
  // users; masking it makes a single mistyped character invisible and the
  // failure only surfaces when the key is already needed. It is still read from
  // the prompt rather than argv, so it never reaches shell history.
  const { cfg, vault } = fixture("recover-prompt");
  const created = await runCli(
    ["create", vault, "--password", PASS],
    cfg,
    "saved\n",
  );
  assert.equal(created.code, 0, created.stderr);
  const recoveryKey = matchRecoveryKey(created.stdout);

  // Non-TTY stdin, so prompts read plain lines. The recovery key must be taken
  // from the FIRST line and the new password (twice) after it.
  const res = await runCli(
    ["recover", vault],
    cfg,
    `${recoveryKey}\nrecovered-password-1\nrecovered-password-1\n`,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Password reset via recovery key/i);

  // The recovered password must actually work.
  const open = await runCli(
    ["open", vault, "--password", "recovered-password-1"],
    cfg,
  );
  assert.equal(open.code, 0, open.stderr);
});
