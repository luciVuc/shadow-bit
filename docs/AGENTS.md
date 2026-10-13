# AGENTS.md — ShadowBit Documentation Site

This app follows the **UI Prototyping** (`ui-prototyping`) skill conventions.
Before changing anything, load and follow that skill; if you can't, follow the
rules in this file, which mirror it.

---

## What this is

A single-page documentation and presentation website for the **ShadowBit**
encrypted vault app, built with vanilla HTML/CSS/JS with vendored
Tailwind-style utilities (`docs/utilities.css`). No CDN, no build step, no
network access at runtime.
It lives in `docs/` inside the main ShadowBit repo.

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

| File         | Role                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `index.html` | Semantic structure, `<template>` tags for repeated elements, script/link refs |
| `index.css`  | Design tokens (CSS custom properties), component styles, animations           |
| `data.js`    | `window.APP_DATA` — all content: features, commands, install steps, etc.      |
| `index.js`   | `class App` — single class owning all state, rendering, and event wiring      |

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

| Change                                                                 | File to touch                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Update features, commands, install steps, security props, architecture | `data.js` → `window.APP_DATA.*`                                                                     |
| Add or edit a question                                                 | `data.js` → `window.APP_DATA.qa[]`, plus the `faq-*` templates in `index.html` if the shape changes |
| Change colors, spacing, animations, component appearance               | `index.css`                                                                                         |
| Change page structure (new section, new template shape)                | `index.html`                                                                                        |
| Change behavior, add a new tab system, new filter, new interaction     | `index.js` → `class App`                                                                            |
| Add/change a repeated shape (cards, rows)                              | Add/edit a `<template>` in `index.html`, update the render method in `index.js`                     |

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

## Verify after every change

1. Start a local server: `npx --yes serve -l 9090 docs/`
2. Open `http://localhost:9090` in a browser.
3. Check: renders correctly, no console errors (favicon 404 is benign), responsive at 375/768/1280px.
4. Test interactions: install tab switching, GUI tab switching, CLI search filter, Q&A search filter, Q&A category chips, Q&A accordion, copy buttons, mobile menu, scroll spy.
5. Check the Q&A has no horizontal overflow at 375px, and that the copy button in
   a code block sits top-right without covering the first line.
6. Fix code if any check fails before reporting done.

---

## Do / Don't

**Do:**

- Edit `data.js` first when adding new content — the render methods handle the rest.
- Keep all render logic inside `class App` methods.
- Use `cloneTemplate()` + `[data-field]` for any new repeated shape.
- Keep `[hidden] { display: none !important; }` in `index.css`.

**Don't:**

- Add a claim to `data.js` you have not verified in the source, however plausible
  it sounds. The `architecture[]` entry is the only place an unreachable module
  may be named, and it must say so in the description.
- Add `fetch()` for any file — it breaks over `file://`.
- Use ES modules or `<script type="module">`.
- Build markup as strings in JS (no `innerHTML` with tags).
- Remove the `[hidden]` override from `index.css`.
- Add `<style>` blocks to `index.html` — put styles in `index.css`.
