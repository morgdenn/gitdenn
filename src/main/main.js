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

    // Per-branch ahead/behind vs. upstream, from git's own tracking info.
    const tracking = {};
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

    // Full 40-char SHAs keyed by the branch name as the sidebar stores it:
    //   local  refs/heads/main            → 'main'
    //   remote refs/remotes/origin/feat   → 'remotes/origin/feat'
    const branchShas = {};
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
    const diff = await git.show([sha, '--stat', '--format=']);
    const fullDiff = await git.show([sha, '--format=']);
    return { success: true, stat: diff, diff: fullDiff };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

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
ipcMain.handle('git:fileDiff', async (event, { repoPath, file, staged, untracked }) => {
  try {
    const git = simpleGit(repoPath);
    let diff;
    if (staged) {
      diff = await git.diff(['--cached', '--', file]);
    } else if (untracked) {
      // Untracked files have no git diff — show their contents as all additions.
      let content = '';
      try { content = fs.readFileSync(path.join(repoPath, file), 'utf8'); } catch (e) {}
      const lines = content.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      diff = '@@ new file @@\n' + lines.map(l => '+' + l).join('\n');
    } else {
      diff = await git.diff(['--', file]);
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
// Conventional-commit type rules by path/extension. First match wins.
const COMMIT_TYPE_RULES = [
  [/(^|\/)tests?\//, 'test'],
  [/(^|\/)__tests__\//, 'test'],
  [/\.(test|spec)\.[jt]sx?$/, 'test'],
  [/(^|\/)\.github\/workflows\//, 'ci'],
  [/(Jenkinsfile|\.gitlab-ci\.ya?ml|buildspec\.ya?ml)$/, 'ci'],
  [/\.tf$/, 'infra'],
  [/(^|\/)docs?\/|README|CHANGELOG|\.md$/i, 'docs'],
  [/(package(-lock)?\.json|requirements.*\.txt|Pipfile|go\.(mod|sum)|Gemfile|pom\.xml|\.csproj$)/, 'build'],
  [/Dockerfile|docker-compose\.ya?ml/, 'build'],
  [/\.(ya?ml|json|toml|ini|cfg|env)$/, 'chore'],
];
const STATUS_ACTION = { A: 'add', D: 'remove', M: 'update', R: 'rename', C: 'copy' };
const FIX_KEYWORDS = /\b(fix(e[sd])?|bug|error|issue|crash|resolve[sd]?|patch)\b/i;

function classifyCommitFile(p) {
  for (const [re, type] of COMMIT_TYPE_RULES) if (re.test(p)) return type;
  return null; // ordinary source — decided later from status/keywords
}

function scopeFromPath(p) {
  const parts = p.split('/');
  if (parts.length === 1) return null;
  for (const seg of parts.slice(0, -1)) if (!['src', 'lib', 'app', '.'].includes(seg)) return seg;
  return parts[0];
}

function topKey(counts) {
  let best = null, n = -1;
  for (const [k, v] of Object.entries(counts)) if (v > n) { best = k; n = v; }
  return best;
}

// Suggest a Conventional-Commits subject. Without `sha`, uses the staged
// changes; with `sha`, uses that commit's own changes (for rewording).
ipcMain.handle('git:suggestCommit', async (event, { repoPath, sha }) => {
  try {
    const git = simpleGit(repoPath);
    const nameStatus = sha
      ? await git.raw(['show', '--name-status', '--format=', sha])
      : await git.diff(['--cached', '--name-status']);
    const diffText = sha
      ? await git.raw(['show', '--format=', sha])
      : await git.diff(['--cached']);

    const files = [];
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      files.push({ code: parts[0][0], path: parts[parts.length - 1] });
    }
    if (!files.length) return { success: true, message: '' };

    const fixSignal = FIX_KEYWORDS.test(diffText);
    const typeCount = {}, scopeCount = {}, actionCount = {};
    for (const { code, path: p } of files) {
      let type = classifyCommitFile(p);
      if (type === null) {
        if (code === 'D') type = 'chore';
        else if (code === 'A') type = 'feat';
        else type = fixSignal ? 'fix' : 'refactor';
      }
      typeCount[type] = (typeCount[type] || 0) + 1;
      const scope = scopeFromPath(p);
      if (scope) scopeCount[scope] = (scopeCount[scope] || 0) + 1;
      const action = STATUS_ACTION[code] || 'update';
      actionCount[action] = (actionCount[action] || 0) + 1;
    }

    const dominantType = topKey(typeCount);
    const dominantScope = Object.keys(scopeCount).length ? topKey(scopeCount) : null;
    const detail = files.length === 1
      ? `${STATUS_ACTION[files[0].code] || 'update'} ${files[0].path}`
      : `${topKey(actionCount)} ${files.length} files`;

    const scopePart = dominantScope ? `(${dominantScope})` : '';
    const subject = `${dominantType}${scopePart}: ${detail}`.slice(0, 72);
    return { success: true, message: subject };
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

ipcMain.handle('git:pullRebase', async (event, { repoPath }) => {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
