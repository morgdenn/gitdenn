// Heuristic commit-message generator. Pure functions only (no git, no I/O) so
// the logic is easy to test: main.js gathers the inputs, this builds the text.
//
// Signals used:
//   • file paths / statuses / sizes            → type, scope, verb, file names
//   • the diff itself                          → touched / added / removed symbols,
//                                                 whitespace-only, comment-only,
//                                                 version-bump detection
//   • the branch name                          → ticket id (PROJ-123), type hint
//   • the repo's recent commit subjects        → learn the house style
//                                                 (conventional vs plain, scopes,
//                                                 ticket placement, capitalisation)
//   • an in-progress merge (MERGE_MSG)         → reuse git's own message
// Nothing leaves the machine; there is no AI service involved.

const TYPE_RULES = [
  [/(^|\/)tests?\//, 'test'],
  [/(^|\/)__tests__\//, 'test'],
  [/\.(test|spec)\.[jt]sx?$/, 'test'],
  [/(^|\/)\.github\/workflows\//, 'ci'],
  [/(Jenkinsfile|\.gitlab-ci\.ya?ml|buildspec\.ya?ml)$/, 'ci'],
  [/\.tf$/, 'infra'],
  [/(^|\/)docs?\/|README|CHANGELOG|LICENSE|\.md$/i, 'docs'],
  [/(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(json|lock)|requirements.*\.txt|Pipfile|go\.(mod|sum)|Gemfile|pom\.xml|\.csproj$)/, 'build'],
  [/Dockerfile|docker-compose\.ya?ml/, 'build'],
  [/\.(ya?ml|json|toml|ini|cfg|env)$/, 'chore'],
];
const STATUS_VERB = { A: 'add', D: 'remove', M: 'update', R: 'rename', C: 'copy' };
const FIX_WORDS = /\b(fix(e[sd])?|bug|error|issue|crash|resolve[sd]?|patch|regression|null|undefined|typo)\b/i;
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|node_modules|vendor)\//;
const BRANCH_TYPES = {
  feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', hotfix: 'fix', chore: 'chore',
  docs: 'docs', doc: 'docs', refactor: 'refactor', test: 'test', tests: 'test', ci: 'ci',
  build: 'build', perf: 'perf', style: 'style', revert: 'revert',
};
const TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
const CONVENTIONAL = /^(\w+)(\(([^)]*)\))?(!)?:\s+(.*)$/;
const SUBJECT_MAX = 72;

const baseName = p => p.split('/').pop();
const topKey = counts => {
  let best = null, n = -Infinity;
  for (const [k, v] of Object.entries(counts)) if (v > n) { best = k; n = v; }
  return best;
};

// ── House style, learned from recent subjects ────────────────────────────────
function learnStyle(history) {
  const subjects = (history || []).filter(s => s && !/^(Merge |Revert ")/.test(s));
  const style = { conventional: true, scopes: true, ticketAfterColon: false, capitalise: false, types: new Set() };
  if (subjects.length < 5) return style; // too little to learn from → sensible default
  let conv = 0, scoped = 0, ticketed = 0, capital = 0;
  for (const s of subjects) {
    const m = CONVENTIONAL.exec(s);
    if (m) {
      conv++;
      if (m[3]) scoped++;
      const hasTicket = TICKET.test(m[5].split(/\s/)[0]);
      if (hasTicket) ticketed++;
      // Judge capitalisation on the first real word, not on a ticket id.
      const word = hasTicket ? m[5].replace(/^\S+\s*/, '') : m[5];
      if (/^[A-Z]/.test(word)) capital++;
      style.types.add(m[1].toLowerCase());
    } else if (/^[A-Z]/.test(s)) capital++;
  }
  style.conventional = conv / subjects.length >= 0.3;
  style.scopes = conv ? scoped / conv >= 0.3 : false;
  style.ticketAfterColon = conv ? ticketed / conv >= 0.2 : false;
  style.capitalise = (style.conventional ? conv : subjects.length) ? capital / (style.conventional ? conv : subjects.length) >= 0.6 : false;
  return style;
}

// ── Diff analysis ─────────────────────────────────────────────────────────────
function splitDiffByFile(diffText) {
  const out = {};
  if (!diffText) return out;
  for (const chunk of diffText.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const m = /^a\/(.+?) b\/(.+)$/m.exec(chunk.split('\n')[0]);
    if (m) out[m[2]] = chunk;
  }
  return out;
}

const DECLS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:public|private|protected|static)\s+[\w<>\[\],\s]+?\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/,
];
const declName = line => {
  for (const re of DECLS) { const m = re.exec(line); if (m) return m[1]; }
  return null;
};
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'function']);

