import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { deviceSpecs } from '../src/config.js';
import { defaultConfig, validateConfig, type DeviceRow, type OnAirConfig } from '../src/config-store.js';

// --------------------------------------------------------------------- migration

/** A raw document as it exists on disk today: `light`, and no `devices` key at all. */
function legacyDoc(light: Partial<OnAirConfig['light']> = {}): Record<string, unknown> {
  const d = defaultConfig();
  return { ...d, light: { ...d.light, ...light }, devices: undefined };
}

function ok(raw: unknown): OnAirConfig {
  const v = validateConfig(raw);
  assert.equal(v.ok, true, v.ok ? '' : `unexpected errors: ${v.errors.join('; ')}`);
  return (v as { ok: true; config: OnAirConfig }).config;
}

function errs(raw: unknown): string[] {
  const v = validateConfig(raw);
  assert.equal(v.ok, false, 'expected validation to fail, it passed');
  return (v as { ok: false; errors: string[] }).errors;
}

test('a document with NO devices key migrates its light into one primary row', () => {
  const c = ok(legacyDoc({ host: '10.0.0.5', username: 'rocket', password: 'ESP32' }));
  assert.equal(c.devices.length, 1);
  const [row] = c.devices;
  assert.equal(row!.host, '10.0.0.5');
  assert.equal(row!.password, 'ESP32');
  assert.equal(row!.primary, true, 'the migrated row is not primary, so nothing is authoritative');
  assert.equal(row!.enabled, true);
});

test('a WHOLLY DEFAULT light migrates to NO devices - a fresh install has no light', () => {
  // `light.host: null` has always meant "no light". Inventing a hostless device row here
  // would put an unfinished entry in the console of every new install.
  assert.deepEqual(ok(legacyDoc()).devices, []);
});

test('a light with only a custom ENTITY still migrates - no field is silently dropped', () => {
  const c = ok(legacyDoc({ entity: 'OnAirKey' }));
  assert.equal(c.devices.length, 1);
  assert.equal(c.devices[0]!.entity, 'OnAirKey');
});

test('light is RECOMPUTED from the primary, never read back from the payload', () => {
  const c = ok({
    ...defaultConfig(),
    devices: [row({ id: 'crow', host: '10.0.0.7', primary: true })],
    light: undefined,
  });
  assert.equal(c.light.host, '10.0.0.7', 'light did not follow the primary device');
});

test('light follows the PRIMARY, not the first row', () => {
  const c = ok({
    ...defaultConfig(),
    devices: [row({ id: 'elegoo', host: '10.0.0.8' }), row({ id: 'crow', host: '10.0.0.7', primary: true })],
    light: undefined,
  });
  assert.equal(c.light.host, '10.0.0.7');
});

test('a light that CONTRADICTS its own devices is refused, never quietly resolved', () => {
  // The failure this prevents: an old client fetches the document, edits `light`, puts it
  // back, and gets a 200 with no change because `devices` won. Silent success is the
  // failure mode this project keeps being bitten by (D-79, D-100).
  const e = errs({
    ...defaultConfig(),
    devices: [row({ id: 'crow', host: '10.0.0.7', primary: true })],
    light: { host: '10.0.0.9', entity: 'PresenceKey', username: null, password: null },
  });
  assert.equal(e.length, 1);
  assert.match(e[0]!, /light\.host disagrees with the primary device/);
  assert.match(e[0]!, /edit `devices` instead/, 'the error does not say how to fix it');
});

test('an EMPTY devices list cannot contradict anything, so a seeded light still migrates', () => {
  // index.ts's first-boot seedConfig folds ONAIR_LIGHT_* onto a default document, which
  // carries `devices: []`. An empty list names no primary, so there is nothing to disagree.
  const c = ok({ ...defaultConfig(), devices: [], light: { ...defaultConfig().light, host: '10.0.0.5' } });
  assert.equal(c.devices.length, 1);
  assert.equal(c.devices[0]!.host, '10.0.0.5');
});

// --------------------------------------------------------------------- validation

function row(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'dev',
    label: 'A panel',
    host: '10.0.0.1',
    entity: 'PresenceKey',
    username: null,
    password: null,
    enabled: true,
    primary: false,
    order: 0,
    ...over,
  };
}

const base = (devices: DeviceRow[]): Record<string, unknown> => ({
  ...defaultConfig(),
  devices,
  light: undefined,
});

test('a duplicate device id is refused', () => {
  const e = errs(base([row({ id: 'a', primary: true }), row({ id: 'a' })]));
  assert.ok(e.some((m) => /devices\[1\]\.id "a" is a duplicate/.test(m)), e.join('; '));
});

