import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { LightDriver } from '../src/driver.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID, type PersistedState } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: string[] = [];
  async set(stateId: string): Promise<string> {
    this.calls.push(stateId);
    return stateId;
  }
  async read(): Promise<string> {
    return this.calls.at(-1) ?? UNKNOWN_ID;
  }
}

interface Harness {
  base: string;
  driver: StubDriver;
  store: StateStore;
  persisted: PersistedState[];
  close: () => Promise<void>;
}

async function boot(t: TestContext, over: Partial<ServerDeps> = {}): Promise<Harness> {
  const driver = new StubDriver();
  const persisted: PersistedState[] = [];
  const store = new StateStore(defaultState(), new StateTable());
  const deps: ServerDeps = { store, driver, persist: async (s) => void persisted.push(s), log: () => {}, ...over };
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  // Registered up front so a failing assertion cannot leak a listening server and hang
  // the whole run. close() is idempotent enough: a second call rejects, so swallow it.
  t.after(() => close().catch(() => {}));
  return { base: `http://127.0.0.1:${addr.port}`, driver, store, persisted, close };
}

function put(h: Harness, body: unknown): Promise<Response> {
  return fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify(body) });
}

async function status(h: Harness): Promise<Record<string, unknown>> {
  return (await (await fetch(`${h.base}/status`)).json()) as Record<string, unknown>;
}

// ------------------------------------------------------------- the v2 object

test('GET /status returns the v2 object, with every derived field', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const s = await status(h);
  assert.equal(s.state, 'on-air');
  assert.equal(s.busy, true);
  assert.equal(s.intended, 'on');
  assert.equal(s.confirmed, 'on-air');
  assert.equal(s.source, 'auto:vcrec');
  assert.equal('stale' in s, false, 'the server makes no judgement about age (D-91)');
  assert.equal(s.tableVersion, 1);
  assert.equal(typeof s.ageSeconds, 'number');
});

test('GET /status has an EXACT key set - a retired field cannot linger unnoticed', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  // /public/status has had this guard since D-35 (auth-routes) and /status has not, which
  // is how `hold` survived as a permanent null long enough to need D-126. An allowlist of
  // absent names ('hold' in s === false) is satisfied by the NEXT retired field too; an
  // exact set is not. `stateResolvedFrom` is deliberately absent: it appears only when the
  // live row was deleted (D-34), and it has its own tests.
  assert.deepEqual(Object.keys(await status(h)).sort(), [
    'ageSeconds', 'busy', 'confirmed', 'intended', 'message', 'source', 'state', 'tableVersion', 'updatedAt',
  ]);
});

test('the state payload carries NO presentation (D-42)', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const s = await status(h);
  for (const field of ['label', 'color', 'bgcolor', 'description', 'order']) {
    assert.equal(field in s, false, `${field} must not be on the state payload`);
  }
});

test('level and onAir are GONE from the wire', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'available', source: 'human:test' });
  const s = await status(h);
  assert.equal('level' in s, false);
  assert.equal('onAir' in s, false);
});

// ------------------------------------------------------------- PUT /state

test('PUT /state sets the row and drives it onto the light', async (t) => {
  const h = await boot(t);
  const res = await put(h, { state: 'recording', source: 'auto:vcrec' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.state, 'recording');
  assert.equal(body.busy, true);
  assert.deepEqual(h.driver.calls, ['recording']);
});

test('PUT /state is idempotent - a repeat just refreshes updatedAt', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const first = (await status(h)).updatedAt;
  await new Promise((r) => setTimeout(r, 1100));
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const second = (await status(h)).updatedAt;
  assert.notEqual(first, second);
  assert.equal((await status(h)).state, 'on-air');
});

test('an unknown state id is 400 and LISTS the valid ids - never accept-and-fall-back', async (t) => {
  const h = await boot(t);
  const res = await put(h, { state: 'dnd', source: 'auto:vcrec' });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; validStates: string[] };
  assert.match(body.error, /unknown state 'dnd'/);
  assert.deepEqual(body.validStates, ['available', 'on-air', 'interruptible', 'recording', 'unknown']);
  // The typo must not have moved anything.
  assert.equal((await status(h)).state, UNKNOWN_ID);
  assert.deepEqual(h.driver.calls, [], 'and must never have reached the light');
});

