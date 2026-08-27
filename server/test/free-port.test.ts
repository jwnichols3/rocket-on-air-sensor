import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { resolveBind } from '../src/config-store.js';
import { freePort } from './free-port.js';

/** Binds one address and hands back a closer, so a test can hold a port on purpose. */
async function hold(address: string): Promise<{ port: number; close: () => Promise<void> }> {
  const s: Server = createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, address, () => {
      s.removeListener('error', reject);
      resolve();
    });
  });
  return {
    port: (s.address() as { port: number }).port,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

function listen(port: number, address?: string): Promise<Error | null> {
  return new Promise((resolve) => {
    const s = createServer(() => {});
    s.once('error', (err) => resolve(err));
    const done = () => s.close(() => resolve(null));
    address === undefined ? s.listen(port, done) : s.listen(port, address, done);
  });
}

test('the port is outside BOTH OS ephemeral ranges, so nothing can be handed it underneath us', async () => {
  // macOS allocates 49152-65535, Linux 32768-60999. A port from `listen(0)` is drawn from
  // that pool and can be redrawn the instant it is released - which is what `EADDRINUSE
  // :::54460` was (#58). 54460 sits inside both.
  for (let i = 0; i < 8; i++) {
    const p = await freePort();
    assert.ok(p >= 20_000 && p <= 32_767, `${p} must be below every ephemeral range`);
  }
});

test('two calls never collide, however many times they are asked', async () => {
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) seen.add(await freePort());
  assert.equal(seen.size, 40, 'a repeated port would put two concurrent tests on one socket');
});

test('the port it hands out is bindable on the scope the service actually binds', async () => {
  // Not a paraphrase of the helper: this reads the same resolveBind() app.ts does.
  assert.deepEqual(resolveBind('all').addresses, ['::']);
  const p = await freePort();
  assert.equal(await listen(p, '::'), null);
});

test('A LOOPBACK PROBE IS NOT ENOUGH - this is the flake the old helper had', async (t) => {
  // The deterministic core of #58, and the reason the ticket's own fix direction was aimed at
  // the wrong code: the `blocker` it told us to make atomic already was. Measured matrix,
  // this machine, holder down the side and the attempted bind across:
  //
  //     holder      127.0.0.1   ::1   ::           wildcard
  //     127.0.0.1   EADDRINUSE  OK    OK           OK
  //     ::1         OK          EADDRINUSE  OK     OK
  //     ::          OK          OK    EADDRINUSE   EADDRINUSE
  //
  // Read the last row. A port held on the WILDCARD still binds happily on 127.0.0.1 - so the
  // old helper, which probed only 127.0.0.1, called such a port free. Then the service bound
  // `::` (resolveBind('all')) and got EADDRINUSE on an address the probe never looked at.
  // That is `EADDRINUSE :::54460`, and the wildcard holder in a run like this is easy to come
  // by: every other test file boots the same app on `::`, and this file's own `blocker` takes
  // an ephemeral wildcard port out of the very pool the old helper drew from.
  const held = await hold('::');
  t.after(() => held.close());

  assert.equal(await listen(held.port, '127.0.0.1'), null, 'the old probe would call this port free');
  const wildcard = await listen(held.port);
  assert.ok(wildcard, 'but the wildcard bind - what listenAll() does for bind:all - fails');
  assert.match(String((wildcard as NodeJS.ErrnoException).code), /EADDRINUSE/);

  // And the fix, stated as behaviour rather than as implementation: the helper cannot hand
  // out a port that is busy on the wildcard, because that is the scope it now probes.
  for (let i = 0; i < 8; i++) assert.notEqual(await freePort(), held.port);
});