test('a device id that is not a slug is refused', () => {
  const e = errs(base([row({ id: 'Not A Slug', primary: true })]));
  assert.ok(e.some((m) => /devices\[0\]\.id must match/.test(m)), e.join('; '));
});

test('a list with NO primary is refused - nothing would be authoritative', () => {
  const e = errs(base([row({ id: 'a' }), row({ id: 'b' })]));
  assert.ok(e.some((m) => /exactly one device must be primary/.test(m)), e.join('; '));
});

test('a list with TWO primaries is refused, and the error names both', () => {
  const e = errs(base([row({ id: 'a', primary: true }), row({ id: 'b', primary: true })]));
  const m = e.find((x) => /exactly one device must be primary, got 2/.test(x));
  assert.ok(m, e.join('; '));
  assert.match(m!, /a, b/);
});

test('a DISABLED primary is refused - confirmed cannot describe a panel we never write to', () => {
  const e = errs(base([row({ id: 'a', primary: true, enabled: false })]));
  assert.ok(e.some((x) => /the primary device "a" cannot be disabled/.test(x)), e.join('; '));
});

test('an EMPTY device list is legal and means no light', () => {
  const c = ok(base([]));
  assert.deepEqual(c.devices, []);
  assert.equal(c.light.host, null);
});

test('a device order outside 0-999 is refused', () => {
  const e = errs(base([row({ id: 'a', primary: true, order: 1000 })]));
  assert.ok(e.some((x) => /devices\[0\]\.order must be an integer 0-999/.test(x)), e.join('; '));
});

// --------------------------------------------------------------------- deviceSpecs

const ENV_HOST = { ONAIR_LIGHT_HOST: '10.9.9.9' } as NodeJS.ProcessEnv;

test('the env overlay repoints the PRIMARY and leaves secondaries alone', () => {
  const devices = [row({ id: 'crow', host: '10.0.0.7', primary: true }), row({ id: 'elegoo', host: '10.0.0.8' })];
  const specs = deviceSpecs(devices, ENV_HOST);
  assert.equal(specs.find((s) => s.id === 'crow')!.host, '10.9.9.9', 'the SSH escape hatch is gone');
  assert.equal(specs.find((s) => s.id === 'elegoo')!.host, '10.0.0.8', 'the overlay repointed a secondary too');
});

test('a DISABLED device is not driven at all', () => {
  const specs = deviceSpecs([row({ id: 'a', primary: true }), row({ id: 'b', enabled: false })], {});
  assert.deepEqual(specs.map((s) => s.id), ['a']);
});

test('a device with no address yet is skipped rather than driven', () => {
  const specs = deviceSpecs([row({ id: 'a', primary: true }), row({ id: 'b', host: null })], {});
  assert.deepEqual(specs.map((s) => s.id), ['a']);
});

// --------------------------------------------------------------------- end to end

