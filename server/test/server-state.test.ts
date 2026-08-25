import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { LightDriver } from '../src/driver.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID, type PersistedState } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: string[] = [];
  async set(stateId: string): Promise<string> {
    this.calls.push(stateId);
    return stateId;
  }
  async read(): Promise<string> {
    return this.calls.at(-1) ?? UNKNOWN_ID;
  }
}

interface Harness {
  base: string;
  driver: StubDriver;
  store: StateStore;
  persisted: PersistedState[];
  close: () => Promise<void>;
}

async function boot(t: TestContext, over: Partial<ServerDeps> = {}): Promise<Harness> {
  const driver = new StubDriver();
  const persisted: PersistedState[] = [];
  const store = new StateStore(defaultState(), new StateTable());
  const deps: ServerDeps = { store, driver, persist: async (s) => void persisted.push(s), log: () => {}, ...over };
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  // Registered up front so a failing assertion cannot leak a listening server and hang
  // the whole run. close() is idempotent enough: a second call rejects, so swallow it.
  t.after(() => close().catch(() => {}));
  return { base: `http://127.0.0.1:${addr.port}`, driver, store, persisted, close };
}

function put(h: Harness, body: unknown): Promise<Response> {
  return fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify(body) });
}

async function status(h: Harness): Promise<Record<string, unknown>> {
  return (await (await fetch(`${h.base}/status`)).json()) as Record<string, unknown>;
}

// ------------------------------------------------------------- the v2 object

test('GET /status returns the v2 object, with every derived field', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const s = await status(h);
  assert.equal(s.state, 'on-air');
  assert.equal(s.busy, true);
  assert.equal(s.intended, 'on');
  assert.equal(s.confirmed, 'on-air');
  assert.equal(s.hold, null);
  assert.equal(s.source, 'auto:vcrec');
  assert.equal(s.stale, false);
  assert.equal(s.tableVersion, 1);
  assert.equal(typeof s.ageSeconds, 'number');
});

test('the state payload carries NO presentation (D-42)', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const s = await status(h);
  for (const field of ['label', 'color', 'bgcolor', 'description', 'order']) {
    assert.equal(field in s, false, `${field} must not be on the state payload`);
  }
});

test('level and onAir are GONE from the wire', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'available', source: 'human:test' });
  const s = await status(h);
  assert.equal('level' in s, false);
  assert.equal('onAir' in s, false);
});

// ------------------------------------------------------------- PUT /state

test('PUT /state sets the row and drives it onto the light', async (t) => {
  const h = await boot(t);
  const res = await put(h, { state: 'recording', source: 'auto:vcrec' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.state, 'recording');
  assert.equal(body.busy, true);
  assert.deepEqual(h.driver.calls, ['recording']);
});

test('PUT /state is idempotent - a repeat just refreshes updatedAt', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const first = (await status(h)).updatedAt;
  await new Promise((r) => setTimeout(r, 1100));
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const second = (await status(h)).updatedAt;
  assert.notEqual(first, second);
  assert.equal((await status(h)).state, 'on-air');
});

test('an unknown state id is 400 and LISTS the valid ids - never accept-and-fall-back', async (t) => {
  const h = await boot(t);
  const res = await put(h, { state: 'dnd', source: 'auto:vcrec' });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; validStates: string[] };
  assert.match(body.error, /unknown state 'dnd'/);
  assert.deepEqual(body.validStates, ['available', 'on-air', 'interruptible', 'recording', 'unknown']);
  // The typo must not have moved anything.
  assert.equal((await status(h)).state, UNKNOWN_ID);
  assert.deepEqual(h.driver.calls, [], 'and must never have reached the light');
});

test('a missing state is 400', async (t) => {
  const h = await boot(t);
  assert.equal((await put(h, { source: 'auto:vcrec' })).status, 400);
});

test('PUT /state REQUIRES a prefixed source', async (t) => {
  const h = await boot(t);
  for (const source of [undefined, 'vcrec', 'detector', 'robot:x', '']) {
    const res = await put(h, { state: 'on-air', source });
    assert.equal(res.status, 400, `source ${JSON.stringify(source)} must be rejected`);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /source must be prefixed auto: or human:/);
  }
  assert.deepEqual(h.driver.calls, [], 'a rejected write never reaches the light');
});

test('PUT /state 400s on a non-boolean hold', async (t) => {
  const h = await boot(t);
  assert.equal((await put(h, { state: 'on-air', source: 'human:x', hold: 'yes' })).status, 400);
});

