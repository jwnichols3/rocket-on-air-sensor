import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightDriver } from '../src/driver.js';
import { startSupervisor } from '../src/supervise.js';
import { defaultState, StateStore, type Confirmed, type Level, type OnAirState } from '../src/state.js';

class FakeLight implements LightDriver {
  sets: Level[] = [];
  reads = 0;
  /** What the device reports. 'unknown' models an unreachable device. */
  device: Confirmed = 'dnd';
  /** When false, set() is accepted but does not take: models the silent-drop 200. */
  accepts = true;
  frames: boolean | null | undefined = undefined;

  async set(level: Level): Promise<Confirmed> {
    this.sets.push(level);
    if (this.device === 'unknown') return 'unknown'; // unreachable: the write goes nowhere
    if (this.accepts) this.device = level;
    return this.device;
  }
  async read(): Promise<Confirmed> {
    this.reads++;
    return this.device;
  }
  async repainted(): Promise<boolean | null> {
    return this.frames ?? null;
  }
}

interface Rig {
  store: StateStore;
  light: FakeLight;
  changes: OnAirState[];
  enqueued: number;
  stop: () => void;
}

function rig(over: Record<string, unknown> = {}, state?: OnAirState): Rig {
  const store = new StateStore(state ?? defaultState());
  const light = new FakeLight();
  const changes: OnAirState[] = [];
  const r = { store, light, changes, enqueued: 0 } as Rig;
  let chain: Promise<unknown> = Promise.resolve();
  const { stop } = startSupervisor({
    store,
    driver: light,
    enqueue: (run) => {
      r.enqueued++;
      chain = chain.then(run, run);
      return chain as Promise<void>;
    },
    onChange: (s) => changes.push(s),
    pollMs: 5,
    reassertMs: 25,
    decayMs: 20,
    log: () => {},
    ...over,
  });
  r.stop = stop;
  return r;
}

test('supervisor: the heartbeat keeps firing - lastAssertAt advances only on a successful set', async () => {
  const r = rig();
  await sleep(200);
  r.stop();
  // reassertMs is 25ms over a 200ms window. Advancing the clock on read() too would
  // leave this at exactly 1 forever, and the panel would go STALE in the healthy case.
  assert.equal(r.light.sets.length >= 3, true, `expected repeated heartbeats, got ${r.light.sets.length}`);
  assert.deepEqual([...new Set(r.light.sets)], ['dnd']);
});

test('supervisor: a mismatched device level triggers a re-assert', async () => {
  const r = rig();
  r.light.device = 'available'; // somebody poked the device directly
  await sleep(40);
  r.stop();
  assert.equal(r.light.sets.includes('dnd'), true);
  assert.equal(r.light.device, 'dnd', 'the device is pulled back to what the server intends');
});

test('supervisor: a stale, lower-ranked level is NOT asserted down onto a higher-ranked device', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), level: 'available' as const };
  const r = rig({}, old);
  r.light.device = 'dnd';
  await sleep(60);
  r.stop();
  assert.deepEqual(r.light.sets, [], 'a 1-hour-old available must never push a live dnd down');
  assert.equal(r.light.device, 'dnd');
});

test('supervisor: a fresh lower-ranked level IS asserted down - fresh evidence permits lowering', async () => {
  const fresh = { ...defaultState(), level: 'available' as const };
  const r = rig({}, fresh);
  r.light.device = 'dnd';
  await sleep(40);
  r.stop();
  assert.equal(r.light.sets.includes('available'), true);
  assert.equal(r.light.device, 'available');
});

test('supervisor: an unreachable device for longer than decayMs decays confirmed to unknown', async () => {
  const r = rig();
  r.store.setConfirmed('dnd');
  r.light.device = 'unknown';
  await sleep(80);
  r.stop();
  assert.equal(r.store.get().confirmed, 'unknown');
  assert.equal(r.changes.length >= 1, true, 'the decay is broadcast');
});

test('supervisor: confirmed reaches the wanted level once the device agrees', async () => {
  const r = rig();
  await sleep(40);
  r.stop();
  assert.equal(r.store.get().confirmed, 'dnd');
});

test('supervisor: a device that agrees but is not repainting confirms nothing', async () => {
  const r = rig();
  r.light.frames = false;
  r.store.setConfirmed('dnd');
  await sleep(40);
  r.stop();
  assert.equal(r.store.get().confirmed, 'unknown', 'confirmed must describe pixels, not a variable');
});

test('supervisor: every tick goes through the shared write queue', async () => {
  const r = rig();
  await sleep(40);
  r.stop();
  assert.equal(r.enqueued >= 3, true, `supervisor writes must serialise with HTTP writes, got ${r.enqueued}`);
});

test('supervisor: the withheld heartbeat - a stale available is not heartbeated to the device', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), level: 'available' as const };
  const r = rig({}, old);
  r.light.device = 'available'; // device already agrees, so no re-assert branch either
  await sleep(80);
  r.stop();
  assert.deepEqual(r.light.sets, [], 'withdraw the liveness assertion and let the device go STALE');
});

test('supervisor: stop() is synchronous and takes effect immediately', async () => {
  const r = rig();
  await sleep(30);
  const before = r.light.sets.length + r.light.reads;
  r.stop();
  await sleep(40);
  assert.equal(r.light.sets.length + r.light.reads <= before + 1, true, 'at most one in-flight tick finishes');
});
