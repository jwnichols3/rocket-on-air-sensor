import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/app.js';
import { defaultConfig, projectLight, type DeviceRow, type OnAirConfig } from '../src/config-store.js';
import { FanOutDriver } from '../src/fanout-driver.js';
import type { LightDriver } from '../src/driver.js';
import { freePort } from './free-port.js';
import { waitFor } from './wait-for.js';

const inert = (): LightDriver => ({ set: async (id) => id, read: async () => 'unknown' });
async function boot(t: TestContext, options: Partial<AppOptions> = {}, initial?: OnAirConfig) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-transaction-'));
  const configFile = join(dir, 'config.json');
  if (initial) await writeFile(configFile, JSON.stringify(initial));
  const app = await createApp({ stateFile: join(dir, 'state.json'), configFile, port: 0,
    bind: 'loopback', driver: inert(), log: () => {}, supervise: { pollMs: 3600000 }, ...options });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${app.port}`;
  const save = async (config: OnAirConfig) => {
    const res = await fetch(`${base()}/admin/config`, { method: 'PUT', body: JSON.stringify(config) });
    return { status: res.status, body: await res.json() as { error?: string; config: OnAirConfig } };
  };
  return { app, dir, configFile, base, save };
}

test('concurrent config saves have one winner and disk, memory, and restart agree', async (t) => {
  const h = await boot(t);
  const original = h.app.config();
  const edit = (label: string) => ({ ...original, states: original.states.map((r) => r.id === 'available' ? { ...r, label } : r) });
  const replies = await Promise.all([h.save(edit('Editor A')), h.save(edit('Editor B'))]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  assert.match(replies.find((r) => r.status === 409)!.body.error!, /changed underneath/);
  const winner = replies.find((r) => r.status === 200)!.body.config;
  const disk = JSON.parse(await readFile(h.configFile, 'utf8')) as OnAirConfig;
  assert.deepEqual(h.app.config(), winner);
  assert.deepEqual(disk, winner);
  const restarted = await createApp({ configFile: h.configFile, stateFile: join(h.dir, 'restart.json'), port: 0,
    bind: 'loopback', driver: inert(), log: () => {}, supervise: { pollMs: 3600000 } });
  try { assert.deepEqual(restarted.config(), winner); } finally { await restarted.close(); }
});

test('a failed rebind changes neither driver, table, nor admin session', async (t) => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const address = blocker.address();
  assert(address && typeof address === 'object');
  const row = { id: 'primary', label: 'Primary', host: '127.0.0.1:1', entity: 'PresenceKey', username: null,
    password: null, enabled: true, primary: true, order: 0 };
  const initial = { ...defaultConfig(), port, bind: 'loopback' as const, devices: [row],
    light: { host: row.host, entity: row.entity, username: null, password: null } };
  const nudges: number[] = [];
  const driver = new FanOutDriver({ specs: [row], make: () => ({ ...inert(), setTableVersion: async (v) => { nudges.push(v); } }), log: () => {} });
  const h = await boot(t, { port: undefined, driver }, initial);
  await fetch(`${h.base()}/state/recording`, { method: 'POST' });
  const session = h.app.sessions.create();
  const next = { ...initial, port: address.port, devices: [{ ...row, host: '127.0.0.1:2' }],
    light: { ...initial.light, host: '127.0.0.1:2' }, states: initial.states.filter((r) => r.id !== 'recording'),
    auth: { ...initial.auth, adminPassword: 'replacement' } };
  const reply = await h.save(next);
  assert.equal(reply.status, 409);
  assert.equal(driver.host, row.host, 'rejected target must never become active');
  assert.equal(h.app.store.get().state, 'recording', 'a rejected table must not resolve away the live state');
  assert(h.app.sessions.validate(session.token), 'failed save must not invalidate current sessions');
  assert.deepEqual(nudges, [], 'rejected table version must not be sent to devices');
  assert.deepEqual(h.app.config(), initial);
  assert.deepEqual(JSON.parse(await readFile(h.configFile, 'utf8')), initial);
});

test('environment passphrase survives save, reset, and restart without entering persisted config', async (t) => {
  const override = 'environment-only-secret';
  const h = await boot(t, { token: override });
  const status = async (secret: string) => {
    const res = await fetch(`${h.base()}/status`, { headers: { origin: 'http://other.invalid', authorization: `Bearer ${secret}` } });
    await res.text(); return res.status;
  };
  assert.equal(await status(override), 200);
  assert.equal(h.app.config().auth.passphrase, 'onair', 'document must remain the document');
  const configResponse = await fetch(`${h.base()}/admin/config`);
  const body = await configResponse.json() as { env: { overrides: unknown[] } };
  assert(body.env.overrides.some((o) => JSON.stringify(o) === JSON.stringify({ key: 'auth.passphrase', variable: 'ONAIR_TOKEN' })));
  const current = h.app.config();
  assert.equal((await h.save({ ...current, auth: { ...current.auth, passphrase: 'document-secret' } })).status, 200);
  assert.equal(await status(override), 200);
  assert.equal(await status('document-secret'), 401, 'document credential must not bypass an override');
  const reset = await fetch(`${h.base()}/admin/factory-reset`, { method: 'POST', body: JSON.stringify({ password: current.auth.adminPassword }) });
  assert.equal(reset.status, 200); await reset.text();
  assert.equal(await status(override), 200);
  assert.equal(await status('onair'), 401);
  assert(!(await readFile(h.configFile, 'utf8')).includes(override));
  const restarted = await createApp({ configFile: h.configFile, stateFile: join(h.dir, 'restart.json'), port: 0,
    bind: 'loopback', token: override, driver: inert(), log: () => {}, supervise: { pollMs: 3600000 } });
  try {
    const r = await fetch(`http://127.0.0.1:${restarted.port}/status`, { headers: { origin: 'http://other.invalid', authorization: `Bearer ${override}` } });
    assert.equal(r.status, 200); await r.text();
  } finally { await restarted.close(); }
});

