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
  #lost, #held {
    position: fixed; top: 2vh; font-size: 2.4vw; font-weight: 700; letter-spacing: 0.12em;
    padding: 0.6vh 1.4vw; border: 0.25vh solid currentColor; border-radius: 0.6vh;
    display: none;
  }
  #lost { right: 2vw; }
  body.lost #lost { display: block; }

  /* A hatched wash, so the mark is legible across a room without changing the state colour -
     the colour is the state and nothing else is allowed to speak with it. */
  body.lost::after {
    content: ""; position: fixed; inset: 0; pointer-events: none; opacity: 0.16;
    background: repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 14px);
  }
</style>
</head>
<body>
  <div id="word"></div>
  <div id="sub"></div>
  <div id="lost">CONNECTION LOST</div>
  <script>
    // THE CLIENT CONTRACT (D-91/D-92), in three conditions. Every threshold below is
    // measured from THE LAST SUCCESSFUL CONTACT WITH THIS SERVER - our own wall clock,
    // never a number the server sent us. That is what makes this fail CLOSED: there is no
    // field to be absent, renamed or wrong. Trusting a server flag is a measured incident
    // (D-64.3) - a calm menu bar drawn on 27-hour-old evidence - not a hypothetical.
    //
    // The two thresholds are independent, both from the same instant, and NOT chained.
    // Overridable per kiosk on the query string, since a wall panel and a desk monitor can
    // reasonably want different patience: /display?lost=60&nodata=1800 (seconds).
    var CONNECTION_LOST_MS = 60000;   // 1 minute  - mark it as no longer refreshing
    var NO_DATA_MS = 1800000;         // 30 minutes - give up on the state entirely
    // Deliberately far apart: a meeting runs about thirty minutes, so the STATE must
    // survive an outage for at least that long or the panel goes dark mid-call. The
    // honesty about not being refreshed costs nothing, so it arrives immediately.

    function seconds(name, fallback) {
      // A character class, NOT a digit escape. This whole page is a TEMPLATE LITERAL, so a
      // backslash here is eaten on the way out and the emitted page matches a literal "d"
      // instead of a digit - silently, and only when someone passes an override. A class
      // with no escape in it cannot have that bug.
      var m = new RegExp('[?&]' + name + '=([0-9]{1,6})').exec(location.search);
      return m ? Number(m[1]) * 1000 : fallback;
    }
    CONNECTION_LOST_MS = seconds('lost', CONNECTION_LOST_MS);
    NO_DATA_MS = seconds('nodata', NO_DATA_MS);

    var word = document.getElementById('word');
    var sub = document.getElementById('sub');
    var last = null;
    var lastContactAt = 0;
    var es;

    // The reserved row's look is the fallback for "we have nothing" - never blank, and
    // never calm. It is replaced by the server's own 'unknown' row the moment one arrives.
    function unknownLook() {
      return { label: 'NO DATA', color: '#ff00ff', bgcolor: '#1a1a1a', message: null };
    }

    /** Milliseconds since we last heard ANYTHING from the server. Infinity before we ever did. */
    function sinceContact() {
      return lastContactAt === 0 ? Infinity : Date.now() - lastContactAt;
    }

    /**
     * Condition 3: beyond the second threshold we stop claiming to know the state at all.
     * NO DATA is drawn as the state itself rather than as an overlay - an overlay over the
     * last known state would be two claims at once, and the honest one is the reserved row.
     */
    var gaveUp = false;
    function judge() {
      var gap = sinceContact();
      if (last === null || gap > NO_DATA_MS) {
        document.body.classList.remove('lost');
        // Paint once on the way in, not every tick: this runs on a 1 s timer and repainting
        // the same thing sixty times a minute is a busy loop wearing a judgement's clothes.
        if (!gaveUp) { gaveUp = true; paint(unknownLook()); }
        return;
      }
      gaveUp = false;
      // Condition 2: hold the last known state, and say plainly that it is not being
      // refreshed. It does not go blank and it does not go calm.
      document.body.classList.toggle('lost', gap > CONNECTION_LOST_MS);
    }

    function paint(s) {
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
    }

    /** A fresh payload: condition 1. Draw it plainly and clear any mark. */
    function render(s) {
      paint(s);
      judge();
    }

    function connect() {
      if (es) { try { es.close(); } catch (e) {} }
      // Unauthenticated by design: this page is served without a credential, so it cannot
      // present one either. A ?token= left in a bookmarked URL is simply ignored.
      es = new EventSource('/public/events');
      // Opening the socket is not contact. Only a payload is - a stream that connects and
      // then says nothing is exactly the failure these thresholds exist to catch.
      es.onopen = function () {};
      // A NAMED event, so onmessage would never fire - onmessage only receives unnamed
      // ones. Getting this wrong is silent: the page connects, the server streams, and the
      // page sits on its opening appearance forever with nothing in the console.
      es.addEventListener('status', function (ev) {
        var data;
        // An unparseable payload is NOT contact. Counting it would let a server emitting
        // garbage hold the panel calm forever, which is the fail-open direction.
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        last = data;
        lastContactAt = Date.now();
        render(data);
      });
      // A socket error is NOT itself a verdict - the thresholds are - and it must not
      // trigger a reconnect here. onerror fires immediately when the server is down, so
      // reconnecting from inside it is a tight loop hammering a box that is already
      // struggling. The 10 s watchdog below does the retrying, on a clock.
      es.onerror = function () {};
    }

    // Ship as the unknown appearance rather than asserting anything before data arrives.
    paint(unknownLook());
    connect();

    // The judgement runs on our own clock, not on server traffic, so a stream that goes
    // silent still escalates on time.
    setInterval(judge, 1000);
    // The server emits a keep-alive status event every 15 s, so silence beyond a couple of
    // those is a dead stream even when the socket never errored. Reconnect well inside the
    // first threshold, so a recoverable drop never reaches the mark.
    setInterval(function () {
      if (sinceContact() > 20000) connect();
    }, 10000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) connect();
    });
  </script>
</body>
</html>
`;
