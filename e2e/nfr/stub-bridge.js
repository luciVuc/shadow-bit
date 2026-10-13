// Bridge stub served to the standalone-browser harness.
// Plain JavaScript on purpose: this file is served raw to the browser, so it
// must not contain TypeScript-only syntax.
//
// It stands in for src/gui/preload.ts, which requires a main process that a
// plain Chromium tab does not have. Values are inert but well-formed so the
// renderer's init path completes and the real markup renders.
//
// This must mirror the preload API surface: renderer.js calls these at load
// time, so a missing entry throws before any handler is wired up and every
// later assertion fails for the wrong reason. When you add a bridge method,
// add it here too.
//
// RETURN SHAPES MATTER AS MUCH AS NAMES. main.ts wraps every vault/settings
// handler in `wrap()`/`wrapWorker()`, which return `{ ok: true, value }` or
// `{ ok: false, error }`, and renderer.js unwraps them with result(). A stub
// that returns the bare value therefore makes every vault action fail with
// "Unknown error" — silently, since nothing asserted on it. Methods whose
// result the renderer consumes through result() are listed in ENVELOPED below;
// the rest (file dialogs, listeners, fire-and-forget commands) return raw
// values, exactly as their main-process counterparts do.

(function () {
  var calls = [];
  var overrides = {};

  // Methods whose resolved value the renderer reads via result().
  var ENVELOPED = [
    "createVault",
    "openVault",
    "closeVault",
    "discardVault",
    "changePassword",
    "recoverVault",
    "regenRecovery",
    "removeRecovery",
    "info",
    "preflight",
    "sessions",
    "addFiles",
    "deleteVault",
    "setMeta",
    "listFiles",
    "deleteFile",
    "renameFile",
    "getRecent",
    "getAutoLock",
    "setAutoLock",
    "getTheme",
    "setTheme",
    "isOnboardingDone",
    "markOnboardingDone",
  ];

  var defaults = {
    chooseCreatePath: function () {
      return Promise.resolve("/tmp/stub.vault");
    },
    chooseOpenPath: function () {
      return Promise.resolve("/tmp/stub.vault");
    },
    chooseDir: function () {
      return Promise.resolve("/tmp");
    },
    chooseFiles: function () {
      return Promise.resolve(["/tmp/a.txt"]);
    },

    createVault: function (a) {
      return Promise.resolve({
        vaultPath: a.vaultPath,
        recoveryKey: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH",
      });
    },
    openVault: function () {
      return Promise.resolve({
        vaultPath: "/tmp/stub.vault",
        workingDir: "/tmp/stub-wd",
      });
    },
    closeVault: function () {
      return Promise.resolve(null);
    },
    discardVault: function () {
      return Promise.resolve(null);
    },
    changePassword: function () {
      return Promise.resolve(null);
    },
    recoverVault: function () {
      return Promise.resolve(null);
    },
    regenRecovery: function () {
      return Promise.resolve({
        recoveryKey: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH",
      });
    },
    removeRecovery: function () {
      return Promise.resolve(null);
    },
    info: function () {
      return Promise.resolve({
        vaultPath: "/tmp/stub.vault",
        version: 3,
        hasRecoveryKey: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        fileSize: 4096,
        isOpen: false,
        compressed: true,
        meta: {
          name: "Stub Vault",
          description: "Fixture vault for NFR tests",
        },
      });
    },
    preflight: function () {
      return Promise.resolve({ bytes: 4096, maxBytes: 1611661328 });
    },
    sessions: function () {
      return Promise.resolve([]);
    },
    addFiles: function () {
      return Promise.resolve({ count: 1, symlinksSkipped: 0 });
    },
    deleteVault: function () {
      return Promise.resolve(null);
    },
    setMeta: function () {
      // SetMetaResult, not null: vault.setMeta returns { vaultPath, paranoid }
      // and renderer.js branches on res.paranoid. Returning null would make the
      // paranoid warning unreachable in the NFR harness, so a renderer change
      // that depended on it would be untested here.
      return Promise.resolve({ vaultPath: "/tmp/stub.vault", paranoid: false });
    },
    confirmDialog: function () {
      return Promise.resolve(true);
    },

    listFiles: function () {
      // An ARRAY of entries, matching WorkingDirEntry[] in src/core/vault.ts.
      // It used to return { files: [] }, which renderer.js iterates directly —
      // so the in-app file browser threw the moment a user opened it.
      return Promise.resolve([]);
    },
    deleteFile: function () {
      return Promise.resolve(null);
    },
    renameFile: function () {
      return Promise.resolve(null);
    },

    getRecent: function () {
      return Promise.resolve([]);
    },
    getAutoLock: function () {
      return Promise.resolve(15);
    },
    setAutoLock: function () {
      return Promise.resolve(null);
    },
    getTheme: function () {
      return Promise.resolve("system");
    },
    setTheme: function () {
      return Promise.resolve(null);
    },
    isOnboardingDone: function () {
      return Promise.resolve(true);
    },
    markOnboardingDone: function () {
      return Promise.resolve(null);
    },

    onOpenVaultFile: function () {},
    onMenuCommand: function () {},
    setOpenVaultCount: function () {},
    onAutoLocked: function () {},
    noteActivity: function () {},
    pathForFile: function () {
      return "/tmp/dropped.txt";
    },

    openPath: function () {
      return Promise.resolve(null);
    },
    copy: function () {
      return Promise.resolve(null);
    },
    copySecret: function () {
      return Promise.resolve(null);
    },
  };

  var api = {};
  Object.keys(defaults).forEach(function (k) {
    var enveloped = ENVELOPED.indexOf(k) !== -1;
    api[k] = function () {
      var args = Array.prototype.slice.call(arguments);
      calls.push([k, args]);
      var result = overrides[k]
        ? overrides[k].apply(null, args)
        : defaults[k].apply(null, args);
      if (!enveloped) return result;
      // Mirror wrap()/wrapWorker(): resolve to { ok: true, value }. Overrides
      // may return an envelope of their own (e.g. to simulate a failure), which
      // is passed through untouched.
      return Promise.resolve(result).then(function (v) {
        if (v && typeof v === "object" && typeof v.ok === "boolean") return v;
        return { ok: true, value: v };
      });
    };
  });

  window.__sbStub = {
    calls: calls,
    set: function (map) {
      Object.keys(map).forEach(function (k) {
        overrides[k] = map[k];
      });
    },
    reset: function () {
      overrides = {};
      calls.length = 0;
    },
  };
  window.shadowbit = api;
})();
