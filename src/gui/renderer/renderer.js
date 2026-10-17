// Renderer logic. Talks to the main process only through window.shadowbit (preload).
/* global window, document */
const api = window.shadowbit;

const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(id) {
  return document.getElementById(id);
}

let toastTimer = null;

/**
 * Show a status toast.
 *
 * Errors persist until they are replaced or dismissed. The previous behaviour
 * hid everything after four seconds, which meant a failed operation — a wrong
 * password, a mismatched confirmation, a vault too large — could vanish before
 * a slow reader finished looking at it, and before a screen reader had finished
 * announcing it. Success and warning messages stay on the four-second timer;
 * they confirm something already understood.
 */
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  const persistent = kind === "err";
  if (persistent) {
    t.setAttribute("data-persistent", "true");
    return;
  }
  t.removeAttribute("data-persistent");
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4000);
}
function ok(msg) {
  toast(msg, "ok");
}
function err(msg) {
  toast(msg, "err");
}
function warn(msg) {
  toast(msg, "warn");
}

/**
 * Report a validation failure: a persistent toast plus `aria-invalid` on the
 * field(s) at fault.
 *
 * The toast alone is easy to miss and vanishes on the next message; marking the
 * field is what a screen-reader user navigates to, and it survives until the
 * next input event on that field.
 */
function fieldError(msg, ...inputIds) {
  for (const id of inputIds) {
    const el = $(id);
    if (el) el.setAttribute("aria-invalid", "true");
  }
  err(msg);
}

/** Clear `aria-invalid` as soon as the user starts fixing the field. */
function clearFieldError(...inputIds) {
  for (const id of inputIds) {
    $(id)?.removeAttribute("aria-invalid");
  }
}

// Unwrap the {ok, value|error} envelope from the core.
function result(res) {
  if (!res || res.ok !== true) {
    throw new Error(res && res.error ? res.error : "Unknown error");
  }
  return res.value;
}

/** Escape HTML special characters — prevents broken markup in vault paths. */
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Human-readable file size. */
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(3)} GB`;
}

/** Extract the last path component from a POSIX or Windows path string. */
function pathBasename(p) {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

/** Show a full-screen loading overlay for the duration of `fn`. */
async function withLoading(fn) {
  $("loading-overlay").classList.remove("hidden");
  try {
    return await fn();
  } finally {
    $("loading-overlay").classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Status toasts
// ---------------------------------------------------------------------------
$("toast").addEventListener("click", () => {
  $("toast").classList.add("hidden");
});
$("toast").addEventListener("keydown", (e) => {
  // Only reachable while focus is on the toast itself (see the tabindex below).
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("toast").classList.add("hidden");
  }
});

/**
 * Tell the main process the user did something, so auto-lock measures
 * *inactivity* rather than "time since the last vault command".
 *
 * Throttled to one message per 20 seconds: the main process only restarts a
 * timer, and a message per keystroke would be pure IPC chatter for no benefit.
 * Any interaction counts — moving the mouse is deliberate too.
 */
let lastActivitySent = 0;
function noteActivity() {
  const now = Date.now();
  if (now - lastActivitySent < 20_000) return;
  lastActivitySent = now;
  try {
    api.noteActivity();
  } catch {
    /* bridge not ready yet */
  }
}
for (const evt of ["pointerdown", "keydown", "wheel"]) {
  document.addEventListener(evt, noteActivity, { passive: true, capture: true });
}

// ---------------------------------------------------------------------------
// Password strength indicator
// ---------------------------------------------------------------------------
//
// Colours come from CSS custom properties (`--strength-1` … `--strength-5`),
// NOT from literals here. The literal amber/olive values that were previously
// baked into this function measured ~2:1 against a white light theme and failed
// WCAG 1.4.3 as label text; deriving them from tokens means each theme owns its
// own accessible ramp and the two can never drift apart.
//
// The score is a length × character-class estimate. It is advisory: the core
// enforces only a minimum length, so this must never read as a guarantee.
function strengthColorVar(score) {
  const clamped = Math.min(5, Math.max(1, score));
  return `var(--strength-${clamped})`;
}

function passwordStrength(pw) {
  if (!pw) return { score: 0, label: "", color: "transparent" };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  const entropy = pw.length * Math.log2(Math.max(pool, 1));
  if (entropy < 28)
    return { score: 1, label: "Very weak", color: strengthColorVar(1) };
  if (entropy < 40)
    return { score: 2, label: "Weak", color: strengthColorVar(2) };
  if (entropy < 60)
    return { score: 3, label: "Fair", color: strengthColorVar(3) };
  if (entropy < 80)
    return { score: 4, label: "Strong", color: strengthColorVar(4) };
  return { score: 5, label: "Very strong", color: strengthColorVar(5) };
}

function updateStrength(inputId, fillId, labelId) {
  const { score, label, color } = passwordStrength($(inputId).value);
  const fill = $(fillId);
  fill.style.width = `${score * 20}%`;
  fill.style.backgroundColor = color;
  const strengthBar = fill.closest('[role="progressbar"]');
  if (strengthBar) {
    strengthBar.setAttribute("aria-valuenow", String(score * 20));
    // aria-valuetext carries the meaning; the bare 0–100 number does not.
    strengthBar.setAttribute("aria-valuetext", label || "empty");
  }
  const lbl = $(labelId);
  lbl.textContent = label;
  lbl.style.color = color;
}

$("create-password").addEventListener("input", () =>
  updateStrength(
    "create-password",
    "create-strength-fill",
    "create-strength-label",
  ),
);
$("cp-new").addEventListener("input", () =>
  updateStrength("cp-new", "cp-strength-fill", "cp-strength-label"),
);

// Clear `aria-invalid` as soon as the user starts correcting a field, so the
// mark always reflects the current state rather than the last failed attempt.
for (const id of [
  "open-password",
  "create-password",
  "create-password2",
  "cp-old",
  "cp-new",
  "cp-new2",
  "rec-key",
  "rec-new",
  "rec-new2",
  "meta-pass",
  "del-pass",
  "rk-pass",
]) {
  $(id)?.addEventListener("input", () => clearFieldError(id));
}

// ---------------------------------------------------------------------------
// Show/hide password toggles
// ---------------------------------------------------------------------------
document.querySelectorAll(".pw-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.target);
    if (!input) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "👁" : "🙈";
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
});

// ---------------------------------------------------------------------------
// Tabs — WAI-ARIA Tabs Pattern
// ---------------------------------------------------------------------------
const tabEls = [...document.querySelectorAll(".tab")];

function switchToTab(tabEl) {
  tabEls.forEach((t) => {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
    t.setAttribute("tabindex", "-1");
  });
  document
    .querySelectorAll(".panel")
    .forEach((p) => p.classList.remove("active"));

  tabEl.classList.add("active");
  tabEl.setAttribute("aria-selected", "true");
  tabEl.setAttribute("tabindex", "0");
  $("panel-" + tabEl.dataset.tab).classList.add("active");

  if (tabEl.dataset.tab === "sessions") refreshSessions();
  if (tabEl.dataset.tab === "open") refreshRecent();
}

tabEls.forEach((tab) => {
  tab.addEventListener("click", () => switchToTab(tab));
});

// Arrow-key navigation (WAI-ARIA tablist pattern)
document.querySelector('[role="tablist"]').addEventListener("keydown", (e) => {
  const idx = tabEls.indexOf(document.activeElement);
  if (idx < 0) return;
  let next = -1;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    next = (idx + 1) % tabEls.length;
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    next = (idx - 1 + tabEls.length) % tabEls.length;
  } else if (e.key === "Home") {
    next = 0;
  } else if (e.key === "End") {
    next = tabEls.length - 1;
  }
  if (next >= 0) {
    e.preventDefault();
    tabEls[next].focus();
    switchToTab(tabEls[next]);
  }
});

// ---------------------------------------------------------------------------
// Focus trap utility
// ---------------------------------------------------------------------------
const FOCUSABLE_SELECTOR =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
  'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab inside `container` while it is open.
 *
 * The focusable set is re-queried on every Tab rather than captured once. That
 * matters for the recovery-key modal: `#modal-ok` starts `disabled` (and carries
 * `aria-disabled`), so a set captured at open time excludes it — but ticking the
 * "I have saved it" checkbox enables it *after* the trap is installed. With a
 * one-shot snapshot, Tab from the last originally-focusable control walks past
 * the newly-enabled button and out of the dialog, dropping keyboard users on the
 * page behind a modal that claims `aria-modal="true"`.
 */
