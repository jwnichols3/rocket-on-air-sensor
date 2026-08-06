// Self-contained control panel + API console. No external resources - same constraint
// as display.ts. Served by GET /ui.
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>on-air console</title>
<style>
  :root {
    --bg: #0b0c0e;
    --surface: #141619;
    --border: #23262b;
    --well: #0e0f11;
    --text: #e8e6e1;
    --muted: #8a8f98;
    --accent: #e03131;
    --ok: #3fb950;
    --warn: #ffb300;
    --mono: ui-monospace, 'SF Mono', Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background-color: var(--bg);
    background-image:
      radial-gradient(ellipse 1200px 800px at 50% -10%, rgba(255,255,255,0.035), transparent 60%),
      repeating-linear-gradient(0deg, rgba(255,255,255,0.006) 0px, rgba(255,255,255,0.006) 1px, transparent 1px, transparent 2px);
    color: var(--text);
    font-family: var(--sans);
    min-height: 100vh;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 16px 16px 48px;
  }
  a { color: inherit; }

  header {
    position: sticky; top: 0; z-index: 5;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 10px 16px;
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  #wordmark {
    font-family: var(--mono);
    font-weight: 700;
    letter-spacing: 0.06em;
    font-size: 15px;
  }
  .pill {
    font-family: var(--mono);
    font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
    padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--border);
    background: #1b1e22; color: var(--muted);
    transition: background 0.2s, box-shadow 0.2s, color 0.2s, border-color 0.2s;
  }
  .pill.on { background: rgba(224,49,49,0.15); color: var(--accent); border-color: var(--accent); box-shadow: 0 0 12px rgba(224,49,49,0.45); }
  .pill.off { background: #1b1e22; color: var(--muted); }

  .led {
    width: 9px; height: 9px; border-radius: 50%;
    background: #33383f; display: inline-block;
    transition: background 0.2s, box-shadow 0.2s;
  }
  .led.live { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .led.reconnecting { background: var(--warn); box-shadow: 0 0 6px var(--warn); animation: pulse 1s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  #age { font-family: var(--mono); font-size: 12px; color: var(--muted); }

  #token {
    margin-left: auto;
    background: var(--well); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 8px; font-family: var(--mono); font-size: 12px;
    width: 140px;
  }
  #token:focus-visible { outline: 2px solid var(--warn); outline-offset: 1px; }

  #banner {
    position: sticky; top: 41px; z-index: 4;
    background: var(--accent); color: #fff;
    font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
    text-align: center; padding: 6px;
    transform: translateY(-120%);
    transition: transform 0.2s ease-out;
  }
  body.disconnected #banner { transform: translateY(0); }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-top: 16px;
  }
  .card h2 {
    margin: 0 0 12px;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .btn {
    font: inherit;
    background: #1b1e22;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 16px;
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.03), 0 1px 0 rgba(0,0,0,0.4);
    transition: background 0.15s, box-shadow 0.15s, border-color 0.15s, transform 0.05s;
  }
  .btn:active { transform: translateY(1px); box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); }
  .btn:focus-visible { outline: 2px solid var(--warn); outline-offset: 2px; }
  .btn-sm { padding: 6px 10px; font-size: 12px; }

  .controls-row { display: flex; gap: 12px; }
  .btn-big { flex: 1; padding: 20px; font-size: 15px; font-weight: 700; letter-spacing: 0.05em; }
  .btn-on.active { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 0 20px rgba(224,49,49,0.5), inset 0 1px 0 rgba(255,255,255,0.15); }
  .btn-off.active { background: #20232a; border-color: #3a3d42; color: var(--text); }

  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  #msg-input {
    flex: 1; min-width: 180px;
    background: var(--well); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; font-family: var(--sans); font-size: 14px;
  }
  #msg-input:focus-visible { outline: 2px solid var(--warn); outline-offset: 1px; }
  #msg-counter { font-family: var(--mono); font-size: 11px; color: var(--muted); min-width: 44px; text-align: right; }
  #msg-current { margin-top: 10px; font-size: 13px; color: var(--muted); }
  #msg-current b { color: var(--text); font-weight: 500; }

  #log { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow-y: auto; }
  #log li {
    font-family: var(--mono); font-size: 12px;
    display: flex; gap: 10px;
    padding: 6px 4px;
    border-bottom: 1px solid var(--border);
    animation: slide-in 0.15s ease-out;
  }
  #log li:last-child { border-bottom: none; }
  @keyframes slide-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  .ev-time { color: var(--muted); }
  .ev-intended.on { color: var(--accent); font-weight: 700; }
  .ev-intended.off { color: var(--muted); }
  .ev-source { color: var(--text); }
  .ev-message { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #log-empty { color: var(--muted); font-size: 13px; }

  .console-row + .console-row { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 16px; }
  .row-label { font-family: var(--mono); font-size: 13px; font-weight: 600; }
  .row-actions { margin-left: auto; display: flex; gap: 8px; }
  textarea.row-body {
    width: 100%; margin-top: 8px;
    background: var(--well); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; font-family: var(--mono); font-size: 12px;
    resize: vertical; min-height: 44px;
  }
  textarea.row-body:focus-visible { outline: 2px solid var(--warn); outline-offset: 1px; }
  .well {
    margin-top: 8px;
    background: var(--well);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px;
    font-family: var(--mono); font-size: 12px;
    min-height: 18px;
    box-shadow: inset 0 1px 4px rgba(0,0,0,0.5);
  }
  .well pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-all; }
  .status { font-weight: 700; }
  .status-ok { color: var(--ok); }
  .status-warn { color: var(--warn); }
  .status-err { color: var(--accent); }

  @media (max-width: 480px) {
    .controls-row { flex-direction: column; }
    #token { width: 100px; }
  }
