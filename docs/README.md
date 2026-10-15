# ShadowBit — Documentation Website

A beautiful, single-page documentation and presentation site for the **ShadowBit** encrypted vault app.

Open `index.html` directly in a browser — the site is self-contained (no CDN,
no bundler, no build step) and runs over `file://` as well as HTTP. The
`screenshots/` directory does not exist in the repo, so there is no hero image
here; run the GUI (`npm run gui`) to see the app itself.

---

## How to open

**Option A — double-click** `index.html` (opens over `file://`, no server, no install).

**Option B — local server** (if you prefer):

```bash
npx --yes serve -l 9090 docs/
# then open http://localhost:9090
```

---

## What's on the page

| Section           | What it covers                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Hero**          | Animated lock icon, tagline, stat pills (cipher, KDF, format, platforms)                                                               |
| **Vault Format**  | Visual diagram of the `.svlt` binary format + legend explaining envelope encryption, GCM auth, and the recovery key                    |
| **Features**      | 10 feature cards covering encryption, portability, password changes, recovery key, CLI+GUI, scrypt, drag-and-drop                      |
| **How It Works**  | 4-step workflow cards (Create → Open → Edit → Close) with inline CLI examples                                                          |
| **Installation**  | Platform tabs (macOS / Windows / Linux / From Source) with code blocks and copy buttons                                                |
| **Recipes**       | 4 copy-ready shell recipes (share, recover, automate, migrate)                                                                         |
| **Q&A**           | 30 questions in 4 categories (Getting started, How-to recipes, Privacy & limits, Troubleshooting) with live search and category filter |
| **CLI Reference** | All 14 commands with flags, descriptions, and example snippets; live search filter                                                     |
| **Desktop GUI**   | 4-tab GUI mock (Open / Create / Manage / Open Vaults) with decorative form previews                                                    |
| **Security**      | 13 security property cards + audit-status callout + best-effort erase notice                                                           |
| **Architecture**  | Source tree for `src/core/`, `src/cli/`, `src/gui/` with per-file descriptions                                                         |
| **Footer**        | Navigation links, help links, license, version                                                                                         |

---

## Features of the site itself

- **Scroll spy** — navbar links highlight the active section as you scroll.
- **Smooth scroll** — clicking any nav link scrolls smoothly to that section.
- **Reveal animations** — cards and steps fade-in as they enter the viewport.
- **Copy buttons** — every code block has a one-click copy button with a ✓ flash
  (drawn in CSS, not swapped into the DOM via `innerHTML`).
- **CLI search** — live filter for the command reference table.
- **Q&A accordion** — `<details>`/`<summary>` questions (keyboard-operable and
  announced correctly with no JS), filtered live by a search box and by
  category chips. Filtering hides whole groups that end up empty.
- **Install tabs** — switch between macOS / Windows / Linux / From Source.
- **GUI tabs** — switch between the four Electron app tabs.
- **Mobile menu** — hamburger nav for ≤768px viewports.
- **Responsive** — tested at 375px (phone), 768px (tablet), 1280px (desktop).
- **Dark theme** — deep navy + electric cyan + indigo accent palette.

---

## Project structure

```
docs/
├── index.html    # semantic structure, templates, script/link refs
├── index.css     # design tokens, animations, component styles
├── data.js       # window.APP_DATA — all content (features, commands, etc.)
├── index.js      # class App — rendering, event wiring, interactions
├── README.md     # this file
└── AGENTS.md     # orientation for the next coding agent
```

---

## Content must be true

This site is the first thing a potential user reads, and for a security tool an
overstated claim is worse than a missing feature. Before writing any claim,
confirm it against the source.

Rules that exist because a claim here was wrong:

- **Never advertise a capability that only exists as an unused library file.**
  `src/core/hidden.ts` (hidden volumes, plausible deniability) and
  `src/core/stego.ts` (carrier-file steganography) are implemented and
  unit-tested, but nothing in `src/cli/` or `src/gui/` imports them. They are
  listed under Architecture as library-only and appear nowhere else. Do not add
  them to features, use cases, or security properties — and do not describe them
  as anything a user can operate.
