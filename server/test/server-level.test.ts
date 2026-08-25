import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { LightDriver } from '../src/driver.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import {
  defaultState,
  StateStore,
  type Confirmed,
  type Level,
  type PersistedState,
} from '../src/state.js';

class StubDriver implements LightDriver {
  calls: Level[] = [];
  async set(level: Level): Promise<Confirmed> {
    this.calls.push(level);
    return level;
  }
  async read(): Promise<Confirmed> {
    return this.calls.at(-1) ?? 'unknown';
  }
}

interface Harness {
  base: string;
  driver: StubDriver;
  store: StateStore;
  persisted: PersistedState[];
  close: () => Promise<void>;
}

async function boot(t: TestContext): Promise<Harness> {
  const driver = new StubDriver();
  const persisted: PersistedState[] = [];
  const store = new StateStore(defaultState());
  const deps: ServerDeps = { store, driver, persist: async (s) => void persisted.push(s), log: () => {} };
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

test('GET /status carries level, a derived intended, hold and ageSeconds', async (t) => {
  const h = await boot(t);
  const b = await status(h);
  assert.equal(b.level, 'dnd', 'the server boots on the safe rung');
  assert.equal(b.intended, 'on');
  assert.equal(b.hold, null);
  assert.equal(b.confirmed, 'unknown');
  assert.equal(typeof b.ageSeconds, 'number');
});

test('PUT /state accepts a level and drives it', async (t) => {
  const h = await boot(t);
  const res = await put(h, { level: 'interruptible', source: 'webui' });
  assert.equal(res.status, 200);
  const b = (await res.json()) as Record<string, unknown>;
  assert.equal(b.level, 'interruptible');
  assert.equal(b.intended, 'on', 'interruptible reads as on to a legacy client');
  assert.equal(b.confirmed, 'interruptible');
  assert.deepEqual(h.driver.calls, ['interruptible']);
});

test('PUT /state still accepts the legacy boolean, rounding true UP to dnd', async (t) => {
  const h = await boot(t);
  await put(h, { onAir: false, source: 'detector' });
  assert.equal((await status(h)).level, 'available');
  await put(h, { onAir: true, source: 'detector' });
  assert.equal((await status(h)).level, 'dnd');
});

test('PUT /state 400s when level and onAir disagree, rather than silently picking', async (t) => {
  const h = await boot(t);
  const res = await put(h, { onAir: true, level: 'available' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /disagree/);
});

test('PUT /state accepts level and onAir when they agree', async (t) => {
  const h = await boot(t);
  const res = await put(h, { onAir: true, level: 'interruptible' });
  assert.equal(res.status, 200);
  assert.equal((await status(h)).level, 'interruptible');
});

test('PUT /state 400s on an unknown level and on a body with neither field', async (t) => {
  const h = await boot(t);
  assert.equal((await put(h, { level: 'chartreuse' })).status, 400);
  const res = await put(h, { source: 'webui' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /level or onAir/);
});

test('POST /available, /interruptible and /dnd each set their rung', async (t) => {
  const h = await boot(t);
  for (const p of ['available', 'interruptible', 'dnd'] as const) {
    const res = await fetch(`${h.base}/${p}`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Record<string, unknown>).level, p);
  }
  assert.deepEqual(h.driver.calls, ['available', 'interruptible', 'dnd']);
});

test('POST /on maps to dnd and POST /off to available', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/off`, { method: 'POST' });
  assert.equal((await status(h)).level, 'available');
  await fetch(`${h.base}/on`, { method: 'POST' });
  assert.equal((await status(h)).level, 'dnd');
});

test('what is persisted carries a derived intended and confirmed unknown', async (t) => {
  const h = await boot(t);
  await put(h, { level: 'interruptible', source: 'webui' });
  const last = h.persisted.at(-1);
  assert.equal(last?.level, 'interruptible');
  assert.equal(last?.intended, 'on', 'rollback insurance must be on disk');
  assert.equal(last?.confirmed, 'unknown', 'the live confirmation is memory-only');
});

// --- the manual hold over the wire (D-19) ---

test('PUT /state with hold true pins the floor at that level', async (t) => {
  const h = await boot(t);
  await put(h, { level: 'interruptible', hold: true, source: 'manual' });
  const b = await status(h);
  assert.equal(b.hold, 'interruptible');
  assert.equal(b.level, 'interruptible');
});

test('a detector write below the floor is clamped up, and the device is driven to the floor', async (t) => {
  const h = await boot(t);
  await put(h, { level: 'interruptible', hold: true, source: 'manual' });
  h.driver.calls.length = 0;
  const res = await put(h, { level: 'available', source: 'detector' });
  assert.equal(((await res.json()) as Record<string, unknown>).level, 'interruptible');
  assert.deepEqual(h.driver.calls, ['interruptible'], 'the light must be driven to the clamped level, not the requested one');
});

test('the floor does not block escalation, and survives it', async (t) => {
  const h = await boot(t);
  await put(h, { level: 'interruptible', hold: true, source: 'manual' });
  await put(h, { level: 'dnd', source: 'detector' });
  let b = await status(h);
  assert.equal(b.level, 'dnd');
  assert.equal(b.hold, 'interruptible');
  await put(h, { level: 'available', source: 'detector' });
  b = await status(h);
  assert.equal(b.level, 'interruptible', 'the call ended, but the hold outlives it');
});

test('PUT /state with hold false clears the floor', async (t) => {
  const h = await boot(t);
  await put(h, { level: 'dnd', hold: true, source: 'manual' });
  await put(h, { level: 'available', hold: false, source: 'manual' });
  const b = await status(h);
  assert.equal(b.hold, null);
  assert.equal(b.level, 'available');
});

test('a floor at available is rejected with 400: it is a lever for forcing green', async (t) => {
  const h = await boot(t);
  const res = await put(h, { level: 'available', hold: true });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /hold/);
  assert.equal((await status(h)).hold, null);
});

test('PUT /state 400s on a non-boolean hold', async (t) => {
  const h = await boot(t);
  assert.equal((await put(h, { level: 'dnd', hold: 'yes' })).status, 400);
});

test('POST /interruptible?hold=1 pins the floor too', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/interruptible?hold=1&source=webui`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Record<string, unknown>).hold, 'interruptible');
});

test('POST /available?hold=0 releases the floor', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/dnd?hold=1`, { method: 'POST' });
  const res = await fetch(`${h.base}/available?hold=0`, { method: 'POST' });
  const b = (await res.json()) as Record<string, unknown>;
  assert.equal(b.hold, null);
  assert.equal(b.level, 'available');
});

test('the hold is persisted, so it survives a restart', async (t) => {
  const h = await boot(t);
  await put(h, { level: 'interruptible', hold: true, source: 'manual' });
  assert.equal(h.persisted.at(-1)?.hold, 'interruptible');
});

test('the hold does not decay: an aged store still reports it', async (t) => {
  const h = await boot(t);
  await put(h, { level: 'interruptible', hold: true, source: 'manual' });
  // Reach past FRESH_S without touching the hold.
  h.store.write('interruptible', 'manual', new Date(Date.now() + 10 * 60_000));
  const b = await status(h);
  assert.equal(b.hold, 'interruptible');
  assert.equal((b.ageSeconds as number) >= 0, true);
});
