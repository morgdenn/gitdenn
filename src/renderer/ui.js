// ─── Minimal UI helpers (no dependencies, no build step) ──────────────────────
// Purpose: keep GitDenn buildless while removing the two recurring hazards of
// hand-written innerHTML —
//   1. forgetting to HTML-escape interpolated values (XSS / broken markup), and
//   2. re-binding event listeners on every render (stale handlers, lost state).
//
// Loaded as a plain <script> BEFORE app.js, so these names are available to it.
//
// Usage:
//   render('commit-rows', items.map(x => html`<div>${x.name}</div>`));
//   on('commit-rows', 'click', '.commit-row', (el, e) => select(el.dataset.sha));
//
// Interpolated values are auto-escaped. To inject already-safe HTML (e.g. a
// nested html`` result or pre-built markup), wrap it in raw().

class Raw {
  constructor(value) { this.value = value; }
}

// Mark a string as trusted HTML that should NOT be escaped.
function raw(value) {
  return new Raw(value);
}

// Convert any interpolated value into an HTML string.
// - null / undefined / false  → '' (lets you write ${cond && html`...`})
// - Raw                       → its literal HTML
// - Array                     → each item rendered and concatenated
// - everything else           → escaped text
function renderValue(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return escapeHtml(String(v));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

// Auto-escaping tagged template. Returns a Raw so results can nest inside
// other html`` templates without being double-escaped.
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new Raw(out);
}

// Render a template (or array of templates) into a container element or id.
function render(container, template) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.innerHTML = renderValue(template);
}

// Delegated event binding — attach ONCE per container. When an event of `type`
// occurs, if it originated inside an element matching `selector`, `handler` is
// called with (matchedElement, event). Because binding is on the container and
// not the individual rows, re-rendering the container's innerHTML never drops
// handlers and never needs re-wiring.
function on(container, type, selector, handler) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.addEventListener(type, e => {
    const match = e.target.closest(selector);
    if (match && el.contains(match)) handler(match, e);
  });
}
