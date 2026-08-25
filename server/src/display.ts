// Self-contained tally page. No external resources - it must render on a kiosk with no
// network beyond the API host. Served by GET /display, unauthenticated (D-25).
//
// REBUILT AGAINST THE STATE TABLE (D-42, D-48). It no longer holds a vocabulary: there are
// no hardcoded appearances and no list of known states. The server resolves the current row
// and sends the label and the two colours already worked out, on `GET /public/events` -
// which is unauthenticated precisely because this page is, and therefore cannot read the
// gated stream.
//
// ZERO `${}` INTERPOLATION, deliberately (D-25): the page is byte-identical for every
// caller and discloses nothing on its own. Everything it shows arrives at runtime.
export const DISPLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>On Air</title>
<style>
  :root { --bg: #1a1a1a; --fg: #ff00ff; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; overflow: hidden; user-select: none; -webkit-user-select: none;
    transition: background-color 220ms ease, color 220ms ease;
  }
  #word { font-weight: 800; letter-spacing: 0.01em; line-height: 1; padding: 0 3vw; }
  #sub {
    margin-top: 3vh; font-size: 4vw; font-weight: 500; line-height: 1.2;
    max-width: 84vw; opacity: 0.85; overflow-wrap: anywhere;
  }

  /* The badges sit in the corners so they can never displace or cover the state word. */
  #stale, #held {
    position: fixed; top: 2vh; font-size: 2.4vw; font-weight: 700; letter-spacing: 0.12em;
    padding: 0.6vh 1.4vw; border: 0.25vh solid currentColor; border-radius: 0.6vh;
    display: none;
  }
  #stale { right: 2vw; }
  body.stale #stale { display: block; }

  /* A hatched wash, so STALE is legible across a room without changing the state colour -
     the colour is the state and nothing else is allowed to speak with it. */
  body.stale::after {
    content: ""; position: fixed; inset: 0; pointer-events: none; opacity: 0.16;
    background: repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 14px);
  }

  #overlay {
    position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.82); color: #fff; font-size: 6vw; font-weight: 800;
    letter-spacing: 0.08em;
  }
  body.disconnected #overlay { display: flex; }
</style>
</head>
<body>
  <div id="word"></div>
  <div id="sub"></div>
  <div id="stale">STALE</div>
  <div id="overlay">DISCONNECTED</div>
  <script>
    // If the stream says nothing at all for this long, assume the connection is dead rather
    // than that the world stopped changing. An SSE connection can sit open and silent.
    var WATCHDOG_SILENT_MS = 45000;
    // Extends the server's own 'stale' forward between events. The server is the authority
    // on the threshold; this only ages the last value we were given.
    var STALE_AFTER_SECONDS = 90;

    var word = document.getElementById('word');
    var sub = document.getElementById('sub');
    var last = null;
    var lastAt = 0;
    var es;

    // The reserved row's look is the fallback for "we have nothing" - never blank, and
    // never calm. It is replaced by the server's own 'unknown' row the moment one arrives.
    function unknownLook() {
      return { label: 'NO DATA', color: '#ff00ff', bgcolor: '#1a1a1a', message: null, stale: false };
    }

    function effectiveAgeSeconds() {
      if (last === null) return Infinity;
      return last.ageSeconds + (Date.now() - lastAt) / 1000;
    }

    function refreshStale() {
      var stale = last !== null && (last.stale === true || effectiveAgeSeconds() > STALE_AFTER_SECONDS);
      document.body.classList.toggle('stale', stale);
    }

    function render(s) {
      // No vocabulary here: whatever row the server resolved is what gets drawn, including
      // one invented this morning. A page that only knew four appearances could not do that
      // and would have to drop the state - and a state that degrades to nothing looks
      // exactly like a calm one.
      var label = typeof s.label === 'string' && s.label !== '' ? s.label : String(s.state || '').toUpperCase();
      if (label === '') label = 'NO DATA';
      document.documentElement.style.setProperty('--bg', s.bgcolor || '#1a1a1a');
      document.documentElement.style.setProperty('--fg', s.color || '#ff00ff');

      word.textContent = label;
      // Long labels shrink rather than wrap or overflow - a thirteen-character label has to
      // fit the same glass as a six-character one. Naming an example here would put a row
      // name back into a page whose whole point is that it holds none.
      var size = label.length > 16 ? 7 : label.length > 12 ? 9 : label.length > 8 ? 12 : 18;
      word.style.fontSize = size + 'vw';

      // D-9, unchanged: a message renders as a subordinate line UNDER the state word and
      // may never replace it or the colour.
      var msg = (s.message !== null && s.message !== undefined) ? String(s.message) : '';
      sub.textContent = msg;
      sub.style.display = msg === '' ? 'none' : 'block';

      refreshStale();
    }

    function connect() {
      if (es) { try { es.close(); } catch (e) {} }
      // Unauthenticated by design: this page is served without a credential, so it cannot
      // present one either. A ?token= left in a bookmarked URL is simply ignored.
      es = new EventSource('/public/events');
      es.onopen = function () { document.body.classList.remove('disconnected'); };
      // A NAMED event, so onmessage would never fire - onmessage only receives unnamed
      // ones. Getting this wrong is silent: the page connects, the server streams, and the
      // page sits on its opening appearance forever with nothing in the console.
      es.addEventListener('status', function (ev) {
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        document.body.classList.remove('disconnected');
        last = data;
        lastAt = Date.now();
        render(data);
      });
      es.onerror = function () { document.body.classList.add('disconnected'); };
    }

    // Ship as the unknown appearance rather than asserting anything before data arrives.
    render(unknownLook());
    connect();

    setInterval(refreshStale, 5000);
    setInterval(function () {
      if (lastAt !== 0 && Date.now() - lastAt > WATCHDOG_SILENT_MS) {
        document.body.classList.add('disconnected');
        connect();
      }
    }, 10000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) connect();
    });
  </script>
</body>
</html>
`;
