// #91: a Stream Deck button that darkens the panel, and one that lights it again.
//
// The SCHEDULE stays device-local (D-111) - its times and its enable switch are on the
// panel's own page and appear nowhere in this API. The manual OVERRIDE is here, because the
// thing asking for it is a button in another room, and a setting nobody can reach is not a
// setting.
//
// What this file is really guarding is that the override cannot become a way to tell a lie.
// A dark panel must report `confirmed: unknown` with reason `asleep` however it got dark, or
// the server is claiming a confirmation of pixels nobody can see - which is #82, reopened.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_PASSPHRASE } from '../src/auth.js';
import type { LightDriver } from '../src/driver.js';
import { EsphomeTextDriver } from '../src/esphome-driver.js';
import { UNKNOWN_ID } from '../src/state.js';
import { waitFor } from './wait-for.js';

/** The header that takes D-24's local waiver off the table, so a credential is demanded. */
const REMOTE = { origin: 'http://10.42.14.189:9099' };

/** A panel that applies its state writes and honours the sleep switch, like the real one. */
async function fakePanel(t: TestContext) {
  let key = 'unknown';
  let sleeping = false;
  let reachable = true;
  // The panel REFUSES a sleep while the current row is busy: the switch goes on, the glass
  // stays lit. That is the firmware's rule (#91) and the reason #91 shipped two buttons
  // instead of a toggle - so a toggle has to be tested against it, not around it.
  let refuse = false;
  // Dark with the manual switch OFF: the nightly schedule, which is device-local (D-111) and
  // which the server can only ever learn about by reading the glass.
  let scheduled = false;
  const switchCalls: string[] = [];
  const server: Server = createServer((req, res) => {
    if (!reachable) return; // accept, never answer
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/switch/PanelSleep/')) {
      switchCalls.push(u.pathname);
      sleeping = u.pathname.endsWith('turn_on');
      res.writeHead(200).end();
      return;
    }
    if (req.method === 'POST' && u.pathname === '/text/PresenceKey/set') {
      key = u.searchParams.get('value') ?? '';
      res.writeHead(200, { 'content-length': '0' }).end();
      return;
    }
    if (u.pathname === '/text_sensor/Night') {
      const dark = scheduled || (sleeping && !refuse);
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ state: dark ? 'dark' : refuse ? 'lit (sleep pending - busy or no data)' : 'lit (daytime)' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: key, value: 7 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    switchCalls,
    isSleeping: () => sleeping,
    goAway: () => {
      reachable = false;
    },
    refuseSleep: (on: boolean) => {
      refuse = on;
    },
    goDarkOnSchedule: (on: boolean) => {
      scheduled = on;
    },
  };
}

async function boot(t: TestContext, driver: LightDriver, pollMs = 1_000_000) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-panel-'));
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config.json'),
    port: 0,
    driver,
    log: () => {},
    supervise: { pollMs },
  });
  t.after(() => app.close().catch(() => {}));
  return { app, base: `http://127.0.0.1:${app.port}` };
}

const post = (base: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers });

test('#91 POST /panel/sleep and /panel/wake drive the panel switch', async (t) => {
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 500, log: () => {} }));

  const slept = await post(h.base, '/panel/sleep');
  assert.equal(slept.status, 200);
  assert.deepEqual(await slept.json(), { ok: true, delivered: true, asked: 'sleep', wasDark: null });
  assert.equal(panel.isSleeping(), true);

  const woke = await post(h.base, '/panel/wake');
  assert.equal(woke.status, 200);
  assert.deepEqual(await woke.json(), { ok: true, delivered: true, asked: 'wake', wasDark: null });
  assert.equal(panel.isSleeping(), false);

  assert.deepEqual(panel.switchCalls, ['/switch/PanelSleep/turn_on', '/switch/PanelSleep/turn_off']);
});

