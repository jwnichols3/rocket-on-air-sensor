import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import type { Confirmed, Level } from '../src/state.js';

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

test('state survives a restart and boot re-applies intended to the driver', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');

  const driver1 = new StubDriver();
  const app1 = await createApp({ stateFile, port: 0, driver: driver1, log: () => {} });
  assert.deepEqual(driver1.calls, ['dnd']); // boot re-applies the default, which is dnd
  const res = await fetch(`http://127.0.0.1:${app1.port}/state`, {
    method: 'PUT',
    body: JSON.stringify({ onAir: true, source: 'detector' }),
  });
  assert.equal(res.status, 200);
  await app1.close();

  const driver2 = new StubDriver();
  const app2 = await createApp({ stateFile, port: 0, driver: driver2, log: () => {} });
  assert.deepEqual(driver2.calls, ['dnd']); // boot re-applies the persisted level
  const body = await (await fetch(`http://127.0.0.1:${app2.port}/status`)).json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'dnd');
  assert.equal(body.source, 'detector');
  await app2.close();
});

class FailingDriver implements LightDriver {
  async set(): Promise<Confirmed> {
    throw new Error('light unreachable');
  }
  async read(): Promise<Confirmed> {
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

test('token from options gates the API end to end', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const app = await createApp({ stateFile, port: 0, token: 'tok', driver: new StubDriver(), log: () => {} });
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/status`)).status, 401);
  assert.equal(
    (await fetch(`http://127.0.0.1:${app.port}/status`, { headers: { authorization: 'Bearer tok' } })).status,
    200,
  );
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
