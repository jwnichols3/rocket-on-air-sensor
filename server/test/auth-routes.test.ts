import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USER, DEFAULT_PASSPHRASE } from '../src/auth.js';
import type { OnAirConfig } from '../src/config-store.js';
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

/**
 * The header that takes the D-24 waiver off the table, so a credential is actually
 * demanded. Every request from a test process is a genuine local one and would otherwise
 * be waived - correctly. This is what a client from elsewhere looks like from here.
 */
const REMOTE = { origin: 'http://10.42.14.189:9099' };

async function boot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-auth-'));
  const configFile = join(dir, 'config.json');
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile,
    port: 0,
    driver: new StubDriver(),
    log: () => {},
  });
  t.after(() => app.close().catch(() => {}));
  return { app, configFile, base: `http://127.0.0.1:${app.port}` };
}

const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const bearer = (v: string) => ({ ...REMOTE, authorization: `Bearer ${v}` });

// ------------------------------------------------ the passphrase gates data

test('a data route demands the passphrase from a non-local client', async (t) => {
  const h = await boot(t);
  assert.equal((await fetch(`${h.base}/status`, { headers: REMOTE })).status, 401);
  assert.equal((await fetch(`${h.base}/status`, { headers: bearer(DEFAULT_PASSPHRASE) })).status, 200);
  assert.equal((await fetch(`${h.base}/status`, { headers: bearer('wrong') })).status, 401);
});

test('every data route is gated, and the two public ones are not', async (t) => {
  const h = await boot(t);
  for (const path of ['/status', '/config/states', '/events']) {
    assert.equal((await fetch(`${h.base}${path}`, { headers: REMOTE })).status, 401, path);
  }
  for (const path of ['/public/status', '/display']) {
    const res = await fetch(`${h.base}${path}`, { headers: REMOTE });
    assert.equal(res.status, 200, path);
    await res.text();
  }
});

test('?passphrase= works where a header cannot, and ?token= is still accepted', async (t) => {
  const h = await boot(t);
  const p = DEFAULT_PASSPHRASE;
  assert.equal((await fetch(`${h.base}/status?passphrase=${p}`, { headers: REMOTE })).status, 200);
  assert.equal((await fetch(`${h.base}/status?token=${p}`, { headers: REMOTE })).status, 200);
});

test('a query credential is refused on a WRITE - it would land in logs and history', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/state/on-air?passphrase=${DEFAULT_PASSPHRASE}`, {
    method: 'POST',
    headers: REMOTE,
  });
  assert.equal(res.status, 401);
});

// --------------------------------------- NEITHER credential on the other's routes

test('the passphrase does NOT open an admin route', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/config`, { headers: bearer(DEFAULT_PASSPHRASE) });
  assert.equal(res.status, 401);
  assert.match(String((await json(res)).error), /admin session/);
});

test('an admin session does NOT open a data route', async (t) => {
  const h = await boot(t);
  const session = await json(
    await fetch(`${h.base}/admin/session`, {
      method: 'POST',
      headers: REMOTE,
      body: JSON.stringify({ user: DEFAULT_ADMIN_USER, password: DEFAULT_ADMIN_PASSWORD }),
    }),
  );
  const token = String(session.token);
  assert.equal((await fetch(`${h.base}/admin/config`, { headers: bearer(token) })).status, 200);
  // Two different trust questions. "You may reconfigure the system" is not "you may write
  // state", and conflating them would make the split D-35 exists to create decorative.
  assert.equal((await fetch(`${h.base}/status`, { headers: bearer(token) })).status, 401);
});

// ------------------------------------------------------------ admin sessions

test('the admin login takes user + password, and issues a bearer session - no cookie', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/session`, {
    method: 'POST',
    headers: REMOTE,
    body: JSON.stringify({ user: DEFAULT_ADMIN_USER, password: DEFAULT_ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 200);
  // No cookie: a header cannot be forged cross-origin without a preflight, so CSRF on
  // admin routes is structurally impossible rather than defended against.
  assert.equal(res.headers.get('set-cookie'), null);
  const body = await json(res);
  assert.equal(typeof body.token, 'string');
  assert.equal(body.via, 'password');
  assert.deepEqual(body.nags, { passphrase: true, adminPassword: true }, 'a change-me nag, not a forced change');
});

test('a wrong admin password is 401, and grants nothing', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/session`, {
    method: 'POST',
    headers: REMOTE,
    body: JSON.stringify({ user: DEFAULT_ADMIN_USER, password: 'nope' }),
  });
  assert.equal(res.status, 401);
});

