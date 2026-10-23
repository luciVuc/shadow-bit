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

/**
 * Build the expandable body of a gatekeeper-style walkthrough: intro text,
 * then one titled figure per step (desc + screenshot). Screenshot paths and
 * captions come from data.js so the text and assets are versioned together.
 */
function buildGuideBody(guide) {
  const body = document.createElement("div");
  body.className = "install-guide-body";
  if (guide.intro) {
    const intro = document.createElement("p");
    intro.className = "install-guide-intro";
    intro.textContent = guide.intro;
    body.append(intro);
  }
  const steps = document.createElement("ol");
  steps.className = "install-guide-steps";
  guide.steps.forEach((step) => {
    const li = document.createElement("li");
    li.className = "install-guide-step";
    const heading = document.createElement("h4");
    heading.className = "install-guide-step-title";
    heading.textContent = step.title;
    const desc = document.createElement("p");
    desc.className = "install-guide-step-desc";
    desc.textContent = step.desc;
    li.append(heading, desc);
    if (step.img) {
      const figure = document.createElement("figure");
      figure.className = "install-guide-figure";
      const img = document.createElement("img");
      img.src = step.img;
      img.alt = step.alt || "";
      img.loading = "lazy";
      figure.append(img);
      if (step.caption) {
        const caption = document.createElement("figcaption");
        caption.textContent = step.caption;
        figure.append(caption);
      }
      li.append(figure);
    }
    steps.append(li);
  });
  body.append(steps);
  return body;
}

