import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import { defaultState, StateTable, UNKNOWN_ID, type PersistedState } from '../src/state.js';

const TABLE = new StateTable();

class FakeLight implements LightDriver {
  sets: string[] = [];
  reads = 0;
  device: string = UNKNOWN_ID;
  unreachable = false;
  async set(stateId: string): Promise<string> {
    this.sets.push(stateId);
    if (this.unreachable) return UNKNOWN_ID;
    this.device = stateId;
    return stateId;
  }
  async read(): Promise<string> {
    this.reads++;
    return this.device;
  }
}

async function stateFileWith(state: Partial<PersistedState> & { state: string }, ageMs = 0): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), 'onair-boot-')), 'state.json');
  const base = defaultState(new Date(Date.now() - ageMs));
  const out: PersistedState = {
    ...base,
    ...state,
    intended: TABLE.busy(state.state) ? 'on' : 'off',
    tableVersion: TABLE.version,
  };
  await writeFile(file, JSON.stringify(out), 'utf8');
  return file;
}

async function boot(t: TestContext, opts: Partial<AppOptions> & { stateFile: string }) {
  const app = await createApp({ port: 0, log: () => {}, ...opts });
  t.after(() => app.close());
  return app;
}

test('boot with no state file starts at unknown and asserts it onto the light', async (t) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-boot-')), 'state.json');
  const light = new FakeLight();
  const app = await boot(t, { stateFile, driver: light });
  // ENOENT is not proof that nobody is on a call. `unknown` is busy, so this is the
  // conspicuous answer rather than the calm one.
  assert.equal(app.store.get().state, UNKNOWN_ID);
  assert.equal(app.store.status().busy, true);
  assert.deepEqual(light.sets, [UNKNOWN_ID]);
});

test('boot re-applies a fresh persisted state onto the light', async (t) => {
  const stateFile = await stateFileWith({ state: 'recording' });
  const light = new FakeLight();
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().state, 'recording');
  assert.deepEqual(light.sets, ['recording']);
});

test('boot pushes an OLD calm state onto a device showing a busy one, and adopts nothing (D-91)', async (t) => {
  const stateFile = await stateFileWith({ state: 'available' }, 120_000);
  const light = new FakeLight();
  light.device = 'on-air';
  const app = await boot(t, { stateFile, driver: light });
  // The file is the last explicit write. Whatever the device holds is an echo of an
  // earlier one, so there is nothing here to adopt and no clock to consult.
  assert.equal(app.store.get().state, 'available');
  assert.equal(app.store.get().confirmed, 'available');
  assert.deepEqual(light.sets, ['available'], 'the latched state is re-applied at any age');
});

test('boot applies an OLD BUSY state too: the latch does not care which way it points', async (t) => {
  const stateFile = await stateFileWith({ state: 'on-air' }, 120_000);
  const light = new FakeLight();
  light.device = 'available';
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().state, 'on-air');
  assert.deepEqual(light.sets, ['on-air']);
});

test('boot re-asserts a FRESH calm state even over a busy device', async (t) => {
  const stateFile = await stateFileWith({ state: 'available' }, 1_000);
  const light = new FakeLight();
  light.device = 'on-air';
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().state, 'available', 'fresh evidence is allowed to go calm');
  assert.deepEqual(light.sets, ['available']);
});

test('boot does not adopt a device holding a key outside the table', async (t) => {
  const stateFile = await stateFileWith({ state: 'available' }, 120_000);
  const light = new FakeLight();
  light.device = 'focus-block';
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().state, 'available', 'a key nobody knows is not evidence to adopt');
  assert.deepEqual(light.sets, ['available']);
});

test('boot survives an unreachable light with confirmed unknown', async (t) => {
  const stateFile = await stateFileWith({ state: 'on-air' });
  const light = new FakeLight();
  light.unreachable = true;
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().state, 'on-air');
  assert.equal(app.store.get().confirmed, UNKNOWN_ID);
});

test('boot restores a persisted hold', async (t) => {
  const stateFile = await stateFileWith({ state: 'interruptible', hold: 'interruptible' });
  const app = await boot(t, { stateFile, driver: new FakeLight() });
  assert.equal(app.store.get().hold, 'interruptible');
});

test('a v1 state file boots on the migrated row, not on unknown', async (t) => {
  const file = join(await mkdtemp(join(tmpdir(), 'onair-boot-')), 'state.json');
  await writeFile(file, JSON.stringify({
    intended: 'on', confirmed: 'unknown', level: 'dnd', source: 'webui', hold: null,
    updatedAt: new Date().toISOString(), message: null,
  }), 'utf8');
  const light = new FakeLight();
  const app = await boot(t, { stateFile: file, driver: light });
  assert.equal(app.store.get().state, 'on-air');
  assert.deepEqual(light.sets, ['on-air'], 'the live panel keeps saying the same thing across the upgrade');
});

test('a corrupt state file boots at unknown with an explanatory message rather than crash-looping', async (t) => {
  const stateFile = await stateFileWith({ state: 'on-air' });
  await writeFile(stateFile, 'not json', 'utf8');
  const app = await boot(t, { stateFile, driver: new FakeLight() });
  assert.equal(app.store.get().state, UNKNOWN_ID);
  assert.match(app.store.get().message ?? '', /quarantined/);
});
