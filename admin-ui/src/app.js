'use strict';
// The admin console. Vanilla, no framework, no imports - the shell is served
// unauthenticated (D-35) and every value it shows arrives from a gated route.
//
// NO RATIONALE IN THE UI. The prototype argued for its own design decisions in hint text
// because it was a design artifact; Rocket's note on it was that there was a lot of extra
// information and some of it was not clearly relevant. A hint survives here only where it
// changes what someone types. The reasoning lives in these comments and in CONTEXT.md.
//
// LAYOUT (#52, D-82). The command surface - tally, caution, chips - sits above every
// section and is identical in both views, so the job this page is opened for costs one
// glance and zero navigation. The rail below it REVEALS one section and hides the rest; it
// never scrolls. Simple view carries the two sections that hold things you set.

var DRAFT_KEY = 'onair.draft.v1';
var VIEW_KEY = 'onair.view.v1';
var THEME_KEY = 'onair.theme.v1';

var session = null;      // the admin bearer token, in MEMORY only - never a cookie (D-35)
var live = null;         // the config document as the server has it
var draft = null;        // staged edits, keyed the same shape as `live`
var editing = {};        // id -> the in-progress edit for one row, not yet staged
// NOT `status`. At top level in a classic script `var status` binds window.status, a
// legacy STRING property - so `status = someObject` silently stores "[object Object]",
// which is truthy and has no fields. It renders as a blank page with one exception in the
// console and nothing else. Found in a browser; no test would have.
var liveStatus = null;       // the gated /status readout

// THE CLIENT CONTRACT (D-91/D-92). The console is a renderer like any other: it polls, and
// it judges its own CONNECTION rather than reading a verdict off the wire. `stale` is gone
// from the server precisely because it was a judgement, and the console used to key five
// separate pieces of chrome on it.
//
// Both thresholds are measured from the LAST SUCCESSFUL CONTACT, on our own clock, and are
// NOT chained off each other. Nothing here reads `ageSeconds` to decide anything: that is
// provenance about the WRITE, and a write being old is not the same as the server being
// gone - conflating the two is what painted NO DATA on a healthy system.
var CONNECTION_LOST_MS = 60000;    // 1 minute  - say it is no longer refreshing
var NO_DATA_MS = 1800000;          // 30 minutes - give up on the state entirely
var lastContactAt = 0;
var lastRenderedState = null; // which row last wore the LIVE badge - see refreshStatus()
var nags = {};
var envInfo = { overrides: [], effective: {} };  // what the environment is overriding (D-79)
var view = 'simple';
var section = 'states';

var $ = function (id) { return document.getElementById(id); };
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
function recall(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

// ---------------------------------------------------------------- transport

function api(path, opts) {
  opts = opts || {};
  var headers = opts.headers || {};
  if (session) headers['authorization'] = 'Bearer ' + session;
  if (opts.body) headers['content-type'] = 'application/json';
  return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body }).then(function (r) {
    return r.text().then(function (text) {
      var body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = { error: text }; }
      return { status: r.status, body: body };
    });
  });
}

// ---------------------------------------------------------------- view and theme
//
// BOTH ARE localStorage AND NEITHER TOUCHES THE DRAFT (D-80). Putting a view preference in
// the config document would mean that changing what you are LOOKING at marks the
// configuration dirty, increments the staged count and arms the beforeunload guard. That
// teaches the staged count to cry wolf. They apply instantly and follow the browser.

function setView(next) {
  view = next === 'advanced' ? 'advanced' : 'simple';
  store(VIEW_KEY, view);
  $('view-simple').className = 'seg' + (view === 'simple' ? ' on' : '');
  $('view-advanced').className = 'seg' + (view === 'advanced' ? ' on' : '');
  $('admin-view').value = view;
  // A section that simple view does not carry must not stay open when the view narrows.
  if (sectionsFor().indexOf(section) === -1) section = 'states';
  renderRail();
  showSection(section);
}

