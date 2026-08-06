import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightDriver } from '../src/driver.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import { defaultState, StateStore, type Confirmed, type OnAirState } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: boolean[] = [];
  fail = false;
  /** When set, set() waits for this promise to resolve before returning. */
  gate: Promise<void> | null = null;

  async set(onAir: boolean): Promise<Confirmed> {
    this.calls.push(onAir);
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('light unreachable');
    return onAir ? 'on' : 'off';
  }
}

interface Harness {
  base: string;
  driver: StubDriver;
  persisted: OnAirState[];
  close: () => Promise<void>;
}

async function boot(token?: string): Promise<Harness> {
  const driver = new StubDriver();
  const persisted: OnAirState[] = [];
  const deps: ServerDeps = {
    store: new StateStore(defaultState()),
    driver,
    persist: async (state) => {
      persisted.push(state);
    },
    token,
  };
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    driver,
    persisted,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test('GET /status returns state plus ageSeconds', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'off');
  assert.equal(body.confirmed, 'unknown');
  assert.equal(typeof body.ageSeconds, 'number');
  await h.close();
});

test('PUT /state turns on, persists, and reports driver confirmation', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, {
    method: 'PUT',
    body: JSON.stringify({ onAir: true, source: 'detector' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'on');
  assert.equal(body.source, 'detector');
  assert.deepEqual(h.driver.calls, [true]);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0]!.intended, 'on');
  assert.equal(h.persisted[0]!.confirmed, 'unknown');
  await h.close();
});

test('PUT /state defaults source to manual', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: false }) });
  const body = await res.json();
  assert.equal(body.source, 'manual');
  await h.close();
});

test('driver failure still succeeds the write with confirmed unknown', async () => {
  const h = await boot();
  h.driver.fail = true;
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: true }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'unknown');
  assert.equal(h.persisted.length, 1);
  await h.close();
});

test('POST /on and /off are manual conveniences with ?source= override', async () => {
  const h = await boot();
  let body = await (await fetch(`${h.base}/on`, { method: 'POST' })).json();
  assert.equal(body.intended, 'on');
  assert.equal(body.source, 'manual');
  body = await (await fetch(`${h.base}/off?source=shortcut`, { method: 'POST' })).json();
  assert.equal(body.intended, 'off');
  assert.equal(body.source, 'shortcut');
  assert.deepEqual(h.driver.calls, [true, false]);
  await h.close();
});

test('malformed and invalid bodies get 400 with error shape', async () => {
  const h = await boot();
  const bad = await fetch(`${h.base}/state`, { method: 'PUT', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json()).error, 'string');
  const wrongType = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: 'yes' }) });
  assert.equal(wrongType.status, 400);
  assert.deepEqual(h.driver.calls, []);
  await h.close();
});

test('unknown path 404, wrong method 405', async () => {
  const h = await boot();
  assert.equal((await fetch(`${h.base}/nope`)).status, 404);
  assert.equal((await fetch(`${h.base}/status`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${h.base}/on`)).status, 405);
  await h.close();
});

test('token gate: 401 without or with wrong bearer, 200 with right one', async () => {
  const h = await boot('sekrit');
  assert.equal((await fetch(`${h.base}/status`)).status, 401);
  assert.equal(
    (await fetch(`${h.base}/status`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${h.base}/status`, { headers: { authorization: 'Bearer sekrit' } })).status,
    200,
  );
  await h.close();
});

test('createApiServer rejects an empty token', () => {
  const deps: ServerDeps = {
    store: new StateStore(defaultState()),
    driver: new StubDriver(),
    persist: async () => {},
    token: '',
  };
  assert.throws(() => createApiServer(deps));
});

test('PUT /state body over 16KB returns 400 with an error string', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, {
    method: 'PUT',
    body: JSON.stringify({ onAir: true, source: 'x'.repeat(17 * 1024) }),
  });
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
  assert.deepEqual(h.driver.calls, []);
  await h.close();
});

test('PUT /state with no onAir field returns 400 and never calls the driver', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({}) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'onAir must be a boolean');
  assert.deepEqual(h.driver.calls, []);
  await h.close();
});

