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

test('supervisor: an OLD calm state is asserted over a busy device, and never adopted (D-91)', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'on-air';
  await sleep(60);
  r.stop();
  // The server latches. Age is not evidence, the device is a renderer rather than a
  // source, and whatever it holds arrived from an earlier assertion by this server.
  assert.equal(r.light.sets.includes('available'), true, 'the latched state is asserted at any age');
  assert.equal(r.light.device, 'available');
  assert.equal(r.store.get().state, 'available', 'the store never adopts the device');
});

test('supervisor: a FRESH calm state IS asserted - age changes nothing either way', async () => {
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

test('supervisor: a driver that THROWS is logged, never fatal, and confirmed still decays (D-92)', async () => {
  // Push is a notification, not a delivery guarantee. A panel that is not listening must
  // not abandon the tick before the `confirmed` bookkeeping, or a device that fell over
  // freezes `confirmed` at its last good value forever instead of admitting ignorance.
  class DeadLight implements LightDriver {
    async set(): Promise<string> {
      throw new Error('connect ECONNREFUSED');
    }
    async read(): Promise<string> {
      throw new Error('fetch failed');
    }
  }
  const lines: string[] = [];
  const r = rig({ driver: new DeadLight(), log: (l: string) => lines.push(l) });
  r.store.setConfirmed('on-air');
  await sleep(80);
  r.stop();
  assert.equal(r.store.get().confirmed, UNKNOWN_ID, 'no evidence is reported as unknown, not held');
  assert.equal(lines.some((l) => /failed: (fetch failed|connect ECONNREFUSED)/.test(l)), true, lines.join('\n'));
  assert.equal(lines.some((l) => /^\[supervisor\] Error/.test(l)), false, 'the throw never escapes the tick');
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

test('supervisor: there is no withheld heartbeat - an old available is still heartbeated', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'available'; // device already agrees, so this is the heartbeat alone
  await sleep(80);
  r.stop();
  assert.equal(r.light.sets.includes('available'), true, 'the heartbeat does not expire (D-91)');
});

test('supervisor: stop() is synchronous and takes effect immediately', async () => {
  const r = rig();
  await sleep(30);
  const before = r.light.sets.length + r.light.reads;
  r.stop();
  await sleep(40);
  assert.equal(r.light.sets.length + r.light.reads <= before + 1, true, 'at most one in-flight tick finishes');
});

// ------------------------------------------- THE LATCH, at its edges (D-91)

test('no clock decides what the state is: age is reported and nothing branches on it', async () => {
  const at = (ageMs: number) => new StateStore({ ...defaultState(new Date(Date.now() - ageMs)), state: 'available' }, new StateTable());
  assert.equal(at(91_000).status().ageSeconds >= 91, true, 'the fact is served');
  assert.equal(at(91_000).status().state, 'available', 'and the state is untouched by it');
  assert.equal('stale' in at(91_000).status(), false, 'the judgement is not served at all');
});

test('an old BUSY state IS still heartbeated - unchanged by D-91, for a different reason', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'on-air' };
  const r = rig({}, old);
  r.light.device = 'on-air';
  await sleep(80);
  r.stop();
  assert.equal(r.light.sets.includes('on-air'), true, 'the withheld heartbeat is for CALM states only');
});

test('no auto-raise: an old calm state is asserted as itself, never escalated on its own', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'available';
  await sleep(80);
  r.stop();
  // The server does NOT invent a busy state to be safe - that would be a state change
  // nobody asked for, and this system changes state only on an explicit write (D-6, D-91).
  assert.equal(r.light.sets.every((v) => v === 'available'), true);
  assert.equal(r.store.get().state, 'available', 'age is visible, never acted on');
});

test('no TTL: the supervisor never rewrites state on a timer', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'available';
  const before = r.store.get().updatedAt;
  await sleep(80);
  r.stop();
  assert.equal(r.store.get().updatedAt, before, 'only an explicit write moves updatedAt');
});
