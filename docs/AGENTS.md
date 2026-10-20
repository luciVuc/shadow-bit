# AGENTS.md — ShadowBit Documentation Site

This app follows the **UI Prototyping** (`ui-prototyping`) skill conventions.
Before changing anything, load and follow that skill; if you can't, follow the
rules in this file, which mirror it.

---

## What this is

A static website for the **ShadowBit** encrypted vault app, built with vanilla
HTML/CSS/JS and vendored Tailwind-style utilities (`docs/utilities.css`). No
CDN, no build step, no network access at runtime. It lives in `docs/` inside the
main ShadowBit repo.

**Two pages, two audiences — this is the most important rule in this file.**

| Page         | Audience     | May contain                                  |
| ------------ | ------------ | -------------------------------------------- |
| `index.html` | End users    | Presentation, downloads, usage documentation |
| `dev.html`   | Contributors | Build, test, packaging, source tree          |

**`index.html` carries no technology stack.** No Electron, no Node.js, no npm,
no `git clone`, no TypeScript, no source tree, no build instructions. Someone
who came to encrypt a folder must not scroll past a package.json to find the
download button. Contributor content belongs on `dev.html`, which is linked
from the footer only — never from the main navigation.

The split is enforced by hand. When you add a section, ask which page it
belongs to before you ask where it goes in the file. The one deliberate
exception: the **CLI is a user-facing interface** and is documented on the main
page, including `npm install -g shadow-bit`.

---

## Content accuracy — read before editing copy

The site is a security product's front page. A false capability claim here is a
real defect, not a copy nit, and this repo has shipped three of them. Before
adding or changing any text in `data.js` or `index.html`:

- **Verify against the source, every time.** Do not trust the existing copy, the
  roadmap, or your own memory of the codebase. Check the CLI command list in
  `src/cli/index.ts`, the flags it registers, and the files a claim depends on.
- **A file existing is not a feature existing.** `src/core/hidden.ts` and
  `src/core/stego.ts` are fully implemented and unit-tested, but neither is
  imported by `src/cli/` or `src/gui/`, so no user can reach them. They may
  appear in Architecture, labelled as library-only, and nowhere else — not in
  `features[]`, `useCases[]`, or `security[]`.
- **The Q&A (`qa[]`) answers "duress password" and "steganography" with "not
  in this build".** That is the one place on the site where those two modules
  are discussed at length, and it is deliberate: a visitor searching for
  "duress" arrives there, so a vague answer would be read as a capability
  claim. Both answers name the library file and the `ROADMAP.md` section, and
  state that no command calls it. If a `hidden` or `stego` subcommand is ever
  added, those two answers must be rewritten in the same change.
- **Every command shown in a Q&A `code` block must exist in `src/cli/index.ts`,
  with the flags it registers.** A recipe that teaches a missing `--keyfile` is
  worse than no recipe: the command fails closed, so the user's takeaway would
  be "ShadowBit is broken".
- **Do not write for high-risk audiences.** The site previously addressed
  "journalists, activists, and other high-risk users" because of the two
  unreachable features above. Nothing in the current build supports a
  deniability claim, so the site must not imply one.
- **`SECURITY_AUDIT.md` is an internal self-review.** Never describe it as a
  professional audit or imply third-party assurance.
- **Use `SHADOWBIT_PASSWORD`, not `--password`,** in any example. `--password` is
  deprecated precisely because it leaks via `ps` and shell history.
- **Recount rather than trusting a number.** Feature, command and test counts in
  prose drift. `node -e 'global.window={};require("./docs/data.js");console.log(global.window.APP_DATA.features.length)'`
  is the ground truth for card counts.

## Hard `file://` rules — DO NOT VIOLATE

- Must open by double-clicking `index.html` (no server required).
- **No `fetch()` of local JSON** — data lives in `data.js` as `window.APP_DATA`.
- **No `<script type="module">` / `import` / `export`** — classic scripts only.
- Load order in `index.html`: `data.js` → `index.js` (classic scripts, not modules).

---

## Architecture

| File            | Role                                                                |
| --------------- | ------------------------------------------------------------------- |
| `index.html`    | End-user page: structure, `<template>` tags, script/link refs       |
| `dev.html`      | Contributor page: build/test/packaging/source tree, own templates   |
| `index.css`     | Design tokens (CSS custom properties), component styles, animations |
| `utilities.css` | Vendored Tailwind-style utilities, no CDN                           |
| `data.js`       | `window.APP_DATA` — all content for both pages                      |
| `index.js`      | `class App` — renders `index.html`                                  |
| `dev.js`        | `class DevApp` — renders `dev.html`                                 |