test('health separates primary readiness from service availability and ignores secondary failure', async (t) => {
  const primary = { id: 'primary', label: 'Primary', host: '127.0.0.1:1', entity: 'PresenceKey', username: null,
    password: null, enabled: true, primary: true, order: 0 };
  const secondary = { ...primary, id: 'secondary', primary: false };
  const driver = new FanOutDriver({ specs: [primary, secondary], make: inert, log: () => {} });
  const config = { ...defaultConfig(), devices: [primary, secondary], light: {
    host: primary.host, entity: primary.entity, username: null, password: null } };
  const h = await boot(t, { driver }, config);
  const on = await fetch(`${h.base()}/state/available`, { method: 'POST' });
  await on.text();
  driver.markUnreachable('secondary', 'intentionally absent');
  const health = async () => {
    const res = await fetch(`${h.base()}/admin/health`);
    assert.equal(res.status, 200);
    return await res.json() as { primary: { id: string; ready: boolean; status: string }; build: Record<string, unknown> };
  };
  assert.deepEqual((await health()).primary, { id: 'primary', ready: true, status: 'ready' });
  h.app.store.setConfirmed('unknown', 'asleep');
  assert.deepEqual((await health()).primary, { id: 'primary', ready: true, status: 'asleep' });
  h.app.store.setConfirmed('unknown', 'unreachable');
  assert.deepEqual((await health()).primary, { id: 'primary', ready: false, status: 'unreachable' });
  assert.deepEqual(Object.keys((await health()).build).sort(), ['builtAt', 'commit', 'dirty', 'version']);
});

