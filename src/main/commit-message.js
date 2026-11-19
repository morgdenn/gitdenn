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
//
// Suggested git invocation for diffText (main.js side):
//   git -c core.quotepath=off diff --cached -U0 --no-color --no-ext-diff -M

const TYPE_RULES = [
  [/(^|\/)tests?\//, 'test'],
  [/(^|\/)__tests__\//, 'test'],
  [/\.(test|spec)\.[jt]sx?$/, 'test'],
  [/(^|\/)\.github\/workflows\//, 'ci'],
  [/(Jenkinsfile|\.gitlab-ci\.ya?ml|buildspec\.ya?ml)$/, 'ci'],
  [/\.tf$/, 'infra'], // internal type; reconcileType() maps it to 'chore' unless the repo uses it
  [/(^|\/)docs?\/|README|CHANGELOG|LICENSE|\.md$/i, 'docs'],
  [/(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(json|lock)|requirements.*\.txt|Pipfile|go\.(mod|sum)|Gemfile|pom\.xml|\.csproj$)/, 'build'],
  [/Dockerfile|docker-compose\.ya?ml/, 'build'],
  [/\.(ya?ml|json|toml|ini|cfg|env)$/, 'chore'],
];
const STATUS_VERB = { A: 'add', D: 'remove', M: 'update', R: 'rename', C: 'copy' };
// Deliberately narrow: words like error/null/undefined/issue appear in most diffs.
const FIX_WORDS = /\b(fix(e[sd])?|bug|crash|regression|typo)\b/i;
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|node_modules|vendor)\//;
const BRANCH_TYPES = {
  feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', hotfix: 'fix', chore: 'chore',
  docs: 'docs', doc: 'docs', refactor: 'refactor', test: 'test', tests: 'test', ci: 'ci',
  build: 'build', perf: 'perf', style: 'style', revert: 'revert',
};
// If the repo has never used a type, fall back to a more common one.
const TYPE_FALLBACK = { infra: 'chore', ci: 'chore', build: 'chore', style: 'chore', perf: 'refactor' };
const NOT_A_PROJECT_KEY = new Set(['release', 'rc', 'v', 'sprint', 'utf', 'iso', 'sha', 'md']);

const TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/; // for commit subjects (history)
const CONVENTIONAL = /^(\w+)(\(([^)]*)\))?(!)?:\s+(.*)$/;
const SUBJECT_MAX = 72;
const MIN_HISTORY = 5;          // subjects needed before we trust the learned style
const MAX_DIFF_LINES = 4000;    // skip symbol analysis for huge per-file diffs

const baseName = p => p.split('/').pop();
const topKey = counts => {
  let best = null, n = -Infinity;
  for (const [k, v] of Object.entries(counts)) if (v > n) { best = k; n = v; }
  return best;
};

// Branch names are usually lowercase (feature/proj-123-foo), so match any case,
// but ignore "fix-123" style type prefixes and a few common non-ticket words.
function ticketFromBranch(branch) {
  const re = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d+)\b/g;
  let m;
  while ((m = re.exec(branch || ''))) {
    const key = m[1].toLowerCase();
    if (BRANCH_TYPES[key] || NOT_A_PROJECT_KEY.has(key)) continue;
    return `${m[1]}-${m[2]}`.toUpperCase();
  }
  return null;
}

