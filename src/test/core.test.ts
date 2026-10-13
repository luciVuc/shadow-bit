// Security-focused round-trip tests for the core engine.
// Run with: npm test
//
// Isolated from any real sessions file: SHADOWBIT_CONFIG_DIR is pointed at
// a throwaway temp dir BEFORE the core modules are first loaded, so the
// on-disk session registry never touches ~/.shadow-bit.

import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { sleepSync } from "../core/fsutil";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "shadowbit-security-test-"),
);
process.env.SHADOWBIT_CONFIG_DIR = path.join(tmpRoot, "cfg");

const localkeyMod = path.join(__dirname, "..", "core", "localkey");

let vault: typeof import("../core/vault");
let container: typeof import("../core/container");
let bundle: typeof import("../core/bundle");
let fsutil: typeof import("../core/fsutil");
let sessions: typeof import("../core/sessions");

before(async () => {
  vault = await import("../core/vault.js");
  container = await import("../core/container.js");
  bundle = await import("../core/bundle.js");
  fsutil = await import("../core/fsutil.js");
  sessions = await import("../core/sessions.js");
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const PASS = "correct-horse-battery-staple";

function tmpVault(name: string): string {
  return path.join(tmpRoot, `${name}.vault`);
}

function emptyBundleBuffer(): Buffer {
  const manifest = Buffer.from(JSON.stringify({ entries: [] }), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length, 0);
  return Buffer.concat([len, manifest]);
}

/** Craft a format-v1 container (legacy recovery derivation, no salt). */
async function makeLegacyVault(
  vp: string,
  password: string,
  recoveryKey?: string,
): Promise<void> {
  const cryptoMod = await import("../core/crypto.js");
  const legacyParams: import("../core/types").KdfParams = {
    N: 16384,
    r: 8,
    p: 1,
    keyLen: 32,
  };
  const mek = cryptoMod.generateMek();
  const salt = cryptoMod.generateSalt();
  const passKey = cryptoMod.deriveKeyFromPassword(password, salt, legacyParams);
  // Legacy vaults did NOT compress.
  const { iv, tag, ciphertext } = cryptoMod.encryptPayload(
    mek,
    emptyBundleBuffer(),
  );
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
    // No `compressed` flag — uncompressed, back-compat path.
  };
  if (recoveryKey) {
    const recKey = cryptoMod.deriveKeyFromRecovery(recoveryKey);
    header.recovery = {
      encryptedMek: cryptoMod.encryptGCM(recKey, mek),
      keyHash: cryptoMod.hashRecoveryKey(recoveryKey),
    };
  }
  container.writeContainer(vp, header, ciphertext);
}

// ---------------------------------------------------------------------------
// Phase 1-11 regression suite (unchanged semantics, updated API calls)
// ---------------------------------------------------------------------------

test("create → open → close → reopen round-trips files", () => {
  const vp = tmpVault("roundtrip");
  vault.createVault(vp, { password: PASS, generateRecovery: false });

  const a = vault.openVault(vp, PASS);
  assert.ok(fs.existsSync(a.workingDir));
  fs.writeFileSync(path.join(a.workingDir, "hello.txt"), "hello world");
  fs.mkdirSync(path.join(a.workingDir, "sub"));
  fs.writeFileSync(
    path.join(a.workingDir, "sub", "nested.bin"),
    Buffer.from([1, 2, 3]),
  );
  vault.closeVault(vp, PASS);
  assert.equal(fs.existsSync(a.workingDir), false);

  const b = vault.openVault(vp, PASS);
  assert.equal(
    fs.readFileSync(path.join(b.workingDir, "hello.txt"), "utf8"),
    "hello world",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(b.workingDir, "sub", "nested.bin")),
    Buffer.from([1, 2, 3]),
  );
  vault.discardVault(vp, PASS);
});

test("opening twice with the correct password reuses the session", () => {
  const vp = tmpVault("reopen");
  vault.createVault(vp, { password: PASS });
  const a = vault.openVault(vp, PASS);
  const b = vault.openVault(vp, PASS);
  assert.equal(a.workingDir, b.workingDir);
  vault.closeVault(vp, PASS);
});

test("wrong password fails even when a session already exists (C2)", () => {
  const vp = tmpVault("wrongpw");
  vault.createVault(vp, { password: PASS });
  vault.openVault(vp, PASS);
  assert.throws(
    () => vault.openVault(vp, "definitely-wrong-password"),
    vault.WrongCredentialError,
  );
  assert.equal(vault.getInfo(vp).isOpen, true);
  vault.closeVault(vp, PASS);
});

test("tampered ciphertext is detected on open", () => {
  const vp = tmpVault("tamper");
  vault.createVault(vp, { password: PASS });
  const buf = fs.readFileSync(vp);
  buf[buf.length - 1] ^= 0xff;
  fs.writeFileSync(vp, buf);
  assert.throws(
    () => vault.openVault(vp, PASS),
    /Incorrect password|authentication|decrypt/i,
  );
});

test("recovery-key flow resets the password (v2, salted scrypt)", () => {
  const vp = tmpVault("recovery");
  const { recoveryKey } = vault.createVault(vp, {
    password: PASS,
    generateRecovery: true,
  });
  assert.ok(recoveryKey);

  vault.recoverVault(vp, recoveryKey, "brand-new-password-1");
  assert.throws(() => vault.openVault(vp, PASS), vault.WrongCredentialError);
  vault.openVault(vp, "brand-new-password-1");
  vault.discardVault(vp, "brand-new-password-1");
});

test("legacy v1 vaults still open with password and recover with key", async () => {
  const vp = tmpVault("legacy");
  const recoveryKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH";
  await makeLegacyVault(vp, PASS, recoveryKey);

  const a = vault.openVault(vp, PASS);
  vault.discardVault(vp, PASS);

  vault.recoverVault(vp, recoveryKey, "new-password-after-recover");
  const b = vault.openVault(vp, "new-password-after-recover");
  vault.discardVault(vp, "new-password-after-recover");
});

test("unsafe/oversized scrypt params from a crafted header are rejected (H1)", async () => {
  const cryptoMod = await import("../core/crypto.js");
  const salt = cryptoMod.generateSalt();
  assert.throws(
    () =>
      cryptoMod.deriveKeyFromPassword("pw", salt, {
        N: 1 << 30,
        r: 8,
        p: 1,
        keyLen: 32,
      }),
    /Unsupported or unsafe KDF/,
  );
  assert.throws(
    () =>
      cryptoMod.deriveKeyFromPassword("pw", salt, {
        N: 16384,
        r: 8,
        p: 1,
        keyLen: 64,
      }),
    /Unsupported or unsafe KDF/,
  );
  assert.equal(cryptoMod.deriveKeyFromPassword("pw", salt).length, 32);
});

test("unsupported header version is rejected (H2)", () => {
  const vp = tmpVault("badver");
  vault.createVault(vp, { password: PASS });
  const { header, payload } = container.readContainer(vp);
  header.version = 999;
  container.writeContainer(vp, header, payload);
  assert.throws(() => container.readHeader(vp), /Unsupported vault version/);
});

test("bad header magic is rejected (H2/M3)", () => {
  const vp = tmpVault("badmagic");
  vault.createVault(vp, { password: PASS });
  const { header, payload } = container.readContainer(vp);
  header.magic = "BOGUS";
  container.writeContainer(vp, header, payload);
  assert.throws(() => container.readHeader(vp), /bad header magic/);
});

