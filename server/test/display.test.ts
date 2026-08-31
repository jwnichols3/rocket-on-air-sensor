import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { DISPLAY_HTML } from '../src/display.js';
import type { OnAirConfig } from '../src/config-store.js';
import type { LightDriver } from '../src/driver.js';
import { UNKNOWN_ID } from '../src/state.js';

class StubDriver implements LightDriver {
  async set(id: string): Promise<string> {
    return id;
  }
  async read(): Promise<string> {
    return UNKNOWN_ID;
  }
}

async function boot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-display-'));
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config.json'),
    port: 0,
    bind: 'loopback', // #49: exclusive, so no other process can share this port
    driver: new StubDriver(),
    log: () => {},
  });
  t.after(() => app.close().catch(() => {}));
  return { app, base: `http://127.0.0.1:${app.port}` };
}

const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

test('/display holds no vocabulary of its own', () => {
  // The point of the rebuild: no hardcoded appearances, no list of known states. Anything
  // it recognised by name would be a row it could render and another it could not.
  for (const gone of ['available', 'interruptible', 'on-air', 'dnd', 'INTERRUPTIBLE']) {
    assert.equal(DISPLAY_HTML.includes(gone), false, `${gone} must not be baked into the page`);
  }
  // And zero interpolation, so it stays byte-identical for every caller (D-25).
  assert.equal(DISPLAY_HTML.includes('${'), false);
});

test('/display reads the UNAUTHENTICATED stream, because it is served unauthenticated', async (t) => {
  const h = await boot(t);
  assert.equal(DISPLAY_HTML.includes("EventSource('/public/events')"), true);
  assert.equal(DISPLAY_HTML.includes("'/events'"), false, 'the gated stream is not reachable from here');
  // Served with no credential, from anywhere.
  const res = await fetch(`${h.base}/display`, { headers: { origin: 'http://10.42.14.189:9099' } });
  assert.equal(res.status, 200);
  await res.text();
});

