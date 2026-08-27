'use strict';
// The admin console. Vanilla, no framework, no imports - the shell is served
// unauthenticated (D-35) and every value it shows arrives from a gated route.
//
// NO RATIONALE IN THE UI. The prototype argued for its own design decisions in hint text
// because it was a design artifact; Rocket's note on it was that there was a lot of extra
// information and some of it was not clearly relevant. A hint survives here only where it
// changes what someone types. The reasoning lives in these comments and in CONTEXT.md.

var DRAFT_KEY = 'onair.draft.v1';

var session = null;      // the admin bearer token, in MEMORY only - never a cookie (D-35)
var live = null;         // the config document as the server has it
var draft = null;        // staged edits, keyed the same shape as `live`
var editing = {};        // id -> the in-progress edit for one row, not yet staged
// NOT `status`. At top level in a classic script `var status` binds window.status, a
// legacy STRING property - so `status = someObject` silently stores "[object Object]",
// which is truthy and has no fields. It renders as a blank page with one exception in the
// console and nothing else. Found in a browser; no test would have.
var liveStatus = null;       // the gated /status readout
var lastRenderedState = null; // which row last wore the LIVE badge - see refreshStatus()
var nags = {};

var $ = function (id) { return document.getElementById(id); };
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

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
function settingsChanged() {
  if (!draft || !live) return false;
  return ['port', 'bind'].some(function (k) { return draft[k] !== live[k]; }) ||
    JSON.stringify(draft.auth) !== JSON.stringify(live.auth) ||
    JSON.stringify(draft.light) !== JSON.stringify(live.light) ||
    JSON.stringify(draft.shortcuts) !== JSON.stringify(live.shortcuts);
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

// ---------------------------------------------------------------- rendering

function renderBar() {
  var n = stagedCount();
  $('staged-count').textContent = n === 0 ? '' : n + (n === 1 ? ' staged' : ' staged');
  $('discard-all').disabled = n === 0;
  $('save-all').disabled = n === 0;
  if (liveStatus && live) {
    var pill = $('live-pill');
    pill.textContent = liveStatus.state.toUpperCase();
    var row = (live ? live.states : []).filter(function (r) { return r.id === liveStatus.state; })[0];
    pill.style.background = row ? row.bgcolor : 'transparent';
    pill.style.color = row ? row.color : 'inherit';
    pill.style.borderColor = row ? row.bgcolor : '';
    $('live-age').textContent = liveStatus.stale ? liveStatus.ageSeconds + 's - stale' : liveStatus.ageSeconds + 's';
  }
}

// THE STATE BUTTONS ARE NOT REBUILT ON A POLL EITHER.
//
// The same defect the comment in refreshStatus() describes, on the other control - and the
// guard that fixed it there covered renderRows() only. renderStatus() ran on every 5s tick
// and cleared #status-controls, so every state button was destroyed and re-created, listener
// and all. A mousedown landing just before a tick hit a node detached before the click, the
// handler never ran, and the page did nothing: no error, no console entry. These are the
// MOST-CLICKED controls on the page. The fix landed on the rare job and left the frequent
// one exposed for six weeks (#54).
//
// Split, therefore: buildStateControls() creates nodes and attaches listeners, and runs only
// when the table it is built from actually changes. markStateControls() runs on every tick
// and touches textContent and className only - never a node.
var stateButtons = {};      // row id -> its button node
var pinButton = null;
var builtForVersion = null; // the table version the buttons above were built from

function buildStateControls() {
  var box = $('status-controls');
  clear(box);
  stateButtons = {};
  (live ? live.states : []).forEach(function (r) {
    var b = el('button', 'btn small', r.label);
    b.addEventListener('click', function () {
      api('/state/' + encodeURIComponent(r.id) + '?source=human:admin', { method: 'POST' }).then(refreshStatus);
    });
    stateButtons[r.id] = b;
    box.appendChild(b);
  });
  // Everything the pin needs is read AT CLICK TIME. Capturing `pinned` at build time was
  // harmless when the node was rebuilt every five seconds and is a bug the moment it is not.
  pinButton = el('button', 'btn small', '');
  pinButton.addEventListener('click', function () {
    if (!liveStatus) return;
    var pinned = liveStatus.hold !== null;
    api('/state/' + encodeURIComponent(liveStatus.state) + '?source=human:admin&hold=' + (pinned ? '0' : '1'),
        { method: 'POST' }).then(refreshStatus);
  });
  box.appendChild(pinButton);
  builtForVersion = live ? live.version : null;
}

function markStateControls() {
  if (!pinButton || !liveStatus) return;
  pinButton.textContent = liveStatus.hold === null ? 'Pin current state' : 'Release pin';
  Object.keys(stateButtons).forEach(function (id) {
    stateButtons[id].className = 'btn small' + (id === liveStatus.state ? ' on' : '');
  });
}

function renderStatus() {
  var dl = $('status-facts');
  clear(dl);
  if (!liveStatus) return;
  var facts = [
    ['State', liveStatus.state],
    ['Busy', liveStatus.busy ? 'yes' : 'no'],
    ['Confirmed by the light', liveStatus.confirmed],
    ['Written by', liveStatus.source],
    ['Last write', liveStatus.ageSeconds + 's ago' + (liveStatus.stale ? ' (stale)' : '')],
    ['Pinned at', liveStatus.hold === null ? 'auto' : liveStatus.hold],
    ['Table version', String(liveStatus.tableVersion)]
  ];
  if (liveStatus.stateResolvedFrom) facts.push(['Fell back from', liveStatus.stateResolvedFrom]);
  facts.forEach(function (f) {
    dl.appendChild(el('dt', null, f[0]));
    dl.appendChild(el('dd', null, f[1]));
  });

  // The buttons are built from the TABLE, which a poll never changes. Rebuild only when the
  // table itself has moved - a save, or the first render.
  if (builtForVersion !== (live ? live.version : null)) buildStateControls();
  markStateControls();
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
    line.appendChild(el('span', 'badge live', 'LIVE'));
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
      saveDraft(); renderRows(); renderBar();
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
    saveDraft(); renderRows(); renderBar();
  });
  var cancel = el('button', 'btn small', 'Cancel');
  cancel.addEventListener('click', function () {
    // Back to the LAST STAGED value, not to live - see the comment on the commit levels.
    delete editing[row.id];
    if (isNew) draft.states = draft.states.filter(function (r) { return r.id !== row.id; });
    saveDraft(); renderRows(); renderBar();
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
      saveDraft(); renderRows(); renderBar();
    });
    clear(n.querySelector('.row-actions'));
    n.querySelector('.row-actions').appendChild(undo);
    box.appendChild(n);
  });
}