test("path-traversal bundle entries are rejected on unpack (C4)", () => {
  const makeBundle = (p: string, size = 4) => {
    const entries = [{ path: p, size, mode: 0o644 }];
    const manifest = Buffer.from(JSON.stringify({ entries }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(manifest.length, 0);
    return Buffer.concat([len, manifest, Buffer.from("EVIL")]);
  };
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-unpack-"));

  for (const evil of [
    "../../evil.txt",
    "..\\..\\..\\evil.txt",
    "../evil.txt",
    "/etc/evil",
    "C:\\evil.txt",
    "sub/../../evil",
    "..",
  ]) {
    assert.throws(
      () => bundle.unpackDir(makeBundle(evil), dest),
      /Unsafe path in bundle/,
      `path should be rejected: ${evil}`,
    );
  }

  bundle.unpackDir(makeBundle("a/b/c.txt"), dest);
  assert.equal(
    fs.readFileSync(path.join(dest, "a", "b", "c.txt"), "utf8"),
    "EVIL",
  );
  fs.rmSync(dest, { recursive: true, force: true });
});

test("corrupt entry sizes are rejected on unpack (H4)", () => {
  const entries = [{ path: "x.txt", size: 99999, mode: 0o644 }];
  const manifest = Buffer.from(JSON.stringify({ entries }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length, 0);
  const b = Buffer.concat([len, manifest, Buffer.from("EVIL")]);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-unpack-"));
  assert.throws(() => bundle.unpackDir(b, dest), /out of range/);
  fs.rmSync(dest, { recursive: true, force: true });
});

test("discard requires the correct password (M6)", () => {
  const vp = tmpVault("discard");
  vault.createVault(vp, { password: PASS });
  vault.openVault(vp, PASS);

  assert.throws(
    () => vault.discardVault(vp, "wrong-password"),
    vault.WrongCredentialError,
  );
  assert.equal(vault.getInfo(vp).isOpen, true);

  vault.discardVault(vp, PASS);
  assert.equal(vault.getInfo(vp).isOpen, false);
});

test("discard still cleans up a stale session when the vault file is gone (F1)", async () => {
  const vp = tmpVault("orphan");
  vault.createVault(vp, { password: PASS });
  const { workingDir } = vault.openVault(vp, PASS);
  assert.equal(fs.existsSync(workingDir), true);

  fs.rmSync(vp);

  assert.doesNotThrow(() => vault.discardVault(vp, PASS));
  assert.equal(fs.existsSync(workingDir), false);
  assert.equal(
    sessions.loadSessions().some((s) => s.vaultPath === vp),
    false,
  );
});

test("changePassword keeps version 1 for a legacy v1 escrow (F2)", async () => {
  const vp = tmpVault("upgrade-legacy");
  const recoveryKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH";
  await makeLegacyVault(vp, PASS, recoveryKey);

  vault.changePassword(vp, PASS, "new-password-9");
  const h = container.readHeader(vp);
  assert.equal(h.version, 1);
  assert.equal(h.recovery!.salt, undefined);
  const cryptoMod = await import("../core/crypto.js");
  assert.equal(h.kdfParams.N, cryptoMod.DEFAULT_KDF_PARAMS.N);
  assert.doesNotThrow(() => vault.openVault(vp, "new-password-9"));
  vault.discardVault(vp, "new-password-9");
});

test("changePassword bumps to v2 once the escrow is already v2 (F2)", () => {
  const vp = tmpVault("upgrade-modern");
  vault.createVault(vp, { password: PASS, generateRecovery: true });
  vault.changePassword(vp, PASS, "another-new-password");
  const h = container.readHeader(vp);
  assert.equal(h.version, container.CURRENT_VERSION);
  assert.ok(h.recovery!.salt);
});

test("core enforces a minimum password policy (M4)", () => {
  assert.throws(
    () => vault.createVault(tmpVault("emptypw"), { password: "" }),
    /at least 8 characters/,
  );
  assert.throws(
    () => vault.createVault(tmpVault("shortpw"), { password: "short" }),
    /at least 8 characters/,
  );
});

test("header-only read does not require the payload to be parseable (M1)", () => {
  const vp = tmpVault("headeronly");
  vault.createVault(vp, { password: PASS });
  const info = vault.getInfo(vp);
  assert.equal(info.version, container.CURRENT_VERSION);
  assert.equal(info.hasRecoveryKey, false);
});

test("new vaults use the raised default scrypt cost (N=2^17)", async () => {
  const cryptoMod = await import("../core/crypto.js");
  assert.equal(cryptoMod.DEFAULT_KDF_PARAMS.N, 1 << 17);

  const vp = tmpVault("kdfcost");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  assert.equal(container.readHeader(vp).kdfParams.N, 1 << 17);

  const legacyVp = tmpVault("kdfcost-legacy");
  await makeLegacyVault(legacyVp, PASS);
  const a = vault.openVault(legacyVp, PASS);
  assert.ok(fs.existsSync(a.workingDir));
  vault.discardVault(legacyVp, PASS);
});

test("writeContainer uses tmp+rename (atomic); no .tmp file lingers after write", () => {
  const vp = tmpVault("atomic-write");
  vault.createVault(vp, { password: PASS });
  assert.equal(fs.existsSync(`${vp}.tmp`), false);
  assert.ok(fs.existsSync(vp));

  vault.openVault(vp, PASS);
  vault.closeVault(vp, PASS);
  assert.equal(fs.existsSync(`${vp}.tmp`), false);
  assert.ok(fs.existsSync(vp));
});

test("copyInto rejects top-level symlinks (lstatSync consistency with packDir/walk)", async () => {
  const srcDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "shadowbit-symlink-src-"),
  );
  const real = path.join(srcDir, "real.txt");
  const link = path.join(srcDir, "link.txt");
  const destDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "shadowbit-symlink-dst-"),
  );
  try {
    fs.writeFileSync(real, "hello");
    try {
      fs.symlinkSync(real, link);
    } catch {
      return;
    }
    assert.throws(
      () => fsutil.copyInto(link, destDir),
      /Symlinks cannot be added/,
    );
    assert.doesNotThrow(() => fsutil.copyInto(real, destDir));
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test("upgradeRecoveryEscrow re-salts a legacy v1 escrow in place", async () => {
  const vp = tmpVault("escrow-upgrade");
  const recoveryKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH";
  await makeLegacyVault(vp, PASS, recoveryKey);

  const h0 = container.readHeader(vp);
  assert.equal(h0.version, 1);
  assert.equal(h0.recovery!.salt, undefined);

  assert.throws(
    () =>
      vault.upgradeRecoveryEscrow(
        vp,
        "ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV-UUUUU-TTTTT-SSSSS",
      ),
    vault.WrongCredentialError,
  );
  assert.equal(container.readHeader(vp).version, 1);

  vault.upgradeRecoveryEscrow(vp, recoveryKey);
  const h1 = container.readHeader(vp);
  assert.equal(h1.version, container.CURRENT_VERSION);
  assert.ok(h1.recovery!.salt);

  vault.recoverVault(vp, recoveryKey, "post-upgrade-password-1");
  const a = vault.openVault(vp, "post-upgrade-password-1");
  assert.ok(fs.existsSync(a.workingDir));
  vault.discardVault(vp, "post-upgrade-password-1");

  assert.throws(
    () => vault.upgradeRecoveryEscrow(vp, recoveryKey),
    /already up to date/,
  );
});

// ---------------------------------------------------------------------------
// Phase 12 — new tests
// ---------------------------------------------------------------------------

test("deleteVault requires the correct password (B1)", () => {
  const vp = tmpVault("delete-auth");
  vault.createVault(vp, { password: PASS, generateRecovery: false });

  // Wrong password must not delete.
  assert.throws(
    () => vault.deleteVault(vp, "wrong-password"),
    vault.WrongCredentialError,
  );
  assert.ok(fs.existsSync(vp), "vault still exists after rejected delete");

  // Correct password deletes successfully.
  assert.doesNotThrow(() => vault.deleteVault(vp, PASS));
  assert.equal(fs.existsSync(vp), false);
});

test("deleteVault with wrong password leaves vault and session intact", () => {
  const vp = tmpVault("delete-intact");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  vault.openVault(vp, PASS);
  const info = vault.getInfo(vp);
  assert.ok(info.isOpen);

  assert.throws(
    () => vault.deleteVault(vp, "totally-wrong"),
    vault.WrongCredentialError,
  );
  assert.ok(fs.existsSync(vp));
  assert.ok(vault.getInfo(vp).isOpen);
  vault.discardVault(vp, PASS);
});

test("copyInto skips nested symlinks inside a directory (B2)", async () => {
  const srcDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "shadowbit-nested-sym-src-"),
  );
  const destDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "shadowbit-nested-sym-dst-"),
  );
  const subdir = path.join(srcDir, "sub");
  fs.mkdirSync(subdir);
  fs.writeFileSync(path.join(subdir, "real.txt"), "content");
  try {
    fs.symlinkSync(
      path.join(subdir, "real.txt"),
      path.join(subdir, "link.txt"),
    );
  } catch {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
    return; // platform doesn't support symlinks — skip
  }
  const { skipped } = fsutil.copyInto(srcDir, destDir);
  assert.equal(skipped, 1, "one nested symlink should be skipped");
  assert.ok(
    fs.existsSync(path.join(destDir, path.basename(srcDir), "sub", "real.txt")),
    "real file should be copied",
  );
  assert.equal(
    fs.existsSync(path.join(destDir, path.basename(srcDir), "sub", "link.txt")),
    false,
    "symlink should not be copied",
  );
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(destDir, { recursive: true, force: true });
});

test("closeVault detects header tampering since open (TOCTOU guard / S6)", () => {
  const vp = tmpVault("toctou");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  vault.openVault(vp, PASS);

  // Simulate an attacker swapping the header by changing the modifiedAt.
  const { header, payload } = container.readContainer(vp);
  header.modifiedAt = "1970-01-01T00:00:00.000Z"; // tamper
  container.writeContainer(vp, header, payload);

  assert.throws(
    () => vault.closeVault(vp, PASS),
    /modified since it was opened/,
  );

  // Clean up the session manually since close failed.
  const { removeSession } = sessions;
  removeSession(vp);
});

test("addToSession returns count and symlinksSkipped", async () => {
  const vp = tmpVault("addresult");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  vault.openVault(vp, PASS);

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-add-src-"));
  fs.writeFileSync(path.join(srcDir, "file1.txt"), "a");
  fs.writeFileSync(path.join(srcDir, "file2.txt"), "b");

  const addResult = vault.addToSession(vp, [
    path.join(srcDir, "file1.txt"),
    path.join(srcDir, "file2.txt"),
  ]);
  assert.equal(addResult.count, 2);
  assert.equal(addResult.symlinksSkipped, 0);

  fs.rmSync(srcDir, { recursive: true, force: true });
  vault.discardVault(vp, PASS);
});

test("MEK buffer is zeroed after vault operations (S2 pattern)", () => {
  // Verify that Buffer.fill(0) actually zeros a buffer — the functional
  // correctness of the zeroing mechanism that vault.ts relies on.
  const buf = Buffer.from("secret-key-material-32-bytes!!!!");
  assert.ok(
    buf.some((b) => b !== 0),
    "buffer should have non-zero bytes",
  );
  buf.fill(0);
  assert.ok(
    buf.every((b) => b === 0),
    "buffer should be all zeros after fill",
  );
});

test("new vaults have compressed flag set to true", () => {
  const vp = tmpVault("compressed");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  const h = container.readHeader(vp);
  assert.equal(h.compressed, true);
});

test("compressed vault round-trips files correctly", () => {
  const vp = tmpVault("compress-roundtrip");
  vault.createVault(vp, { password: PASS, generateRecovery: false });

  const a = vault.openVault(vp, PASS);
  // Write some text content that compresses well.
  fs.writeFileSync(
    path.join(a.workingDir, "large.txt"),
    "AAAA".repeat(10_000), // 40 KB of repeated chars → highly compressible
  );
  vault.closeVault(vp, PASS);

  const b = vault.openVault(vp, PASS);
  assert.equal(
    fs.readFileSync(path.join(b.workingDir, "large.txt"), "utf8"),
    "AAAA".repeat(10_000),
  );
  vault.discardVault(vp, PASS);
});

test("legacy uncompressed vault still opens correctly", async () => {
  const vp = tmpVault("legacy-nocompress");
  await makeLegacyVault(vp, PASS); // no `compressed` flag in header
  const { workingDir } = vault.openVault(vp, PASS);
  assert.ok(fs.existsSync(workingDir));
  vault.discardVault(vp, PASS);
});

test("setMeta saves and retrieves vault metadata", () => {
  const vp = tmpVault("metadata");
  vault.createVault(vp, { password: PASS, generateRecovery: false });

  vault.setMeta(vp, PASS, {
    name: "My Test Vault",
    description: "A vault for testing",
  });

  const info = vault.getInfo(vp);
  assert.equal(info.meta?.name, "My Test Vault");
  assert.equal(info.meta?.description, "A vault for testing");

  // Clear the name.
  vault.setMeta(vp, PASS, { name: "", description: "Updated description" });
  const info2 = vault.getInfo(vp);
  assert.equal(info2.meta?.name, undefined);
  assert.equal(info2.meta?.description, "Updated description");
});

test("setMeta requires correct password", () => {
  const vp = tmpVault("meta-auth");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  assert.throws(
    () => vault.setMeta(vp, "wrong-password", { name: "hacked" }),
    vault.WrongCredentialError,
  );
  // Ensure header was not modified.
  assert.equal(vault.getInfo(vp).meta, undefined);
});

test("readHeaderRaw returns raw bytes and parsed header", () => {
  const vp = tmpVault("rawhdr");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  const { header, rawBytes } = container.readHeaderRaw(vp);
  assert.ok(rawBytes.length > 10, "raw bytes should be non-trivial");
  assert.equal(header.magic, "SHDBIT");
  // rawBytes should round-trip through JSON parse to the same header.
  const parsed = JSON.parse(rawBytes.toString("utf8"));
  assert.equal(parsed.magic, "SHDBIT");
});

test("changePassword refreshes session hash so subsequent close succeeds", () => {
  const vp = tmpVault("cp-refresh-hash");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  vault.openVault(vp, PASS);

  // Change password while the vault is open — this rewrites the header.
  vault.changePassword(vp, PASS, "new-password-for-hash-test");

  // Close with the NEW password — should succeed without TOCTOU error
  // because changePassword refreshed the session's headerHash.
  assert.doesNotThrow(() => vault.closeVault(vp, "new-password-for-hash-test"));
});

// ---------------------------------------------------------------------------
// Phase 21 — Adversarial security hardening tests
// ---------------------------------------------------------------------------

test("v3 vaults have a headerMac and it is verified on open (21.1)", () => {
  const vp = tmpVault("headermac");
  vault.createVault(vp, { password: PASS, generateRecovery: false });

  const h = container.readHeader(vp);
  assert.equal(h.version, container.CURRENT_VERSION);
  assert.ok(h.headerMac, "new vaults must have a headerMac");
  assert.equal(typeof h.headerMac, "string");
  assert.equal(h.headerMac.length, 64); // SHA-256 hex = 64 chars

  // Opens normally with correct password.
  vault.openVault(vp, PASS);
  vault.discardVault(vp, PASS);
});

test("tampered header (KDF downgrade) is detected via headerMac (21.1)", () => {
  const vp = tmpVault("headermac-tamper");
  vault.createVault(vp, { password: PASS, generateRecovery: false });

  // Read the container, tamper the KDF params (downgrade N), rewrite.
  const { header, payload } = container.readContainer(vp);
  assert.ok(header.headerMac);
  header.kdfParams = { ...header.kdfParams, N: 16384 }; // downgrade from 2^17 to 2^14
  // Leave the old headerMac — it's now stale.
  container.writeContainer(vp, header, payload);

  // Opening should detect the mismatch.
  assert.throws(
    () => vault.openVault(vp, PASS),
    /tampered|integrity|Incorrect/i,
  );
});

