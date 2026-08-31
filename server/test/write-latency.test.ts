// #68: a write against a dead panel, and the queue that grew while it was away.
//
// The defect was never the latency on its own. Every write and every supervisor tick share
// one queue (`app.ts`), a write's own device work against an unplugged panel measured 6.4s,
// and both the supervisor (5s) and the detector (~5s, D-90) arrive faster than that. So
// arrivals outpaced drains and the queue grew for as long as the panel was away - measured
// on the ticket as writes answered after 7.7s, 9.1s, 14.9s, 16.3s, 17.7s.
//
// Two changes, and this file is about both:
//   1. The version nudge came off the write path. It was 2 of the 6.4 seconds and it is
//      advisory. Covered in config-routes.test.ts, where the nudge's other tests live.
//   2. A host the driver already knows is failing is not asked again until its re-probe is
//      due. That is this file.
//
// AND THE CORRECTION THAT FOLLOWED (D-132). The first version of (2) gated `set()` too, and
// keyed the gate on `failingSince` - which means "one call failed once", not "this host is
// dead". So a single dropped packet on a poll stopped the server telling the panel anything
// for 15 seconds. Found by an adversarial review of the DEPLOYED change, and reproduced:
// after one blip, five writes to a fully healthy panel returned in under a millisecond each
// with nothing on the wire, while the panel went on showing the previous row.
//
// The rule that came out of it, and most of this file now guards it:
//
//   A READ may be skipped. Skipping one costs the server knowledge it re-acquires in 15
//   seconds. A WRITE may never be skipped. Skipping one costs the LIGHT, and if the write
//   swallowed was the one turning the light on, that is a false OFF.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { EsphomeTextDriver } from '../src/esphome-driver.js';
import { waitFor } from './wait-for.js';

/**
 * A BLACK HOLE, not a refused connection - the distinction the ticket insists on.
 *
 * A closed port answers RST immediately and costs nothing, which is the case that was never
 * the problem. This accepts the connection and then says nothing at all, so every request
 * runs the timeout out. On loopback, so the suite does not depend on how this machine routes
 * TEST-NET-1.
 */
async function blackHole(t: TestContext): Promise<{ host: string; connections: () => number }> {
  let connections = 0;
  const server: Server = createServer(() => {
    connections++; // and never respond
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { host: `127.0.0.1:${(server.address() as AddressInfo).port}`, connections: () => connections };
}

async function boot(t: TestContext, driver: EsphomeTextDriver, pollMs: number) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-latency-'));
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config.json'),
    port: 0,
    bind: 'loopback', // #49: exclusive, so no other process can share this port
    driver,
    log: () => {},
    supervise: { pollMs },
  });
  t.after(() => app.close().catch(() => {}));
  return { app, base: `http://127.0.0.1:${app.port}` };
}

/** The constants the service actually ships with. */
const SHIPPED = { timeoutMs: 2000, retries: 1, retryGapMs: 400 };