class App {
  constructor(data) {
    this.data = data;
    /** @type {string} active platform tab id */
    this.activePlatform = data.platforms[0].id;
    /** @type {boolean} whether the download section has been rendered once */
    this.openedPlatform = false;
    /** @type {string} the platform the user agent suggests, kept separately
     *  from the active tab so the "your platform" badge stays put when the
     *  visitor switches tabs — it describes their machine, not what is open. */
    this.detectedPlatform = data.platforms[0].id;
    /** @type {string} the version the download buttons currently point at */
    this.selectedVersion = data.meta.version;
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
    this.renderAgentSkill();
    this.renderSecurity();
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
    this.el.versionPicker = document.getElementById("version-picker");
    this.el.installTabs = document.getElementById("install-tabs");
    this.el.installPanels = document.getElementById("install-panels");
    this.el.allReleases = document.getElementById("all-releases");
    this.el.cliInstall = document.getElementById("cli-install");
    this.el.faqSearch = document.getElementById("faq-search");
    this.el.faqFilters = document.getElementById("faq-filters");
    this.el.faqGroups = document.getElementById("faq-groups");
    this.el.faqEmpty = document.getElementById("faq-empty");
    this.el.cliSearch = document.getElementById("cli-search");
    this.el.cliTable = document.getElementById("cli-table");
    this.el.guiTabBar = document.getElementById("gui-tab-bar");
    this.el.guiContent = document.getElementById("gui-content");
    this.el.agentIntro = document.getElementById("agent-intro");
    this.el.agentCards = document.getElementById("agent-cards");
    this.el.agentInstall = document.getElementById("agent-install");
    this.el.agentManual = document.getElementById("agent-manual");
    this.el.agentVerify = document.getElementById("agent-verify");
    this.el.securityGrid = document.getElementById("security-grid");
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

  // ─── Download ────────────────────────────────────────────────────────
  /**
   * Every selectable version, newest first: the current app version, then the
   * releases listed in data.js.
   *
   * The current version is derived from `meta.version` rather than listed
   * alongside the history. `npm version` rewrites every version-shaped literal
   * in data.js, so keeping the current one in that array would mean a bump
   * also rewrote 1.0.0 → the new version — the site would advertise a download
   * for a build that does not exist and lose the real one.
   *
   * The history entries are keyed `release`, not `version`: see the comment in
   * data.js. Renaming the key back would put them in range of `npm version`.
   *
   * @returns {{version: string, released?: string, notes?: string, current?: boolean}[]}
   */
  allVersions() {
    const current = { version: this.data.meta.version, current: true };
    const history = (this.data.releases.versions || []).map((entry) => ({
      version: entry.release,
      released: entry.released,
      notes: entry.notes,
    }));
    return [current].concat(history);
  }

  /**
   * Guess the visitor's platform from the user agent so the matching tab is
   * open on arrival. This is a convenience, never a gate: every platform stays
   * one click away, and the guess is a hint the visitor can ignore.
   *
   * @returns {string} a platform id, defaulting to the first one.
   */
  detectPlatform() {
    const ua = (
      (window.navigator && window.navigator.userAgent) ||
      ""
    ).toLowerCase();
    const platform = String(
      (window.navigator && window.navigator.platform) || "",
    ).toLowerCase();
    const haystack = `${ua} ${platform}`;
    const match = this.data.platforms.find((p) =>
      (p.detect || []).some((token) => haystack.includes(token)),
    );
    return match ? match.id : this.data.platforms[0].id;
  }

  /**
   * The download URL for one artifact.
   *
   * Assembled from the repository URL + tag rather than written out by hand:
   * a hand-written link is exactly the thing that survives a version bump and
   * then 404s, and nothing in the site would notice.
   *
   * Artifact names embed their version (ShadowBit-1.1.3.AppImage), so the
   * names are written against the current version and re-stamped here when the
   * visitor picks an older one. Substituting on the version *string* is why
   * this works: the names live in data.js as literals that `npm version`
   * rewrites in place, rather than as templates the bump script cannot see.
   *
   * @param {string} file artifact file name, e.g. "ShadowBit-1.1.3.AppImage".
   * @param {string} version the tag version to fetch it from.
   * @returns {string} an absolute URL.
   */
  downloadUrl(file, version) {
    const name = this.stampVersion(file, version);
    return `${this.data.releases.repo}/releases/download/v${version}/${encodeURIComponent(name)}`;
  }

  /** Re-stamp an artifact name written against the current version. */
  stampVersion(file, version) {
    const current = this.data.meta.version;
    return version === current ? file : file.split(current).join(version);
  }

  /** The artifact name for the version currently selected. */
  downloadFileName(file) {
    return this.stampVersion(file, this.selectedVersion);
  }

  /** Release page for one version — where the checksums and every artifact live. */
  releasePageUrl(version) {
    return `${this.data.releases.repo}/releases/tag/v${version}`;
  }

  /**
   * Render the version selector, the platform tabs, one panel per platform,
   * and the "all releases" footer. Called again whenever the selected version
   * changes, which is why it rebuilds rather than mutates.
   */
  renderInstall() {
    this.detectedPlatform = this.detectPlatform();
    // Open on the detected platform the first time. On a version change the
    // whole section is re-rendered, so the visitor's open tab is preserved —
    // losing their place because they picked an older build would be a small,
    // very avoidable annoyance.
    if (!this.openedPlatform) {
      this.activePlatform = this.detectedPlatform;
      this.openedPlatform = true;
    }
    this.renderVersionPicker();

    // Tab buttons
    const tabFrag = document.createDocumentFragment();
    this.data.platforms.forEach((platform) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "install-tab-btn";
      btn.dataset.tab = platform.id;
      btn.id = `install-tab-${platform.id}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute(
        "aria-selected",
        String(platform.id === this.activePlatform),
      );
      btn.setAttribute("aria-controls", `install-panel-${platform.id}`);
      // Roving tabindex: only the active tab is in the tab order, so Tab
      // moves past the widget and arrow keys move between tabs.
      btn.tabIndex = platform.id === this.activePlatform ? 0 : -1;
      btn.textContent = `${platform.icon} ${platform.label}`;
      if (platform.id === this.activePlatform) btn.classList.add("active");
      // The badge marks the *detected* platform, not the open tab: it tells
      // the visitor which tab is theirs, and stays put when they browse the
      // others. A hint, never a filter — every tab remains visible.
      if (platform.id === this.detectedPlatform) {
        const tag = document.createElement("span");
        tag.className = "install-tab-badge";
        tag.textContent = "your platform";
        btn.append(tag);
      }
      tabFrag.append(btn);
    });
    this.el.installTabs.replaceChildren(tabFrag);

    // Panels
    const panelFrag = document.createDocumentFragment();
    this.data.platforms.forEach((platform) => {
      const panel = document.createElement("div");
      panel.className = "install-panel";
      panel.dataset.panel = platform.id;
      panel.id = `install-panel-${platform.id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `install-tab-${platform.id}`);
      panel.tabIndex = 0;
      if (platform.id === this.activePlatform) panel.classList.add("active");

      const heading = document.createElement("div");
      heading.className = "install-panel-heading";
      heading.textContent = `Download for ${platform.label}`;
      panel.append(heading);

      // Download buttons
      const buildsWrap = document.createElement("div");
      buildsWrap.className = "download-builds";
      platform.builds.forEach((build) => {
        const a = cloneTemplate("download-build-tpl");
        a.querySelector('[data-field="label"]').textContent = build.label;
        a.querySelector('[data-field="format"]').textContent = build.format;
        a.querySelector('[data-field="arch"]').textContent = build.arch || "";
        a.querySelector('[data-field="size"]').textContent = build.size || "";
        const action = a.querySelector('[data-field="action"]');
        action.textContent = `Download ${this.selectedVersion}`;
        a.href = this.downloadUrl(build.file, this.selectedVersion);
        // The visible label names the version; the accessible name must too,
        // or a screen reader announces a link that gives no version away.
        a.setAttribute(
          "aria-label",
          `${build.label}, ${build.format}, version ${this.selectedVersion}`,
        );
        a.setAttribute("download", "");
        if (build.primary) a.classList.add("primary");
        buildsWrap.append(a);
      });
      panel.append(buildsWrap);

      // Steps — what to do with the file that was just downloaded.
      //
      // `{file}` in a step's title/desc/code is replaced with the file the
      // visitor is actually about to have: for Linux that is the AppImage, and
      // its name embeds the version, so `chmod +x "ShadowBit-1.1.3.AppImage"`
      // must not keep naming a build they did not download when they pick
      // 1.1.0 from the version chips.
      const primaryFile = platform.builds.find((b) => b.primary);
      const steps = document.createElement("ol");
      steps.className = "install-steps";
      platform.steps.forEach((step, i) => {
        const stepEl = cloneTemplate("install-step-tpl");
        const stamp = (text) =>
          primaryFile
            ? text.split("{file}").join(this.downloadFileName(primaryFile.file))
            : text;
        stepEl.querySelector('[data-field="num"]').textContent = String(i + 1);
        stepEl.querySelector('[data-field="title"]').textContent = stamp(
          step.title,
        );
        stepEl.querySelector('[data-field="desc"]').textContent = stamp(
          step.desc,
        );
        // The Linux AppImage steps carry a command; the rest do not, so the
        // code wrapper is hidden rather than cloning a template variant.
        const codeWrapper = stepEl.querySelector('[data-field="code-wrapper"]');
        if (step.code) {
          const code = stamp(step.code);
          stepEl.querySelector('[data-field="code"]').textContent = code;
          const copyBtn = stepEl.querySelector(".copy-btn");
          copyBtn.addEventListener("click", () => copyCode(copyBtn, code));
        } else {
          codeWrapper.hidden = true;
        }
        steps.append(stepEl);
      });
      panel.append(steps);

      // Note — plain string, or an object carrying an expandable guide
      // (the macOS Gatekeeper walkthrough). Either way the note text is the
      // visible part; the guide is collapsed behind a <details> so the
      // default install panel stays small.
      if (platform.note) {
        const note =
          typeof platform.note === "string"
            ? { text: platform.note }
            : platform.note;
        if (note.guide) {
          const details = document.createElement("details");
          details.className = "install-guide";
          const summary = document.createElement("summary");
          summary.className = "install-note install-guide-summary";
          const text = document.createElement("span");
          text.className = "install-guide-summary-text";
          text.textContent = note.text;
          const marker = document.createElement("span");
          // Same affordance the Q&A accordion uses (chevron + focusable
          // summary), so expanding behaves the same everywhere on the page.
          marker.className = "faq-marker";
          marker.setAttribute("aria-hidden", "true");
          summary.append(text, marker);
          details.append(summary, buildGuideBody(note.guide));
          panel.append(details);
        } else {
          const noteEl = document.createElement("div");
          noteEl.className = "install-note";
          noteEl.textContent = note.text;
          panel.append(noteEl);
        }
      }

      // Release page link — where checksums and every other artifact for this
      // version live, and the fallback if a direct link 404s.
      const relLink = document.createElement("a");
      relLink.className = "install-release-link";
      relLink.href = this.releasePageUrl(this.selectedVersion);
      relLink.textContent = `All downloads and checksums for v${this.selectedVersion}`;
      panel.append(relLink);

      panelFrag.append(panel);
    });
    this.el.installPanels.replaceChildren(panelFrag);
    this.renderAllReleases();
    this.renderCliInstall();
  }