test('#91 a MANUAL sleep is reported as asleep, exactly like the scheduled one', async (t) => {
  // The point of the whole ticket. A panel dark by a button press and a panel dark by the
  // clock are the same darkness, and the server must not claim a confirmation of either.
  // If this ever passes for the scheduled path and fails here, #82 is back on one of them.
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 500, log: () => {} }), 25);

  await post(h.base, '/state/on-air');
  await waitFor(async () => ((await (await fetch(`${h.base}/status`)).json()) as { confirmed: string }).confirmed === 'on-air',
    'the panel never confirmed the lit state');

  await post(h.base, '/panel/sleep');
  await waitFor(
    async () => ((await (await fetch(`${h.base}/status`)).json()) as { confirmedReason?: string }).confirmedReason === 'asleep',
    'a manual sleep did not reach confirmedReason',
  );
  const dark = (await (await fetch(`${h.base}/status`)).json()) as Record<string, unknown>;
  assert.equal(dark.confirmed, UNKNOWN_ID, 'the server claimed a confirmation of a dark panel');
  assert.equal(dark.state, 'on-air', 'and the STATE is untouched - sleeping is not a state write');

  await post(h.base, '/panel/wake');
  await waitFor(
    async () => ((await (await fetch(`${h.base}/status`)).json()) as { confirmed: string }).confirmed === 'on-air',
    'the panel never came back',
  );
  const lit = (await (await fetch(`${h.base}/status`)).json()) as Record<string, unknown>;
  assert.equal(lit.confirmedReason, undefined, 'a stale reason survived the wake');
});

test('#91 an unreachable panel is 200 with delivered:false, never a 5xx', async (t) => {
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 120, retries: 0, log: () => {} }));
  panel.goAway();

  const res = await post(h.base, '/panel/sleep');
  // A 5xx would tell the caller to retry a command that may well have landed, and a deck
  // button reporting failure on a command the panel took is worse than one that says
  // "asked - now read the status". Same shape as `confirmed`, same reason (section 7).
  assert.equal(res.status, 200);
  // `wasDark` is null and not false: /panel/sleep never asked the glass anything. Only the
  // toggle reads it, and reporting `false` here would be a reading nobody took.
  assert.deepEqual(await res.json(), { ok: true, delivered: false, asked: 'sleep', wasDark: null });
});

test('#91 a driver that cannot darken a panel says so, rather than pretending', async (t) => {
  class NoSleep implements LightDriver {
    async set(id: string): Promise<string> {
      return id;
    }
    async read(): Promise<string> {
      return UNKNOWN_ID;
    }
  }
  const h = await boot(t, new NoSleep());
  const res = await post(h.base, '/panel/sleep');
  assert.equal(res.status, 501);
  assert.match(((await res.json()) as { error: string }).error, /cannot darken/);
});

test('#91 the routes are gated and are POST-only', async (t) => {
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 500, log: () => {} }));

  // Darkening the panel is a write to the light. It sits behind the passphrase like every
  // other one - a LAN neighbour must not be able to blank the on-air display.
  const anon = await post(h.base, '/panel/sleep', REMOTE);
  assert.equal(anon.status, 401);
  assert.equal(panel.switchCalls.length, 0, 'an unauthenticated request reached the device');

  // AUTHENTICATION COMES FIRST, and that ordering is the point rather than an accident: an
  // unauthenticated caller gets 401 for a wrong method too, so probing the routes tells them
  // nothing about which verbs exist.
  const unauthGet = await fetch(`${h.base}/panel/sleep`, { headers: REMOTE });
  assert.equal(unauthGet.status, 401, 'a wrong method leaked past the credential check');

  const wrongMethod = await fetch(`${h.base}/panel/sleep?passphrase=${DEFAULT_PASSPHRASE}`, { headers: REMOTE });
  assert.equal(wrongMethod.status, 405);
  assert.equal(panel.switchCalls.length, 0, 'a GET reached the device');
});

// #92: one button that does both.
//
// #91 argued against a toggle and the argument was sound for the toggle it had in mind - one
// that remembers its own presses. The panel refuses a sleep while the row is busy, so a
// press-counting toggle desynchronises on the first refusal and stays wrong until somebody
// notices. This toggle READS THE GLASS every time and flips what it finds, which is a
// different mechanism with a different failure mode, and these tests are that distinction.