test('a missing state is 400', async (t) => {
  const h = await boot(t);
  assert.equal((await put(h, { source: 'auto:vcrec' })).status, 400);
});

test('PUT /state REQUIRES a prefixed source', async (t) => {
  const h = await boot(t);
  for (const source of [undefined, 'vcrec', 'detector', 'robot:x', '']) {
    const res = await put(h, { state: 'on-air', source });
    assert.equal(res.status, 400, `source ${JSON.stringify(source)} must be rejected`);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /source must be prefixed auto: or human:/);
  }
  assert.deepEqual(h.driver.calls, [], 'a rejected write never reaches the light');
});

// ------------------------------------------- the retired `hold` rider (D-126)

/**
 * THE RULE: a retired rider must never veto a state assertion.
 *
 * This is the one place the project's usual "a typo must never be silent" instinct points
 * the wrong way, and it is deliberate. VCREC is external (D-30) and the guide PUBLISHED
 * `POST /off?hold=1` as a copyable example, so senders exist that this repo cannot edit in
 * lockstep. A 400 on a body carrying `hold` DISCARDS the state write - the light does not
 * move and no one is told, which is a FALSE OFF (or a false ON on `/off`), the exact
 * failure this system exists to prevent. Ignoring costs a stale intent nobody can satisfy
 * any more. Rejecting costs a wrong light. So: accepted, ignored, 200, state applied.
 */

test('a body still carrying hold is ACCEPTED and ignored - never a 400', async (t) => {
  const h = await boot(t);
  for (const hold of [true, false, 'yes', null, 7] as const) {
    const res = await put(h, { state: 'on-air', source: 'auto:vcrec', hold });
    assert.equal(res.status, 200, `hold: ${JSON.stringify(hold)} must not refuse the write`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.state, 'on-air', 'and the state it asked for is what stands');
    assert.equal('hold' in body, false, 'the answer does not echo the retired field back');
    await put(h, { state: 'available', source: 'auto:vcrec' });
  }
  // Note the non-boolean values in that list: a non-boolean `hold` was a 400 with no write
  // before D-126. It is now a 200 with a write, on purpose.
  assert.equal(h.driver.calls.includes('on-air'), true, 'every one of them reached the light');
});

test('?hold=1 and ?hold=0 are ignored on the convenience route, and the state still lands', async (t) => {
  const h = await boot(t);
  for (const q of ['hold=1', 'hold=0', 'hold=maybe']) {
    const res = await fetch(`${h.base}/state/recording?source=auto:vcrec&${q}`, { method: 'POST' });
    assert.equal(res.status, 200, q);
    assert.equal((await status(h)).state, 'recording', q);
    await fetch(`${h.base}/state/available?source=auto:vcrec`, { method: 'POST' });
  }
  // The query surface is where a phone Shortcut lives. `/off?hold=1` is the published
  // example: refusing it would leave the light asserting ON AIR after the human said they
  // were done - a false ON that never clears.
  assert.equal((await fetch(`${h.base}/off?hold=1`, { method: 'POST' })).status, 200);
  assert.equal((await status(h)).state, 'available');
  assert.equal(h.driver.calls.at(-1), 'available', 'and the light was driven calm');
});

// -------------------------------------------------------- POST /state/{id}

test('POST /state/{id} sets that row, with no body', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/state/recording`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await status(h)).state, 'recording');
});

test('POST /state/{id} defaults source to human:anonymous', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:anonymous');
});

test('POST /state/{id} takes an unprefixed source as human:, unlike PUT /state', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air?source=menubar`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:menubar');
});

test('POST /state/{id} still reads bare "detector" as auto:, not human:', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air?source=detector`, { method: 'POST' });
  assert.equal((await status(h)).source, 'auto:detector');
});

test('POST /state/{id} on an unknown id is 400 with the valid ids', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/state/dnd`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.deepEqual(((await res.json()) as { validStates: string[] }).validStates.includes('on-air'), true);
});

test('GET /state/{id} is 405, not 404: the path is known, the method is not', async (t) => {
  const h = await boot(t);
  assert.equal((await fetch(`${h.base}/state/on-air`)).status, 405);
});

test('the retired rung routes are gone', async (t) => {
  const h = await boot(t);
  for (const path of ['/available', '/interruptible', '/dnd']) {
    assert.equal((await fetch(`${h.base}${path}`, { method: 'POST' })).status, 404, `${path} must be gone`);
  }
});

