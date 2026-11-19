<p align="center">
  <img src="public/logo.svg" alt="GitDenn logo" width="128" height="128" />
</p>

<h1 align="center">GitDenn — A Desktop Git Client</h1>

<p align="center">Built with Electron + simple-git. Visualizes commit history as an interactive branch graph.</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-a6e22e.svg"></a>
  <img alt="Electron 28" src="https://img.shields.io/badge/Electron-28-66d9ef.svg">
  <img alt="Vanilla JS — no build step" src="https://img.shields.io/badge/Vanilla%20JS-no%20build%20step-f92672.svg">
</p>

## Features

**Repository**
- **Clone** any public or private Git repo via URL (with progress)
- **Open** existing local repositories
- **Recent repos** list (persisted in localStorage) — each repo gets a small icon: a logo/favicon file found in the project itself if there is one, otherwise the GitHub owner's avatar (organisation logo or personal profile picture)
- **Open in GitHub** (when the remote is on GitHub) and **Open in VS Code**

**Commit graph**
- Branching/merging lane visualisation on an HTML Canvas, ordered newest-first
- Commit nodes rendered as **author-initial avatars**, coloured by lane
- **Right-angle (orthogonal) edge routing** with rounded corners
- Per-lane row tint; virtualised painting (only visible rows)
- **Commit detail panel** — author, date, SHA, ref badges, **full commit message**, file diff stats
- **Side-by-side file diff** — click a file in a commit to see the whole file split old/new with changes highlighted (toggle "Changes only", jump between changes with ↑/↓, **mini map** of the whole file (click/drag to scroll), `Esc` closes)
- **Multi-select** commits (Ctrl/Cmd-click, Shift-click range) and **squash** them into one via right-click (consecutive, non-merge commits on the current branch)

**Branches**
- Sidebar **branch tree** grouped by `/`, split into Local / Remote (resizable divider)
- **Ahead/behind** indicators vs. upstream (`N↑` / `N↓`), kept live: local refs re-checked every 5s and a background `git fetch` every 60s
- **Stale branches** (no commits for 3+ months — GitHub's own definition, computed locally from each branch tip's commit date) are dimmed in the branch lists; a **Hide/Show stale (N)** button in the panel header toggles them (remembered)
- **Unpushed commits highlight Push**: when the current branch is ahead of its remote, the toolbar Push button stays in its hover (highlighted) state and its tooltip shows the count; likewise Pull is highlighted when the remote has commits to pull down
- **Pull and rebase auto-stash** uncommitted changes first and restore them afterwards, so local edits no longer block a pull; common git failures are shown in plain language
- **Stash** toolbar button: stash changes (optional message, untracked files included by default), with a count badge and a list to apply, pop or drop saved stashes
- Right-click a local branch to **Pull branch** (fast-forwards it even if it isn't checked out), copy its name, rename, or delete
- Double-click a remote branch to check it out locally; double-click a local branch to switch
- **Create a branch**, **fetch**, **pull**, and **push** (auto-sets upstream) from the toolbar

**Working directory (uncommitted changes)**
- A **WIP node** at the top of the graph for uncommitted changes, refreshed automatically
- Detail panel lists **Changes** and **Staged** files; stage/unstage individually or all
- **Commit** staged changes with a message box
- **✨ Generate commit message** — a local heuristic (no AI service): learns your repo's commit style from recent history, takes the ticket id (e.g. `PROJ-123`) from the branch name, names touched functions/classes from the diff, detects version bumps and whitespace-/comment-only changes, and itemises multi-file commits in the body. Logic lives in `src/main/commit-message.js`.
- **Side-by-side diff for uncommitted files** — click a changed file to open the same full-width side-by-side diff used for commits, with a **Discard** button; stage/unstage via the row buttons

**UI**
- Monokai-inspired dark theme
- Resizable, collapsible sidebar panels; resizable commit-list columns
- **Keyboard shortcuts**: `Esc` closes modals, `Cmd/Ctrl+R` refreshes, `Cmd/Ctrl+Shift+E` opens VS Code

## Setup

```bash
# 1. Enter the project folder
cd gitdenn

# 2. Install dependencies
npm install

# 3. Run the app
npm start

# Run in dev mode (hot reload: renderer edits reload the page,
# main-process edits restart the app)
npm run dev
```

## Requirements

- **Node.js** 18+ 
- **npm** 8+
- **Git** installed and available on your PATH

## Project Structure

```
gitdenn/
├── package.json
├── AGENTS.md              # Guide for AI assistants working on this repo
├── CLAUDE.md              # Pointer to AGENTS.md for Claude Code
├── src/
│   ├── main/
│   │   ├── main.js        # Electron main process — window, IPC, git ops
│   │   ├── preload.js     # Context bridge — exposes gitApp API to renderer
│   │   └── dev-reload.js  # Dev-only hot reload (active with --dev)
│   └── renderer/
│       ├── index.html     # App shell
│       ├── app.js         # UI logic + graph layout + canvas painter
│       ├── ui.js          # Tiny buildless UI helper (html/raw/render/on)
│       └── styles/
│           └── app.css    # Dark theme styles
└── public/
    └── (icons etc.)
```

## Architecture

```
Renderer (index.html + app.js)
    ↕ window.gitApp (preload bridge)
Main process (main.js)
    ↕ simple-git
Local Git / Remote repos
```

The **graph layout engine** in `app.js` implements a lane-allocation algorithm:
- Assigns each commit a horizontal lane (column)
- Tracks open lanes that expect a parent commit
- Draws right-angle (orthogonal) connectors with rounded corners on an HTML Canvas
- Only paints visible rows (virtual scrolling) for performance

## Next Steps / Roadmap
- [x] Stage/unstage files
- [x] Commit from UI
- [x] Push / pull
- [x] Side-by-side file diff for uncommitted files (with discard)
- [x] Create branch
- [ ] Side-by-side diff opened in tabs
- [x] Branch delete / rename
- [x] Pull any branch, live ahead/behind with background fetch
- [x] Squash commits
- [x] Stash management (stash button, apply / pop / drop)
- [ ] Search commits
- [ ] Drag-and-drop rebase

## Contributing

Contributions are welcome! Please read **[CONTRIBUTING.md](CONTRIBUTING.md)**
and **[AGENTS.md](AGENTS.md)** first — GitDenn is intentionally buildless
(vanilla JS, no bundler, no framework), and the guides explain the conventions.

## License

[MIT](LICENSE) © Morgan Denn
