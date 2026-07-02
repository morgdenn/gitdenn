// ─── Dev-only hot reload (no dependencies) ────────────────────────────────────
// Watches the source tree and reacts to file changes:
//   • renderer files (HTML/CSS/JS) → reload the BrowserWindow page (fast)
//   • main / preload files         → relaunch the whole app (they run in the
//                                     main process and cannot be hot-swapped)
//
// Enabled only when the app is started with --dev (see main.js), so packaged
// builds never watch the filesystem.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const RENDERER_DIR = path.join(__dirname, '../renderer');
const MAIN_DIR = __dirname; // src/main — main.js, preload.js, this file

function watchForReload(getWindow) {
  let timer = null;
  const debounce = fn => {
    clearTimeout(timer);
    timer = setTimeout(fn, 120); // editors emit several events per save
  };

  // Renderer changes → reload the page only.
  fs.watch(RENDERER_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    debounce(() => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        console.log(`[dev-reload] renderer changed (${filename}) → reloading page`);
        win.webContents.reloadIgnoringCache();
      }
    });
  });

  // Main / preload changes → full restart.
  fs.watch(MAIN_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (filename.includes('dev-reload')) return; // ignore edits to this watcher
    debounce(() => {
      console.log(`[dev-reload] main process changed (${filename}) → restarting app`);
      app.relaunch();
      app.exit(0);
    });
  });

  console.log('[dev-reload] watching for changes (renderer → reload, main → restart)');
}

module.exports = { watchForReload };