function setTheme(next) {
  // Explicit only. There is no third "system" setting: Rocket asked for an icon that
  // toggles between the two, and a tri-state control that silently passes through a mode
  // with no icon of its own is a worse answer to that than two states.
  var dark = next === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  store(THEME_KEY, dark ? 'dark' : 'light');
  $('icon-sun').hidden = dark;
  $('icon-moon').hidden = !dark;
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function bootPreferences() {
  var savedTheme = recall(THEME_KEY);
  if (savedTheme !== 'dark' && savedTheme !== 'light') {
    savedTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }
  setTheme(savedTheme);
  setView(recall(VIEW_KEY) === 'advanced' ? 'advanced' : 'simple');
}

// ---------------------------------------------------------------- sections

// Simple view carries only the sections that hold things you SET. Status, Network and
// Device connection hold facts and machine settings; the command surface above already
// carries the one fact that matters, and it is on screen in both views.
var SECTIONS = [
  { id: 'status', label: 'Status', simple: false },
  { id: 'states', label: 'States', simple: true },
  { id: 'admin', label: 'Admin', simple: true },
  { id: 'network', label: 'Network', simple: false },
  { id: 'device', label: 'Device connection', simple: false }
];

function sectionsFor() {
  return SECTIONS.filter(function (s) { return view === 'advanced' || s.simple; })
                 .map(function (s) { return s.id; });
}

function showSection(id) {
  section = id;
  SECTIONS.forEach(function (s) {
    $('sec-' + s.id).hidden = s.id !== id;
  });
  renderRail();
}

// The rail carries live signal per section, not just links: how many changes are staged in
// each, and whether a section has something to say. Without it the commit bar can report
// "2 staged" with nothing on screen naming where they are.
function railSignal(id) {
  if (id === 'states') {
    var n = stagedRowIds().length;
    return n ? { text: n + ' staged', cls: 'staged' } : null;
  }
  if (id === 'network' || id === 'device' || id === 'admin') {
    return sectionDirty(id) ? { text: 'staged', cls: 'staged' } : null;
  }
  if (id === 'status') {
    if (!liveStatus) return null;
    if (gaveUp()) return { text: 'no data', cls: 'warn' };
    return contactLost() ? { text: 'not refreshing', cls: 'warn' } : null;
  }
  return null;
}

function renderRail() {
  var rail = $('rail');
  clear(rail);
  var allowed = sectionsFor();
  SECTIONS.forEach(function (s) {
    if (allowed.indexOf(s.id) === -1) return;
    var b = el('button', null);
    b.type = 'button';
    b.dataset.sec = s.id;
    b.setAttribute('aria-current', s.id === section ? 'true' : 'false');
    b.appendChild(el('span', null, s.label));
    var sig = railSignal(s.id);
    if (sig) b.appendChild(el('span', 'sig ' + sig.cls, sig.text));
    b.addEventListener('click', function () { showSection(s.id); });
    rail.appendChild(b);
  });
}

// ---------------------------------------------------------------- the draft
//
// THREE COMMIT LEVELS (D-39), and the distinction that matters:
//   editing  - a row open in the editor. `Cancel` abandons the edit session and returns
//              the row to its LAST STAGED value.
//   staged   - saved into the draft, badged, diffed against live. `Revert` is a separate
//              control that drops the row back to LIVE.
//   saved    - one `Save configuration` in the header reaches the server.
// Collapsing Cancel and Revert loses the ability to abandon a typo without also throwing
// away a change staged ten minutes ago.

function loadDraft() {
  try {
    var raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    // A draft against an older document is not applicable: the thing it was diffed against
    // has moved. Dropping it is honest; silently merging it is not.
    if (!live || parsed.version !== live.version) return null;
    return parsed.draft;
  } catch (e) { return null; }
}
function saveDraft() {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ version: live.version, draft: draft }));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch (e) { /* private mode: the draft just does not survive a reload */ }
}
function resetDraft() { draft = JSON.parse(JSON.stringify(live)); saveDraft(); }

function stagedRowIds() {
  if (!draft || !live) return [];
  var out = [];
  var liveById = {};
  live.states.forEach(function (r) { liveById[r.id] = r; });
  draft.states.forEach(function (r) {
    var l = liveById[r.id];
    if (!l || JSON.stringify(l) !== JSON.stringify(r)) out.push(r.id);
  });
  // A deletion is one staged change, counted once. The prototype double-counted these.
  live.states.forEach(function (r) {
    if (!draft.states.some(function (d) { return d.id === r.id; })) out.push(r.id);
  });
  return out;
}

// Which SECTION a settings change belongs to, so the rail can point at it.
function sectionDirty(id) {
  if (!draft || !live) return false;
  if (id === 'admin') return JSON.stringify(draft.auth) !== JSON.stringify(live.auth);
  if (id === 'device') return JSON.stringify(draft.light) !== JSON.stringify(live.light);
  if (id === 'network') {
    return ['port', 'bind'].some(function (k) { return draft[k] !== live[k]; }) ||
      JSON.stringify(draft.shortcuts) !== JSON.stringify(live.shortcuts);
  }
  return false;
}
function settingsChanged() {
  return sectionDirty('admin') || sectionDirty('device') || sectionDirty('network');
}
function stagedCount() { return stagedRowIds().length + (settingsChanged() ? 1 : 0); }

// ---------------------------------------------------------------- contrast
//
// WCAG relative luminance. The single most valuable thing on the page: legibility across a
// room is a real constraint, and this makes it checkable the instant a colour changes
// rather than after a firmware round trip.
function srgbToLinear(c) {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  var n = parseInt(m[1], 16);
  return 0.2126 * srgbToLinear((n >> 16) & 255) + 0.7152 * srgbToLinear((n >> 8) & 255) +
         0.0722 * srgbToLinear(n & 255);
}
function contrastRatio(fg, bg) {
  var a = luminance(fg), b = luminance(bg);
  if (a === null || b === null) return null;
  var hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}
function slugify(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}
var HEX = /^#[0-9a-f]{6}$/;