test('the page subscribes to the NAMED status event, not onmessage', () => {
  // The hub sends `event: status`, and `onmessage` only receives UNNAMED events. Getting
  // this wrong is completely silent - the page connects, the server streams, and the page
  // sits on its opening appearance forever with nothing in the console. It did, once, and
  // only a browser caught it.
  assert.match(DISPLAY_HTML, /addEventListener\('status'/);
  assert.equal(/es\.onmessage/.test(DISPLAY_HTML), false);
});

test('the page holds no private staleness threshold of its own (D-91, #63)', () => {
  // The rule it used to carry - `ageSeconds > 90`, extended forward between events - is
  // gone along with the server field it mirrored. What replaced it is a judgement about
  // THIS PAGE'S CONNECTION, on its own clock.
  assert.equal(/STALE_AFTER_SECONDS/.test(DISPLAY_HTML), false);
  assert.equal(/\b90\b/.test(DISPLAY_HTML.replace(/[#][0-9a-f]{6}/g, '')), false, 'no bare 90 survives');
  assert.match(DISPLAY_HTML, /CONNECTION_LOST_MS = 60000/);
  assert.match(DISPLAY_HTML, /NO_DATA_MS = 1800000/);
});

test('the blanking DISCONNECTED overlay is GONE: condition 2 must not go blank', () => {
  // An 82%-black overlay across the state word IS going blank, which the client contract
  // forbids: the panel says what it last knew AND that it is not being refreshed.
  assert.equal(/DISCONNECTED/.test(DISPLAY_HTML), false);
  assert.equal(/body\.disconnected/.test(DISPLAY_HTML), false);
  assert.match(DISPLAY_HTML, /CONNECTION LOST/);
});

// ---------------------------------------------------------------------------------------
// THE CLIENT CONTRACT, actually executed. The page's judgement is the whole of #63, so it
// is run in a stub DOM rather than pattern-matched: a regex over the source cannot tell a
// working threshold from a commented-out one.

interface Harnessed {
  classes: Set<string>;
  label: () => string;
  bg: () => string;
  emit: (payload: unknown) => void;
  emitRaw: (data: string) => void;
  advance: (ms: number) => void;
}

function runPage(search = ''): Harnessed {
  const script = /<script>([\s\S]*?)<\/script>/.exec(DISPLAY_HTML)![1]!;
  const classes = new Set<string>();
  const els: Record<string, { textContent: string; style: Record<string, string> }> = {
    word: { textContent: '', style: {} },
    sub: { textContent: '', style: {} },
    lost: { textContent: '', style: {} },
  };
  const css: Record<string, string> = {};
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; every: number; next: number }> = [];
  let listener: ((ev: { data: string }) => void) | null = null;

  const ctx = vm.createContext({
    Date: { now: () => now },
    Number,
    String,
    RegExp,
    Infinity,
    location: { search },
    setInterval: (fn: () => void, every: number) => {
      timers.push({ fn, every, next: now + every });
      return timers.length;
    },
    EventSource: class {
      addEventListener(_name: string, fn: (ev: { data: string }) => void): void {
        listener = fn;
      }
      close(): void {}
    },
    document: {
      getElementById: (id: string) => els[id],
      body: {
        classList: {
          add: (c: string) => classes.add(c),
          remove: (c: string) => classes.delete(c),
          toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
        },
      },
      documentElement: { style: { setProperty: (k: string, v: string) => (css[k] = v) } },
      addEventListener: () => {},
      hidden: false,
    },
  });
  vm.runInContext(script, ctx);

  return {
    classes,
    label: () => els.word!.textContent,
    bg: () => css['--bg'] ?? '',
    emit: (payload) => listener?.({ data: JSON.stringify(payload) }),
    emitRaw: (data) => listener?.({ data }),
    advance: (ms) => {
      // Fire every timer that would have fired, in order, so a 40-minute jump escalates
      // through both thresholds exactly as the real page would.
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.next <= target).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.every;
        due.fn();
      }
      now = target;
      for (const t of timers) if (t.next <= now) t.next = now + t.every;
    },
  };
}

const ON_AIR = { state: 'x1', label: 'BUSY NOW', color: '#ffffff', bgcolor: '#c1121f', message: null, ageSeconds: 4 };
const CALM = { state: 'x2', label: 'ALL CLEAR', color: '#ffffff', bgcolor: '#0b6e2e', message: null, ageSeconds: 4 };

test('condition 1 - reachable: the current state is drawn plainly, with no mark', () => {
  const p = runPage();
  p.emit(ON_AIR);
  assert.equal(p.label(), 'BUSY NOW');
  assert.equal(p.classes.has('lost'), false);
});

test('condition 1 holds through a long QUIET but CONNECTED stream', () => {
  // The keep-alive is a real event every 15 s. A state nobody has changed for an hour is
  // still the state - this is the D-91 latch seen from the renderer's side, and the exact
  // case that used to paint NO DATA.
  const p = runPage();
  p.emit(CALM);
  for (let i = 0; i < 240; i++) {
    p.advance(15_000);
    p.emit(CALM);
  }
  assert.equal(p.label(), 'ALL CLEAR', 'one hour of keep-alives is not a loss of contact');
  assert.equal(p.classes.has('lost'), false);
});

test('condition 2 - contact lost: the last known state is HELD, and marked', () => {
  const p = runPage();
  p.emit(ON_AIR);
  p.advance(61_000);
  assert.equal(p.label(), 'BUSY NOW', 'it does not go blank');
  assert.equal(p.bg(), '#c1121f', 'and it does not go calm');
  assert.equal(p.classes.has('lost'), true, 'and it says it is not being refreshed');
});

test('condition 2 arrives at ONE MINUTE, not before', () => {
  const p = runPage();
  p.emit(CALM);
  p.advance(59_000);
  assert.equal(p.classes.has('lost'), false);
  p.advance(2_000);
  assert.equal(p.classes.has('lost'), true);
});

test('a CALM row is marked exactly like a busy one - no per-row branch', () => {
  // The asymmetric-threshold proposal was rejected in favour of this: mark everything at a
  // minute, hold everything for thirty. A calm row on a dead link is never a confident
  // claim, because within a minute it is visibly no longer being refreshed.
  const p = runPage();
  p.emit(CALM);
  p.advance(61_000);
  assert.equal(p.label(), 'ALL CLEAR');
  assert.equal(p.classes.has('lost'), true);
});

test('condition 3 - thirty minutes: it gives up on the state entirely', () => {
  const p = runPage();
  p.emit(ON_AIR);
  p.advance(1_801_000);
  assert.equal(p.label(), 'NO DATA');
  assert.equal(p.bg(), '#1a1a1a');
  assert.equal(p.classes.has('lost'), false, 'NO DATA is the whole claim; a mark beside it says nothing more');
});

test('the two thresholds are independent, not chained', () => {
  // 29 minutes of silence is still condition 2 - held and marked - not NO DATA. If the
  // second clock were chained off the first this would have expired ten minutes ago.
  const p = runPage();
  p.emit(ON_AIR);
  p.advance(1_740_000);
  assert.equal(p.label(), 'BUSY NOW');
  assert.equal(p.classes.has('lost'), true);
});

test('contact RESTORED clears the mark and resumes drawing plainly', () => {
  const p = runPage();
  p.emit(ON_AIR);
  p.advance(120_000);
  assert.equal(p.classes.has('lost'), true);
  p.emit(CALM);
  assert.equal(p.classes.has('lost'), false);
  assert.equal(p.label(), 'ALL CLEAR');
});

test('it recovers from NO DATA too, without a reload', () => {
  const p = runPage();
  p.emit(ON_AIR);
  p.advance(1_801_000);
  assert.equal(p.label(), 'NO DATA');
  p.emit(CALM);
  assert.equal(p.label(), 'ALL CLEAR');
  assert.equal(p.classes.has('lost'), false);
});

test('before ANY contact the page is NO DATA, never blank and never calm', () => {
  const p = runPage();
  assert.equal(p.label(), 'NO DATA');
  p.advance(300_000);
  assert.equal(p.label(), 'NO DATA');
  assert.equal(p.classes.has('lost'), false);
});

test('FAIL CLOSED: an unparseable payload does not count as contact (D-64.3)', () => {
  // The measured incident was trusting the server's own word, and the direction that
  // matters is this one: garbage must never COUNT as contact. If it did, a server emitting
  // junk on a healthy socket would hold the panel confident forever - failing OPEN, calm,
  // which is the failure this whole system exists to prevent.
  const p = runPage();
  p.emit(ON_AIR);
  p.advance(59_000);
  assert.equal(p.classes.has('lost'), false);
  p.emitRaw('<html>a proxy error page</html>');
  p.advance(2_000);
  assert.equal(p.classes.has('lost'), true, 'junk did not refresh the clock');
  assert.equal(p.label(), 'BUSY NOW', 'and it did not overwrite the last real state either');
});

test('a payload with NO ageSeconds still works: the page never reads the server clock', () => {
  const p = runPage();
  p.emit({ state: 'x', label: 'SOMETHING', color: '#fff', bgcolor: '#000', message: null });
  assert.equal(p.label(), 'SOMETHING');
  assert.equal(p.classes.has('lost'), false);
  p.advance(61_000);
  assert.equal(p.classes.has('lost'), true, 'judged on contact, not on a field that was absent');
});

test('the thresholds are configuration: a kiosk may override them on the query string', () => {
  const p = runPage('?lost=5&nodata=20');
  p.emit(ON_AIR);
  p.advance(6_000);
  assert.equal(p.classes.has('lost'), true);
  p.advance(16_000);
  assert.equal(p.label(), 'NO DATA');
});

test('a message can never replace the state word - it is a separate element', () => {
  // D-9's safety rule, structural rather than conventional: the message has its own node
  // under the word, so no message value can end up in `word`.
  assert.match(DISPLAY_HTML, /sub\.textContent = msg/);
  assert.match(DISPLAY_HTML, /word\.textContent = label/);
  assert.equal(/word\.textContent = .*msg/.test(DISPLAY_HTML), false);
});

test('the public stream carries everything /display needs, and nothing more', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'back at 3' }) });
  const body = await json(await fetch(`${h.base}/public/status`));
  assert.equal(body.label, 'ON AIR');
  assert.equal(body.bgcolor, '#c1121f');
  assert.equal(body.color, '#ffffff');
  assert.equal(body.message, 'back at 3');
  assert.equal('stale' in body, false, 'the public view carries facts, not judgements (D-91)');
  // Still thin: the things D-35 excluded stay excluded.
  for (const forbidden of ['source', 'confirmed']) {
    assert.equal(forbidden in body, false, forbidden);
  }
});