test('PUT /state with hold true pins, and hold false releases', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'interruptible', source: 'human:ui', hold: true });
  assert.equal((await status(h)).hold, 'interruptible');
  await put(h, { state: 'interruptible', source: 'human:ui', hold: false });
  assert.equal((await status(h)).hold, null);
});

test('pinning at available is legal now - it cannot force calm against a live camera', async (t) => {
  const h = await boot(t);
  const res = await put(h, { state: 'available', source: 'human:ui', hold: true });
  assert.equal(res.status, 200);
  assert.equal((await status(h)).hold, 'available');
});

// -------------------------------------------------------- POST /state/{id}

test('POST /state/{id} sets that row, with no body', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/state/recording`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await status(h)).state, 'recording');
});

test('POST /state/{id} defaults source to human:anonymous', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:anonymous');
});

test('POST /state/{id} takes an unprefixed source as human:, unlike PUT /state', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air?source=menubar`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:menubar');
});

test('POST /state/{id} still reads bare "detector" as auto:, not human:', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air?source=detector`, { method: 'POST' });
  assert.equal((await status(h)).source, 'auto:detector');
});

test('POST /state/{id} on an unknown id is 400 with the valid ids', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/state/dnd`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.deepEqual(((await res.json()) as { validStates: string[] }).validStates.includes('on-air'), true);
});

test('POST /state/{id} takes ?hold=1 and ?hold=0', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/interruptible?hold=1`, { method: 'POST' });
  assert.equal((await status(h)).hold, 'interruptible');
  await fetch(`${h.base}/state/interruptible?hold=0`, { method: 'POST' });
  assert.equal((await status(h)).hold, null);
});

test('GET /state/{id} is 405, not 404: the path is known, the method is not', async (t) => {
  const h = await boot(t);
  assert.equal((await fetch(`${h.base}/state/on-air`)).status, 405);
});

test('the retired rung routes are gone', async (t) => {
  const h = await boot(t);
  for (const path of ['/available', '/interruptible', '/dnd']) {
    assert.equal((await fetch(`${h.base}${path}`, { method: 'POST' })).status, 404, `${path} must be gone`);
  }
});

// ------------------------------------------------------------ /on and /off

test('/on and /off resolve through the configured shortcut rows', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/on`, { method: 'POST' });
  assert.equal((await status(h)).state, 'on-air');
  await fetch(`${h.base}/off`, { method: 'POST' });
  assert.equal((await status(h)).state, 'available');
});

test('an unset shortcut is 409, never a guess', async (t) => {
  const h = await boot(t, { shortcuts: { on: null, off: null } });
  for (const path of ['/on', '/off']) {
    const res = await fetch(`${h.base}${path}`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, new RegExp(`no shortcut row is configured for ${path}`));
  }
  // "Fall back to the first row" is a bad rule when the first row is ON AIR.
  assert.equal((await status(h)).state, UNKNOWN_ID);
});

test('a shortcut naming a row that no longer exists is 400, not a silent miss', async (t) => {
  const h = await boot(t, { shortcuts: { on: 'deleted-row', off: 'available' } });
  const res = await fetch(`${h.base}/on`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('/on and /off accept ?source= and default to human:anonymous', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/on?source=human:shortcut`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:shortcut');
  await fetch(`${h.base}/off`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:anonymous');
});

// ------------------------------------------------------------- persistence

test('what is persisted carries a derived intended, tableVersion and confirmed unknown', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const last = h.persisted.at(-1)!;
  assert.equal(last.state, 'on-air');
  assert.equal(last.intended, 'on');
  assert.equal(last.tableVersion, 1);
  assert.equal(last.confirmed, UNKNOWN_ID);
});

test('an unreachable light is not a failed write (§7)', async (t) => {
  const dead: LightDriver = { set: async () => UNKNOWN_ID, read: async () => UNKNOWN_ID };
  const h = await boot(t, { driver: dead });
  const res = await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal(res.status, 200, 'the write succeeded');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.state, 'on-air');
  assert.equal(body.confirmed, UNKNOWN_ID, 'and the failure surfaces here');
});

test('a device holding a key outside the table never becomes confirmed', async (t) => {
  const liar: LightDriver = { set: async () => 'focus-block', read: async () => 'focus-block' };
  const h = await boot(t, { driver: liar });
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal((await status(h)).confirmed, UNKNOWN_ID);
});
