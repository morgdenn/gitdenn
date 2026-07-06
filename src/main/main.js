const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const simpleGit = require('simple-git');
const fs = require('fs');

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

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
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
    const remotes = await git.remote(['-v']);

    return {
      success: true,
      commits,
      branches: branches.all,
      currentBranch: branches.current,
      status: {
        modified: status.modified.length,
        staged: status.staged.length,
        untracked: status.not_added.length,
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
