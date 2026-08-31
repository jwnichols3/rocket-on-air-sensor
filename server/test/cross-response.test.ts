// #49's reproduction harness: does a response ever reach the WRONG request?
//
// Two witnesses, days apart, in different files, neither reproducible on demand:
//   - `GET /status` answered `403`, a status no handler on that route can produce, four tests
//     after a test that asserts a `403` from `/admin/factory-reset`.
//   - `GET /admin/config` answered `200` with a body carrying no `config` key.
// A third, different in symptom and recorded rather than folded in: `connect ETIMEDOUT` to a
// loopback port, where a port with no listener refuses IMMEDIATELY rather than timing out.
//
// The production rebind path was ELIMINATED by reading (see the ticket): a socket belongs to
// exactly one `Server`, and Node serialises responses per socket, so `stopAccepting`'s
// overlapping-listeners window cannot cross a response. What survives is the test substrate:
// every app in the file where the sharp witness happened boots on `port: 0`, so the OS hands
// out an ephemeral port and will readily hand the SAME one out again moments later - while
// undici keeps its connection pool keyed by origin, and an origin here is `127.0.0.1:<port>`.
//
// So this is deliberately built on `port: 0` and NOT on `freePort()`. #58 moved the tests that
// name a port into a band below both ephemeral ranges, which is right for them and would
// destroy this harness: recycling the ephemeral port is the mechanism under test.
//
// IT ASSERTS TWO PROPERTIES, because there are two witnesses:
//   1. Every response matches the request it was made for - the route, and the app instance.
//   2. Every connect either succeeds or is REFUSED, promptly. A timeout on loopback is itself
//      the finding.
//
// Scale it to hunt: `CROSS_N=5000 npx tsx --test test/cross-response.test.ts`. The default is
// small enough to live inside `npm run verify`, which is the point - a harness that only runs
// when somebody remembers it is a harness that rots.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import { UNKNOWN_ID } from '../src/state.js';

class StubDriver implements LightDriver {
  async set(id: string): Promise<string> {
    return id;
  }
  async read(): Promise<string> {
    return UNKNOWN_ID;
  }
}

const N = Number(process.env.CROSS_N ?? 40);
const REMOTE = { origin: 'http://10.42.14.189:9099' };

/**
 * WHAT EACH ROUTE IS ALLOWED TO SAY. The witness was a status no handler could produce on the
 * route it arrived on, so the check is per-route and not "is it 2xx". `403` appears on exactly
 * two admin routes and nowhere else - that asymmetry is what made witness 2 legible, and it is
 * what this table preserves.
 */
const PROBES = [
  { name: 'status', path: '/status', init: {}, allow: [200] },
  { name: 'status-remote', path: '/status', init: { headers: REMOTE }, allow: [401] },
  // NO remote origin: the D-24 waiver grants a local caller a full admin session, so the
  // request reaches the password check and answers 403. With the origin it stops at 401 in
  // the auth gate instead - a different code from a different place, which is not the 403
  // witness 2 saw. Matching the shipped test at auth-routes.test.ts:232 exactly matters here.
  { name: 'reset', path: '/admin/factory-reset', init: { method: 'POST', body: '{}' }, allow: [403] },
  { name: 'restart', path: '/admin/restart', init: { method: 'POST' }, allow: [403] },
  { name: 'restart-get', path: '/admin/restart', init: {}, allow: [405] },
  { name: 'nope', path: '/nope', init: {}, allow: [404] },
] as const;

/**
 * THE CAUSE, AND THE FIX (see the ticket comment for the full derivation).
 *
 * `bind: 'all'` resolves to `['::']` - the dual-stack wildcard - and a wildcard bind does NOT
 * exclude a process that binds `127.0.0.1:P` specifically. Both `listen` calls succeed, and
 * IPv4 traffic to `127.0.0.1:P` goes to the MORE SPECIFIC bind: the stranger, not us. On this
 * machine the stranger is Tailscale's local API, which answers `403 invalid localapi request`
 * - which is #49's witness 2 exactly, a `403` on `/status` that no handler here can produce.
 *
 * So the rig binds LOOPBACK, which is exclusive: nothing else can hold `127.0.0.1:P` at the
 * same time, and `http://127.0.0.1:P` can then only reach the app under test.
 *
 * Set `CROSS_BIND_ALL=1` to put the rig back on the wildcard. That is the NEGATIVE CONTROL,
 * and it is kept deliberately: a harness that has never been seen to fail is not evidence that
 * the property holds. It needs several thousand iterations to catch a collision.
 */
