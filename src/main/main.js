const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const simpleGit = require('simple-git');
const fs = require('fs');
const { exec } = require('child_process');

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

    const { tracking, branchShas } = await readRefInfo(git);

    return {
      success: true,
      commits,
      branches: branches.all,
      branchShas,
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
ipcMain.handle('git:pull', async (event, { repoPath }) => {
  try {
    await simpleGit(repoPath).pull();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
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
      await git.pull();
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
      : err.message;
    return { success: false, error: msg };
  }
});

ipcMain.handle('git:pullRebase',async (event, { repoPath }) => {
  try {
    await simpleGit(repoPath).pull(['--rebase']);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('git:rebaseOnto', async (event, { repoPath, branch }) => {
  try {
    const git = simpleGit(repoPath);
    await git.fetch('origin', branch);
    await git.rebase([`origin/${branch}`]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
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
    const { tracking, branchShas } = await readRefInfo(git);
    return { success: true, tracking, branchShas };
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
      'for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes',
    ]);
    refOut.split('\n').forEach(line => {
      const tab = line.indexOf('\t');
      if (tab < 0) return;
      const refname = line.slice(0, tab).trim();
      const sha = line.slice(tab + 1).trim();
      if (!sha) return;
      let key;
      if (refname.startsWith('refs/heads/')) {
        key = refname.slice('refs/heads/'.length);
      } else if (refname.startsWith('refs/remotes/')) {
        key = 'remotes/' + refname.slice('refs/remotes/'.length);
      }
      if (key) branchShas[key] = sha;
    });
  } catch (e) { /* ignore */ }

  return { tracking, branchShas };
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
