// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  repoPath: null,
  commits: [],
  branches: [],
  currentBranch: null,
  selectedSha: null,
  recentRepos: JSON.parse(localStorage.getItem('recentRepos') || '[]'),
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const welcomeScreen   = $('welcome-screen');
const cloneModal      = $('clone-modal');
const branchModal     = $('branch-modal');
const pushModal       = $('push-modal');
const rebaseModal     = $('rebase-modal');
const repoView        = $('repo-view');
const commitRows      = $('commit-rows');
const graphCanvas     = $('graph-canvas');
const detailPlaceholder = $('detail-placeholder');
const detailContent   = $('detail-content');
const graphScroll     = $('graph-scroll');

// ─── Graph layout constants ───────────────────────────────────────────────────
const ROW_H    = 28;
let   GRAPH_W  = 220;
const COL_W    = 22;   // px per branch lane (wide enough for avatar nodes)
const NODE_R   = 9;    // commit avatar radius
const LANE_PAD = 14;   // left padding before first lane
const NODE_FONT = '700 9px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Branch lane colours (cycling) — Monokai palette, no purple
const LANE_COLORS = [
  '#a6e22e', '#66d9ef', '#f92672', '#fd971f',
  '#e6db74', '#a1efe4', '#f45b8f', '#b8e673',
  '#78dce8', '#ffa94d', '#d1d648', '#7bd88f',
];
const laneColor = lane => LANE_COLORS[lane % LANE_COLORS.length];

// Author initials for avatar nodes: "Ian Anderson" → "IA", "Kevin" → "K".
function authorInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
}

// Pick a readable text colour (dark or light) for a filled node of hex colour.
function textOn(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#1e1f1c' : '#f8f8f2';
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderRecentRepos();
  bindEvents();
  setAppIcon();
});

// Draw the den logo (bear at a round cave) with canvas primitives — matches the
// inline SVG in index.html — and set it as the window/taskbar icon.
function drawDenLogo(ctx, size) {
  const s = size / 64;
  ctx.save();
  ctx.scale(s, s);
  const circle = (x, y, r, fill) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  };
  const ellipse = (x, y, rx, ry, fill, alpha) => {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.fillStyle = fill; ctx.fill(); ctx.globalAlpha = 1;
  };
  circle(32, 31, 28, '#45463c');                                  // stone rim
  ctx.beginPath(); ctx.arc(32, 31, 28, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(166,226,46,0.55)'; ctx.lineWidth = 2; ctx.stroke(); // accent ring
  circle(32, 33, 22, '#141509');                                  // dark opening
  ellipse(32, 60, 27, 8, '#5f8a29');                              // grassy ground
  ellipse(32, 46, 14, 13, '#9c7248');                             // body
  ellipse(24, 54, 4.5, 3.3, '#7d5a38');                           // paws
  ellipse(40, 54, 4.5, 3.3, '#7d5a38');
  ellipse(32, 48, 8, 8, '#c9a06f', 0.5);                          // belly
  circle(23, 23, 4.5, '#8a6440'); circle(41, 23, 4.5, '#8a6440'); // ears
  circle(23, 23, 2, '#c9a06f');   circle(41, 23, 2, '#c9a06f');
  circle(32, 29, 11, '#9c7248');                                  // head
  ellipse(32, 33, 6, 4.6, '#ecd8b6');                             // muzzle
  ellipse(32, 30.5, 2, 1.4, '#2b2a25');                           // nose
  circle(27.5, 27, 1.6, '#2b2a25'); circle(36.5, 27, 1.6, '#2b2a25'); // eyes
  ctx.restore();
}

function setAppIcon() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    drawDenLogo(c.getContext('2d'), 256);
    window.gitApp.setIcon(c.toDataURL('image/png'));
  } catch (e) { /* non-fatal */ }
}

function bindEvents() {
  $('btn-clone').addEventListener('click', showCloneModal);
  $('welcome-clone').addEventListener('click', showCloneModal);
  $('btn-open').addEventListener('click', openRepo);
  $('welcome-open').addEventListener('click', openRepo);

  $('clone-cancel').addEventListener('click', hideCloneModal);
  $('clone-cancel-2').addEventListener('click', hideCloneModal);
  $('clone-browse').addEventListener('click', browseDestination);
  $('clone-confirm').addEventListener('click', doClone);

  $('btn-fetch').addEventListener('click', doFetch);

  $('btn-branch').addEventListener('click', showBranchModal);
  $('btn-pull').addEventListener('click', doPull);
  $('btn-rebase').addEventListener('click', showRebaseModal);
  $('btn-push').addEventListener('click', showPushModal);
  $('btn-github').addEventListener('click', () => {
    if (state.githubUrl) window.gitApp.openExternal(state.githubUrl);
  });
  $('btn-vscode').addEventListener('click', () => {
    if (state.repoPath) window.gitApp.openInVscode(state.repoPath);
  });
  $('branch-cancel').addEventListener('click', hideBranchModal);
  $('branch-cancel-2').addEventListener('click', hideBranchModal);
  $('branch-confirm').addEventListener('click', doCreateBranch);
  $('push-cancel').addEventListener('click', hidePushModal);
  $('push-cancel-2').addEventListener('click', hidePushModal);
  $('push-confirm').addEventListener('click', () => { hidePushModal(); doPush(false); });
  $('push-force-confirm').addEventListener('click', () => { hidePushModal(); doPush(true); });
  $('rebase-cancel').addEventListener('click', hideRebaseModal);
  $('rebase-cancel-2').addEventListener('click', hideRebaseModal);
  $('rebase-confirm').addEventListener('click', () => { const b = $('rebase-branch-select').value; hideRebaseModal(); doRebaseOnto(b); });
  $('branch-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') doCreateBranch();
  });

  initColumnResizers();
  initSidebarPanels();
  initBranchSplit();
  initDetailResize();

  // Close the commit dropdown when clicking outside it
  document.addEventListener('click', e => {
    const dd = $('commit-dropdown');
    if (dd && !dd.hidden && !e.target.closest('.commit-split-btn')) dd.hidden = true;
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideCloneModal(); hideBranchModal(); hidePushModal(); hideRebaseModal(); hideSquashModal(); closeFileDiff(); hideBranchCtxMenu(); hideCommitCtxMenu(); const dd = $('commit-dropdown'); if (dd) dd.hidden = true; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') loadRepo(state.repoPath);
    // Ctrl/Cmd+Shift+E → open the repo in VS Code
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      if (state.repoPath) window.gitApp.openInVscode(state.repoPath);
    }
  });

  // Graph scroll → repaint canvas
  graphScroll.addEventListener('scroll', () => paintGraph(state.graphData));

  // Reflect working-directory changes automatically: immediately on focus, and
  // via a light poll that runs whether or not the window is focused (so edits
  // show while GitDenn sits side-by-side with an editor).
  window.addEventListener('focus', () => { refreshWorkingState(); refreshRefs(false); });
  setInterval(() => {
    if (state.repoPath) refreshWorkingState();
  }, 2000);

  // Keep branch ↑/↓ counts current: a cheap local ref check every 5s (catches
  // commits/pulls made elsewhere) and a real `git fetch` every 60s so remote
  // changes show up like in other clients.
  setInterval(() => refreshRefs(false), 5000);
  setInterval(() => refreshRefs(true), 60000);

  // Commit row selection (delegated — survives every re-render, bound once)
  // Ctrl/Cmd-click toggles a commit in a multi-selection, Shift-click selects
  // a range; a plain click selects just that commit.
  on(commitRows, 'click', '.commit-row', (el, e) => {
    if (e && (e.ctrlKey || e.metaKey)) return toggleMultiSelect(el.dataset.sha);
    if (e && e.shiftKey) return rangeMultiSelect(el.dataset.sha);
    state.multiSel = [];
    selectCommit(el.dataset.sha, el.dataset.idx);
  });

  // Right-click a commit → context menu (squash)
  on(commitRows, 'contextmenu', '.commit-row', (el, e) => {
    e.preventDefault();
    const sha = el.dataset.sha;
    if (sha === '__WIP__') return;
    if (!(state.multiSel || []).includes(sha)) {
      state.multiSel = [];
      selectCommit(sha, el.dataset.idx);
    }
    showCommitCtxMenu(e.clientX, e.clientY);
  });

  // Click a file in a commit's file list → side-by-side diff over the graph
  on('detail-diff', 'click', '.diff-stat-line[data-idx]', el => openCommitFileDiff(+el.dataset.idx));
  $('dv-close').addEventListener('click', closeFileDiff);
  $('dv-prev').addEventListener('click', () => stepDiffChange(-1));
  $('dv-next').addEventListener('click', () => stepDiffChange(1));
  $('dv-mode').addEventListener('click', () => {
    state.diffMode = state.diffMode === 'full' ? 'hunks' : 'full';
    showFileDiff();
  });

  $('squash-cancel').addEventListener('click', hideSquashModal);
  $('squash-cancel-2').addEventListener('click', hideSquashModal);
  $('squash-confirm').addEventListener('click', doSquash);

  // Double-click a remote branch → check it out as a local tracking branch
  on('remote-branches-list', 'dblclick', '.branch-remote', el => checkoutRemoteBranch(el.dataset.branch));

  // Double-click a local branch → switch to it
  on('local-branches-list', 'dblclick', '.branch-item', el => checkoutLocalBranch(el.dataset.branch));

  // Single click a branch (local or remote) → select its tip commit in the graph
  on('local-branches-list',  'click', '.branch-item',  el => scrollToBranch(el.dataset.branch));
  on('remote-branches-list', 'click', '.branch-remote', (el, e) => { console.log('[remote click]', el.dataset.branch, el); scrollToBranch(el.dataset.branch); });

  // Right-click a local branch → context menu
  on('local-branches-list', 'contextmenu', '.branch-item', (el, e) => {
    e.preventDefault();
    showBranchCtxMenu(e.clientX, e.clientY, el.dataset.branch, { isCurrent: el.classList.contains('current'), isRemote: false });
  });

  // Right-click a remote branch → context menu
  on('remote-branches-list', 'contextmenu', '.branch-remote', (el, e) => {
    e.preventDefault();
    showBranchCtxMenu(e.clientX, e.clientY, el.dataset.branch, { isCurrent: false, isRemote: true });
  });

  // Close context menu on any click outside it
  document.addEventListener('click', e => {
    if (!e.target.closest('#branch-ctx-menu')) hideBranchCtxMenu();
    if (!e.target.closest('#commit-ctx-menu')) hideCommitCtxMenu();
  });

  // Working-directory staging/commit actions (delegated, bound once)
  on('detail-diff', 'click', '[data-act]', el => handleWipAction(el.dataset.act, el.dataset.path));
  // Clicking a file row (but not its stage/unstage button) opens its quick view
  on('detail-diff', 'click', '.wd-file', (el, e) => {
    if (e.target.closest('[data-act]')) return;
    state.fileDiff = {
      wip: true,
      file: el.dataset.path,
      staged: el.dataset.staged === 'true',
      untracked: el.dataset.untracked === 'true',
    };
    showFileDiff();
  });
  $('dv-discard').addEventListener('click', discardViewedFile);
  $('detail-diff').addEventListener('input', e => {
    if (e.target.id === 'commit-msg-input') state.commitMsg = e.target.value;
  });

  // Reword (edit message) actions in the commit detail panel
  on('detail-actions', 'click', '[data-act]', el => handleRewordAction(el.dataset.act));
}

