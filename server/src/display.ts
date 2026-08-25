// Self-contained tally page. No external resources - it must render on a kiosk
// with no network beyond the API host. Served by GET /display.
export const DISPLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>On Air</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #111; cursor: none; overflow: hidden;
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
    transition: background 0.2s;
  }
  #word {
    font-weight: 800; letter-spacing: 0.08em; text-align: center;
    line-height: 1.1; padding: 0 4vw; overflow-wrap: anywhere;
  }
  body.dnd { background: #b30000; }
  body.dnd #word { color: #fff; }
  body.interruptible { background: #b38600; }
  body.interruptible #word { color: #fff; }
  body.available { background: #111; }
  body.available #word { color: #3a3a3a; }
  /* Ship UNKNOWN, never a state. The page must not claim "not on air" during exactly
     the window when the server may be crash-looping. */
  body.unknown { background: #4a0000; }
  body.unknown #word { color: #ffb300; }
  #sub {
    position: fixed; bottom: 4vh; left: 0; right: 0; text-align: center;
    font-size: 4vw; font-weight: 600; letter-spacing: 0.05em;
    padding: 0 4vw; overflow-wrap: anywhere; display: none;
  }
  body.dnd #sub, body.interruptible #sub { color: rgba(255,255,255,0.85); }
  body.available #sub, body.unknown #sub { color: #7a7a7a; }
  #held {
    position: fixed; top: 2vh; left: 2vw; display: none;
    color: #ffb300; font-size: 3vw; font-weight: 600; letter-spacing: 0.08em;
  }
  body.held #held { display: block; }
  #overlay {
    position: fixed; inset: 0; display: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,0.85); color: #ffb300;
    font-size: 8vw; font-weight: 700; letter-spacing: 0.1em;
  }
  body.disconnected #overlay { display: flex; }
  #stale {
    position: fixed; top: 2vh; right: 2vw; display: none;
    color: #ffb300; font-size: 3vw; font-weight: 600;
  }
  body.stale #stale { display: block; }
</style>
</head>
<body class="unknown">
  <div id="word">NO DATA</div>
  <div id="sub"></div>
  <div id="held">HELD</div>
  <div id="stale">STALE</div>
  <div id="overlay">DISCONNECTED</div>
  <script>
    var STALE_AFTER_SECONDS = 300;
    var WATCHDOG_SILENT_MS = 45000;
    var token = new URLSearchParams(location.search).get('token');
    var word = document.getElementById('word');
    var sub = document.getElementById('sub');
    var LEVELS = ['available', 'interruptible', 'dnd', 'unknown'];
    var WORDS = { available: 'OFF AIR', interruptible: 'INTERRUPTIBLE', dnd: 'ON AIR', unknown: 'NO DATA' };
    var last = null;
    var lastAt = 0;
    var es;

    function connect() {
      if (es) {
        try { es.close(); } catch (e) {}
      }
      es = new EventSource('/events' + (token ? '?token=' + encodeURIComponent(token) : ''));
      es.addEventListener('status', function (e) {
        document.body.classList.remove('disconnected');
        last = JSON.parse(e.data);
        lastAt = Date.now();
        render(last);
      });
      es.onerror = function () {
        document.body.classList.add('disconnected');
      };
      lastAt = Date.now();
    }

    function effectiveAgeSeconds() {
      if (last === null) return 0;
      return last.ageSeconds + (Date.now() - lastAt) / 1000;
    }

    function refreshStale() {
      var stale = last !== null && last.source === 'detector' && effectiveAgeSeconds() > STALE_AFTER_SECONDS;
      document.body.classList.toggle('stale', stale);
    }

    function render(s) {
      // A kiosk tab under D-10 can be running week-old JS, so fall back to the derived
      // 'intended' when a stale page meets a new server, or a new page an old server.
      var level = s.level;
      if (LEVELS.indexOf(level) === -1) level = s.intended === 'on' ? 'dnd' : 'available';
      for (var i = 0; i < LEVELS.length; i++) {
        document.body.classList.toggle(LEVELS[i], LEVELS[i] === level);
      }
      document.body.classList.toggle('held', s.hold === 'interruptible' || s.hold === 'dnd');

      // D-9: a message may never replace or obscure the state word. It renders as a
      // subordinate line underneath it.
      var text = WORDS[level];
      word.textContent = text;
      word.style.fontSize = text.length > 12 ? '9vw' : '18vw';
      var msg = (s.message !== null && s.message !== undefined) ? String(s.message) : '';
      sub.textContent = msg;
      sub.style.display = msg === '' ? 'none' : 'block';
      refreshStale();
    }

    connect();
    setInterval(refreshStale, 30000);
    setInterval(function () {
      if (Date.now() - lastAt > WATCHDOG_SILENT_MS) {
        document.body.classList.add('disconnected');
        connect();
      }
    }, 10000);
  </script>
</body>
</html>
`;
