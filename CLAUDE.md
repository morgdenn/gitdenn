# CLAUDE.md

AI guidance for this repo lives in **[AGENTS.md](AGENTS.md)** — read it before
making any changes.

Two rules that must not be broken without explicit owner approval:

1. **Buildless, no UI framework.** Vanilla JS only; all UI uses the
   `src/renderer/ui.js` helper (`html` / `raw` / `render` / `on`). No bundler,
   no framework, no `type="module"`.
2. **Commit & push every completed feature** to `origin main` automatically
   (`github.com/morgdenn/gitdenn`) — syntax-check with
   `node --check` first.

See [AGENTS.md](AGENTS.md) for the renderer↔main boundary, UI patterns, hot
reload, and the hard-won gotchas.