// ─── Column Resizing ──────────────────────────────────────────────────────────
// Draggable dividers on the graph-panel header. The "message" column is the
// flexible filler that absorbs slack, so it has no handle — it is resized by
// dragging the dividers on either side of it (graph's right edge, author's left
// edge). Columns BEFORE the message column resize via their right edge; columns
// AFTER it have a pinned right edge, so they resize via their LEFT edge with an
// inverted drag direction (otherwise the handle wouldn't track the cursor).
const RESIZABLE_COLS = [
  { cls: 'col-branch', varName: '--branch-w', min: 60, side: 'right' },
  { cls: 'col-graph',  varName: '--graph-w',  min: 80, side: 'right' },
  { cls: 'col-author', varName: '--author-w', min: 60, side: 'left'  },
  { cls: 'col-date',   varName: '--date-w',   min: 60, side: 'left'  },
  { cls: 'col-sha',    varName: '--sha-w',    min: 50, side: 'left'  },
  { cls: 'col-tag',    varName: '--tag-w',    min: 50, side: 'left'  },
];

function initColumnResizers() {
  const header = $('graph-header');
  RESIZABLE_COLS.forEach(col => {
    const cell = header.querySelector('.' + col.cls);
    if (!cell) return;
    const handle = document.createElement('span');
    handle.className = `col-resizer ${col.side}`;
    handle.addEventListener('mousedown', e => startColumnResize(e, col));
    cell.appendChild(handle);
  });
}