function trapFocus(container) {
  const currently = () =>
    [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
      (el) => el.offsetParent !== null || el.getClientRects().length > 0,
    );

  const focusable = currently();
  if (!focusable.length) return () => {};
  const first = focusable[0];
  first.focus();
  const handler = (e) => {
    if (e.key !== "Tab") return;
    const items = currently();
    if (!items.length) return;
    const last = items[items.length - 1];
    const active = document.activeElement;
    // Recover from focus that landed outside the container (e.g. the user
    // clicked the backdrop): pull it back in rather than letting it roam.
    if (!container.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && (active === first || active === items[0])) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener("keydown", handler);
  return () => container.removeEventListener("keydown", handler);
}

// ---------------------------------------------------------------------------
// Recovery-key modal
// ---------------------------------------------------------------------------
let releaseFocusTrap = null;

/**
 * Close a modal: release the focus trap, hide it, and return focus to the
 * element that opened it. Restoring focus is expected behaviour for a dialog —
 * without it, keyboard users are dumped back at the top of the document.
 */
function closeModal(modalId, triggerId) {
  if (releaseFocusTrap) {
    releaseFocusTrap();
    releaseFocusTrap = null;
  }
  const el = $(modalId);
  if (el) el.classList.add("hidden");
  const trigger = triggerId ? $(triggerId) : null;
  if (trigger) trigger.focus();
}

/**
 * Make a modal dismissible with Escape (WAI-ARIA dialog pattern; WCAG 2.1.1).
 * `dismissible: false` is used for the recovery-key modal on purpose — that key
 * is displayed exactly once, so it must not be closable by a stray keypress.
 */
function trapEscape(modalId, dismissible = true) {
  const el = $(modalId);
  if (!el) return;
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !dismissible) return;
    if (el.classList.contains("hidden")) return;
    e.stopPropagation();
    e.preventDefault();
    el.dispatchEvent(new CustomEvent("modal:dismiss"));
  });
}