// ---------------------------------------------------------------- the busy rule, drawn
//
// THE ASYMMETRY IS THE WHOLE POINT (D-32, D-82).
//
// An unrefreshed reading is handled DIFFERENTLY depending on which way being wrong would
// hurt:
//
//   calm + unrefreshed -> withhold the row's colours entirely. Painting a calm room on
//                    evidence that cannot support it is the failure this product exists to
//                    prevent.
//   busy + unrefreshed -> keep the row's own colours, and hatch them. Draining an
//                    unrefreshed ON AIR toward the page background WEAKENS a busy signal,
//                    and false OFF is worse than false ON.
//
// Two of the three design prototypes drained both directions toward grey. That is the
// intuitive move and it is wrong in the busy direction: a judge verified that the drained
// treatment reads calm from across the desk in the light theme, which is exactly what the
// rule forbids.
//
// WHAT CHANGED UNDER D-91, AND WHAT DID NOT. The TRIGGER moved: this used to fire on the
// server's `stale` flag, which meant a calm state nobody had rewritten in ten minutes was
// drained even though the server was healthy and answering. It now fires on OUR connection.
// The asymmetric TREATMENT below is untouched and is still D-82's - that asymmetry is about
// how a withheld claim should look, not about when to withhold it, and D-92's rejection of
// asymmetric THRESHOLDS does not touch it.
function treatment(row, st) {
  if (!row || !st || gaveUp()) return { lit: false, hatch: true, eyebrow: 'NO DATA' };
  if (!contactLost()) return { lit: true, hatch: false, eyebrow: 'LAST WRITE ' + st.ageSeconds + 'S AGO' };
  if (row.busy) return { lit: true, hatch: true, eyebrow: 'NOT REFRESHED FOR ' + lostFor() + 'S' };
  return { lit: false, hatch: true, eyebrow: 'NOT REFRESHED FOR ' + lostFor() + 'S - COLOURS WITHHELD' };
}

function rowFor(id) {
  return (live ? live.states : []).filter(function (r) { return r.id === id; })[0] || null;
}

/** Milliseconds since the server last answered. Infinity before it ever has. */
function sinceContact() {
  return lastContactAt === 0 ? Infinity : Date.now() - lastContactAt;
}
/** Condition 2: held, but visibly not being refreshed. */
function contactLost() {
  return sinceContact() > CONNECTION_LOST_MS;
}
/** Condition 3: we no longer claim to know the state. */
function gaveUp() {
  return sinceContact() > NO_DATA_MS;
}
function lostFor() {
  return Math.floor(sinceContact() / 1000);
}

// ---------------------------------------------------------------- the command surface

function renderTally() {
  if (!liveStatus) return;
  var row = rowFor(liveStatus.state);
  var t = treatment(row, liveStatus);
  var card = $('tally');

  card.className = 'tally' + (t.lit ? ' lit' : ' withheld') + (t.hatch ? ' hatched' : '');
  if (t.lit && row) {
    card.style.background = row.bgcolor;
    card.style.color = row.color;
    card.style.borderColor = row.bgcolor;
  } else {
    card.style.background = '';
    card.style.color = '';
    card.style.borderColor = '';
  }

  $('tally-eyebrow').textContent = t.eyebrow;
  $('tally-word').textContent = row ? row.label : liveStatus.state.toUpperCase();

  var marks = $('tally-marks');
  clear(marks);
  marks.appendChild(el('span', 'mark', 'light asked for ' + liveStatus.intended));
  if (liveStatus.confirmed !== liveStatus.state) {
    marks.appendChild(el('span', 'mark', 'light says ' + liveStatus.confirmed));
  }

  // The caution band sits BETWEEN the tally and the chips, so the sentence saying the
  // reading may already be wrong physically touches the control that fixes it.
  var caution = $('caution');
  if (contactLost()) {
    caution.textContent = 'No answer from the service for ' + lostFor() +
      's. This is the last state it reported, not a current reading.';
    caution.hidden = false;
  } else {
    caution.hidden = true;
  }

  $('table-ver').textContent = 'table v' + liveStatus.tableVersion;
}

// THE CHIPS ARE BUILT ONCE AND ONLY MARKED ON A POLL (#54).
//
// renderStatus() used to clear #status-controls and rebuild every button on every 5s tick.
// A mousedown landing just before a tick hit a node detached before the click, so the
// handler never ran and the page did nothing - silently. That is the same defect the
// comment in refreshStatus() describes for the rows, on the control that gets clicked most.
//
// They are also built from LIVE, never from the draft: a staged rename must not put an
// unsaved word on the buttons that command the server.
var chipNodes = {};
var builtForVersion = null;

function buildChips() {
  var box = $('chips');
  clear(box);
  chipNodes = {};
  (live ? live.states : []).slice()
    .sort(function (a, b) { return a.order - b.order || a.id.localeCompare(b.id); })
    .forEach(function (r) {
      var wrap = el('div');
      var b = el('button', 'chip');
      b.type = 'button';
      b.dataset.id = r.id;
      b.style.background = r.bgcolor;
      b.style.color = r.color;
      b.appendChild(el('span', null, r.label));
      var mark = el('span', 'chip-mark');
      mark.hidden = true;
      b.appendChild(mark);
      b.addEventListener('click', function () {
        api('/state/' + encodeURIComponent(r.id) + '?source=human:admin', { method: 'POST' })
          .then(refreshStatus);
      });
      wrap.appendChild(b);
      wrap.appendChild(el('div', 'chip-id', r.id));
      chipNodes[r.id] = { button: b, mark: mark };
      box.appendChild(wrap);
    });
  builtForVersion = live ? live.version : null;
}

function markChips() {
  if (!liveStatus) return;
  Object.keys(chipNodes).forEach(function (id) {
    var n = chipNodes[id];
    var isLive = id === liveStatus.state;
    n.button.className = 'chip' + (isLive ? ' on' : '');
    // A chip only claims to be live when we are still hearing from the server. Once we are
    // not, it says what it actually knows: this is the last thing we were told, and nobody
    // has confirmed it since.
    if (isLive && contactLost()) {
      n.mark.textContent = 'last known';
      n.mark.hidden = false;
    } else if (isLive) {
      n.mark.textContent = 'live';
      n.mark.hidden = false;
    } else {
      n.mark.hidden = true;
    }
  });
}