  /**
   * The command-line install, rendered as its own block beneath the desktop
   * downloads. The desktop app is the primary path; this exists because a
   * meaningful share of visitors arrive from a terminal and should not have to
   * scroll past three tabs to find the one line they need.
   */
  renderCliInstall() {
    const { cliInstall } = this.data;
    if (!cliInstall || !this.el.cliInstall) return;

    const box = document.createElement("div");
    box.className = "cli-install-inner";

    const title = document.createElement("div");
    title.className = "install-panel-heading";
    title.textContent = cliInstall.title;
    box.append(title);

    const desc = document.createElement("p");
    desc.className = "cli-install-desc";
    desc.textContent = cliInstall.desc;
    box.append(desc);

    const codeWrap = document.createElement("div");
    codeWrap.className = "install-step-code-wrapper";
    // Cloned from a template rather than assembled element-by-element: the
    // inline SVG is markup, and the only reason to build it in JS is to avoid
    // a template — so use the template.
    const copyBtn = cloneTemplate("copy-btn-tpl");
    copyBtn.setAttribute("aria-label", "Copy install command");
    copyBtn.addEventListener("click", () => copyCode(copyBtn, cliInstall.code));

    const pre = document.createElement("pre");
    pre.className = "install-code";
    const code = document.createElement("code");
    code.textContent = cliInstall.code;
    pre.append(code);

    codeWrap.append(copyBtn, pre);
    box.append(codeWrap);

    if (cliInstall.note) {
      const note = document.createElement("div");
      note.className = "install-note";
      note.textContent = cliInstall.note;
      box.append(note);
    }

    const relLink = document.createElement("a");
    relLink.className = "install-release-link";
    relLink.href = `${this.data.releases.repo}/releases`;
    relLink.textContent = "Or download a CLI release archive";
    box.append(relLink);

    this.el.cliInstall.replaceChildren(box);
  }

