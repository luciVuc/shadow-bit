// Bridge that runs vault operations in a worker_thread so the Electron
// main process stays responsive during scrypt / AES / large file I/O.
//
// There is deliberately NO synchronous fallback: if the worker cannot be
// spawned, every operation fails loudly. A silent in-process fallback would
// put key material back on the main thread — exactly where it must not be —
// while still reporting success to the user.

import { Worker } from "worker_threads";
import * as path from "path";
import * as fs from "fs";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function getWorkerPath(): string {
  // In the built app, the compiled worker lives next to this file.
  const candidates = [
    path.join(__dirname, "..", "core", "vault-worker.js"),
    path.join(__dirname, "vault-worker.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("vault-worker.js not found in dist/");
}

function getWorker(): Worker {
  if (worker) return worker;

  const w = new Worker(getWorkerPath());
  w.on(
    "message",
    (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) {
        p.resolve(msg.value);
      } else {
        p.reject(new Error(msg.error ?? "Worker error"));
      }
    },
  );
  w.on("error", (err) => {
    // Reject all pending calls and reset so the next call spawns a fresh worker.
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  });
  w.on("exit", () => {
    worker = null;
  });
  worker = w;
  return w;
}

/** Dispatch an operation to the vault worker thread. */
export function callWorker(
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, op, args });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

/** Terminate the worker cleanly (call on app quit). */
export function terminateWorker(): void {
  if (worker) {
    worker.terminate().catch(() => {});
    worker = null;
  }
}
