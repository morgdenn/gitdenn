# AI Agent Guide — GitDenn

Guidance for any AI coding assistant (Claude, Copilot, Cursor, Codex, etc.)
working on this repo. Read this **before** making changes. For setup, features,
and architecture, see [README.md](README.md); this file covers the conventions
and gotchas that aren't obvious from the code.

Context: the repo owner does **not** read the code directly and drives
development through an AI. Optimize for correctness and low-friction
reliability over cleverness.

---

## Non-negotiable conventions

### 1. No build step. No UI framework.

This app is **buildless vanilla JS** — Electron loads the source files
directly. There is no bundler, no transpiler, no `type="module"`.

- **Do NOT** introduce React / Vue / Svelte / Lit, a bundler (webpack/vite/etc.),
  TypeScript, or npm UI dependencies **without explicit owner approval.**
- **Why:** a build step or CDN dependency is a recurring failure surface
  (resolution errors, stale builds, offline breakage) every session. Buildless
  keeps the loop at "edit file → reload app," which is the most reliable mode
  for AI-driven development. The owner chose this deliberately.

All UI is built with the tiny in-repo helper **`src/renderer/ui.js`** (loaded as
a plain `<script>` before `app.js`):

- `` html`...` `` — auto-escaping tagged template. Interpolated values are
  HTML-escaped by default (prevents XSS / broken markup).
- `raw(x)` — opt out of escaping, only for already-safe HTML (e.g. the output
  of `buildRefBadges`).
- `render(container, template)` — set an element's content from a template (or
  array of templates).
- `on(container, type, selector, handler)` — **delegated** events, bound once.

### 2. UI rendering rules

- **Escape everything.** Use `` html`` `` for any string that includes data.
  Never hand-concatenate untrusted text into `innerHTML`.
- **Never re-bind listeners inside a render function.** Bind once with
  delegated `on(...)` in `bindEvents()`. Because it's delegated on a container,
  re-rendering that container's `innerHTML` never drops handlers — this is how
  we avoid the "stale DOM / lost handler" class of bug.
- **Resizable columns/panels** are driven by CSS variables (`--branch-w`,
  `--graph-w`, `--author-w`, `--repos-w`, `--branches-w`, …) updated on drag.
  See `initColumnResizers()` and `initSidebarPanels()` in `app.js`.
- **The commit graph is imperative HTML Canvas** (`computeGraphLayout()` +
  `paintGraph()`). It is framework-neutral by nature — leave it vanilla; a
  framework would not help it.

### 3. Renderer ↔ main process boundary

The renderer has **no** `nodeIntegration`. All git and OS operations run in the
**main process** (`src/main/main.js`) via `simple-git`, exposed to the renderer
through `src/main/preload.js` (`contextBridge` → `window.gitApp`).

**To add a git/OS operation:**
1. Add an `ipcMain.handle('git:xxx', ...)` in `main.js`.
2. Expose it in `preload.js` on the `gitApp` object.
3. Call it via `window.gitApp.xxx(...)` in `app.js`.

Every handler returns `{ success: true, ... }` or `{ success: false, error }`.
Follow that shape.

### 4. Commit & push workflow

The owner wants **every completed feature committed and pushed automatically**
to `origin main` — no need to ask.

- Repo: `https://github.com/morgdenn/gitdenn` (public). The download site is `docs/index.html`, served by GitHub Pages from `/docs` on `main` at https://gitdenn.com (the `docs/CNAME` file must stay).
- One logical feature per commit; write a clear, descriptive message.
- **Syntax-check before committing:** `node --check <file>` on any changed
  `.js`. (There is no test suite yet.)
- Commit at the natural end of a feature — not mid-work, and not on
  discussion-only turns where no code changed.

---

## Running

```bash
npm install
npm run dev     # dev mode: DevTools open + hot reload (see below)
npm start       # production mode
```

**Hot reload** (`src/main/dev-reload.js`, active only with `--dev`):
- Editing a **renderer** file (`index.html`, `app.js`, `ui.js`, `app.css`)
  reloads the page (~0.1s). Note: a page reload resets in-app state, so you
  return to the welcome screen and must reopen a repo.
- Editing a **main/preload** file restarts the whole app.

---

## Project layout

See the structure block in [README.md](README.md). Beyond what it lists:

- `src/renderer/ui.js` — the buildless UI helper (see convention #1).
- `src/main/dev-reload.js` — dev-only hot-reload watcher.

---

## Gotchas (learned the hard way)

- **simple-git clone progress:** the progress callback must be passed to the
  `simpleGit({ progress })` **constructor**, not as an argument to `.clone()`.
- **Canvas + HiDPI:** `paintGraph()` scales the canvas backing store by
  `devicePixelRatio` each call; `renderCommitRows()` resets `canvas.width` from
  `GRAPH_W` before painting. When the **graph column** is resized, call
  `renderCommitRows()` **then** `paintGraph()` — do **not** call `paintGraph()`
  alone, or the canvas double-scales on HiDPI displays.
- **Commit ordering:** `git log` uses `--date-order` (newest first, but a
  parent never appears above its child). Do **not** re-sort commits purely by
  timestamp in JS — that can place a parent above a child and break the graph's
  parent-lookup / edge drawing.
- **Persistence:** column widths, sidebar panel widths, and collapsed state are
  **not** persisted yet — they reset on reload. Recent repos **are** persisted
  in `localStorage`. If you add persistence, keep it in `localStorage`.
- **Line endings (Windows):** `git add` prints `LF will be replaced by CRLF`
  warnings — harmless.

---

## What's built / not built

Current features and the roadmap live in the README's **Features** and
**Next Steps / Roadmap** sections. Keep both updated as you ship features.
