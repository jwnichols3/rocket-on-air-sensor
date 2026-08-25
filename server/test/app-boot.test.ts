import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import { defaultState, levelToOnOff, type Confirmed, type Level, type PersistedState } from '../src/state.js';

class FakeLight implements LightDriver {
  sets: Level[] = [];
  reads = 0;
  device: Confirmed = 'unknown';
  async set(level: Level): Promise<Confirmed> {
    this.sets.push(level);
    if (this.device === 'unknown' && this.unreachable) return 'unknown';
    this.device = level;
    return level;
  }
  async read(): Promise<Confirmed> {
    this.reads++;
    return this.device;
  }
  unreachable = false;
}

async function stateFileWith(state: Partial<PersistedState> & { level: Level }, ageMs = 0): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), 'onair-boot-')), 'state.json');
  const base = defaultState(new Date(Date.now() - ageMs));
  const out: PersistedState = { ...base, ...state, intended: levelToOnOff(state.level) };
  await writeFile(file, JSON.stringify(out), 'utf8');
  return file;
}

async function boot(t: TestContext, opts: Partial<AppOptions> & { stateFile: string }) {
  const app = await createApp({ port: 0, log: () => {}, ...opts });
  t.after(() => app.close());
  return app;
}

test('boot with no state file starts at dnd and asserts it onto the light', async (t) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-boot-')), 'state.json');
  const light = new FakeLight();
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().level, 'dnd', 'ENOENT is not proof that nobody is on a call');
  assert.deepEqual(light.sets, ['dnd']);
});

test('boot re-applies a fresh persisted level onto the light', async (t) => {
  const stateFile = await stateFileWith({ level: 'interruptible' });
  const light = new FakeLight();
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().level, 'interruptible');
  assert.deepEqual(light.sets, ['interruptible']);
});

test('boot does NOT push a stale lower level onto a device showing a higher one', async (t) => {
  const stateFile = await stateFileWith({ level: 'available' }, 3600_000);
  const light = new FakeLight();
  light.device = 'dnd'; // the device has been correctly showing dnd all along
  const app = await boot(t, { stateFile, driver: light });
  assert.deepEqual(light.sets, [], 'a 1-hour-old available must not turn a live dnd green');
  assert.equal(app.store.get().confirmed, 'dnd', 'adopt what the device says instead');
  // Adopting into `confirmed` alone is not enough: `level` is what every OTHER renderer
  // draws, so leaving it stale shows a green browser page beside a red panel. Raising is
  // always ladder-legal, and the device read is fresh evidence of the higher rung.
  assert.equal(app.store.get().level, 'dnd', 'the whole store adopts the device, not just confirmed');
  const body = (await (await fetch(`http://127.0.0.1:${app.port}/status`)).json()) as Record<string, unknown>;
  assert.equal(body.level, 'dnd');
  assert.equal(body.intended, 'on', 'no renderer may still be told OFF AIR');
});

test('boot DOES apply a stale HIGHER level: raising never needs fresh evidence', async (t) => {
  const stateFile = await stateFileWith({ level: 'dnd' }, 3600_000);
  const light = new FakeLight();
  light.device = 'available';
  await boot(t, { stateFile, driver: light });
  assert.deepEqual(light.sets, ['dnd']);
});

test('boot survives an unreachable light with confirmed unknown', async (t) => {
  const stateFile = await stateFileWith({ level: 'dnd' });
  const light = new FakeLight();
  light.unreachable = true;
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().confirmed, 'unknown');
});

test('boot restores a persisted hold', async (t) => {
  const stateFile = await stateFileWith({ level: 'interruptible', hold: 'interruptible' });
  const light = new FakeLight();
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().hold, 'interruptible');
  const body = (await (await fetch(`http://127.0.0.1:${app.port}/status`)).json()) as Record<string, unknown>;
  assert.equal(body.hold, 'interruptible');
});

test('a corrupt state file boots at dnd with an explanatory message rather than crash-looping', async (t) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-boot-')), 'state.json');
  await writeFile(stateFile, '{not json', 'utf8');
  const light = new FakeLight();
  const app = await boot(t, { stateFile, driver: light });
  assert.equal(app.store.get().level, 'dnd');
  assert.match(app.store.get().message ?? '', /quarantined/);
});