// ── House style, learned from recent subjects ────────────────────────────────
function learnStyle(history) {
  const subjects = (history || []).filter(s => s && !/^(Merge |Revert ")/.test(s));
  const style = {
    conventional: true, scopes: true, ticketAfterColon: false, capitalise: false,
    types: new Set(), learned: false,
  };
  if (subjects.length < MIN_HISTORY) return style; // too little to learn from → sensible default
  style.learned = true;
  let conv = 0, scoped = 0, ticketed = 0, convCap = 0, plain = 0, plainCap = 0;
  for (const s of subjects) {
    const m = CONVENTIONAL.exec(s);
    if (m) {
      conv++;
      if (m[3]) scoped++;
      const hasTicket = TICKET.test(m[5].split(/\s/)[0]);
      if (hasTicket) ticketed++;
      // Judge capitalisation on the first real word, not on a ticket id.
      const word = hasTicket ? m[5].replace(/^\S+\s*/, '') : m[5];
      if (/^[A-Z]/.test(word)) convCap++;
      style.types.add(m[1].toLowerCase());
    } else {
      plain++;
      if (/^[A-Z]/.test(s)) plainCap++;
    }
  }
  style.conventional = conv / subjects.length >= 0.3;
  style.scopes = conv ? scoped / conv >= 0.3 : false;
  style.ticketAfterColon = conv ? ticketed / conv >= 0.2 : false;
  // Each group is divided by its own size, so the ratio can never exceed 1.
  const capNum = style.conventional ? convCap : plainCap;
  const capDen = style.conventional ? conv : plain;
  style.capitalise = capDen ? capNum / capDen >= 0.6 : false;
  return style;
}

function reconcileType(type, style) {
  if (type === 'infra' && !style.types.has('infra')) type = 'chore'; // not a standard type
  if (style.types.size && !style.types.has(type) && TYPE_FALLBACK[type]) type = TYPE_FALLBACK[type];
  return type;
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

// What a "comment line" looks like depends on the language. Unknown extension →
// null, which means we never claim "comment-only".
const COMMENT_STYLES = [
  [/\.(js|jsx|ts|tsx|mjs|cjs|java|kt|kts|go|rs|c|h|cc|cpp|hpp|cs|swift|php|scala|dart|css|scss)$/i, /^\s*(\/\/|\/\*|\*(\s|\/|$))/],
  [/\.(py|sh|bash|zsh|rb|ya?ml|toml|ini|cfg|tf|pl|r|ps1)$|(^|\/)(Dockerfile|Makefile)$/i, /^\s*#/],
  [/\.(html?|xml|svg|vue)$/i, /^\s*<!--/],
  [/\.(sql|lua|hs)$/i, /^\s*--(\s|$)/],
];
const commentRegexFor = p => {
  for (const [ext, re] of COMMENT_STYLES) if (ext.test(p || '')) return re;
  return null;
};

// Parses one file's diff. Lines are only classified once inside a hunk, so
// `++i;` (diff line `+++i;`) and a removed `-- foo` (diff line `--- foo`) are
// counted, while the real ---/+++ headers (before the first @@) are skipped.
function analyseFileDiff(chunk, path = '') {
  const added = new Set(), removed = new Set(), touched = new Set();
  const addLines = [], delLines = [];
  let inHunk = false;
  for (const line of chunk.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      const ctx = line.replace(/^@@[^@]*@@\s*/, '');
      const n = declName(ctx);
      if (n && !CONTROL.has(n)) touched.add(n);
    } else if (!inHunk) {
      continue;
    } else if (line[0] === '+') {
      addLines.push(line.slice(1));
      const n = declName(line.slice(1)); if (n && !CONTROL.has(n)) added.add(n);
    } else if (line[0] === '-') {
      delLines.push(line.slice(1));
      const n = declName(line.slice(1)); if (n && !CONTROL.has(n)) removed.add(n);
    }
  }
  // A symbol appearing on both sides was edited, not added/removed.
  for (const n of [...added]) if (removed.has(n)) { added.delete(n); removed.delete(n); touched.add(n); }
  const norm = a => a.map(l => l.replace(/\s+/g, '')).filter(Boolean).sort().join('\n');
  const changed = addLines.length + delLines.length > 0;
  const commentRe = commentRegexFor(path);
  return {
    added: [...added], removed: [...removed], touched: [...touched],
    whitespaceOnly: changed && norm(addLines) === norm(delLines),
    commentOnly: changed && !!commentRe && [...addLines, ...delLines].every(l => !l.trim() || commentRe.test(l)),
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

// index.js ×2 → "a/index.js" and "b/index.js"; unique names stay as the bare file name.
function makeNamer(files) {
  const counts = {};
  for (const f of files) counts[baseName(f.path)] = (counts[baseName(f.path)] || 0) + 1;
  return p => {
    const b = baseName(p);
    if (counts[b] < 2) return b;
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(-2).join('/') : b;
  };
}

// One verb only if every file shares it; a mix of add/modify reads as "update".
const commonVerb = fs => {
  const vs = new Set(fs.map(f => STATUS_VERB[f.status] || 'update'));
  return vs.size === 1 ? [...vs][0] : 'update';
};

function truncateSubject(s) {
  if (s.length <= SUBJECT_MAX) return s;
  const cut = s.slice(0, SUBJECT_MAX - 3);
  const sp = cut.lastIndexOf(' ');
  return (sp > SUBJECT_MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,:;(]+$/, '') + '...';
}

// Drop git's own "# Conflicts:" / "#\tfile" comment lines.
const cleanMergeMsg = m => (m || '').split('\n').filter(l => !l.startsWith('#')).join('\n').trim();

// ── Main entry ────────────────────────────────────────────────────────────────
// files: [{ status:'A'|'M'|'D'|'R'|'C', path, oldPath?, adds, dels }]
// Returns { subject, body, message } — message is subject (+ blank line + body).
function buildCommitMessage({ files, diffText = '', branch = '', history = [], mergeMsg = '' }) {
  const merge = cleanMergeMsg(mergeMsg);
  if (merge) {
    const [subject, ...rest] = merge.split('\n');
    return { subject, body: rest.join('\n').trim(), message: merge };
  }
  if (!files || !files.length) return { subject: '', body: '', message: '' };

  const style = learnStyle(history);
  const perFile = splitDiffByFile(diffText);
  const info = {};
  for (const f of files) {
    const chunk = perFile[f.path];
    const small = chunk && chunk.split('\n').length <= MAX_DIFF_LINES;
    info[f.path] = small ? analyseFileDiff(chunk, f.path) : null;
  }

  // Prefer real source over lockfiles/generated output when naming and voting.
  const real = files.filter(f => !NOISE.test(f.path));
  const focus = real.length ? real : files;
  const nameOf = makeNamer(focus);

  // Branch hints.
  const ticket = ticketFromBranch(branch);
  const branchWord = (branch || '').split(/[\/\-_]/)[0].toLowerCase();
  const branchType = BRANCH_TYPES[branchWord] || null;

  // Special whole-change cases first.
  let type = null, detail = null, versionBump = false;

  // Version bump: package.json where the only change is "version".
  const pkg = focus.length === 1 && baseName(focus[0].path) === 'package.json' && info[focus[0].path];
  if (pkg) {
    const v = pkg.addLines.find(l => /"version"\s*:/.test(l));
    if (v && pkg.addLines.filter(l => l.trim()).length === 1 && pkg.delLines.filter(l => l.trim()).length === 1) {
      const ver = /"version"\s*:\s*"([^"]+)"/.exec(v);
      if (ver) { type = 'chore'; detail = `bump version to ${ver[1]}`; versionBump = true; }
    }
  }

  // Votes weighted by how much changed, ignoring tests/docs when real source also changed.
  const weight = f => Math.max(1, (f.adds || 0) + (f.dels || 0));
  const analyses = focus.map(f => info[f.path]).filter(Boolean);
  const allWhitespace = analyses.length === focus.length && analyses.every(a => a.whitespaceOnly);
  const allComments = analyses.length === focus.length && analyses.every(a => a.commentOnly);
  // Only added lines of the files we're naming — not headers, lockfiles or removed code.
  const fixSignal = focus.some(f => info[f.path] && info[f.path].addLines.some(l => FIX_WORDS.test(l)));

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
  type = reconcileType(type, style); // don't invent types the repo doesn't use

  // Scope (only if the repo uses scopes).
  const scopeCount = {};
  // Like the type vote: when real source changed, tests/docs/config don't pick the scope.
  const scopeFiles = hasSource ? focus.filter(f => classify(f) === null) : focus;
  for (const f of scopeFiles) { const s = scopeFromPath(f.path); if (s) scopeCount[s] = (scopeCount[s] || 0) + weight(f); }
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
      const name = nameOf(f.path);
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
      const total = focus.length;
      const phrases = verbs.map(v => {
        const list = listNames(actions[v].map(f => nameOf(f.path)), 3);
        return list ? `${v} ${list}` : `${v} ${actions[v].length} files`;
      });
      detail = total <= 3 && phrases.length <= 2
        ? phrases.join(', ')
        : `${commonVerb(focus)} ${total} files`;
      if (scope && total > 3) detail += ` in ${scope}`;
    }
  }

  // Short form used when the detailed subject doesn't fit: say how much, not what.
  const countDetail = focus.length === 1
    ? `${commonVerb(focus)} ${nameOf(focus[0].path)}`
    : `${commonVerb(focus)} ${focus.length} files${scope ? ` in ${scope}` : ''}`;

  // Assemble in the house style. Not enough history to learn from → still add the ticket.
  const useTicket = ticket && (style.ticketAfterColon || !style.learned);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const assemble = d => {
    let desc = (style.capitalise || !style.conventional) ? cap(d) : d;
    if (useTicket) desc = `${ticket} ${desc}`;
    return style.conventional ? `${type}${scope ? `(${scope})` : ''}: ${desc}` : desc;
  };
  let subject = assemble(detail);
  let detailToBody = '';
  if (subject.length > SUBJECT_MAX && !versionBump) {
    const short = assemble(countDetail);
    if (short.length < subject.length) { subject = short; detailToBody = `- ${detail}`; }
  }
  subject = truncateSubject(subject);

  // Body: itemise multi-file changes (excluding nothing — lockfiles listed too).
  // Plain ASCII so it survives Windows consoles and older git configs.
  let body = '';
  if (files.length >= 2 && files.length <= 12) {
    body = files.map(f => {
      const verb = STATUS_VERB[f.status] || 'update';
      const what = f.status === 'R' && f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path;
      const size = (f.adds || f.dels) ? ` (+${f.adds || 0} -${f.dels || 0})` : '';
      return `- ${verb} ${what}${size}`;
    }).join('\n');
  } else if (detailToBody) {
    body = detailToBody; // the long detail we cut from the subject
  }

  return { subject, body, message: body ? `${subject}\n\n${body}` : subject };
}

module.exports = { buildCommitMessage, learnStyle, analyseFileDiff, splitDiffByFile };
