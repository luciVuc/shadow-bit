/**
 * Filesystem watcher for an open vault's working directory.
 *
 * The in-app file browser used to be a one-shot snapshot: anything that changed
 * the working folder after the panel was drawn — "Add Files", drag-and-drop, or
 * edits in the OS file manager — was invisible until the user closed and
 * reopened the panel. This module watches the resolved working folder and, on
 * any change, invokes a callback so the main process can push a
 * `files:changed` event to the renderer.
 *
 * PORTABILITY: `fs.watch` is recursive natively on macOS and Windows but not
 * on Linux — changes inside a subdirectory are only reported by a watcher
 * placed on that subdirectory. Rather than branch per platform, this maintains
 * one watcher per discovered directory everywhere, which behaves identically
 * on all three operating systems and adds no third-party dependency. A rescan
 * runs after every change so directories that appear are watched and
 * directories that disappear stop being watched.
 *
 * SECURITY: only an open session's working directory is addressable —
 * resolveOpenWorkingDir() refuses anything that is not in the session
 * registry, so a watcher can never be pointed at an arbitrary path. The
 * rescan re-validates before every callback, so closing, discarding or
 * locking the vault (all of which erase the working dir) stops the watcher by
 * itself; the returned stop() is for closing the panel early. Symlinks are
 * never watched — lstat discipline, same as the packer and the eraser.
 *
 * Live-directory tolerance: readdir/lstat races with the user mutating the
 * folder mid-scan are swallowed, per the working directory's "moving target"
 * rule in AGENTS.md.
 */
import fs from "node:fs";
import path from "node:path";
import { loadSessions } from "./sessions";
import { resolveOpenWorkingDir } from "./vault";

const CHANGE_DEBOUNCE_MS = 300;

/** Bound the watcher set so a pathological tree cannot exhaust file handles. */
const MAX_WATCHED_DIRS = 500;

/** Per-watch-instance state: which directories hold an open fs.watch handle. */
interface WatchHandle {
  stop: () => void;
  dirWatchers: Map<string, fs.FSWatcher>;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

interface WatchHost {
  handle: WatchHandle;
  root: string;
  schedule: () => void;
}

/**
 * Start watching an open vault's working directory.
 *
 * @param workingDir the session's working folder (validated against the
 *   session registry; throws if that folder is not an open vault)
 * @param onChange invoked (debounced, with the resolved working dir) when the
 *   folder's contents changed
 * @returns a stop function — idempotent
 */
export function watchWorkingDir(
  workingDir: string,
  onChange: (workingDir: string) => void,
): () => void {
  const root = resolveOpenWorkingDir(workingDir);
  const handle: WatchHandle = {
    stop: () => {},
    dirWatchers: new Map(),
    timer: null,
    stopped: false,
  };

  const rescan = () => {
    if (handle.stopped) return;
    // Re-validate: the session may have gone away between events. A not-open
    // (closed / discarded / locked) vault stops the watcher by itself.
    const sessions = loadSessions();
    const live = sessions.some(
      (s) => path.resolve(s.workingDir) === path.resolve(root),
    );
    if (!live || !fs.existsSync(root)) {
      stopAll();
      return;
    }
    // Collect directories currently on disk (not following symlinks).
    const wanted = new Set<string>([root]);
    const queue = [root];
    while (queue.length > 0 && wanted.size < MAX_WATCHED_DIRS) {
      const dir = queue.shift()!;
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: watch what we can see
      }
      for (const d of names) {
        if (
          wanted.size >= MAX_WATCHED_DIRS || // defensive: bounds never recurse
          d.isSymbolicLink()
        ) {
          continue;
        }
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          wanted.add(abs);
          queue.push(abs);
        }
      }
    }
    // Drop stale watchers.
    for (const [dir, w] of handle.dirWatchers) {
      if (!wanted.has(dir)) {
        w.close();
        handle.dirWatchers.delete(dir);
      }
    }
    // Add new watchers.
    for (const dir of wanted) {
      if (handle.dirWatchers.has(dir)) continue;
      try {
        // fs.watch without `recursive` everywhere: the directory set above is
        // the recursion, and it is portable.
        const w = fs.watch(dir, { persistent: false }, () => schedule());
        handle.dirWatchers.set(dir, w);
      } catch {
        // FSEvent limits or a TOCTOU-deleted directory: watch what we can.
      }
    }
    // Progress events fire after the rescan, so the schedule callback is only
    // needed on the fs.watch side; keep the read-side tolerant either way.
  };

  const schedule = () => {
    if (handle.stopped) return;
    if (handle.timer) clearTimeout(handle.timer);
    // Debounce: bulk operations (seeding, "Add Files" of a folder tree, a
    // save-all in the OS editor) produce a burst of events; one refresh is
    // the useful outcome, not one per write.
    handle.timer = setTimeout(() => {
      handle.timer = null;
      if (handle.stopped) return;
      try {
        // Rescan FIRST — it re-validates that the folder is still an open
        // session's working dir — and only then notify. Without the ordering,
        // the burst of events a close/discard/lock produces would fire one
        // final onChange for a directory that no longer exists.
        rescan();
        if (handle.stopped) return;
        onChange(root);
      } catch {
        // a rescan failure must not kill the watcher or the callback chain
      }
    }, CHANGE_DEBOUNCE_MS);
  };

  const stopAll = () => {
    handle.stopped = true;
    if (handle.timer) {
      clearTimeout(handle.timer);
      handle.timer = null;
    }
    for (const w of handle.dirWatchers.values()) w.close();
    handle.dirWatchers.clear();
  };
  handle.stop = stopAll;

  rescan();
  // Prime the change schedule from the initial scan too: the tree may have
  // changed in the gap between the renderer's last render and this watcher.
  schedule();

  return () => stopAll();
}