const BIND_ALL = process.env.CROSS_BIND_ALL === '1';

async function boot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-cross-'));
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config.json'),
    port: 0, // DELIBERATE. See the header - the ephemeral port IS the mechanism under test.
    bind: BIND_ALL ? 'all' : 'loopback',
    driver: new StubDriver(),
    log: () => {},
  });
  t.after(() => app.close().catch(() => {}));
  return app;
}

interface Odd {
  iteration: number;
  port: number;
  probe: string;
  url: string;
  status: number | string;
  contentType: string | null;
  body: string;
}

test(`#49: a response never reaches the wrong request (${N} recycled ephemeral ports)`, async (t) => {
  const odd: Odd[] = [];
  const ports: number[] = [];
  let reused = 0;

  for (let i = 0; i < N; i++) {
    const app = await boot(t);
    const port = app.port;
    if (ports.includes(port)) reused++;
    ports.push(port);
    const base = `http://127.0.0.1:${port}`;

    // A marker only THIS app can answer with. If a `/status` body ever carries another
    // iteration's marker, the response came from another app and the port is the reason.
    const marker = `cross-${i}-${port}`;
    await fetch(`${base}/message`, { method: 'PUT', body: JSON.stringify({ text: marker }) });

    // Concurrent on purpose: one socket per request is the easy case, and the pool reusing a
    // socket between two in-flight requests is the case the hypothesis is about.
    const results = await Promise.all(
      PROBES.map(async (p) => {
        const url = `${base}${p.path}`;
        try {
          const res = await fetch(url, p.init as RequestInit);
          return { p, url, status: res.status, ct: res.headers.get('content-type'), body: await res.text() };
        } catch (err) {
          return { p, url, status: `THREW ${err instanceof Error ? err.message : String(err)}`, ct: null, body: '' };
        }
      }),
    );

    for (const r of results) {
      const allowed: readonly number[] = r.p.allow;
      const wrongStatus = typeof r.status !== 'number' || !allowed.includes(r.status);
      if (wrongStatus) {
        odd.push({ iteration: i, port, probe: r.p.name, url: r.url, status: r.status, contentType: r.ct, body: r.body.slice(0, 400) });
      } else if (r.p.name === 'status' && !r.body.includes(marker)) {
        // The right STATUS from the wrong APP. Witness 1's shape: a 200 whose body is not the
        // answer to this question.
        odd.push({ iteration: i, port, probe: 'status-marker', url: r.url, status: r.status, contentType: r.ct, body: r.body.slice(0, 400) });
      }
    }

    await app.close();
  }

  t.diagnostic(`${N} apps, ${new Set(ports).size} distinct ports, ${reused} port reuses`);
  assert.deepEqual(odd, [], `a response reached the wrong request:\n${JSON.stringify(odd, null, 2)}`);
});

/**
 * WITNESS 3'S PROPERTY, and it is a different one: a connect that neither succeeds nor is
 * refused. `connect ETIMEDOUT 127.0.0.1:57768` is odd on its face - a loopback port with no
 * listener answers with RST immediately, it does not hang - so something was bound there and
 * not accepting. That is the same substrate as the test above (a recycled ephemeral port), so
 * it is hunted in the same file, but it is NOT the same failure and is asserted separately.
 *
 * The deadline is generous and is not a latency measurement: loopback refusal is sub-millisecond,
 * so anything approaching a second is the pathology, not a slow machine.
 */
test(`#49/witness 3: a closed ephemeral port is REFUSED, never left hanging (${N} ports)`, async (t) => {
  const slow: Array<{ port: number; ms: number; outcome: string }> = [];

  for (let i = 0; i < N; i++) {
    const app = await boot(t);
    const port = app.port;
    // Establish a real connection first, so undici has a pooled socket for this origin - which
    // is the state the hypothesis says matters. Then take the listener away underneath it.
    await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.text());
    await app.close();

    const began = Date.now();
    let outcome = 'ANSWERED - a closed port must not answer';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      await res.text();
    } catch (err) {
      outcome = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    }
    const ms = Date.now() - began;
    // A refusal, or a "socket is gone" error, both promptly. Only hanging - or answering - is
    // the finding.
    if (ms > 1000 || outcome.startsWith('ANSWERED')) slow.push({ port, ms, outcome });
  }

  assert.deepEqual(slow, [], `a closed loopback port did not refuse promptly:\n${JSON.stringify(slow, null, 2)}`);
});
