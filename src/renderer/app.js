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
});

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
  $('btn-github').addEventListener('click', () => {
    if (state.githubUrl) window.gitApp.openExternal(state.githubUrl);
  });
  $('btn-vscode').addEventListener('click', () => {
    if (state.repoPath) window.gitApp.openInVscode(state.repoPath);
  });
  $('branch-cancel').addEventListener('click', hideBranchModal);
  $('branch-cancel-2').addEventListener('click', hideBranchModal);
  $('branch-confirm').addEventListener('click', doCreateBranch);
  $('branch-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') doCreateBranch();
  });

  initColumnResizers();
  initSidebarPanels();
  initBranchSplit();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideCloneModal(); hideBranchModal(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') loadRepo(state.repoPath);
  });

  // Graph scroll → repaint canvas
  graphScroll.addEventListener('scroll', () => paintGraph(state.graphData));

  // Commit row selection (delegated — survives every re-render, bound once)
  on(commitRows, 'click', '.commit-row', el => selectCommit(el.dataset.sha, el.dataset.idx));

  // Double-click a remote branch → check it out as a local tracking branch
  on('remote-branches-list', 'dblclick', '.branch-remote', el => checkoutRemoteBranch(el.dataset.branch));

  // Double-click a local branch → switch to it
  on('local-branches-list', 'dblclick', '.branch-item', el => checkoutLocalBranch(el.dataset.branch));
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

  state.commits = result.commits;
  state.branches = result.branches;
  state.currentBranch = result.currentBranch;
  state.remoteUrl = result.remoteUrl || null;

  // Update toolbar
  const repoName = repoPath.split(/[\\/]/).pop();
  $('repo-name-display').textContent = repoName;
  updateRepoLinks();
  $('branches-panel').classList.add('has-repo');
  renderBranches();
  renderStatusChips(result.status);
  addRecentRepo(repoPath);
  renderRecentRepos();

  // Compute graph layout
  const graphData = computeGraphLayout(state.commits);
  state.graphData = graphData;
  renderCommitRows(graphData);
  paintGraph(graphData);
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
const ICON_CHECK = `<svg class="tree-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
  <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" style="fill:var(--green)"/>
  <path d="M4.6 8.2l2.1 2.2 4.7-4.9" fill="none" style="stroke:var(--bg-deep)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function renderBranchTree(node, opts) {
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
      return html`
        <div class="${cls}" data-branch="${it.value}"${title}>
          ${raw(it.current ? ICON_CHECK : ICON_BRANCH)}
          ${child.label}
        </div>`;
    }
    return html`
      <details class="branch-folder" open>
        <summary class="branch-folder-label">${raw(ICON_FOLDER)}${child.label}</summary>
        <div class="branch-tree-children">${renderBranchTree(child, opts)}</div>
      </details>`;
  });
}

// Double-clicking a remote branch checks it out as a local tracking branch.
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
    const selected = commit.sha === state.selectedSha ? 'selected' : '';
    const branchRefs = filterSyncedRemotes(
      commit.refs.filter(r => !r.startsWith('tag: ')),
      remoteNames
    );
    const tagRefs    = commit.refs.filter(r =>  r.startsWith('tag: '));
    // Tint the graph cell to the right of this commit's graph line only.
    const lineX = LANE_PAD + row.lane * COL_W + COL_W / 2;
    const tint = raw(` style="--lane-tint: color-mix(in srgb, ${laneColor(row.lane)} 12%, transparent); --line-x: ${lineX}px"`);
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

// ─── Select Commit ────────────────────────────────────────────────────────────
async function selectCommit(sha, idx) {
  state.selectedSha = sha;

  // Update row highlight
  document.querySelectorAll('.commit-row').forEach(el => {
    el.classList.toggle('selected', el.dataset.sha === sha);
  });

  // Repaint to show selection dot
  paintGraph(state.graphData);

  // Show detail panel
  const commit = state.commits.find(c => c.sha === sha);
  if (!commit) return;

  detailPlaceholder.style.display = 'none';
  detailContent.style.display = 'block';

  const initials = commit.authorName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  $('detail-avatar').textContent = initials;
  $('detail-subject').textContent = commit.subject;
  $('detail-author').textContent = commit.authorName + ' <' + commit.authorEmail + '>';
  $('detail-date').textContent = new Date(commit.timestamp * 1000).toLocaleString();
  $('detail-sha').textContent = commit.sha;
  $('detail-refs').innerHTML = buildRefBadges(commit.refs);
  $('detail-diff').innerHTML = '<div style="color:var(--text-muted);font-family:var(--font);font-size:11px;">Loading diff…</div>';

  // Fetch diff
  const diff = await window.gitApp.commitDiff(state.repoPath, sha);
  if (diff.success) {
    renderDiff(diff.stat);
  }
}

function renderDiff(stat) {
  const lines = stat.trim().split('\n');
  const el = $('detail-diff');

  let html = '';
  lines.forEach(line => {
    line = escHtml(line);
    if (line.match(/^\s*\d+ file/)) {
      html += `<div style="color:var(--text-sec);font-size:11px;margin-top:8px;font-family:var(--font)">${line}</div>`;
    } else if (line.includes('|')) {
      const [file, changes] = line.split('|');
      const addDel = changes || '';
      const adds = (addDel.match(/\+/g) || []).length;
      const dels = (addDel.match(/-/g) || []).length;
      html += `
        <div class="diff-stat-line">
          <span class="diff-file-header">${file.trim()}</span>
          <span><span class="diff-stat-add">${'+'.repeat(adds)}</span><span class="diff-stat-del">${'-'.repeat(dels)}</span></span>
        </div>
      `;
    } else if (line.trim()) {
      html += `<div style="color:var(--text-muted);font-size:10px;">${line}</div>`;
    }
  });

  el.innerHTML = html || '<div style="color:var(--text-muted);font-family:var(--font);font-size:11px;">No changes</div>';
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
