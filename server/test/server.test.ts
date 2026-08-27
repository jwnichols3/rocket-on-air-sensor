import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightDriver } from '../src/driver.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID, type PersistedState } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: string[] = [];
  fail = false;
  /** When set, set() throws this value instead of an Error (tests non-Error throw handling). */
  throwValue: unknown = undefined;
  /** When set, set() waits for this promise to resolve before returning. */
  gate: Promise<void> | null = null;

  async set(stateId: string): Promise<string> {
    this.calls.push(stateId);
    if (this.gate) await this.gate;
    if (this.throwValue !== undefined) throw this.throwValue;
    if (this.fail) throw new Error('light unreachable');
    return stateId;
  }

  async read(): Promise<string> {
    return this.calls.at(-1) ?? UNKNOWN_ID;
  }
}

interface Harness {
  base: string;
  driver: StubDriver;
  persisted: PersistedState[];
  close: () => Promise<void>;
}

interface BootExtras {
  stateFile?: string;
  exitFn?: () => void;
}

/**
 * Every harness this file opens, so none can outlive the run.
 *
 * A test that throws before its `await h.close()` leaks a listening server, and the file
 * then sits for the whole test-runner timeout with nothing to show for it - a five-second
 * assertion failure reported after seventeen minutes. This has bitten twice. The sweep
 * below is the cheap structural fix; `close()` is idempotent enough that a second call
 * just rejects, so swallow it.
 */
const opened: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(opened.map((close) => close().catch(() => {})));
});

async function boot(token?: string, log?: (line: string) => void, extras?: BootExtras): Promise<Harness> {
  const driver = new StubDriver();
  const persisted: PersistedState[] = [];
  const deps: ServerDeps = {
    store: new StateStore({ ...defaultState(), state: 'available' }, new StateTable()),
    driver,
    persist: async (state) => {
      persisted.push(state);
    },
    token,
    log,
    stateFile: extras?.stateFile,
    exitFn: extras?.exitFn,
  };
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.closeIdleConnections();
      server.close((e) => (e ? reject(e) : resolve()));
    });
  opened.push(close);
  return { base: `http://127.0.0.1:${address.port}`, driver, persisted, close };
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
    body: JSON.stringify({ state: 'on-air', source: 'auto:detector' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'on');
  assert.equal(body.state, 'on-air');
  assert.equal(body.confirmed, 'on-air');
  assert.equal(body.source, 'auto:detector');
  assert.equal(body.busy, true);
  assert.deepEqual(h.driver.calls, ['on-air']);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0]!.intended, 'on');
  assert.equal(h.persisted[0]!.confirmed, 'unknown');
  await h.close();
});

test('PUT /state does NOT default source - it is required and prefixed (D-41)', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ state: 'available' }) });
  const body = await res.json();
  assert.match(body.error, /source must be prefixed/);
  await h.close();
});

test('driver failure still succeeds the write with confirmed unknown', async () => {
  const h = await boot();
  h.driver.fail = true;
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ state: 'on-air', source: 'human:test' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'unknown');
  assert.equal(h.persisted.length, 1);
  await h.close();
});

test('driver failure is logged before confirmed is set to unknown', async () => {
  const lines: string[] = [];
  const h = await boot(undefined, (line) => lines.push(line));
  h.driver.fail = true;
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ state: 'on-air', source: 'human:test' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.confirmed, 'unknown');
  assert.ok(
    lines.some((line) => /driver\.set\(on-air\) failed/.test(line)),
    `expected a log line matching /driver\\.set\\(on-air\\) failed/, got: ${JSON.stringify(lines)}`,
  );
  await h.close();
});

test('POST /on and /off are human conveniences with ?source= override', async () => {
  const h = await boot();
  let body = await (await fetch(`${h.base}/on`, { method: 'POST' })).json();
  assert.equal(body.intended, 'on');
  assert.equal(body.state, 'on-air');
  // Optional here, unlike PUT /state, and unprefixed reads as human: (D-41).
  assert.equal(body.source, 'human:anonymous');
  body = await (await fetch(`${h.base}/off?source=shortcut`, { method: 'POST' })).json();
  assert.equal(body.intended, 'off');
  assert.equal(body.state, 'available');
  assert.equal(body.source, 'human:shortcut');
  assert.deepEqual(h.driver.calls, ['on-air', 'available']);
  await h.close();
});

test('malformed and invalid bodies get 400 with error shape', async () => {
  const h = await boot();
  const bad = await fetch(`${h.base}/state`, { method: 'PUT', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json()).error, 'string');
  const wrongType = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ state: 42, source: 'human:x' }) });
  assert.equal(wrongType.status, 400);
  assert.deepEqual(h.driver.calls, []);
  await h.close();
});

test('driver throwing a non-Error value still succeeds the write and logs the string', async () => {
  const lines: string[] = [];
  const h = await boot(undefined, (line) => lines.push(line));
  h.driver.throwValue = 'light offline';
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ state: 'on-air', source: 'human:test' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.confirmed, 'unknown');
  assert.ok(
    lines.some((line) => line.includes('light offline')),
    `expected a log line containing "light offline", got: ${JSON.stringify(lines)}`,
  );
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

test('auth gate runs before routing: unknown path 401s without a token, not 404', async () => {
  // Intentional ordering (see issue #7): checking auth before the route map means an
  // unauthenticated caller can't distinguish "wrong token" from "path doesn't exist",
  // so the route map isn't leaked to unauthenticated probes.
  const h = await boot('sekrit');
  assert.equal((await fetch(`${h.base}/nope`)).status, 401);
  await h.close();
});

test('createApiServer rejects an empty token', () => {
  const deps: ServerDeps = {
    store: new StateStore({ ...defaultState(), state: 'available' }, new StateTable()),
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
    body: JSON.stringify({ state: 'on-air', source: `human:${'x'.repeat(17 * 1024)}` }),
  });
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
  assert.deepEqual(h.driver.calls, []);
  await h.close();
});