// ---------------------------------------------------------------- rendering

function renderCommit() {
  var n = stagedCount();
  $('commit').hidden = n === 0;
  $('staged-count').textContent = n === 0 ? '' : n + ' staged';
  $('discard-all').disabled = n === 0;
  $('save-all').disabled = n === 0;
  // Name WHERE, so the count never refers to something no section is showing.
  var where = [];
  var rows = stagedRowIds().length;
  if (rows) where.push(rows + ' in States');
  ['admin', 'network', 'device'].forEach(function (id) {
    if (sectionDirty(id)) {
      where.push('1 in ' + SECTIONS.filter(function (s) { return s.id === id; })[0].label);
    }
  });
  $('staged-where').textContent = where.join(' · ');
}

function renderStatus() {
  var dl = $('status-facts');
  clear(dl);
  if (!liveStatus) return;
  var facts = [
    ['State', liveStatus.state, false],
    ['Busy', liveStatus.busy ? 'yes' : 'no', false],
    ['Confirmed by the light', liveStatus.confirmed, liveStatus.confirmed !== liveStatus.state],
    ['Written by', liveStatus.source, false],
    ['Last write', liveStatus.ageSeconds + 's ago', false],
    ['Service contact', contactLost() ? lostFor() + 's ago - not refreshing' : 'current', contactLost()],
    ['Light output (intended)', liveStatus.intended, false],
    ['Table version', String(liveStatus.tableVersion), false]
  ];
  if (liveStatus.stateResolvedFrom) facts.push(['Fell back from', liveStatus.stateResolvedFrom, true]);
  facts.forEach(function (f) {
    dl.appendChild(el('dt', null, f[0]));
    dl.appendChild(el('dd', f[2] ? 'warn' : null, f[1]));
  });
}

function rowNode(row, isNew) {
  var node = el('div', 'row');
  var stagedIds = stagedRowIds();
  var liveRow = live.states.filter(function (r) { return r.id === row.id; })[0];
  if (stagedIds.indexOf(row.id) !== -1) node.className += ' staged';

  var head = el('div', 'row-head');
  var swatch = el('div', 'swatch', row.label);
  swatch.style.background = row.bgcolor;
  swatch.style.color = row.color;
  head.appendChild(swatch);

  var meta = el('div', 'row-meta');
  var idLine = el('div', 'row-id');
  // The id is visible, monospace and VISIBLY LOCKED. Making the immutability visible is
  // what stops someone expecting a rename to rebind their Companion buttons.
  idLine.appendChild(el('span', null, row.id));
  idLine.appendChild(el('span', 'lock', ' \u{1F512}'));
  meta.appendChild(idLine);

  var line = el('div');
  var ratio = contrastRatio(row.color, row.bgcolor);
  var c = el('span', 'contrast ' + (ratio !== null && ratio >= 4.5 ? 'pass' : 'fail'),
             ratio === null ? 'contrast ?' : ratio.toFixed(2) + ':1 ' + (ratio >= 4.5 ? 'AA' : 'fails AA'));
  line.appendChild(c);
  if (row.busy) { line.appendChild(document.createTextNode(' ')); line.appendChild(el('span', 'badge busy', 'BUSY')); }
  if (liveRow && liveStatus && liveStatus.state === row.id) {
    line.appendChild(document.createTextNode(' '));
    line.appendChild(el('span', 'badge live', contactLost() ? 'LAST KNOWN' : 'LIVE'));
  }
  if (stagedIds.indexOf(row.id) !== -1) {
    line.appendChild(document.createTextNode(' '));
    line.appendChild(el('span', 'badge staged', isNew ? 'NEW' : 'STAGED'));
  }
  meta.appendChild(line);
  head.appendChild(meta);

  var actions = el('div', 'row-actions');
  var edit = el('button', 'btn small', editing[row.id] ? 'Editing' : 'Edit');
  edit.disabled = !!editing[row.id];
  edit.addEventListener('click', function () {
    editing[row.id] = JSON.parse(JSON.stringify(row));
    renderRows();
  });
  actions.appendChild(edit);
  if (stagedIds.indexOf(row.id) !== -1) {
    var revert = el('button', 'btn small', 'Revert');
    revert.addEventListener('click', function () {
      delete editing[row.id];
      if (liveRow) {
        draft.states = draft.states.map(function (r) { return r.id === row.id ? JSON.parse(JSON.stringify(liveRow)) : r; });
      } else {
        draft.states = draft.states.filter(function (r) { return r.id !== row.id; });
      }
      saveDraft(); renderRows(); renderCommit(); renderRail();
    });
    actions.appendChild(revert);
  }
  if (row.id !== 'unknown') {
    var del = el('button', 'btn small danger-btn', 'Delete');
    del.addEventListener('click', function () { confirmDelete(row); });
    actions.appendChild(del);
  }
  head.appendChild(actions);
  node.appendChild(head);

  if (ratio !== null && ratio < 4.5) {
    node.appendChild(el('div', 'row-warn', 'This pair is hard to read across a room.'));
  }
  if (editing[row.id]) node.appendChild(editorNode(row, isNew));
  return node;
}

