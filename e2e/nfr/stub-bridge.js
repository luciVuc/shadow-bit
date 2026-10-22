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
  var listeners = {
    onOpenVaultFile: [],
    onMenuCommand: [],
    onAutoLocked: [],
  };
  function listen(name, cb) {
    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(cb);
  }

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
    "getAppVersion",
    "getCheckForUpdates",
    "setCheckForUpdates",
    "checkForUpdates",
  ];

  var defaults = {
    chooseCreatePath: function () {
      return Promise.resolve("/tmp/stub.svlt");
    },
    chooseOpenPath: function () {
      return Promise.resolve("/tmp/stub.svlt");
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
        vaultPath: "/tmp/stub.svlt",
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
        vaultPath: "/tmp/stub.svlt",
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
      return Promise.resolve({ vaultPath: "/tmp/stub.svlt", paranoid: false });
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

    getAppVersion: function () {
      return Promise.resolve("1.0.0");
    },
    getCheckForUpdates: function () {
      return Promise.resolve(true);
    },
    setCheckForUpdates: function () {
      return Promise.resolve(null);
    },
    checkForUpdates: function () {
      // Up-to-date by default: the stub cannot reach the network, so a stub
      // claiming a newer version exists would leave a phantom badge visible in
      // every NFR screenshot and a11y audit unless a test overrides it.
      return Promise.resolve({
        current: "1.0.0",
        latest: "1.0.0",
        isNew: false,
        url: "https://github.com/luciVuc/shadow-bit/releases/latest",
      });
    },

    // Listener methods: the renderer registers callbacks at load time, so the
    // stub must capture them — otherwise a simulation/test cannot push a main
    // process event (open vault file, menu command, update-available) after
    // load. window.__sbStub.emit(name, payload) replays them.
    onOpenVaultFile: function (cb) {
      listen("onOpenVaultFile", cb);
    },
    onMenuCommand: function (cb) {
      listen("onMenuCommand", cb);
    },
    setOpenVaultCount: function () {},
    onAutoLocked: function (cb) {
      listen("onAutoLocked", cb);
    },
    onUpdateAvailable: function (cb) {
      listen("onUpdateAvailable", cb);
    },
    noteActivity: function () {},
    pathForFile: function () {
      return "/tmp/dropped.txt";
    },

    openPath: function () {
      return Promise.resolve(null);
    },
    openExternal: function () {
      return Promise.resolve({ ok: true, value: null });
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
    /** Replay a main→renderer push: emit("onUpdateAvailable", {...}). */
    emit: function (name, payload) {
      (listeners[name] || []).forEach(function (cb) {
        // Matches the real preload's dispatch shapes: onMenuCommand unpacks
        // {"cmd","arg"} into two arguments, the rest pass the payload as-is.
        if (name === "onMenuCommand") {
          cb(payload && payload.cmd, payload && payload.arg);
        } else {
          cb(payload);
        }
      });
    },
  };
  window.shadowbit = api;
})();