test('a queued state write is validated against the table that actually executes it', async (t) => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const driver: LightDriver = { read: async () => 'unknown', set: async (id) => {
    if (id === 'available') { enter(); await gate; }
    return id;
  } };
  const h = await boot(t, { driver });
  const first = fetch(`${h.base()}/state/available`, { method: 'POST' });
  await entered;
  const initial = h.app.config();
  const config = h.save({ ...initial, states: initial.states.filter((r) => r.id !== 'recording') });
  const waitDepth = async (depth: number) => {
    const deadline = Date.now() + 2000;
    while (h.app.writeQueueDepth() < depth && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    assert.equal(h.app.writeQueueDepth(), depth);
  };
  try {
    await waitDepth(2);
    const state = fetch(`${h.base()}/state/recording`, { method: 'POST' });
    await waitDepth(3);
    release();
    await (await first).text();
    assert.equal((await config).status, 200);
    const rejected = await state;
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json() as { error: string }).error, /unknown state/);
    assert.equal(h.app.store.get().state, 'available');
  } finally { release(); }
});

test('a successful rebind can finish a slow version nudge before its response socket is retired', async (t) => {
  const initial = { ...defaultConfig(), port: await freePort(), bind: 'loopback' as const };
  const h = await boot(t, { port: undefined, driver: { ...inert(),
    setTableVersion: async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); },
  } }, initial);
  const nextPort = await freePort();
  const saved = await h.save({ ...initial, port: nextPort });
  assert.equal(saved.status, 200);
  assert.equal(h.app.port, nextPort);
});

test('replacing the primary discards the previous panel confirmation until the replacement answers', async (t) => {
  const row = { id: 'primary', label: 'Primary', host: '127.0.0.1:1', entity: 'PresenceKey', username: null,
    password: null, enabled: true, primary: true, order: 0 };
  const driver = new FanOutDriver({ specs: [row], make: inert, log: () => {} });
  const initial = { ...defaultConfig(), devices: [row], light: {
    host: row.host, entity: row.entity, username: null, password: null } };
  const h = await boot(t, { driver }, initial);
  const on = await fetch(`${h.base()}/state/available`, { method: 'POST' });
  assert.equal(on.status, 200); await on.text();
  assert.equal(h.app.store.get().confirmed, 'available');
  const newHost = '127.0.0.1:2';
  assert.equal((await h.save({ ...h.app.config(), devices: [{ ...row, host: newHost }],
    light: { ...initial.light, host: newHost } })).status, 200);
  assert.equal(h.app.store.get().confirmed, 'unknown');
  assert.equal(h.app.store.get().confirmedReason, undefined);
  const health = await fetch(`${h.base()}/admin/health`);
  const result = await health.json() as { primary: { ready: boolean; status: string } };
  assert.deepEqual(result.primary, { id: 'primary', ready: false, status: 'unconfirmed' });
});

test('renaming the primary and changing only secondaries preserves primary evidence', async (t) => {
  const row = { id: 'primary', label: 'Primary', host: '127.0.0.1:1', entity: 'PresenceKey', username: null,
    password: null, enabled: true, primary: true, order: 0 };
  const driver = new FanOutDriver({ specs: [row], make: inert, log: () => {} });
  const initial = { ...defaultConfig(), devices: [row], light: {
    host: row.host, entity: row.entity, username: null, password: null } };
  const h = await boot(t, { driver }, initial);
  const on = await fetch(`${h.base()}/state/available`, { method: 'POST' }); await on.text();
  const primaryDriver = driver.primaryDriver();
  const updated = { ...row, label: 'Renamed primary' };
  const secondary = { ...row, id: 'secondary', primary: false, host: '127.0.0.1:2' };
  assert.equal((await h.save({ ...h.app.config(), devices: [updated, secondary] })).status, 200);
  assert.equal(driver.primaryDriver(), primaryDriver);
  assert.equal(h.app.store.get().confirmed, 'available');
});