function editorNode(row, isNew) {
  var work = editing[row.id];
  var box = el('div', 'row-edit');
  var grid = el('div', 'edit-grid');

  function field(label, key, type, hint) {
    var f = el('div', 'field');
    f.appendChild(el('label', null, label));
    var input = el('input');
    input.type = type || 'text';
    input.value = work[key];
    input.addEventListener('input', function () {
      work[key] = input.type === 'number' ? Number(input.value) : input.value;
      // A new row's id auto-slugs from the label as it is typed, and freezes on stage.
      if (key === 'label' && isNew) work.id = slugify(input.value);
      liveSwatch();
    });
    f.appendChild(input);
    if (hint) f.appendChild(el('div', 'nag', hint));
    var bad = el('div', 'bad');
    bad.dataset.for = key;
    f.appendChild(bad);
    return f;
  }

  grid.appendChild(field('Label', 'label'));
  grid.appendChild(field('Text colour', 'color'));
  grid.appendChild(field('Background', 'bgcolor'));
  grid.appendChild(field('Order', 'order', 'number'));
  var busyField = el('div', 'field');
  busyField.appendChild(el('label', null, 'Meaning'));
  var sel = el('select');
  [['true', 'Busy - the camera may be live'], ['false', 'Calm']].forEach(function (o) {
    var opt = el('option', null, o[1]); opt.value = o[0];
    if (String(work.busy) === o[0]) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', function () { work.busy = sel.value === 'true'; });
  busyField.appendChild(sel);
  grid.appendChild(busyField);
  var descField = el('div', 'field');
  descField.appendChild(el('label', null, 'Description'));
  var desc = el('input'); desc.value = work.description;
  desc.addEventListener('input', function () { work.description = desc.value; });
  descField.appendChild(desc);
  grid.appendChild(descField);
  box.appendChild(grid);

  var mock = el('div', 'panel-mock', 'On the panel');
  var glass = el('div', 'glass');
  mock.appendChild(glass);
  box.appendChild(mock);
  function liveSwatch() {
    glass.textContent = work.label;
    glass.style.background = HEX.test(work.bgcolor) ? work.bgcolor : 'transparent';
    glass.style.color = HEX.test(work.color) ? work.color : 'inherit';
  }
  liveSwatch();

  var actions = el('div', 'edit-actions');
  var err = el('span', 'err');
  var save = el('button', 'btn primary small', 'Save row');
  save.addEventListener('click', function () {
    var problems = validateRow(work, isNew);
    if (problems.length) { err.textContent = problems.join('; '); return; }
    var frozen = JSON.parse(JSON.stringify(work));
    var exists = draft.states.some(function (r) { return r.id === row.id; });
    if (exists) draft.states = draft.states.map(function (r) { return r.id === row.id ? frozen : r; });
    else draft.states.push(frozen);
    if (isNew && frozen.id !== row.id) {
      draft.states = draft.states.filter(function (r) { return r.id !== row.id; });
      if (!draft.states.some(function (r) { return r.id === frozen.id; })) draft.states.push(frozen);
    }
    delete editing[row.id];
    saveDraft(); renderRows(); renderCommit(); renderRail();
  });
  var cancel = el('button', 'btn small', 'Cancel');
  cancel.addEventListener('click', function () {
    // Back to the LAST STAGED value, not to live - see the comment on the commit levels.
    delete editing[row.id];
    if (isNew) draft.states = draft.states.filter(function (r) { return r.id !== row.id; });
    saveDraft(); renderRows(); renderCommit(); renderRail();
  });
  actions.appendChild(save); actions.appendChild(cancel); actions.appendChild(err);
  box.appendChild(actions);
  return box;
}

function validateRow(row, isNew) {
  var p = [];
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(row.id)) p.push('id must be lower-case letters, digits and dashes');
  if (!row.label || row.label.length > 64) p.push('label must be 1-64 characters');
  if (!HEX.test(row.color)) p.push('text colour must be #rrggbb, lower-case');
  if (!HEX.test(row.bgcolor)) p.push('background must be #rrggbb, lower-case');
  if (!(Number.isInteger(row.order) && row.order >= 0 && row.order <= 999)) p.push('order must be 0-999');
  if (row.description && row.description.length > 200) p.push('description must be at most 200 characters');
  if (isNew && draft.states.filter(function (r) { return r.id === row.id; }).length > 1) p.push('that id is already taken');
  return p;
}

function renderRows() {
  var box = $('rows');
  clear(box);
  var liveIds = live.states.map(function (r) { return r.id; });
  var sorted = draft.states.slice().sort(function (a, b) { return a.order - b.order || a.id.localeCompare(b.id); });
  sorted.forEach(function (r) { box.appendChild(rowNode(r, liveIds.indexOf(r.id) === -1)); });
  // Rows staged for deletion still have to be visible, or the staged count names something
  // the page does not show.
  live.states.forEach(function (r) {
    if (draft.states.some(function (d) { return d.id === r.id; })) return;
    var n = rowNode(r, false);
    n.className += ' deleted staged';
    var undo = el('button', 'btn small', 'Undo delete');
    undo.addEventListener('click', function () {
      draft.states.push(JSON.parse(JSON.stringify(r)));
      saveDraft(); renderRows(); renderCommit(); renderRail();
    });
    clear(n.querySelector('.row-actions'));
    n.querySelector('.row-actions').appendChild(undo);
    box.appendChild(n);
  });
}

function confirmDelete(row) {
  var isLive = liveStatus && liveStatus.state === row.id;
  var consequences = [];
  if (isLive) consequences.push('The live state becomes "unknown", and GET /status reports it fell back from "' + row.id + '".');
  consequences.push('Anything writing "' + row.id + '" starts getting 400 - Companion buttons and the detector included.');
  openModal('Delete ' + row.id + '?', consequences, 'Stage the delete', null, function () {
    draft.states = draft.states.filter(function (r) { return r.id !== row.id; });
    delete editing[row.id];
    saveDraft(); renderRows(); renderCommit(); renderRail();
  });
}

function openModal(title, bullets, okLabel, promptLabel, onOk) {
  $('modal-title').textContent = title;
  var body = $('modal-body');
  clear(body);
  if (bullets && bullets.length) {
    var ul = el('ul');
    bullets.forEach(function (b) { ul.appendChild(el('li', null, b)); });
    body.appendChild(ul);
  }
  var input = null;
  if (promptLabel) {
    body.appendChild(el('div', 'muted', promptLabel));
    input = el('input'); input.type = 'password';
    body.appendChild(input);
  }
  var errLine = el('div', 'err');
  body.appendChild(errLine);
  $('modal-ok').textContent = okLabel;
  $('modal').hidden = false;
  if (input) input.focus();
  $('modal-ok').onclick = function () {
    var r = onOk(input ? input.value : null, errLine);
    if (r !== false) $('modal').hidden = true;
  };
  $('modal-cancel').onclick = function () { $('modal').hidden = true; };
}

// Which env var is winning over a given config key, or null. Names only - the VALUE never
// leaves the server for anything but `light.host`, which is a LAN address (D-79).
function overriddenBy(key) {
  var hit = (envInfo.overrides || []).filter(function (o) { return o.key === key; })[0];
  return hit ? hit.variable : null;
}

// A host is only turned into a link once it looks like one. The value is operator-set and
// reaches an href, so an arbitrary string must not: `javascript:` and friends never get to
// be a scheme here, because the scheme is ours and only the authority comes from config.
var HOSTISH = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;
function panelLink(box, label, host, path) {
  if (!host || !HOSTISH.test(host)) return;
  var a = el('a', 'panel-link', label);
  a.href = 'http://' + host + path;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  box.appendChild(a);
}

function renderFields() {
  function textField(box, label, get, set, opts) {
    opts = opts || {};
    var f = el('div', 'field');
    var id = 'f-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    var lab = el('label', null, label);
    lab.htmlFor = id;
    f.appendChild(lab);
    var input = el('input');
    input.id = id;
    input.type = opts.type || 'text';
    input.value = opts.override ? '' : get();
    // AN OVERRIDDEN FIELD IS NOT EDITABLE, and says who is winning (D-79). Leaving it
    // editable is what made saving a new address succeed and change nothing.
    if (opts.override) {
      input.readOnly = true;
      // A credential's effective value is deliberately not sent (D-79), so the box stays
      // empty and the note beneath it is the whole answer. A non-credential shows what is
      // actually in force - an empty box would read as "not configured", which is a
      // different and wrong claim.
      input.value = opts.overrideValue === undefined || opts.overrideValue === null
        ? '' : String(opts.overrideValue);
      if (input.value === '') input.placeholder = 'not shown';
    } else {
      input.addEventListener('input', function () {
        set(opts.type === 'number' ? Number(input.value) : input.value);
        renderCommit(); renderRail();
      });
    }
    f.appendChild(input);
    if (opts.override) {
      f.appendChild(el('div', 'nag', 'Set by ' + opts.override + ' in ~/.onair/config.env.'));
    }
    if (opts.nag) f.appendChild(el('div', 'nag', opts.nag));
    box.appendChild(f);
    return input;
  }

  var admin = $('admin-fields'); clear(admin);
  // THE PASSPHRASE STAYS READABLE AND THE ADMIN PASSWORD DOES NOT (D-81). They have
  // opposite jobs: this one is read off the page and typed into the ESP32 and Companion, so
  // masking it would add a reveal click to every client setup for no gain. The admin
  // password is typed in here and never read back, so masking costs nothing.
  textField(admin, 'Passphrase (machine clients)', function () { return draft.auth.passphrase; },
    function (v) { draft.auth.passphrase = v; saveDraft(); },
    { nag: nags.passphrase ? 'Currently set to the default.' : '' });
  textField(admin, 'Admin user', function () { return draft.auth.adminUser; },
    function (v) { draft.auth.adminUser = v; saveDraft(); });
  textField(admin, 'Admin password', function () { return draft.auth.adminPassword; },
    function (v) { draft.auth.adminPassword = v; saveDraft(); },
    { type: 'password', nag: nags.adminPassword ? 'Currently set to the default.' : '' });

  var net = $('network-fields'); clear(net);
  textField(net, 'Port', function () { return draft.port; }, function (v) { draft.port = v; saveDraft(); }, { type: 'number' });
  var bindField = el('div', 'field');
  bindField.appendChild(el('label', null, 'Bind'));
  var bindSel = el('select');
  [['all', 'All interfaces'], ['loopback', 'This machine only']].forEach(function (o) {
    var opt = el('option', null, o[1]); opt.value = o[0];
    if (draft.bind === o[0]) opt.selected = true;
    bindSel.appendChild(opt);
  });
  if (draft.bind.indexOf('iface:') === 0) {
    var opt = el('option', null, draft.bind); opt.value = draft.bind; opt.selected = true;
    bindSel.appendChild(opt);
  }
  bindSel.addEventListener('change', function () {
    draft.bind = bindSel.value; saveDraft(); renderCommit(); renderRail();
  });
  bindField.appendChild(bindSel);
  bindField.appendChild(el('div', 'nag', 'Loopback is always bound.'));
  net.appendChild(bindField);

  function shortcut(box, label, key) {
    var f = el('div', 'field');
    f.appendChild(el('label', null, label));
    var sel = el('select');
    var none = el('option', null, 'not configured - returns 409'); none.value = '';
    sel.appendChild(none);
    draft.states.forEach(function (r) {
      var o = el('option', null, r.label + ' (' + r.id + ')'); o.value = r.id;
      if (draft.shortcuts[key] === r.id) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      draft.shortcuts[key] = sel.value === '' ? null : sel.value;
      saveDraft(); renderCommit(); renderRail();
    });
    f.appendChild(sel);
    box.appendChild(f);
  }
  shortcut(net, 'POST /on sets', 'on');
  shortcut(net, 'POST /off sets', 'off');

  // "Device connection", not "Light" (D-78). The four fields are about how the server
  // REACHES the on-air light, not about the light; the glossary keeps "on-air light" for
  // the object and the JSON key stays `light`.
  var device = $('device-fields'); clear(device);
  textField(device, 'Address', function () { return draft.light.host || ''; },
    function (v) { draft.light.host = v || null; saveDraft(); },
    { override: overriddenBy('light.host'), overrideValue: envInfo.effective.host });
  textField(device, 'Entity name', function () { return draft.light.entity; },
    function (v) { draft.light.entity = v; saveDraft(); },
    { override: overriddenBy('light.entity'), overrideValue: envInfo.effective.entity });
  textField(device, 'Device user', function () { return draft.light.username || ''; },
    function (v) { draft.light.username = v || null; saveDraft(); },
    { override: overriddenBy('light.username') });
  textField(device, 'Device password', function () { return draft.light.password || ''; },
    function (v) { draft.light.password = v || null; saveDraft(); },
    { type: 'password', override: overriddenBy('light.password') });

  // THE LINKS NAME THE HOST THE SERVICE IS ACTUALLY DRIVING, not the document's. A field
  // that lies can be re-read; a link that lies gets clicked. `deploy/onair`'s cmd_ui
  // resolves the overlay first for exactly this reason (D-79, #55).
  var host = envInfo.effective.host || draft.light.host;
  if (host && HOSTISH.test(host)) {
    var links = el('div', 'links');
    panelLink(links, 'Open the panel', host, '/onair');
    panelLink(links, 'Panel settings', host, '/onair/config');
    device.appendChild(links);
  }
}

function renderAll() {
  renderCommit();
  renderTally();
  if (builtForVersion !== (live ? live.version : null)) buildChips();
  markChips();
  renderStatus();
  renderRows();
  renderFields();
  renderRail();
}

// ---------------------------------------------------------------- actions

function refreshStatus() {
  // A FAILED POLL IS INFORMATION, and it used to be discarded. `if (r.status !== 200)
  // return` meant a service that had stopped answering left the console rendering its last
  // reading with full confidence, forever - the console had no way to tell "nothing has
  // changed" from "I cannot hear the service". Recording contact is what closes that.
  return api('/status').then(function (r) {
    if (r.status !== 200) return null;
    lastContactAt = Date.now();
    return r.body;
  }, function () {
    return null; // a network failure is a lost connection, not an exception to swallow
  }).then(function (body) {
    if (body === null) { repaintLiveness(); return; }
    liveStatus = body;
    // The first call happens during boot, BEFORE showConsole() has a draft - and on the
    // landing path there is no console at all. Rendering the console from here without
    // checking throws on a page that otherwise looks like it is still connecting.
    if (!live || !draft) return;
    renderTally();
    // NEITHER THE CHIPS NOR THE ROWS ARE REBUILT ON A POLL.
    //
    // This runs every five seconds. Rebuilding a node swaps the DOM out from under whatever
    // the user is doing: typing went into an input that no longer existed a moment later,
    // and a click on a button detached between mousedown and click never ran its handler.
    // Both were completely silent - no error, no console entry, the page just did not
    // respond. It happened twice, on the rows (#50-era) and on the state buttons (#54).
    //
    // markChips() touches text and classes only. The rows depend on `draft` and `live`,
    // which a poll never changes; the only thing it CAN change is which row wears the LIVE
    // badge, so rebuild only when that moves, and never while a row is open for editing.
    markChips();
    renderStatus();
    renderRail();
    var liveChanged = lastRenderedState !== liveStatus.state;
    lastRenderedState = liveStatus.state;
    if (liveChanged && Object.keys(editing).length === 0) renderRows();
  });
}

/**
 * Redraw only the parts that speak about the connection. Runs when a poll FAILS and on its
 * own second-by-second timer, so the escalation happens on our clock rather than waiting
 * for traffic that by definition is not arriving. It touches text and classes only - never
 * rebuilding a node, for the reason refreshStatus() explains at length.
 */
function repaintLiveness() {
  if (!liveStatus || !live || !draft) return;
  renderTally();
  markChips();
  renderStatus();
  renderRail();
}

function saveAll() {
  $('save-err').hidden = true;
  return api('/admin/config', { method: 'PUT', body: JSON.stringify(draft) }).then(function (r) {
    if (r.status === 200) {
      live = r.body.config;
      resetDraft(); editing = {};
      return refreshStatus().then(renderAll);
    }
    var msg = (r.body && r.body.error) || ('save failed: ' + r.status);
    if (r.body && r.body.problems) msg += ' - ' + r.body.problems.join('; ');
    if (r.status === 409 && r.body && r.body.config) {
      live = r.body.config;
      msg += ' Your edits are still staged; reload to start from the current document.';
    }
    $('save-err').textContent = msg;
    $('save-err').hidden = false;
    renderAll();
  });
}

function factoryReset() {
  openModal('Factory reset', [
    'Credentials, the state table, the live state, the port and the bind mode all return to their defaults.',
    'The device address and its credentials are kept.',
    'Every admin session ends, including this one.'
  ], 'Reset', 'Admin password', function (password, errLine) {
    api('/admin/factory-reset', { method: 'POST', body: JSON.stringify({ password: password }) }).then(function (r) {
      if (r.status !== 200) { errLine.textContent = (r.body && r.body.error) || ('failed: ' + r.status); return; }
      sessionStorage.removeItem(DRAFT_KEY);
      location.reload();
    });
    return false; // the modal closes itself on success, via the reload
  });
}

// ---------------------------------------------------------------- boot

function showConsole() {
  $('boot').hidden = true;
  $('landing').hidden = true;
  $('console').hidden = false;
  var restored = loadDraft();
  draft = restored || JSON.parse(JSON.stringify(live));
  bootPreferences();
  renderAll();
  showSection(section);
  setInterval(refreshStatus, 5000);
  // The thresholds are ours, so they are checked on our clock. A poll every 5s would put
  // the mark up to 5s late and, worse, would stop escalating entirely if the poll itself
  // wedged rather than failed.
  setInterval(repaintLiveness, 1000);
}

function showLanding(publicStatus) {
  $('boot').hidden = true;
  $('console').hidden = true;
  $('landing').hidden = false;
  var card = $('landing-card');
  card.style.background = publicStatus.bgcolor;
  card.style.color = publicStatus.color;
  $('landing-word').textContent = publicStatus.label;
  $('landing-desc').textContent = publicStatus.message || '';
  var dl = $('landing-facts');
  clear(dl);
  [['Service', 'running'], ['Currently sending', publicStatus.state],
   ['Last write', publicStatus.ageSeconds + 's ago']
  ].forEach(function (f) {
    dl.appendChild(el('dt', null, f[0]));
    dl.appendChild(el('dd', null, f[1]));
  });
}

function establish() {
  // No body: the D-24 waiver applies at the Mac and this returns a session with no prompt,
  // which is what pays for holding the token in memory instead of a cookie.
  return api('/admin/session', { method: 'POST' }).then(function (r) {
    if (r.status !== 200) return false;
    session = r.body.token;
    nags = r.body.nags || {};
    return true;
  });
}

function start() {
  establish().then(function (ok) {
    if (!ok) {
      return api('/public/status').then(function (r) {
        showLanding(r.body || { label: 'NO DATA', color: '#ff00ff', bgcolor: '#1a1a1a', state: 'unknown', ageSeconds: 0 });
      });
    }
    return api('/admin/config').then(function (r) {
      live = r.body.config;
      envInfo = r.body.env || envInfo;
      return refreshStatus().then(showConsole);
    });
  });
}

$('login-open').addEventListener('click', function () {
  $('login').hidden = false;
  $('login-open').hidden = true;
  $('login-user').focus();
});
$('login').addEventListener('submit', function (e) {
  e.preventDefault();
  api('/admin/session', {
    method: 'POST',
    body: JSON.stringify({ user: $('login-user').value, password: $('login-pass').value })
  }).then(function (r) {
    if (r.status !== 200) { $('login-err').textContent = 'that did not work'; return; }
    session = r.body.token;
    nags = r.body.nags || {};
    api('/admin/config').then(function (c) {
      live = c.body.config;
      envInfo = c.body.env || envInfo;
      refreshStatus().then(showConsole);
    });
  });
});
$('logout').addEventListener('click', function () {
  api('/admin/session', { method: 'DELETE' }).then(function () { session = null; location.reload(); });
});
$('save-all').addEventListener('click', saveAll);
$('discard-all').addEventListener('click', function () { editing = {}; resetDraft(); renderAll(); });
$('add-row').addEventListener('click', function () {
  var id = 'new-state';
  var n = 1;
  while (draft.states.some(function (r) { return r.id === id; })) { id = 'new-state-' + (++n); }
  var row = { id: id, label: '', color: '#ffffff', bgcolor: '#333333', description: '', busy: true,
              order: draft.states.length };
  draft.states.push(row);
  editing[id] = JSON.parse(JSON.stringify(row));
  saveDraft(); renderRows(); renderCommit(); renderRail();
});
$('factory-reset').addEventListener('click', factoryReset);

$('view-simple').addEventListener('click', function () { setView('simple'); });
$('view-advanced').addEventListener('click', function () { setView('advanced'); });
$('admin-view').addEventListener('change', function () { setView($('admin-view').value); });
$('theme').addEventListener('click', function () {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

window.addEventListener('beforeunload', function (e) {
  if (stagedCount() > 0) { e.preventDefault(); e.returnValue = ''; }
});

start();