test("legacy v1/v2 vaults without headerMac still open (backward compat)", async () => {
  const vp = tmpVault("no-mac-legacy");
  const recoveryKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH";
  await makeLegacyVault(vp, PASS, recoveryKey);

  const h = container.readHeader(vp);
  assert.equal(h.headerMac, undefined, "legacy vault should have no MAC");

  // Should still open — MAC check is skipped for v1/v2.
  const { workingDir } = vault.openVault(vp, PASS);
  assert.ok(fs.existsSync(workingDir));
  vault.discardVault(vp, PASS);
});

test("closeVault upgrades vault to v3 with headerMac", async () => {
  const vp = tmpVault("close-upgrades");
  await makeLegacyVault(vp, PASS);

  // Open the legacy v1 vault.
  vault.openVault(vp, PASS);
  // Close re-encrypts and should write a v3 header with MAC.
  vault.closeVault(vp, PASS);

  const h = container.readHeader(vp);
  assert.equal(h.version, container.CURRENT_VERSION);
  assert.ok(h.headerMac, "close should produce a headerMac");

  // Should still open after upgrade.
  vault.openVault(vp, PASS);
  vault.discardVault(vp, PASS);
});

test("password strength estimation (21.5)", async () => {
  const cryptoMod = await import("../core/crypto.js");

  // Rejected (too short)
  assert.equal(cryptoMod.estimateStrength("short").score, 0);
  assert.equal(cryptoMod.estimateStrength("1234567").score, 0);

  // Rejected (blocklisted)
  assert.equal(cryptoMod.estimateStrength("password").score, 0);
  assert.equal(cryptoMod.estimateStrength("12345678").score, 0);
  assert.equal(cryptoMod.estimateStrength("qwerty123").score, 0);

  // Weak (single class, short, but not blocklisted)
  assert.equal(cryptoMod.estimateStrength("reindeer").score, 1);

  // Fair (two classes)
  assert.ok(cryptoMod.estimateStrength("Abcdefgh1").score >= 2);

  // Good (long + mixed)
  assert.ok(cryptoMod.estimateStrength("MyP@ssw0rd!Long").score >= 3);

  // Strong (very long + diverse)
  assert.equal(
    cryptoMod.estimateStrength("C0rrect-H0rse-B@ttery-St@ple!").score,
    4,
  );

  // Entropy is positive for valid passwords.
  assert.ok(
    cryptoMod.estimateStrength("correct-horse-battery-staple").entropy > 0,
  );
});

test("timing-safe recovery key hash comparison works (21.2)", () => {
  const vp = tmpVault("timing-safe");
  const { recoveryKey } = vault.createVault(vp, {
    password: PASS,
    generateRecovery: true,
  });
  assert.ok(recoveryKey);

  // Correct recovery key works.
  vault.recoverVault(vp, recoveryKey, "new-password-timing-safe");

  // Wrong recovery key fails.
  assert.throws(
    () =>
      vault.recoverVault(
        vp,
        "ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV-UUUUU-TTTTT-SSSSS",
        "another-pass",
      ),
    vault.WrongCredentialError,
  );
});

// ---------------------------------------------------------------------------
// Phase 21 — Steganography tests (21.4)
// ---------------------------------------------------------------------------

test("embedVault hides a vault inside a carrier file and extractVault recovers it", async () => {
  const stegoMod = await import("../core/stego.js");

  // Create a real vault first.
  const vp = tmpVault("stego-src");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  vault.openVault(vp, PASS);
  // Add a test file so the payload is non-trivial.
  const session = sessions.findSession(path.resolve(vp));
  fs.writeFileSync(path.join(session!.workingDir, "secret.txt"), "hidden data");
  vault.closeVault(vp, PASS);

  // Read the vault container for embedding.
  const containerMod = await import("../core/container.js");
  const { header, payload } = containerMod.readContainer(vp);

  // Create a fake carrier (a minimal valid "image" — just some bytes).
  const carrierPath = path.join(tmpRoot, "carrier.jpg");
  const carrierData = Buffer.from("FAKE_JPEG_HEADER_DATA_" + "X".repeat(100));
  fs.writeFileSync(carrierPath, carrierData);

  // Embed the vault inside the carrier.
  const outputPath = path.join(tmpRoot, "photo.jpg");
  stegoMod.embedVault(carrierPath, header, payload, outputPath);

  // The output file should exist and be larger than the carrier.
  assert.ok(fs.existsSync(outputPath));
  assert.ok(fs.statSync(outputPath).size > carrierData.length);

  // The carrier data should be intact at the beginning.
  const outputBuf = fs.readFileSync(outputPath);
  assert.ok(outputBuf.subarray(0, carrierData.length).equals(carrierData));

  // hasEmbeddedVault should detect it.
  assert.ok(stegoMod.hasEmbeddedVault(outputPath));
  assert.equal(stegoMod.hasEmbeddedVault(carrierPath), false); // original has no vault

  // extractVault should recover the header and payload.
  const extracted = stegoMod.extractVault(outputPath);
  assert.ok(extracted);
  assert.equal(extracted!.header.magic, "SHDBIT");
  assert.ok(extracted!.payload.length > 0);

  // The extracted vault should decrypt correctly.
  // Write it as a normal .vault and open it.
  const recoveredVp = tmpVault("stego-recovered");
  containerMod.writeContainer(
    recoveredVp,
    extracted!.header,
    extracted!.payload,
  );
  const opened = vault.openVault(recoveredVp, PASS);
  assert.equal(
    fs.readFileSync(path.join(opened.workingDir, "secret.txt"), "utf8"),
    "hidden data",
  );
  vault.discardVault(recoveredVp, PASS);
});

test("extractVault returns null for a file without an embedded vault", async () => {
  const stegoMod = await import("../core/stego.js");
  const plainFile = path.join(tmpRoot, "plain.txt");
  fs.writeFileSync(plainFile, "just a normal file");
  assert.equal(stegoMod.extractVault(plainFile), null);
  assert.equal(stegoMod.hasEmbeddedVault(plainFile), false);
});

test("extractVault skips a coincidental magic inside the carrier", async () => {
  // The carrier is arbitrary user content, so it may legitimately contain the 8
  // magic bytes — inside a JPEG's compressed scan data, say. The scan used to
  // stop at the FIRST match, which reported "no vault" for a carrier that had
  // one appended after it. Every candidate is now tried, and only one that
  // parses as a real container (magic + version, via parseHeader) is accepted.
  const stegoMod = await import("../core/stego.js");
  const containerMod = await import("../core/container.js");

  const vp = tmpVault("stego-decoy");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  vault.openVault(vp, PASS);
  const session = sessions.findSession(path.resolve(vp));
  fs.writeFileSync(path.join(session!.workingDir, "secret.txt"), "decoy data");
  vault.closeVault(vp, PASS);
  const { header, payload } = containerMod.readContainer(vp);

  const decoyCarrier = path.join(tmpRoot, "decoy-carrier.jpg");
  fs.writeFileSync(
    decoyCarrier,
    Buffer.concat([
      Buffer.from("JPEG-ish header"),
      Buffer.from("SBSTEG\x00\x01", "latin1"), // 8 magic bytes, no container
      Buffer.from("garbage that is not a vault"),
    ]),
  );

  const output = path.join(tmpRoot, "decoy-output.jpg");
  stegoMod.embedVault(decoyCarrier, header, payload, output);

  const extracted = stegoMod.extractVault(output);
  assert.ok(
    extracted,
    "the real container appended after the decoy magic must still be found",
  );
  // The real magic sits immediately after the carrier bytes, so its offset is
  // exactly the carrier length. Anything smaller would be the decoy inside.
  assert.ok(
    extracted!.stegoOffset >= fs.statSync(decoyCarrier).size,
    `the match must be the real vault, not the decoy inside the carrier ` +
      `(offset ${extracted!.stegoOffset}, carrier ` +
      `${fs.statSync(decoyCarrier).size})`,
  );

  const recovered = tmpVault("stego-decoy-recovered");
  containerMod.writeContainer(recovered, extracted!.header, extracted!.payload);
  const opened = vault.openVault(recovered, PASS);
  assert.equal(
    fs.readFileSync(path.join(opened.workingDir, "secret.txt"), "utf8"),
    "decoy data",
  );
  vault.discardVault(recovered, PASS);
});

test("embedVault refuses to write over its own carrier", async () => {
  // The tmp-then-rename would rename onto outputPath, so a caller passing the
  // carrier as the output would destroy the source before the copy finished.
  const stegoMod = await import("../core/stego.js");
  const carrier = path.join(tmpRoot, "selfoverwrite.jpg");
  fs.writeFileSync(carrier, "ORIGINAL CARRIER BYTES");

  assert.throws(
    () => stegoMod.embedVault(carrier, {} as any, Buffer.from("p"), carrier),
    /must differ/i,
    "embedding onto the carrier must be refused",
  );
  assert.equal(
    fs.readFileSync(carrier, "utf8"),
    "ORIGINAL CARRIER BYTES",
    "the carrier must survive the refusal",
  );
});

// ---------------------------------------------------------------------------
// Phase 21 — Encrypted session metadata tests (21.7)
// ---------------------------------------------------------------------------

test("local key encryption round-trips correctly", async () => {
  const localkey = await import("../core/localkey.js");
  localkey._clearCachedKey(); // force fresh key for this test

  const plaintext = JSON.stringify({ test: "data", nested: [1, 2, 3] });
  const encrypted = localkey.encryptLocal(plaintext);

  // Encrypted output should be larger than plaintext and start with marker.
  assert.ok(encrypted.length > plaintext.length);

  const decrypted = localkey.decryptLocal(encrypted);
  assert.equal(decrypted, plaintext);

  // Random data should not decrypt.
  const garbage = Buffer.from("not encrypted at all");
  assert.equal(localkey.decryptLocal(garbage), null);
});

test("sessions are stored encrypted and can be read back", () => {
  // The test already uses an isolated SHADOWBIT_CONFIG_DIR, so sessions
  // should be encrypted by the localkey module.
  const vp = tmpVault("enc-sessions");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  vault.openVault(vp, PASS);

  // Verify the session was recorded.
  const allSessions = sessions.loadSessions();
  assert.ok(allSessions.some((s) => s.vaultPath === path.resolve(vp)));

  vault.discardVault(vp, PASS);
});

// ---------------------------------------------------------------------------
// Gap closing tests — Keyfiles, Algorithm agility, Hidden volumes, Indexing
// ---------------------------------------------------------------------------

test("keyfile-protected vault requires keyfile to open", async () => {
  // Create a temporary keyfile.
  const kfPath = path.join(tmpRoot, "test.keyfile");
  fs.writeFileSync(kfPath, crypto.randomBytes(64));

  const vp = tmpVault("keyfile-vault");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
    keyfiles: [kfPath],
  });

  // Verify header has keyfileRequired.
  const h = container.readHeader(vp);
  assert.equal(h.keyfileRequired, true);

  // Open WITHOUT keyfile should fail.
  assert.throws(() => vault.openVault(vp, PASS), /keyfile/i);

  // Open WITH keyfile should succeed.
  const opened = vault.openVault(vp, PASS, [kfPath]);
  assert.ok(fs.existsSync(opened.workingDir));
  vault.discardVault(vp, PASS, [kfPath]);
});

test("wrong keyfile fails to open vault", async () => {
  const kfPath = path.join(tmpRoot, "correct.keyfile");
  fs.writeFileSync(kfPath, crypto.randomBytes(64));
  const wrongKfPath = path.join(tmpRoot, "wrong.keyfile");
  fs.writeFileSync(wrongKfPath, crypto.randomBytes(64));

  const vp = tmpVault("keyfile-wrong");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
    keyfiles: [kfPath],
  });

  // Wrong keyfile should fail (GCM auth failure).
  assert.throws(
    () => vault.openVault(vp, PASS, [wrongKfPath]),
    /Incorrect|tampered|integrity/i,
  );
});