function confirmDelete(row) {
  var isLive = liveStatus && liveStatus.state === row.id;
  var isPinned = liveStatus && liveStatus.hold === row.id;
  var consequences = [];
  if (isLive) consequences.push('The live state becomes "unknown", and GET /status reports it fell back from "' + row.id + '".');
  if (isPinned) consequences.push('The pin is released.');
  consequences.push('Anything writing "' + row.id + '" starts getting 400 - Companion buttons and the detector included.');
  openModal('Delete ' + row.id + '?', consequences, 'Stage the delete', null, function () {
    draft.states = draft.states.filter(function (r) { return r.id !== row.id; });
    delete editing[row.id];
    saveDraft(); renderRows(); renderBar();
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

function renderFields() {
  function textField(box, label, get, set, opts) {
    opts = opts || {};
    var f = el('div', 'field');
    f.appendChild(el('label', null, label));
    var input = el('input');
    input.type = opts.type || 'text';
    input.value = get();
    input.addEventListener('input', function () { set(opts.type === 'number' ? Number(input.value) : input.value); renderBar(); });
    f.appendChild(input);
    if (opts.nag) f.appendChild(el('div', 'nag', opts.nag));
    box.appendChild(f);
  }

  var admin = $('admin-fields'); clear(admin);
  // Shown in plaintext, deliberately: it has to be read to be typed into the ESP32 and
  // Companion, and a reveal control would only add a click to that.
  textField(admin, 'Passphrase (machine clients)', function () { return draft.auth.passphrase; },
    function (v) { draft.auth.passphrase = v; saveDraft(); },
    { nag: nags.passphrase ? 'Still the shipped default.' : '' });
  textField(admin, 'Admin user', function () { return draft.auth.adminUser; },
    function (v) { draft.auth.adminUser = v; saveDraft(); });
  textField(admin, 'Admin password', function () { return draft.auth.adminPassword; },
    function (v) { draft.auth.adminPassword = v; saveDraft(); },
    { nag: nags.adminPassword ? 'Still the shipped default.' : '' });

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
  bindSel.addEventListener('change', function () { draft.bind = bindSel.value; saveDraft(); renderBar(); });
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
      saveDraft(); renderBar();
    });
    f.appendChild(sel);
    box.appendChild(f);
  }
  shortcut(net, 'POST /on sets', 'on');
  shortcut(net, 'POST /off sets', 'off');

  var light = $('light-fields'); clear(light);
  textField(light, 'Device host', function () { return draft.light.host || ''; },
    function (v) { draft.light.host = v || null; saveDraft(); });
  textField(light, 'Entity name', function () { return draft.light.entity; },
    function (v) { draft.light.entity = v; saveDraft(); });
  textField(light, 'Device user', function () { return draft.light.username || ''; },
    function (v) { draft.light.username = v || null; saveDraft(); });
  textField(light, 'Device password', function () { return draft.light.password || ''; },
    function (v) { draft.light.password = v || null; saveDraft(); });
}