test('#68/D-132: ONE BLIP MUST NOT SILENCE THE DRIVER - the regression this file exists for', async (t) => {
  // The exact reproduction from the review. A panel that swallowed two packets once, and is
  // then perfectly healthy for the rest of its life.
  let value = 'available';
  let swallow = 0;
  let reached = 0;
  const server: Server = createServer((req, res) => {
    reached++;
    if (swallow > 0) {
      swallow--;
      return; // accept, never answer
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/text/PresenceKey/set') {
      value = url.searchParams.get('value') ?? '';
      res.writeHead(200, { 'content-length': '0' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: value }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const driver = new EsphomeTextDriver({
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    timeoutMs: 150,
    retries: 1,
    retryGapMs: 10,
    reprobeMs: 60_000, // a window far longer than this test, so a pass cannot be it expiring
    log: () => {},
  });

  swallow = 2; // one blip: the whole ladder, two tries
  assert.equal(await driver.set('available'), 'unknown', 'the blip write itself legitimately fails');

  const afterBlip = reached;
  // The panel is answering again. Every one of these must go on the wire and must land.
  for (let i = 0; i < 5; i++) {
    assert.equal(await driver.set('on-air'), 'on-air', `write ${i} was swallowed by the gate`);
  }
  assert.equal(value, 'on-air', 'THE LIGHT IS WRONG: the panel never got the write');
  assert.ok(reached > afterBlip, 'not one request reached a healthy panel after a single blip');
});

test('#68: a write is attempted even against a host the driver believes is dead', async (t) => {
  // The general form of the rule. The server may skip LEARNING; it may never skip TELLING.
  const hole = await blackHole(t);
  const driver = new EsphomeTextDriver({
    host: hole.host,
    timeoutMs: 100,
    retries: 0,
    reprobeMs: 60_000,
    log: () => {},
  });

  assert.equal(await driver.read(), 'unknown'); // exhausts a ladder, arms the gate
  const afterRead = hole.connections();
  assert.equal(await driver.read(), 'unknown');
  assert.equal(hole.connections(), afterRead, 'a READ inside the window is skipped');

  assert.equal(await driver.set('on-air'), 'unknown');
  assert.ok(hole.connections() > afterRead, 'a WRITE inside the window must still be attempted');
});

test('#68: the supervisor\'s polling is what the window drains', async (t) => {
  // This is where the traffic is, and it is what made the queue grow: the supervisor ticks
  // every 5s and its read() ladder against a dead host outlasts the interval.
  const hole = await blackHole(t);
  const driver = new EsphomeTextDriver({
    host: hole.host,
    timeoutMs: 200,
    retries: 0,
    reprobeMs: 60_000,
    log: () => {},
  });
  assert.equal(await driver.read(), 'unknown');
  const armed = hole.connections();

  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await driver.read();
    assert.ok(Date.now() - t0 < 50, `poll ${i} paid the ladder`);
  }
  assert.equal(hole.connections(), armed, '10 polls inside the window, none on the wire');
});

test('#68: a write drains faster than the detector produces them', async (t) => {
  // THE REAL INVARIANT, and the one the original queue-depth test stopped measuring.
  //
  // That test only had supervisor ticks in it, and the supervisor CANNOT pile up: schedule()
  // re-arms in a `.finally` on the previous tick, so it never has more than one outstanding.
  // So `deepest <= 2` was true no matter what the driver did - it survived a mutation that
  // removed the skip window entirely. A test that cannot go red is not a test.
  //
  // What actually grew the queue is arrivals outpacing drains: the detector writes every ~5s
  // (D-90) into a shared queue where each write's device work was 6.4s. Taking the version
  // nudge off the write path is what inverted that, and this asserts the inversion at the
  // SHIPPED constants, because a scaled-down version of a ratio test proves nothing about
  // the ratio that ships.
  //
  // THIS MEASURES THE DRIVER, NOT THE ROUTE, and the pair is what makes it sound: the other
  // half - that `doWrite` adds no device work beyond `set()` - is guarded structurally by
  // "a state write does NOT nudge (#68)" in config-routes.test.ts, with no timing in it at
  // all. Measured here, that half would cost this suite the app's 6.4s boot to prove
  // something an assertion on a call list already proves for free. Checked deliberately:
  // putting the nudge back in `doWrite` does NOT turn this test red, and it should not.
  const DETECTOR_INTERVAL_MS = 5000; // D-90
  const hole = await blackHole(t);
  const driver = new EsphomeTextDriver({ host: hole.host, ...SHIPPED, log: () => {} });

  const t0 = Date.now();
  assert.equal(await driver.set('on-air'), 'unknown');
  const cost = Date.now() - t0;

  assert.ok(
    cost < DETECTOR_INTERVAL_MS,
    `one write costs ${cost}ms against a dead host and the detector produces one every ` +
      `${DETECTOR_INTERVAL_MS}ms - the queue grows without bound, which is the whole of #68`,
  );
  // And it really did go to the wire. A write that drains fast because it was skipped is the
  // regression D-132 removed, not the fix D-130 intended.
  assert.ok(hole.connections() >= 2, 'the write never reached the host');
});

test('#68: a dead host is polled once per window, not once per call', async (t) => {
  const hole = await blackHole(t);
  const driver = new EsphomeTextDriver({
    host: hole.host,
    timeoutMs: 50,
    retries: 0,
    reprobeMs: 400,
    log: () => {},
  });

  assert.equal(await driver.read(), 'unknown');
  const afterFirst = hole.connections();
  assert.equal(afterFirst, 1);

  for (let i = 0; i < 20; i++) await driver.read();
  assert.equal(hole.connections(), afterFirst, '20 polls inside the window, none of them on the wire');

  // And the window OPENS again - a skip that never lifts is a panel written off for good,
  // which is the failure mode the ticket names.
  await waitFor(
    async () => {
      await driver.read();
      return hole.connections() > afterFirst;
    },
    'the re-probe never came due',
    3000,
  );
});

test('#68: a single-shot poller cannot arm the gate on its own (D-132)', async (t) => {
  // setTableVersion, glassDark and verifyEntity have no retry ladder and call unreachable()
  // on their first failure. Keying the gate on that is what dropped writes: glassDark alone
  // fires every supervisor tick, so on a lossy link it was ~17,000 chances a day to silence
  // the driver.
  const hole = await blackHole(t);
  const driver = new EsphomeTextDriver({
    host: hole.host,
    timeoutMs: 60,
    retries: 0,
    reprobeMs: 60_000,
    log: () => {},
  });

  assert.equal(await driver.glassDark(), null); // fails, logs an edge, must NOT arm the gate
  const afterPoll = hole.connections();
  assert.equal(await driver.read(), 'unknown');
  assert.ok(hole.connections() > afterPoll, 'a failed single-shot poll gated the next read');
});

test('#68: a host that comes back is picked up, and the log says how much was skipped', async (t) => {
  const lines: string[] = [];
  let answering = false;
  const server: Server = createServer((req, res) => {
    if (!answering) return; // black hole
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: 'on-air' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const driver = new EsphomeTextDriver({
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    timeoutMs: 50,
    retries: 0,
    reprobeMs: 300,
    log: (l: string) => lines.push(l),
  });

  assert.equal(await driver.read(), 'unknown');
  for (let i = 0; i < 15; i++) await driver.read(); // all skipped, all silent
  assert.equal(lines.length, 1, `one UNREACHABLE edge and nothing else: ${lines.join('\n')}`);

  answering = true;
  await waitFor(
    async () => {
      await driver.read();
      return lines.length > 1;
    },
    () => lines.join('\n'),
    3000,
  );
  // The skipped count belongs on the recovery line and nowhere else: it is the only number
  // that says how much traffic the window absorbed, and per-call it would be the flood.
  assert.match(lines[1]!, /BACK after \d+s and \d+ failed calls? \(\d+ skipped while it was down\)/, lines[1]);
});

test('#68: the shipped ladder still costs what it costs, and that is the accepted trade', async (t) => {
  // #68's original criterion was "a write against a black-hole host returns in under 1s".
  // D-132 gave that up deliberately: it was only ever true because writes were being
  // SKIPPED, and a fast write that never reached the panel is not a fast write.
  const hole = await blackHole(t);
  // Scaled down by 5x from SHIPPED so this does not add eleven seconds to the suite. The
  // arithmetic is identical: 2 tries x timeoutMs plus one gap. At the shipped numbers that
  // is 4.4s, and it is paid rather than skipped.
  const ladder = { timeoutMs: SHIPPED.timeoutMs / 5, retries: 1, retryGapMs: SHIPPED.retryGapMs / 5 };
  const driver = new EsphomeTextDriver({ host: hole.host, ...ladder, log: () => {} });
  const h = await boot(t, driver, 1_000_000); // supervisor parked

  const before = hole.connections();
  const t0 = Date.now();
  const res = await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  const ms = Date.now() - t0;
  assert.equal(res.status, 200, 'a dead light is still not a failed write (contract section 7)');
  // The write went ON THE WIRE, which is the property worth having. The feedback loop #68
  // was really about is drained by skipping the POLLS, not the writes.
  assert.ok(ms >= ladder.timeoutMs, `the write short-circuited in ${ms}ms - is set() gated again?`);
  assert.ok(hole.connections() >= before + 2, 'the write must have been attempted, twice');
});

test('#68/D-132: the boot re-apply invariant survives a blip at startup', async (t) => {
  // app.ts calls verifyEntity() and then, under the comment "Invariant: recover after
  // restart", driver.set(want). verifyEntity has NO retry ladder, so one swallowed packet
  // at boot used to arm the gate and skip the re-apply - the persisted state was never
  // re-asserted, and the panel came back showing whatever it had before. The review found
  // this and was right that nobody decided it.
  let value = 'available';
  let swallow = 1; // exactly one packet lost, at the worst possible moment
  const server: Server = createServer((req, res) => {
    if (swallow > 0) {
      swallow--;
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/text/PresenceKey/set') {
      value = url.searchParams.get('value') ?? '';
      res.writeHead(200, { 'content-length': '0' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: value }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const driver = new EsphomeTextDriver({
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    timeoutMs: 150,
    retries: 1,
    retryGapMs: 10,
    reprobeMs: 60_000,
    log: () => {},
  });

  const h = await boot(t, driver, 1_000_000);
  // The default boot state is `unknown`, and the re-apply asserts it. What matters is that
  // the device was TOLD something rather than skipped.
  assert.equal(value, h.app.store.get().state, 'the boot re-apply never reached the panel');
});