test('PUT /state with no state field returns 400 and never calls the driver', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({}) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'body must contain state');
  assert.deepEqual(h.driver.calls, []);
  await h.close();
});

test('concurrent writes serialize: last write wins, driver calls and persists happen in arrival order', async () => {
  const h = await boot();
  let releaseGate: () => void = () => {};
  h.driver.gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  // Slow write: PUT /state {state:'on-air'} - blocks inside driver.set() until we release the gate.
  const slow = fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ state: 'on-air', source: 'human:test' }) });

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
    ['on-air'],
    'fast write must stay queued behind the slow write, not race through the driver',
  );

  // Let the slow write's driver.set() finish; the queue then lets the fast write run.
  releaseGate();

  const [slowRes, fastRes] = await Promise.all([slow, fast]);
  assert.equal(slowRes.status, 200);
  assert.equal(fastRes.status, 200);

  const status = await (await fetch(`${h.base}/status`)).json();
  assert.equal(status.intended, 'off');
  assert.equal(status.confirmed, 'available');

  assert.deepEqual(h.driver.calls, ['on-air', 'available']);
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
  await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ state: 'on-air', source: 'auto:detector' }) });
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
  // NOT a state word: the page holds no vocabulary since D-42/D-48 - the label arrives at
  // runtime, resolved from the table. Asserting one here would re-bake one in.
  assert.match(html, /public\/events/);
  // The client contract's two thresholds (D-91), which replaced the single 45s watchdog.
  assert.match(html, /CONNECTION_LOST_MS/);
  assert.match(html, /NO_DATA_MS/);
  await h.close();
});

test('token via query works on GETs only - a write must never put it in the logs', async () => {
  const h = await boot('sekrit');
  assert.equal((await fetch(`${h.base}/status?token=sekrit`)).status, 200);
  assert.equal((await fetch(`${h.base}/status?token=wrong`)).status, 401);
  assert.equal((await fetch(`${h.base}/display?token=sekrit`)).status, 200);
  const write = await fetch(`${h.base}/state?token=sekrit`, { method: 'PUT', body: JSON.stringify({ state: 'on-air', source: 'human:test' }) });
  assert.equal(write.status, 401); // writes require the header
  await h.close();
});

test('GET /ui is GONE - it is retired, not moved', async () => {
  const h = await boot();
  // D-35 retired it into the admin UI. A 404 rather than a redirect: there is no
  // equivalent page at another path, and pretending otherwise would send a bookmark
  // somewhere that does not answer the same question.
  assert.equal((await fetch(`${h.base}/ui`)).status, 404);
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

test('GET /admin/health returns health shape with stateFileWritable true for a not-yet-created but writable path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-admin-'));
  const stateFile = join(dir, 'state.json');
  const h = await boot(undefined, undefined, { stateFile });
  const res = await fetch(`${h.base}/admin/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.uptime, 'number');
  assert.equal(body.pid, process.pid);
  assert.equal(body.nodeVersion, process.version);
  assert.equal(typeof body.port, 'number');
  assert.ok(h.base.endsWith(`:${body.port}`));
  assert.equal(body.stateFileWritable, true);
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /admin/health reports stateFileWritable false when the state file directory is not writable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-admin-ro-'));
  chmodSync(dir, 0o555);
  const stateFile = join(dir, 'state.json');
  const h = await boot(undefined, undefined, { stateFile });
  try {
    const res = await fetch(`${h.base}/admin/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stateFileWritable, false);
  } finally {
    await h.close();
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /admin/health is token-gated like /status, including ?token=', async () => {
  const h = await boot('sekrit');
  assert.equal((await fetch(`${h.base}/admin/health`)).status, 401);
  assert.equal(
    (await fetch(`${h.base}/admin/health`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${h.base}/admin/health`, { headers: { authorization: 'Bearer sekrit' } })).status,
    200,
  );
  assert.equal((await fetch(`${h.base}/admin/health?token=sekrit`)).status, 200);
  await h.close();
});

test('POST /admin/restart returns 403 without a configured token and never calls exitFn', async () => {
  let calls = 0;
  const h = await boot(undefined, undefined, { exitFn: () => calls++ });
  const res = await fetch(`${h.base}/admin/restart`, { method: 'POST' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'restart requires ONAIR_TOKEN to be configured' });
  await sleep(10);
  assert.equal(calls, 0);
  await h.close();
});

test('POST /admin/restart returns 401 with a wrong token when a token is configured, and never calls exitFn', async () => {
  let calls = 0;
  const h = await boot('sekrit', undefined, { exitFn: () => calls++ });
  const res = await fetch(`${h.base}/admin/restart`, { method: 'POST' });
  assert.equal(res.status, 401);
  const wrong = await fetch(`${h.base}/admin/restart`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(wrong.status, 401);
  await sleep(10);
  assert.equal(calls, 0);
  await h.close();
});

test('POST /admin/restart returns 202 with the right token and calls exitFn exactly once after the response is received', async () => {
  let calls = 0;
  const h = await boot('sekrit', undefined, { exitFn: () => calls++ });
  const res = await fetch(`${h.base}/admin/restart`, {
    method: 'POST',
    headers: { authorization: 'Bearer sekrit' },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { restarting: true });
  await sleep(50);
  assert.equal(calls, 1);
  await h.close();
});

test('GET /admin/restart returns 405', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/admin/restart`);
  assert.equal(res.status, 405);
  await h.close();
});