  /** Render the "which version do you want" chips. */
  renderVersionPicker() {
    const wrap = document.createElement("div");
    wrap.className = "version-picker-inner";

    const label = document.createElement("span");
    label.className = "version-picker-label";
    label.id = "version-picker-label";
    label.textContent = "Version";
    wrap.append(label);

    const group = document.createElement("div");
    group.className = "version-picker-options";
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", "version-picker-label");

    this.allVersions().forEach((entry) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "version-chip";
      btn.dataset.version = entry.version;
      btn.setAttribute(
        "aria-pressed",
        String(entry.version === this.selectedVersion),
      );
      btn.textContent = entry.current
        ? `${entry.version} (latest)`
        : entry.version;
      if (entry.version === this.selectedVersion) btn.classList.add("active");
      group.append(btn);
    });
    wrap.append(group);

    const hint = document.createElement("p");
    hint.className = "version-picker-hint";
    hint.textContent =
      "Older releases stay downloadable — useful if a newer build breaks something on your machine.";
    wrap.append(hint);

    this.el.versionPicker.replaceChildren(wrap);
  }

  /** Render the release history list under the panels. */
  renderAllReleases() {
    const wrap = document.createElement("div");
    wrap.className = "all-releases-inner";

    const heading = document.createElement("div");
    heading.className = "install-panel-heading";
    heading.textContent = "Every past release";
    wrap.append(heading);

    const list = document.createElement("ul");
    list.className = "release-list";
    this.allVersions().forEach((entry) => {
      const item = document.createElement("li");
      item.className = "release-item";

      const link = document.createElement("a");
      link.className = "release-link";
      link.href = this.releasePageUrl(entry.version);
      link.textContent = `v${entry.version}`;
      item.append(link);

      const meta = document.createElement("span");
      meta.className = "release-meta";
      meta.textContent = entry.released ? entry.released : entry.notes || "";
      item.append(meta);

      if (entry.version === this.selectedVersion) {
        const cur = document.createElement("span");
        cur.className = "release-current";
        cur.textContent = "selected";
        item.append(cur);
      }
      list.append(item);
    });
    wrap.append(list);

    const link = document.createElement("a");
    link.className = "install-release-link";
    link.href = `${this.data.releases.repo}/releases`;
    link.textContent = "Browse all releases on GitHub";
    wrap.append(link);

    this.el.allReleases.replaceChildren(wrap);
  }

  /** Switch the active platform tab. */
  switchInstallTab(id) {
    this.activePlatform = id;
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
   * Point every download button at a different version. The whole section is
   * re-rendered rather than patched: the links, the step copy and the release
   * list all mention the version, and a partial update is how one of them
   * silently keeps pointing at the previous build.
   */
  selectVersion(version) {
    this.selectedVersion = version;
    this.renderInstall();
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

    // Some answers carry a screenshot walkthrough (the Gatekeeper bypass);
    // rendered collapsed inside <details> so a long answer does not dominate
    // the accordion — expanding follows the browser's own <summary> semantics.
    if (item.guide) {
      const guide = document.createElement("details");
      guide.className = "install-guide faq-guide";
      const summary = document.createElement("summary");
      summary.textContent = guide.title || "Step-by-step walkthrough";
      guide.append(summary, buildGuideBody(item.guide));
      parasEl.append(guide);
    }

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

  // ─── Agent skill ─────────────────────────────────────────────────────
  /** Render the installable agent-skill section (install, cards, manual, verify). */
  renderAgentSkill() {
    const d = this.data.agentSkill;
    if (!d) return;

    // Intro paragraphs.
    const intro = document.createDocumentFragment();
    d.intro.forEach((tx) => {
      const p = document.createElement("p");
      p.className = "text-sb-muted text-lg mb-6 max-w-2xl";
      p.textContent = tx;
      intro.append(p);
    });
    this.el.agentIntro.replaceChildren(intro);

    // Cards: the shared feature-card shape, revealed like every other grid.
    const frag = document.createDocumentFragment();
    d.cards.forEach((card, i) => {
      const el = cloneTemplate("feature-card-tpl");
      el.querySelector('[data-field="icon"]').textContent = card.icon;
      el.querySelector('[data-field="title"]').textContent = card.title;
      el.querySelector('[data-field="desc"]').textContent = card.desc;
      el.classList.add("reveal", `reveal-delay-${Math.min(i + 1, 4)}`);
      frag.append(el);
    });
    this.el.agentCards.replaceChildren(frag);

    // Info blocks share one builder: heading, optional preface, code block
    // with a copy button, and note. Same skeleton renderCliInstall uses.
    const block = (node, spec) => {
      const box = document.createElement("div");
      box.className = "cli-install-inner";
      const heading = document.createElement("div");
      heading.className = "install-panel-heading";
      heading.textContent = spec.title;
      box.append(heading);
      if (spec.desc) {
        const desc = document.createElement("p");
        desc.className = "cli-install-desc";
        desc.textContent = spec.desc;
        box.append(desc);
      }
      const wrap = document.createElement("div");
      wrap.className = "install-step-code-wrapper";
      const btn = cloneTemplate("copy-btn-tpl");
      btn.setAttribute("aria-label", `Copy ${spec.title} command`);
      btn.addEventListener("click", () => copyCode(btn, spec.code));
      const pre = document.createElement("pre");
      pre.className = "install-code";
      const code = document.createElement("code");
      code.textContent = spec.code;
      pre.append(code);
      wrap.append(btn, pre);
      box.append(wrap);
      if (spec.note) {
        const note = document.createElement("div");
        note.className = "install-note";
        note.textContent = spec.note;
        box.append(note);
      }
      node.replaceChildren(box);
    };

    block(this.el.agentInstall, {
      title: d.installTitle,
      code: d.installCode,
      note: d.installNote,
    });
    block(this.el.agentManual, {
      title: d.manualTitle,
      code: d.manualInstallCode,
      note: d.manualNote,
    });
    block(this.el.agentVerify, {
      title: "Verify it loaded",
      desc: null,
      code: d.verifyCode,
      note: d.verifyNote,
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
  //
  // The source-tree walk lives on dev.html, not here: it is contributor
  // documentation, and the marketing page has no business describing a
  // codebase to someone who came to download a file.

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

    // Version chips (delegated). The handler lives on the container, which
    // renderInstall() replaces on every selection, so it must survive the
    // re-render — hence delegation rather than a listener per chip.
    this.el.versionPicker.addEventListener("click", (e) => {
      const btn = e.target.closest(".version-chip");
      if (btn) this.selectVersion(btn.dataset.version);
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
