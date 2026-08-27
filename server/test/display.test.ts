import assert from 'node:assert/strict';
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

test('the page keeps the stale badge, the DISCONNECTED overlay and the ~45s watchdog', () => {
  assert.match(DISPLAY_HTML, /WATCHDOG_SILENT_MS = 45000/);
  assert.match(DISPLAY_HTML, /DISCONNECTED/);
  assert.match(DISPLAY_HTML, /STALE/);
  assert.match(DISPLAY_HTML, /body\.stale/);
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
  for (const forbidden of ['hold', 'source', 'confirmed']) {
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