test('a replacement primary inherits neither the old glass verdict nor its heartbeat timer', async (t) => {
  const row = { id: 'primary', label: 'Primary', host: '127.0.0.1:1', entity: 'PresenceKey', username: null,
    password: null, enabled: true, primary: true, order: 0 };
  const newSets: string[] = [];
  const driver = new FanOutDriver({ specs: [row], make: (spec) => {
    let state = 'available';
    const replacement = spec.host === '127.0.0.1:2';
    return {
      set: async (id) => { state = id; if (replacement) newSets.push(id); return state; },
      read: async () => state,
      repainted: async () => true,
      glassDark: async () => replacement ? null : true,
    };
  }, log: () => {} });
  const initial = { ...defaultConfig(), devices: [row], light: {
    host: row.host, entity: row.entity, username: null, password: null } };
  const h = await boot(t, { driver, supervise: { pollMs: 3, reassertMs: 1e9, decayMs: 1e9 } }, initial);
  const on = await fetch(`${h.base()}/state/available`, { method: 'POST' }); await on.text();
  await waitFor(() => h.app.store.get().confirmedReason === 'asleep', 'old primary should establish darkness');
  const newHost = '127.0.0.1:2';
  assert.equal((await h.save({ ...h.app.config(), devices: [{ ...row, host: newHost }],
    light: { ...initial.light, host: newHost } })).status, 200);
  await waitFor(() => h.app.store.get().confirmed === 'available', 'new primary must not inherit old darkness');
  assert.equal(h.app.store.get().confirmedReason, undefined);
  assert(newSets.includes('available'), 'new primary must be asserted without waiting for the old heartbeat timer');
});

test('a replacement that cannot answer receives no confirmation grace period from the old primary', async (t) => {
  const row = { id: 'primary', label: 'Primary', host: '127.0.0.1:1', entity: 'PresenceKey', username: null,
    password: null, enabled: true, primary: true, order: 0 };
  const driver = new FanOutDriver({ specs: [row], make: (spec) => {
    let state = 'available';
    const replacement = spec.host === '127.0.0.1:2';
    return {
      set: async (id) => { state = id; return replacement ? 'unknown' : state; },
      read: async () => replacement ? 'unknown' : state,
      repainted: async () => true,
      glassDark: async () => false,
    };
  }, log: () => {} });
  const initial = { ...defaultConfig(), devices: [row], light: {
    host: row.host, entity: row.entity, username: null, password: null } };
  const h = await boot(t, { driver, supervise: { pollMs: 3, reassertMs: 1e9, decayMs: 1e9 } }, initial);
  const on = await fetch(`${h.base()}/state/available`, { method: 'POST' }); await on.text();
  await waitFor(() => h.app.store.get().confirmed === 'available', 'old primary should confirm');
  const newHost = '127.0.0.1:2';
  assert.equal((await h.save({ ...h.app.config(), devices: [{ ...row, host: newHost }],
    light: { ...initial.light, host: newHost } })).status, 200);
  await waitFor(() => h.app.store.get().confirmedReason === 'unreachable', 'replacement must not inherit old confirmation grace');
  assert.equal(h.app.store.get().confirmed, 'unknown');
});


test('primary identity, entity, credential changes and removal each discard confirmation', async (t) => {
  const original: DeviceRow = { id: 'primary', label: 'Primary', host: '127.0.0.1:1', entity: 'PresenceKey', username: null,
    password: null, enabled: true, primary: true, order: 0 };
  const variants: Array<[string, DeviceRow[]]> = [
    ['identity', [{ ...original, id: 'replacement' }]],
    ['entity', [{ ...original, entity: 'OtherKey' }]],
    ['username', [{ ...original, username: 'new-user' }]],
    ['password', [{ ...original, password: 'new-password' }]],
    ['removal', []],
  ];
  for (const [name, devices] of variants) {
    await t.test(name, async (t) => {
      const driver = new FanOutDriver({ specs: [{ ...original, host: original.host! }], make: inert, log: () => {} });
      const h = await boot(t, { driver }, { ...defaultConfig(), devices: [original], light: projectLight([original]) });
      const on = await fetch(`${h.base()}/state/available`, { method: 'POST' }); await on.text();
      h.app.store.setConfirmed('unknown', 'asleep');
      assert.equal((await h.save({ ...h.app.config(), devices, light: projectLight(devices) })).status, 200);
      assert.equal(h.app.store.get().confirmed, 'unknown');
      assert.equal(h.app.store.get().confirmedReason, undefined);
    });
  }
});