- **The Q&A is where this is easiest to get wrong.** Someone searching "duress"
  or "steganography" lands there first, so an answer that implies either is
  reachable is a false claim in the most-read part of the page. Both are
  answered explicitly as _not available in this build_ — that wording is
  deliberate. If the CLI ever grows a `hidden` or `stego` subcommand, update
  those two answers in the same change.
- **Every command in a Q&A code block must exist in `src/cli/index.ts`.** The
  `--keyfile` flag in particular has to be threaded through _every_
  authenticating command; a recipe that omits it teaches a command that will
  fail closed.
- **Do not target users by threat model.** The site used to address "journalists,
  activists, and other high-risk users" on the strength of those two features.
  Whatever the roadmap says, that is not a claim this build can support.
- **No "audit complete" framing.** `SECURITY_AUDIT.md` is an internal self-review,
  not a professional audit. Say so, and say what was actually reviewed.
- **Prefer `SHADOWBIT_PASSWORD` in examples.** The CLI deprecates `--password`
  because the argument is visible in `ps` and shell history. Recommending it in
  an automation recipe would teach the unsafe path.
- **Verify counts and flags against the code, not from memory.** Command lists,
  test totals and flag names drift silently.

## Editing the content

All text content lives in **`data.js`** as `window.APP_DATA`. To change:

- **Features** → edit `APP_DATA.features[]`
- **Q&A questions** → edit `APP_DATA.qa[]` (grouped by category; see below)
- **CLI commands** → edit `APP_DATA.commands[]`
- **Installation steps** → edit `APP_DATA.installTabs[]`
- **Security properties** → edit `APP_DATA.security[]`
- **Architecture files** → edit `APP_DATA.architecture[]`
- **Hero text / version** → edit `APP_DATA.meta`

### The Q&A data shape

```js
// data.js, inside APP_DATA.qa[]
{
  id: "recipes",                 // also the category chip's data-category
  label: "How-to recipes",
  icon: "🧭",
  blurb: "One line shown under the heading.",
  items: [
    {
      q: "How do I require a keyfile as well as the password?",
      a: ["First paragraph.", "Second paragraph."],   // one <p> each
      code: "./shadow-bit create secret --keyfile …", // optional shell block
      note: { tone: "warn", text: "Keep the keyfile elsewhere." }, // optional
    },
  ],
}
```

`note.tone` is `"warn"` (amber, prefixed ⚠️) or anything else (neutral, ℹ️).
Omit `code` or `note` and the wrapper is hidden — do not clone the template to
make variants.

---

## Tech notes

- **Vanilla HTML5 / CSS / JS** — no framework, no build step.
- **Tailwind-style utilities are vendored, not loaded.** `utilities.css` holds
  the exact utility rules the page uses; `index.css` holds component styles and
  local colour/opacity bridges. The CDN is gone, so the site makes no network
  requests at all. When you add a new utility class to `index.html`, add its
  rule to `utilities.css` in the same change — `e2e/nfr.site.test.ts` fails if
  a class has no rule in either stylesheet.
- **No `fetch()` of local JSON** — data is in `data.js` as a global (`window.APP_DATA`), safe over `file://`.
- **Classic `<script>` only** — no ES modules (`import`/`export`). Works over `file://`.
- **`[hidden] { display: none !important }`** — needed because the `.flex` utility would otherwise override the HTML `hidden` attribute.
- **Custom properties must come as a full set.** `utilities.css` declares the
  seven `--tw-*` variables its `transform` rules reference. An undefined
  `var()` invalidates the entire declaration, so a missing one silently drops
  the element back to `transform: none`; a test guards this.

---

## Browser support

Modern evergreen browsers (Chrome 90+, Firefox 88+, Safari 14+, Edge 90+). This is a documentation prototype — content is static, no persistence.
