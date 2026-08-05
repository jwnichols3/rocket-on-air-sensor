import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import type { Confirmed } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: boolean[] = [];
  async set(onAir: boolean): Promise<Confirmed> {
    this.calls.push(onAir);
    return onAir ? 'on' : 'off';
  }
}

test('state survives a restart and boot re-applies intended to the driver', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');

  const driver1 = new StubDriver();
  const app1 = await createApp({ stateFile, port: 0, driver: driver1, log: () => {} });
  assert.deepEqual(driver1.calls, [false]); // boot re-applies default OFF
  const res = await fetch(`http://127.0.0.1:${app1.port}/state`, {
    method: 'PUT',
    body: JSON.stringify({ onAir: true, source: 'detector' }),
  });
  assert.equal(res.status, 200);
  await app1.close();

  const driver2 = new StubDriver();
  const app2 = await createApp({ stateFile, port: 0, driver: driver2, log: () => {} });
  assert.deepEqual(driver2.calls, [true]); // boot re-applies persisted ON
  const body = await (await fetch(`http://127.0.0.1:${app2.port}/status`)).json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'on');
  assert.equal(body.source, 'detector');
  await app2.close();
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
