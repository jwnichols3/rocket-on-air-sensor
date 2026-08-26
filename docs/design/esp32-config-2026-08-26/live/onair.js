// The on-air panel's config page (#50, D-69, D-71). Served from flash, gzipped, cached.
//
// EVERYTHING HERE IS AN ENHANCEMENT. The page is fully server-rendered and every control is
// an ordinary form submit, so with scripting off you lose live preview and lose nothing
// else. That is deliberate: a page that LOOKS functional and is inert is worse than one
// that is visibly plainer.
//
// The whole file exists to do three things: mirror a colour picker into the text input that
// actually posts, keep the glass and the luminance readout in step with what you are
// typing, and mark a card dirty. Nothing here talks to the device.

(function () {
  'use strict';

  // The firmware's own luminance, integer and truncating (onair_table.h:291). Rec.601.
  // If this and the C++ ever disagree, the page lies about which SHAPE the glass will draw,
  // which is the one thing this page must never do. Keep them identical.
  function lum(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return Math.floor((299 * r + 587 * g + 114 * b) / 1000);
  }

  function isHex(v) { return /^#[0-9a-fA-F]{6}$/.test(v); }

  var ed = document.querySelector('.ed');
  if (!ed) return;                       // no row open: nothing to enhance.

  var glass = ed.querySelector('.g');
  var busy = ed.dataset.busy === '1';
  var serverBg = ed.dataset.sbg || '#000000';
  var isUnknown = ed.dataset.id === 'unknown';

  // Reads the effective value of a field: what is typed, or the server's if blank.
  function eff(name) {
    var i = ed.querySelector('input[name=' + name + ']');
    if (!i) return '';
    var v = i.value.trim();
    return v ? v : i.placeholder;
  }

  function redraw() {
    if (!glass) return;
    var label = eff('label');
    var bg = eff('bgcolor');

    // SHAPE, by the firmware's own rules and in the firmware's own order.
    // `unknown` short-circuits to NO_DATA on the KEY, BEFORE the busy test
    // (onair_table.h:600). Getting this order wrong is what made three of the four
    // prototypes draw a picture the glass will never produce.
    var shape;
    if (isUnknown) shape = 3;
    else if (busy) shape = 0;
    else shape = (isHex(bg) && lum(bg) >= 128) ? 1 : 2;

    glass.dataset.shape = String(shape);
    var b = glass.querySelector('b');
    if (b) {
      // NO DATA draws its own word; the row's label never reaches that glass.
      b.textContent = shape === 3 ? 'NO DATA' : label;
      // label_font() applies on BUSY and CALM HEAVY only. The CSS handles CALM LIGHT's
      // unconditional 11px on its own; this class is only ever consulted there.
      b.className = label.length <= 8 ? 'lg' : '';
    }

    // The luminance track and its caption.
    var track = ed.querySelector('.lum .mark');
    var cap = ed.querySelector('.lum .cap');
    if (track && cap) {
      if (!isHex(bg)) {
        cap.textContent = 'not a valid #rrggbb - nothing will be saved';
        return;
      }
      var L = lum(bg);
      track.style.left = (L / 255 * 100).toFixed(1) + '%';
      // textContent throughout. L is an integer from a hex-validated parse and could not be
      // injected, but a page whose whole job is being trustworthy should not have an
      // innerHTML in it for a reviewer to have to reason about.
      cap.textContent = '';
      cap.appendChild(document.createTextNode('background luminance '));
      var strong = document.createElement('b');
      strong.textContent = String(L);
      cap.appendChild(strong);
      cap.appendChild(document.createTextNode(
        (busy || isUnknown)
          ? ' - not consulted on this row'
          : ' - the line is 128, so this draws the ' +
            (L >= 128 ? 'heavy double frame' : 'open ring')));
    }

    // The shape-flip warning, against the SERVER's own background.
    var flip = ed.querySelector('.flip');
    if (flip && !busy && !isUnknown && isHex(bg) && isHex(serverBg)) {
      var was = lum(serverBg) >= 128, now = lum(bg) >= 128;
      flip.hidden = (was === now);
      if (!flip.hidden) {
        flip.textContent = 'This crosses the 128 line: the picture changes from ' +
          (was ? 'CALM HEAVY to CALM LIGHT' : 'CALM LIGHT to CALM HEAVY') + '.';
      }
    }
  }

  ed.addEventListener('input', function (e) {
    var t = e.target;

    // THE GUARDED MIRROR. The picker is unnamed, so it can never post - but that alone is
    // not enough, and this is the third door D-68's trap comes through. The picker is
    // SEEDED with the server's value, so an unguarded mirror writes that value into the
    // posting field on any input event. Firefox fires `input` while its colour dialog
    // previews, and the operator may then cancel; macOS NSColorPanel offers no cancel at
    // all. Either way, merely LOOKING at the picker would pin the server's current value as
    // a permanent local override.
    //
    // So: writing the server's own colour means "follow the server", which is '' - the same
    // outcome as the Follow button, reached by picking instead of by pressing.
    if (t.type === 'color') {
      var field = t.parentNode.querySelector('input[name]');
      if (field) {
        var server = field.placeholder || '';
        field.value = (t.value.toLowerCase() === server.toLowerCase()) ? '' : t.value;
      }
    }
    redraw();
  });

  // The per-field Follow buttons. type=button, so they are inert without JS and the
  // row-level "Follow server" submit still does the real work.
  [].forEach.call(ed.querySelectorAll('button[data-follow]'), function (btn) {
    btn.addEventListener('click', function () {
      var field = ed.querySelector('input[name=' + btn.dataset.follow + ']');
      if (!field) return;
      field.value = '';
      var picker = field.parentNode.querySelector('input[type=color]');
      if (picker && isHex(field.placeholder)) picker.value = field.placeholder;
      redraw();
    });
  });

  redraw();
})();
