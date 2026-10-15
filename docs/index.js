/**
 * index.js — ShadowBit Documentation SPA
 * Single class App; boots on DOMContentLoaded; reads window.APP_DATA.
 * No ES modules, no build step, no fetch() of local JSON — safe over file://.
 */

/** Clone the first element inside <template id="…">. */
function cloneTemplate(id) {
  const tpl = document.getElementById(id);
  return tpl.content.firstElementChild.cloneNode(true);
}

/** Copy text to clipboard and flash a button.
 *
 * The ✓ state is pure CSS (`.copy-btn.copied`): swapping an inline SVG string
 * through `innerHTML` was the one place this file built markup as a string,
 * which docs/AGENTS.md forbids — and it is the kind of rule that gets broken
 * once and then copied into the next feature. */
function copyCode(btn, text) {
  navigator.clipboard.writeText(text.trim()).then(() => {
    btn.classList.add("copied");
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => btn.classList.remove("copied"), 1800);
  });
}

class App {
  constructor(data) {
    this.data = data;
    /** @type {string} active install tab id */
    this.activeInstall = data.installTabs[0].id;
    /** @type {string} active GUI tab id */
    this.activeGui = data.guiTabs[0].id;
    /** @type {string} CLI search query */
    this.cliQuery = "";
    /** @type {string} Q&A search query */
    this.faqQuery = "";
    /** @type {string|null} active Q&A category id, or null for "all" */
    this.faqCategory = null;
    this.el = {};
  }

  /** Cache DOM references and kick off everything. */
  init() {
    this.bindElements();
    this.renderHero();
    this.renderFeatures();
    this.renderUseCases();
    this.renderWorkflow();
    this.renderInstall();
    this.renderFaq();
    this.renderCli();
    this.renderGui();
    this.renderSecurity();
    this.renderArchitecture();
    this.renderFooter();
    this.bindEvents();
    this.initScrollSpy();
    this.initRevealObserver();
  }

  bindElements() {
    this.el.navbar = document.getElementById("navbar");
    this.el.mobileMenu = document.getElementById("mobile-menu");
    this.el.menuToggle = document.getElementById("menu-toggle");
    this.el.heroTagline = document.getElementById("hero-tagline");
    this.el.heroSubtagline = document.getElementById("hero-subtagline");
    this.el.featuresGrid = document.getElementById("features-grid");
    this.el.useCasesGrid = document.getElementById("use-cases-grid");
    this.el.workflowSteps = document.getElementById("workflow-steps");
    this.el.installTabs = document.getElementById("install-tabs");
    this.el.installPanels = document.getElementById("install-panels");
    this.el.faqSearch = document.getElementById("faq-search");
    this.el.faqFilters = document.getElementById("faq-filters");
    this.el.faqGroups = document.getElementById("faq-groups");
    this.el.faqEmpty = document.getElementById("faq-empty");
    this.el.cliSearch = document.getElementById("cli-search");
    this.el.cliTable = document.getElementById("cli-table");
    this.el.guiTabBar = document.getElementById("gui-tab-bar");
    this.el.guiContent = document.getElementById("gui-content");
    this.el.securityGrid = document.getElementById("security-grid");
    this.el.archTree = document.getElementById("arch-tree");
    this.el.footerMeta = document.getElementById("footer-meta");
  }

  // ─── Hero ───────────────────────────────────────────────────────────
  renderHero() {
    const { tagline, subTagline } = this.data.meta;
    this.el.heroTagline.textContent = tagline;
    this.el.heroSubtagline.textContent = subTagline;
  }

  // ─── Features ───────────────────────────────────────────────────────
  renderFeatures() {
    const frag = document.createDocumentFragment();
    this.data.features.forEach((f, i) => {
      const card = cloneTemplate("feature-card-tpl");
      card.querySelector('[data-field="icon"]').textContent = f.icon;
      card.querySelector('[data-field="title"]').textContent = f.title;
      card.querySelector('[data-field="desc"]').textContent = f.desc;
      card.classList.add("reveal");
      if (i < 4) card.classList.add(`reveal-delay-${(i % 4) + 1}`);
      frag.append(card);
    });
    this.el.featuresGrid.replaceChildren(frag);
  }

