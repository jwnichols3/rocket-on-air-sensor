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
  /** The `Night` verdict. `null` is "cannot tell", which is the default everywhere else. */
  night: boolean | null = null;
  /** Count of glassDark() calls, so a test can blip exactly one of them. */
  nightReads = 0;
  /** When > 0, that many glassDark() calls fail (return null) - a dropped packet. */
  nightBlips = 0;

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
  async glassDark(): Promise<boolean | null> {
    this.nightReads++;
    if (this.nightBlips > 0) {
      this.nightBlips--;
      return null; // the driver could not tell, and says so
    }
    return this.night;
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
  await waitFor(
    () => r.light.sets.includes('on-air'),
    () => `expected a re-assert of on-air, got sets=[${r.light.sets.join(',')}]`,
  );
  r.stop();
  assert.equal(r.light.device, 'on-air', 'the device is pulled back to what the server intends');
});

test('supervisor: an OLD calm state is asserted over a busy device, and never adopted (D-91)', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'on-air';
  // The server latches. Age is not evidence, the device is a renderer rather than a
  // source, and whatever it holds arrived from an earlier assertion by this server.
  await waitFor(
    () => r.light.sets.includes('available'),
    () => `the latched state is asserted at any age, got sets=[${r.light.sets.join(',')}]`,
  );
  r.stop();
  assert.equal(r.light.device, 'available');
  assert.equal(r.store.get().state, 'available', 'the store never adopts the device');
});

test('supervisor: a FRESH calm state IS asserted - age changes nothing either way', async () => {
  const fresh = { ...defaultState(), state: 'available' };
  const r = rig({}, fresh);
  r.light.device = 'on-air';
  await waitFor(
    () => r.light.sets.includes('available'),
    () => `expected the fresh calm state to be asserted, got sets=[${r.light.sets.join(',')}]`,
  );
  r.stop();
  assert.equal(r.light.device, 'available');
});

test('supervisor: a device holding a key outside the table is never adopted', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'focus-block';
  // A key nobody recognises is a stale firmware or a hand-poked entity, not evidence.
  // Re-assert over it rather than adopting a state this server cannot reason about.
  await waitFor(
    () => r.light.sets.includes('available'),
    () => `expected a re-assert over the unknown key, got sets=[${r.light.sets.join(',')}]`,
  );
  r.stop();
  assert.equal(r.store.get().state, 'available');
});

test('supervisor: an unreachable device for longer than decayMs decays confirmed to unknown', async () => {
  const r = rig();
  r.store.setConfirmed('on-air');
  r.light.device = UNKNOWN_ID;
  // Both halves in one wait: the broadcast is part of the decay, so asserting it separately
  // after the wait would be a second race on the same event.
  await waitFor(
    () => r.store.get().confirmed === UNKNOWN_ID && r.changes.length >= 1,
    () => `confirmed=${r.store.get().confirmed}, broadcasts=${r.changes.length}`,
  );
  r.stop();
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
  await waitFor(
    () =>
      r.store.get().confirmed === UNKNOWN_ID &&
      lines.some((l) => /failed: (fetch failed|connect ECONNREFUSED)/.test(l)),
    () =>
      `no evidence must be reported as unknown, not held. confirmed=${r.store.get().confirmed}\n${lines.join('\n')}`,
  );
  r.stop();
  // An ABSENCE, and safe to check the moment the wait above proves a failing tick has run.
  assert.equal(lines.some((l) => /^\[supervisor\] Error/.test(l)), false, 'the throw never escapes the tick');
});

test('supervisor: confirmed reaches the wanted state once the device agrees', async () => {
  const r = rig();
  await waitFor(
    () => r.store.get().confirmed === 'on-air',
    () => `confirmed never reached the wanted state: ${r.store.get().confirmed}`,
  );
  r.stop();
});

test('supervisor: a device that agrees but is not repainting confirms nothing', async () => {
  const r = rig();
  r.light.frames = false;
  r.store.setConfirmed('on-air');
  await waitFor(
    () => r.store.get().confirmed === UNKNOWN_ID,
    () => `confirmed must describe pixels, not a variable: ${r.store.get().confirmed}`,
  );
  r.stop();
});

test('supervisor: every tick goes through the shared write queue', async () => {
  const r = rig();
  await waitFor(
    () => r.enqueued >= 3,
    () => `supervisor writes must serialise with HTTP writes, got ${r.enqueued}`,
  );
  r.stop();
});

