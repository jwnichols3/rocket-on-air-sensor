import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { NoopDriver } from '../src/driver.js';
import { DriverConfigError, EsphomeTextDriver } from '../src/esphome-driver.js';
import { UNKNOWN_ID } from '../src/state.js';

test('noop driver logs the level and reports unknown', async () => {
  const lines: string[] = [];
  const driver = new NoopDriver((line) => lines.push(line));
  assert.equal(await driver.set('on-air'), UNKNOWN_ID);
  assert.equal(await driver.set('available'), UNKNOWN_ID);
  assert.equal(await driver.read(), UNKNOWN_ID);
  assert.deepEqual(lines, ['[noop-driver] light -> ON-AIR', '[noop-driver] light -> AVAILABLE']);
});

/**
 * A stand-in for the device's `text` entity: same URL shapes, same "the POST 200 proves
 * nothing" lie, and the same two silent-drop traps measured on the board (D-44) - a value
 * outside [min_length, max_length] is answered 200 and discarded.
 */
interface FakeDevice {
  base: string;
  host: string;
  posts: string[];
  gets: string[];
  auth: string[];
  value: string;
  minLength: number;
  maxLength: number;
  /** When set, the POST is accepted with 200 but the value is NOT applied. */
  swallowWrites: boolean;
  /** The device answers the POST BEFORE applying the value. This models that gap. */
  applyDelayMs: number;
  status: number | null;
  frames: number;
  close: () => Promise<void>;
}

async function fakeDevice(): Promise<FakeDevice> {
  const d: Partial<FakeDevice> = {
    posts: [], gets: [], auth: [], value: 'on-air', minLength: 1, maxLength: 64,
    swallowWrites: false, applyDelayMs: 0, status: null, frames: 0,
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    d.auth!.push(req.headers.authorization ?? '');
    if (d.status !== null && d.status !== undefined) {
      res.writeHead(d.status).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/text/PresenceKey/set') {
      // esp_http_server rejects a POST with no Content-Length before any handler runs.
      if (req.headers['content-length'] === undefined) {
        res.writeHead(411).end('Client must specify Content-Length');
        return;
      }
      const v = url.searchParams.get('value') ?? '';
      d.posts!.push(v);
      // The device answers BEFORE applying, and silently drops an invalid value.
      res.writeHead(200, { 'content-length': '0' }).end();
      const apply = (): void => {
        if (d.swallowWrites) return;
        if (v.length < d.minLength! || v.length > d.maxLength!) return;
        d.value = v;
      };
      if (d.applyDelayMs! > 0) setTimeout(apply, d.applyDelayMs!).unref();
      else apply();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/text/PresenceKey') {
      d.gets!.push(url.search);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'text/PresenceKey', value: d.value, state: d.value,
          min_length: d.minLength, max_length: d.maxLength, pattern: '',
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sensor/Frames') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: 'sensor/Frames', value: d.frames, state: String(d.frames) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  d.host = `127.0.0.1:${port}`;
  d.base = `http://${d.host}`;
  d.close = () => new Promise<void>((r) => server.close(() => r()));
  return d as FakeDevice;
}

function driverFor(d: FakeDevice, over: Record<string, unknown> = {}) {
  return new EsphomeTextDriver({ host: d.host, timeoutMs: 1000, retryGapMs: 1, log: () => {}, ...over });
}

test('set writes ?value= to the text entity and reports what the device read back', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.equal(await driver.set('interruptible'), 'interruptible');
  assert.deepEqual(d.posts, ['interruptible']);
  await d.close();
});

test('the POST carries a Content-Length: the device answers 411 without one', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  // A 411 would fail the write outright, so a successful set proves the header went out.
  assert.equal(await driver.set('available'), 'available');
  await d.close();
});

test('a 200 that did not apply is caught by the read-back, not trusted', async () => {
  const d = await fakeDevice();
  d.swallowWrites = true;
  const driver = driverFor(d);
  assert.equal(await driver.set('available'), 'on-air', 'the read-back must win over the 200');
  await d.close();
});

test('an over-length value is answered 200 and dropped; only the read-back sees it', async () => {
  const d = await fakeDevice();
  d.maxLength = 3; // "available" no longer fits, exactly as a too-long row id would not
  const driver = driverFor(d);
  assert.equal(await driver.set('available'), 'on-air', 'a length violation must not be reported as applied');
  await d.close();
});

