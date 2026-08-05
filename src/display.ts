// Self-contained tally page. No external resources - it must render on a kiosk
// with no network beyond the API host. Served by GET /display.
export const DISPLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  body.on { background: #b30000; }
  body.on #word { color: #fff; }
  body.off { background: #111; }
  body.off #word { color: #3a3a3a; }
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
<body class="off">
  <div id="word">OFF AIR</div>
  <div id="stale">STALE</div>
  <div id="overlay">DISCONNECTED</div>
  <script>
    var STALE_AFTER_SECONDS = 300;
    var token = new URLSearchParams(location.search).get('token');
    var es = new EventSource('/events' + (token ? '?token=' + encodeURIComponent(token) : ''));
    var word = document.getElementById('word');
    var last = null;
    var lastAt = 0;

    function effectiveAgeSeconds() {
      if (last === null) return 0;
      return last.ageSeconds + (Date.now() - lastAt) / 1000;
    }

    function refreshStale() {
      var stale = last !== null && last.source === 'detector' && effectiveAgeSeconds() > STALE_AFTER_SECONDS;
      document.body.classList.toggle('stale', stale);
    }

    function render(s) {
      var on = s.intended === 'on';
      document.body.classList.toggle('on', on);
      document.body.classList.toggle('off', !on);
      var text = (s.message !== null && s.message !== undefined) ? s.message : (on ? 'ON AIR' : 'OFF AIR');
      word.textContent = text;
      word.style.fontSize = text.length > 12 ? '9vw' : '18vw';
      refreshStale();
    }

    es.addEventListener('status', function (e) {
      document.body.classList.remove('disconnected');
      last = JSON.parse(e.data);
      lastAt = Date.now();
      render(last);
    });
    es.onerror = function () {
      document.body.classList.add('disconnected');
    };
    setInterval(refreshStale, 30000);
  </script>
</body>
</html>
`;