test('supervisor: there is no withheld heartbeat - an old available is still heartbeated', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'available'; // device already agrees, so this is the heartbeat alone
  await waitFor(
    () => r.light.sets.includes('available'),
    () => `the heartbeat does not expire (D-91), got sets=[${r.light.sets.join(',')}]`,
  );
  r.stop();
});

test('supervisor: stop() is synchronous and takes effect immediately', async () => {
  const r = rig();
  // THE SLEEPS STAY. This asserts an ABSENCE - that nothing further happens after stop() - and a
  // slow machine only makes an absence easier to satisfy, which is the safe direction (D-127).
  // The wait is not the assertion; it only proves the supervisor was really running, so `before`
  // is a real count and the test cannot pass by never having started.
  await waitFor(() => r.light.sets.length + r.light.reads >= 1, 'the supervisor never ticked at all');
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
  await waitFor(
    () => r.light.sets.includes('on-air'),
    () => `the withheld heartbeat is for CALM states only, got sets=[${r.light.sets.join(',')}]`,
  );
  r.stop();
});

test('no auto-raise: an old calm state is asserted as itself, never escalated on its own', async () => {
  const old = { ...defaultState(new Date(Date.now() - 3600_000)), state: 'available' };
  const r = rig({}, old);
  r.light.device = 'available';
  // THE SLEEP STAYS. Both assertions below are ABSENCES - no escalation appeared, the state did
  // not move - and a slow machine only makes an absence easier to satisfy (D-127). The wait
  // guards VACUITY instead: `[].every(...)` is true, so with no writes at all this would pass
  // without testing anything.
  await waitFor(() => r.light.sets.length >= 1, 'the supervisor never asserted anything');
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
  // `before` is read FIRST, before a single tick has run, and the order is load-bearing: the
  // supervisor's one legitimate write is the opening `confirmed` transition, so capturing after
  // a tick would put that write OUTSIDE the window and the test would stop noticing if it moved
  // `updatedAt`. Measured - with the capture below the wait, a mutation that makes setConfirmed
  // stamp `updatedAt` turns nothing red.
  const before = r.store.get().updatedAt;
  // THE SLEEP STAYS: `updatedAt` never moving is an ABSENCE, and a slow machine only makes it
  // easier to satisfy (D-127). The wait guards vacuity - an unchanged clock proves nothing if
  // the supervisor never ran a tick that could have changed it.
  await waitFor(() => r.light.sets.length >= 1, 'the supervisor never asserted anything');
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
  // And the count is a real accumulation, not the constant 1. A recovery line that always
  // says "1 frozen tick" cannot tell a momentary blip from an hour of dead glass, which is
  // the entire reason the count is on the line.
  const ticks = Number(/and (\d+) frozen/.exec(back(lines)[0]!)?.[1]);
  assert.ok(ticks >= 2, `the tick count is not accumulating: ${back(lines)[0]}`);
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

// ------------------------------------------- confirmed must describe PIXELS SOMEBODY CAN SEE (#82)

const asleep = (lines: string[]): string[] => lines.filter((l) => l.includes('ASLEEP'));
const awake = (lines: string[]): string[] => lines.filter((l) => l.includes('AWAKE after'));

test('supervisor: a panel dark on schedule confirms NOTHING, and says why (#82)', async () => {
  const r = rig();
  // The exact shape of the bug: the display lambda keeps running with the backlight off, so
  // Frames advances all night and repainted() says true about a panel emitting nothing.
  r.light.frames = true;
  r.light.night = true;
  // Waited on the REASON, not on `confirmed`. The rig starts at `confirmed: unknown`, so
  // waiting for that is satisfied at t=0 and the test passes without a tick ever running -
  // the vacuous-wait trap D-127's helper makes easy to fall into.
  await waitFor(() => r.store.get().confirmedReason === 'asleep', () => JSON.stringify(r.store.get()));
  r.stop();
  assert.equal(r.store.get().confirmed, UNKNOWN_ID, 'confirmed must describe pixels somebody can see');
});

test('supervisor: the dark test runs BEFORE the repainting test, or it never runs at all (#82)', async () => {
  // A dark panel IS repainting. Placed after that branch this test is dead code, and the
  // server reports a confirmation of pixels nobody can see - which is the whole bug.
  const r = rig();
  r.light.frames = true;
  r.light.night = true;
  await waitFor(() => r.changes.some((c) => c.confirmedReason === 'asleep'), () => JSON.stringify(r.changes));
  r.stop();
  assert.equal(r.changes.at(-1)!.confirmed, UNKNOWN_ID);
});

test('supervisor: waking up restores confirmed, and clears the reason (#82)', async () => {
  const r = rig();
  r.light.frames = true;
  r.light.night = true;
  await waitFor(() => r.store.get().confirmedReason === 'asleep', () => JSON.stringify(r.store.get()));
  r.light.night = false;
  await waitFor(() => r.store.get().confirmed === 'on-air', () => JSON.stringify(r.store.get()));
  r.stop();
  // A stale reason surviving a recovery is the same lie as a stale confirmed, one level out.
  assert.equal(r.store.get().confirmedReason, undefined, JSON.stringify(r.store.get()));
});

test('supervisor: a whole night is TWO log lines, not one per tick (#82)', async () => {
  // Eight hours at the shipped 5s poll is 5,760 ticks. A line each would be 5,760 lines
  // before breakfast, every night, about a panel that is working perfectly.
  const lines: string[] = [];
  const r = rig({ log: (l: string) => lines.push(l) });
  r.light.frames = true;
  r.light.night = true;
  await waitFor(() => r.enqueued >= 12, () => `wanted 12 ticks, got ${r.enqueued}`);
  assert.equal(asleep(lines).length, 1, lines.join('\n'));
  r.light.night = false;
  await waitFor(() => awake(lines).length === 1, () => lines.join('\n'));
  r.stop();
  assert.equal(asleep(lines).length, 1, lines.join('\n'));
  assert.match(asleep(lines)[0]!, ISO);
  assert.match(asleep(lines)[0]!, /10\.42\.14\.239/);
  // NOT an error line and it must not read like one. A panel dark at 2am is healthy.
  // Deliberately NOT "on schedule": since #91 the glass can be dark by a button press too,
  // and the supervisor sees one boolean either way.
  assert.match(asleep(lines)[0]!, /the glass is dark/);
  assert.doesNotMatch(asleep(lines)[0]!, /on schedule/, 'the line claims a cause it cannot know');
  assert.doesNotMatch(asleep(lines)[0]!, /fail|error|unreachable/i);
});

test('supervisor: the three reasons stay distinguishable (#82)', async () => {
  // Two, not three: a surface that cannot tell "dark on purpose" from "broken" alarms every
  // night, and one that cannot tell "gone" from "frozen" is not worth reading.
  const frozen = rig();
  frozen.light.frames = false;
  await waitFor(() => frozen.store.get().confirmedReason === 'not-repainting', () => JSON.stringify(frozen.store.get()));
  frozen.stop();

  const gone = rig();
  gone.light.device = UNKNOWN_ID; // unreachable: set() goes nowhere, read() says nothing
  await waitFor(() => gone.store.get().confirmedReason === 'unreachable', () => JSON.stringify(gone.store.get()));
  gone.stop();
});

test('#82/D-132: a BLIP on the Night sensor must not confirm a dark panel', async () => {
  // The defect the adversarial review found in the deployed #82. glassDark() correctly
  // returns null when it cannot tell - and the supervisor then guessed "lit" anyway,
  // publishing `confirmed: on-air` about a panel that was black. That is precisely the lie
  // #82 was written to remove, restored by a single dropped packet.
  const r = rig();
  r.light.frames = true;
  r.light.night = true;
  await waitFor(() => r.store.get().confirmedReason === 'asleep', () => JSON.stringify(r.store.get()));

  // One dropped packet on an otherwise perfect panel, mid-night.
  const before = r.light.nightReads;
  r.light.nightBlips = 1;
  await waitFor(() => r.light.nightReads > before + 2, () => `reads ${r.light.nightReads}`);
  r.stop();

  // A null HOLDS the last real answer rather than reading as lit.
  assert.equal(r.store.get().confirmed, UNKNOWN_ID, 'a blip published a confirmation of a dark panel');
  assert.equal(r.store.get().confirmedReason, 'asleep');
  assert.ok(
    r.changes.every((c) => c.confirmed === UNKNOWN_ID),
    `confirmed went positive at some point: ${JSON.stringify(r.changes.map((c) => c.confirmed))}`,
  );
});

test('#82/D-132: a driver that has NEVER read the glass behaves as it always did', async () => {
  // The other side of holding the last answer. Old firmware with no Night sensor returns
  // null forever, and must not be held at `unknown` for want of an answer it cannot give.
  const r = rig();
  r.light.frames = true;
  r.light.night = null; // cannot tell, ever
  await waitFor(() => r.store.get().confirmed === 'on-air', () => JSON.stringify(r.store.get()));
  r.stop();
  assert.equal(r.store.get().confirmedReason, undefined);
});
