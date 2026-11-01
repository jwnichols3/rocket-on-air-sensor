// D-152: call claims. Several Macs report "in a call" to one Receiver, and the light stays
// ON AIR until the LAST one leaves. Rocket, 2026-11-01: "the state should remain on-air until
// all computers exit zoom" - and a row set by hand during a call survives the call's end.
//
// The load-bearing tests are the multi-Mac one, the hand-set one, the restart one and the
// concurrent one. Each is a false OFF if it regresses.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { LightDriver } from '../src/driver.js';
import { loadState, saveState } from '../src/persist.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID, type OnAirState, type PersistedState } from '../src/state.js';

class SlowDriver implements LightDriver {
  calls: string[] = [];
  constructor(private readonly delayMs = 0) {}
  async set(stateId: string): Promise<string> {
    this.calls.push(stateId);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return stateId;
  }
  async read(): Promise<string> {
    return this.calls.at(-1) ?? UNKNOWN_ID;
  }
}

interface Harness {
  base: string;
  driver: SlowDriver;
  store: StateStore;
  persisted: PersistedState[];
}

async function boot(
  t: TestContext,
  opts: { driver?: SlowDriver; initial?: OnAirState; table?: StateTable; shortcuts?: ServerDeps['shortcuts'] } = {},
): Promise<Harness> {
  const persisted: PersistedState[] = [];
  const driver = opts.driver ?? new SlowDriver();
  const store = new StateStore(opts.initial ?? { ...defaultState(), state: 'available' }, opts.table ?? new StateTable());
  const deps: ServerDeps = {
    store, driver, persist: async (s) => void persisted.push(s), log: () => {},
    ...(opts.shortcuts ? { shortcuts: opts.shortcuts } : {}),
  };
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${addr.port}`, driver, store, persisted };
}

const report = (h: Harness, sensorId: string, inCall: boolean, source = `auto:call-detector-${sensorId}`): Promise<Response> =>
  fetch(`${h.base}/calls/${sensorId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inCall, source }),
  });