</style>
</head>
<body class="off">
  <header>
    <span id="wordmark">on-air</span>
    <span id="pill" class="pill off">OFF AIR</span>
    <span id="led" class="led"></span>
    <span id="age">age &mdash;</span>
    <input id="token" type="password" placeholder="token" autocomplete="off" spellcheck="false">
  </header>
  <div id="banner">DISCONNECTED</div>

  <main>
    <section class="card">
      <h2>Transport</h2>
      <div class="controls-row">
        <button id="btn-on" class="btn btn-big btn-on">ON</button>
        <button id="btn-off" class="btn btn-big btn-off">OFF</button>
      </div>
    </section>

    <section class="card">
      <h2>Message</h2>
      <div class="row">
        <input id="msg-input" type="text" maxlength="200" placeholder="display message">
        <span id="msg-counter">0/200</span>
        <button id="msg-set" class="btn btn-sm">Set</button>
        <button id="msg-clear" class="btn btn-sm">Clear</button>
      </div>
      <div id="msg-current">Current: <b>(none)</b></div>
    </section>

    <section class="card">
      <h2>Event Log</h2>
      <ul id="log"><li id="log-empty">no events yet</li></ul>
    </section>

    <section class="card">
      <h2>API Console</h2>

      <div class="console-row" id="row-status">
        <div class="row"><span class="row-label">GET /status</span>
          <div class="row-actions"><button class="btn btn-sm send-btn">Send</button><button class="btn btn-sm copy-btn">&#x29c9; curl</button></div>
        </div>
        <div class="well"></div>
      </div>

      <div class="console-row" id="row-state">
        <div class="row"><span class="row-label">PUT /state</span>
          <div class="row-actions"><button class="btn btn-sm send-btn">Send</button><button class="btn btn-sm copy-btn">&#x29c9; curl</button></div>
        </div>
        <textarea class="row-body" rows="2">{"onAir": true, "source": "webui"}</textarea>
        <div class="well"></div>
      </div>

      <div class="console-row" id="row-on">
        <div class="row"><span class="row-label">POST /on</span>
          <div class="row-actions"><button class="btn btn-sm send-btn">Send</button><button class="btn btn-sm copy-btn">&#x29c9; curl</button></div>
        </div>
        <div class="well"></div>
      </div>

      <div class="console-row" id="row-off">
        <div class="row"><span class="row-label">POST /off</span>
          <div class="row-actions"><button class="btn btn-sm send-btn">Send</button><button class="btn btn-sm copy-btn">&#x29c9; curl</button></div>
        </div>
        <div class="well"></div>
      </div>

      <div class="console-row" id="row-message-set">
        <div class="row"><span class="row-label">PUT /message</span>
          <div class="row-actions"><button class="btn btn-sm send-btn">Send</button><button class="btn btn-sm copy-btn">&#x29c9; curl</button></div>
        </div>
        <textarea class="row-body" rows="2">{"text": "BE QUIET"}</textarea>
        <div class="well"></div>
      </div>

      <div class="console-row" id="row-message-clear">
        <div class="row"><span class="row-label">DELETE /message</span>
          <div class="row-actions"><button class="btn btn-sm send-btn">Send</button><button class="btn btn-sm copy-btn">&#x29c9; curl</button></div>
        </div>
        <div class="well"></div>
      </div>
    </section>
  </main>

  <script>
    var WATCHDOG_SILENT_MS = 45000;
    var MAX_LOG_ROWS = 100;

    var token = localStorage.getItem('onair-token') || '';
    var tokenInput = document.getElementById('token');
    tokenInput.value = token;
    tokenInput.addEventListener('change', function () {
      token = tokenInput.value;
      localStorage.setItem('onair-token', token);
      connect();
    });

    function authHeaders() {
      var h = {};
      if (token) h['Authorization'] = 'Bearer ' + token;
      return h;
    }

    var pill = document.getElementById('pill');
    var led = document.getElementById('led');
    var ageEl = document.getElementById('age');
    var btnOn = document.getElementById('btn-on');
    var btnOff = document.getElementById('btn-off');
    var msgInput = document.getElementById('msg-input');
    var msgCounter = document.getElementById('msg-counter');
    var msgCurrent = document.getElementById('msg-current');
    var log = document.getElementById('log');
    var logEmpty = document.getElementById('log-empty');

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
        led.className = 'led live';
        last = JSON.parse(e.data);
        lastAt = Date.now();
        render(last);
      });
      es.onerror = function () {
        document.body.classList.add('disconnected');
        led.className = 'led reconnecting';
      };
      lastAt = Date.now();
    }

    function effectiveAgeSeconds() {
      if (last === null) return 0;
      return last.ageSeconds + (Date.now() - lastAt) / 1000;
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function addLogRow(s) {
      if (logEmpty) { logEmpty.remove(); logEmpty = null; }
      var now = new Date();
      var time = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
      var li = document.createElement('li');

      var timeSpan = document.createElement('span');
      timeSpan.className = 'ev-time';
      timeSpan.textContent = time;
      li.appendChild(timeSpan);

      var intendedSpan = document.createElement('span');
      intendedSpan.className = 'ev-intended ' + s.intended;
      intendedSpan.textContent = s.intended === 'on' ? 'ON AIR' : 'OFF AIR';
      li.appendChild(intendedSpan);

      var sourceSpan = document.createElement('span');
      sourceSpan.className = 'ev-source';
      sourceSpan.textContent = s.source;
      li.appendChild(sourceSpan);

      if (s.message !== null && s.message !== undefined) {
        var msgSpan = document.createElement('span');
        msgSpan.className = 'ev-message';
        msgSpan.textContent = s.message;
        li.appendChild(msgSpan);
      }

      log.insertBefore(li, log.firstChild);
      while (log.children.length > MAX_LOG_ROWS) {
        log.removeChild(log.lastChild);
      }
    }

    function render(s) {
      var on = s.intended === 'on';
      pill.textContent = on ? 'ON AIR' : 'OFF AIR';
      pill.className = 'pill ' + (on ? 'on' : 'off');
      btnOn.classList.toggle('active', on);
      btnOff.classList.toggle('active', !on);
      msgCurrent.innerHTML = 'Current: <b></b>';
      msgCurrent.querySelector('b').textContent = (s.message !== null && s.message !== undefined) ? s.message : '(none)';
      addLogRow(s);
    }

    function doAction(path) {
      fetch(path + '?source=webui', { method: 'POST', headers: authHeaders() }).catch(function () {});
    }
    btnOn.addEventListener('click', function () { doAction('/on'); });
    btnOff.addEventListener('click', function () { doAction('/off'); });

    msgInput.addEventListener('input', function () {
      msgCounter.textContent = msgInput.value.length + '/200';
    });
    document.getElementById('msg-set').addEventListener('click', function () {
      var headers = authHeaders();
      headers['content-type'] = 'application/json';
      fetch('/message', { method: 'PUT', headers: headers, body: JSON.stringify({ text: msgInput.value }) }).catch(function () {});
    });
    document.getElementById('msg-clear').addEventListener('click', function () {
      fetch('/message', { method: 'DELETE', headers: authHeaders() }).catch(function () {});
    });

    function buildCurl(method, path, bodyText) {
      var cmd = "curl -X " + method + " '" + location.origin + path + "'";
      if (bodyText !== undefined && bodyText !== null && bodyText !== '') {
        cmd += " -d '" + bodyText.replace(/'/g, "'\\\\''") + "'";
      }
      if (token) {
        cmd += " -H 'Authorization: Bearer " + token + "'";
      }
      return cmd;
    }

    function showWellResponse(well, status, cls, text) {
      well.innerHTML = '';
      var statusSpan = document.createElement('span');
      statusSpan.className = 'status status-' + cls;
      statusSpan.textContent = status !== null ? String(status) : 'ERR';
      well.appendChild(statusSpan);
      var pre = document.createElement('pre');
      pre.textContent = text;
      well.appendChild(pre);
    }

    function showWellText(well, text) {
      well.innerHTML = '';
      var pre = document.createElement('pre');
      pre.textContent = text;
      well.appendChild(pre);
    }

    var consoleRows = [
      { id: 'row-status', method: 'GET', path: '/status' },
      { id: 'row-state', method: 'PUT', path: '/state' },
      { id: 'row-on', method: 'POST', path: '/on' },
      { id: 'row-off', method: 'POST', path: '/off' },
      { id: 'row-message-set', method: 'PUT', path: '/message' },
      { id: 'row-message-clear', method: 'DELETE', path: '/message' }
    ];

    function wireRow(cfg) {
      var root = document.getElementById(cfg.id);
      var well = root.querySelector('.well');
      var textarea = root.querySelector('textarea.row-body');
      var sendBtn = root.querySelector('.send-btn');
      var copyBtn = root.querySelector('.copy-btn');

      sendBtn.addEventListener('click', function () {
        var bodyText = textarea ? textarea.value : undefined;
        var headers = authHeaders();
        var opts = { method: cfg.method, headers: headers };
        if (bodyText !== undefined) opts.body = bodyText;
        fetch(cfg.path, opts).then(function (res) {
          var cls = res.status >= 200 && res.status < 300 ? 'ok' : (res.status >= 400 && res.status < 500 ? 'warn' : 'err');
          return res.text().then(function (txt) {
            var pretty = txt;
            try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch (e) {}
            showWellResponse(well, res.status, cls, pretty);
          });
        }).catch(function (err) {
          showWellResponse(well, null, 'err', 'network error: ' + (err && err.message ? err.message : String(err)));
        });
      });

      copyBtn.addEventListener('click', function () {
        var bodyText = textarea ? textarea.value : undefined;
        var cmd = buildCurl(cfg.method, cfg.path, bodyText);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          var orig = copyBtn.textContent;
          navigator.clipboard.writeText(cmd).then(function () {
            copyBtn.textContent = 'Copied';
            setTimeout(function () { copyBtn.textContent = orig; }, 1200);
          }).catch(function () { showWellText(well, cmd); });
        } else {
          showWellText(well, cmd);
        }
      });
    }
    for (var i = 0; i < consoleRows.length; i++) wireRow(consoleRows[i]);

    connect();
    setInterval(function () {
      if (last !== null) ageEl.textContent = 'age ' + Math.floor(effectiveAgeSeconds()) + 's';
    }, 1000);
    setInterval(function () {
      if (Date.now() - lastAt > WATCHDOG_SILENT_MS) {
        document.body.classList.add('disconnected');
        led.className = 'led reconnecting';
        connect();
      }
    }, 10000);
  </script>
</body>
</html>
`;