test('#92 the toggle reads the glass and flips it, both ways', async (t) => {
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 500, log: () => {} }));

  const first = await post(h.base, '/panel/toggle');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, delivered: true, asked: 'sleep', wasDark: false });
  assert.equal(panel.isSleeping(), true);

  const second = await post(h.base, '/panel/toggle');
  assert.deepEqual(await second.json(), { ok: true, delivered: true, asked: 'wake', wasDark: true });
  assert.equal(panel.isSleeping(), false);

  assert.deepEqual(panel.switchCalls, ['/switch/PanelSleep/turn_on', '/switch/PanelSleep/turn_off']);
});

test('#92 a REFUSED sleep does not desynchronise the toggle', async (t) => {
  // The exact failure #91 predicted, aimed at the design that has an answer for it. The
  // press lands on the switch, the busy rule keeps the glass lit, and the NEXT press must
  // still mean sleep - because the glass is still lit and that is the only thing consulted.
  // A toggle that counted presses would send wake here, at a panel nobody ever darkened.
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 500, log: () => {} }));
  panel.refuseSleep(true);

  assert.deepEqual(await (await post(h.base, '/panel/toggle')).json(), {
    ok: true,
    delivered: true,
    asked: 'sleep',
    wasDark: false,
  });
  const again = await post(h.base, '/panel/toggle');
  assert.deepEqual(await again.json(), { ok: true, delivered: true, asked: 'sleep', wasDark: false });
  assert.deepEqual(panel.switchCalls, ['/switch/PanelSleep/turn_on', '/switch/PanelSleep/turn_on']);
});

test('#92 pressing it at a panel dark on its own schedule wakes the panel', async (t) => {
  // 23:30. The glass is dark, the MANUAL switch is off, and a human pointing at a dark panel
  // and pressing a button means "light that up". A toggle that flipped the manual switch
  // would send sleep and nothing visible would happen - the exact button that teaches an
  // operator the deck is broken.
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 500, log: () => {} }));
  panel.goDarkOnSchedule(true);
  assert.equal(panel.isSleeping(), false, 'the manual switch must be off for this test to mean anything');

  const res = await post(h.base, '/panel/toggle');
  assert.deepEqual(await res.json(), { ok: true, delivered: true, asked: 'wake', wasDark: true });
  assert.deepEqual(panel.switchCalls, ['/switch/PanelSleep/turn_off']);
});

test('#92 a panel that cannot be read is assumed lit, and the press is a sleep', async (t) => {
  // `glassDark()` returns null when it cannot tell. Guessing LIT sends sleep, which is the
  // recoverable direction: the busy rule still lights the panel for a call, and one more
  // press wakes it. Guessing DARK would send wake at a panel already lit, which looks like
  // a dead button.
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 120, retries: 0, log: () => {} }));
  panel.goAway();

  const res = await post(h.base, '/panel/toggle');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, delivered: false, asked: 'sleep', wasDark: false });
});

test('#92 the toggle is gated and POST-only, like its two siblings', async (t) => {
  const panel = await fakePanel(t);
  const h = await boot(t, new EsphomeTextDriver({ host: panel.host, timeoutMs: 500, log: () => {} }));

  const anon = await post(h.base, '/panel/toggle', REMOTE);
  assert.equal(anon.status, 401);
  assert.equal(panel.switchCalls.length, 0, 'an unauthenticated request reached the device');

  const wrongMethod = await fetch(`${h.base}/panel/toggle?passphrase=${DEFAULT_PASSPHRASE}`, { headers: REMOTE });
  assert.equal(wrongMethod.status, 405);
  assert.equal(panel.switchCalls.length, 0, 'a GET reached the device');
});

test('#92 a driver that cannot darken a panel refuses the toggle too', async (t) => {
  class NoSleep implements LightDriver {
    async set(id: string): Promise<string> {
      return id;
    }
    async read(): Promise<string> {
      return UNKNOWN_ID;
    }
  }
  const h = await boot(t, new NoSleep());
  const res = await post(h.base, '/panel/toggle');
  assert.equal(res.status, 501);
  assert.match(((await res.json()) as { error: string }).error, /cannot darken/);
});
