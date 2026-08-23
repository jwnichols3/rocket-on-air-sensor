import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { NoopDriver } from '../src/driver.js';
import { DriverConfigError, EsphomeSelectDriver } from '../src/esphome-driver.js';

test('noop driver logs the level and reports unknown', async () => {
  const lines: string[] = [];
  const driver = new NoopDriver((line) => lines.push(line));
  assert.equal(await driver.set('dnd'), 'unknown');
  assert.equal(await driver.set('available'), 'unknown');
  assert.equal(await driver.read(), 'unknown');
  assert.deepEqual(lines, ['[noop-driver] light -> DND', '[noop-driver] light -> AVAILABLE']);
});

/** A stand-in for the device: same URL shapes, same "the POST 200 proves nothing" lie. */
interface FakeDevice {
  base: string;
  host: string;
  posts: string[];
  gets: string[];
  auth: string[];
  option: string;
  /** When set, the POST is accepted with 200 but the value is NOT applied. */
  swallowWrites: boolean;
  /** The device answers the POST BEFORE applying the value. This models that gap. */
  applyDelayMs: number;
  status: number | null;
  frames: number;
  close: () => Promise<void>;
}

async function fakeDevice(): Promise<FakeDevice> {
  const d: Partial<FakeDevice> = { posts: [], gets: [], auth: [], option: 'dnd', swallowWrites: false, applyDelayMs: 0, status: null, frames: 0 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    d.auth!.push(req.headers.authorization ?? '');
    if (d.status !== null && d.status !== undefined) {
      res.writeHead(d.status).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/select/Presence/set') {
      d.posts!.push(url.searchParams.get('option') ?? '');
      // The device answers BEFORE applying, and silently drops an invalid option.
      res.writeHead(200, { 'content-length': '0' }).end();
      const opt = url.searchParams.get('option');
      const apply = (): void => {
        if (!d.swallowWrites && opt && ['dnd', 'interruptible', 'available'].includes(opt)) d.option = opt;
      };
      if (d.applyDelayMs! > 0) setTimeout(apply, d.applyDelayMs!).unref();
      else apply();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/select/Presence') {
      d.gets!.push(url.search);
      const body: Record<string, unknown> = { id: 'select/Presence', value: d.option, state: d.option };
      if (url.searchParams.get('detail') === 'all') body.option = ['dnd', 'interruptible', 'available'];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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
  return new EsphomeSelectDriver({ host: d.host, timeoutMs: 1000, retryGapMs: 1, log: () => {}, ...over });
}

test('set writes the option and reports what the device read back', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.equal(await driver.set('interruptible'), 'interruptible');
  assert.deepEqual(d.posts, ['interruptible']);
  await d.close();
});

test('a 200 that did not apply is caught by the read-back, not trusted', async () => {
  const d = await fakeDevice();
  d.swallowWrites = true;
  const driver = driverFor(d);
  assert.equal(await driver.set('available'), 'dnd', 'the read-back must win over the 200');
  await d.close();
});

test('read reports the device state, and unknown when it is unreachable', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  d.option = 'available';
  assert.equal(await driver.read(), 'available');
  await d.close();
  assert.equal(await driver.read(), 'unknown', 'a dead device is unknown, never a level');
});

test('set never throws when the device is gone', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  await d.close();
  assert.equal(await driver.set('dnd'), 'unknown');
});

test('basic auth is sent pre-emptively on every request', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { username: 'onair', password: 'hunter2' });
  await driver.set('dnd');
  const expected = `Basic ${Buffer.from('onair:hunter2').toString('base64')}`;
  assert.equal(d.auth.length >= 2, true, 'both the POST and the read-back are authenticated');
  assert.deepEqual([...new Set(d.auth)], [expected]);
  await d.close();
});

test('verifyOptions returns the device option list', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.deepEqual(await driver.verifyOptions(), ['dnd', 'interruptible', 'available']);
  await d.close();
});

test('verifyOptions throws DriverConfigError on 404: a wrong entity name is a deploy bug', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { entity: 'Nope' });
  await assert.rejects(() => driver.verifyOptions(), DriverConfigError);
  await d.close();
});

test('verifyOptions throws DriverConfigError on 401', async () => {
  const d = await fakeDevice();
  d.status = 401;
  const driver = driverFor(d);
  await assert.rejects(() => driver.verifyOptions(), DriverConfigError);
  await d.close();
});

test('verifyOptions returns null for an unreachable device: do not crash on a dead light', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  await d.close();
  assert.equal(await driver.verifyOptions(), null);
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
  assert.equal(await driver.set('available'), 'dnd', 'a dropped option must not be papered over by retries');
  await d.close();
});