test('concurrent writes serialize: last write wins, driver calls and persists happen in arrival order', async () => {
  const h = await boot();
  let releaseGate: () => void = () => {};
  h.driver.gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  // Slow write: PUT /state {onAir:true} - blocks inside driver.set() until we release the gate.
  const slow = fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: true }) });

  // Wait until the slow write has actually reached driver.set() (i.e. it's holding the write
  // queue) before firing the second write, so the arrival order is deterministic.
  while (h.driver.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  // Clear the gate so it can no longer be blamed for blocking the fast write's driver call -
  // if the fast write's driver.set() runs at all before we release the slow write, it must be
  // because the queue let it through, not because a shared gate happened to hold it back too.
  h.driver.gate = null;

  // Fast write arrives second but its driver call would resolve immediately once it runs.
  const fast = fetch(`${h.base}/off`, { method: 'POST' });

  // Yield briefly. Without the write queue, the fast write's driver.set() would run now (its
  // own gate is null) and this assertion would fail.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    h.driver.calls,
    [true],
    'fast write must stay queued behind the slow write, not race through the driver',
  );

  // Let the slow write's driver.set() finish; the queue then lets the fast write run.
  releaseGate();

  const [slowRes, fastRes] = await Promise.all([slow, fast]);
  assert.equal(slowRes.status, 200);
  assert.equal(fastRes.status, 200);

  const status = await (await fetch(`${h.base}/status`)).json();
  assert.equal(status.intended, 'off');
  assert.equal(status.confirmed, 'off');

  assert.deepEqual(h.driver.calls, [true, false]);
  assert.equal(h.persisted.length, 2);
  assert.equal(h.persisted[0]!.intended, 'on');
  assert.equal(h.persisted[1]!.intended, 'off');

  await h.close();
});

test('PUT /message sets, DELETE clears; on-air fields untouched', async () => {
  const h = await boot();
  const set = await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'BE QUIET' }) });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.equal(setBody.message, 'BE QUIET');
  assert.equal(setBody.intended, 'off');
  assert.equal(h.persisted.at(-1)!.message, 'BE QUIET');
  const del = await fetch(`${h.base}/message`, { method: 'DELETE' });
  assert.equal((await del.json()).message, null);
  const delAgain = await fetch(`${h.base}/message`, { method: 'DELETE' });
  assert.equal(delAgain.status, 200); // idempotent
  await h.close();
});

test('message write persists confirmed as unknown even after a driver ack', async () => {
  const h = await boot();
  await fetch(`${h.base}/on`, { method: 'POST' }); // StubDriver acks -> confirmed "on" in memory
  await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'HI' }) });
  assert.equal(h.persisted.at(-1)!.confirmed, 'unknown');
  assert.equal(h.persisted.at(-1)!.message, 'HI');
  await h.close();
});

test('PUT /message validation: missing, empty, oversized text get 400', async () => {
  const h = await boot();
  for (const body of [JSON.stringify({}), JSON.stringify({ text: '' }), JSON.stringify({ text: 'x'.repeat(201) })]) {
    const res = await fetch(`${h.base}/message`, { method: 'PUT', body });
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, 'string');
  }
  await h.close();
});

test('heartbeat re-PUT of /state leaves the message intact', async () => {
  const h = await boot();
  await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'BE QUIET' }) });
  await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: true, source: 'detector' }) });
  const status = await (await fetch(`${h.base}/status`)).json();
  assert.equal(status.message, 'BE QUIET');
  assert.equal(status.intended, 'on');
  await h.close();
});

test('GET /display serves the self-contained page', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/display`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /EventSource/);
  assert.match(html, /ON AIR/);
  assert.match(html, /WATCHDOG_SILENT_MS/);
  await h.close();
});

test('token via query works on GETs only', async () => {
  const h = await boot('sekrit');
  assert.equal((await fetch(`${h.base}/status?token=sekrit`)).status, 200);
  assert.equal((await fetch(`${h.base}/status?token=wrong`)).status, 401);
  assert.equal((await fetch(`${h.base}/display?token=sekrit`)).status, 200);
  const write = await fetch(`${h.base}/state?token=sekrit`, { method: 'PUT', body: JSON.stringify({ onAir: true }) });
  assert.equal(write.status, 401); // writes require the header
  await h.close();
});

test('GET /events sends a snapshot then an event per write', async () => {
  const h = await boot();
  const controller = new AbortController();
  const eventsPromise = (async () => {
    const res = await fetch(`${h.base}/events`, { signal: controller.signal });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events: Array<Record<string, unknown>> = [];
    while (events.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine !== undefined) events.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
      }
    }
    return events;
  })();
  await sleep(50);
  await fetch(`${h.base}/on`, { method: 'POST' });
  await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'HI' }) });
  const events = await eventsPromise;
  assert.equal(events[0]!.intended, 'off'); // snapshot
  assert.equal(events[1]!.intended, 'on'); // after POST /on
  assert.equal(events[2]!.message, 'HI'); // after PUT /message
  controller.abort();
  await h.close();
});