function showRecoveryModal(key) {
  $("modal-key").textContent = key;
  const ackCheck = $("modal-ack-check");
  const okBtn = $("modal-ok");
  ackCheck.checked = false;
  okBtn.disabled = true;
  okBtn.setAttribute("aria-disabled", "true");
  ackCheck.onchange = () => {
    okBtn.disabled = !ackCheck.checked;
    okBtn.setAttribute("aria-disabled", String(!ackCheck.checked));
  };
  $("modal").classList.remove("hidden");
  if (releaseFocusTrap) releaseFocusTrap();
  releaseFocusTrap = trapFocus($("modal").querySelector(".modal-box"));

  $("modal-copy").onclick = () => {
    api.copySecret(key);
    ok("Recovery key copied. Clipboard will be cleared in 30 seconds.");
  };
  okBtn.onclick = () => {
    if (!ackCheck.checked) return;
    // Deliberately does NOT clear the clipboard. `sys:copySecret` already
    // scheduled a clear for 30 s after the copy, and it only wipes when the
    // clipboard still holds the key. An unconditional `copy("")` here — which
    // is what this used to do — destroyed whatever the user had copied in the
    // meantime, which is data loss in an app whose entire job is not losing
    // data.
    closeModal("modal");
  };
}

/**
 * Ask the user for a line of text.
 *
 * Electron does not implement `window.prompt` — it throws "prompt() is and
 * will not be supported" — so the file browser's rename used to throw on every
 * attempt. `window.confirm` does exist but always resolves `false` under
 * Playwright-driven automation and renders as an unstyleable browser dialog, so
 * confirmations go through the app's own `dialog:confirm` IPC bridge (a real
 * native message box) and this in-app prompt covers the one case a message box
 * cannot express.
 *
 * Resolves to the entered text, or `null` if cancelled. Escape and Cancel both
 * mean cancel; Enter submits.
 */
function askText({ title, value = "", confirmLabel = "OK" }) {
  return new Promise((resolve) => {
    const modal = $("prompt-modal");
    const input = $("prompt-input");
    input.value = value;
    $("prompt-title").textContent = title;
    $("prompt-ok").textContent = confirmLabel;

    const finish = (result) => {
      if (releaseFocusTrap) {
        releaseFocusTrap();
        releaseFocusTrap = null;
      }
      modal.classList.add("hidden");
      modal.removeEventListener("modal:dismiss", onDismiss);
      $("prompt-cancel").onclick = null;
      $("prompt-ok").onclick = null;
      input.onkeydown = null;
      resolve(result);
    };
    const onDismiss = () => finish(null);

    modal.classList.remove("hidden");
    releaseFocusTrap = trapFocus(modal.querySelector(".modal-box"));
    modal.addEventListener("modal:dismiss", onDismiss);
    $("prompt-cancel").onclick = () => finish(null);
    $("prompt-ok").onclick = () => {
      const v = input.value.trim();
      finish(v.length > 0 ? v : null);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("prompt-ok").click();
      }
    };
    // trapFocus already focused the first control; put the caret in the text.
    input.focus();
    input.select();
  });
}

/** Ask a yes/no question via the native message box. */
async function askConfirm(opts) {
  return (await api.confirmDialog(opts)) === true;
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
async function openSettingsModal() {
  // Populate current values.
  try {
    const minutes = result(await api.getAutoLock());
    const sel = $("auto-lock-select");
    const opt = [...sel.options].find((o) => parseInt(o.value) === minutes);
    if (opt) opt.selected = true;
    const theme = result(await api.getTheme());
    const tSel = $("theme-select");
    const tOpt = [...tSel.options].find((o) => o.value === theme);
    if (tOpt) tOpt.selected = true;
  } catch {
    /* best-effort */
  }
  $("settings-modal").classList.remove("hidden");
  releaseFocusTrap = trapFocus($("settings-modal").querySelector(".modal-box"));
}

$("settings-btn").onclick = openSettingsModal;

$("settings-close").onclick = async () => {
  // Persist settings.
  try {
    const minutes = parseInt($("auto-lock-select").value, 10);
    await api.setAutoLock(minutes);
    const theme = $("theme-select").value;
    await api.setTheme(theme);
    applyTheme(theme);
  } catch {
    /* best-effort */
  }
  closeModal("settings-modal", "settings-btn");
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * The theme actually in effect right now.
 *
 * "system" is a stored *preference*, not a visual state — the rendered theme
 * comes from the OS. The topbar toggle used to read `data-theme` directly, so
 * with "system" selected it saw nothing, assumed dark, and its icon disagreed
 * with what was on screen. Resolve through the media query instead.
 */
function effectiveTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function syncThemeToggleIcon() {
  $("theme-toggle").textContent =
    effectiveTheme() === "light" ? "🌙" : "☀️";
}

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
  syncThemeToggleIcon();
}

$("theme-toggle").onclick = async () => {
  // Flip away from what is currently displayed, whatever the stored preference.
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    await api.setTheme(next);
  } catch {
    /* best-effort */
  }
};

// Keep the icon honest when the OS theme changes while we are on "system".
try {
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", syncThemeToggleIcon);
} catch {
  /* older matchMedia without addEventListener — non-fatal */
}

// ---------------------------------------------------------------------------
// File association: handle .svlt (or legacy .vault) opened from OS
// ---------------------------------------------------------------------------
api.onOpenVaultFile((filePath) => {
  switchToTab(document.querySelector("[data-tab='open']"));
  $("open-path").value = filePath;
  $("open-password").focus();
  refreshRecent();
});