`dev.js` is a **separate file on purpose**, not a second class in `index.js`:
the main page's renderer has nothing to delete because the contributor
rendering was never in it.

**Class App flow:**

1. `init()` caches element refs and calls all render methods + `bindEvents()`.
2. Each render method reads `window.APP_DATA`, clones `<template>` tags, fills `[data-field]` hooks via `textContent`, and calls `replaceChildren()` on the container.
3. Interactive state (active install tab, active GUI tab, CLI search query) lives as instance properties on `App`.
4. Events are bound in `bindEvents()` using delegation where possible.

**No Store needed** — this is a mostly static, read-only documentation site.
No persistent state, no localStorage.

---

## Important CSS fix

`[hidden] { display: none !important; }` is in `index.css`.
This is required because the `.flex` utility overrides the browser UA
`[hidden]` style. Without it, hidden elements (like `#loadError`) become visible.
**Do not remove this rule.**

---

## Utilities are vendored — no CDN

The site used to load `https://cdn.tailwindcss.com`. That is gone. `utilities.css`
holds the utility rules the page actually uses and `index.css` holds everything
else, so the site renders with no network access and executes no third-party JS.

**When you add a Tailwind-style class to `index.html`, add its rule to
`utilities.css` in the same change.** `npm run test:site` asserts every class in
`index.html` resolves to a rule in one of the two stylesheets.

If you add a transform utility, declare the whole `--tw-*` set it references.
A single undefined `var()` invalidates the whole declaration at computed-value
time and the element silently falls back to `transform: none` — this actually
happened, un-centring `.scroll-indicator` by 3px. A test guards it.

## How to make changes

| Change                                                             | File to touch                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Update features, commands, security props                          | `data.js` → `window.APP_DATA.*`                                                                     |
| Add a version, platform, artifact, or download step                | `data.js` → `APP_DATA.releases` / `APP_DATA.platforms`                                              |
| Change download URL construction or platform detection             | `index.js` → `downloadUrl()` / `detectPlatform()`                                                   |
| Change build-from-source or source-tree content                    | `data.js` → `APP_DATA.devSetup` / `APP_DATA.architecture` (dev.html only)                           |
| Add or edit a question                                             | `data.js` → `window.APP_DATA.qa[]`, plus the `faq-*` templates in `index.html` if the shape changes |
| Change colors, spacing, animations, component appearance           | `index.css`                                                                                         |
| Change page structure (new section, new template shape)            | `index.html`                                                                                        |
| Change behavior, add a new tab system, new filter, new interaction | `index.js` → `class App`                                                                            |
| Add/change a repeated shape (cards, rows)                          | Add/edit a `<template>` in `index.html`, update the render method in `index.js`                     |

**Never build markup as strings in JS.** All repeated shapes use `<template>` tags
in `index.html`, cloned by `cloneTemplate(id)` and filled via `textContent` /
`[data-field]` attribute hooks. No `innerHTML`, no template literals with tags.

`cloneTemplate(id)` returns the template's **root** element, not a wrapper. The
three Q&A templates make this easy to get wrong, and it fails as
`Cannot read properties of null (reading 'dataset')`:

- `faq-filter-tpl` — the root **is** the `<button>`. Set `btn.dataset.category`
  on it directly.
- `faq-group-tpl` — the root **is** the `.faq-group` div. Set `dataset.category`
  on it directly.
- `faq-item-tpl` — the root is the `<details>`; its `[data-field]` hooks are
  genuine descendants, so `el.querySelector(...)` works there.

Use the class on the root (`.faq-filter-btn`, `.faq-group`) to identify it —
never a `[data-field]` on the root, which reads as if it were a descendant.

**The copy button's ✓ is CSS, not DOM.** `copyCode()` adds `.copied` and the
tick comes from `.copy-btn.copied::after` with the inline SVG hidden. The
original implementation swapped an SVG string through `innerHTML`, which broke
the no-markup-in-JS rule. Do not reintroduce it.

---

## Templates (`index.html`)

Templates on `index.html` (the `dev.html` set lives on that page):

