import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import { UNKNOWN_ID } from '../src/state.js';

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

test('state survives a restart and boot re-applies it to the driver', async (t: TestContext) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');

  const driver1 = new StubDriver();
  const app1 = await createApp({ stateFile, port: 0, driver: driver1, log: () => {} });
  // Registered before the first assertion: a throw between here and close() would
  // otherwise leak a listening server and hang the whole run for minutes.
  t.after(() => app1.close().catch(() => {}));
  assert.deepEqual(driver1.calls, [UNKNOWN_ID], 'boot re-applies the default, which is unknown');
  const res = await fetch(`http://127.0.0.1:${app1.port}/state`, {
    method: 'PUT',
    body: JSON.stringify({ state: 'on-air', source: 'auto:detector' }),
  });
  assert.equal(res.status, 200);
  await app1.close();

  const driver2 = new StubDriver();
  const app2 = await createApp({ stateFile, port: 0, driver: driver2, log: () => {} });
  t.after(() => app2.close().catch(() => {}));
  assert.deepEqual(driver2.calls, ['on-air'], 'boot re-applies the persisted state');
  const body = (await (await fetch(`http://127.0.0.1:${app2.port}/status`)).json()) as Record<string, unknown>;
  assert.equal(body.state, 'on-air');
  assert.equal(body.busy, true);
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'on-air');
  assert.equal(body.source, 'auto:detector');
  await app2.close();
});

class FailingDriver implements LightDriver {
  async set(): Promise<string> {
    throw new Error('light unreachable');
  }
  async read(): Promise<string> {
    throw new Error('light unreachable');
  }
}

test('boot driver re-apply failure is logged and confirmed stays unknown', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const lines: string[] = [];
  const app = await createApp({
    stateFile,
    port: 0,
    driver: new FailingDriver(),
    log: (line) => lines.push(line),
  });
  const body = await (await fetch(`http://127.0.0.1:${app.port}/status`)).json();
  assert.equal(body.confirmed, 'unknown');
  assert.ok(
    lines.some((line) => /boot driver re-apply failed/.test(line)),
    `expected a log line matching /boot driver re-apply failed/, got: ${JSON.stringify(lines)}`,
  );
  await app.close();
});

test('the env credential gates the API end to end, for a client that is not local', async (t) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const app = await createApp({ stateFile, port: 0, token: 'tok', driver: new StubDriver(), log: () => {} });
  t.after(() => app.close().catch(() => {}));
  const base = `http://127.0.0.1:${app.port}`;
  // An Origin that is not ours is what a non-local client looks like from here, and it is
  // what takes the D-24 waiver off the table. Without it every request from this test
  // process is a genuine local one and is correctly waived - see auth.test.ts.
  const remote = { origin: 'http://10.42.14.189:9099' };

  assert.equal((await fetch(`${base}/status`, { headers: remote })).status, 401);
  assert.equal(
    (await fetch(`${base}/status`, { headers: { ...remote, authorization: 'Bearer tok' } })).status,
    200,
    'ONAIR_TOKEN keeps working - it is folded in as the passphrase, not a second gate',
  );
  // ...and locally it is waived, with no credential at all (D-24).
  assert.equal((await fetch(`${base}/status`)).status, 200);
  await app.close();
});

test('message survives a restart', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const app1 = await createApp({ stateFile, port: 0, driver: new StubDriver(), log: () => {} });
  await fetch(`http://127.0.0.1:${app1.port}/message`, { method: 'PUT', body: JSON.stringify({ text: 'BRB' }) });
  await app1.close();
  const app2 = await createApp({ stateFile, port: 0, driver: new StubDriver(), log: () => {} });
  const body = await (await fetch(`http://127.0.0.1:${app2.port}/status`)).json();
  assert.equal(body.message, 'BRB');
  await app2.close();
});

test('close() completes while an SSE client is connected', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const app = await createApp({ stateFile, port: 0, driver: new StubDriver(), log: () => {} });
  const res = await fetch(`http://127.0.0.1:${app.port}/events`);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  await res.body?.cancel();
  await app.close(); // must resolve despite the open stream
});