test('DELETE /admin/session ends it', async (t) => {
  const h = await boot(t);
  const token = String(
    (await json(
      await fetch(`${h.base}/admin/session`, {
        method: 'POST',
        headers: REMOTE,
        body: JSON.stringify({ user: DEFAULT_ADMIN_USER, password: DEFAULT_ADMIN_PASSWORD }),
      }),
    )).token,
  );
  assert.equal((await fetch(`${h.base}/admin/config`, { headers: bearer(token) })).status, 200);
  await fetch(`${h.base}/admin/session`, { method: 'DELETE', headers: bearer(token) });
  assert.equal((await fetch(`${h.base}/admin/config`, { headers: bearer(token) })).status, 401);
});

// ------------------------------------------------------------- THE WAIVER

test('locally, both credentials are invisible - the waiver grants a full admin session', async (t) => {
  const h = await boot(t);
  // No credential at all, from loopback with our Host and no foreign Origin.
  assert.equal((await fetch(`${h.base}/status`)).status, 200);
  assert.equal((await fetch(`${h.base}/admin/config`)).status, 200);
  const res = await fetch(`${h.base}/admin/session`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).via, 'waiver', 'this is what pays for having no cookie');
});

test('D-24 ATTACK 1 over HTTP: a foreign Origin from loopback is refused', async (t) => {
  const h = await boot(t);
  // Measured: the server sees remote 127.0.0.1 with origin http://10.42.14.189:9099.
  const res = await fetch(`${h.base}/state/on-air`, { method: 'POST', headers: REMOTE });
  assert.equal(res.status, 401);
  assert.equal((await json(await fetch(`${h.base}/status`))).state, UNKNOWN_ID, 'and it changed nothing');
});

test('D-24 ATTACK 2 over HTTP: another port on the same host is refused', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/config`, {
    headers: { origin: 'http://127.0.0.1:9099', 'sec-fetch-site': 'same-site' },
  });
  // A port is not part of a "site", so rejecting only `cross-site` would have let this in.
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------- rotation

test('rotating the passphrase keeps the previous one working, and persists the window', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  const res = await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, auth: { ...cfg.auth, passphrase: 'brand-new' } }),
  });
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${h.base}/status`, { headers: bearer('brand-new') })).status, 200);
  // The walk around the house: the ESP32 and Companion are still hand-configured with the
  // old one and keep working while you go and update them.
  assert.equal((await fetch(`${h.base}/status`, { headers: bearer(DEFAULT_PASSPHRASE) })).status, 200);
  const onDisk = JSON.parse(await readFile(h.configFile, 'utf8')) as OnAirConfig;
  assert.equal(onDisk.auth.previous, DEFAULT_PASSPHRASE);
  assert.equal(typeof onDisk.auth.previousUntil, 'number', 'persisted, so a restart mid-rotation does not cut them');
});

test('changing the admin password logs every session out', async (t) => {
  const h = await boot(t);
  const token = String((await json(await fetch(`${h.base}/admin/session`, { method: 'POST' }))).token);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, auth: { ...cfg.auth, adminPassword: 'something-else' } }),
  });
  // The point of changing it is that whoever knew the old one stops being admin.
  assert.equal((await fetch(`${h.base}/admin/config`, { headers: bearer(token) })).status, 401);
});

test('an empty credential in the config is a validation error, never bypassable auth', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  for (const key of ['passphrase', 'adminUser', 'adminPassword'] as const) {
    const res = await fetch(`${h.base}/admin/config`, {
      method: 'PUT',
      body: JSON.stringify({ ...cfg, auth: { ...cfg.auth, [key]: '' } }),
    });
    assert.equal(res.status, 400, key);
    assert.ok((((await json(res)).problems as string[]) ?? []).some((p) => p.includes(key)));
  }
});

// ----------------------------------------------------------- factory reset