const setState = (h: Harness, state: string): Promise<Response> =>
  fetch(`${h.base}/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, source: 'human:companion' }),
  });

const status = async (h: Harness): Promise<{ state: string; source: string; calls: Array<{ sensorId: string }> }> =>
  (await (await fetch(`${h.base}/status`)).json()) as { state: string; source: string; calls: Array<{ sensorId: string }> };

test('D-152 one Mac: the first claim lights ON AIR and its end goes calm', async (t) => {
  const h = await boot(t);
  assert.equal((await report(h, 'studio', true)).status, 200);
  let s = await status(h);
  assert.equal(s.state, 'on-air');
  assert.equal(s.source, 'auto:call-detector-studio', 'the state write carries the reporting detector');
  assert.deepEqual(s.calls.map((c) => c.sensorId), ['studio']);

  await report(h, 'studio', false);
  s = await status(h);
  assert.equal(s.state, 'available');
  assert.deepEqual(s.calls, []);
});

test('D-152 TWO MACS: one leaving does not turn the light calm while the other is in the call', async (t) => {
  const h = await boot(t);
  await report(h, 'studio', true);
  await report(h, 'laptop', true);
  assert.equal((await status(h)).state, 'on-air');

  await report(h, 'laptop', false);
  const mid = await status(h);
  assert.equal(mid.state, 'on-air', 'FALSE OFF: the laptop left and the light went calm with the studio Mac still in the call');
  assert.deepEqual(mid.calls.map((c) => c.sensorId), ['studio']);

  await report(h, 'studio', false);
  assert.equal((await status(h)).state, 'available');
});

test('D-152 a repeated report is idempotent and writes nothing to the light', async (t) => {
  const h = await boot(t);
  await report(h, 'studio', true);
  const writes = h.driver.calls.length;
  await report(h, 'studio', true);
  await report(h, 'studio', true);
  assert.equal(h.driver.calls.length, writes, 'a retry re-drove the light');
  assert.equal((await status(h)).calls.length, 1);
});

test('D-152 a second Mac joining does not re-write the state', async (t) => {
  const h = await boot(t);
  await report(h, 'studio', true);
  const writes = h.driver.calls.length;
  await report(h, 'laptop', true);
  assert.equal(h.driver.calls.length, writes);
});

test('D-152 a row set BY HAND during the call survives the end of the call', async (t) => {
  const h = await boot(t);
  await report(h, 'studio', true);
  await setState(h, 'interruptible');
  await report(h, 'studio', false);
  const s = await status(h);
  assert.equal(s.state, 'interruptible', "the end of the call overwrote Rocket's choice");
  assert.deepEqual(s.calls, []);
});

test('D-152 recording set before the call is neither downgraded by the start nor cleared by the end', async (t) => {
  const h = await boot(t);
  await setState(h, 'recording');
  await report(h, 'studio', true);
  assert.equal((await status(h)).state, 'recording', 'a busy row was downgraded to on-air');
  await report(h, 'studio', false);
  assert.equal((await status(h)).state, 'recording', 'the end of the call cleared a row the call did not set');
});

test('D-152 "not in a call" from a Mac with no claim changes nothing', async (t) => {
  const h = await boot(t, { initial: { ...defaultState(), state: 'interruptible' } });
  const writes = h.driver.calls.length;
  assert.equal((await report(h, 'laptop', false)).status, 200);
  assert.equal((await status(h)).state, 'interruptible');
  assert.equal(h.driver.calls.length, writes);
});

test('D-152 CONCURRENT: the last two Macs leaving together produce exactly one calm write', async (t) => {
  const h = await boot(t, { driver: new SlowDriver(30) });
  await report(h, 'studio', true);
  await report(h, 'laptop', true);
  h.driver.calls.length = 0;
  await Promise.all([report(h, 'studio', false), report(h, 'laptop', false)]);
  assert.deepEqual(h.driver.calls, ['available']);
  assert.deepEqual((await status(h)).calls, []);
});

test('D-152 CONCURRENT: two Macs joining together produce exactly one ON write', async (t) => {
  const h = await boot(t, { driver: new SlowDriver(30) });
  h.driver.calls.length = 0;
  await Promise.all([report(h, 'studio', true), report(h, 'laptop', true)]);
  assert.deepEqual(h.driver.calls, ['on-air']);
  assert.equal((await status(h)).calls.length, 2);
});

test('D-152 a calm row deleted from the table is never guessed at: the claim clears, the light stays ON', async (t) => {
  const h = await boot(t, { shortcuts: { on: 'on-air', off: 'gone' } });
  await report(h, 'studio', true);
  await report(h, 'studio', false);
  const s = await status(h);
  assert.equal(s.state, 'on-air');
  assert.deepEqual(s.calls, []);
});

test('D-152 an unset call row records the claim and does not touch the state', async (t) => {
  const h = await boot(t, { shortcuts: { on: null, off: 'available' } });
  await report(h, 'studio', true);
  const s = await status(h);
  assert.equal(s.state, 'available');
  assert.equal(s.calls.length, 1);
});

test('D-152 DELETE clears a claim from a Mac that will not come back', async (t) => {
  const h = await boot(t);
  await report(h, 'laptop', true);
  const res = await fetch(`${h.base}/calls/laptop?source=human:admin`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const s = await status(h);
  assert.deepEqual(s.calls, []);
  assert.equal(s.state, 'available');
});

test('D-152 a bad request is a 400 and changes nothing', async (t) => {
  const h = await boot(t);
  const put = (path: string, body: string): Promise<Response> =>
    fetch(`${h.base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await put('/calls/Bad_Id', JSON.stringify({ inCall: true, source: 'auto:x' }))).status, 400);
  assert.equal((await put('/calls/studio', JSON.stringify({ inCall: 'yes', source: 'auto:x' }))).status, 400);
  assert.equal((await put('/calls/studio', JSON.stringify({ inCall: true }))).status, 400);
  assert.equal((await put('/calls/studio', JSON.stringify({ inCall: true, source: 'detector' }))).status, 400);
  assert.equal((await put('/calls/studio', '{not json')).status, 400);
  assert.equal((await fetch(`${h.base}/calls/studio`, { method: 'GET' })).status, 405);
  const s = await status(h);
  assert.deepEqual(s.calls, []);
  assert.equal(s.state, 'available');
});