  // ─── Use Cases ───────────────────────────────────────────────────────
  renderUseCases() {
    if (!this.data.useCases || !this.el.useCasesGrid) return;
    const frag = document.createDocumentFragment();
    this.data.useCases.forEach((uc, i) => {
      const card = cloneTemplate("use-case-card-tpl");
      card.querySelector('[data-field="icon"]').textContent = uc.icon;
      card.querySelector('[data-field="title"]').textContent = uc.title;
      card.querySelector('[data-field="desc"]').textContent = uc.desc;
      card.querySelector('[data-field="audience"]').textContent = uc.audience;
      card.classList.add("reveal");
      if (i < 4) card.classList.add(`reveal-delay-${(i % 4) + 1}`);
      frag.append(card);
    });
    this.el.useCasesGrid.replaceChildren(frag);
  }

  // ─── Workflow ────────────────────────────────────────────────────────
  renderWorkflow() {
    const frag = document.createDocumentFragment();
    this.data.workflow.forEach((s, i) => {
      const step = cloneTemplate("workflow-step-tpl");
      step.querySelector('[data-field="step"]').textContent = s.step;
      step.querySelector('[data-field="icon"]').textContent = s.icon;
      step.querySelector('[data-field="title"]').textContent = s.title;
      step.querySelector('[data-field="desc"]').textContent = s.desc;
      step.querySelector('[data-field="code"]').textContent = s.code;
      step.classList.add("reveal", `reveal-delay-${i + 1}`);
      frag.append(step);
    });
    this.el.workflowSteps.replaceChildren(frag);
  }

