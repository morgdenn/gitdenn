# Contributing to GitDenn

Thanks for your interest in improving GitDenn!

## Development

```bash
npm install
npm run dev   # dev mode with hot reload
```

Requirements: **Node.js 18+**, **npm 8+**, and **Git** on your PATH.

Hot reload: editing a renderer file reloads the page; editing a main-process
file restarts the app.

## Project conventions

GitDenn is deliberately **buildless** — vanilla JS, no bundler, no framework,
no build step. All UI is built with the tiny helper in `src/renderer/ui.js`
(`html` / `raw` / `render` / `on`). Please keep it that way.

**Read [AGENTS.md](AGENTS.md) before making changes** — it documents the
architecture, the renderer↔main (IPC) boundary, the UI patterns, and the
hard-won gotchas.

A few essentials:
- Syntax-check any changed JS with `node --check <file>`.
- Keep commits focused — one logical change per commit.
- Add git operations in the main process (`src/main/main.js`), expose them via
  `src/main/preload.js`, and call them through `window.gitApp` in the renderer.
- The commit-graph engine is imperative HTML Canvas code — leave it vanilla.
- Don't introduce npm UI dependencies, a bundler, or `type="module"` without
  discussing it first.

## Reporting issues

Open an issue with steps to reproduce, what you expected, and what actually
happened. Screenshots help a lot for UI problems.

## Pull requests

1. Fork the repo and create a feature branch.
2. Make your change following the conventions above.
3. Open a PR describing **what** changed and **why**.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
