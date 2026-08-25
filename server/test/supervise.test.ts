import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightDriver } from '../src/driver.js';
import { startSupervisor } from '../src/supervise.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID, type OnAirState } from '../src/state.js';

class FakeLight implements LightDriver {
  sets: string[] = [];
  reads = 0;
  /** What the device reports. `unknown` models an unreachable device. */
  device: string = 'on-air';
  /** When false, set() is accepted but does not take: models the silent-drop 200. */
  accepts = true;
  frames: boolean | null | undefined = undefined;

  async set(stateId: string): Promise<string> {
    this.sets.push(stateId);
    if (this.device === UNKNOWN_ID) return UNKNOWN_ID; // unreachable: the write goes nowhere
    if (this.accepts) this.device = stateId;
    return this.device;
  }
  async read(): Promise<string> {
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
  const store = new StateStore(state ?? { ...defaultState(), state: 'on-air' }, new StateTable());
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
  assert.deepEqual([...new Set(r.light.sets)], ['on-air']);
});

test('supervisor: a mismatched device state triggers a re-assert', async () => {
  const r = rig();
  r.light.device = 'available'; // somebody poked the device directly
  await sleep(40);
  r.stop();
  assert.equal(r.light.sets.includes('on-air'), true);
  assert.equal(r.light.device, 'on-air', 'the device is pulled back to what the server intends');
});

test('supervisor: a stale CALM state is NOT asserted onto a device showing a busy one', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'on-air';
  await sleep(60);
  r.stop();
  // THE BUSY RULE. The point is never "make no calls" - it is never to go CALM on stale
  // evidence. Once the store adopts the device's state, heartbeating it back is healthy.
  assert.equal(r.light.sets.includes('available'), false, 'a 1-hour-old available must never calm a live on-air');
  assert.equal(r.light.device, 'on-air');
  // Deferring must not mean "disagree forever". Leaving `state` stale strands every other
  // renderer on the old value - the browser page reads calm while the panel reads ON AIR -
  // and the supervisor re-logs the same deferral every tick with nothing converging.
  assert.equal(r.store.get().state, 'on-air', 'the store adopts the device it just deferred to');
  assert.equal(r.store.get().confirmed, 'on-air', 'and can then confirm it');
});

test('supervisor: a FRESH calm state IS asserted - fresh evidence permits going calm', async () => {
  const fresh = { ...defaultState(), state: 'available' };
  const r = rig({}, fresh);
  r.light.device = 'on-air';
  await sleep(40);
  r.stop();
  assert.equal(r.light.sets.includes('available'), true);
  assert.equal(r.light.device, 'available');
});

test('supervisor: a device holding a key outside the table is never adopted', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'focus-block';
  await sleep(60);
  r.stop();
  // A key nobody recognises is a stale firmware or a hand-poked entity, not evidence.
  // Re-assert over it rather than adopting a state this server cannot reason about.
  assert.equal(r.store.get().state, 'available');
  assert.equal(r.light.sets.includes('available'), true);
});

test('supervisor: an unreachable device for longer than decayMs decays confirmed to unknown', async () => {
  const r = rig();
  r.store.setConfirmed('on-air');
  r.light.device = UNKNOWN_ID;
  await sleep(80);
  r.stop();
  assert.equal(r.store.get().confirmed, UNKNOWN_ID);
  assert.equal(r.changes.length >= 1, true, 'the decay is broadcast');
});

test('supervisor: confirmed reaches the wanted state once the device agrees', async () => {
  const r = rig();
  await sleep(40);
  r.stop();
  assert.equal(r.store.get().confirmed, 'on-air');
});

test('supervisor: a device that agrees but is not repainting confirms nothing', async () => {
  const r = rig();
  r.light.frames = false;
  r.store.setConfirmed('on-air');
  await sleep(40);
  r.stop();
  assert.equal(r.store.get().confirmed, UNKNOWN_ID, 'confirmed must describe pixels, not a variable');
});

test('supervisor: every tick goes through the shared write queue', async () => {
  const r = rig();
  await sleep(40);
  r.stop();
  assert.equal(r.enqueued >= 3, true, `supervisor writes must serialise with HTTP writes, got ${r.enqueued}`);
});

test('supervisor: the withheld heartbeat - a stale available is not heartbeated to the device', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
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
