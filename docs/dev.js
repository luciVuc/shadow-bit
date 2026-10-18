/**
 * dev.js — contributor page for docs/dev.html.
 *
 * Deliberately a separate file from index.js: the marketing page must never
 * grow a reference to the source tree, the build scripts, or the test runners.
 * Splitting the renderer is what keeps that from happening quietly — there is
 * nothing to delete from index.js because it was never here.
 *
 * Same rules as index.js: classic script, no modules, no fetch(), no markup
 * built as strings. Templates live in dev.html.
 */

/** Clone the first element inside <template id="…">. */
function cloneTemplate(id) {
  const tpl = document.getElementById(id);
  return tpl.content.firstElementChild.cloneNode(true);
}

/** Copy text to clipboard and flash the button. The ✓ is CSS, not DOM. */
function copyCode(btn, text) {
  navigator.clipboard.writeText(text.trim()).then(() => {
    btn.classList.add("copied");
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => btn.classList.remove("copied"), 1800);
  });
}

/** The suites behind `npm run verify`, and what each one is actually for. */
const TEST_SUITES = [
  {
    cmd: "npm test",
    desc: "Core unit and integration suite (node:test). Crypto round-trips, the full keyfile lifecycle, cipher agility, paranoid mode, and the session/local-key lock races.",
  },
  {
    cmd: "npm run test:cli-e2e",
    desc: "The real CLI as a subprocess — the whole option matrix. This suite also carries the version-consistency assertions that keep package.json and the site's version literals in step.",
  },
  {
    cmd: "npm run test:gui",
    desc: "The real desktop app under Electron, plus Playwright. The only coverage of the preload bridge, the worker thread, and the native dialogs. Auto-provisions a virtual display when there is none; on Linux there is no headless mode that works, so this is Xvfb, not a flag.",
  },
  {
    cmd: "npm run test:a11y",
    desc: "WCAG 2.2 AA against the real renderer DOM, loaded same-origin in headless Chromium so the strict CSP is not weakened to accommodate the runner.",
  },
  {
    cmd: "npm run test:responsive",
    desc: "XS/SM/MD/LG/XL reflow. Runs in Chromium rather than Electron because the app window has a 640px minimum, which makes the narrow widths unreachable inside it.",
  },
  {
    cmd: "npm run test:perf",
    desc: "Asset budget and interaction cost.",
  },
  {
    cmd: "npm run test:site",
    desc: "This website: no CDN, no external requests, works over file://, every Tailwind-style class resolves to a real rule, and every command named in a Q&A recipe exists in the CLI.",
  },
  {
    cmd: "npm run verify",
    desc: "Build, then all of the above in the order CI runs them. Use this before opening a PR.",
  },
];

class DevApp {
  constructor(data) {
    this.data = data;
    this.el = {};
  }

  /** Cache DOM references and render everything. */
  init() {
    this.bindElements();
    this.renderPrereqs();
    this.renderSetup();
    this.renderTests();
    this.renderPackaging();
    this.renderArchitecture();
    this.renderFooter();
  }

  bindElements() {
    this.el.prereqs = document.getElementById("dev-prereqs");
    this.el.steps = document.getElementById("dev-steps");
    this.el.note = document.getElementById("dev-note");
    this.el.tests = document.getElementById("dev-tests");
    this.el.packaging = document.getElementById("dev-packaging");
    this.el.archTree = document.getElementById("arch-tree");
    this.el.footerMeta = document.getElementById("footer-meta");
  }

  /** Render the prerequisite list. */
  renderPrereqs() {
    if (!this.data.devSetup || !this.el.prereqs) return;
    const frag = document.createDocumentFragment();
    this.data.devSetup.prerequisites.forEach((text) => {
      // cloneTemplate returns the template's ROOT element, so the <li> *is*
      // `li` — querySelector would look at its descendants and find nothing.
      const li = cloneTemplate("prereq-tpl");
      li.dataset.field = "text";
      li.textContent = text;
      frag.append(li);
    });
    this.el.prereqs.replaceChildren(frag);
  }

  /**
   * Build one shell step: a titled block with a copy button.
   * @param {{title: string, code: string}} step
   * @returns {HTMLElement}
   */
  buildStep(step) {
    const el = cloneTemplate("dev-step-tpl");
    el.querySelector('[data-field="title"]').textContent = step.title;
    el.querySelector('[data-field="code"]').textContent = step.code;
    const copyBtn = el.querySelector(".copy-btn");
    copyBtn.addEventListener("click", () => copyCode(copyBtn, step.code));
    return el;
  }

  /** Render the build-from-source steps and their trailing note. */
  renderSetup() {
    const setup = this.data.devSetup;
    if (!setup || !this.el.steps) return;
    const frag = document.createDocumentFragment();
    setup.steps.forEach((step) => frag.append(this.buildStep(step)));
    this.el.steps.replaceChildren(frag);

    if (setup.note && this.el.note) {
      const note = document.createElement("div");
      note.className = "install-note mt-5";
      note.textContent = setup.note;
      this.el.note.replaceChildren(note);
    }
  }

  /** Render the test-suite table. */
  renderTests() {
    const frag = document.createDocumentFragment();
    TEST_SUITES.forEach((suite) => {
      const wrap = document.createElement("div");
      wrap.className = "test-suite";

      const cmd = document.createElement("div");
      cmd.className = "test-suite-cmd";
      cmd.textContent = suite.cmd;
      wrap.append(cmd);

      const desc = document.createElement("div");
      desc.className = "test-suite-desc";
      desc.textContent = suite.desc;
      wrap.append(desc);

      frag.append(wrap);
    });
    this.el.tests.replaceChildren(frag);
  }

  /** Render the packaging steps. */
  renderPackaging() {
    const steps = this.data.devSetup && this.data.devSetup.packaging;
    if (!steps || !this.el.packaging) return;
    const frag = document.createDocumentFragment();
    steps.forEach((step) => frag.append(this.buildStep(step)));
    this.el.packaging.replaceChildren(frag);
  }

  /** Render the source-tree walk. */
  renderArchitecture() {
    const frag = document.createDocumentFragment();
    this.data.architecture.forEach((mod) => {
      const moduleEl = cloneTemplate("arch-module-tpl");
      moduleEl.querySelector('[data-field="path"]').textContent = mod.path;
      moduleEl.querySelector('[data-field="desc"]').textContent = mod.desc;

      const filesContainer = moduleEl.querySelector(
        '[data-field="files-container"]',
      );
      const filesFrag = document.createDocumentFragment();
      mod.files.forEach((file) => {
        const fileEl = cloneTemplate("arch-file-tpl");
        fileEl.querySelector('[data-field="name"]').textContent = file.name;
        fileEl.querySelector('[data-field="desc"]').textContent = file.desc;
        filesFrag.append(fileEl);
      });
      filesContainer.replaceChildren(filesFrag);
      frag.append(moduleEl);
    });
    this.el.archTree.replaceChildren(frag);
  }

  /** Render the version/licence line. */
  renderFooter() {
    const { title, version, license } = this.data.meta;
    this.el.footerMeta.textContent = `${title} v${version} — ${license} License`;
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (!window.APP_DATA) return;
  new DevApp(window.APP_DATA).init();
});
