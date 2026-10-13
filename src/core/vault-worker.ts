// Worker thread entry point — executes all crypto-intensive vault operations
// off the Electron main thread, so the UI never freezes during scrypt, AES,
// or large file I/O.
//
// Message protocol (both directions):
//   request:  { id: number; op: string; args: Record<string, unknown> }
//   response: { id: number; ok: true; value: unknown }
//           | { id: number; ok: false; error: string }

import { parentPort } from "worker_threads";
import * as fs from "fs";
import * as path from "path";
import * as vault from "./vault";
import { loadSessions } from "./sessions";
import { MAX_CONTAINER_SIZE } from "./container";

if (!parentPort) {
  throw new Error("vault-worker must be run as a worker_thread, not directly.");
}

parentPort.on("message", (msg: { id: number; op: string; args: any }) => {
  let result: unknown;
  try {
    switch (msg.op) {
      case "create":
        result = vault.createVault(msg.args.vaultPath, msg.args.opts);
        break;
      case "open":
        result = vault.openVault(
          msg.args.vaultPath,
          msg.args.password,
          msg.args.keyfiles,
        );
        break;
      case "close":
        vault.closeVault(
          msg.args.vaultPath,
          msg.args.password,
          msg.args.keyfiles,
        );
        result = null;
        break;
      case "discard":
        vault.discardVault(
          msg.args.vaultPath,
          msg.args.password,
          msg.args.keyfiles,
        );
        result = null;
        break;
      case "changePassword":
        vault.changePassword(
          msg.args.vaultPath,
          msg.args.oldPassword,
          msg.args.newPassword,
          {
            keyfiles: msg.args.keyfiles,
            newKeyfiles: msg.args.newKeyfiles,
          },
        );
        result = null;
        break;
      case "recover":
        vault.recoverVault(
          msg.args.vaultPath,
          msg.args.recoveryKey,
          msg.args.newPassword,
        );
        result = null;
        break;
      case "regenRecovery":
        result = vault.regenerateRecoveryKey(
          msg.args.vaultPath,
          msg.args.password,
          msg.args.keyfiles,
        );
        break;
      case "removeRecovery":
        vault.removeRecoveryKey(
          msg.args.vaultPath,
          msg.args.password,
          msg.args.keyfiles,
        );
        result = null;
        break;
      case "delete":
        vault.deleteVault(
          msg.args.vaultPath,
          msg.args.password,
          msg.args.opts ?? {},
        );
        result = null;
        break;
      case "addFiles":
        result = vault.addToSession(msg.args.vaultPath, msg.args.paths);
        break;
      // In-app file browser. These touch decrypted content, so they live here
      // rather than on the main thread — both to keep that thread free and to
      // put resolveOpenWorkingDir()'s session-registry check on the same side
      // of the boundary as every other vault operation.
      case "listFiles":
        result = vault.listWorkingDir(msg.args.workingDir);
        break;
      case "deleteFile":
        vault.deleteFromWorkingDir(msg.args.workingDir, msg.args.relPath);
        result = null;
        break;
      case "renameFile":
        vault.renameInWorkingDir(
          msg.args.workingDir,
          msg.args.oldRel,
          msg.args.newName,
        );
        result = null;
        break;
      case "preflight": {
        // Stat-only size check, so the GUI can warn before attempting an open
        // that would need the whole payload in memory. Does not read the file.
        const abs = path.resolve(msg.args.vaultPath);
        const bytes = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
        result = { bytes, maxBytes: MAX_CONTAINER_SIZE };
        break;
      }
      case "info":
        result = vault.getInfo(msg.args.vaultPath);
        break;
      case "sessions":
        result = loadSessions();
        break;
      // Lock-everything. Securely erasing working directories means overwriting
      // every decrypted byte on disk, which must not happen on the main thread.
      case "lockAll":
        result = vault.lockAllOpenVaults();
        break;
      case "setMeta":
        // Returns the result (rather than null) so the renderer can tell the
        // user when the metadata they just set is plaintext in a paranoid
        // header.
        result = vault.setMeta(
          msg.args.vaultPath,
          msg.args.password,
          msg.args.meta,
          msg.args.keyfiles,
        );
        break;
      default:
        throw new Error(`Unknown worker op: ${msg.op}`);
    }
    parentPort!.postMessage({ id: msg.id, ok: true, value: result });
  } catch (e: any) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: e.message ?? String(e),
    });
  }
});