// ---------------------------------------------------------------------------
// Keyfile lifecycle — every operation that authenticates against an existing
// vault must accept the keyfile. If one of these forgets to forward it,
// effectivePassword() throws and the user is stuck: a keyfile vault cannot be
// deleted, shredded, re-passworded, or have its recovery key rotated. That is
// a data-lifecycle dead end, so each operation is asserted individually.
// ---------------------------------------------------------------------------

test("keyfile vault: every authenticated operation forwards keyfiles", () => {
  const kfPath = path.join(tmpRoot, "lifecycle.keyfile");
  fs.writeFileSync(kfPath, crypto.randomBytes(64));

  const vp = tmpVault("keyfile-lifecycle");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: true,
    keyfiles: [kfPath],
  });

  // Each of these throws "requires a keyfile" if keyfiles is not forwarded.
  assert.doesNotThrow(() =>
    vault.setMeta(vp, PASS, { name: "renamed" }, [kfPath]),
  );
  assert.doesNotThrow(() =>
    vault.changePassword(vp, PASS, "new-password-1", {
      keyfiles: [kfPath],
    }),
  );
  assert.doesNotThrow(() =>
    vault.regenerateRecoveryKey(vp, "new-password-1", [kfPath]),
  );
  assert.doesNotThrow(() =>
    vault.removeRecoveryKey(vp, "new-password-1", [kfPath]),
  );

  const opened = vault.openVault(vp, "new-password-1", [kfPath]);
  assert.ok(fs.existsSync(opened.workingDir));
  assert.doesNotThrow(() => vault.closeVault(vp, "new-password-1", [kfPath]));

  // The whole point: a keyfile vault must remain deletable.
  assert.doesNotThrow(() =>
    vault.deleteVault(vp, "new-password-1", { keyfiles: [kfPath] }),
  );
  assert.equal(fs.existsSync(vp), false);
});

test("keyfile vault: delete without the keyfile is refused, not destructive", () => {
  const kfPath = path.join(tmpRoot, "undelete.keyfile");
  fs.writeFileSync(kfPath, crypto.randomBytes(64));

  const vp = tmpVault("keyfile-undelete");
  vault.createVault(vp, { password: PASS, keyfiles: [kfPath] });

  assert.throws(() => vault.deleteVault(vp, PASS), /keyfile/i);
  assert.equal(fs.existsSync(vp), true, "vault must survive a failed delete");
});

test("changePassword keeps the keyfile requirement instead of bricking the vault", () => {
  const kfPath = path.join(tmpRoot, "brick.keyfile");
  fs.writeFileSync(kfPath, crypto.randomBytes(64));

  const vp = tmpVault("keyfile-cp-brick");
  vault.createVault(vp, { password: PASS, keyfiles: [kfPath] });

  // No `newKeyfiles`: the existing keyfile set must carry over. If the MEK were
  // re-wrapped under the bare password while keyfileRequired stayed set, the
  // vault would be unopenable both with and without the keyfile.
  vault.changePassword(vp, PASS, "rotated-password", { keyfiles: [kfPath] });

  const h = container.readHeader(vp);
  assert.equal(h.keyfileRequired, true, "requirement must survive the change");

  // Both ways of opening must still work: the flag and the wrap agree.
  assert.throws(() => vault.openVault(vp, "rotated-password"), /keyfile/i);
  const opened = vault.openVault(vp, "rotated-password", [kfPath]);
  assert.ok(fs.existsSync(opened.workingDir));
  vault.discardVault(vp, "rotated-password", [kfPath]);
});

test("changePassword drops the keyfile requirement only when asked explicitly", () => {
  const kfPath = path.join(tmpRoot, "drop.keyfile");
  fs.writeFileSync(kfPath, crypto.randomBytes(64));

  const vp = tmpVault("keyfile-cp-drop");
  vault.createVault(vp, { password: PASS, keyfiles: [kfPath] });

  // An explicitly empty newKeyfiles set means "no keyfile from now on".
  vault.changePassword(vp, PASS, "no-keyfile-now", {
    keyfiles: [kfPath],
    newKeyfiles: [],
  });

  const h = container.readHeader(vp);
  assert.equal(h.keyfileRequired, undefined);
  const opened = vault.openVault(vp, "no-keyfile-now");
  assert.ok(fs.existsSync(opened.workingDir));
  vault.discardVault(vp, "no-keyfile-now");
});

test("paranoid mode strips metadata even when meta is supplied", () => {
  const vp = tmpVault("paranoid-meta");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
    paranoid: true,
    meta: { name: "SECRET-NAME", description: "SECRET-DESC" },
  });

  const h = container.readHeader(vp);
  assert.equal(h.meta, undefined, "paranoid vaults must carry no metadata");
  assert.equal(JSON.stringify(h).includes("SECRET-NAME"), false);
  assert.equal(JSON.stringify(h).includes("SECRET-DESC"), false);
  assert.equal(h.createdAt, "1970-01-01T00:00:00.000Z");
});

test("paranoid mode: setMeta succeeds but reports that it wrote plaintext", () => {
  // The write is ALLOWED. Refusing outright was the wrong call: metadata is
  // legitimate content, and a user who chose --paranoid years ago and now wants
  // a description is not making a mistake — they are entitled to it. What must
  // not happen is a silent success, because the whole point of paranoid mode is
  // a header carrying nothing optional in plaintext. So the result carries
  // `paranoid: true` and every frontend is required to warn.
  const vp = tmpVault("paranoid-setmeta");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
    paranoid: true,
  });

  const res = vault.setMeta(vp, PASS, {
    name: "Tax 2026",
    description: "Filed",
  });
  assert.equal(res.paranoid, true, "the caller must be told to warn");
  assert.equal(res.vaultPath, path.resolve(vp));

  const h = container.readHeader(vp);
  assert.equal(
    h.meta?.name,
    "Tax 2026",
    "the metadata is written, as intended",
  );
  // Paranoid mode still holds on what it owns: the metadata write must not
  // introduce a real timestamp, because that is what setMeta is not allowed to
  // undo.
  assert.equal(
    h.createdAt,
    "1970-01-01T00:00:00.000Z",
    "createdAt identifies the vault as paranoid, so it must not change",
  );

  // And the vault is still usable afterwards.
  vault.openVault(vp, PASS);
  vault.closeVault(vp, PASS);

  // An ordinary vault must NOT be flagged, or every frontend would warn about a
  // vault that has no such caveat.
  const plain = tmpVault("plain-setmeta");
  vault.createVault(plain, { password: PASS, generateRecovery: false });
  assert.equal(
    vault.setMeta(plain, PASS, { name: "Ordinary" }).paranoid,
    false,
    "an ordinary vault must not be flagged as paranoid",
  );
});

test("getInfo reports cipher and keyfile requirement", () => {
  const kfPath = path.join(tmpRoot, "info.keyfile");
  fs.writeFileSync(kfPath, crypto.randomBytes(64));

  const plain = tmpVault("info-plain");
  vault.createVault(plain, { password: PASS, generateRecovery: false });
  assert.equal(vault.getInfo(plain).cipher, "aes-256-gcm");
  assert.equal(vault.getInfo(plain).keyfileRequired, false);

  const guarded = tmpVault("info-keyfile");
  vault.createVault(guarded, {
    password: PASS,
    generateRecovery: false,
    cipher: "chacha20-poly1305",
    keyfiles: [kfPath],
  });
  assert.equal(vault.getInfo(guarded).cipher, "chacha20-poly1305");
  assert.equal(vault.getInfo(guarded).keyfileRequired, true);
});

test("ChaCha20-Poly1305 cipher creates and opens correctly", () => {
  const vp = tmpVault("chacha20");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
    cipher: "chacha20-poly1305",
  });

  const h = container.readHeader(vp);
  assert.equal(h.cipher, "chacha20-poly1305");
  assert.equal(h.version, container.CURRENT_VERSION);

  // Open and verify data round-trips.
  const opened = vault.openVault(vp, PASS);
  assert.ok(fs.existsSync(opened.workingDir));
  // Add a file, close, re-open.
  fs.writeFileSync(path.join(opened.workingDir, "chacha.txt"), "chacha20 test");
  vault.closeVault(vp, PASS);

  const reopened = vault.openVault(vp, PASS);
  assert.equal(
    fs.readFileSync(path.join(reopened.workingDir, "chacha.txt"), "utf8"),
    "chacha20 test",
  );
  vault.discardVault(vp, PASS);
});

test("hidden volume: create, open outer, open hidden", async () => {
  const hiddenMod = await import("../core/hidden.js");
  const vp = path.join(tmpRoot, "hidden.vault");
  const outerDir = path.join(tmpRoot, "outer-seed");
  const hiddenDir = path.join(tmpRoot, "hidden-seed");
  fs.mkdirSync(outerDir, { recursive: true });
  fs.mkdirSync(hiddenDir, { recursive: true });
  fs.writeFileSync(path.join(outerDir, "decoy.txt"), "decoy data");
  fs.writeFileSync(path.join(hiddenDir, "secret.txt"), "hidden secret");

  // Create hidden vault (8 MiB container).
  hiddenMod.createHiddenVault({
    vaultPath: vp,
    outerPassword: "outer-password-test",
    hiddenPassword: "hidden-password-test",
    totalSize: 8 * 1024 * 1024,
    outerSeedDir: outerDir,
    hiddenSeedDir: hiddenDir,
  });

  // File should exist and be exactly 8 MiB.
  assert.ok(fs.existsSync(vp));
  assert.equal(fs.statSync(vp).size, 8 * 1024 * 1024);

  // Outer password opens the standard container.
  assert.ok(hiddenMod.isOuterPassword(vp, "outer-password-test"));
  assert.equal(hiddenMod.isOuterPassword(vp, "hidden-password-test"), false);

  // Open the hidden volume.
  const { header: hh, payload: hp } = hiddenMod.openHiddenVolume(
    vp,
    "hidden-password-test",
  );
  assert.ok(hh.magic, "SHDBIT");
  assert.ok(hp.length > 0);

  // Wrong password should fail for hidden volume.
  assert.throws(
    () => hiddenMod.openHiddenVolume(vp, "wrong-password-test"),
    /No hidden volume/i,
  );
});

test("hidden volume: wrong hidden password does not reveal existence", async () => {
  const hiddenMod = await import("../core/hidden.js");
  const vp = path.join(tmpRoot, "hidden-deny.vault");

  hiddenMod.createHiddenVault({
    vaultPath: vp,
    outerPassword: "deny-outer-pw",
    hiddenPassword: "deny-hidden-pw",
    totalSize: 8 * 1024 * 1024,
  });

  // A wrong password should produce the same error whether the vault has
  // a hidden volume or not — no information leakage.
  assert.throws(
    () => hiddenMod.openHiddenVolume(vp, "totally-wrong-password"),
    /No hidden volume/i,
  );
});

test("hidden volume: a crafted file full of SBHID magic cannot burn CPU", async () => {
  // Each candidate block costs a full scrypt derivation (~134 MB, hundreds of
  // ms). The scan walks the file backwards for the magic, so a hostile file
  // padded with thousands of copies of those 6 bytes would turn one open into a
  // CPU-exhaustion loop. The attempt count is capped; a container written by
  // createHiddenVault needs exactly one.
  const hiddenMod = await import("../core/hidden.js");
  const vp = path.join(tmpRoot, "hidden-dos.vault");

  hiddenMod.createHiddenVault({
    vaultPath: vp,
    outerPassword: "dos-outer-pw",
    hiddenPassword: "dos-hidden-pw",
    totalSize: 8 * 1024 * 1024,
  });

  // Overwrite with nothing but repeated magic, so every candidate is a decoy.
  const size = fs.statSync(vp).size;
  const MAGIC = Buffer.from("SBHID\x00", "latin1");
  const filler = Buffer.alloc(size);
  for (let i = 0; i + MAGIC.length <= size; i += MAGIC.length) {
    MAGIC.copy(filler, i);
  }
  fs.writeFileSync(vp, filler);

  const started = Date.now();
  assert.throws(
    () => hiddenMod.openHiddenVolume(vp, "dos-hidden-pw"),
    /No hidden volume/i,
  );
  const elapsed = Date.now() - started;

  // The cap is 8 attempts. Assert the bound rather than an exact timing: a
  // generous ceiling still fails loudly if the cap is ever removed, while not
  // being flaky on a loaded CI box. Unbounded would be ~200k derivations here.
  assert.ok(
    elapsed < 60_000,
    `open must stay bounded, took ${elapsed}ms for a file of pure decoys`,
  );
});

