// #93: POST /cycle - one deck key that walks a ring of rows and wraps.
//
// Rocket's ask was "instead of needing three or four buttons on a stream deck, we can have
// just two", and the method of use is a jab repeated until the wanted row comes up.
//
// THAT METHOD OF USE IS THE WHOLE REASON THIS ROUTE EXISTS RATHER THAN A LOOP IN THE MODULE.
// A client that reads `state` and writes its successor is correct for one press and wrong for
// two: the second press starts before the first one's answer arrives, reads the same `state`
// and writes the same row. This file's load-bearing test is the concurrent one; everything
// else here is the boundary work around it.

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { LightDriver } from '../src/driver.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID, type PersistedState } from '../src/state.js';

/** Slow on purpose: a driver that answers instantly cannot expose an interleave. */
class SlowDriver implements LightDriver {
  calls: string[] = [];
  constructor(private readonly delayMs = 0) {}
  async set(stateId: string): Promise<string> {
    this.calls.push(stateId);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return stateId;
  }
  async read(): Promise<string> {
    return this.calls.at(-1) ?? UNKNOWN_ID;
  }
}

interface Harness {
  base: string;
  driver: SlowDriver;
  store: StateStore;
}

async function boot(t: TestContext, driver = new SlowDriver()): Promise<Harness> {
  const persisted: PersistedState[] = [];
  const store = new StateStore(defaultState(), new StateTable());
  const deps: ServerDeps = { store, driver, persist: async (s) => void persisted.push(s), log: () => {} };
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${addr.port}`, driver, store };
}

const cycle = (h: Harness, query = ''): Promise<Response> =>
  fetch(`${h.base}/cycle${query}`, { method: 'POST' });

const state = async (h: Harness): Promise<string> =>
  ((await (await fetch(`${h.base}/status`)).json()) as { state: string }).state;

test('#93 /cycle advances one stop and wraps at the end', async (t) => {
  const h = await boot(t);
  const ring = '?ring=available,on-air,interruptible';

  assert.equal(await state(h), UNKNOWN_ID);
  // Not in the ring at boot, so the first press lands on the FIRST entry rather than erroring.
  // A cycle button that is dead until somebody uses a different button is not a cycle button.
  await cycle(h, ring);
  assert.equal(await state(h), 'available');
  await cycle(h, ring);
  assert.equal(await state(h), 'on-air');
  await cycle(h, ring);
  assert.equal(await state(h), 'interruptible');
  await cycle(h, ring);
  assert.equal(await state(h), 'available', 'the ring did not wrap');
});

test('#93 the response is the full status body, like every other state write', async (t) => {
  const h = await boot(t);
  const res = await cycle(h, '?ring=available,on-air&source=companion');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.state, 'available');
  assert.equal(body.confirmed, 'available', 'the caller cannot see whether the light took it');
  // Lenient like the other convenience routes (D-41): a bare label becomes `human:`.
  assert.equal(body.source, 'human:companion');
  assert.equal(body.busy, false);
});

test('#93 THREE PRESSES INSIDE ONE ROUND TRIP ADVANCE THREE STOPS', async (t) => {
  // The reason the successor is computed on this side of the wire. The driver takes 80 ms, so
  // all three requests are in flight together and none of them can have seen another's
  // answer. Computed anywhere but inside the write queue, all three read `available` and all
  // three write `on-air`, and the deck moves one stop for three presses - which is exactly
  // what a human jabbing the button would report as "it is stuck".
  const h = await boot(t, new SlowDriver(80));
  const ring = '?ring=available,on-air,interruptible,recording';
  await cycle(h, ring);
  assert.equal(await state(h), 'available');

  const started = Date.now();
  await Promise.all([cycle(h, ring), cycle(h, ring), cycle(h, ring)]);
  assert.ok(Date.now() - started >= 80, 'the driver did not actually block, so nothing overlapped');

  assert.equal(await state(h), 'recording', 'three presses did not advance three stops');
  // And each one really went to the light, in order. A queue that coalesced them would leave
  // the panel holding a row the server never showed.
  assert.deepEqual(h.driver.calls, ['available', 'on-air', 'interruptible', 'recording']);
});

test('#93 an omitted ring is every row except the reserved one', async (t) => {
  const h = await boot(t);
  // `unknown` is the server saying it does not know. Cycling INTO it would be asserting
  // ignorance on purpose, and the panel treats it as busy (D-34) - so a stray press would
  // light the lamp for a state nobody is in.
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) {
    await cycle(h);
    seen.push(await state(h));
  }
  assert.deepEqual(seen, ['available', 'on-air', 'interruptible', 'recording', 'available']);
});

test('#93 a ring naming a row the table no longer has still cycles the rest', async (t) => {
  // A placed Companion button freezes its options the day somebody drags it onto the deck.
  // Delete a row from the table and a route that 400'd would leave that button dead forever -
  // and a physical button that does nothing is the failure this repo keeps refusing.
  const h = await boot(t);
  await cycle(h, '?ring=available,ghost-row,on-air');
  assert.equal(await state(h), 'available');
  await cycle(h, '?ring=available,ghost-row,on-air');
  assert.equal(await state(h), 'on-air');
  await cycle(h, '?ring=available,ghost-row,on-air');
  assert.equal(await state(h), 'available', 'the gap in the ring broke the wrap');
});

test('#93 a ring with NOTHING this server knows is a 400 that lists what would have worked', async (t) => {
  const h = await boot(t);
  const res = await cycle(h, '?ring=ghost,phantom');
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; validStates: string[] };
  assert.match(body.error, /ring names no row/);
  assert.ok(body.validStates.includes('available'), 'the 400 did not say what would have worked');
  assert.equal(await state(h), UNKNOWN_ID, 'a refused cycle still moved the state');
});

test('#93 GET /cycle is a 405, like every other write route', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/cycle`);
  assert.equal(res.status, 405);
});