test('read reports the device state, and unknown when it is unreachable', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  d.value = 'available';
  assert.equal(await driver.read(), 'available');
  await d.close();
  assert.equal(await driver.read(), UNKNOWN_ID, 'a dead device is unknown, never a state');
});

test('read reports the raw key, even one this build has never heard of', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  // `text` accepts arbitrary keys (measured, D-44), and this driver deliberately does NOT
  // hold the state table - it reports what the device has and the caller, which does hold
  // the table, decides whether that is a row it knows. Two copies of the vocabulary is one
  // more than can be kept in agreement.
  d.value = 'focus-block';
  assert.equal(await driver.read(), 'focus-block');
  await d.close();
});

test('an empty or unreadable device value is unknown, never a bare empty string', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  d.value = '';
  // "" is not a state, and a renderer handed one draws nothing - which looks exactly like
  // a calm panel. It must arrive as `unknown`, which is a real row and is never calm.
  assert.equal(await driver.read(), UNKNOWN_ID);
  await d.close();
  assert.equal(await driver.read(), UNKNOWN_ID, 'and so is a dead device');
});

test('set never throws when the device is gone', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  await d.close();
  assert.equal(await driver.set('on-air'), UNKNOWN_ID);
});

test('basic auth is sent pre-emptively on every request', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { username: 'onair', password: 'hunter2' });
  await driver.set('on-air');
  const expected = `Basic ${Buffer.from('onair:hunter2').toString('base64')}`;
  assert.equal(d.auth.length >= 2, true, 'both the POST and the read-back are authenticated');
  assert.deepEqual([...new Set(d.auth)], [expected]);
  await d.close();
});

test('verifyEntity confirms the entity is there, and asks it for nothing else', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.equal(await driver.verifyEntity(), true);
  // The device no longer declares a set of valid states, so there is no option list to
  // compare against and no stale-firmware warning to derive from one (D-38).
  await d.close();
});

test('verifyEntity throws DriverConfigError on 404: a wrong entity name is a deploy bug', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { entity: 'Nope' });
  await assert.rejects(() => driver.verifyEntity(), DriverConfigError);
  await d.close();
});

test('verifyEntity throws DriverConfigError on 401', async () => {
  const d = await fakeDevice();
  d.status = 401;
  const driver = driverFor(d);
  await assert.rejects(() => driver.verifyEntity(), DriverConfigError);
  await d.close();
});

test('verifyEntity returns null for an unreachable device: do not crash on a dead light', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  await d.close();
  assert.equal(await driver.verifyEntity(), null);
});

test('repainted reports true as soon as the frame counter advances', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.equal(await driver.repainted(), null, 'the first call has nothing to compare to');
  d.frames = 7;
  assert.equal(await driver.repainted(), true);
  await d.close();
});

test('repainted says "cannot tell", not "frozen", while the sensor has yet to republish', async () => {
  const d = await fakeDevice();
  // The device publishes Frames on its own interval. Polling faster than that sees the
  // same value twice, which is not evidence the panel stopped - and calling it frozen
  // drops `confirmed` to unknown on a perfectly healthy panel.
  const driver = driverFor(d, { frozenAfterMs: 10_000 });
  await driver.repainted();
  assert.equal(await driver.repainted(), null, 'an unchanged counter alone proves nothing');
  await d.close();
});

test('repainted does report frozen once the counter has been static long enough', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { frozenAfterMs: 30 });
  await driver.repainted();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await driver.repainted(), false, 'a genuinely stuck panel must still be caught');
  await d.close();
});

test('a transient failure is retried once', async () => {
  const d = await fakeDevice();
  d.status = 503;
  const driver = driverFor(d, { retries: 1 });
  const before = d.auth.length;
  assert.equal(await driver.read(), 'unknown');
  assert.equal(d.auth.length - before, 2, 'one attempt plus one retry');
  await d.close();
});

test('set waits out the apply gap: the device answers the POST before the value lands', async () => {
  const d = await fakeDevice();
  d.applyDelayMs = 120; // the 200 arrives first; an immediate read-back sees the OLD value
  const driver = driverFor(d);
  assert.equal(await driver.set('interruptible'), 'interruptible', 'must not report the pre-write value');
  await d.close();
});

test('set still reports the truth when the write genuinely never applies', async () => {
  const d = await fakeDevice();
  d.swallowWrites = true;
  const driver = driverFor(d);
  assert.equal(await driver.set('available'), 'on-air', 'a dropped value must not be papered over by retries');
  await d.close();
});