test('D-152 PUT /state is unchanged: last write wins, and claims do not veto it', async (t) => {
  const h = await boot(t);
  await report(h, 'studio', true);
  assert.equal((await setState(h, 'available')).status, 200);
  const s = await status(h);
  assert.equal(s.state, 'available');
  assert.equal(s.calls.length, 1, 'a state write must not touch the claim set');
});

test('D-152 the public view does not carry the claim set', async (t) => {
  const h = await boot(t);
  await report(h, 'studio', true);
  const body = (await (await fetch(`${h.base}/public/status`)).json()) as Record<string, unknown>;
  assert.equal(body.calls, undefined);
  assert.equal(body.stateFromCalls, undefined);
});

test('D-152 stateFromCalls never reaches the wire', async (t) => {
  const h = await boot(t);
  await report(h, 'studio', true);
  const body = (await (await fetch(`${h.base}/status`)).json()) as Record<string, unknown>;
  assert.equal('stateFromCalls' in body, false);
});

test('D-152 RESTART: claims and ownership persist, so a second Mac leaving after a restart keeps the light ON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-calls-'));
  const file = join(dir, 'state.json');

  const h1 = await boot(t);
  await report(h1, 'studio', true);
  await report(h1, 'laptop', true);
  await saveState(file, h1.store.persisted());

  const loaded = await loadState(file);
  assert.ok(loaded);
  const h2 = await boot(t, { initial: loaded });
  assert.deepEqual((await status(h2)).calls.map((c) => c.sensorId), ['studio', 'laptop']);
  await report(h2, 'laptop', false);
  assert.equal((await status(h2)).state, 'on-air', 'a restart forgot the studio Mac was in the call');
  await report(h2, 'studio', false);
  assert.equal((await status(h2)).state, 'available', 'a restart forgot that the call mechanism owned the state');
});

test('D-152 a state file from before claims loads with an empty claim set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-calls-'));
  const file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ state: 'on-air', source: 'auto:vcrec', updatedAt: new Date().toISOString(), message: null }));
  const loaded = await loadState(file);
  assert.deepEqual(loaded?.calls, []);
  assert.equal(loaded?.stateFromCalls, undefined);
});

test('D-152 a malformed claim on disk is dropped and logged; the good ones and the state survive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-calls-'));
  const file = join(dir, 'state.json');
  const at = new Date().toISOString();
  await writeFile(file, JSON.stringify({
    state: 'on-air', source: 'auto:x', updatedAt: at, message: null, stateFromCalls: true,
    calls: [
      { sensorId: 'studio', source: 'auto:x', since: at, lastReportAt: at },
      { sensorId: 'BAD ID', source: 'auto:x', since: at, lastReportAt: at },
      { sensorId: 'studio', source: 'auto:dup', since: at, lastReportAt: at },
      'nonsense',
    ],
  }));
  const lines: string[] = [];
  const loaded = await loadState(file, (l) => lines.push(l));
  assert.equal(loaded?.state, 'on-air');
  assert.equal(loaded?.stateFromCalls, true);
  assert.deepEqual(loaded?.calls?.map((c) => c.sensorId), ['studio']);
  assert.equal(lines.filter((l) => l.includes('malformed call claim')).length, 3);
  // And the file is not rewritten or quarantined by the load.
  assert.ok((await readFile(file, 'utf8')).includes('BAD ID'));
});

test('D-152 store: busy current state skips the ON write and does not take ownership', () => {
  const store = new StateStore({ ...defaultState(), state: 'recording' }, new StateTable());
  const src = { kind: 'auto' as const, label: 'x', raw: 'auto:x' };
  const r = store.reportCall('studio', true, src, { on: 'on-air', off: 'available' });
  assert.equal(r.write, null);
  assert.match(r.skipped ?? '', /already busy/);
  assert.equal(store.get().stateFromCalls, undefined);
});