// ------------------------------------------------------------ /on and /off

test('/on and /off resolve through the configured shortcut rows', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/on`, { method: 'POST' });
  assert.equal((await status(h)).state, 'on-air');
  await fetch(`${h.base}/off`, { method: 'POST' });
  assert.equal((await status(h)).state, 'available');
});

test('an unset shortcut is 409, never a guess', async (t) => {
  // KEEP THIS. Since D-126 retired the pin's 409, this is one of only four 409s the whole
  // service can still produce, and the only one a write route can - the other three are
  // config-side (a stale save version, a save that failed to write, a rebind that rolled
  // back) and live in config-routes.test.ts. Anyone "removing the 409s" should stop here.
  const h = await boot(t, { shortcuts: { on: null, off: null } });
  for (const path of ['/on', '/off']) {
    const res = await fetch(`${h.base}${path}`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, new RegExp(`no shortcut row is configured for ${path}`));
  }
  // "Fall back to the first row" is a bad rule when the first row is ON AIR.
  assert.equal((await status(h)).state, UNKNOWN_ID);
});

test('a shortcut naming a row that no longer exists is 400, not a silent miss', async (t) => {
  const h = await boot(t, { shortcuts: { on: 'deleted-row', off: 'available' } });
  const res = await fetch(`${h.base}/on`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('/on and /off accept ?source= and default to human:anonymous', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/on?source=human:shortcut`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:shortcut');
  await fetch(`${h.base}/off`, { method: 'POST' });
  assert.equal((await status(h)).source, 'human:anonymous');
});

// ------------------------------------------------------------- persistence

test('what is persisted carries a derived intended, tableVersion and confirmed unknown', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  const last = h.persisted.at(-1)!;
  assert.equal(last.state, 'on-air');
  assert.equal(last.intended, 'on');
  assert.equal(last.tableVersion, 1);
  assert.equal(last.confirmed, UNKNOWN_ID);
});

test('an unreachable light is not a failed write (§7)', async (t) => {
  const dead: LightDriver = { set: async () => UNKNOWN_ID, read: async () => UNKNOWN_ID };
  const h = await boot(t, { driver: dead });
  const res = await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal(res.status, 200, 'the write succeeded');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.state, 'on-air');
  assert.equal(body.confirmed, UNKNOWN_ID, 'and the failure surfaces here');
});

test('a device holding a key outside the table never becomes confirmed', async (t) => {
  const liar: LightDriver = { set: async () => 'focus-block', read: async () => 'focus-block' };
  const h = await boot(t, { driver: liar });
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal((await status(h)).confirmed, UNKNOWN_ID);
});

// --------------------------------------------- LAST WRITE WINS, over HTTP (§3, D-126)

/**
 * What replaced THE PIN RULE. Every write with a valid body is applied, no `source`
 * outranks another, and no earlier write can block a later one.
 *
 * Written as a positive rule rather than as a gap on purpose: the tests these replaced -
 * `THE REGRESSION: "I am interruptible today" survives a meeting` and its siblings - are
 * the exact inverse of the ones below, and without a standing statement of the new rule the
 * next reader of D-19/D-32 reinstates precedence and nothing here objects.
 *
 * What is genuinely lost is named, not hidden: pinned at a busy row, an `auto:` write to a
 * calm row used to be refused and the light stayed ON. That was a real, narrow false-OFF
 * protection. It only ever applied while a human had explicitly pinned, and Rocket's
 * workflow never pins.
 */

test('NOTHING refuses a write: every source, every row, both routes', async (t) => {
  // Exhaustive over the cross product rather than a spot check, because a surviving special
  // case would be scoped to some rows (busy -> calm) or some kinds (auto:) and a sampled
  // test is exactly what it would slip past.
  const sources = ['auto:vcrec', 'human:menubar', 'human:anonymous', 'auto:detector'];
  const ids = ['available', 'on-air', 'interruptible', 'recording', 'unknown'];
  const h = await boot(t);
  for (const source of sources) {
    for (const id of ids) {
      // Seed something else first, so every case is a real move and not a no-op.
      await put(h, { state: id === 'recording' ? 'available' : 'recording', source: 'human:seed' });

      const viaPut = await put(h, { state: id, source });
      assert.equal(viaPut.status, 200, `PUT ${id} as ${source}`);
      assert.equal((await status(h)).state, id, `PUT ${id} as ${source} must land`);

      await put(h, { state: id === 'recording' ? 'available' : 'recording', source: 'human:seed' });
      const viaPost = await fetch(`${h.base}/state/${id}?source=${encodeURIComponent(source)}`, { method: 'POST' });
      assert.equal(viaPost.status, 200, `POST /state/${id} as ${source}`);
      assert.equal((await status(h)).state, id, `POST /state/${id} as ${source} must land`);
    }
  }
});

