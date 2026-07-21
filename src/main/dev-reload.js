// ─── Dev-only hot reload (no dependencies) ────────────────────────────────────
// Watches the source tree and reacts to file changes:
//   • renderer files (HTML/CSS/JS) → reload the BrowserWindow page (fast)
//   • main / preload files         → relaunch the whole app (they run in the
//                                     main process and cannot be hot-swapped)
//
// Watches each source directory explicitly (non-recursive), which is far more
// reliable across platforms than fs.watch({recursive:true}). Enabled only when
// the app is started with --dev (see main.js).

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const RENDERER_DIR = path.join(__dirname, '../renderer');       // index.html, app.js, ui.js
const STYLES_DIR   = path.join(RENDERER_DIR, 'styles');         // app.css
const MAIN_DIR     = __dirname;                                 // main.js, preload.js

function watchForReload(getWindow) {
  const watchers = [];
  let reloadTimer = null;
  let restartTimer = null;

  const reloadRenderer = filename => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        console.log(`[dev-reload] renderer changed (${filename}) → reloading page`);
        win.webContents.reloadIgnoringCache();
      }
    }, 100);
  };

  const restartApp = filename => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      console.log(`[dev-reload] main process changed (${filename}) → restarting app`);
      app.relaunch();
      app.exit(0);
    }, 100);
  };

  const watchDir = (dir, onChange) => {
    try {
      const w = fs.watch(dir, (event, filename) => {
        if (filename) onChange(filename);
      });
      w.on('error', err => console.error(`[dev-reload] watch error on ${dir}: ${err.message}`));
      watchers.push(w);
      console.log(`[dev-reload] watching ${dir}`);
    } catch (err) {
      console.error(`[dev-reload] cannot watch ${dir}: ${err.message}`);
    }
  };

  watchDir(RENDERER_DIR, reloadRenderer);
  watchDir(STYLES_DIR, reloadRenderer);
  watchDir(MAIN_DIR, filename => {
    if (filename.includes('dev-reload')) return; // ignore edits to this watcher
    restartApp(filename);
  });

  return watchers;
}

module.exports = { watchForReload };
