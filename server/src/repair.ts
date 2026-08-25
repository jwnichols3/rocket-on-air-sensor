/**
 * The repair view (D-36). Served only when the config file on disk could not be used.
 *
 * It exists because the failure to design against is *"a config save that leaves the
 * service unable to start, on a machine Rocket is not sitting in front of"*. The service
 * binds loopback, starts on defaults, and serves this - so the fix is a browser away
 * instead of an SSH session away. Self-contained, like `/display`: no external resources,
 * because the thing that is broken might be the thing that would serve them.
 */
/**
 * Exported since #48: the browser-readable 401 in `server.ts` needs the same escaping, and
 * two copies of an escaper is how one of them ends up missing a case.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Build the page for a specific problem.
 *
 * The errors and the raw text are rendered SERVER-SIDE, not fetched by the page's own
 * script. On a page whose entire job is "something is broken", a diagnosis that only
 * appears if a second request succeeds is the wrong way round - view-source has to show
 * the problem even if the JS never runs.
 */
export function repairHtml(problem: { errors: string[]; raw: string }): string {
  return REPAIR_HTML.replace(
    '<!--ERRORS-->',
    problem.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('\n      '),
  ).replace('<!--RAW-->', escapeHtml(problem.raw));
}

const REPAIR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>on-air: repair config</title>
<style>
  :root { color-scheme: dark; --bg:#0d0f12; --card:#14171b; --border:#262a30; --text:#e6e6e6;
          --muted:#8b9096; --accent:#e03131; --ok:#2f9e44; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui, sans-serif; }
  header { background:var(--accent); color:#fff; padding:14px 20px; font-weight:700; letter-spacing:0.02em; }
  main { max-width:900px; margin:0 auto; padding:20px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:16px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin:0 0 12px; }
  ul { margin:0; padding-left:20px; } li { color:var(--accent); font-family:var(--mono); font-size:13px; }
  textarea { width:100%; min-height:340px; background:#0b0d10; color:var(--text); border:1px solid var(--border);
             border-radius:6px; padding:12px; font-family:var(--mono); font-size:12.5px; }
  .row { display:flex; gap:8px; align-items:center; margin-top:12px; }
  button { background:#1d2126; color:var(--text); border:1px solid var(--border); border-radius:6px;
           padding:8px 14px; font:inherit; cursor:pointer; }
  button.primary { background:var(--ok); border-color:var(--ok); color:#fff; font-weight:600; }
  #msg { font-family:var(--mono); font-size:13px; }
  #msg.bad { color:var(--accent); } #msg.good { color:var(--ok); }
  p.note { color:var(--muted); margin:0 0 12px; }
</style>
</head>
<body>
<header>CONFIG UNUSABLE - running on defaults, bound to loopback</header>
<main>
  <div class="card">
    <h2>What is wrong</h2>
    <ul id="errors"><!--ERRORS--></ul>
  </div>
  <div class="card">
    <h2>The file on disk</h2>
    <p class="note">Edit and save, or reset to the shipped defaults. Saving is the repair -
      the service picks it up immediately and this page stops being served.</p>
    <textarea id="raw" spellcheck="false"><!--RAW--></textarea>
    <div class="row">
      <button id="save" class="primary">Save configuration</button>
      <button id="reset">Reset to defaults</button>
      <span id="msg"></span>
    </div>
  </div>
</main>
<script>
  var token = new URLSearchParams(location.search).get('token');
  function headers(extra) {
    var h = extra || {};
    if (token) h['authorization'] = 'Bearer ' + token;
    return h;
  }
  var rawEl = document.getElementById('raw');
  var msg = document.getElementById('msg');
  var live = null;

  function say(text, good) { msg.textContent = text; msg.className = good ? 'good' : 'bad'; }

  // The errors and the raw text are already in the page. This only fetches the RUNNING
  // document, which is what supplies the version base and the reset target.
  fetch('/admin/config', { headers: headers() }).then(function (r) { return r.json(); }).then(function (b) {
    live = b.config;
    if (rawEl.value.trim() === '') rawEl.value = JSON.stringify(live, null, 2);
  });

  document.getElementById('reset').addEventListener('click', function () {
    if (live) rawEl.value = JSON.stringify(live, null, 2);
    say('reset to the running defaults - not saved yet', true);
  });

  document.getElementById('save').addEventListener('click', function () {
    var parsed;
    try { parsed = JSON.parse(rawEl.value); }
    catch (e) { say('still not valid JSON: ' + e.message, false); return; }
    // The running document is the version base, since the broken file has no usable one.
    if (live) parsed.version = live.version;
    fetch('/admin/config', {
      method: 'PUT',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(parsed)
    }).then(function (r) {
      return r.json().then(function (b) { return { status: r.status, body: b }; });
    }).then(function (out) {
      // No redirect: /ui is retired (D-35) and this page stops being served the moment the
      // save succeeds, so sending the browser anywhere would land it on a 404.
      if (out.status === 200) { say('saved - the service has picked it up, and this page is done', true); }
      else say(out.status + ': ' + (out.body.error || '') + ' ' + ((out.body.problems || []).join('; ')), false);
    }).catch(function (e) { say('save failed: ' + e.message, false); });
  });
</script>
</body>
</html>
`;
