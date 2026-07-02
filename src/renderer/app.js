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
const repoView        = $('repo-view');
const commitRows      = $('commit-rows');
const graphCanvas     = $('graph-canvas');
const detailPlaceholder = $('detail-placeholder');
const detailContent   = $('detail-content');
const graphScroll     = $('graph-scroll');

// ─── Graph layout constants ───────────────────────────────────────────────────
const ROW_H    = 28;
let   GRAPH_W  = 220;
const COL_W    = 14;   // px per branch lane
const DOT_R    = 4;    // commit dot radius
const LANE_PAD = 12;   // left padding before first lane

// Branch lane colours (cycling) — Monokai palette, no purple
const LANE_COLORS = [
  '#a6e22e', '#66d9ef', '#f92672', '#fd971f',
  '#e6db74', '#a1efe4', '#f45b8f', '#b8e673',
  '#78dce8', '#ffa94d', '#d1d648', '#7bd88f',
];
const laneColor = lane => LANE_COLORS[lane % LANE_COLORS.length];

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

  initColumnResizers();
  initSidebarPanels();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideCloneModal();
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
// Draggable dividers on the graph-panel header. Dragging updates the CSS width
// variable for that column; the flexible "Commit message" column absorbs the
// slack. Resizing the Graph column also resizes the canvas and repaints.
const RESIZABLE_COLS = [
  { cls: 'col-branch', varName: '--branch-w', min: 60 },
  { cls: 'col-graph',  varName: '--graph-w',  min: 80 },
  { cls: 'col-author', varName: '--author-w', min: 60 },
  { cls: 'col-date',   varName: '--date-w',   min: 60 },
  { cls: 'col-sha',    varName: '--sha-w',    min: 50 },
  { cls: 'col-tag',    varName: '--tag-w',    min: 50 },
];

function initColumnResizers() {
  const header = $('graph-header');
  RESIZABLE_COLS.forEach(col => {
    const cell = header.querySelector('.' + col.cls);
    if (!cell) return;
    const handle = document.createElement('span');
    handle.className = 'col-resizer';
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
  document.body.classList.add('col-resizing');

  const onMove = ev => {
    const width = Math.max(col.min, startW + (ev.clientX - startX));
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

  // Update toolbar
  const repoName = repoPath.split(/[\\/]/).pop();
  $('repo-name-display').textContent = repoName;
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
  const remoteItems = remotes.slice(0, 20).map(b => ({
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
          <span class="branch-dot"></span>
          ${child.label}
        </div>`;
    }
    return html`
      <details class="branch-folder" open>
        <summary class="branch-folder-label">${child.label}</summary>
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
      connections.push({ fromLane: lane, toLane: parentLane, parentSha });
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
    return html`
      <div class="commit-row ${selected}" data-sha="${commit.sha}" data-idx="${i}">
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
    if (ref === 'HEAD') return `<span class="ref-badge ref-head"${style}>HEAD</span>`;
    if (ref.startsWith('HEAD -> ')) return `<span class="ref-badge ref-head"${style}>${escHtml(ref.replace('HEAD -> ', ''))}</span>`;
    if (ref.startsWith('tag: '))  return `<span class="ref-badge ref-tag">${escHtml(ref.replace('tag: ', ''))}</span>`;
    const remote = ref.split('/')[0];
    if (remotes.has(remote)) {
      const name = ref.slice(remote.length + 1); // strip "origin/"
      if (name === 'HEAD' || name === '') return ''; // skip "origin/HEAD"
      return `<span class="ref-badge ref-remote"${style}>${escHtml(name)}</span>`;
    }
    return `<span class="ref-badge ref-branch"${style}>${escHtml(ref)}</span>`;
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

  // Draw edges
  for (let i = firstRow; i <= lastRow; i++) {
    const row = graphData[i];
    row.connections.forEach(({ fromLane, toLane, parentSha }) => {
      const parentRow = graphData.findIndex(r => r.commit.sha === parentSha);
      if (parentRow < 0) return;

      const x1 = laneX(fromLane);
      const y1 = rowY(i);
      const x2 = laneX(toLane);
      const y2 = rowY(parentRow);

      ctx.beginPath();
      ctx.strokeStyle = color(fromLane);
      ctx.lineWidth = 1.5;
      ctx.moveTo(x1, y1);

      if (fromLane === toLane) {
        ctx.lineTo(x2, y2);
      } else {
        // Bezier curve for branch/merge lines
        const midY = (y1 + y2) / 2;
        ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
      }
      ctx.stroke();
    });
  }

  // Draw commit dots
  for (let i = firstRow; i <= lastRow; i++) {
    const row = graphData[i];
    const x = laneX(row.lane);
    const y = rowY(i);
    const c = color(row.lane);

    // Outer glow ring for merge commits
    if (row.commit.parents.length > 1) {
      ctx.beginPath();
      ctx.arc(x, y, DOT_R + 3, 0, Math.PI * 2);
      ctx.strokeStyle = c + '55';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Dot
    ctx.beginPath();
    ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();

    // White inner for selected
    if (row.commit.sha === state.selectedSha) {
      ctx.beginPath();
      ctx.arc(x, y, DOT_R - 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
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