test('A ROW INVENTED TODAY RENDERS, with the colours its owner chose', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({
      ...cfg,
      states: [...cfg.states, { id: 'deep-work', label: 'DEEP WORK', color: '#000000', bgcolor: '#7cc4ff', description: '', busy: false, order: 4 }],
    }),
  });
  await fetch(`${h.base}/state/deep-work`, { method: 'POST' });
  const body = await json(await fetch(`${h.base}/public/status`));
  assert.equal(body.label, 'DEEP WORK');
  assert.equal(body.bgcolor, '#7cc4ff');
  assert.equal(body.color, '#000000');
});

test('a state with no row borrows the RESERVED row - conspicuous, never blank, never calm', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  await fetch(`${h.base}/state/recording`, { method: 'POST' });
  // Delete the live row out from under it.
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, states: cfg.states.filter((r) => r.id !== 'recording') }),
  });
  const body = await json(await fetch(`${h.base}/public/status`));
  assert.equal(body.state, UNKNOWN_ID);
  assert.equal(body.label, 'NO DATA');
  assert.equal(body.busy, true, 'never calm');
  assert.notEqual(body.label, '', 'never blank - a state that degrades to nothing looks calm');
});

test('the reserved row is restyleable, and /display follows it', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({
      ...cfg,
      states: cfg.states.map((r) => (r.id === UNKNOWN_ID ? { ...r, label: 'NO SIGNAL', bgcolor: '#330000' } : r)),
    }),
  });
  await fetch(`${h.base}/state/${UNKNOWN_ID}`, { method: 'POST' });
  const body = await json(await fetch(`${h.base}/public/status`));
  // The fallback borrows whatever the owner chose to mean "something is wrong", rather
  // than a colour compiled into the page.
  assert.equal(body.label, 'NO SIGNAL');
  assert.equal(body.bgcolor, '#330000');
});

test('/ui is gone', async (t) => {
  const h = await boot(t);
  assert.equal((await fetch(`${h.base}/ui`)).status, 404);
});