  // ─── Installation ────────────────────────────────────────────────────
  renderInstall() {
    // Tab buttons
    const tabFrag = document.createDocumentFragment();
    this.data.installTabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "install-tab-btn";
      btn.dataset.tab = tab.id;
      btn.id = `install-tab-${tab.id}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(tab.id === this.activeInstall));
      btn.setAttribute("aria-controls", `install-panel-${tab.id}`);
      // Roving tabindex: only the active tab is in the tab order, so Tab
      // moves past the widget and arrow keys move between tabs.
      btn.tabIndex = tab.id === this.activeInstall ? 0 : -1;
      btn.textContent = `${tab.icon} ${tab.label}`;
      if (tab.id === this.activeInstall) btn.classList.add("active");
      tabFrag.append(btn);
    });
    this.el.installTabs.replaceChildren(tabFrag);

    // Panels
    const panelFrag = document.createDocumentFragment();
    this.data.installTabs.forEach((tab) => {
      const panel = document.createElement("div");
      panel.className = "install-panel";
      panel.dataset.panel = tab.id;
      panel.id = `install-panel-${tab.id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `install-tab-${tab.id}`);
      panel.tabIndex = 0;
      if (tab.id === this.activeInstall) panel.classList.add("active");

      // Steps
      tab.steps.forEach((step) => {
        const stepEl = cloneTemplate("install-step-tpl");
        stepEl.querySelector('[data-field="title"]').textContent = step.title;
        const codeEl = stepEl.querySelector('[data-field="code"]');
        codeEl.textContent = step.code;
        // Wire copy button
        const copyBtn = stepEl.querySelector(".copy-btn");
        copyBtn.addEventListener("click", () => copyCode(copyBtn, step.code));
        panel.append(stepEl);
      });

      // Note
      if (tab.note) {
        const note = document.createElement("div");
        note.className = "install-note";
        note.textContent = tab.note;
        panel.append(note);
      }

      panelFrag.append(panel);
    });
    this.el.installPanels.replaceChildren(panelFrag);
  }

  /** Switch the active install tab. */
  switchInstallTab(id) {
    this.activeInstall = id;
    this.el.installTabs.querySelectorAll(".install-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
    });
    this.el.installPanels.querySelectorAll(".install-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.panel === id);
    });
  }

  /**
   * Arrow-key navigation for a tablist (WAI-ARIA tabs pattern).
   * Left/Right move and select, wrapping at the ends; Home/End jump to the
   * first/last tab. The tablist owns the handler, so it works for tabs added
   * later without re-binding.
   */
  bindTabKeys(container, selector) {
    if (!container) return;
    container.addEventListener("keydown", (e) => {
      const btn = e.target.closest(selector);
      if (!btn) return;
      const tabs = Array.from(container.querySelectorAll(selector));
      const i = tabs.indexOf(btn);
      let target = null;
      if (e.key === "ArrowRight") target = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft")
        target = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") target = tabs[0];
      else if (e.key === "End") target = tabs[tabs.length - 1];
      else return;
      e.preventDefault();
      target.focus();
      target.click();
    });
  }

  // ─── Q&A ─────────────────────────────────────────────────────────────
  /**
   * Render the category chips and every question as a <details> accordion.
   *
   * Filtering is done here rather than by re-rendering so that a search typed
   * mid-answer does not collapse the open items out from under the reader.
   * Each item's searchable text is stashed in `dataset.search` once, at build
   * time, for the same reason the CLI rows do it.
   */
  renderFaq() {
    const groups = this.data.qa || [];
    if (!groups.length) return;

    // Chips: "All" plus one per group, each showing how many questions it holds.
    const filterFrag = document.createDocumentFragment();
    const makeChip = (id, icon, label, count) => {
      // cloneTemplate returns the template's ROOT element, so the button *is*
      // `btn` — querying for it as a descendant returns null.
      const btn = cloneTemplate("faq-filter-tpl");
      btn.dataset.category = id;
      btn.querySelector('[data-field="label"]').textContent =
        `${icon} ${label}`.trim();
      btn.querySelector('[data-field="count"]').textContent = String(count);
      btn.setAttribute("aria-pressed", String(this.faqCategory === id));
      btn.classList.toggle("active", this.faqCategory === id);
      filterFrag.append(btn);
    };
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    makeChip("all", "", "All", total);
    groups.forEach((g) => makeChip(g.id, g.icon, g.label, g.items.length));
    this.el.faqFilters.replaceChildren(filterFrag);

    // Groups.
    const groupFrag = document.createDocumentFragment();
    groups.forEach((g) => {
      const groupEl = cloneTemplate("faq-group-tpl");
      // cloneTemplate returns the template's ROOT element, so the group div
      // *is* `groupEl` — do not look for it as a descendant.
      groupEl.dataset.category = g.id;
      groupEl.querySelector('[data-field="icon"]').textContent = g.icon;
      groupEl.querySelector('[data-field="label"]').textContent = g.label;
      groupEl.querySelector('[data-field="blurb"]').textContent = g.blurb;

      const itemsEl = groupEl.querySelector('[data-field="items-container"]');
      const itemsFrag = document.createDocumentFragment();
      g.items.forEach((item) => itemsFrag.append(this.buildFaqItem(item)));
      itemsEl.replaceChildren(itemsFrag);
      groupFrag.append(groupEl);
    });
    this.el.faqGroups.replaceChildren(groupFrag);
  }

  /** Build one <details> question. Returns the element. */
  buildFaqItem(item) {
    const el = cloneTemplate("faq-item-tpl");
    el.querySelector('[data-field="q"]').textContent = item.q;

    const parasEl = el.querySelector('[data-field="paras-container"]');
    const parasFrag = document.createDocumentFragment();
    (item.a || []).forEach((text) => {
      const p = document.createElement("p");
      p.className = "faq-a-p";
      p.textContent = text;
      parasFrag.append(p);
    });
    parasEl.replaceChildren(parasFrag);

    // The code block and the note are optional; hide the wrapper rather than
    // cloning variants of the template.
    const codeWrapper = el.querySelector('[data-field="code-wrapper"]');
    if (item.code) {
      el.querySelector('[data-field="code"]').textContent = item.code;
      const copyBtn = codeWrapper.querySelector(".copy-btn");
      copyBtn.addEventListener("click", () => copyCode(copyBtn, item.code));
    } else {
      codeWrapper.hidden = true;
    }

    const noteEl = el.querySelector('[data-field="note"]');
    if (item.note) {
      noteEl.dataset.tone = item.note.tone || "info";
      noteEl.querySelector('[data-field="note-icon"]').textContent =
        item.note.tone === "warn" ? "⚠️" : "ℹ️";
      noteEl.querySelector('[data-field="note-text"]').textContent =
        item.note.text;
    } else {
      noteEl.hidden = true;
    }

    // Question + answer text, so the filter matches on what someone searches
    // for ("keyfile") and not only on the wording of the question line.
    el.dataset.search = [item.q]
      .concat(item.a || [], item.code ? [item.code] : [])
      .join(" ")
      .toLowerCase();
    return el;
  }

  /**
   * Show only the questions matching the current query and category.
   *
   * A group whose questions are all filtered out is hidden entirely — four
   * headings with nothing under them reads as a broken page rather than a
   * filtered one.
   */
  filterFaq() {
    const q = this.faqQuery.toLowerCase().trim();
    let shown = 0;
    this.el.faqGroups.querySelectorAll(".faq-group").forEach((groupEl) => {
      const inCategory =
        !this.faqCategory ||
        this.faqCategory === "all" ||
        groupEl.dataset.category === this.faqCategory;
      let shownHere = 0;
      groupEl.querySelectorAll(".faq-item").forEach((item) => {
        const match = inCategory && (!q || item.dataset.search.includes(q));
        item.classList.toggle("hidden-row", !match);
        if (match) shownHere++;
      });
      groupEl.hidden = shownHere === 0;
      shown += shownHere;
    });
    if (this.el.faqEmpty) this.el.faqEmpty.hidden = shown > 0;
  }

  /** Select a Q&A category, or "all", and re-filter. */
  switchFaqCategory(id) {
    this.faqCategory = id;
    this.el.faqFilters.querySelectorAll(".faq-filter-btn").forEach((btn) => {
      const active = btn.dataset.category === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    this.filterFaq();
  }

  // ─── CLI Table ───────────────────────────────────────────────────────
  renderCli() {
    const frag = document.createDocumentFragment();
    this.data.commands.forEach((cmd) => {
      const row = cloneTemplate("cli-row-tpl");
      row.querySelector('[data-field="cmd"]').textContent = cmd.cmd;
      row.querySelector('[data-field="desc"]').textContent = cmd.desc;
      row.querySelector('[data-field="example"]').textContent = cmd.example;

      const flagsWrapper = row.querySelector('[data-field="flags-wrapper"]');
      if (cmd.flags) {
        row.querySelector('[data-field="flags"]').textContent = cmd.flags;
      } else {
        flagsWrapper.hidden = true;
      }

      // Copy button wired to example
      const copyBtn = row.querySelector(".copy-btn-sm");
      copyBtn.addEventListener("click", () => copyCode(copyBtn, cmd.example));

      // Store search text on element for quick filtering
      row.dataset.search = `${cmd.cmd} ${cmd.desc} ${cmd.flags}`.toLowerCase();
      frag.append(row);
    });
    this.el.cliTable.replaceChildren(frag);
  }

  /** Filter CLI rows by search query. */
  filterCli(query) {
    const q = query.toLowerCase().trim();
    this.el.cliTable.querySelectorAll(".cli-row").forEach((row) => {
      const match = !q || row.dataset.search.includes(q);
      row.classList.toggle("hidden-row", !match);
    });
  }

  // ─── GUI ─────────────────────────────────────────────────────────────
  renderGui() {
    // Tab bar
    const tabFrag = document.createDocumentFragment();
    this.data.guiTabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gui-tab-btn";
      btn.dataset.tab = tab.id;
      btn.id = `gui-tab-${tab.id}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(tab.id === this.activeGui));
      btn.setAttribute("aria-controls", `gui-panel-${tab.id}`);
      btn.tabIndex = tab.id === this.activeGui ? 0 : -1;
      btn.textContent = `${tab.icon} ${tab.label}`;
      if (tab.id === this.activeGui) btn.classList.add("active");
      tabFrag.append(btn);
    });
    this.el.guiTabBar.replaceChildren(tabFrag);

    // Content panels
    const contentFrag = document.createDocumentFragment();
    this.data.guiTabs.forEach((tab) => {
      const panel = document.createElement("div");
      panel.className = "gui-panel";
      panel.dataset.panel = tab.id;
      panel.id = `gui-panel-${tab.id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `gui-tab-${tab.id}`);
      panel.tabIndex = 0;
      if (tab.id === this.activeGui) panel.classList.add("active");

      const desc = document.createElement("p");
      desc.className = "gui-panel-desc";
      desc.textContent = tab.desc;
      panel.append(desc);

      // Add a decorative mock UI for each tab
      panel.append(this.buildGuiMock(tab.id));
      contentFrag.append(panel);
    });
    this.el.guiContent.replaceChildren(contentFrag);
  }

  /** Build a simple decorative mock UI for a GUI tab. */
  buildGuiMock(tabId) {
    const mock = document.createElement("div");
    mock.className = "gui-mock";

    const configs = {
      open: [
        { label: "Vault file", value: "📄 project.svlt" },
        { label: "Password", value: "••••••••••••" },
      ],
      create: [
        { label: "Save as", value: "📄 secrets.svlt" },
        { label: "Password", value: "••••••••••••" },
        { label: "Confirm password", value: "••••••••••••" },
        { label: "Seed from folder (optional)", value: "📁 ~/Documents/…" },
      ],
      manage: [
        { label: "Vault file", value: "📄 project.svlt" },
        { label: "Current password", value: "••••••••••••" },
        { label: "New password", value: "••••••••••••" },
      ],
      sessions: [
        {
          label: "Open vault",
          value: "📄 project.svlt  →  /tmp/shadow-bit/project-a1b2c3",
        },
        { label: "Drop zone", value: "🗂 Drag files here to add them" },
      ],
    };

    const fields = configs[tabId] || [];
    fields.forEach((f) => {
      const row = document.createElement("div");
      row.className = "gui-mock-row";

      const lbl = document.createElement("div");
      lbl.className = "gui-mock-label";
      lbl.textContent = f.label;
      row.append(lbl);

      const inp = document.createElement("div");
      inp.className = "gui-mock-input";
      inp.textContent = f.value;
      row.append(inp);

      mock.append(row);
    });

    // Action button
    const btnLabels = {
      open: "🔓 Open Vault",
      create: "✨ Create Vault",
      manage: "⚙️ Apply Changes",
      sessions: "🔒 Close & Save",
    };
    const btn = document.createElement("div");
    btn.className = "gui-mock-btn";
    btn.textContent = btnLabels[tabId] || "Submit";
    mock.append(btn);

    return mock;
  }

  /** Switch the active GUI tab. Keeps aria-selected and the roving tabindex in sync. */
  switchGuiTab(id) {
    this.activeGui = id;
    this.el.guiTabBar.querySelectorAll(".gui-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === id;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
    });
    this.el.guiContent.querySelectorAll(".gui-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.panel === id);
    });
  }

  // ─── Security ────────────────────────────────────────────────────────
  renderSecurity() {
    const frag = document.createDocumentFragment();
    this.data.security.forEach((item) => {
      const card = cloneTemplate("security-card-tpl");
      card.querySelector('[data-field="icon"]').textContent = item.icon;
      card.querySelector('[data-field="label"]').textContent = item.label;
      card.querySelector('[data-field="value"]').textContent = item.value;
      card.querySelector('[data-field="detail"]').textContent = item.detail;
      card.classList.add("reveal");
      frag.append(card);
    });
    this.el.securityGrid.replaceChildren(frag);
  }

  // ─── Architecture ────────────────────────────────────────────────────
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

  // ─── Footer ──────────────────────────────────────────────────────────
  renderFooter() {
    const { title, version, license } = this.data.meta;
    this.el.footerMeta.textContent = `${title} v${version} — ${license} License`;
  }

  // ─── Events ──────────────────────────────────────────────────────────
  bindEvents() {
    // Mobile menu toggle
    this.el.menuToggle.addEventListener("click", () => {
      const hidden = this.el.mobileMenu.classList.toggle("hidden");
      this.el.menuToggle.setAttribute("aria-expanded", String(!hidden));
    });

    // Close mobile menu on link click
    this.el.mobileMenu.querySelectorAll(".mobile-nav-link").forEach((a) => {
      a.addEventListener("click", () => {
        this.el.mobileMenu.classList.add("hidden");
      });
    });

    // Navbar scroll effect
    window.addEventListener(
      "scroll",
      () => {
        this.el.navbar.classList.toggle("scrolled", window.scrollY > 10);
      },
      { passive: true },
    );

    // Install tab clicks (delegated)
    this.el.installTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".install-tab-btn");
      if (btn) this.switchInstallTab(btn.dataset.tab);
    });

    // GUI tab clicks (delegated)
    this.el.guiTabBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".gui-tab-btn");
      if (btn) this.switchGuiTab(btn.dataset.tab);
    });

    // Arrow-key navigation for both tablists (WAI-ARIA tabs pattern).
    this.bindTabKeys(this.el.installTabs, ".install-tab-btn");
    this.bindTabKeys(this.el.guiTabBar, ".gui-tab-btn");

    // CLI search
    this.el.cliSearch.addEventListener("input", (e) => {
      this.cliQuery = e.target.value;
      this.filterCli(this.cliQuery);
    });

    // Q&A search
    this.el.faqSearch.addEventListener("input", (e) => {
      this.faqQuery = e.target.value;
      this.filterFaq();
    });

    // Q&A category chips (delegated)
    this.el.faqFilters.addEventListener("click", (e) => {
      const btn = e.target.closest(".faq-filter-btn");
      if (btn) this.switchFaqCategory(btn.dataset.category);
    });
  }

  // ─── Scroll spy ──────────────────────────────────────────────────────
  initScrollSpy() {
    const navLinks = document.querySelectorAll(".nav-link");
    // Observe exactly the sections the nav actually links to. A hardcoded id
    // list silently stopped highlighting #workflows when it was added, and
    // would break again on the next reorder.
    const sections = Array.from(
      new Set(
        Array.from(navLinks)
          .map((l) => l.getAttribute("href") ?? "")
          .filter((h) => h.startsWith("#"))
          .map((h) => document.querySelector(h))
          .filter(Boolean),
      ),
    );

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            navLinks.forEach((link) => {
              const href = link.getAttribute("href");
              link.classList.toggle("active", href === `#${id}`);
            });
          }
        });
      },
      { rootMargin: "-30% 0px -65% 0px" },
    );

    sections.forEach((s) => observer.observe(s));
  }

  // ─── Reveal on scroll ────────────────────────────────────────────────
  initRevealObserver() {
    const revealEls = document.querySelectorAll(".reveal");
    if (!revealEls.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 },
    );

    revealEls.forEach((el) => observer.observe(el));
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  if (!window.APP_DATA) {
    const errEl = document.getElementById("loadError");
    if (errEl) errEl.removeAttribute("hidden");
    return;
  }
  new App(window.APP_DATA).init();
});