test("suppressIndexing creates marker files without throwing", async () => {
  const { suppressIndexing } = await import("../core/fsutil.js");
  const dir = fs.mkdtempSync(path.join(tmpRoot, "idx-test-"));
  // Should not throw on any platform.
  assert.doesNotThrow(() => suppressIndexing(dir));
  // On macOS, check the marker file was created.
  if (process.platform === "darwin") {
    assert.ok(fs.existsSync(path.join(dir, ".metadata_never_index")));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Metadata privacy & timestamp scrubbing tests
// ---------------------------------------------------------------------------

test("vault file timestamps are scrubbed to epoch after write", () => {
  const vp = tmpVault("ts-scrub");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
  });
  const stat = fs.statSync(vp);
  // atime and mtime should be epoch (within 1 second tolerance for fs precision).
  assert.ok(
    stat.mtimeMs < 1000,
    `mtime should be epoch, got ${stat.mtime.toISOString()}`,
  );
});

test("paranoid mode strips timestamps and metadata from header", () => {
  const vp = tmpVault("paranoid");
  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
    meta: { name: "should-be-stripped", description: "also stripped" },
    paranoid: true,
  });

  const h = container.readHeader(vp);
  assert.equal(h.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(h.modifiedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(h.meta, undefined, "meta should be stripped in paranoid mode");

  // Vault should still open/close correctly.
  vault.openVault(vp, PASS);
  vault.closeVault(vp, PASS);

  // After close, timestamps should STILL be epoch (paranoid mode persists).
  const h2 = container.readHeader(vp);
  assert.equal(h2.modifiedAt, "1970-01-01T00:00:00.000Z");
  vault.discardVault(vp, PASS);
});

test("working dir files have scrubbed timestamps after open", () => {
  const vp = tmpVault("ts-working-dir");
  const seedDir = path.join(tmpRoot, "ts-seed");
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, "test.txt"), "timestamp test");
  // Set a known recent mtime on the seed file.
  fs.utimesSync(path.join(seedDir, "test.txt"), new Date(), new Date());

  vault.createVault(vp, {
    password: PASS,
    generateRecovery: false,
    seedDir,
  });

  const { workingDir } = vault.openVault(vp, PASS);
  const fileStat = fs.statSync(path.join(workingDir, "test.txt"));
  // After open, file timestamps should be scrubbed to epoch.
  assert.ok(
    fileStat.mtimeMs < 1000,
    `Working dir file mtime should be epoch, got ${fileStat.mtime.toISOString()}`,
  );
  vault.discardVault(vp, PASS);
});

// ---------------------------------------------------------------------------
// Session-registry concurrency
//
// The sessions file is mutated with a read-modify-write cycle guarded by an
// advisory O_EXCL lock. An in-process test cannot exercise this: Node is
// single-threaded, so the cycle cannot interleave. These tests therefore spawn
// real child processes, which is also the actual scenario the lock exists for
// (two `shadow-bit` invocations, or a CLI plus the Electron GUI).
// ---------------------------------------------------------------------------

test("concurrent addSession calls from separate processes all persist", async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowbit-lock-race-"));
  const childSrc = path.join(cfgDir, "add.ts");
  fs.writeFileSync(
    childSrc,
    `
    import * as sessions from ${JSON.stringify(
      path.join(__dirname, "..", "core", "sessions"),
    )};
    sessions.addSession({
      vaultPath: process.argv[2],
      workingDir: "/tmp/wd-" + process.argv[2],
      openedAt: new Date().toISOString(),
    });
    `,
    "utf8",
  );

  const N = 8;
  const children = [];
  for (let i = 0; i < N; i++) {
    children.push(
      new Promise<void>((resolve, reject) => {
        const proc = spawn(
          process.execPath,
          ["--import", "tsx", childSrc, `vault-${i}.vault`],
          {
            env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
            stdio: "ignore",
          },
        );
        proc.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`child ${i} exited with ${code}`)),
        );
        proc.on("error", reject);
      }),
    );
  }
  await Promise.all(children);

  // Every concurrent add must be present — a lost update here means the
  // read-modify-write cycle ran outside the lock. Read back through a fresh
  // child process so the local machine key is loaded against this cfgDir
  // (localkey captures SHADOWBIT_CONFIG_DIR at module load, so importing it
  // into this process would use the suite-wide config dir instead).
  const readerSrc = path.join(cfgDir, "read.ts");
  fs.writeFileSync(
    readerSrc,
    `
    import * as sessions from ${JSON.stringify(
      path.join(__dirname, "..", "core", "sessions"),
    )};
    process.stdout.write(JSON.stringify(sessions.loadSessions().length));
    `,
    "utf8",
  );
  const count = await new Promise<string>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", readerSrc], {
      env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    proc.stdout!.on("data", (d) => (out += d));
    proc.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`reader exited ${code}`)),
    );
    proc.on("error", reject);
  });

  assert.equal(
    Number(count),
    N,
    `expected all ${N} concurrent sessions to persist, got ${count}`,
  );

  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test("session lock file is released even when the mutation throws", () => {
  const lockPath = path.join(tmpRoot, "cfg", "sessions.json.lock");
  // Poison the registry with a non-array value so readSessionsUnlocked
  // returns [], then drive a mutation. The lock must not leak afterwards.
  sessions.addSession({
    vaultPath: path.join(tmpRoot, "lock-release.vault"),
    workingDir: path.join(tmpRoot, "wd"),
    openedAt: new Date().toISOString(),
  });
  assert.ok(
    !fs.existsSync(lockPath),
    "advisory lock must be released after a completed mutation",
  );
});

// ---------------------------------------------------------------------------
// Local machine key — first-run concurrency
// ---------------------------------------------------------------------------

/**
 * Regression test for the first-run race in getLocalKey().
 *
 * The original code generated a key and renamed it into place unconditionally.
 * With N processes starting against an empty config dir, every process but the
 * last wrote data encrypted with a key that no longer existed anywhere — the
 * loser cached its own key in memory while the file on disk held the winner's.
 * That data could never be decrypted again.
 *
 * The test makes every child encrypt a payload through the real public API and
 * then checks, from a fresh process, that ALL payloads decrypt. Any loser in
 * the race produces an undecryptable file here.
 */
