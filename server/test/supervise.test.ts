import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LightDriver } from '../src/driver.js';
import { startSupervisor } from '../src/supervise.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID, type OnAirState } from '../src/state.js';
import { waitFor } from './wait-for.js';

class FakeLight implements LightDriver {
  readonly host = '10.42.14.239';
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
  // reassertMs is 25ms. Advancing the clock on read() too would leave this at exactly 1
  // forever, and the panel would go STALE in the healthy case. Waited for rather than slept
  // for (#89): "the timer keeps firing" is a property, not a count inside a fixed window.
  await waitFor(() => r.light.sets.length >= 3, () => `expected repeated heartbeats, got ${r.light.sets.length}`);
  r.stop();
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

// ---------------------------------------------- the not-repainting line logs edges (#84)

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
const frozen = (lines: string[]): string[] => lines.filter((l) => l.includes('NOT REPAINTING'));
const back = (lines: string[]): string[] => lines.filter((l) => l.includes('REPAINTING after'));

test('supervisor: ten frozen ticks produce ONE stamped, host-named line (#84)', async () => {
  const lines: string[] = [];
  const r = rig({ log: (l: string) => lines.push(l) });
  r.light.frames = false;
  await waitFor(() => r.enqueued >= 10, () => `wanted 10 ticks, got ${r.enqueued}`);
  r.stop();
  // The whole point. This used to fire on every tick, so a panel frozen for an hour wrote
  // it 720 times at the default 5s poll - D-109's census, on a second component.
  assert.equal(frozen(lines).length, 1, lines.join('\n'));
  assert.match(frozen(lines)[0]!, ISO);
  assert.match(frozen(lines)[0]!, /10\.42\.14\.239/);
  assert.equal(back(lines).length, 0);
});

test('supervisor: the recovery line carries the elapsed time and the tick count (#84)', async () => {
  const lines: string[] = [];
  const r = rig({ log: (l: string) => lines.push(l) });
  r.light.frames = false;
  await waitFor(() => frozen(lines).length === 1, () => lines.join('\n'));
  await waitFor(() => r.enqueued >= 5, () => `wanted 5 ticks, got ${r.enqueued}`);
  r.light.frames = true;
  await waitFor(() => back(lines).length === 1, () => lines.join('\n'));
  r.stop();
  assert.equal(frozen(lines).length, 1, lines.join('\n'));
  assert.match(back(lines)[0]!, ISO);
  assert.match(back(lines)[0]!, /10\.42\.14\.239/);
  // esphome-driver.ts's "BACK after 3s and 45 failed calls" shape: how long, and how much.
  assert.match(back(lines)[0]!, /REPAINTING after \d+s and \d+ frozen ticks?/, back(lines)[0]);
});

test('supervisor: a FLAPPING panel logs per transition, not once (#84)', async () => {
  // A panel alternating between painting and frozen is a different fault from a dead one
  // and must not read like one. This is the case a "log it once ever" fix would hide.
  const lines: string[] = [];
  const r = rig({ log: (l: string) => lines.push(l) });
  for (let i = 0; i < 3; i++) {
    r.light.frames = false;
    await waitFor(() => frozen(lines).length === i + 1, () => lines.join('\n'));
    r.light.frames = true;
    await waitFor(() => back(lines).length === i + 1, () => lines.join('\n'));
  }
  r.stop();
  assert.equal(frozen(lines).length, 3, lines.join('\n'));
  assert.equal(back(lines).length, 3, lines.join('\n'));
});

test('supervisor: "cannot tell" is not recovery - a null reading logs nothing (#84)', async () => {
  const lines: string[] = [];
  const r = rig({ log: (l: string) => lines.push(l) });
  r.light.frames = false;
  await waitFor(() => frozen(lines).length === 1, () => lines.join('\n'));
  r.light.frames = null; // the driver cannot tell yet
  await waitFor(() => r.enqueued >= 8, () => `wanted 8 ticks, got ${r.enqueued}`);
  r.stop();
  // No evidence is not evidence of recovery. Logging a panel back to health it never
  // reached would put a lie in the one place a person goes to find out what happened.
  assert.equal(back(lines).length, 0, lines.join('\n'));
  assert.equal(frozen(lines).length, 1, lines.join('\n'));
});
