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

// ------------------------------------------------- THE PIN RULE, over HTTP

async function pin(h: Harness, at: string): Promise<void> {
  await put(h, { state: at, source: 'human:ui', hold: true });
}

test('while pinned, an auto write that would go calm is 409 - with the state that won', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');
  const res = await put(h, { state: 'available', source: 'auto:vcrec' });
  assert.equal(res.status, 409);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body.error), /held at 'interruptible'/);
  // The refusal carries the current status, so the client can see what stands without a
  // second round trip. This is the system working, not a fault to retry.
  assert.equal(body.state, 'interruptible');
  assert.equal(body.hold, 'interruptible');
  assert.deepEqual(h.driver.calls, ['interruptible'], 'the refused write never reached the light');
});

test('while pinned calm, an auto ESCALATION to busy is allowed, and the pin survives it', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');
  const res = await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.state, 'on-air');
  assert.equal(body.hold, 'interruptible', 'the pin survives the escalation');
});

test('pinned to a busy row, nothing automated moves it', async (t) => {
  const h = await boot(t);
  await pin(h, 'recording');
  for (const target of ['available', 'interruptible', 'on-air']) {
    assert.equal((await put(h, { state: target, source: 'auto:vcrec' })).status, 409, target);
  }
  assert.equal((await status(h)).state, 'recording');
});

test('a human write always applies while pinned, and one naming another state releases it', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');
  const res = await put(h, { state: 'available', source: 'human:menubar' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.state, 'available');
  assert.equal(body.hold, null, 'a human naming another state releases the pin');
});

test('an auto source touching the hold at all is 403', async (t) => {
  const h = await boot(t);
  for (const hold of [true, false]) {
    const res = await put(h, { state: 'on-air', source: 'auto:vcrec', hold });
    assert.equal(res.status, 403);
    assert.match(String(((await res.json()) as { error: string }).error), /only a human/);
  }
  assert.deepEqual(h.driver.calls, [], 'and it never reached the light');
});

test('?hold=1 from an auto source on the convenience route is 403 too', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/state/on-air?source=auto:vcrec&hold=1`, { method: 'POST' });
  assert.equal(res.status, 403);
});

test('the convenience routes are subject to the pin rule as well', async (t) => {
  const h = await boot(t);
  await pin(h, 'recording');
  // `?source=detector` is the one bare legacy value that reads as auto: - so it is bound by
  // the pin exactly like a prefixed automated writer, which is the point of mapping it.
  assert.equal((await fetch(`${h.base}/state/available?source=detector`, { method: 'POST' })).status, 409);
  // ...while an unprefixed source is a human and gets through.
  assert.equal((await fetch(`${h.base}/state/available?source=menubar`, { method: 'POST' })).status, 200);
});

test('/off is refused by a pin, since it resolves to a calm row', async (t) => {
  const h = await boot(t);
  await pin(h, 'recording');
  assert.equal((await fetch(`${h.base}/off?source=auto:vcrec`, { method: 'POST' })).status, 409);
});

test('THE REGRESSION: "I am interruptible today" survives a meeting, over HTTP', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');

  // A call starts. calm -> busy, so the carve-out lets the detector through.
  assert.equal((await put(h, { state: 'on-air', source: 'auto:vcrec' })).status, 200);
  assert.equal((await status(h)).state, 'on-air');
  assert.equal((await status(h)).hold, 'interruptible');

  // The call ends and the detector writes calm. Refused.
  assert.equal((await put(h, { state: 'available', source: 'auto:vcrec' })).status, 409);

  // The light did not go calm, and the pin still stands.
  const s = await status(h);
  assert.equal(s.hold, 'interruptible');
  assert.equal(h.driver.calls.includes('available'), false, 'the light was never driven calm');
});

test('with no pin, an auto write goes calm freely - the pin is the only thing that refuses', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal((await put(h, { state: 'available', source: 'auto:vcrec' })).status, 200);
  assert.equal((await status(h)).state, 'available');
});

test('a pin does not decay: an aged store still refuses', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');
  // Age the write without touching the hold. No TTL, no decay, no auto-anything (D-6).
  h.store.write('interruptible', { kind: 'human', label: 'ui', raw: 'human:ui' }, new Date(Date.now() - 3600_000), true);
  assert.equal((await status(h)).stale, true, 'staleness is VISIBLE...');
  assert.equal((await put(h, { state: 'available', source: 'auto:vcrec' })).status, 409, '...and never acted on');
  assert.equal((await status(h)).hold, 'interruptible');
});

test('a refused auto write SETTLES BACK to the held row - it does not strand the escalation', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');
  await put(h, { state: 'on-air', source: 'auto:vcrec' });        // call starts, allowed
  assert.equal((await status(h)).state, 'on-air');

  const res = await put(h, { state: 'available', source: 'auto:vcrec' }); // call ends
  assert.equal(res.status, 409, 'the requested state was not applied');
  const body = (await res.json()) as Record<string, unknown>;
  // "...and the held state stands" (D-32). Leaving `on-air` standing would be a false ON
  // that never clears - the meeting is over and nothing will ever move the light again
  // until a human does. The pin is what the system falls back TO, not merely a veto.
  assert.equal(body.state, 'interruptible');
  assert.equal(body.hold, 'interruptible');
  assert.equal((await status(h)).state, 'interruptible');
  assert.equal(h.driver.calls.at(-1), 'interruptible', 'and the light was driven there');
});

test('the settle-back is attributed to the pin, not to the refused writer', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  await put(h, { state: 'available', source: 'auto:vcrec' });
  assert.equal((await status(h)).source, 'human:hold', 'the pin decided this, and says so');
});

test('a refusal that is already at the held row changes nothing', async (t) => {
  const h = await boot(t);
  await pin(h, 'recording');
  const before = h.driver.calls.length;
  assert.equal((await put(h, { state: 'available', source: 'auto:vcrec' })).status, 409);
  assert.equal((await status(h)).state, 'recording');
  assert.equal(h.driver.calls.length, before, 'no pointless re-drive of the light');
});

test('a 403 changes nothing at all - it is an authority fault, not a pin decision', async (t) => {
  const h = await boot(t);
  await pin(h, 'interruptible');
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal((await put(h, { state: 'available', source: 'auto:vcrec', hold: false })).status, 403);
  assert.equal((await status(h)).state, 'on-air', 'no settle-back on a 403');
  assert.equal((await status(h)).hold, 'interruptible');
});