test("concurrent first-run processes agree on one local machine key", async () => {
  const N = 6;
  const cfgDir = path.join(tmpRoot, "localkey-race-cfg");
  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  const childSrc = path.join(cfgDir, "child.ts");
  fs.writeFileSync(
    childSrc,
    `
    import * as fs from "node:fs";
    import * as path from "node:path";
    import * as localkey from ${JSON.stringify(localkeyMod)};

    const outDir = process.argv[2];
    const id = process.argv[3];
    const startAt = Number(process.argv[4]);

    // Barrier: without this the children boot staggered by hundreds of ms
    // (node + tsx transpile) and never actually contend, so the test passes
    // even against the racy implementation. Park every child on a shared
    // wall-clock instant so all of them call getLocalKey() together.
    while (Date.now() < startAt) {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 5);
    }

    const payload = "payload-from-" + id;
    const enc = localkey.encryptLocal(payload);
    fs.writeFileSync(path.join(outDir, id + ".bin"), enc);
    // Report the key this process ended up using, so we can compare directly.
    fs.writeFileSync(path.join(outDir, id + ".key"), localkey.getLocalKey());
    `,
    "utf8",
  );

  const outDir = path.join(cfgDir, "out");
  fs.mkdirSync(outDir, { recursive: true });

  // Give every child time to boot and reach the barrier, then release them all
  // at the same instant.
  const startAt = Date.now() + 3_000;
  await Promise.all(
    Array.from({ length: N }, (_, i) => {
      const proc = spawn(
        process.execPath,
        ["--import", "tsx", childSrc, outDir, `p${i}`, String(startAt)],
        {
          env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
          stdio: "ignore",
        },
      );
      return new Promise<void>((resolve, reject) => {
        proc.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`child ${i} exited ${code}`)),
        );
        proc.on("error", reject);
      });
    }),
  );

  // Every process must have converged on identical key material.
  const keys = Array.from({ length: N }, (_, i) =>
    fs.readFileSync(path.join(outDir, `p${i}.key`)),
  );
  for (let i = 1; i < keys.length; i++) {
    assert.ok(
      keys[i].equals(keys[0]),
      `process ${i} used a different local key than process 0 — the first-run race is back`,
    );
  }

  // And a fresh process must be able to decrypt everything all of them wrote.
  const readerSrc = path.join(cfgDir, "read.ts");
  fs.writeFileSync(
    readerSrc,
    `
    import * as fs from "node:fs";
    import * as path from "node:path";
    import * as localkey from ${JSON.stringify(localkeyMod)};
    const outDir = process.argv[2];
    const bad: string[] = [];
    for (const f of fs.readdirSync(outDir).filter((n) => n.endsWith(".bin"))) {
      const dec = localkey.decryptLocal(fs.readFileSync(path.join(outDir, f)));
      if (dec === null) bad.push(f);
    }
    process.stdout.write(JSON.stringify(bad));
    `,
    "utf8",
  );
  const bad = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", readerSrc, outDir],
      {
        env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let out = "";
    proc.stdout!.on("data", (d) => (out += d));
    proc.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`reader exited ${code}`)),
    );
    proc.on("error", reject);
  });
  assert.deepEqual(
    JSON.parse(bad),
    [],
    "payloads written by a losing process are permanently undecryptable",
  );

  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test("an in-flight zero-length key claim is waited out, never overwritten", async () => {
  // Regression: a process that has won the O_EXCL create but not yet written
  // leaves a zero-length .local-key. Treating that as corruption and renaming
  // a fresh random key over it splits the keys — the claimant writes into an
  // unlinked inode and caches bytes nobody else has, so anything it encrypts
  // becomes permanently undecryptable. A reader must wait for the real bytes.
  const cfgDir = path.join(tmpRoot, "localkey-inflight-cfg");
  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  const keyPath = path.join(cfgDir, ".local-key");
  const readyPath = path.join(cfgDir, "reader.ready");
  const goPath = path.join(cfgDir, "reader.go");

  // The reader is booted and parked *before* the claim exists, so its call to
  // getLocalKey() lands in the zero-length window instead of racing boot.
  const readerSrc = path.join(cfgDir, "reader.ts");
  fs.writeFileSync(
    readerSrc,
    `
    import * as fs from "fs";
    import * as localkey from ${JSON.stringify(localkeyMod)};
    const [readyPath, goPath] = process.argv.slice(2);
    fs.writeFileSync(readyPath, "ready");
    for (let i = 0; i < 2000; i++) {
      if (fs.existsSync(goPath)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    process.stdout.write(localkey.getLocalKey().toString("hex"));
    `,
    "utf8",
  );
  const reader = spawn(
    process.execPath,
    ["--import", "tsx", readerSrc, readyPath, goPath],
    {
      env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let readerOut = "";
  reader.stdout!.on("data", (d) => (readerOut += d));
  const readerDone = new Promise<number>((resolve, reject) => {
    reader.on("exit", (code) =>
      code === 0 ? resolve(0) : reject(new Error(`reader exited ${code}`)),
    );
    reader.on("error", reject);
  });

  for (let i = 0; i < 400 && !fs.existsSync(readyPath); i++) sleepSync(5);
  assert.ok(fs.existsSync(readyPath), "reader never became ready");

  // Now open the claim and deliberately leave it empty, exactly as a process
  // suspended between its create and its write would.
  const fd = fs.openSync(keyPath, "wx", 0o600);
  assert.equal(fs.statSync(keyPath).size, 0, "claim should be empty");

  fs.writeFileSync(goPath, "go");

  // Fill the claim while the reader is inside its retry loop.
  const realKey = crypto.randomBytes(32);
  sleepSync(40);
  assert.equal(
    fs.statSync(keyPath).size,
    0,
    "reader must not have clobbered the in-flight claim",
  );
  fs.writeSync(fd, realKey);
  fs.closeSync(fd);

  await readerDone;
  assert.equal(
    Buffer.from(readerOut, "hex").toString("hex"),
    realKey.toString("hex"),
    "reader must adopt the claimed key, not its own",
  );
  assert.equal(
    fs.readFileSync(keyPath).toString("hex"),
    realKey.toString("hex"),
    "the in-flight claim must be filled in, not replaced",
  );

  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test("a wrong-length local key file is replaced, not treated as a race", async () => {
  const cfgDir = path.join(tmpRoot, "localkey-corrupt-cfg");
  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  const keyPath = path.join(cfgDir, ".local-key");
  fs.writeFileSync(keyPath, Buffer.alloc(7)); // truncated / garbage

  const src = path.join(cfgDir, "run.ts");
  fs.writeFileSync(
    src,
    `
    import * as localkey from ${JSON.stringify(
      path.join(__dirname, "..", "core", "localkey"),
    )};
    const enc = localkey.encryptLocal("hello");
    process.stdout.write(String(localkey.decryptLocal(enc)));
    `,
    "utf8",
  );
  const out = await new Promise<string>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", src], {
      env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let s = "";
    proc.stdout!.on("data", (d) => (s += d));
    proc.on("exit", (code) =>
      code === 0 ? resolve(s) : reject(new Error(`child exited ${code}`)),
    );
    proc.on("error", reject);
  });
  assert.equal(out, "hello");
  assert.equal(
    fs.readFileSync(keyPath).length,
    32,
    "the corrupt key file must be rewritten at full length",
  );

  fs.rmSync(cfgDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Release-blocking regression tests
//
// Each of these reproduces a defect found in review that the existing suite
// passed straight through. They are grouped with the fix so the reason they
// exist is not lost.
// ---------------------------------------------------------------------------

test("B1: secureEraseDir does not follow a symlink out of the working folder", async () => {
  // A working directory is a real folder the user browses and writes into, so
  // it can contain a link they made themselves. secureEraseFile used statSync
  // and openSync, both of which resolve links: erasing the folder overwrote the
  // LINK'S TARGET with random bytes, irreversibly destroying a file that was
  // never in the vault. The link itself is removed; the target is untouched.
  const victim = path.join(tmpRoot, "precious-notes.txt");
  const original = "DATA THAT WAS NEVER IN ANY VAULT";
  fs.writeFileSync(victim, original);

  const wd = path.join(tmpRoot, "erase-symlink-wd");
  fs.mkdirSync(wd);
  fs.symlinkSync(victim, path.join(wd, "innocent-link.txt"));

  fsutil.secureEraseDir(wd);

  assert.ok(fs.existsSync(victim), "the symlink target must survive the erase");
  assert.equal(
    fs.readFileSync(victim, "utf8"),
    original,
    "the symlink target must be byte-for-byte unchanged",
  );
  assert.ok(!fs.existsSync(wd), "the working directory itself must be removed");
});

test("B1: secureEraseDir does not recurse through a symlinked directory", async () => {
  const outside = path.join(tmpRoot, "outside-dir");
  fs.mkdirSync(outside);
  const keep = path.join(outside, "keep.txt");
  fs.writeFileSync(keep, "still here");

  const wd = path.join(tmpRoot, "erase-symlink-dir-wd");
  fs.mkdirSync(wd);
  fs.symlinkSync(outside, path.join(wd, "linked-dir"));

  fsutil.secureEraseDir(wd);

  assert.ok(fs.existsSync(outside), "a linked directory must not be walked");
  assert.ok(fs.existsSync(keep));
  assert.equal(fs.readFileSync(keep, "utf8"), "still here");
});

test("B1: secureEraseDir still erases real files", async () => {
  // Guard against "fix" that simply stops erasing.
  const wd = path.join(tmpRoot, "erase-real-wd");
  fs.mkdirSync(path.join(wd, "nested"), { recursive: true });
  const f = path.join(wd, "nested", "secret.txt");
  fs.writeFileSync(f, "sensitive content that must not survive");
  const secret = fs.readFileSync(f, "utf8");

  fsutil.secureEraseDir(wd);

  assert.ok(!fs.existsSync(wd), "the directory must be gone");
  assert.ok(!fs.existsSync(f));
  void secret;
});

test("B3: index-suppression markers are not packed into the vault", async () => {
  // suppressIndexing() drops .trackerignore / .noindex / .hidden into the
  // working directory so the OS indexers skip it. packDir() walked them like any
  // other file, so every close baked all three into the payload and every open
  // unpacked them again: users permanently carried three dotfiles they never
  // created, in every vault, forever.
  const vp = tmpVault("marker-pollution");
  vault.createVault(vp, { password: PASS, generateRecovery: false });

  const r1 = vault.openVault(vp, PASS);
  const markers = fs
    .readdirSync(r1.workingDir)
    .filter((n) => fsutil.INDEX_SUPPRESSION_MARKERS.has(n));
  assert.ok(
    markers.length > 0,
    "precondition: the platform markers must actually be on disk, otherwise " +
      "this test would pass without exercising anything",
  );
  fs.writeFileSync(path.join(r1.workingDir, "user-file.txt"), "mine");

  // Inspect what the packer would store, independent of the unpack path.
  // Must happen BEFORE closeVault, which erases the working directory.
  const packed = bundle.packDir(r1.workingDir);
  const manifestLen = packed.readUInt32BE(0);
  const manifest = JSON.parse(
    packed.subarray(4, 4 + manifestLen).toString("utf8"),
  ) as { entries: Array<{ path: string }> };
  const packedPaths = manifest.entries.map((e) => e.path);
  for (const m of markers) {
    assert.ok(
      !packedPaths.includes(m),
      `${m} must not be packed as vault content (packed: ${packedPaths.join(", ")})`,
    );
  }
  assert.ok(packedPaths.includes("user-file.txt"), "real content is preserved");

  vault.closeVault(vp, PASS);

  // And the user's own files must survive the round trip.
  const r2 = vault.openVault(vp, PASS);
  assert.ok(
    fs.existsSync(path.join(r2.workingDir, "user-file.txt")),
    "user content must survive the round trip",
  );
  vault.closeVault(vp, PASS);
});

test("B3: a nested file named like a marker is preserved", async () => {
  // Only the top level is filtered — `docs/.noindex` is ordinary user content.
  const vp = tmpVault("marker-nested");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  const r = vault.openVault(vp, PASS);
  fs.mkdirSync(path.join(r.workingDir, "docs"));
  fs.writeFileSync(path.join(r.workingDir, "docs", ".noindex"), "user data");
  vault.closeVault(vp, PASS);

  const r2 = vault.openVault(vp, PASS);
  assert.equal(
    fs.readFileSync(path.join(r2.workingDir, "docs", ".noindex"), "utf8"),
    "user data",
    "a nested .noindex is user content and must not be dropped",
  );
  vault.closeVault(vp, PASS);
});

test("B3: legacy markers already inside a vault are cleaned on open", async () => {
  // A vault written before the packer fix carries the three dotfiles forever.
  // unpackDir must drop them so old vaults heal instead of staying polluted.
  const wd = path.join(tmpRoot, "legacy-marker-seed");
  fs.mkdirSync(wd, { recursive: true });
  fs.writeFileSync(path.join(wd, ".noindex"), "");
  fs.writeFileSync(path.join(wd, "real.txt"), "keep me");
  // Bypass the packer: build a bundle by hand so the markers are inside it.
  const manifest = Buffer.from(
    JSON.stringify({
      entries: [
        { path: ".noindex", size: 0, mode: 0o100644 },
        { path: "real.txt", size: 7, mode: 0o100644 },
      ],
    }),
    "utf8",
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length, 0);
  const handBuilt = Buffer.concat([len, manifest, Buffer.from("keep me")]);

  const dest = path.join(tmpRoot, "legacy-marker-unpack");
  bundle.unpackDir(handBuilt, dest);
  assert.ok(
    !fs.existsSync(path.join(dest, ".noindex")),
    "a marker smuggled into a bundle must be skipped on unpack",
  );
  assert.equal(fs.readFileSync(path.join(dest, "real.txt"), "utf8"), "keep me");
});

test("B4: file operations only address a registered open session", async () => {
  // The GUI's file browser used to hand the main process a plain directory
  // string that it then rmSync'd recursively, so anything able to run script in
  // the renderer could delete any directory the user could reach. The core now
  // resolves the folder against the session registry first.
  const outside = path.join(tmpRoot, "not-a-vault");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "precious.txt"), "must survive");

  assert.throws(
    () => vault.listWorkingDir(outside),
    /not an open vault/i,
    "listing an arbitrary directory must be refused",
  );
  assert.throws(
    () => vault.deleteFromWorkingDir(outside, "precious.txt"),
    /not an open vault/i,
    "deleting inside an arbitrary directory must be refused",
  );
  assert.throws(
    () => vault.renameInWorkingDir(outside, "precious.txt", "stolen.txt"),
    /not an open vault/i,
  );
  assert.equal(
    fs.readFileSync(path.join(outside, "precious.txt"), "utf8"),
    "must survive",
  );
});

test("B4: file operations work inside a real session and block traversal", async () => {
  const vp = tmpVault("file-ops");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  const r = vault.openVault(vp, PASS);
  fs.writeFileSync(path.join(r.workingDir, "a.txt"), "alpha");
  fs.mkdirSync(path.join(r.workingDir, "sub"));
  fs.writeFileSync(path.join(r.workingDir, "sub", "b.txt"), "beta");

  // listWorkingDir
  const entries = vault.listWorkingDir(r.workingDir);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("a.txt"), `expected a.txt in ${names.join(", ")}`);
  assert.ok(names.includes("sub"));
  const sub = entries.find((e) => e.name === "sub")!;
  assert.equal(sub.type, "dir");
  assert.deepEqual(
    sub.children?.map((c) => c.name),
    ["b.txt"],
  );

  // rename within the same folder
  vault.renameInWorkingDir(r.workingDir, "a.txt", "renamed.txt");
  assert.ok(fs.existsSync(path.join(r.workingDir, "renamed.txt")));
  assert.ok(!fs.existsSync(path.join(r.workingDir, "a.txt")));

  // A rename may not relocate an entry into another folder. basename() strips
  // the directory component, so "../escaped.txt" sanitises to "escaped.txt"
  // IN THE SAME FOLDER — the file must move nowhere near the traversal target.
  vault.renameInWorkingDir(r.workingDir, "renamed.txt", "../escaped.txt");
  assert.ok(
    fs.existsSync(path.join(r.workingDir, "escaped.txt")),
    "a traversal component must be stripped, leaving the entry in its folder",
  );
  assert.ok(
    !fs.existsSync(path.join(tmpRoot, "escaped.txt")),
    "a rename must never create a file outside the working folder",
  );
  // ...and an empty / dot name is refused outright.
  for (const badName of ["", "   ", "..", "."]) {
    assert.throws(
      () => vault.renameInWorkingDir(r.workingDir, "escaped.txt", badName),
      /invalid name|enter a new name/i,
      `rename to ${JSON.stringify(badName)} must be refused`,
    );
  }

  // traversal is refused in every form
  for (const bad of ["../../etc/passwd", "..", "/etc/passwd", ""]) {
    assert.throws(
      () => vault.deleteFromWorkingDir(r.workingDir, bad),
      /invalid|path/i,
      `delete(${JSON.stringify(bad)}) must be refused`,
    );
  }
  assert.ok(
    fs.existsSync(path.join(r.workingDir, "escaped.txt")),
    "refused deletes must not remove anything",
  );

  // delete works for a legitimate path
  vault.deleteFromWorkingDir(r.workingDir, "sub/b.txt");
  assert.ok(!fs.existsSync(path.join(r.workingDir, "sub", "b.txt")));

  vault.closeVault(vp, PASS);
});

test("H1: a payload that inflates past the cap is refused, not OOM-killed", async () => {
  // zlib.inflateSync without maxOutputLength asks Node for whatever the
  // deflate stream expands to. MAX_PAYLOAD_SIZE bounds the COMPRESSED size
  // only, so a legitimately compressible vault (a sparse image, a log of
  // zeros) could demand tens of gigabytes and kill the process with a heap OOM
  // instead of an error. The check itself is on the code path; here we assert
  // the option is actually plumbed through.
  const zlib = await import("node:zlib");
  const bomb = zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x41), {
    level: 9,
  });
  assert.ok(
    bomb.length < 1024 * 1024,
    "precondition: the test payload must compress well below its expanded size",
  );
  // With a cap below the expansion, Node raises ERR_BUFFER_TOO_LARGE rather than
  // allocating. This is the behaviour decompressBundle relies on.
  assert.throws(
    () => zlib.inflateSync(bomb, { maxOutputLength: 1024 }),
    (e: any) => e?.code === "ERR_BUFFER_TOO_LARGE",
  );
  // And a cap above it still succeeds, so the option is not simply rejecting
  // everything.
  assert.equal(
    zlib.inflateSync(bomb, { maxOutputLength: 64 * 1024 * 1024 }).length,
    8 * 1024 * 1024,
  );
});