test("THE WORKFLOW: the detector's write wins when the meeting ends", async (t) => {
  // This is what Rocket asked for, and it is the inverse of the deleted
  // 'THE REGRESSION: "I am interruptible today" survives a meeting'. Do not delete it.
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air?source=human:menubar`, { method: 'POST' }); // he overrides by hand
  const res = await put(h, { state: 'available', source: 'auto:vcrec' });          // the meeting ends
  assert.equal(res.status, 200);
  const s = await status(h);
  assert.equal(s.state, 'available');
  assert.equal(s.busy, false);
  assert.equal(s.source, 'auto:vcrec');
  // Not optional. Asserting only the status body would pass against a server that refused
  // the write and reported the row it kept.
  assert.equal(h.driver.calls.at(-1), 'available', 'and the light really was driven calm');
});

test('a human override mid-meeting APPLIES, and does not stick', async (t) => {
  const h = await boot(t);
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  assert.equal((await fetch(`${h.base}/state/interruptible?source=human:ui`, { method: 'POST' })).status, 200);
  assert.equal((await status(h)).state, 'interruptible', 'the manual write is honoured...');
  assert.equal((await put(h, { state: 'on-air', source: 'auto:vcrec' })).status, 200);
  assert.equal((await status(h)).state, 'on-air', '...and it is transient');
});

test('no write route can answer 403 or 409 any more, riders and all', async (t) => {
  // 403 now survives only on the admin surface (POST /admin/restart, /admin/factory-reset)
  // and 409 only on config saves, a failed rebind, and an unset /on|/off shortcut row.
  const h = await boot(t, { shortcuts: { on: 'on-air', off: 'available' } });
  const attempts: Promise<Response>[] = [
    put(h, { state: 'available', source: 'auto:vcrec' }),
    put(h, { state: 'available', source: 'auto:vcrec', hold: true }),
    put(h, { state: 'on-air', source: 'auto:vcrec', hold: false }),
    fetch(`${h.base}/state/available?source=auto:vcrec&hold=1`, { method: 'POST' }),
    fetch(`${h.base}/state/on-air?source=detector&hold=0`, { method: 'POST' }),
    fetch(`${h.base}/on?source=auto:vcrec&hold=1`, { method: 'POST' }),
    fetch(`${h.base}/off?source=auto:vcrec&hold=1`, { method: 'POST' }),
  ];
  for (const [i, res] of (await Promise.all(attempts)).entries()) {
    assert.notEqual(res.status, 403, `attempt ${i} must not be a 403`);
    assert.notEqual(res.status, 409, `attempt ${i} must not be a 409`);
    assert.equal(res.status, 200, `attempt ${i}`);
  }
});

test('/off from an auto: source drives the light calm', async (t) => {
  // The positive replacement for '/off is refused by a pin, since it resolves to a calm row'.
  const h = await boot(t);
  await put(h, { state: 'recording', source: 'human:ui' });
  assert.equal((await fetch(`${h.base}/off?source=auto:vcrec`, { method: 'POST' })).status, 200);
  assert.equal((await status(h)).state, 'available');
  assert.equal(h.driver.calls.at(-1), 'available');
});

test('human:hold never appears as a source - the settle-back path is gone', async (t) => {
  // There is no server-authored write left. Whatever `source` says, a client said it.
  const h = await boot(t);
  await put(h, { state: 'interruptible', source: 'human:ui', hold: true });
  await put(h, { state: 'on-air', source: 'auto:vcrec' });
  await put(h, { state: 'available', source: 'auto:vcrec' });
  assert.equal(String((await status(h)).source).startsWith('human:hold'), false);
  assert.equal((await status(h)).source, 'auto:vcrec');
});