test('FACTORY RESET ALWAYS DEMANDS THE PASSWORD - including from loopback', async (t) => {
  const h = await boot(t);
  // The waiver grants a full admin session, and this is the one thing it does not cover:
  // everything else an admin session can do is recoverable, and a factory reset on a box
  // across the house is the lockout path.
  const noBody = await fetch(`${h.base}/admin/factory-reset`, { method: 'POST', body: '{}' });
  assert.equal(noBody.status, 403);
  const wrong = await fetch(`${h.base}/admin/factory-reset`, { method: 'POST', body: JSON.stringify({ password: 'x' }) });
  assert.equal(wrong.status, 403);
});

test('factory reset restores the shipped defaults and clears the pin', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    // Deliberately NOT changing bind or port here: that would rebind the listener onto a
    // different ephemeral port mid-test. Rebinding has its own tests in config-routes.
    body: JSON.stringify({
      ...cfg,
      auth: { ...cfg.auth, passphrase: 'changed' },
      states: cfg.states.filter((r) => r.id !== 'recording'),
    }),
  });
  await fetch(`${h.base}/state/interruptible?hold=1`, { method: 'POST' });

  const res = await fetch(`${h.base}/admin/factory-reset`, {
    method: 'POST',
    body: JSON.stringify({ password: DEFAULT_ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 200);
  const after = (await json(res)).config as OnAirConfig;
  assert.equal(after.auth.passphrase, DEFAULT_PASSPHRASE, 'a FIXED default, not a random one (D-43)');
  assert.equal(after.auth.adminUser, DEFAULT_ADMIN_USER);
  assert.equal(after.auth.adminPassword, DEFAULT_ADMIN_PASSWORD);
  assert.equal(after.bind, 'all');
  assert.equal(after.port, 8484);
  assert.equal(after.states.some((r) => r.id === 'recording'), true, 'the seed table is back');

  const status = await json(await fetch(`${h.base}/status`));
  assert.equal(status.state, UNKNOWN_ID);
  assert.equal(status.hold, null);
});

test('factory reset KEEPS the device credentials - they are compiled into the firmware', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, light: { host: '10.0.0.9', entity: 'PresenceKey', username: 'onair', password: 'dev' } }),
  });
  const res = await fetch(`${h.base}/admin/factory-reset`, {
    method: 'POST',
    body: JSON.stringify({ password: DEFAULT_ADMIN_PASSWORD }),
  });
  // Not ours to reset: they were compiled into the firmware (D-17), and forgetting them
  // would take the light offline with no error - the opposite of what a reset is reached for.
  assert.equal(((await json(res)).config as OnAirConfig).light.host, '10.0.0.9');
});

test('factory reset ends every session', async (t) => {
  const h = await boot(t);
  const token = String((await json(await fetch(`${h.base}/admin/session`, { method: 'POST' }))).token);
  await fetch(`${h.base}/admin/factory-reset`, {
    method: 'POST',
    body: JSON.stringify({ password: DEFAULT_ADMIN_PASSWORD }),
  });
  assert.equal((await fetch(`${h.base}/admin/config`, { headers: bearer(token) })).status, 401);
});

// -------------------------------------------------------- the public pair

test('GET /public/status is thin, resolved for rendering, and leaks nothing', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  const body = await json(await fetch(`${h.base}/public/status`, { headers: REMOTE }));
  assert.deepEqual(Object.keys(body).sort(), ['ageSeconds', 'bgcolor', 'busy', 'color', 'label', 'stale', 'state', 'tableVersion']);
  assert.equal(body.state, 'on-air');
  assert.equal(body.label, 'ON AIR');
  assert.equal(body.bgcolor, '#c1121f');
  // No passphrase, no config, no hold, no source, no device detail.
  for (const forbidden of ['hold', 'source', 'confirmed', 'passphrase', 'auth', 'light']) {
    assert.equal(forbidden in body, false, forbidden);
  }
});

test('GET /public/events streams the same thin view, unauthenticated', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/public/events`, { headers: REMOTE });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value!);
  assert.match(first, /"label"/);
  assert.equal(/"hold"|"source"/.test(first), false);
  await reader.cancel();
});