// ---------------------------------------------------------------------------
// Application menu commands (sent by the main process)
// ---------------------------------------------------------------------------
api.onMenuCommand((cmd, arg) => {
  switch (cmd) {
    case "new-vault":
      switchToTab(document.querySelector("[data-tab='create']"));
      $("create-browse").click();
      break;
    case "open-vault":
      switchToTab(document.querySelector("[data-tab='open']"));
      $("open-browse").click();
      break;
    case "settings":
      openSettingsModal();
      break;
    case "theme":
      // The main process already persisted it; just apply it to the document.
      applyTheme(arg);
      break;
    case "recents-changed":
      refreshRecent();
      break;
    default:
      err(`Unknown menu command: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// Auto-lock notification
// ---------------------------------------------------------------------------
api.onAutoLocked(({ count, reason }) => {
  // A manual lock is what the user asked for, so it is reported as success. An
  // auto-lock erased work they had not saved, so it is a warning. Both used to
  // go through err(), which painted an ordinary confirmation red.
  if (reason === "manual") {
    ok(`Locked ${count} vault(s).`);
  } else {
    warn(`Auto-locked ${count} vault(s) after inactivity. Unsaved changes were erased.`);
  }
  refreshSessions();
});

// ---------------------------------------------------------------------------
// Global drag-and-drop: drop a .svlt file anywhere on the window
// ---------------------------------------------------------------------------
document.body.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  // Map once: `pathForFile` is a synchronous bridge call per file, and calling
  // it twice for the winner (once to test, once to use) means asking the main
  // process the same question twice.
  const vaultPath = [...e.dataTransfer.files]
    .map((f) => api.pathForFile(f))
    .find((p) => p && /\.(svlt|vault)$/i.test(p));
  if (vaultPath) {
    switchToTab(document.querySelector("[data-tab='open']"));
    $("open-path").value = vaultPath;
    $("open-password").focus();
  }
});

// ---------------------------------------------------------------------------
// Recent vaults
// ---------------------------------------------------------------------------
async function refreshRecent() {
  const section = $("recent-section");
  const list = $("recent-list");
  let recents = [];
  try {
    recents = result(await api.getRecent()) ?? [];
  } catch {
    /* swallow — non-fatal */
  }

  if (recents.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  list.innerHTML = recents
    .map(
      (p) =>
        `<li class="recent-item" data-path="${escHtml(p)}" title="${escHtml(p)}"
             tabindex="0" role="button" aria-label="Open recent vault: ${escHtml(pathBasename(p))}">` +
        `<span class="recent-name">${escHtml(pathBasename(p))}</span>` +
        `<span class="recent-dir">${escHtml(p)}</span>` +
        `</li>`,
    )
    .join("");
  list.querySelectorAll(".recent-item").forEach((item) => {
    const activate = () => {
      $("open-path").value = item.dataset.path;
      $("open-password").focus();
    };
    item.addEventListener("click", activate);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// OPEN tab
// ---------------------------------------------------------------------------
// Every card that authenticates against an existing vault needs the same
// optional keyfile picker, so wire them from one place. `prefix` is the element
// id stem: "open" -> open-keyfile / open-keyfile-browse / open-keyfile-clear.
function wireKeyfileRow(prefix) {
  const input = $(prefix + "-keyfile");
  const browse = $(prefix + "-keyfile-browse");
  const clear = $(prefix + "-keyfile-clear");
  if (!input || !browse || !clear) return;
  browse.onclick = async () => {
    const p = await api.chooseFiles();
    if (p && p.length > 0) input.value = p[0];
  };
  clear.onclick = () => {
    input.value = "";
  };
}

// Read a wired keyfile row as the keyfiles argument the bridge expects.
function keyfilesFrom(prefix) {
  const v = $(prefix + "-keyfile").value;
  return v ? [v] : undefined;
}

wireKeyfileRow("open");
wireKeyfileRow("create");
wireKeyfileRow("cp");
wireKeyfileRow("rk");
wireKeyfileRow("meta");
wireKeyfileRow("del");

$("open-browse").onclick = async () => {
  const p = await api.chooseOpenPath();
  if (p) $("open-path").value = p;
};
$("open-go").onclick = async () => {
  const vaultPath = $("open-path").value;
  const password = $("open-password").value;
  if (!vaultPath) return err("Choose a vault file.");
  if (!password) return fieldError("Enter the password.", "open-password");
  // Check the size before attempting the open: the payload is buffered whole
  // in memory, so an oversized vault fails without a useful GUI explanation.
  try {
    const { bytes, maxBytes } = result(await api.preflight({ vaultPath }));
    if (bytes > maxBytes) {
      return err(
        `That vault is ${(bytes / 2 ** 30).toFixed(2)} GiB, over the ` +
          `${(maxBytes / 2 ** 30).toFixed(1)} GiB limit. ShadowBit ` +
          `decrypts a vault entirely in memory, so large vaults need roughly ` +
          `twice their size in free RAM.`,
      );
    }
  } catch {
    // Preflight is advisory; let the real open surface any error.
  }
  await withLoading(async () => {
    try {
      const { workingDir } = result(
        await api.openVault({
          vaultPath,
          password,
          keyfiles: keyfilesFrom("open"),
        }),
      );
      $("open-password").value = "";
      ok("Vault opened. Opening working folder…");
      await api.openPath(workingDir);
      refreshSessions();
      refreshRecent();
    } catch (e) {
      $("open-password").value = "";
      err(e.message);
    }
  });
};

// ---------------------------------------------------------------------------
// CREATE tab
// ---------------------------------------------------------------------------
$("create-browse").onclick = async () => {
  const p = await api.chooseCreatePath();
  if (p) $("create-path").value = p;
};
$("create-seed-browse").onclick = async () => {
  const p = await api.chooseDir();
  if (p) $("create-seed").value = p;
};
$("create-go").onclick = async () => {
  const vaultPath = $("create-path").value;
  const password = $("create-password").value;
  const password2 = $("create-password2").value;
  const seedDir = $("create-seed").value;
  const generateRecovery = $("create-recovery").checked;
  const cipher = $("create-cipher").value;
  const paranoid = $("create-paranoid").checked;
  if (!vaultPath) return err("Choose where to save the vault.");
  if (!password) return fieldError("Enter a password.", "create-password");
  if (password.length < MIN_PASSWORD_LENGTH)
    return fieldError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      "create-password",
    );
  if (password !== password2)
    return fieldError(
      "Passwords do not match.",
      "create-password2",
      "create-password",
    );
  await withLoading(async () => {
    try {
      const res = result(
        await api.createVault({
          vaultPath,
          password,
          generateRecovery,
          seedDir,
          cipher: cipher !== "aes-256-gcm" ? cipher : undefined,
          keyfiles: keyfilesFrom("create"),
          paranoid: paranoid || undefined,
        }),
      );
      $("create-password").value = "";
      $("create-password2").value = "";
      updateStrength(
        "create-password",
        "create-strength-fill",
        "create-strength-label",
      );
      ok("Vault created: " + res.vaultPath);
      if (res.recoveryKey) showRecoveryModal(res.recoveryKey);
    } catch (e) {
      $("create-password").value = "";
      $("create-password2").value = "";
      updateStrength(
        "create-password",
        "create-strength-fill",
        "create-strength-label",
      );
      err(e.message);
    }
  });
};

// ---------------------------------------------------------------------------
// MANAGE tab
// ---------------------------------------------------------------------------
$("manage-browse").onclick = async () => {
  const p = await api.chooseOpenPath();
  if (p) $("manage-path").value = p;
};
$("manage-info").onclick = async () => {
  const vaultPath = $("manage-path").value;
  if (!vaultPath) return err("Choose a vault file.");
  try {
    const info = result(await api.info({ vaultPath }));
    const out = $("manage-info-out");
    let text =
      `Vault:        ${info.vaultPath}\n` +
      `Version:      ${info.version}\n` +
      `Size:         ${formatBytes(info.fileSize)}\n` +
      `Recovery key: ${info.hasRecoveryKey ? "yes" : "no"}\n` +
      `Compressed:   ${info.compressed ? "yes" : "no"}\n` +
      `Created:      ${info.createdAt}\n` +
      `Modified:     ${info.modifiedAt}\n` +
      `Open:         ${info.isOpen ? "yes" : "no"}` +
      (info.workingDir ? `\nWorking dir:  ${info.workingDir}` : "");
    if (info.meta?.name) text += `\nName:         ${info.meta.name}`;
    if (info.meta?.description)
      text += `\nDescription:  ${info.meta.description}`;
    out.textContent = text;
    out.classList.remove("hidden");
  } catch (e) {
    err(e.message);
  }
};

// Change password
$("cp-go").onclick = async () => {
  const vaultPath = $("manage-path").value;
  const oldPassword = $("cp-old").value;
  const newPassword = $("cp-new").value;
  const newPassword2 = $("cp-new2").value;
  if (!vaultPath) return err("Choose a vault file.");
  if (!oldPassword) return fieldError("Enter your current password.", "cp-old");
  if (newPassword.length < MIN_PASSWORD_LENGTH)
    return fieldError(
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      "cp-new",
    );
  if (newPassword !== newPassword2)
    return fieldError("New passwords do not match.", "cp-new2", "cp-new");
  await withLoading(async () => {
    try {
      result(
        await api.changePassword({
          vaultPath,
          oldPassword,
          newPassword,
          keyfiles: keyfilesFrom("cp"),
        }),
      );
      $("cp-old").value = $("cp-new").value = $("cp-new2").value = "";
      updateStrength("cp-new", "cp-strength-fill", "cp-strength-label");
      ok("Password changed.");
    } catch (e) {
      $("cp-old").value = $("cp-new").value = $("cp-new2").value = "";
      updateStrength("cp-new", "cp-strength-fill", "cp-strength-label");
      err(e.message);
    }
  });
};

// Recover via recovery key
$("rec-go").onclick = async () => {
  const vaultPath = $("manage-path").value;
  const recoveryKey = $("rec-key").value;
  const newPassword = $("rec-new").value;
  const newPassword2 = $("rec-new2").value;
  if (!vaultPath) return err("Choose a vault file.");
  if (!recoveryKey)
    return fieldError("Enter your recovery key.", "rec-key");
  if (newPassword.length < MIN_PASSWORD_LENGTH)
    return fieldError(
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      "rec-new",
    );
  if (newPassword !== newPassword2)
    return fieldError("New passwords do not match.", "rec-new2", "rec-new");
  await withLoading(async () => {
    try {
      result(await api.recoverVault({ vaultPath, recoveryKey, newPassword }));
      $("rec-key").value = $("rec-new").value = $("rec-new2").value = "";
      ok("Password reset via recovery key.");
    } catch (e) {
      $("rec-new").value = $("rec-new2").value = "";
      err(e.message);
    }
  });
};

// Regen recovery key
$("rk-regen").onclick = async () => {
  const vaultPath = $("manage-path").value;
  const password = $("rk-pass").value;
  if (!vaultPath) return err("Choose a vault file.");
  if (!password) return err("Enter the current password.");
  await withLoading(async () => {
    try {
      const newKey = result(
        await api.regenRecovery({
          vaultPath,
          password,
          keyfiles: keyfilesFrom("rk"),
        }),
      );
      $("rk-pass").value = "";
      ok("New recovery key generated.");
      showRecoveryModal(newKey);
    } catch (e) {
      $("rk-pass").value = "";
      err(e.message);
    }
  });
};

// Remove recovery key
$("rk-remove").onclick = async () => {
  const vaultPath = $("manage-path").value;
  const password = $("rk-pass").value;
  if (!vaultPath) return err("Choose a vault file.");
  if (!password) return err("Enter the current password.");
  const confirmed = await askConfirm({
    title: "Remove recovery key",
    message: "Remove this vault's recovery key?",
    detail: "The password will become the only way to open it.",
    confirmLabel: "Remove",
  });
  if (!confirmed) return;
  await withLoading(async () => {
    try {
      result(
        await api.removeRecovery({
          vaultPath,
          password,
          keyfiles: keyfilesFrom("rk"),
        }),
      );
      $("rk-pass").value = "";
      ok("Recovery key removed.");
    } catch (e) {
      $("rk-pass").value = "";
      err(e.message);
    }
  });
};

// Set metadata
$("meta-go").onclick = async () => {
  const vaultPath = $("manage-path").value;
  const password = $("meta-pass").value;
  const name = $("meta-name").value.trim();
  const description = $("meta-desc").value.trim();
  if (!vaultPath) return err("Choose a vault file.");
  if (!password) return err("Enter the password.");
  try {
    const res = result(
      await api.setMeta({
        vaultPath,
        password,
        meta: { name, description },
        keyfiles: keyfilesFrom("meta"),
      }),
    );
    $("meta-pass").value = "";
    // A paranoid vault keeps its header free of optional plaintext, and a name
    // and description are exactly that — so the save succeeds but the warning is
    // the honest report. `warn` auto-hides after a few seconds, which is too
    // short for something the user should act on, so this uses err()'s
    // persistent path with a warning framing.
    if (res && res.paranoid) {
      err(
        "Saved — but this vault was created in paranoid mode, which keeps its " +
          "header free of optional plaintext. The name and description are " +
          "stored in the clear and are readable by anyone who has the file.",
      );
    } else {
      ok("Metadata saved.");
    }
  } catch (e) {
    $("meta-pass").value = "";
    err(e.message);
  }
};

// Delete vault
$("del-go").onclick = async () => {
  const vaultPath = $("manage-path").value;
  const password = $("del-pass").value;
  const shred = $("del-shred").checked;
  if (!vaultPath) return err("Choose a vault file.");
  if (!password) return err("Enter the password to delete.");
  const confirmed = await askConfirm({
    title: shred ? "Shred vault" : "Delete vault",
    message: `${shred ? "Shred" : "Delete"} this vault permanently?`,
    detail: vaultPath,
    confirmLabel: shred ? "Shred" : "Delete",
  });
  if (!confirmed) return;
  await withLoading(async () => {
    try {
      result(
        await api.deleteVault({
          vaultPath,
          password,
          shred,
          keyfiles: keyfilesFrom("del"),
        }),
      );
      $("del-pass").value = "";
      $("manage-path").value = "";
      $("manage-info-out").classList.add("hidden");
      ok(shred ? "Vault shredded." : "Vault deleted.");
    } catch (e) {
      $("del-pass").value = "";
      err(e.message);
    }
  });
};

// ---------------------------------------------------------------------------
// SESSIONS tab
// ---------------------------------------------------------------------------
async function refreshSessions() {
  // Fetch BEFORE touching the DOM. Clearing the list first left it empty for
  // the whole round-trip, so anything that read the list during that window saw
  // nothing — and rebuilding it unconditionally threw away whatever the user
  // had already typed into a card, since merely switching to this tab triggers
  // a refresh.
  let sessions = [];
  try {
    sessions = result(await api.sessions());
  } catch (e) {
    return err(e.message);
  }
  // Keep the main process in sync so File > Lock All Vaults is only enabled
  // when there is something to lock.
  api.setOpenVaultCount(sessions.length);

  const list = $("sessions-list");
  // Keyed on what the card actually displays, not on the whole session object:
  // a field that changes without changing the visible content must not force a
  // rebuild, or the same clobbering comes back through another door.
  const sig = JSON.stringify(
    sessions.map((s) => [s.vaultPath, s.workingDir]),
  );
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;

  list.innerHTML = "";
  if (sessions.length === 0) {
    list.innerHTML = '<p class="hint">No open vaults.</p>';
    return;
  }
  for (const s of sessions) {
    const el = document.createElement("div");
    el.className = "session";
    el.setAttribute("role", "article");
    el.setAttribute("aria-label", `Open vault: ${pathBasename(s.vaultPath)}`);
    el.innerHTML =
      `<div class="path">${escHtml(s.vaultPath)}</div>` +
      `<div class="wd">${escHtml(s.workingDir)}</div>` +
      `<div class="dropzone" role="region" aria-label="Drop zone for adding files">` +
      `<span class="dropzone-icon" aria-hidden="true">🗂</span>` +
      `Drag files here to add them, or use "Add Files…"</div>` +
      `<div class="pw-wrapper">` +
      `<input type="password" placeholder="Password (to close & save)"` +
      ` aria-label="Password to close or discard this vault" autocomplete="current-password" />` +
      `<button type="button" class="pw-toggle" aria-label="Show password">👁</button>` +
      `</div>` +
      `<div class="actions">
         <button class="secondary btn-folder">Open Folder</button>
         <button class="secondary btn-add">Add Files…</button>
         <button class="secondary btn-tree">Files</button>
         <button class="primary btn-close">Close &amp; Save</button>
         <button class="secondary btn-discard">Discard</button>
       </div>` +
      `<div class="session-tree hidden"></div>`;

    // Wire the pw-toggle inside this card.
    const pwToggle = el.querySelector(".pw-toggle");
    const pwInput = el.querySelector("input[type=password]");
    pwToggle.addEventListener("click", () => {
      const showing = pwInput.type === "text";
      pwInput.type = showing ? "password" : "text";
      pwToggle.textContent = showing ? "👁" : "🙈";
      pwToggle.setAttribute(
        "aria-label",
        showing ? "Show password" : "Hide password",
      );
    });

    const dz = el.querySelector(".dropzone");
    const treeContainer = el.querySelector(".session-tree");

    const addPaths = async (paths) => {
      if (!paths || paths.length === 0) return;
      await withLoading(async () => {
        try {
          const { count, symlinksSkipped } = result(
            await api.addFiles({ vaultPath: s.vaultPath, paths }),
          );
          ok(`Added ${count} item(s). Close to save.`);
          if (symlinksSkipped > 0)
            warn(`${symlinksSkipped} symlink(s) were skipped.`);
        } catch (e) {
          err(e.message);
        }
      });
    };

    dz.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // prevent global .svlt drop handler
      dz.classList.remove("drag");
      const paths = [...ev.dataTransfer.files].map((f) => api.pathForFile(f));
      await addPaths(paths);
    });

    el.querySelector(".btn-folder").onclick = () => api.openPath(s.workingDir);
    el.querySelector(".btn-add").onclick = async () => {
      const paths = await api.chooseFiles();
      await addPaths(paths);
    };

    // In-app file browser toggle
    el.querySelector(".btn-tree").onclick = async () => {
      const hidden = treeContainer.classList.toggle("hidden");
      if (!hidden) await renderFileTree(treeContainer, s.workingDir);
    };

    el.querySelector(".btn-close").onclick = async () => {
      if (!pwInput.value) return err("Enter the password to save.");
      await withLoading(async () => {
        try {
          result(
            await api.closeVault({
              vaultPath: s.vaultPath,
              password: pwInput.value,
              keyfiles: s.keyfiles,
            }),
          );
          ok("Closed & re-encrypted.");
          pwInput.value = "";
          refreshSessions();
        } catch (e) {
          pwInput.value = "";
          err(e.message);
        }
      });
    };

    el.querySelector(".btn-discard").onclick = async () => {
      if (!pwInput.value) return err("Enter the password to discard.");
      const confirmed = await askConfirm({
        title: "Discard changes",
        message: "Discard all unsaved changes?",
        detail: "The working folder will be securely erased without saving.",
        confirmLabel: "Discard",
      });
      if (!confirmed) return;
      await withLoading(async () => {
        try {
          result(
            await api.discardVault({
              vaultPath: s.vaultPath,
              password: pwInput.value,
              keyfiles: s.keyfiles,
            }),
          );
          pwInput.value = "";
          ok("Discarded unsaved changes.");
          refreshSessions();
        } catch (e) {
          pwInput.value = "";
          err(e.message);
        }
      });
    };

    list.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// In-app file browser
// ---------------------------------------------------------------------------
async function renderFileTree(container, workingDir) {
  container.innerHTML = "";
  let entries;
  try {
    entries = result(await api.listFiles({ workingDir }));
  } catch (e) {
    container.innerHTML = `<p class="file-tree-empty">${escHtml(e.message)}</p>`;
    return;
  }
  if (!entries || entries.length === 0) {
    container.innerHTML = `<div class="file-tree"><p class="file-tree-empty">Empty vault</p></div>`;
    return;
  }
  const treeEl = document.createElement("div");
  treeEl.className = "file-tree";
  renderTreeLevel(treeEl, entries, workingDir);
  container.appendChild(treeEl);
}

function renderTreeLevel(parent, entries, workingDir) {
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = `tree-item ${entry.type}`;

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = entry.type === "dir" ? "📁" : "📄";

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    name.title = entry.rel;

    const actions = document.createElement("div");
    actions.className = "tree-actions";

    if (entry.type === "file") {
      const size = document.createElement("span");
      size.className = "tree-size";
      size.textContent = formatBytes(entry.size);
      item.append(icon, name, size, actions);

      // Open file
      const openBtn = document.createElement("button");
      openBtn.title = "Open";
      openBtn.setAttribute("aria-label", `Open ${entry.name}`);
      openBtn.textContent = "↗";
      openBtn.onclick = (e) => {
        e.stopPropagation();
        api.openPath(`${workingDir}/${entry.rel}`);
      };

      // Rename
      const renBtn = document.createElement("button");
      renBtn.title = "Rename";
      renBtn.setAttribute("aria-label", `Rename ${entry.name}`);
      renBtn.textContent = "✏️";
      renBtn.onclick = async (e) => {
        e.stopPropagation();
        const newName = await askText({
          title: "Rename",
          value: entry.name,
          confirmLabel: "Rename",
        });
        if (!newName || newName === entry.name) return;
        try {
          result(await api.renameFile({ workingDir, oldRel: entry.rel, newName }));
          await renderFileTree(item.closest(".session-tree"), workingDir);
        } catch (ex) {
          err(ex.message);
        }
      };

      // Delete
      const delBtn = document.createElement("button");
      delBtn.title = "Delete";
      delBtn.setAttribute("aria-label", `Delete ${entry.name}`);
      delBtn.textContent = "🗑";
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        // Not window.confirm: it always resolves false under automation and is
        // an unstyleable browser dialog next to every other confirmation in
        // this app, which uses the native message box.
        const yes = await askConfirm({
          title: `Delete ${entry.name}?`,
          message: `Delete "${entry.name}" from this vault?`,
          detail: "It is removed from the working folder. Close & Save writes the change to the vault file.",
          confirmLabel: "Delete",
        });
        if (!yes) return;
        try {
          result(await api.deleteFile({ workingDir, relPath: entry.rel }));
          await renderFileTree(item.closest(".session-tree"), workingDir);
        } catch (ex) {
          err(ex.message);
        }
      };
      actions.append(openBtn, renBtn, delBtn);
      parent.appendChild(item);
      continue;
    }

    // Directory — collapsible. Children are built the first time the folder is
    // expanded rather than up front: the core already sent the whole subtree in
    // one message, so eagerly rendering it built a DOM node per file in a large
    // vault before the user had looked at any of it.
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "tree-toggle-btn";
    toggleBtn.textContent = "▸";
    toggleBtn.setAttribute("aria-label", `Expand ${entry.name}`);
    toggleBtn.setAttribute("aria-expanded", "false");

    const childContainer = document.createElement("div");
    childContainer.className = "tree-indent hidden";

    let childrenBuilt = false;
    const buildChildren = () => {
      if (childrenBuilt) return;
      childrenBuilt = true;
      renderTreeLevel(childContainer, entry.children || [], workingDir);
    };

    toggleBtn.onclick = () => {
      const isOpen = !childContainer.classList.contains("hidden");
      if (!isOpen) buildChildren();
      childContainer.classList.toggle("hidden", isOpen);
      toggleBtn.textContent = isOpen ? "▸" : "▾";
      toggleBtn.setAttribute("aria-expanded", String(!isOpen));
      toggleBtn.setAttribute(
        "aria-label",
        isOpen ? `Expand ${entry.name}` : `Collapse ${entry.name}`,
      );
    };

    // Delete directory
    const delBtn = document.createElement("button");
    delBtn.title = "Delete folder";
    delBtn.setAttribute("aria-label", `Delete folder ${entry.name}`);
    delBtn.textContent = "🗑";
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const yes = await askConfirm({
        title: `Delete folder ${entry.name}?`,
        message: `Delete "${entry.name}" and everything in it?`,
        detail: "It is removed from the working folder. Close & Save writes the change to the vault file.",
        confirmLabel: "Delete",
      });
      if (!yes) return;
      try {
        result(await api.deleteFile({ workingDir, relPath: entry.rel }));
        await renderFileTree(item.closest(".session-tree"), workingDir);
      } catch (ex) {
        err(ex.message);
      }
    };
    actions.append(delBtn);

    parent.appendChild(item);
    parent.appendChild(childContainer);
  }
}

$("sessions-refresh").onclick = refreshSessions;

// ---------------------------------------------------------------------------
// First-run onboarding
// ---------------------------------------------------------------------------
async function initOnboarding() {
  try {
    const done = result(await api.isOnboardingDone());
    if (!done) {
      $("welcome-modal").classList.remove("hidden");
      releaseFocusTrap = trapFocus(
        $("welcome-modal").querySelector(".modal-box"),
      );
    }
  } catch {
    /* best-effort */
  }
}

$("welcome-start").onclick = async () => {
  closeModal("welcome-modal");
  try {
    await api.markOnboardingDone();
  } catch {
    /* best-effort */
  }
  // Switch to Create tab to guide new users.
  switchToTab(document.querySelector("[data-tab='create']"));
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  // Escape-to-dismiss, per the WAI-ARIA dialog pattern (WCAG 2.1.1).
  // The recovery-key modal is deliberately NOT dismissible: that key is shown
  // exactly once, so it requires the explicit acknowledgement checkbox.
  $("settings-modal").addEventListener("modal:dismiss", () =>
    closeModal("settings-modal", "settings-btn"),
  );
  $("welcome-modal").addEventListener("modal:dismiss", () =>
    closeModal("welcome-modal"),
  );
  trapEscape("settings-modal");
  trapEscape("welcome-modal");
  // The recovery-key modal is deliberately NOT dismissible: that key is shown
  // exactly once, so a stray keypress must not discard it.
  trapEscape("modal", false);
  // The prompt modal IS dismissible: it is a dialog (WCAG 2.1.1), so Escape
  // must cancel. trapEscape is what translates the keypress into the
  // `modal:dismiss` event askText() listens for, so it has to be registered
  // even though askText manages its own per-invocation listener. Without it,
  // Escape silently does nothing and the only ways out are Cancel and Enter.
  trapEscape("prompt-modal");

  // Apply saved theme.
  try {
    const theme = result(await api.getTheme());
    applyTheme(theme);
    $("theme-toggle").textContent = theme === "light" ? "🌙" : "☀️";
  } catch {
    /* best-effort */
  }

  // Populate recent vaults and sessions on the default tab.
  refreshRecent();
  await initOnboarding();
}

init();