| Template ID         | Used for                                                       |
| ------------------- | -------------------------------------------------------------- |
| `feature-card-tpl`  | Feature cards in `#features-grid`                              |
| `workflow-step-tpl` | Workflow steps in `#workflow-steps`                            |
| `install-step-tpl`  | Install code blocks inside each tab panel                      |
| `cli-row-tpl`       | CLI command rows in `#cli-table`                               |
| `security-card-tpl` | Security property cards in `#security-grid`                    |
| `arch-module-tpl`   | Architecture module blocks in `#arch-tree`                     |
| `arch-file-tpl`     | Individual file rows inside an arch module                     |
| `faq-filter-tpl`    | Category filter chips in `#faq-filters`                        |
| `faq-group-tpl`     | One question category in `#faq-groups`                         |
| `faq-item-tpl`      | One `<details>` question, with optional code and optional note |

---

## Coding standards

- ES2020 vanilla, `const` / `let` (never `var`).
- **No HTML strings in `.js`** — no `innerHTML="…tags…"`, no template-literal markup.
- Fill `[data-field]` hooks via `textContent` only (never `.innerHTML`).
- JSDoc comment on every `class App` method.
- Handle empty/error states via the static `#loadError` element in `index.html`.
- Accessibility: semantic HTML, keyboard-reachable interactive elements.

---

## Downloads must not rot

A download link that 404s is worse than no download section: it is the primary
call to action, and it looks like it worked until the user clicks it.

- **Never hand-write a release URL.** `downloadUrl()` assembles it from
  `APP_DATA.releases.repo` + the tag + the artifact name, so a version bump
  cannot leave a link pointing at a build that was never uploaded.
- **Never hand-write an artifact name.** The names embed the version, and
  `scripts/version-literals.js` rewrites them on `npm version`. If you add a new
  artifact, add a site for it in `LITERAL_SITES` in the same change — an
  unregistered name is one `npm version` will silently leave behind.
  Note the `after` anchors: `"ShadowBit-" … ".dmg"` would capture
  `1.1.3-arm64` and rewrite the download to `ShadowBit-<v>.dmg`, silently
  dropping the architecture. Anchor on `"-arm64.dmg"`.
- **`releases.versions` is a hand-maintained list**, newest first, with exactly
  one `current: true`. Adding a release means adding an entry. This is
  deliberate: the page must work offline over `file://`, so it never calls the
  GitHub API.
- **The version chips re-render the whole section.** The links, the step copy
  and the release list all mention the version; a partial update is how one of
  them keeps naming the previous build. `{file}` in a step's title/desc/code is
  replaced with the file the visitor actually downloaded.
- **Platform detection is a hint, never a filter.** Every platform tab stays
  visible. The "your platform" badge marks the _detected_ platform and stays put
  when the visitor switches tabs — it describes their machine, not what is open.

---

## Verify after every change

1. Start a local server: `npx --yes serve -l 9090 docs/`
2. Open `http://localhost:9090` in a browser. Check `dev.html` too.
3. **For any download change**, click through: switch platform tabs, pick an
   older version, and confirm the hrefs carry that version in both the tag and
   the artifact name.
4. Check: renders correctly, no console errors, responsive at 375/768/1280px.
5. Test interactions: version chips, platform tab switching, GUI tab switching, CLI search filter, Q&A search filter, Q&A category chips, Q&A accordion, copy buttons, mobile menu, scroll spy.
6. Check the Q&A has no horizontal overflow at 375px, and that the copy button in
   a code block sits top-right without covering the first line.
7. Run `npm run test:site` and `npm run test:a11y` — they assert the class/CSS
   and self-containment invariants this file describes.
8. Fix code if any check fails before reporting done.

---

## Do / Don't

**Do:**

- Edit `data.js` first when adding new content — the render methods handle the rest.
- Put contributor content on `dev.html`, never on the main page.
- Keep all render logic inside `class App` methods.
- Use `cloneTemplate()` + `[data-field]` for any new repeated shape.
- Keep `[hidden] { display: none !important; }` in `index.css`.

**Don't:**

- Mention Electron, Node.js, npm, TypeScript, `git clone`, or a build step
  anywhere in `index.html` or anything `index.js` renders.
- Hand-write a download URL or an artifact file name.
- Add a claim to `data.js` you have not verified in the source, however plausible
  it sounds. The `architecture[]` entry is the only place an unreachable module
  may be named, and it must say so in the description.
- Add `fetch()` for any file — it breaks over `file://`.
- Use ES modules or `<script type="module">`.
- Build markup as strings in JS (no `innerHTML` with tags).
- Remove the `[hidden]` override from `index.css`.
- Add `<style>` blocks to `index.html` — put styles in `index.css`.