function renderAll() { renderBar(); renderStatus(); renderRows(); renderFields(); }

// ---------------------------------------------------------------- actions

function refreshStatus() {
  return api('/status').then(function (r) {
    if (r.status !== 200) return;
    liveStatus = r.body;
    // The first call happens during boot, BEFORE showConsole() has a draft - and on the
    // landing path there is no console at all. Rendering the console from here without
    // checking throws on a page that otherwise looks like it is still connecting.
    if (!live || !draft) return;
    renderBar();
    renderStatus();
    // ROWS ARE NOT REBUILT ON A POLL.
    //
    // This runs every five seconds and renderRows() replaces every row node. That is not
    // merely wasteful: it swaps the DOM out from under whatever the user is doing. Typing
    // went into an input that no longer existed a moment later, and a click on Edit landed
    // on a button that had been detached between mousedown and click - so the handler
    // never ran and the page just sat there. Both were silent.
    //
    // The rows depend on `draft` and `live`, which a poll never changes. The only thing it
    // CAN change is which row wears the LIVE badge, so rebuild only when that moves, and
    // never while a row is open for editing.
    var liveChanged = lastRenderedState !== liveStatus.state;
    lastRenderedState = liveStatus.state;
    if (liveChanged && Object.keys(editing).length === 0) renderRows();
  });
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
    'Credentials, the state table, the pin, the live state, the port and the bind mode all return to their defaults.',
    'The device host and its credentials are kept.',
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
  renderAll();
  setInterval(refreshStatus, 5000);
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
   ['Last write', publicStatus.ageSeconds + 's ago' + (publicStatus.stale ? ' (stale)' : '')]
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
  saveDraft(); renderRows(); renderBar();
});
$('factory-reset').addEventListener('click', factoryReset);

window.addEventListener('beforeunload', function (e) {
  if (stagedCount() > 0) { e.preventDefault(); e.returnValue = ''; }
});

Array.prototype.forEach.call(document.querySelectorAll('.rail a'), function (a) {
  a.addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll('.rail a'), function (x) { x.classList.remove('on'); });
    a.classList.add('on');
  });
});

start();