function analyseFileDiff(chunk) {
  const added = new Set(), removed = new Set(), touched = new Set();
  const addLines = [], delLines = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('@@')) {
      const ctx = line.replace(/^@@[^@]*@@\s*/, '');
      const n = declName(ctx);
      if (n && !CONTROL.has(n)) touched.add(n);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addLines.push(line.slice(1));
      const n = declName(line.slice(1)); if (n && !CONTROL.has(n)) added.add(n);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      delLines.push(line.slice(1));
      const n = declName(line.slice(1)); if (n && !CONTROL.has(n)) removed.add(n);
    }
  }
  // A symbol appearing on both sides was edited, not added/removed.
  for (const n of [...added]) if (removed.has(n)) { added.delete(n); removed.delete(n); touched.add(n); }
  const norm = a => a.map(l => l.replace(/\s+/g, '')).filter(Boolean).sort().join('\n');
  const changed = addLines.length + delLines.length > 0;
  return {
    added: [...added], removed: [...removed], touched: [...touched],
    whitespaceOnly: changed && norm(addLines) === norm(delLines),
    commentOnly: changed && [...addLines, ...delLines].every(l => !l.trim() || /^\s*(\/\/|#|\*|\/\*|<!--|--)/.test(l)),
    addLines, delLines,
  };
}

// ── Helpers for naming ───────────────────────────────────────────────────────
function scopeFromPath(p) {
  const parts = p.split('/');
  if (parts.length === 1) return null;
  for (const seg of parts.slice(0, -1)) if (!['src', 'lib', 'app', 'packages', '.'].includes(seg)) return seg;
  return parts[0];
}

function listNames(names, max) {
  if (names.length <= 1) return names.join('');
  if (names.length <= max) return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return null;
}

function truncateSubject(s) {
  if (s.length <= SUBJECT_MAX) return s;
  const cut = s.slice(0, SUBJECT_MAX - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > SUBJECT_MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,:;(]+$/, '') + '…';
}

// ── Main entry ────────────────────────────────────────────────────────────────
// files: [{ status:'A'|'M'|'D'|'R'|'C', path, oldPath?, adds, dels }]
// Returns { subject, body, message } — message is subject (+ blank line + body).
function buildCommitMessage({ files, diffText = '', branch = '', history = [], mergeMsg = '' }) {
  if (mergeMsg && mergeMsg.trim()) {
    const [subject, ...rest] = mergeMsg.trim().split('\n');
    const body = rest.join('\n').trim();
    return { subject, body, message: mergeMsg.trim() };
  }
  if (!files || !files.length) return { subject: '', body: '', message: '' };

  const style = learnStyle(history);
  const perFile = splitDiffByFile(diffText);
  const info = {};
  for (const f of files) info[f.path] = perFile[f.path] ? analyseFileDiff(perFile[f.path]) : null;

  // Prefer real source over lockfiles/generated output when naming and voting.
  const real = files.filter(f => !NOISE.test(f.path));
  const focus = real.length ? real : files;

  // Branch hints.
  const ticketMatch = TICKET.exec(branch || '');
  const ticket = ticketMatch ? ticketMatch[1].toUpperCase() : null;
  const branchWord = (branch || '').split(/[\/\-_]/)[0].toLowerCase();
  const branchType = BRANCH_TYPES[branchWord] || null;

  // Special whole-change cases first.
  let type = null, detail = null;

  // Version bump: package.json where the only change is "version".
  const pkg = focus.length === 1 && baseName(focus[0].path) === 'package.json' && info[focus[0].path];
  if (pkg) {
    const v = pkg.addLines.find(l => /"version"\s*:/.test(l));
    if (v && pkg.addLines.filter(l => l.trim()).length === 1 && pkg.delLines.filter(l => l.trim()).length === 1) {
      const ver = /"version"\s*:\s*"([^"]+)"/.exec(v);
      if (ver) { type = 'chore'; detail = `bump version to ${ver[1]}`; }
    }
  }

  // Votes weighted by how much changed, ignoring tests/docs when real source also changed.
  const weight = f => Math.max(1, (f.adds || 0) + (f.dels || 0));
  const analyses = focus.map(f => info[f.path]).filter(Boolean);
  const allWhitespace = analyses.length === focus.length && analyses.every(a => a.whitespaceOnly);
  const allComments = analyses.length === focus.length && analyses.every(a => a.commentOnly);
  const fixSignal = FIX_WORDS.test(diffText.split('\n').filter(l => /^[+-]/.test(l)).join('\n'));

  const votes = {};
  const classify = f => {
    for (const [re, t] of TYPE_RULES) if (re.test(f.path)) return t;
    return null;
  };
  const hasSource = focus.some(f => classify(f) === null);
  for (const f of focus) {
    let t = classify(f);
    if (t === null) {
      if (branchType && ['feat', 'fix', 'refactor', 'perf', 'chore'].includes(branchType)) t = branchType;
      else if (f.status === 'D') t = 'chore';
      else if (f.status === 'A') t = 'feat';
      else if (fixSignal) t = 'fix';
      else if (info[f.path] && info[f.path].added.length) t = 'feat'; // new function/class
      else t = 'refactor';
    } else if (hasSource && (t === 'test' || t === 'docs' || t === 'chore' || t === 'build')) {
      continue; // supporting files don't decide the type when source changed
    }
    votes[t] = (votes[t] || 0) + weight(f);
  }
  if (!type) type = topKey(votes) || branchType || 'chore';
  if (!detail) {
    if (allWhitespace) type = 'style';
    else if (allComments && type !== 'docs') type = 'docs';
  }
  if (style.types.size && !style.types.has(type) && type === 'infra') type = 'chore'; // don't invent exotic types

  // Scope (only if the repo uses scopes).
  const scopeCount = {};
  for (const f of focus) { const s = scopeFromPath(f.path); if (s) scopeCount[s] = (scopeCount[s] || 0) + weight(f); }
  const scope = style.scopes && Object.keys(scopeCount).length ? topKey(scopeCount) : null;

  // Detail: what happened, as specifically as the evidence allows.
  if (!detail) {
    const actions = {};
    for (const f of focus) (actions[STATUS_VERB[f.status] || 'update'] ||= []).push(f);
    const ORDER = ['add', 'update', 'rename', 'copy', 'remove'];
    const verbs = Object.keys(actions).sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));

    if (focus.length === 1) {
      const f = focus[0];
      const a = info[f.path];
      const name = baseName(f.path);
      if (f.status === 'R') {
        detail = `rename ${baseName(f.oldPath || '')} to ${name}`;
      } else if (a && f.status === 'A' && a.added.length) {
        detail = `add ${listNames(a.added.slice(0, 3), 3)} in ${name}`;
      } else if (a && f.status === 'M' && (a.added.length || a.removed.length || a.touched.length)) {
        const parts = [];
        if (a.added.length) parts.push(`add ${listNames(a.added.slice(0, 2), 2)}`);
        if (a.removed.length) parts.push(`remove ${listNames(a.removed.slice(0, 2), 2)}`);
        if (!parts.length) parts.push(`update ${listNames(a.touched.slice(0, 2), 2)}`);
        detail = `${parts.join(', ')} in ${name}`;
      } else {
        detail = `${STATUS_VERB[f.status] || 'update'} ${f.path}`;
      }
    } else if (verbs.length === 1 && focus.every(f => f.status === 'R')) {
      detail = `rename ${focus.length} files`;
    } else {
      const names = focus.map(f => baseName(f.path));
      const phrases = verbs.map(v => {
        const list = listNames(actions[v].map(f => baseName(f.path)), 3);
        return list ? `${v} ${list}` : `${v} ${actions[v].length} files`;
      });
      const total = names.length;
      detail = total <= 3 && phrases.length <= 2
        ? phrases.join(', ')
        : `${topKey(Object.fromEntries(verbs.map(v => [v, actions[v].length])))} ${total} files`;
      if (scope && total > 3) detail += ` in ${scope}`;
    }
  }

  // Assemble in the house style.
  const useTicket = ticket && (style.ticketAfterColon || !history.length);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  let desc = (style.capitalise || !style.conventional) ? cap(detail) : detail;
  if (useTicket) desc = `${ticket} ${desc}`;
  let subject;
  if (style.conventional) subject = `${type}${scope ? `(${scope})` : ''}: ${desc}`;
  else subject = desc;
  subject = truncateSubject(subject);

  // Body: itemise multi-file changes (excluding nothing — lockfiles listed too).
  let body = '';
  if (files.length >= 2 && files.length <= 12) {
    body = files.map(f => {
      const verb = STATUS_VERB[f.status] || 'update';
      const what = f.status === 'R' && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
      const size = (f.adds || f.dels) ? ` (+${f.adds || 0} −${f.dels || 0})` : '';
      return `- ${verb} ${what}${size}`;
    }).join('\n');
  }

  return { subject, body, message: body ? `${subject}\n\n${body}` : subject };
}

module.exports = { buildCommitMessage, learnStyle, analyseFileDiff, splitDiffByFile };
