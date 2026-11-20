const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const simpleGit = require('simple-git');
const fs = require('fs');
const { exec, spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1b26',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../../public/icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  createWindow();
  if (process.argv.includes('--dev')) {
    require('./dev-reload').watchForReload(() => mainWindow);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// Clone a repository
ipcMain.handle('git:clone', async (event, { url, targetDir }) => {
  try {
    const git = simpleGit({
      progress({ method, stage, progress: p }) {
        if (p !== undefined) {
          event.sender.send('git:clone-progress', { method, stage, progress: p });
        }
      },
    });

    await git.clone(url, targetDir);

    return { success: true, path: targetDir };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Pick a folder to clone into
ipcMain.handle('dialog:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose destination folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// Open an existing local repo
ipcMain.handle('dialog:openRepo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open repository',
  });
  if (result.canceled) return null;
  const repoPath = result.filePaths[0];
  // Check it's actually a git repo
  try {
    const git = simpleGit(repoPath);
    await git.status();
    return repoPath;
  } catch {
    return { error: 'Not a valid git repository.' };
  }
});

// Get commit log with graph data
ipcMain.handle('git:log', async (event, { repoPath }) => {
  try {
    const git = simpleGit(repoPath);

    const logResult = await git.log([
      '--all',
      '--date-order',
      '--format=%H%n%P%n%an%n%ae%n%at%n%s%n%D%n---END---',
      '-500',
    ]);

    const raw = logResult.all ? null : null; // unused, using raw below
    const rawLog = await git.raw([
      'log',
      '--all',
      '--date-order',
      '--format=%H%n%P%n%an%n%ae%n%at%n%s%n%D%n---END---',
      '-500',
    ]);

    const commits = parseRawLog(rawLog);
    const branches = await git.branch(['-a']);
    const status = await git.status();
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin') || remotes[0];
    const remoteUrl = origin && origin.refs ? origin.refs.fetch : null;

    let head = null;
    try { head = (await git.revparse(['HEAD'])).trim(); } catch (e) { head = null; }

    const { tracking, branchShas, branchDates, defaultBranch } = await readRefInfo(git);

    return {
      success: true,
      commits,
      branches: branches.all,
      branchShas,
      branchDates,
      defaultBranch,
      currentBranch: branches.current,
      remoteUrl,
      head,
      tracking,
      status: {
        modified: status.modified.length,
        staged: status.staged.length,
        untracked: status.not_added.length,
        changed: status.files.length,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get diff for a commit
ipcMain.handle('git:commitDiff', async (event, { repoPath, sha }) => {
  try {
    const git = simpleGit(repoPath);
    // -m --first-parent: for merge commits, diff against the first parent only.
    const flags = ['--format=', '-M', '-m', '--first-parent'];
    const diff = await git.show([sha, '--stat', ...flags]);
    const fullDiff = await git.show([sha, ...flags]);
    // Exact file paths (same order as --stat), including rename old/new paths.
    const numstat = await git.raw(['show', sha, '--numstat', '-z', ...flags]);
    const files = parseNumstatZ(numstat);
    return { success: true, stat: diff, diff: fullDiff, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Unified diff of one file within a commit. `context` 'full' returns the whole
// file with changes marked (for side-by-side); anything else gives 5 lines of
// context. For a rename, pass oldFile so git pairs the two paths.
ipcMain.handle('git:commitFileDiff', async (event, { repoPath, sha, file, oldFile, context }) => {
  try {
    const git = simpleGit(repoPath);
    const paths = oldFile && oldFile !== file ? [oldFile, file] : [file];
    const unified = context === 'full' ? 1000000 : 5;
    const diff = await git.raw([
      'show', sha, '--format=', '-M', '-m', '--first-parent', '--no-color',
      `--unified=${unified}`, '--', ...paths,
    ]);
    return { success: true, diff };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Parse `git show --numstat -z` output into [{ path, oldPath, adds, dels }].
function parseNumstatZ(out) {
  const tokens = out.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[i].replace(/^\n+/, ''));
    if (!m) continue;
    const adds = m[1] === '-' ? 0 : +m[1];
    const dels = m[2] === '-' ? 0 : +m[2];
    if (m[3] === '') { // rename/copy: next two tokens are old, new
      files.push({ path: tokens[i + 2], oldPath: tokens[i + 1], adds, dels });
      i += 2;
    } else {
      files.push({ path: m[3], oldPath: null, adds, dels });
    }
  }
  return files;
}

// Checkout a branch or commit
ipcMain.handle('git:checkout', async (event, { repoPath, ref }) => {
  try {
    const git = simpleGit(repoPath);
    await git.checkout(ref);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Check out a remote branch as a local tracking branch.
// remoteBranch is the sidebar value, e.g. "remotes/origin/feature/x".
ipcMain.handle('git:checkoutRemote', async (event, { repoPath, remoteBranch }) => {
  try {
    const git = simpleGit(repoPath);
    const remoteRef = remoteBranch.replace(/^remotes\//, ''); // origin/feature/x
    const slash = remoteRef.indexOf('/');
    const localName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef; // feature/x

    if (localName === 'HEAD' || remoteRef.endsWith('/HEAD')) {
      return { success: false, error: 'Cannot check out a symbolic HEAD ref.' };
    }

    // If the local branch already exists, just switch to it; otherwise create
    // it tracking the remote ref.
    const localBranches = await git.branchLocal();
    if (localBranches.all.includes(localName)) {
      await git.checkout(localName);
    } else {
      await git.checkout(['-b', localName, '--track', remoteRef]);
    }
    return { success: true, branch: localName };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Working-directory status with per-file staged/unstaged state
ipcMain.handle('git:status', async (event, { repoPath }) => {
  try {
    const git = simpleGit(repoPath);
    const st = await git.status();
    const files = st.files.map(f => {
      const untracked = f.index === '?' && f.working_dir === '?';
      const staged = !untracked && f.index !== ' ' && f.index !== '';
      const unstaged = untracked || (f.working_dir !== ' ' && f.working_dir !== '');
      return { path: f.path, index: f.index, working_dir: f.working_dir, staged, unstaged, untracked };
    });
    return {
      success: true,
      files,
      counts: {
        modified: st.modified.length,
        staged: st.staged.length,
        untracked: st.not_added.length,
        changed: st.files.length,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Unified diff for a single working-directory file
// `context` 'full' returns the whole file with changes marked (side-by-side).
ipcMain.handle('git:fileDiff', async (event, { repoPath, file, staged, untracked, context }) => {
  try {
    const git = simpleGit(repoPath);
    const unified = `--unified=${context === 'full' ? 1000000 : 5}`;
    let diff;
    if (staged) {
      diff = await git.diff(['--cached', '--no-color', unified, '--', file]);
    } else if (untracked) {
      // Untracked files have no git diff — show their contents as all additions.
      let content = '';
      try { content = fs.readFileSync(path.join(repoPath, file), 'utf8'); } catch (e) {}
      const lines = content.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      diff = lines.length
        ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => '+' + l).join('\n')
        : '';
    } else {
      diff = await git.diff(['--no-color', unified, '--', file]);
    }
    return { success: true, diff };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Discard a file's changes: delete it if untracked, else restore it to HEAD
ipcMain.handle('git:discard', async (event, { repoPath, file, untracked }) => {
  try {
    if (untracked) {
      fs.rmSync(path.join(repoPath, file), { force: true });
    } else {
      await simpleGit(repoPath).raw(['checkout', 'HEAD', '--', file]);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Stage the given paths (git add)
ipcMain.handle('git:stage', async (event, { repoPath, paths }) => {
  try {
    await simpleGit(repoPath).add(paths);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Unstage the given paths (git reset -- <paths>)
ipcMain.handle('git:unstage', async (event, { repoPath, paths }) => {
  try {
    await simpleGit(repoPath).reset(['--', ...paths]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Stage everything (git add -A)
ipcMain.handle('git:stageAll', async (event, { repoPath }) => {
  try {
    await simpleGit(repoPath).raw(['add', '-A']);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Unstage everything (git reset)
ipcMain.handle('git:unstageAll', async (event, { repoPath }) => {
  try {
    await simpleGit(repoPath).raw(['reset']);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Push the current branch (setting upstream if it has none)
ipcMain.handle('git:push', async (event, { repoPath }) => {
  try {
    const git = simpleGit(repoPath);
    const status = await git.status();
    const branch = status.current;
    if (status.tracking) {
      await git.push();
    } else {
      await git.push(['-u', 'origin', branch]);
    }
    return { success: true, branch };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('git:pushForce', async (event, { repoPath }) => {
  try {
    const git = simpleGit(repoPath);
    const status = await git.status();
    const branch = status.current;
    if (status.tracking) {
      await git.push(['--force-with-lease']);
    } else {
      await git.push(['-u', 'origin', branch, '--force-with-lease']);
    }
    return { success: true, branch };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Smart (heuristic) commit message generation ─────────────────────────────
// Gathers git facts here; the actual wording lives in commit-message.js (pure).
const { buildCommitMessage } = require('./commit-message');

// Parse `git ... --name-status -z` into [{ status, path, oldPath }].
function parseNameStatusZ(out) {
  const t = out.split('\0');
  const files = [];
  for (let i = 0; i < t.length; i++) {
    const code = (t[i] || '').replace(/^\n+/, '');
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') { files.push({ status: code[0], oldPath: t[i + 1], path: t[i + 2] }); i += 2; }
    else { files.push({ status: code[0], path: t[i + 1], oldPath: null }); i += 1; }
  }
  return files;
}

// Suggest a commit message. Without `sha`, describes the staged changes (or the
// working-tree changes if nothing is staged); with `sha`, that commit's changes.
ipcMain.handle('git:suggestCommit', async (event, { repoPath, sha }) => {
  try {
    const git = simpleGit(repoPath);
    const safe = async fn => { try { return await fn(); } catch (e) { return ''; } };
    const NS = ['--name-status', '-z', '-M'];
    const NUM = ['--numstat', '-z', '-M'];
    let nameStatus, numstat, diffText, extraUntracked = [];

    if (sha) {
      const f = ['--format=', '-m', '--first-parent', '-M'];
      nameStatus = await git.raw(['show', ...f, '--name-status', '-z', sha]);
      numstat = await git.raw(['show', ...f, '--numstat', '-z', sha]);
      diffText = await git.raw(['show', ...f, sha]);
    } else {
      nameStatus = await git.raw(['diff', '--cached', ...NS]);
      numstat = await git.raw(['diff', '--cached', ...NUM]);
      diffText = await git.raw(['diff', '--cached', '-M']);
      if (!nameStatus.replace(/\0/g, '').trim()) {
        // Nothing staged: describe working-tree changes (tracked edits vs HEAD
        // plus untracked files as additions).
        nameStatus = await safe(() => git.raw(['diff', 'HEAD', ...NS]));
        numstat = await safe(() => git.raw(['diff', 'HEAD', ...NUM]));
        diffText = await safe(() => git.raw(['diff', 'HEAD', '-M']));
        extraUntracked = (await git.raw(['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
      }
    }

    const stats = parseNumstatZ(numstat);
    const files = parseNameStatusZ(nameStatus).map((f, i) => ({
      ...f, adds: stats[i] ? stats[i].adds : 0, dels: stats[i] ? stats[i].dels : 0,
    }));
    for (const u of extraUntracked) {
      let lines = 0;
      try {
        const full = path.join(repoPath, u);
        if (fs.statSync(full).size < 1e6) lines = fs.readFileSync(full, 'utf8').split('\n').length;
      } catch (e) { /* binary / unreadable */ }
      files.push({ status: 'A', path: u, oldPath: null, adds: lines, dels: 0 });
    }
    if (!files.length) return { success: true, message: '' };

    // Context for style/ticket learning (only for new commits).
    let branch = '', history = [], mergeMsg = '';
    if (!sha) {
      branch = (await safe(() => git.raw(['rev-parse', '--abbrev-ref', 'HEAD']))).trim();
      history = (await safe(() => git.raw(['log', '-n', '40', '--format=%s']))).split('\n').filter(Boolean);
      const mm = (await safe(() => git.raw(['rev-parse', '--git-path', 'MERGE_MSG']))).trim();
      if (mm) { try { mergeMsg = fs.readFileSync(path.resolve(repoPath, mm), 'utf8').replace(/^#.*$/gm, '').trim(); } catch (e) { /* none */ } }
    }

    const r = buildCommitMessage({ files, diffText: diffText.slice(0, 600000), branch, history, mergeMsg });
    return { success: true, message: r.message, subject: r.subject, body: r.body };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Project icon (logo / favicon found inside the repo) ─────────────────────
// Looks for an obvious logo or icon file in the repo's working tree (root and a
// few conventional asset folders). Returns a small data URL, or null.
const ICON_DIRS = ['', 'assets', 'asset', 'images', 'img', 'static', 'public', 'resources', 'build',
  'docs', '.github', 'media', 'brand', 'branding', 'icons', 'src', 'src/assets', 'src/renderer',
  'src/renderer/assets', 'app', 'web', 'www'];
const ICON_EXT_SCORE = { '.png': 10, '.svg': 9, '.webp': 7, '.ico': 6, '.jpg': 4, '.jpeg': 4 };

function scoreIconFile(name, dir) {
  const ext = path.extname(name).toLowerCase();
  if (!(ext in ICON_EXT_SCORE)) return 0;
  const stem = name.slice(0, -ext.length).toLowerCase();
  if (/sprite|social|banner|og[-_]|screenshot|preview|hero|background|placeholder|arrow|chevron|spinner/.test(stem)) return 0;
  let s = 0;
  if (stem === 'logo') s = 100;
  else if (stem === 'favicon') s = 95;
  else if (/^(app[-_]?)?icon$/.test(stem)) s = 90;
  else if (/^(logo|icon|favicon|brand|mark)[-_.]?[\w.-]*$/.test(stem) || /[-_.](logo|icon)$/.test(stem)) s = 70;
  else if (/logo|favicon/.test(stem)) s = 55;
  else if (/icon/.test(stem)) s = 40;
  else return 0;
  if (dir === '') s += 30;
  else if (/^(assets|asset|images|img|static|public|resources|build|branding|brand|media)$/.test(dir)) s += 15;
  return s + ICON_EXT_SCORE[ext];
}

function findProjectIcon(repoPath) {
  let best = null;
  for (const dir of ICON_DIRS) {
    let entries;
    try { entries = fs.readdirSync(path.join(repoPath, dir), { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const score = scoreIconFile(ent.name, dir);
      if (score <= 0) continue;
      const full = path.join(repoPath, dir, ent.name);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (e) { continue; }
      if (!size || size > 2 * 1024 * 1024) continue;
      if (!best || score > best.score) best = { score, full, rel: path.posix.join(dir.replace(/\\/g, '/'), ent.name), size };
    }
  }
  return best;
}

ipcMain.handle('repo:projectIcon', async (event, { repoPath }) => {
  try {
    const found = findProjectIcon(repoPath);
    if (!found) return { success: true, icon: null };
    const ext = path.extname(found.full).toLowerCase();
    if (ext === '.svg') {
      if (found.size > 100 * 1024) return { success: true, icon: null };
      const b64 = fs.readFileSync(found.full).toString('base64');
      return { success: true, icon: `data:image/svg+xml;base64,${b64}`, file: found.rel };
    }
    // Raster: downscale so the stored icon is tiny.
    const img = nativeImage.createFromPath(found.full);
    if (img.isEmpty()) return { success: true, icon: null };
    const { width, height } = img.getSize();
    const scale = 48 / Math.max(width, height);
    const small = scale < 1 ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }) : img;
    return { success: true, icon: small.toDataURL(), file: found.rel };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── GitHub organisation icon ────────────────────────────────────────────────
// If a repo's origin is on GitHub, return its owner's avatar (organisation logo
// or the person's profile picture) as a small data URL; null for non-GitHub remotes.
// Only the public owner name is sent to GitHub (unauthenticated, generic UA).
ipcMain.handle('github:orgIcon', async (event, { repoPath }) => {
  try {
    const git = simpleGit(repoPath);
    let url = '';
    try { url = (await git.raw(['remote', 'get-url', 'origin'])).trim(); }
    catch (e) {
      const remotes = await git.getRemotes(true);
      url = remotes[0] && remotes[0].refs ? remotes[0].refs.fetch : '';
    }
    const m = /github\.com[:/]([^/\s]+)\/[^/\s]+?(?:\.git)?\/?$/i.exec(url);
    if (!m) return { success: true, org: null, icon: null };
    const owner = m[1];

    const headers = { 'User-Agent': 'GitDenn', Accept: 'application/vnd.github+json' };
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, { headers });
    if (!res.ok) return { success: false, error: `GitHub lookup failed (${res.status})` };
    const info = await res.json();

    const sep = info.avatar_url.includes('?') ? '&' : '?';
    const img = await fetch(`${info.avatar_url}${sep}s=48`, { headers: { 'User-Agent': 'GitDenn' } });
    if (!img.ok) return { success: false, error: `Avatar download failed (${img.status})` };
    const type = (img.headers.get('content-type') || 'image/png').split(';')[0];
    const buf = Buffer.from(await img.arrayBuffer());
    return { success: true, org: owner, kind: info.type, icon: `data:${type};base64,${buf.toString('base64')}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Pull the current branch from its upstream
// Turn the most common raw git failures into something readable; otherwise keep
// the original text (minus the noisy line-ending warnings).
function friendlyPullError(err) {
  const msg = String(err && err.message || err);
  if (/CONFLICT|Automatic merge failed|could not apply|Applying autostash resulted in conflicts/i.test(msg)) {
    return 'The pull brought in changes that conflict with yours. Resolve the conflicted files, then commit (your stashed changes, if any, are kept in "git stash").\n\n' + msg;
  }
  return msg.split('\n').filter(l => !/^warning: in the working copy/i.test(l)).join('\n').trim();
}

// Pulls stash uncommitted changes first and restore them afterwards (--autostash),
// so local edits to files the pull touches no longer block it.
ipcMain.handle('git:pull', async (event, { repoPath }) => {
  try {
    await simpleGit(repoPath).pull(['--autostash']);
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlyPullError(err) };
  }
});

// Pull a specific local branch. The checked-out branch gets a normal pull; any
// other branch is fast-forwarded from its upstream without checking it out
// (`git fetch <remote> <remoteRef>:<branch>` refuses non-fast-forward updates).
ipcMain.handle('git:pullBranch', async (event, { repoPath, branch }) => {
  try {
    const git = simpleGit(repoPath);
    const current = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (current === branch) {
      await git.pull(['--autostash']);
      return { success: true, upToDate: false };
    }
    const cfg = async key => {
      try { return (await git.raw(['config', '--get', key])).trim(); } catch (e) { return ''; }
    };
    const remote = await cfg(`branch.${branch}.remote`);
    const merge = await cfg(`branch.${branch}.merge`);
    if (!remote || !merge) {
      return { success: false, error: `'${branch}' has no upstream branch to pull from.` };
    }
    const before = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim();
    await git.raw(['fetch', remote, `${merge}:refs/heads/${branch}`]);
    const after = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim();
    return { success: true, upToDate: before === after };
  } catch (err) {
    const msg = /non-fast-forward|rejected/i.test(err.message)
      ? `Cannot fast-forward '${branch}' — it has diverged from its upstream. Check it out and pull/rebase instead.`
      : friendlyPullError(err);
    return { success: false, error: msg };
  }
});

ipcMain.handle('git:pullRebase',async (event, { repoPath }) => {
  try {
    await simpleGit(repoPath).pull(['--rebase', '--autostash']);
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlyPullError(err) };
  }
});

// ─── Stash ────────────────────────────────────────────────────────────────────
ipcMain.handle('git:stashList', async (event, { repoPath }) => {
  try {
    const out = await simpleGit(repoPath).raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cr']);
    const stashes = out.split('\n').filter(Boolean).map(line => {
      const [ref, subject, when] = line.split('\x1f');
      const idx = parseInt((/\{(\d+)\}/.exec(ref) || [])[1], 10);
      // Subjects look like "On <branch>: <message>" or "WIP on <branch>: <sha> <msg>".
      const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject || '');
      return { index: idx, branch: m ? m[1] : '', message: m ? m[2] : (subject || ''), when: when || '' };
    });
    return { success: true, stashes };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('git:stashPush', async (event, { repoPath, message, includeUntracked }) => {
  try {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message && message.trim()) args.push('-m', message.trim());
    const out = await simpleGit(repoPath).raw(args);
    if (/No local changes to save/i.test(out)) return { success: false, error: 'There are no changes to stash.' };
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlyPullError(err) };
  }
});

// op: 'apply' (keep the stash), 'pop' (apply + remove) or 'drop' (discard).
ipcMain.handle('git:stashOp', async (event, { repoPath, op, index }) => {
  try {
    if (!['apply', 'pop', 'drop'].includes(op) || !Number.isInteger(index) || index < 0) {
      return { success: false, error: 'Invalid stash operation.' };
    }
    await simpleGit(repoPath).raw(['stash', op, `stash@{${index}}`]);
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlyPullError(err) };
  }
});

ipcMain.handle('git:rebaseOnto', async (event, { repoPath, branch }) => {
  try {
    const git = simpleGit(repoPath);
    await git.fetch('origin', branch);
    await git.rebase(['--autostash', `origin/${branch}`]);
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlyPullError(err) };
  }
});

// Commit the staged changes
ipcMain.handle('git:commit', async (event, { repoPath, message }) => {
  try {
    const result = await simpleGit(repoPath).commit(message);
    return { success: true, commit: result.commit };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Full commit message (subject + body) for a sha
ipcMain.handle('git:commitMessage', async (event, { repoPath, sha }) => {
  try {
    const msg = await simpleGit(repoPath).raw(['log', '-1', '--format=%B', sha]);
    return { success: true, message: msg.replace(/\s+$/, '') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('git:commitAmend', async (event, { repoPath, message }) => {
  try {
    const git = simpleGit(repoPath);
    const args = message ? ['--amend', '-m', message] : ['--amend', '--no-edit'];
    await git.raw(['commit', ...args]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Squash several commits on the current branch into one. The selected commits
// must be a contiguous run on HEAD's first-parent history with no merges. The
// squashed commit reuses the newest selected commit's tree (so the result is
// identical content), is parented on the oldest's parent, and any newer commits
// are replayed on top of it (conflict-free, since the trees match).
// Cherry-pick commits (oldest first) onto the current branch. GitDenn has no
// conflict-resolution screen, so if anything goes wrong the whole pick is aborted
// and the branch is left exactly as it was.
ipcMain.handle('git:cherryPick', async (event, { repoPath, shas }) => {
  const git = simpleGit(repoPath);
  try {
    if (!Array.isArray(shas) || !shas.length || !shas.every(s => /^[0-9a-f]{7,40}$/i.test(s))) {
      throw new Error('No commits to cherry-pick.');
    }
    const args = ['cherry-pick'];
    const parents = async sha => (await git.raw(['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').length - 1;
    const merges = [];
    for (const s of shas) if (await parents(s) > 1) merges.push(s);
    if (merges.length) {
      if (shas.length > 1) throw new Error('Merge commits can only be cherry-picked on their own (select just the merge commit).');
      args.push('-m', '1'); // replay the merge relative to its first parent
    }
    await git.raw([...args, ...shas]);
    return { success: true };
  } catch (err) {
    let msg = String(err && err.message || err);
    try { await git.raw(['cherry-pick', '--abort']); } catch (e) { /* nothing in progress */ }
    if (/conflict/i.test(msg)) {
      msg = 'The changes conflict with the current branch, so the cherry-pick was cancelled and nothing was changed.';
    } else if (/would be overwritten|local changes/i.test(msg)) {
      msg = 'You have uncommitted changes to files this commit touches. Commit or stash them first.';
    } else if (/empty/i.test(msg)) {
      msg = "Nothing to apply: this commit's changes are already in the current branch.";
    }
    return { success: false, error: msg };
  }
});

ipcMain.handle('git:squash', async (event, { repoPath, shas, message }) => {
  const git = simpleGit(repoPath);
  let rebasing = false;
  try {
    if (!Array.isArray(shas) || shas.length < 2) throw new Error('Select at least two commits to squash.');
    if (!message || !message.trim()) throw new Error('Commit message cannot be empty.');

    const chain = (await git.raw(['rev-list', '--first-parent', '-n', '5000', 'HEAD'])).split('\n').filter(Boolean);
    const idx = shas.map(s => chain.indexOf(s));
    if (idx.some(i => i < 0)) throw new Error('Only commits on the current branch can be squashed.');
    const min = Math.min(...idx), max = Math.max(...idx);
    if (new Set(idx).size !== shas.length || max - min !== shas.length - 1) {
      throw new Error('Selected commits must be consecutive (no gaps) on the current branch.');
    }
    const newest = chain[min];
    const oldest = chain[max];

    const parents = (await git.raw(['rev-list', '--parents', '-n', '1', oldest])).trim().split(' ');
    if (parents.length < 2) throw new Error('Cannot squash the root commit.');
    const base = parents[1];
    const merges = (await git.raw(['rev-list', '--merges', `${base}..HEAD`])).trim();
    if (merges) throw new Error('Cannot squash across merge commits.');

    const tree = (await git.raw(['rev-parse', `${newest}^{tree}`])).trim();
    const newSha = (await git.raw(['commit-tree', tree, '-p', base, '-m', message.trim()])).trim();

    if (min === 0) {
      // Newest selected commit is HEAD: just move the branch; working tree and
      // index are untouched.
      await git.raw(['reset', '--soft', newSha]);
    } else {
      rebasing = true;
      await git.raw(['rebase', '--autostash', '--onto', newSha, newest]);
      rebasing = false;
    }
    return { success: true, sha: newSha };
  } catch (err) {
    if (rebasing) { try { await git.raw(['rebase', '--abort']); } catch (e) { /* ignore */ } }
    return { success: false, error: err.message };
  }
});

// Set the window/taskbar icon from a PNG data URL (rendered by the renderer)
ipcMain.handle('window:setIcon', (event, { dataUrl }) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (mainWindow && !img.isEmpty()) mainWindow.setIcon(img);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open a URL in the default browser
ipcMain.handle('shell:openExternal', async (event, { url }) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open the repo folder in a NEW VS Code window. Uses the `code` CLI with
// --new-window; falls back to the vscode:// URL protocol (which reuses the
// current window) if the CLI isn't on PATH.
ipcMain.handle('shell:openInVscode', async (event, { repoPath }) => {
  const quoted = `"${repoPath.replace(/"/g, '\\"')}"`;
  return new Promise(resolve => {
    exec(`code --new-window ${quoted}`, err => {
      if (!err) return resolve({ success: true });
      // CLI unavailable → fall back to the URL protocol (reuses a window)
      shell.openExternal('vscode://file/' + repoPath.replace(/\\/g, '/'))
        .then(() => resolve({ success: true, viaProtocol: true }))
        .catch(e => resolve({ success: false, error: e.message }));
    });
  });
});

// Show the repo folder in the OS file manager (Explorer / Finder / ...).
ipcMain.handle('shell:openExplorer', async (event, { repoPath }) => {
  const err = await shell.openPath(repoPath);
  return err ? { success: false, error: err } : { success: true };
});

// Open a terminal with the repo as its working directory. No shell string is
// built from the path: it is passed as cwd / an argument only.
ipcMain.handle('shell:openTerminal', async (event, { repoPath }) => {
  const launch = (cmd, args) => new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    try {
      const child = spawn(cmd, args, { cwd: repoPath, detached: true, stdio: 'ignore' });
      child.on('error', e => finish({ success: false, error: e.message }));
      child.unref();
      setTimeout(() => finish({ success: true }), 400); // no spawn error by now → started
    } catch (e) { finish({ success: false, error: e.message }); }
  });
  if (process.platform === 'win32') {
    // Windows Terminal if installed, otherwise a plain cmd window.
    const wt = await launch('wt.exe', ['-d', repoPath]);
    if (wt.success) return wt;
    return launch('cmd.exe', ['/c', 'start', '', 'cmd.exe']);
  }
  if (process.platform === 'darwin') return launch('open', ['-a', 'Terminal', repoPath]);
  for (const t of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    const r = await launch(t, []);
    if (r.success) return r;
  }
  return { success: false, error: 'No terminal emulator found.' };
});

// Rename a local branch (git branch -m <old> <new>)
ipcMain.handle('git:renameBranch', async (event, { repoPath, oldName, newName }) => {
  try {
    await simpleGit(repoPath).raw(['branch', '-m', oldName, newName]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Delete a local branch (must not be currently checked out)
ipcMain.handle('git:deleteBranch', async (event, { repoPath, name }) => {
  try {
    const git = simpleGit(repoPath);
    await git.deleteLocalBranch(name, true); // true = force delete (-D)
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Create a new local branch off the current HEAD and switch to it
ipcMain.handle('git:createBranch', async (event, { repoPath, name }) => {
  try {
    const git = simpleGit(repoPath);
    await git.checkoutLocalBranch(name); // git checkout -b <name>
    return { success: true, branch: name };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Fetch from remote
ipcMain.handle('git:fetch', async (event, { repoPath }) => {
  try {
    const git = simpleGit(repoPath);
    await git.fetch(['--all', '--prune']);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Cheap ref snapshot (ahead/behind + branch tips). Optionally fetches first so
// the numbers reflect the remote's latest state. Used for background refresh.
ipcMain.handle('git:refs', async (event, { repoPath, fetch }) => {
  try {
    const git = simpleGit(repoPath);
    if (fetch) {
      try { await git.env({ ...process.env, GIT_TERMINAL_PROMPT: '0' }).fetch(['--all', '--prune']); }
      catch (e) { /* offline / auth failure: still report local refs */ }
    }
    const { tracking, branchShas, branchDates, defaultBranch } = await readRefInfo(git);
    return { success: true, tracking, branchShas, branchDates, defaultBranch };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Per-branch ahead/behind vs. upstream (git's own tracking info) plus full
// 40-char SHAs keyed by the branch name as the sidebar stores it:
//   local  refs/heads/main            → 'main'
//   remote refs/remotes/origin/feat   → 'remotes/origin/feat'
async function readRefInfo(git) {
  const tracking = {};
  const branchShas = {};
  const branchDates = {};
  try {
    const raw = await git.raw([
      'for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads',
    ]);
    raw.split('\n').forEach(line => {
      const tab = line.indexOf('\t');
      if (tab < 0) return;
      const name = line.slice(0, tab);
      const track = line.slice(tab + 1);
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      if (name) tracking[name] = { ahead: ahead ? +ahead[1] : 0, behind: behind ? +behind[1] : 0 };
    });
  } catch (e) { /* no upstreams */ }

  try {
    const refOut = await git.raw([
      'for-each-ref', '--format=%(refname)\t%(objectname)\t%(committerdate:unix)', 'refs/heads', 'refs/remotes',
    ]);
    refOut.split('\n').forEach(line => {
      const [refname0, sha0, date0] = line.split('\t');
      const refname = (refname0 || '').trim();
      const sha = (sha0 || '').trim();
      if (!refname || !sha) return;
      let key;
      if (refname.startsWith('refs/heads/')) {
        key = refname.slice('refs/heads/'.length);
      } else if (refname.startsWith('refs/remotes/')) {
        key = 'remotes/' + refname.slice('refs/remotes/'.length);
      }
      if (key) {
        branchShas[key] = sha;
        const d = parseInt(date0, 10);
        if (d) branchDates[key] = d; // last commit date of the branch tip (unix seconds)
      }
    });
  } catch (e) { /* ignore */ }

  // The repo's default branch (what origin/HEAD points at) is never "stale".
  let defaultBranch = null;
  try {
    const sym = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim(); // origin/master
    defaultBranch = sym.replace(/^[^/]+\//, '');
  } catch (e) {
    defaultBranch = ['main', 'master'].find(n => branchShas[n] || branchShas['remotes/origin/' + n]) || null;
  }

  return { tracking, branchShas, branchDates, defaultBranch };
}

function parseRawLog(raw) {
  const entries = raw.split('---END---').filter(e => e.trim());
  return entries.map(entry => {
    const lines = entry.trim().split('\n');
    const sha = (lines[0] || '').trim();
    const parents = (lines[1] || '').trim().split(' ').filter(Boolean);
    const authorName = (lines[2] || '').trim();
    const authorEmail = (lines[3] || '').trim();
    const timestamp = parseInt((lines[4] || '0').trim(), 10);
    const subject = (lines[5] || '').trim();
    const refs = (lines[6] || '').trim();

    const refsList = refs
      ? refs.split(', ').filter(Boolean).map(r => r.trim())
      : [];

    return {
      sha,
      shortSha: sha.slice(0, 7),
      parents,
      authorName,
      authorEmail,
      timestamp,
      date: new Date(timestamp * 1000).toISOString(),
      subject,
      refs: refsList,
    };
  }).filter(c => c.sha);
}
