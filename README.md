# GitDenn — A GitKraken-style Desktop Git Client

Built with Electron + simple-git. Visualizes commit history as an interactive branch graph.

## Features
- **Clone** any public or private Git repo via URL
- **Open** existing local repositories
- **Commit graph** with branching/merging lane visualisation (canvas-rendered)
- **Commit detail panel** — author, date, SHA, ref badges, file diff stats
- **Branch sidebar** showing local and remote branches
- **Fetch** from all remotes
- **Recent repos** list (persisted in localStorage)
- **Keyboard shortcuts**: `Esc` closes modal, `Cmd/Ctrl+R` refreshes

## Setup

```bash
# 1. Enter the project folder
cd gitdenn

# 2. Install dependencies
npm install

# 3. Run the app
npm start

# Run in dev mode (opens DevTools automatically)
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
├── src/
│   ├── main/
│   │   ├── main.js        # Electron main process — window, IPC, git ops
│   │   └── preload.js     # Context bridge — exposes gitApp API to renderer
│   └── renderer/
│       ├── index.html     # App shell
│       ├── app.js         # UI logic + graph layout + canvas painter
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
- Draws bezier curves for branch/merge lines on an HTML Canvas
- Only paints visible rows (virtual scrolling) for performance

## Next Steps / Roadmap
- [ ] Stage/unstage files
- [ ] Commit from UI
- [ ] Push / pull
- [ ] Full diff viewer (line-level +/-)
- [ ] Branch create / delete / rename
- [ ] Stash management
- [ ] Search commits
- [ ] Drag-and-drop rebase