function startColumnResize(e, col) {
  e.preventDefault();
  const startX = e.clientX;
  const rootStyle = document.documentElement.style;
  const startW = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue(col.varName),
    10
  );

  const isGraph = col.varName === '--graph-w';
  const dir = col.side === 'left' ? -1 : 1; // left-edge handles invert the drag
  document.body.classList.add('col-resizing');

  const onMove = ev => {
    const width = Math.max(col.min, startW + dir * (ev.clientX - startX));
    rootStyle.setProperty(col.varName, width + 'px');
    // The column cell reflows live via CSS. GRAPH_W drives the canvas backing
    // size, so track it here and repaint the canvas once on release (below).
    if (isGraph) GRAPH_W = width;
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('col-resizing');
    if (isGraph && state.graphData) {
      renderCommitRows(state.graphData);
      paintGraph(state.graphData);
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Sidebar Panels (Repos / Branches — collapsible + resizable) ──────────────
const SIDE_PANELS = [
  { resize: 'repos',    varName: '--repos-w',    min: 130 },
  { resize: 'branches', varName: '--branches-w', min: 130 },
];

function initSidebarPanels() {
  // Resizers — drag the divider on a panel's right edge to set its width.
  document.querySelectorAll('.panel-resizer').forEach(rz => {
    const conf = SIDE_PANELS.find(p => p.resize === rz.dataset.resize);
    if (conf) rz.addEventListener('mousedown', e => startPanelResize(e, conf));
  });

  // Collapse / expand — the header button collapses; clicking the collapsed
  // vertical label expands again.
  document.querySelectorAll('.side-panel').forEach(panel => {
    const btn = panel.querySelector('.panel-collapse-btn');
    if (btn) btn.addEventListener('click', () => panel.classList.add('collapsed'));
    const label = panel.querySelector('.panel-collapsed-label');
    if (label) label.addEventListener('click', () => panel.classList.remove('collapsed'));
  });
}

function startPanelResize(e, conf) {
  e.preventDefault();
  const startX = e.clientX;
  const rootStyle = document.documentElement.style;
  const startW = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue(conf.varName),
    10
  );

  document.body.classList.add('col-resizing');

  const onMove = ev => {
    const width = Math.max(conf.min, startW + (ev.clientX - startX));
    rootStyle.setProperty(conf.varName, width + 'px');
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('col-resizing');
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function initDetailResize() {
  const rz = $('detail-resizer');
  if (!rz) return;
  rz.addEventListener('mousedown', e => {
    e.preventDefault();
    const rootStyle = document.documentElement.style;
    const startX = e.clientX;
    const startW = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--detail-w'),
      10
    );

    document.body.classList.add('col-resizing');

    const onMove = ev => {
      // Left-edge drag: moving left increases width
      const width = Math.max(220, startW - (ev.clientX - startX));
      rootStyle.setProperty('--detail-w', width + 'px');
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('col-resizing');
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Draggable divider between the Local and Remote branch lists — sets the Local
// group's height; Remote fills the remaining space. Each list scrolls on its own.
function initBranchSplit() {
  const divider = $('branch-split');
  if (!divider) return;
  divider.addEventListener('mousedown', e => {
    e.preventDefault();
    const rootStyle = document.documentElement.style;
    const startY = e.clientY;
    const startH = $('local-group').getBoundingClientRect().height;
    const total  = $('branches-sections').getBoundingClientRect().height;
    const MIN = 48; // keep both groups usable

    document.body.classList.add('row-resizing');

    const onMove = ev => {
      const h = Math.max(MIN, Math.min(startH + (ev.clientY - startY), total - MIN));
      rootStyle.setProperty('--local-branches-h', h + 'px');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('row-resizing');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Recent Repos ─────────────────────────────────────────────────────────────
function renderRecentRepos() {
  const list = $('recent-repos-list');
  if (state.recentRepos.length === 0) {
    list.innerHTML = '<div class="empty-sidebar">No repos yet</div>';
    return;
  }
  list.innerHTML = state.recentRepos.map((r, i) => `
    <div class="repo-item ${state.repoPath === r.path ? 'active' : ''}"
         data-path="${escHtml(r.path)}"
         data-index="${i}">
      ${escHtml(r.name)}
    </div>
  `).join('');
  list.querySelectorAll('.repo-item').forEach(el => {
    el.addEventListener('click', () => loadRepo(el.dataset.path));
  });
}

function addRecentRepo(repoPath) {
  const name = repoPath.split(/[\\/]/).pop();
  state.recentRepos = [
    { path: repoPath, name },
    ...state.recentRepos.filter(r => r.path !== repoPath),
  ].slice(0, 12);
  localStorage.setItem('recentRepos', JSON.stringify(state.recentRepos));
  renderRecentRepos();
}

// ─── Clone ────────────────────────────────────────────────────────────────────
function showCloneModal() {
  cloneModal.style.display = 'flex';
  $('clone-url').focus();
  $('clone-progress').style.display = 'none';
  $('progress-fill').style.width = '0%';
}
function hideCloneModal() {
  cloneModal.style.display = 'none';
  $('clone-url').value = '';
  $('clone-dest').value = '';
}

function showBranchModal() {
  if (!state.repoPath) return;
  branchModal.style.display = 'flex';
  const base = state.currentBranch || 'current commit';
  $('branch-base-note').textContent = `Based on ${base}`;
  const input = $('branch-name');
  input.value = '';
  input.focus();
}
function hideBranchModal() {
  branchModal.style.display = 'none';
  $('branch-name').value = '';
}

function showPushModal() {
  if (!state.repoPath) return;
  const note = $('push-modal-note');
  const ahead = (state.tracking || {})[state.currentBranch];
  note.textContent = ahead && ahead.ahead
    ? `${ahead.ahead} commit${ahead.ahead === 1 ? '' : 's'} ahead of remote`
    : '';
  pushModal.style.display = 'flex';
}
function hidePushModal() {
  pushModal.style.display = 'none';
}

function showRebaseModal() {
  if (!state.repoPath) return;
  const sel = $('rebase-branch-select');
  const locals = (state.branches || []).filter(b => !b.startsWith('remotes/'));
  // Default to detected main/master, falling back to first branch that isn't current
  const preferred = ['main', 'master', 'develop', 'dev'];
  const def = preferred.find(b => locals.includes(b) && b !== state.currentBranch)
    || locals.find(b => b !== state.currentBranch)
    || locals[0];
  sel.innerHTML = locals
    .filter(b => b !== state.currentBranch)
    .map(b => `<option value="${b}"${b === def ? ' selected' : ''}>${b}</option>`)
    .join('');
  rebaseModal.style.display = 'flex';
}
function hideRebaseModal() {
  rebaseModal.style.display = 'none';
}

async function doCreateBranch() {
  const name = $('branch-name').value.trim();
  if (!name) return alert('Please enter a branch name.');
  if (/\s/.test(name)) return alert('Branch names cannot contain spaces.');

  const btn = $('branch-confirm');
  btn.disabled = true;
  const result = await window.gitApp.createBranch(state.repoPath, name);
  btn.disabled = false;
  if (!result.success) {
    alert(`Create branch failed: ${result.error}`);
    return;
  }
  hideBranchModal();
  await loadRepo(state.repoPath); // refresh branches, current branch, and graph
  showToast(`Created branch ${result.branch}`);
}

async function browseDestination() {
  const folder = await window.gitApp.chooseFolder();
  if (folder) $('clone-dest').value = folder;
}

async function doClone() {
  const url  = $('clone-url').value.trim();
  const dest = $('clone-dest').value.trim();
  if (!url || !dest) return alert('Please enter a URL and destination.');

  const repoName = url.split('/').pop().replace(/\.git$/, '') || 'repo';
  const targetDir = `${dest}/${repoName}`;

  $('clone-confirm').disabled = true;
  $('clone-progress').style.display = 'block';
  $('progress-label').textContent = 'Connecting…';

  window.gitApp.onCloneProgress(({ stage, progress }) => {
    $('progress-fill').style.width = `${progress}%`;
    $('progress-label').textContent = `${stage}: ${progress}%`;
  });

  const result = await window.gitApp.clone(url, targetDir);
  window.gitApp.removeAllListeners('git:clone-progress');

  if (result.success) {
    hideCloneModal();
    await loadRepo(targetDir);
  } else {
    alert(`Clone failed: ${result.error}`);
    $('clone-confirm').disabled = false;
    $('progress-fill').style.width = '0%';
    $('progress-label').textContent = '';
  }
}

// ─── Open Repo ────────────────────────────────────────────────────────────────
async function openRepo() {
  const result = await window.gitApp.openRepo();
  if (!result) return;
  if (result.error) return alert(result.error);
  await loadRepo(result);
}

// ─── Load Repo ────────────────────────────────────────────────────────────────
async function loadRepo(repoPath) {
  if (!repoPath) return;
  state.repoPath = repoPath;

  // Show repo view with loading overlay
  welcomeScreen.style.display = 'none';
  repoView.style.display = 'flex';

  const overlay = showLoading('Loading commits…');

  const result = await window.gitApp.log(repoPath);

  overlay.remove();

  if (!result.success) {
    alert(`Failed to load repo: ${result.error}`);
    return;
  }

  state.branches = result.branches;
  state.branchShas = result.branchShas || {};
  state.currentBranch = result.currentBranch;
  state.remoteUrl = result.remoteUrl || null;
  state.status = result.status || {};
  state.tracking = result.tracking || {};
  state.head = result.head || null;
  state.realCommits = result.commits;
  state.statusSig = statusSignature(state.status);

  // Prepend a synthetic "WIP" commit for uncommitted changes, linked to HEAD.
  const changed = state.status.changed || 0;
  state.commits = (changed > 0 && state.head)
    ? [buildWipCommit(changed), ...result.commits]
    : result.commits;

  // Update toolbar
  const repoName = repoPath.split(/[\\/]/).pop();
  $('repo-name-display').textContent = repoName;
  updateRepoLinks();
  $('branches-panel').classList.add('has-repo');
  renderBranches();
  renderStatusChips(state.status);
  addRecentRepo(repoPath);
  renderRecentRepos();

  // Compute graph layout
  const graphData = computeGraphLayout(state.commits);
  state.graphData = graphData;
  renderCommitRows(graphData);
  paintGraph(graphData);
}

// A synthetic "WIP" commit representing uncommitted changes, linked to HEAD.
function buildWipCommit(changed) {
  return {
    sha: '__WIP__',
    parents: state.head ? [state.head] : [],
    authorName: '',
    authorEmail: '',
    timestamp: Math.floor(Date.now() / 1000),
    subject: `Uncommitted changes · ${changed} file${changed === 1 ? '' : 's'}`,
    refs: [],
    shortSha: '',
    isWip: true,
  };
}

function statusSignature(c) {
  return `${c.changed || 0}:${c.staged || 0}:${c.modified || 0}:${c.untracked || 0}`;
}

// Re-check the working directory and, if it changed, update the WIP node,
// status chips, and (if open) the WIP detail — without a full graph reload.
// Cheap enough to poll; skips re-render when nothing changed.
async function refreshWorkingState() {
  if (!state.repoPath || !state.realCommits) return;
  const res = await window.gitApp.status(state.repoPath);
  if (!res.success) return;

  const sig = statusSignature(res.counts);
  if (sig === state.statusSig) return; // nothing changed → no work
  state.statusSig = sig;
  state.status = res.counts;
  renderStatusChips(res.counts);

  const changed = res.counts.changed || 0;
  state.commits = (changed > 0 && state.head)
    ? [buildWipCommit(changed), ...state.realCommits]
    : state.realCommits;

  const scrollTop = graphScroll.scrollTop;
  const graphData = computeGraphLayout(state.commits);
  state.graphData = graphData;
  renderCommitRows(graphData);
  paintGraph(graphData);
  graphScroll.scrollTop = scrollTop;

  if (state.selectedSha === '__WIP__') renderWipDetail();
}

// Re-read branch tips + ahead/behind (optionally after a background fetch).
// If any branch tip moved, reload the repo so the graph matches; otherwise just
// repaint the sidebar when the counts changed.
let refsBusy = false;
async function refreshRefs(fetch) {
  if (!state.repoPath || !state.realCommits || refsBusy) return;
  refsBusy = true;
  const repo = state.repoPath;
  try {
    const res = await window.gitApp.refs(repo, fetch);
    if (!res.success || repo !== state.repoPath) return;

    const shasChanged = JSON.stringify(res.branchShas) !== JSON.stringify(state.branchShas || {});
    if (shasChanged) { await loadRepo(repo); return; }

    if (JSON.stringify(res.tracking) !== JSON.stringify(state.tracking || {})) {
      state.tracking = res.tracking;
      renderBranches();
    }
  } finally {
    refsBusy = false;
  }
}

function showLoading(text) {
  const el = document.createElement('div');
  el.className = 'loading-overlay';
  el.innerHTML = `<div class="spinner"></div><div class="loading-text">${text}</div>`;
  repoView.style.position = 'relative';
  repoView.appendChild(el);
  return el;
}

// Transient bottom-right notification; auto-dismisses.
function showToast(message) {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, 2500);
}

// ─── Branches Sidebar ─────────────────────────────────────────────────────────
function renderBranches() {
  const locals  = state.branches.filter(b => !b.startsWith('remotes/'));
  const remotes = state.branches.filter(b => b.startsWith('remotes/'));

  // Each tree item: `path` is split on "/" to form the hierarchy; `value` is
  // the full identifier kept on the leaf for checkout (data-branch).
  const localItems  = locals.map(b => ({
    path: b, value: b, current: b === state.currentBranch,
  }));
  const remoteItems = remotes.map(b => ({
    path: b.replace('remotes/', ''), value: b, current: false,
  }));

  render('local-branches-list', locals.length
    ? renderBranchTree(buildBranchTree(localItems), { remote: false })
    : html`<div class="empty-sidebar">No local branches</div>`);

  render('remote-branches-list', remotes.length
    ? renderBranchTree(buildBranchTree(remoteItems), { remote: true })
    : html`<div class="empty-sidebar">No remote branches</div>`);
}

// Build a nested tree from branch items, splitting each `path` on "/".
// A node is either a folder (has children) or a leaf (has `.leaf`), never both
// — git forbids a branch and a branch-folder sharing a name.
function buildBranchTree(items) {
  const root = { children: {} };
  for (const item of items) {
    const parts = item.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      if (!node.children[part]) node.children[part] = { label: part, children: {} };
      node = node.children[part];
      if (i === parts.length - 1) node.leaf = item;
    });
  }
  return root;
}

// Render a tree node's children as an array of html templates (folders first,
// then leaves, each alphabetical). Folders use <details> for native collapse.
// Original SVG glyphs (git-branch, folder, checked-out check) in the style of
// desktop git clients. `currentColor` lets branch/folder icons inherit the row
// text colour; the current-branch check uses the theme green.
const ICON_BRANCH = `<svg class="tree-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
  <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3"/>
  <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3"/>
  <circle cx="11.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3"/>
  <path d="M4.5 5.1v5.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  <path d="M11.5 5.1V6a3 3 0 0 1-3 3H4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;
const ICON_FOLDER = `<svg class="tree-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
  <path d="M1.5 4a1 1 0 0 1 1-1h3.1l1.3 1.6h6.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`;
const ICON_FILE = `<svg class="tree-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
  <path d="M3 2h6.2L13 5.8V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M9 2v4h4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`;
const ICON_CHECK = `<svg class="tree-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
  <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" style="fill:var(--green)"/>
  <path d="M4.6 8.2l2.1 2.2 4.7-4.9" fill="none" style="stroke:var(--bg-deep)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function renderBranchTree(node, opts, depth = 0) {
  const entries = Object.values(node.children).sort((a, b) => {
    const aLeaf = !!a.leaf, bLeaf = !!b.leaf;
    if (aLeaf !== bLeaf) return aLeaf ? 1 : -1;
    return a.label.localeCompare(b.label);
  });

  return entries.map(child => {
    if (child.leaf) {
      const it = child.leaf;
      const cls = `branch-item${opts.remote ? ' branch-remote' : ''}${it.current ? ' current' : ''}`;
      const title = opts.remote ? raw(' title="Double-click to check out locally"') : '';
      const track = opts.remote ? null : (state.tracking || {})[it.value];
      const ab = track && (track.ahead || track.behind) ? html`
        <span class="branch-ab">
          ${track.ahead ? html`<span class="ab ab-ahead">${track.ahead}↑</span>` : ''}
          ${track.behind ? html`<span class="ab ab-behind">${track.behind}↓</span>` : ''}
        </span>` : '';
      return html`
        <div class="${cls}" data-branch="${it.value}"${title}>
          ${raw(it.current ? ICON_CHECK : ICON_BRANCH)}
          <span class="branch-name">${child.label}</span>
          ${ab}
        </div>`;
    }
    // Local folders open by default; remote folders stay folded except the
    // top-level remote (e.g. "origin"), so the Remote list opens onto origin.
    const isOpen = !opts.remote || depth === 0;
    return html`
      <details class="branch-folder" ${isOpen ? raw('open') : ''}>
        <summary class="branch-folder-label">${raw(ICON_FOLDER)}${child.label}</summary>
        <div class="branch-tree-children">${renderBranchTree(child, opts, depth + 1)}</div>
      </details>`;
  });
}

// Double-clicking a remote branch checks it out as a local tracking branch.
function scrollToBranch(branch) {
  if (!branch || !state.commits) return;
  console.log('[scrollToBranch] branch=', branch, 'branchShas keys=', Object.keys(state.branchShas || {}).slice(0, 10));
  const sha = state.branchShas && state.branchShas[branch];
  console.log('[scrollToBranch] sha=', sha);
  if (!sha) return;
  selectCommit(sha, null);
  const rowEl = document.querySelector(`.commit-row[data-sha="${sha}"]`);
  console.log('[scrollToBranch] rowEl=', rowEl);
  if (rowEl) rowEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function checkoutRemoteBranch(remoteBranch) {
  if (!remoteBranch || !state.repoPath) return;
  const label = remoteBranch.replace('remotes/', '');
  const overlay = showLoading(`Checking out ${label}…`);
  const result = await window.gitApp.checkoutRemote(state.repoPath, remoteBranch);
  overlay.remove();
  if (!result.success) {
    alert(`Checkout failed: ${result.error}`);
    return;
  }
  await loadRepo(state.repoPath); // refresh branches, current branch, and graph
  showToast(`Checked out ${result.branch}`);
}

// Double-clicking a local branch switches to it.
async function checkoutLocalBranch(branch) {
  if (!branch || !state.repoPath) return;
  if (branch === state.currentBranch) return; // already on it
  const overlay = showLoading(`Switching to ${branch}…`);
  const result = await window.gitApp.checkout(state.repoPath, branch);
  overlay.remove();
  if (!result.success) {
    alert(`Checkout failed: ${result.error}`);
    return;
  }
  await loadRepo(state.repoPath); // refresh branches, current branch, and graph
  showToast(`Switched to ${branch}`);
}

let _ctxBranch = null;

function showBranchCtxMenu(x, y, branch, { isCurrent, isRemote }) {
  _ctxBranch = branch;
  const menu = $('branch-ctx-menu');

  $('ctx-copy-branch').onclick = () => { const b = _ctxBranch; hideBranchCtxMenu(); doCopyBranchName(b); };

  const pull = $('ctx-pull-branch');
  pull.style.display = isRemote ? 'none' : 'block';
  if (!isRemote) pull.onclick = () => { const b = _ctxBranch; hideBranchCtxMenu(); doPullBranch(b); };

  const checkout = $('ctx-checkout-remote');
  checkout.style.display = isRemote ? 'block' : 'none';
  if (isRemote) checkout.onclick = () => { const b = _ctxBranch; hideBranchCtxMenu(); checkoutRemoteBranch(b); };

  const ren = $('ctx-rename-branch');
  ren.style.display = isRemote ? 'none' : 'block';
  if (!isRemote) {
    ren.disabled = isCurrent;
    ren.title = isCurrent ? 'Cannot rename the currently checked-out branch' : '';
    ren.onclick = () => { const b = _ctxBranch; hideBranchCtxMenu(); doRenameBranch(b); };
  }

  const sep = $('ctx-sep-delete');
  sep.style.display = isRemote ? 'none' : 'block';

  const del = $('ctx-delete-branch');
  del.style.display = isRemote ? 'none' : 'block';
  if (!isRemote) {
    del.disabled = isCurrent;
    del.title = isCurrent ? 'Cannot delete the currently checked-out branch' : '';
    del.onclick = () => { const b = _ctxBranch; hideBranchCtxMenu(); doDeleteBranch(b); };
  }

  menu.style.display = 'block';
  // Clamp to viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 180, mh = isRemote ? 72 : 140;
  menu.style.left = (x + mw > vw ? vw - mw - 4 : x) + 'px';
  menu.style.top  = (y + mh > vh ? vh - mh - 4 : y) + 'px';
}

function hideBranchCtxMenu() {
  $('branch-ctx-menu').style.display = 'none';
  _ctxBranch = null;
}

function doCopyBranchName(branch) {
  if (!branch) return;
  navigator.clipboard.writeText(branch).then(() => showToast(`Copied: ${branch}`));
}

async function doRenameBranch(branch) {
  if (!branch || !state.repoPath) return;
  const newName = prompt(`Rename "${branch}" to:`, branch);
  if (!newName || newName === branch) return;
  const result = await window.gitApp.renameBranch(state.repoPath, branch, newName);
  if (!result.success) {
    alert(`Rename failed: ${result.error}`);
    return;
  }
  showToast(`Renamed to ${newName}`);
  await loadRepo(state.repoPath);
}

async function doDeleteBranch(branch) {
  if (!branch || !state.repoPath) return;
  if (!confirm(`Delete branch "${branch}"?\n\nThis cannot be undone.`)) return;
  const result = await window.gitApp.deleteBranch(state.repoPath, branch);
  if (!result.success) {
    alert(`Delete failed: ${result.error}`);
    return;
  }
  showToast(`Deleted branch ${branch}`);
  await loadRepo(state.repoPath);
}

function renderStatusChips(status) {
  const mod = $('chip-modified');
  const stg = $('chip-staged');
  const unt = $('chip-untracked');
  if (status.modified > 0) { mod.textContent = `${status.modified} modified`; mod.style.display = 'inline'; } else mod.style.display = 'none';
  if (status.staged > 0)   { stg.textContent = `${status.staged} staged`;   stg.style.display = 'inline'; } else stg.style.display = 'none';
  if (status.untracked > 0) { unt.textContent = `${status.untracked} untracked`; unt.style.display = 'inline'; } else unt.style.display = 'none';
}

// ─── Graph Layout Engine ──────────────────────────────────────────────────────
function computeGraphLayout(commits) {
  // Each commit gets assigned a lane (column).
  // We track which lanes are "open" (i.e., expecting a child commit to close them).
  const shaToIndex = new Map();
  commits.forEach((c, i) => shaToIndex.set(c.sha, i));

  const lanes = [];      // lanes[i] = sha of the commit that currently owns this lane, or null
  const rows  = [];

  function findLane(sha) {
    return lanes.indexOf(sha);
  }
  function freeLane(sha) {
    const i = lanes.indexOf(sha);
    if (i !== -1) lanes[i] = null;
  }
  function allocLane(sha) {
    // prefer an existing null slot
    const empty = lanes.indexOf(null);
    if (empty !== -1) { lanes[empty] = sha; return empty; }
    lanes.push(sha);
    return lanes.length - 1;
  }

  // Open lanes for each commit (sha → lane index)
  const openLanes = new Map();

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    let lane;

    // If this commit was already allocated a lane by a child, use it
    if (openLanes.has(commit.sha)) {
      lane = openLanes.get(commit.sha);
      openLanes.delete(commit.sha);
    } else {
      lane = allocLane(commit.sha);
    }

    // Connections: lines from this commit to each parent
    const connections = [];

    commit.parents.forEach((parentSha, pi) => {
      const parentIdx = shaToIndex.get(parentSha);
      if (parentIdx === undefined) return; // parent not in visible range

      let parentLane;
      if (openLanes.has(parentSha)) {
        parentLane = openLanes.get(parentSha);
      } else {
        // Allocate a lane for this parent
        if (pi === 0) {
          // First parent: reuse this commit's lane
          parentLane = lane;
          lanes[lane] = parentSha;
        } else {
          parentLane = allocLane(parentSha);
        }
        openLanes.set(parentSha, parentLane);
      }
      connections.push({ fromLane: lane, toLane: parentLane, parentSha, first: pi === 0 });
    });

    // If no parents (root commit), free the lane
    if (commit.parents.length === 0) {
      freeLane(commit.sha);
    }

    const maxLane = Math.max(lane, ...connections.map(c => Math.max(c.fromLane, c.toLane)), 0);
    rows.push({ commit, lane, connections, maxLane });
  }

  return rows;
}

// ─── Render Commit Rows (DOM) ─────────────────────────────────────────────────
function renderCommitRows(graphData) {
  const totalRows = graphData.length;
  commitRows.style.height = `${totalRows * ROW_H}px`;

  // Compute max lane for canvas width
  const maxLane = graphData.reduce((m, r) => Math.max(m, r.maxLane), 0);
  const canvasW = LANE_PAD + (maxLane + 1) * COL_W + COL_W;
  graphCanvas.width  = Math.min(canvasW, GRAPH_W);
  graphCanvas.height = totalRows * ROW_H;
  graphCanvas.style.width  = graphCanvas.width + 'px';
  graphCanvas.style.height = graphCanvas.height + 'px';

  const remoteNames = getRemoteNames();
  render(commitRows, graphData.map((row, i) => {
    const { commit } = row;
    const selected = (commit.sha === state.selectedSha || (state.multiSel || []).includes(commit.sha)) ? 'selected' : '';
    const branchRefs = filterSyncedRemotes(
      commit.refs.filter(r => !r.startsWith('tag: ')),
      remoteNames
    );
    const tagRefs    = commit.refs.filter(r =>  r.startsWith('tag: '));
    // Tint the graph cell to the right of this commit's graph line only.
    const lineX = LANE_PAD + row.lane * COL_W + COL_W / 2;
    const tint = raw(` style="--lane-tint: color-mix(in srgb, ${laneColor(row.lane)} 12%, transparent); --line-x: ${lineX}px"`);
    if (commit.isWip) {
      return html`
        <div class="commit-row wip ${selected}" data-sha="${commit.sha}" data-idx="${i}"${tint}>
          <div class="commit-branch"></div>
          <div class="commit-graph-cell"></div>
          <div class="commit-msg"><span class="msg-text">${commit.subject}</span></div>
          <div class="commit-author"></div>
          <div class="commit-date"></div>
          <div class="commit-sha"></div>
          <div class="commit-tags"></div>
        </div>
      `;
    }
    return html`
      <div class="commit-row ${selected}" data-sha="${commit.sha}" data-idx="${i}"${tint}>
        <div class="commit-branch">${raw(buildRefBadges(branchRefs, laneColor(row.lane), remoteNames))}</div>
        <div class="commit-graph-cell"></div>
        <div class="commit-msg">
          <span class="msg-text">${commit.subject}</span>
        </div>
        <div class="commit-author">${commit.authorName}</div>
        <div class="commit-date">${relativeDate(commit.timestamp)}</div>
        <div class="commit-sha">${commit.shortSha}</div>
        <div class="commit-tags">${raw(buildRefBadges(tagRefs))}</div>
      </div>
    `;
  }));
}

// The set of remote names in the repo (e.g. "origin"), derived from the
// "remotes/<name>/..." entries in the branch list.
function getRemoteNames() {
  const names = new Set();
  state.branches.forEach(b => {
    if (b.startsWith('remotes/')) {
      const remote = b.slice('remotes/'.length).split('/')[0];
      if (remote) names.add(remote);
    }
  });
  return names;
}

// Drop a remote ref (e.g. "origin/staging") when a local branch of the same
// name decorates the SAME commit — i.e. they're in sync, so show only the
// local. Refs on a commit share its SHA, so co-location means in-sync.
function filterSyncedRemotes(refs, remoteNames) {
  const localNames = new Set();
  refs.forEach(ref => {
    if (ref === 'HEAD') return;
    if (ref.startsWith('HEAD -> ')) { localNames.add(ref.slice(8)); return; }
    if (!remoteNames.has(ref.split('/')[0])) localNames.add(ref); // local branch
  });

  return refs.filter(ref => {
    if (ref === 'HEAD' || ref.startsWith('HEAD -> ')) return true;
    const remote = ref.split('/')[0];
    if (remoteNames.has(remote)) {
      const branchName = ref.slice(remote.length + 1); // strip "origin/"
      if (localNames.has(branchName)) return false; // in sync → hide remote
    }
    return true;
  });
}

// When `color` is given (a commit's graph lane colour), branch-type badges are
// tinted to match the graph; tag badges keep their own colour. Remote badges
// have their "<remote>/" prefix stripped for display, and the symbolic
// "<remote>/HEAD" ref is omitted entirely.
function buildRefBadges(refs, color, remoteNames) {
  const style = color
    ? ` style="color:${color};border-color:${color};background:color-mix(in srgb, ${color} 16%, transparent)"`
    : '';
  const remotes = remoteNames || new Set();
  return refs.map(ref => {
    let cls, label;
    if (ref === 'HEAD') { cls = 'ref-head'; label = 'HEAD'; }
    else if (ref.startsWith('HEAD -> ')) { cls = 'ref-head'; label = ref.slice(8); }
    else if (ref.startsWith('tag: ')) { cls = 'ref-tag'; label = ref.slice(5); }
    else {
      const remote = ref.split('/')[0];
      if (remotes.has(remote)) {
        label = ref.slice(remote.length + 1); // strip "origin/"
        if (label === 'HEAD' || label === '') return ''; // skip "origin/HEAD"
        cls = 'ref-remote';
      } else {
        cls = 'ref-branch'; label = ref;
      }
    }
    const st = cls === 'ref-tag' ? '' : style; // tags keep their own colour
    const safe = escHtml(label);
    // title shows the full name on hover (badge text may be ellipsised in CSS)
    return `<span class="ref-badge ${cls}"${st} title="${safe}">${safe}</span>`;
  }).join('');
}

// ─── Canvas Graph Painter ─────────────────────────────────────────────────────
function paintGraph(graphData) {
  if (!graphData) return;
  const canvas = graphCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Resize for DPR
  const cssW = canvas.width;
  const cssH = canvas.height;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, cssW, cssH);

  // Only paint visible rows for performance
  const scrollTop = graphScroll.scrollTop;
  const scrollH   = graphScroll.clientHeight;
  const firstRow  = Math.max(0, Math.floor(scrollTop / ROW_H) - 2);
  const lastRow   = Math.min(graphData.length - 1, Math.ceil((scrollTop + scrollH) / ROW_H) + 2);

  const laneX = lane => LANE_PAD + lane * COL_W + COL_W / 2;
  const rowY  = idx  => idx * ROW_H + ROW_H / 2;
  const color = lane => LANE_COLORS[lane % LANE_COLORS.length];

  // Map sha → row index for O(1) parent lookups
  const shaToIndex = new Map();
  for (let i = 0; i < graphData.length; i++) shaToIndex.set(graphData[i].commit.sha, i);

  // Draw edges — orthogonal (right-angle) routing with rounded corners.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = firstRow; i <= lastRow; i++) {
    const row = graphData[i];
    row.connections.forEach(({ fromLane, toLane, parentSha, first }) => {
      const parentRow = shaToIndex.has(parentSha) ? shaToIndex.get(parentSha) : -1;
      if (parentRow < 0) return;

      const x1 = laneX(fromLane);
      const y1 = rowY(i);
      const x2 = laneX(toLane);
      const y2 = rowY(parentRow);

      ctx.beginPath();
      // Colour the line after the lane it mostly runs in.
      ctx.strokeStyle = color(first ? fromLane : toLane);
      ctx.lineWidth = 2;
      ctx.moveTo(x1, y1);

      if (x1 === x2) {
        ctx.lineTo(x2, y2);
      } else {
        const r = Math.min(7, Math.abs(x2 - x1), Math.abs(y2 - y1) / 2);
        if (first) {
          // Branch base / convergence: descend in the child's lane, then turn
          // into the parent's lane at the bottom (near the parent).
          ctx.arcTo(x1, y2, x2, y2, r);
        } else {
          // Merge: turn out of the child's lane at the top, then descend in the
          // parent's lane down to the parent.
          ctx.arcTo(x2, y1, x2, y2, r);
        }
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    });
  }

  // Draw commit nodes as author-initial avatars
  ctx.font = NODE_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = firstRow; i <= lastRow; i++) {
    const row = graphData[i];
    const x = laneX(row.lane);
    const y = rowY(i);
    const c = color(row.lane);

    // WIP (uncommitted changes) node: hollow dashed ring, no initials
    if (row.commit.isWip) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#2d2e28';
      ctx.fill();
      ctx.setLineDash([2.5, 2.5]);
      ctx.strokeStyle = '#a6e22e';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
      if (row.commit.sha === state.selectedSha) {
        ctx.beginPath();
        ctx.arc(x, y, NODE_R + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#f8f8f2';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      continue;
    }

    // Filled avatar circle
    ctx.beginPath();
    ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();

    // Merge commits: subtle dark inner ring
    if (row.commit.parents.length > 1) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(30,31,28,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Selection ring
    if (row.commit.sha === state.selectedSha) {
      ctx.beginPath();
      ctx.arc(x, y, NODE_R + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#f8f8f2';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Author initials
    ctx.fillStyle = textOn(c);
    ctx.fillText(authorInitials(row.commit.authorName), x, y + 0.5);
  }
}

// ─── Multi-select & squash ────────────────────────────────────────────────────
function applySelectionClasses() {
  const multi = state.multiSel || [];
  document.querySelectorAll('.commit-row').forEach(el => {
    el.classList.toggle('selected', el.dataset.sha === state.selectedSha || multi.includes(el.dataset.sha));
  });
}

function toggleMultiSelect(sha) {
  if (sha === '__WIP__') return;
  let multi = state.multiSel || [];
  if (!multi.length && state.selectedSha && state.selectedSha !== '__WIP__') multi = [state.selectedSha];
  multi = multi.includes(sha) ? multi.filter(s => s !== sha) : [...multi, sha];
  state.multiSel = multi;
  state.selectedSha = sha; // anchor for shift-range
  applySelectionClasses();
}

function rangeMultiSelect(sha) {
  if (sha === '__WIP__') return;
  const order = state.commits.map(c => c.sha);
  const a = order.indexOf(state.selectedSha);
  const b = order.indexOf(sha);
  if (a < 0 || b < 0) return selectCommit(sha, b);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  state.multiSel = order.slice(lo, hi + 1).filter(s => s !== '__WIP__');
  applySelectionClasses(); // keep the anchor so further shift-clicks re-range
}

function showCommitCtxMenu(x, y) {
  const n = (state.multiSel || []).length || 1;
  const btn = $('ctx-squash-commits');
  btn.textContent = n > 1 ? `Squash ${n} commits` : 'Squash commits';
  btn.disabled = n < 2;
  btn.title = n < 2 ? 'Ctrl-click or Shift-click to select two or more commits first' : '';
  btn.onclick = () => { hideCommitCtxMenu(); showSquashModal(); };
  const menu = $('commit-ctx-menu');
  menu.style.display = 'block';
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = (x + 180 > vw ? vw - 184 : x) + 'px';
  menu.style.top  = (y + 40 > vh ? vh - 44 : y) + 'px';
}
function hideCommitCtxMenu() {
  const m = $('commit-ctx-menu');
  if (m) m.style.display = 'none';
}

let _squashShas = [];
async function showSquashModal() {
  const shas = [...(state.multiSel || [])];
  if (shas.length < 2) return;
  _squashShas = shas;
  // Oldest first (commits list is newest-first).
  const order = state.commits.map(c => c.sha);
  const sorted = shas.sort((a, b) => order.indexOf(b) - order.indexOf(a));
  $('squash-title').textContent = `Squash ${shas.length} commits`;
  const ta = $('squash-message');
  ta.value = 'Loading messages…';
  $('squash-modal').style.display = 'flex';
  const msgs = [];
  for (const sha of sorted) {
    const r = await window.gitApp.commitMessage(state.repoPath, sha);
    if (r.success) msgs.push(r.message);
  }
  ta.value = msgs.join('\n\n');
  ta.focus();
  ta.setSelectionRange(0, 0);
}
function hideSquashModal() {
  const m = $('squash-modal');
  if (m) m.style.display = 'none';
}

async function doSquash() {
  const message = $('squash-message').value.trim();
  if (!message) return alert('Please enter a commit message.');
  const btn = $('squash-confirm');
  btn.disabled = true;
  const res = await window.gitApp.squash(state.repoPath, _squashShas, message);
  btn.disabled = false;
  if (!res.success) return alert(`Squash failed: ${res.error}`);
  hideSquashModal();
  state.multiSel = [];
  state.selectedSha = null;
  showToast(`Squashed ${_squashShas.length} commits`);
  await loadRepo(state.repoPath);
}

// ─── Select Commit ────────────────────────────────────────────────────────────
async function selectCommit(sha, idx) {
  state.selectedSha = sha;
  closeFileDiff();

  // Update row highlight
  applySelectionClasses();

  // Repaint to show selection dot
  paintGraph(state.graphData);

  // Show detail panel
  const commit = state.commits.find(c => c.sha === sha);
  if (!commit) return;

  detailPlaceholder.style.display = 'none';
  detailContent.style.display = 'block';

  if (commit.isWip) {
    await renderWipDetail();
    return;
  }

  const initials = commit.authorName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  $('detail-avatar').textContent = initials;
  $('detail-subject').textContent = commit.subject;
  $('detail-body').textContent = '';
  // Load the full message; show only the part after the subject line.
  window.gitApp.commitMessage(state.repoPath, sha).then(r => {
    if (!r.success || state.selectedSha !== sha) return;
    const body = r.message.split('\n').slice(1).join('\n').replace(/^\s*\n/, '').trim();
    $('detail-body').textContent = body;
  });
  $('detail-author').textContent = commit.authorName + ' <' + commit.authorEmail + '>';
  $('detail-date').textContent = new Date(commit.timestamp * 1000).toLocaleString();
  $('detail-sha').textContent = commit.sha;
  $('detail-refs').innerHTML = buildRefBadges(commit.refs);
  // Only the current tip (HEAD) can be safely reworded (via amend, no rebase).
  render('detail-actions', commit.sha === state.head
    ? html`<button class="wd-bulk" data-act="edit-msg">Edit message</button>`
    : '');
  $('detail-diff').innerHTML = '<div style="color:var(--text-muted);font-family:var(--font);font-size:11px;">Loading diff…</div>';

  // Fetch diff
  const diff = await window.gitApp.commitDiff(state.repoPath, sha);
  if (diff.success && state.selectedSha === sha) {
    state.commitFiles = diff.files || [];
    renderDiff(diff.stat, state.commitFiles);
  }
}

// ─── Side-by-side file diff (commit view) ─────────────────────────────────────
const SBS_ROW_H = 18;          // keep in sync with .sr height in app.css
const SBS_MAX_FULL_ROWS = 8000; // above this, fall back to "changes only"
state.diffMode = 'full';

function openCommitFileDiff(idx) {
  const f = (state.commitFiles || [])[idx];
  if (!f || !state.selectedSha) return;
  state.fileDiff = { sha: state.selectedSha, file: f.path, oldFile: f.oldPath, idx };
  showFileDiff();
}

function closeFileDiff() {
  state.fileDiff = null;
  const v = $('diff-view');
  if (v) v.style.display = 'none';
  document.querySelectorAll('.diff-stat-line.active, .wd-file.active').forEach(el => el.classList.remove('active'));
}

// Parse a unified diff into aligned left/right rows for side-by-side display.
function parseSideBySide(text) {
  const rows = [];
  let adds = 0, dels = 0, binary = false;
  let oldNo = 0, newNo = 0, inHunk = false;
  let delBuf = [], addBuf = [];

  const flush = () => {
    const n = Math.max(delBuf.length, addBuf.length);
    for (let i = 0; i < n; i++) {
      const l = delBuf[i], r = addBuf[i];
      const row = { t: 'chg', l: l || null, r: r || null, first: i === 0 };
      if (l && r) markIntraLine(row);
      rows.push(row);
    }
    delBuf = []; addBuf = [];
  };

  for (const line of text.split('\n')) {
    if (!inHunk && /^Binary files /.test(line)) { binary = true; continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      flush();
      oldNo = +h[1]; newNo = +h[2];
      // A hunk starting at line 1 needs no separator row.
      if (inHunk || oldNo > 1 || newNo > 1) rows.push({ t: 'hunk', text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const c = line[0];
    if (c === '-') { delBuf.push({ n: oldNo++, s: line.slice(1) }); dels++; }
    else if (c === '+') { addBuf.push({ n: newNo++, s: line.slice(1) }); adds++; }
    else if (c === ' ') {
      flush();
      rows.push({ t: 'ctx', l: { n: oldNo++, s: line.slice(1) }, r: { n: newNo++, s: line.slice(1) } });
    }
    // '\ No newline at end of file' and blank trailer lines are ignored.
  }
  flush();
  return { rows, adds, dels, binary };
}

// Highlight the differing middle of a paired removed/added line.
function markIntraLine(row) {
  const a = row.l.s, b = row.r.s;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const longest = Math.max(a.length, b.length) || 1;
  if ((p + s) / longest < 0.3) return; // mostly different: whole-line colour is enough
  row.l.hl = [p, a.length - s];
  row.r.hl = [p, b.length - s];
}

function sbsText(side) {
  if (!side.hl || side.hl[0] >= side.hl[1]) return escHtml(side.s);
  const [a, b] = side.hl;
  return escHtml(side.s.slice(0, a)) + '<mark>' + escHtml(side.s.slice(a, b)) + '</mark>' + escHtml(side.s.slice(b));
}

function renderSideBySide(model) {
  const left = [], right = [];
  const cell = (cls, n, body) =>
    `<div class="sr ${cls}"><span class="sn">${n == null ? '' : n}</span><span class="st">${body}</span></div>`;
  const changes = [];
  model.rows.forEach((row, i) => {
    if (row.t === 'hunk') {
      const t = escHtml(row.text);
      left.push(cell('sr-hunk', '', t));
      right.push(cell('sr-hunk', '', t));
    } else if (row.t === 'ctx') {
      left.push(cell('', row.l.n, escHtml(row.l.s)));
      right.push(cell('', row.r.n, escHtml(row.r.s)));
    } else {
      if (row.first) changes.push(i);
      left.push(row.l ? cell('sr-del', row.l.n, sbsText(row.l)) : cell('sr-empty', '', ''));
      right.push(row.r ? cell('sr-add', row.r.n, sbsText(row.r)) : cell('sr-empty', '', ''));
    }
  });
  state.dvChanges = changes;
  state.dvPos = -1;
  return `<div class="sbs-pane"><div class="sbs-lines">${left.join('')}</div></div>` +
         `<div class="sbs-pane"><div class="sbs-lines">${right.join('')}</div></div>`;
}

function stepDiffChange(dir) {
  const list = state.dvChanges || [];
  if (!list.length) return;
  let pos = (state.dvPos == null ? -1 : state.dvPos) + dir;
  pos = Math.max(0, Math.min(list.length - 1, pos));
  state.dvPos = pos;
  const pane = document.querySelector('#dv-body .sbs-pane');
  if (pane) pane.scrollTop = Math.max(0, list[pos] * SBS_ROW_H - 60);
}

async function showFileDiff() {
  const v = state.fileDiff;
  if (!v) return;
  const view = $('diff-view');
  view.style.display = 'flex';
  $('dv-title').textContent = v.oldFile && v.oldFile !== v.file ? `${v.oldFile}  →  ${v.file}` : v.file;
  $('dv-stats').innerHTML = '';
  $('dv-mode').textContent = state.diffMode === 'full' ? 'Changes only' : 'Full file';
  $('dv-discard').style.display = v.wip ? '' : 'none';
  $('dv-body').innerHTML = '<div class="dv-msg">Loading diff…</div>';
  document.querySelectorAll('.diff-stat-line').forEach(el => {
    el.classList.toggle('active', !v.wip && el.dataset.idx === String(v.idx));
  });
  document.querySelectorAll('.wd-file').forEach(el => {
    el.classList.toggle('active', !!v.wip && el.dataset.path === v.file &&
      el.dataset.staged === String(v.staged));
  });

  // Commit files and working-directory files load through different handlers.
  const fetchDiff = ctx => v.wip
    ? window.gitApp.fileDiff(state.repoPath, v.file, v.staged, v.untracked, ctx)
    : window.gitApp.commitFileDiff(state.repoPath, v.sha, v.file, v.oldFile, ctx);

  let mode = state.diffMode;
  let res = await fetchDiff(mode);
  if (state.fileDiff !== v) return; // user moved on
  if (!res.success) {
    $('dv-body').innerHTML = `<div class="dv-msg">Could not load diff: ${escHtml(res.error)}</div>`;
    return;
  }
  let model = parseSideBySide(res.diff);
  let note = '';
  if (mode === 'full' && model.rows.length > SBS_MAX_FULL_ROWS) {
    res = await fetchDiff('hunks');
    if (state.fileDiff !== v) return;
    if (res.success) { model = parseSideBySide(res.diff); note = ' (large file: changes only)'; }
  }
  $('dv-stats').innerHTML = `<span class="add">+${model.adds}</span><span class="del">−${model.dels}</span>${escHtml(note)}`;
  if (model.binary) {
    $('dv-body').innerHTML = '<div class="dv-msg">Binary file — no textual diff to show.</div>';
    return;
  }
  if (!model.rows.length) {
    $('dv-body').innerHTML = '<div class="dv-msg">No textual changes in this file.</div>';
    return;
  }
  $('dv-body').innerHTML = renderSideBySide(model);
  // Keep the vertical scroll of the two panes in lockstep.
  const panes = $('dv-body').querySelectorAll('.sbs-pane');
  panes.forEach((pane, i) => pane.addEventListener('scroll', () => {
    const other = panes[1 - i];
    if (other.scrollTop !== pane.scrollTop) other.scrollTop = pane.scrollTop;
  }));
  stepDiffChange(1); // jump to the first change
}

// ─── Working Directory (WIP) — staging & commit ───────────────────────────────
function statusLabel(ch, untracked) {
  if (untracked) return { ch: 'U', cls: 'new' };
  switch (ch) {
    case 'A': return { ch: 'A', cls: 'new' };
    case 'D': return { ch: 'D', cls: 'del' };
    case 'R': return { ch: 'R', cls: 'mod' };
    default:  return { ch: (ch || 'M').trim() || 'M', cls: 'mod' };
  }
}

async function renderWipDetail() {
  $('detail-avatar').textContent = '✎';
  $('detail-subject').textContent = 'Uncommitted changes';
  $('detail-body').textContent = '';
  $('detail-date').textContent = '';
  $('detail-sha').textContent = '';
  $('detail-refs').innerHTML = '';

  const res = await window.gitApp.status(state.repoPath);
  const files = res.success ? res.files : [];
  const staged = files.filter(f => f.staged);
  const unstaged = files.filter(f => f.unstaged);
  $('detail-author').textContent = `${staged.length} staged · ${unstaged.length} unstaged`;

  const fileRow = (f, kind) => {
    const label = statusLabel(kind === 'staged' ? f.index : f.working_dir, f.untracked && kind !== 'staged');
    const act = kind === 'staged' ? 'unstage' : 'stage';
    return html`
      <div class="wd-file" data-path="${f.path}" data-staged="${kind === 'staged'}" data-untracked="${!!f.untracked}">
        <span class="wd-status wd-${label.cls}">${label.ch}</span>
        <span class="wd-path" title="${f.path}">${f.path}</span>
        <button class="wd-act" data-act="${act}" data-path="${f.path}" title="${act}">
          ${act === 'stage' ? '+' : '−'}
        </button>
      </div>`;
  };

  render('detail-diff', html`
    <div class="wd">
      <div class="wd-section">
        <div class="wd-head">
          <span>Changes (${unstaged.length})</span>
          ${unstaged.length ? html`<button class="wd-bulk" data-act="stage-all">Stage all</button>` : ''}
        </div>
        ${unstaged.length ? unstaged.map(f => fileRow(f, 'unstaged')) : html`<div class="wd-empty">No changes</div>`}
      </div>
      <div class="wd-section">
        <div class="wd-head">
          <span>Staged (${staged.length})</span>
          ${staged.length ? html`<button class="wd-bulk" data-act="unstage-all">Unstage all</button>` : ''}
        </div>
        ${staged.length ? staged.map(f => fileRow(f, 'staged')) : html`<div class="wd-empty">Nothing staged</div>`}
      </div>
      <div class="wd-commit">
        <div class="wd-commit-head">
          <span>Commit message</span>
          <button class="wd-bulk" data-act="suggest" ${staged.length ? '' : raw('disabled')} title="Generate a message from the staged changes">✨ Generate</button>
        </div>
        <textarea id="commit-msg-input" placeholder="Commit message" rows="3">${state.commitMsg || ''}</textarea>
        <div class="commit-split-btn${staged.length ? '' : ' disabled'}">
          <button class="primary-btn commit-main-btn" data-act="commit" ${staged.length ? '' : raw('disabled')}>
            Commit ${staged.length} file${staged.length === 1 ? '' : 's'}
          </button>
          <button class="primary-btn commit-toggle-btn" data-act="commit-menu" ${staged.length ? '' : raw('disabled')} aria-label="More commit options">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="commit-dropdown" id="commit-dropdown" hidden>
            <button class="commit-dropdown-item" data-act="amend">Amend previous commit</button>
          </div>
        </div>
      </div>
    </div>
  `);
}

// Re-fetch status and refresh the WIP detail + toolbar chips (no graph change).
async function refreshStatus() {
  const res = await window.gitApp.status(state.repoPath);
  if (res.success) {
    state.status = res.counts;
    renderStatusChips(res.counts);
  }
  await renderWipDetail();
}

async function handleWipAction(act, path) {
  if (!state.repoPath) return;
  if (act === 'commit') return doCommit();
  if (act === 'amend')  return doAmend();
  if (act === 'suggest') return generateCommitMessage();
  if (act === 'commit-menu') {
    const dd = $('commit-dropdown');
    if (dd) dd.hidden = !dd.hidden;
    return;
  }
  if (act === 'stage' || act === 'unstage' || act === 'stage-all' || act === 'unstage-all') closeFileDiff(); // file moves between lists
  if (act === 'stage')        await window.gitApp.stage(state.repoPath, [path]);
  else if (act === 'unstage') await window.gitApp.unstage(state.repoPath, [path]);
  else if (act === 'stage-all')   await window.gitApp.stageAll(state.repoPath);
  else if (act === 'unstage-all') await window.gitApp.unstageAll(state.repoPath);
  await refreshStatus();
}

// Fill a message box with a heuristic message. Without `sha`, generates from
// the staged diff (new commit); with `sha`, from that commit's own diff.
async function generateCommitMessage(sha, inputId = 'commit-msg-input') {
  if (!state.repoPath) return;
  const res = await window.gitApp.suggestCommit(state.repoPath, sha || undefined);
  if (!res.success || !res.message) return;
  const input = $(inputId);
  if (input) input.value = res.message;
  if (!sha) state.commitMsg = res.message; // track only for the new-commit box
}

async function doCommit() {
  const msg = (state.commitMsg || '').trim();
  if (!msg) return alert('Please enter a commit message.');
  const res = await window.gitApp.commit(state.repoPath, msg);
  if (!res.success) return alert(`Commit failed: ${res.error}`);
  state.commitMsg = '';
  state.selectedSha = null;
  // New commit → reload the whole graph, and reset the detail panel.
  await loadRepo(state.repoPath);
  detailContent.style.display = 'none';
  detailPlaceholder.style.display = 'flex';
  showToast('Committed');
}

async function doAmend() {
  const msg = (state.commitMsg || '').trim();
  const res = await window.gitApp.commitAmend(state.repoPath, msg || null);
  if (!res.success) return alert(`Amend failed: ${res.error}`);
  state.commitMsg = '';
  state.selectedSha = null;
  await loadRepo(state.repoPath);
  detailContent.style.display = 'none';
  detailPlaceholder.style.display = 'flex';
  showToast('Amended previous commit');
}

// ─── Reword (edit) the latest commit's message ────────────────────────────────
function handleRewordAction(act) {
  if (act === 'edit-msg')        return openRewordEditor();
  if (act === 'reword-cancel')   return closeRewordEditor();
  if (act === 'reword-save')     return doReword();
  if (act === 'reword-suggest')  return generateCommitMessage(state.selectedSha, 'reword-input');
}

async function openRewordEditor() {
  const res = await window.gitApp.commitMessage(state.repoPath, state.selectedSha);
  const current = res.success ? res.message : '';
  render('detail-actions', html`
    <div class="reword">
      <div class="wd-commit-head">
        <span>Edit message</span>
        <button class="wd-bulk" data-act="reword-suggest" title="Generate a message from this commit's changes">✨ Generate</button>
      </div>
      <textarea id="reword-input" rows="4">${current}</textarea>
      <div class="reword-btns">
        <button class="secondary-btn" data-act="reword-cancel">Cancel</button>
        <button class="primary-btn" data-act="reword-save">Save</button>
      </div>
    </div>
  `);
  const ta = $('reword-input');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function closeRewordEditor() {
  render('detail-actions', html`<button class="wd-bulk" data-act="edit-msg">Edit message</button>`);
}

async function doReword() {
  const ta = $('reword-input');
  const msg = ta ? ta.value.trim() : '';
  if (!msg) return alert('Commit message cannot be empty.');
  if ((state.status && state.status.staged) > 0) {
    return alert('You have staged changes.\n\nUnstage them first, or they would be folded into this commit when the message is amended.');
  }
  const res = await window.gitApp.commitAmend(state.repoPath, msg);
  if (!res.success) return alert(`Edit message failed: ${res.error}`);
  state.selectedSha = null;
  await loadRepo(state.repoPath); // HEAD sha changed → reload graph
  detailContent.style.display = 'none';
  detailPlaceholder.style.display = 'flex';
  showToast('Commit message updated');
}

// Discard all changes to the currently-viewed file (destructive → confirm).
async function discardViewedFile() {
  const v = state.fileDiff;
  if (!v || !v.wip) return;
  const ok = confirm(`Discard all changes to ${v.file}?\n\nThis cannot be undone.`);
  if (!ok) return;
  const res = await window.gitApp.discard(state.repoPath, v.file, v.untracked);
  if (!res.success) return alert(`Discard failed: ${res.error}`);
  closeFileDiff();
  showToast('Discarded changes');
  await refreshWorkingState(); // change count dropped → update graph WIP node too
}

function renderDiff(stat, fileInfo = []) {
  const lines = stat.trim().split('\n');
  const el = $('detail-diff');

  // Collect file entries and summary line
  const files = [];
  let summary = '';
  lines.forEach(line => {
    if (line.match(/^\s*\d+ file/)) {
      summary = line.trim();
    } else if (line.includes('|')) {
      const pipeIdx = line.lastIndexOf('|');
      const filePart = line.slice(0, pipeIdx).trim();
      const addDel = line.slice(pipeIdx + 1);
      const adds = (addDel.match(/\+/g) || []).length;
      const dels = (addDel.match(/-/g) || []).length;
      // fileInfo (from --numstat) lists files in the same order as --stat and
      // has exact paths; --stat truncates long names and rewrites renames.
      const idx = files.length;
      const info = fileInfo[idx];
      files.push({ path: info ? info.path : filePart, adds, dels, idx: info ? idx : null });
    }
  });

  if (!files.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-family:var(--font);font-size:11px;">No changes</div>';
    return;
  }

  // Build prefix tree: { children: {name -> node}, file: {adds,dels}|null }
  function makeNode() { return { children: {}, file: null }; }
  const root = makeNode();
  for (const f of files) {
    const parts = f.path.replace(/\\/g, '/').split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!node.children[p]) node.children[p] = makeNode();
      node = node.children[p];
      if (i === parts.length - 1) node.file = { adds: f.adds, dels: f.dels, idx: f.idx };
    }
  }

  // Collapse single-child directories into "dir/subdir" path segments
  function collapse(node, name) {
    const keys = Object.keys(node.children);
    if (keys.length === 1 && node.file === null) {
      const child = node.children[keys[0]];
      return collapse(child, name ? `${name}/${keys[0]}` : keys[0]);
    }
    return { node, name };
  }

  function renderNode(node, name) {
    const sortedKeys = Object.keys(node.children).sort();
    const children = sortedKeys.map(key => {
      const { node: cn, name: cn_name } = collapse(node.children[key], key);
      return renderNode(cn, cn_name);
    });

    if (name === null) {
      // Root — just emit children
      return html`<div class="diff-tree-children">${children}</div>`;
    }

    if (node.file !== null) {
      // File leaf
      const bars = html`<span class="diff-stat-add">${'+'.repeat(node.file.adds)}</span><span class="diff-stat-del">${'-'.repeat(node.file.dels)}</span>`;
      const idxAttr = node.file.idx != null ? raw(` data-idx="${node.file.idx}" title="Click to view side-by-side diff"`) : '';
      return html`
        <div class="diff-stat-line"${idxAttr}>
          <span class="diff-tree-file">${raw(ICON_FILE)}${name}</span>
          <span>${bars}</span>
        </div>`;
    }

    // Directory folder — collapsible via <details> like the branch tree
    return html`
      <details class="diff-folder" open>
        <summary class="diff-folder-label">${raw(ICON_FOLDER)}${name}</summary>
        <div class="diff-tree-children">${children}</div>
      </details>`;
  }

  const treeHtml = renderNode(root, null);
  const sumHtml = summary
    ? html`<div class="diff-tree-summary">${summary}</div>`
    : '';
  render(el, html`${sumHtml}${treeHtml}`);
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
// Convert a git remote URL to its GitHub web URL, or null if not GitHub.
// Handles https (github.com/user/repo(.git)) and ssh (git@github.com:user/repo).
function githubWebUrl(remoteUrl) {
  if (!remoteUrl) return null;
  const m = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}` : null;
}

// Show/hide the GitHub button based on whether the repo is hosted there.
function updateRepoLinks() {
  const url = githubWebUrl(state.remoteUrl);
  state.githubUrl = url;
  $('btn-github').style.display = url ? '' : 'none';
}

async function doPull() {
  if (!state.repoPath) return;
  const btn = $('btn-pull');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span> Pulling…';
  const result = await window.gitApp.pull(state.repoPath);
  btn.disabled = false;
  btn.innerHTML = original;
  if (!result.success) {
    alert(`Pull failed: ${result.error}`);
    return;
  }
  showToast('Pulled');
  await loadRepo(state.repoPath);
}

// Pull any local branch (fast-forward only if it isn't checked out).
async function doPullBranch(branch) {
  if (!state.repoPath || !branch) return;
  showToast(`Pulling ${branch}…`);
  const result = await window.gitApp.pullBranch(state.repoPath, branch);
  if (!result.success) {
    alert(`Pull failed: ${result.error}`);
    return;
  }
  showToast(result.upToDate ? `${branch} is already up to date` : `Pulled ${branch}`);
  await loadRepo(state.repoPath);
}

async function doRebase() {
  if (!state.repoPath) return;
  const btn = $('btn-rebase');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span> Rebasing…';
  const result = await window.gitApp.pullRebase(state.repoPath);
  btn.disabled = false;
  btn.innerHTML = original;
  if (!result.success) {
    alert(`Rebase failed: ${result.error}`);
    return;
  }
  showToast('Updated with rebase');
  await loadRepo(state.repoPath);
}

async function doRebaseOnto(branch) {
  if (!state.repoPath) return;
  const btn = $('btn-rebase');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span> Rebasing…';
  const result = await window.gitApp.rebaseOnto(state.repoPath, branch);
  btn.disabled = false;
  btn.innerHTML = original;
  if (!result.success) {
    alert(`Rebase failed: ${result.error}`);
    return;
  }
  showToast(`Rebased onto ${branch}`);
  await loadRepo(state.repoPath);
}

async function doPush(force = false) {
  if (!state.repoPath) return;
  const btn = $('btn-push');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span> Pushing…';
  const result = force
    ? await window.gitApp.pushForce(state.repoPath)
    : await window.gitApp.push(state.repoPath);
  btn.disabled = false;
  btn.innerHTML = original;
  if (!result.success) {
    alert(`Push failed: ${result.error}`);
    return;
  }
  showToast(force ? `Force pushed ${result.branch}` : `Pushed ${result.branch}`);
  await loadRepo(state.repoPath);
}

async function doFetch() {
  if (!state.repoPath) return;
  const btn = $('btn-fetch');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  const result = await window.gitApp.fetch(state.repoPath);
  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v6M4 4l3-3 3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 9v3h10V9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Fetch`;
  if (result.success) await loadRepo(state.repoPath);
  else alert(`Fetch failed: ${result.error}`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeDate(ts) {
  const now   = Date.now() / 1000;
  const delta = now - ts;
  if (delta < 60)          return 'just now';
  if (delta < 3600)        return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400)       return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 30)  return `${Math.floor(delta / 86400)}d ago`;
  if (delta < 86400 * 365) return `${Math.floor(delta / (86400 * 30))}mo ago`;
  return `${Math.floor(delta / (86400 * 365))}y ago`;
}