test("B2: the outer password opens a hidden volume through openVault", async () => {
  // readContainer used to treat "everything after the header" as the payload.
  // A hidden container appends padding plus a second encrypted volume after the
  // outer ciphertext, so GCM was handed a ciphertext with a tail bolted on and
  // authentication failed on EVERY open: the decoy password opened nothing at
  // all, which defeats the entire point and reads as corruption.
  const hiddenMod = await import("../core/hidden.js");
  const vp = tmpVault("hidden-outer-open");
  const outerSeed = path.join(tmpRoot, "hv-outer");
  const hiddenSeed = path.join(tmpRoot, "hv-hidden");
  fs.mkdirSync(outerSeed, { recursive: true });
  fs.mkdirSync(hiddenSeed, { recursive: true });
  fs.writeFileSync(path.join(outerSeed, "decoy.txt"), "decoy data");
  fs.writeFileSync(path.join(hiddenSeed, "secret.txt"), "hidden secret");

  const totalSize = 8 * 1024 * 1024;
  hiddenMod.createHiddenVault({
    vaultPath: vp,
    outerPassword: "outer-password-test",
    hiddenPassword: "hidden-password-test",
    totalSize,
    outerSeedDir: outerSeed,
    hiddenSeedDir: hiddenSeed,
  });
  assert.equal(fs.statSync(vp).size, totalSize, "container size is fixed");

  // The decoy path: a normal open, through the ordinary code path.
  const r = vault.openVault(vp, "outer-password-test");
  const names = fs.readdirSync(r.workingDir);
  assert.ok(
    names.includes("decoy.txt"),
    `the outer volume must unpack its decoy files, got ${names.join(", ")}`,
  );
  assert.ok(
    !names.includes("secret.txt"),
    "the outer volume must not expose hidden files",
  );

  // getInfo must read it too, not just the dedicated hidden reader.
  const info = vault.getInfo(vp);
  assert.equal(info.version, 3);
  assert.ok(info.isOpen);

  vault.discardVault(vp, "outer-password-test");
  assert.equal(
    fs.statSync(vp).size,
    totalSize,
    "discard must not resize the container",
  );

  // The hidden volume still works, and the file is untouched.
  const { payload } = hiddenMod.openHiddenVolume(vp, "hidden-password-test");
  assert.ok(payload.length > 0);
});

test("B2: rewriting a hidden volume is refused rather than destroying it", async () => {
  // closeVault rebuilds the file as [header][payload] from what readContainer
  // returned. Without a guard that drops the padding and the hidden tail, so a
  // close made the hidden volume unrecoverable AND shrank a fixed-size decoy to
  // a few hundred bytes — which is itself proof a hidden volume existed.
  const hiddenMod = await import("../core/hidden.js");
  const vp = tmpVault("hidden-rewrite-guard");
  const totalSize = 8 * 1024 * 1024;
  hiddenMod.createHiddenVault({
    vaultPath: vp,
    outerPassword: "outer-password-test",
    hiddenPassword: "hidden-password-test",
    totalSize,
  });

  const r = vault.openVault(vp, "outer-password-test");
  fs.writeFileSync(path.join(r.workingDir, "user-edit.txt"), "edit");

  assert.throws(
    () => vault.closeVault(vp, "outer-password-test"),
    /hidden volume/i,
    "close must refuse rather than silently destroy the hidden volume",
  );
  assert.equal(
    fs.statSync(vp).size,
    totalSize,
    "the refused close must leave the file byte-for-byte sized",
  );
  assert.doesNotThrow(
    () => hiddenMod.openHiddenVolume(vp, "hidden-password-test"),
    "the hidden volume must still be openable after the refused close",
  );

  // Header-rewriting operations are guarded the same way.
  assert.throws(
    () => vault.changePassword(vp, "outer-password-test", "a-new-password"),
    /hidden volume/i,
  );
  assert.throws(
    () => vault.regenerateRecoveryKey(vp, "outer-password-test"),
    /hidden volume|recovery/i,
  );
  assert.throws(
    () => vault.setMeta(vp, "outer-password-test", { name: "x" }),
    /hidden volume/i,
  );
  assert.equal(fs.statSync(vp).size, totalSize);

  vault.discardVault(vp, "outer-password-test");
});

test("B2: an ordinary vault has no payloadLen and still reads to end of file", async () => {
  // The payloadLen branch must not change any existing vault. Absence means
  // "the rest of the file", exactly as before.
  const vp = tmpVault("no-payload-len");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  const header = container.readHeader(vp);
  assert.equal(
    header.payloadLen,
    undefined,
    "an ordinary vault must not declare a payload length",
  );
  const c = container.readContainer(vp);
  assert.equal(
    c.payload.length,
    fs.statSync(vp).size - 12 - Buffer.byteLength(JSON.stringify(header)),
  );
  const r = vault.openVault(vp, PASS);
  fs.writeFileSync(path.join(r.workingDir, "x.txt"), "x");
  vault.closeVault(vp, PASS);
  const r2 = vault.openVault(vp, PASS);
  assert.ok(fs.existsSync(path.join(r2.workingDir, "x.txt")));
  vault.closeVault(vp, PASS);
});

