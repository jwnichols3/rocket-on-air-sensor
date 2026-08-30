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
    driver,
    log: () => {},
    supervise: { pollMs },
  });
  t.after(() => app.close().catch(() => {}));
  return { app, base: `http://127.0.0.1:${app.port}` };
}

/** The constants the service actually ships with. */
const SHIPPED = { timeoutMs: 2000, retries: 1, retryGapMs: 400 };

test('#68: a write against a black-hole host returns in well under a second', async (t) => {
  const hole = await blackHole(t);
  const driver = new EsphomeTextDriver({ host: hole.host, ...SHIPPED, log: () => {} });
  // The supervisor is parked so every request below is attributable to a write.
  const h = await boot(t, driver, 1_000_000);

  // Boot is the call that DISCOVERS the host is dead, and it pays for that: one 2s timeout
  // in verifyEntity, after which the boot re-apply's own set() is already inside the window
  // and costs nothing. Somebody has to find out; #68 is about every call after that one.
  const discovered = hole.connections();
  assert.ok(discovered >= 1, `boot should have reached the host once, got ${discovered}`);

  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const res = await fetch(`${h.base}/state/${i % 2 === 0 ? 'on-air' : 'available'}`, { method: 'POST' });
    const ms = Date.now() - t0;
    assert.equal(res.status, 200, 'a dead light is still not a failed write (contract section 7)');
    // 4400ms of device work per write before this change. The margin here is 4x, and it is
    // a ceiling rather than a measurement - the real number is single-digit milliseconds.
    assert.ok(ms < 1000, `write ${i} took ${ms}ms; the skip window is not holding`);
  }

  // The structural half, which no amount of machine load can distort: the dead host was not
  // contacted at all by those four writes.
  assert.equal(hole.connections(), discovered, 'a host known to be dead must not be asked again');
});

test('#68: the queue does not grow while the panel is away', async (t) => {
  const hole = await blackHole(t);
  // Short ladder here: this test is about DEPTH, and a 4.4s discovery would dominate it.
  const driver = new EsphomeTextDriver({
    host: hole.host,
    timeoutMs: 100,
    retries: 0,
    reprobeMs: 60_000,
    log: () => {},
  });
  const h = await boot(t, driver, 20); // a supervisor ticking far faster than the shipped 5s

  let deepest = 0;
  const sampler = setInterval(() => {
    deepest = Math.max(deepest, h.app.writeQueueDepth());
  }, 2);
  t.after(() => clearInterval(sampler));

  // The detector's pattern from D-90: it writes ON A TIMER and does not wait for the
  // previous write to answer. That is the whole mechanism - arrivals outpacing drains - so
  // the writes here are fired on a timer too. Awaiting each one before sending the next
  // would make the queue trivially shallow and the test would pass against the bug.
  const writes: Array<Promise<unknown>> = [];
  for (let i = 0; i < 8; i++) {
    writes.push(fetch(`${h.base}/state/on-air`, { method: 'POST' }));
    await sleep(20); // one supervisor poll apart
  }
  await Promise.all(writes);
  await waitFor(() => h.app.writeQueueDepth() === 0, () => `depth ${h.app.writeQueueDepth()}`, 5000);
  clearInterval(sampler);

  // Depth counts supervisor ticks as well as writes, so 2 is "one write plus at most one
  // tick". Asserting the depth and not the wall time is deliberate: the wall time is what a
  // loaded machine ruins, and the queue is the actual defect.
  assert.ok(deepest <= 2, `the shared queue reached depth ${deepest}; it should never pass 2`);
});

test('#68: a dead host is asked once per window, not once per call', async (t) => {
  const hole = await blackHole(t);
  const driver = new EsphomeTextDriver({
    host: hole.host,
    timeoutMs: 50,
    retries: 0,
    reprobeMs: 400,
    log: () => {},
  });

  assert.equal(await driver.set('on-air'), 'unknown');
  const afterFirst = hole.connections();
  assert.equal(afterFirst, 1);

  for (let i = 0; i < 20; i++) await driver.set('on-air');
  assert.equal(hole.connections(), afterFirst, '20 calls inside the window, none of them on the wire');

  // And the window OPENS again - a skip that never lifts is a panel written off for good,
  // which is the failure mode the ticket names: "the first write after the panel returns is
  // skipped with nothing to un-skip it".
  await waitFor(
    async () => {
      await driver.set('on-air');
      return hole.connections() > afterFirst;
    },
    'the re-probe never came due',
    3000,
  );
});

test('#68: a host that comes back is picked up, and the log says how much was skipped', async (t) => {
  const lines: string[] = [];
  let answering = false;
  const server: Server = createServer((req, res) => {
    if (!answering) return; // black hole
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/text/PresenceKey/set') {
      res.writeHead(200, { 'content-length': '0' }).end();
      return;
    }
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
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const driver = new EsphomeTextDriver({
    host,
    timeoutMs: 50,
    retries: 0,
    reprobeMs: 300,
    log: (l: string) => lines.push(l),
  });

  assert.equal(await driver.set('on-air'), 'unknown');
  for (let i = 0; i < 15; i++) await driver.set('on-air'); // all skipped, all silent
  assert.equal(lines.length, 1, `one UNREACHABLE edge and nothing else: ${lines.join('\n')}`);

  answering = true;
  await waitFor(
    async () => {
      await driver.set('on-air');
      return lines.length > 1;
    },
    () => lines.join('\n'),
    3000,
  );
  // The skipped count belongs on the recovery line and nowhere else: it is the only number
  // that says how much traffic the window absorbed, and per-call it would be the flood.
  assert.match(lines[1]!, /BACK after \d+s and \d+ failed calls? \(\d+ skipped while it was down\)/, lines[1]);
});