/** A minimal ESPHome `text` device: enough for verifyEntity, set and read-back. */
async function fakePanel(): Promise<{ host: string; value: string; posts: string[]; close: () => Promise<void> }> {
  const d = { value: 'unknown', posts: [] as string[] };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/text/PresenceKey/set') {
      const v = url.searchParams.get('value') ?? '';
      d.posts.push(v);
      d.value = v;
      res.writeHead(200, { 'content-length': '0' }).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/text/PresenceKey') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ id: 'text/PresenceKey', value: d.value, state: d.value, min_length: 1, max_length: 64, pattern: '' }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    host: `127.0.0.1:${port}`,
    get value() {
      return d.value;
    },
    get posts() {
      return d.posts;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function boot(t: TestContext, devices: DeviceRow[]): Promise<{ base: string; config: () => OnAirConfig }> {
  const dir = await mkdtemp(join(tmpdir(), 'onair-devices-'));
  const configFile = join(dir, 'config.json');
  const app = await createApp({
    configFile,
    stateFile: join(dir, 'state.json'),
    port: 0,
    bind: 'loopback',
    // `light` is left as the default: seedConfig's output is written straight to disk
    // without going through validateConfig, so it must already be a complete document.
    // The projection is recomputed on the first load, which is what the first assertion of
    // the repoint test relies on.
    seedConfig: (b) => ({ ...b, devices }),
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${app.port}`, config: app.config };
}

test('a device edit in the console reaches the NEW panel with NO restart', async (t) => {
  const a = await fakePanel();
  const b = await fakePanel();
  t.after(async () => {
    await a.close();
    await b.close();
  });

  const h = await boot(t, [row({ id: 'primary', host: a.host, primary: true })]);
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  assert.equal(a.value, 'on-air', 'the original panel never got the first write');

  // Repoint at panel B through the ordinary admin route, exactly as the console does.
  const live = (await (await fetch(`${h.base}/admin/config`)).json()).config as OnAirConfig;
  const put = await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...live, devices: [row({ id: 'primary', host: b.host, primary: true })], light: undefined }),
  });
  assert.equal(put.status, 200, `the save failed: ${await put.text()}`);

  await fetch(`${h.base}/state/available`, { method: 'POST' });

  // THE ASSERTION THIS WHOLE TEST EXISTS FOR. Before applyConfig reconfigured the driver,
  // this save returned 200, persisted, and left the process driving panel A until somebody
  // restarted the daemon.
  assert.equal(b.value, 'available', `the new panel was never written to; it still reads ${b.value}`);
  assert.equal(a.value, 'on-air', 'the OLD panel was still being driven after the repoint');
});

test('a state write reaches BOTH panels, and the primary is what confirmed reports', async (t) => {
  const a = await fakePanel();
  const b = await fakePanel();
  t.after(async () => {
    await a.close();
    await b.close();
  });

  const h = await boot(t, [
    row({ id: 'crow', host: a.host, primary: true }),
    row({ id: 'elegoo', host: b.host }),
  ]);
  const res = await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  assert.equal(res.status, 200);

  assert.equal(a.value, 'on-air');
  // The secondary settles behind the primary, so give the fan-out a beat to drain. This is
  // an ABSENCE-free assertion - it waits for a POSITIVE - so a slow machine only makes it
  // take longer, never makes it wrong (D-127).
  const deadline = Date.now() + 2000;
  while (b.value !== 'on-air' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.value, 'on-air', 'the second panel never got the write');

  const status = await (await fetch(`${h.base}/status`)).json();
  assert.equal(status.confirmed, 'on-air');
});

test('a DEAD secondary does not stop the primary being confirmed', async (t) => {
  const a = await fakePanel();
  t.after(() => a.close());

  // 127.0.0.1:1 refuses promptly, which is the closest thing to a switched-off bench board
  // that a test can have without waiting out a real timeout.
  const h = await boot(t, [
    row({ id: 'crow', host: a.host, primary: true }),
    row({ id: 'elegoo', host: '127.0.0.1:1' }),
  ]);
  const res = await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  assert.equal(res.status, 200, 'an absent bench board turned a good write into a failure');
  assert.equal(a.value, 'on-air');
  assert.equal((await (await fetch(`${h.base}/status`)).json()).confirmed, 'on-air');
});

test('admin health lists every device, including a disabled one, and names the dead one', async (t) => {
  const a = await fakePanel();
  t.after(() => a.close());

  const h = await boot(t, [
    row({ id: 'crow', label: 'CrowPanel', host: a.host, primary: true }),
    row({ id: 'elegoo', label: 'Elegoo', host: '127.0.0.1:1' }),
    row({ id: 'spare', label: 'Spare', host: '10.0.0.3', enabled: false }),
  ]);
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });

  // Re-posting each turn matters: the fan-out SKIPS a device whose previous write is still
  // in flight (that is #68's protection), and a write to a refused port takes long enough
  // that the very first attempt can be the one still outstanding. Polling health alone would
  // then time out against a device that had simply not been asked yet.
  const deadline = Date.now() + 5000;
  let devices: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    devices = (await (await fetch(`${h.base}/admin/health`)).json()).devices;
    if (devices.find((d) => d.id === 'elegoo')?.reachable === false) break;
    await fetch(`${h.base}/state/on-air`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.deepEqual(devices.map((d) => d.id), ['crow', 'elegoo', 'spare']);
  assert.equal(devices.find((d) => d.id === 'crow')!.reachable, true);
  assert.equal(devices.find((d) => d.id === 'elegoo')!.reachable, false, 'a dead panel is not reported as dead');
  assert.ok(devices.find((d) => d.id === 'elegoo')!.lastError, 'the dead panel has no error to show');
  // A disabled row is LISTED (the operator put it there) and makes NO CLAIM (nobody asked).
  assert.equal(devices.find((d) => d.id === 'spare')!.reachable, null);
  assert.equal(devices.find((d) => d.id === 'spare')!.enabled, false);
  assert.equal(devices.find((d) => d.id === 'crow')!.label, 'CrowPanel');
});