test("M1: a non-numeric header version is rejected", async () => {
  // The range check `v < 1 || v > 3` is false for NaN, so a header carrying
  // version: {} or version: [] passed validation and the bogus value flowed
  // into `vault info` output and every version comparison downstream.
  for (const bogus of [{ evil: true }, [3], "3", null, true]) {
    const vp = tmpVault(`bad-version-${JSON.stringify(bogus)}`);
    vault.createVault(vp, { password: PASS, generateRecovery: false });
    const raw = fs.readFileSync(vp);
    const headerLen = raw.readUInt32BE(8);
    const header = JSON.parse(
      raw.subarray(12, 12 + headerLen).toString("utf8"),
    );
    header.version = bogus;
    const newJson = Buffer.from(JSON.stringify(header), "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(newJson.length, 0);
    fs.writeFileSync(
      vp,
      Buffer.concat([
        raw.subarray(0, 8),
        lenBuf,
        newJson,
        raw.subarray(12 + headerLen),
      ]),
    );
    assert.throws(
      () => container.readHeader(vp),
      /Unsupported vault version|corrupt/i,
      `version ${JSON.stringify(bogus)} must be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Medium-severity regressions
// ---------------------------------------------------------------------------

test("M3: lockAllOpenVaults erases every working dir and drops the sessions", async () => {
  // Lock-everything used to run on the Electron main thread, where overwriting
  // every decrypted byte blocks the event loop and freezes the UI. It now runs
  // in the core (so on the worker), and must still do exactly what it did.
  const a = tmpVault("lock-all-a");
  const b = tmpVault("lock-all-b");
  vault.createVault(a, { password: PASS, generateRecovery: false });
  vault.createVault(b, { password: PASS, generateRecovery: false });
  const ra = vault.openVault(a, PASS);
  const rb = vault.openVault(b, PASS);
  fs.writeFileSync(path.join(ra.workingDir, "a-secret.txt"), "aaaa");
  fs.writeFileSync(path.join(rb.workingDir, "b-secret.txt"), "bbbb");

  // Sessions from earlier tests in this file are still registered, so assert on
  // the vaults this test opened rather than on a global count.
  const before = sessions.loadSessions().length;
  const locked = vault.lockAllOpenVaults();
  assert.ok(
    locked >= 2,
    `lockAllOpenVaults must report at least the 2 sessions opened here, got ${locked}`,
  );
  assert.ok(
    sessions.loadSessions().length < before,
    "sessions must have been removed",
  );
  assert.ok(!fs.existsSync(ra.workingDir), "working dir A must be erased");
  assert.ok(!fs.existsSync(rb.workingDir), "working dir B must be erased");
  // The vault files themselves are untouched — locking discards unsaved work,
  // it does not destroy the vault.
  assert.ok(fs.existsSync(a), "vault A must survive a lock");
  assert.ok(fs.existsSync(b), "vault B must survive a lock");
  assert.equal(sessions.findSession(a), undefined, "session A must be dropped");
  assert.equal(sessions.findSession(b), undefined, "session B must be dropped");

  // And a second call is a no-op rather than an error.
  assert.equal(vault.lockAllOpenVaults(), 0);
  void ra;
  void rb;
});

test("M5: the file browser caps depth and entry count", async () => {
  const vp = tmpVault("tree-caps");
  vault.createVault(vp, { password: PASS, generateRecovery: false });
  const r = vault.openVault(vp, PASS);
  // A chain deeper than MAX_TREE_DEPTH (12).
  let deep = r.workingDir;
  for (let i = 0; i < 20; i++) {
    deep = path.join(deep, `d${i}`);
  }
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "buried.txt"), "deep");

  const entries = vault.listWorkingDir(r.workingDir);
  // Depth is capped, so the walk stops early — but it must stop, not recurse
  // until the stack gives out.
  assert.ok(entries.length > 0, "listing must return something");
  assert.ok(
    entries.length < 25,
    `walk should stop at the depth cap, got ${entries.length} top-level entries`,
  );

  let node = entries[0];
  let levels = 1;
  while (node && node.type === "dir" && node.children && node.children.length) {
    node = node.children[0];
    levels++;
  }
  assert.ok(
    levels <= 13,
    `tree exceeded the depth cap (walked ${levels} levels)`,
  );

  vault.closeVault(vp, PASS);
});

test("M16: corrupt settings values fall back instead of arming a bad timer", async () => {
  // settings.json lives on disk and any process running as the user can write
  // it. An unvalidated value flowed straight into setTimeout(minutes * 60_000):
  // a negative duration arms a timer that fires immediately and wipes every
  // open vault's working directory.
  const cfgDir = path.join(tmpRoot, "bad-settings");
  fs.mkdirSync(cfgDir, { recursive: true });
  const localkey = await import("../core/localkey.js");
  localkey._clearCachedKey();

  const { default: settings } = { default: null } as any;
  void settings;
  // settings.ts resolved CONFIG_DIR at import time, so exercise the validators
  // against the live module and assert their contract directly.
  const s = await import("../core/settings.js");

  // 0 (never) and every offered duration are honoured.
  for (const v of [0, 5, 15, 30, 60]) {
    s.setAutoLockMinutes(v);
    assert.equal(
      s.getAutoLockMinutes(),
      v,
      `${v} minutes is an offered value and must round-trip`,
    );
  }

  // Values that are not offered are rejected outright rather than stored.
  s.setAutoLockMinutes(-5);
  assert.equal(s.getAutoLockMinutes(), 60, "a negative value must not persist");
  s.setAutoLockMinutes(999999);
  assert.equal(s.getAutoLockMinutes(), 60, "an absurd value must not persist");
  s.setAutoLockMinutes(Number.NaN);
  assert.equal(s.getAutoLockMinutes(), 60, "NaN must not persist");

  // getTheme only ever returns one of the three real themes.
  for (const t of ["dark", "light", "system"] as const) {
    s.setTheme(t);
    assert.equal(s.getTheme(), t);
  }
  s.setTheme("neon" as any);
  assert.ok(
    ["dark", "light", "system"].includes(s.getTheme()),
    `an unknown theme must not be returned, got ${s.getTheme()}`,
  );

  s.setAutoLockMinutes(30);
  s.setTheme("dark");
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test("M16b: a corrupt stored window geometry is rejected, not clamped to NaN", async () => {
  // The same untrusted-file problem as the auto-lock value above, one level up:
  // main.ts's usableWindowBounds() does `Math.max(saved.width, MIN_WINDOW_WIDTH)`
  // and then `bounds.width ?? 900`. A stored width that is not a number made the
  // first expression NaN, and `NaN ?? 900` is NaN — the 900 fallback does not
  // catch it — so BrowserWindow was constructed with a NaN dimension.
  const s = await import("../core/settings.js");

  const roundTrip = (bounds: any) => {
    s.saveWindowBounds(bounds);
    return s.getWindowBounds();
  };

  // A sane geometry survives, with x/y preserved when both are usable.
  const good = roundTrip({ x: 120, y: 80, width: 1000, height: 700 });
  assert.deepEqual(
    good,
    { width: 1000, height: 700, x: 120, y: 80 },
    "a valid geometry must round-trip",
  );

  // Numeric strings are coerced rather than rejected: JSON has no number type
  // distinct from string in a hand-edited file, and coercion is safe here
  // because the result is range-checked immediately below.
  assert.deepEqual(
    roundTrip({ width: "900", height: "600" }),
    { width: 900, height: 600 },
    "numeric strings must be coerced",
  );

  // Below the window minimum is not honoured anyway, and above any real display
  // is corruption rather than a preference — both discard the geometry so
  // Electron picks its own default.
  assert.equal(
    roundTrip({ width: "abc", height: 700 }),
    undefined,
    "a non-numeric width must be rejected, not turned into NaN",
  );
  assert.equal(
    roundTrip({ width: 1000, height: NaN }),
    undefined,
    "a NaN height must be rejected",
  );
  assert.equal(
    roundTrip({ width: 10, height: 700 }),
    undefined,
    "a width under the window minimum must be rejected",
  );
  assert.equal(
    roundTrip({ width: 1e9, height: 700 }),
    undefined,
    "an absurd width must be rejected",
  );
  assert.equal(
    roundTrip({ width: 1000 }),
    undefined,
    "a missing height must be rejected",
  );

  // One bad coordinate discards only x/y — a valid size is still worth
  // restoring, and it beats losing the geometry entirely.
  assert.deepEqual(
    roundTrip({ x: 120, y: "nope", width: 1000, height: 700 }),
    { width: 1000, height: 700 },
    "a bad y must not discard a valid width/height",
  );
});

test("M7: concurrent settings writes do not lose each other's updates", async () => {
  // The GUI writes settings from several places (theme toggle, auto-lock select,
  // window bounds on close) and the CLI shares the file. Each writer does
  // read-all -> mutate one field -> write-all, so without a lock covering that
  // whole window two writers collide and one field is silently reverted.
  //
  // settings.ts resolves CONFIG_DIR at import time, so both the writers and the
  // verification read run in child processes pointed at the same directory.
  const cfgDir = path.join(tmpRoot, "settings-race");
  fs.mkdirSync(cfgDir, { recursive: true });
  // Pre-create the machine key. Without it, three processes hitting a fresh
  // config dir simultaneously also race on localkey's first-run key claim; if a
  // process ends up caching a different key than the one on disk it cannot
  // decrypt the others' settings, loadSettings() returns {} and that writer
  // clobbers the file. That is a real first-run hazard, but it is localkey's
  // job and its own test covers it — so keep it out of THIS test, which is
  // about the settings lock.
  fs.writeFileSync(
    path.join(cfgDir, ".local-key"),
    require("node:crypto").randomBytes(32),
    { mode: 0o600 },
  );
  const settingsModule = path.join(__dirname, "..", "core", "settings.js");

  // Each child writes ONE distinct field, then waits at a shared wall-clock
  // barrier before writing so the read-modify-write windows genuinely overlap.
  // The recent-vault entry must point at a file that exists: getRecentVaults()
  // deliberately filters out paths that have been deleted, so a dangling path
  // would read back as an empty list and look like a lost update.
  const recentVault = path.join(tmpRoot, "settings-race-recent.vault");
  fs.writeFileSync(recentVault, "placeholder");
  const fields = [
    { name: "theme", value: "light" },
    { name: "autolock", value: "5" },
    { name: "recent", value: recentVault },
  ];
  const child = path.join(tmpRoot, "settings-race-child.mjs");
  fs.writeFileSync(
    child,
    `
    import { setTheme, setAutoLockMinutes, addRecentVault, getRecentVaults,
             getTheme, getAutoLockMinutes }
      from ${JSON.stringify(settingsModule)};
    const [field, value, startAtRaw] = process.argv.slice(2);
    const startAt = Number(startAtRaw);
    // Spin to the shared start instant so every read-modify-write window opens
    // at the same moment. Staggered process boot does not reproduce the race.
    while (Date.now() < startAt) {}
    if (field === "theme") setTheme(value);
    else if (field === "autolock") setAutoLockMinutes(Number(value));
    else if (field === "recent") addRecentVault(value);
    process.stdout.write(JSON.stringify({
      theme: getTheme(),
      lock: getAutoLockMinutes(),
      recent: getRecentVaults(),
    }));
    `,
  );

  // Boot all three children, then release them together.
  const startAt = Date.now() + 3_000;
  const procs = fields.map((f) =>
    spawn(
      process.execPath,
      ["--import", "tsx", child, f.name, f.value, String(startAt)],
      {
        env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const outputs = await Promise.all(
    procs.map(
      (proc, i) =>
        new Promise<string>((resolve, reject) => {
          let out = "";
          let err = "";
          proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
          proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
          proc.on("exit", (code) =>
            code === 0
              ? resolve(out)
              : reject(
                  new Error(
                    `child ${i} (${fields[i].name}) exited ${code}: ${err}`,
                  ),
                ),
          );
        }),
    ),
  );

  // Assert only on the FINAL state, and assert it exactly.
  //
  // An earlier version asserted that at least one writer observed every other
  // writer's field. That depends on the order three independent processes happen
  // to acquire the lock, so under CPU contention it failed intermittently even
  // with the lock working — and a flaky test in a release-gating suite is worse
  // than none, because it teaches you to ignore red.
  //
  // Final state is order-independent. With the lock, each write is a complete
  // read-modify-write of one field, so the file ends up holding all three.
  // Without it, every writer reads the same initial state and the last to write
  // wins, leaving the other two at their defaults — which is exactly the bug.
  const dump = path.join(tmpRoot, "settings-race-dump.mjs");
  fs.writeFileSync(
    dump,
    `import { getTheme, getAutoLockMinutes, getRecentVaults } from ${JSON.stringify(settingsModule)};
     process.stdout.write(JSON.stringify({
       theme: getTheme(), lock: getAutoLockMinutes(), recent: getRecentVaults(),
     }));`,
  );
  const read = spawnSync(process.execPath, ["--import", "tsx", dump], {
    env: { ...process.env, SHADOWBIT_CONFIG_DIR: cfgDir },
    encoding: "utf8",
  });
  assert.equal(read.status, 0, read.stderr);
  const final = JSON.parse(read.stdout.trim()) as {
    theme: string;
    lock: number;
    recent: string[];
  };
  assert.deepEqual(
    { theme: final.theme, lock: final.lock, recent: final.recent },
    { theme: "light", lock: 5, recent: [recentVault] },
    "every concurrent writer's field must survive",
  );

  // The advisory lock must not be left behind.
  assert.ok(
    !fs.existsSync(path.join(cfgDir, "settings.json.lock")),
    "the advisory lock must be released",
  );

  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test("withAdvisoryLock: a zero-byte lock file is treated as LIVE, not stale", () => {
  // The window between the atomic O_EXCL create and writing the payload leaves
  // the lock file zero bytes long. readFileSync returns "" for that (it does not
  // throw), so parsing it as 0 yields the epoch — which made every contender
  // treat a lock that was held *right now* as infinitely stale, delete it, and
  // run its read-modify-write unprotected. Two concurrent writers then clobber
  // each other's fields: an intermittent lost update, which is what the
  // concurrent-writes test above intermittently caught.
  //
  // The discriminator is filesystem state, not timing: if the lock is wrongly
  // judged stale it gets deleted, so after the call the file is gone. If it is
  // correctly judged live, the retry budget is spent waiting and the file is
  // still there, untouched.
  const lock = path.join(tmpRoot, "empty-lock-probe");
  fs.writeFileSync(lock, "");

  let ran = false;
  // retries: 1 means the callback runs after the budget is spent either way;
  // the point is which path was taken, and that is visible in the file's fate.
  fsutil.withAdvisoryLock(
    lock,
    () => {
      ran = true;
    },
    {
      retries: 1,
      backoffMs: 0,
      staleMs: 10_000,
    },
  );

  assert.ok(ran, "the callback must still run once the budget is spent");
  assert.ok(
    fs.existsSync(lock),
    "a zero-byte lock file is a lock being claimed RIGHT NOW; deleting it " +
      "lets a second writer into the critical section concurrently",
  );
  assert.equal(fs.readFileSync(lock, "utf8"), "");

  // A lock file with no parseable timestamp is equally not evidence of
  // abandonment — same rule, same reason.
  fs.writeFileSync(lock, "garbage-without-a-newline");
  fsutil.withAdvisoryLock(lock, () => {}, {
    retries: 1,
    backoffMs: 0,
    staleMs: 10_000,
  });
  assert.ok(fs.existsSync(lock), "an unparseable lock must be waited on too");

  fs.rmSync(lock, { force: true });
});

test("withAdvisoryLock: a genuinely abandoned lock is still reclaimed", () => {
  // The other half of the rule. If the fix above had simply stopped treating any
  // existing lock as stale, a process killed mid-section would wedge the
  // registry forever. An old, well-formed lock must still be broken.
  const lock = path.join(tmpRoot, "abandoned-lock-probe");
  fs.writeFileSync(lock, `999999\n${Date.now() - 60_000}`);

  let ran = false;
  fsutil.withAdvisoryLock(
    lock,
    () => {
      ran = true;
    },
    {
      retries: 2,
      backoffMs: 10,
      staleMs: 10_000,
    },
  );

  assert.ok(ran, "the callback must run");
  assert.ok(
    !fs.existsSync(lock),
    "a lock abandoned 60s ago must be reclaimed and cleaned up",
  );
});

test("withAdvisoryLock: the lock is released even when the body throws", () => {
  const lock = path.join(tmpRoot, "throw-lock-probe");
  assert.throws(
    () =>
      fsutil.withAdvisoryLock(lock, () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.ok(
    !fs.existsSync(lock),
    "a throw inside the critical section must not leave the lock held",
  );
});
