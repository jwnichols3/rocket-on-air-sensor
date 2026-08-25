import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import { defaultConfig, type OnAirConfig } from '../src/config-store.js';
import { SEED_ROWS, UNKNOWN_ID } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: string[] = [];
  async set(id: string): Promise<string> {
    this.calls.push(id);
    return id;
  }
  async read(): Promise<string> {
    return this.calls.at(-1) ?? UNKNOWN_ID;
  }
}

async function boot(t: TestContext, over: Partial<AppOptions> = {}, configOnDisk?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-cfgroute-'));
  const configFile = join(dir, 'config.json');
  if (configOnDisk !== undefined) {
    await writeFile(configFile, typeof configOnDisk === 'string' ? configOnDisk : JSON.stringify(configOnDisk), 'utf8');
  }
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile,
    port: 0,
    driver: new StubDriver(),
    log: () => {},
    ...over,
  });
  t.after(() => app.close().catch(() => {}));
  return { app, configFile, base: `http://127.0.0.1:${app.port}` };
}

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

/**
 * A port that is free right now. The rebind tests need a REAL port in the document rather
 * than the `port: 0` seam, because rebinding is the behaviour under test and rolling back
 * to 0 would land on a different port every time.
 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:http');
  const s = createServer(() => {});
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// ------------------------------------------------------- GET /config/states

test('GET /config/states returns the versioned table', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/config/states`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { version: number; states: Array<{ id: string }>; updatedAt: string };
  assert.equal(body.version, 1);
  assert.deepEqual(body.states.map((r) => r.id), SEED_ROWS.map((r) => r.id));
  // Self-describing: a client asks what states exist rather than being compiled with them.
  assert.equal(Object.keys(body.states[0]!).sort().join(','), 'bgcolor,busy,color,description,id,label,order');
  assert.equal(typeof body.updatedAt, 'string');
});

test('GET /config/states honours If-None-Match with a 304', async (t) => {
  const h = await boot(t);
  const first = await fetch(`${h.base}/config/states`);
  const etag = first.headers.get('etag');
  assert.equal(etag, '"1"');
  await first.text();
  // The ESP32 polls this every 300s. This is the difference between a poll that costs a
  // header and one that costs the whole table.
  const second = await fetch(`${h.base}/config/states`, { headers: { 'if-none-match': etag! } });
  assert.equal(second.status, 304);
  assert.equal(second.headers.get('etag'), etag);
});

test('the ETag moves when the table does, so a 304 can never go stale', async (t) => {
  const h = await boot(t);
  const cfg = defaultConfig();
  const next = { ...cfg, states: cfg.states.map((r) => (r.id === 'on-air' ? { ...r, label: 'LIVE' } : r)) };
  const put = await fetch(`${h.base}/admin/config`, { method: 'PUT', body: JSON.stringify(next) });
  assert.equal(put.status, 200);
  const res = await fetch(`${h.base}/config/states`, { headers: { 'if-none-match': '"1"' } });
  assert.equal(res.status, 200, 'a client holding v1 must be told the table moved');
  assert.equal(res.headers.get('etag'), '"2"');
  const body = (await res.json()) as { states: Array<{ id: string; label: string }> };
  assert.equal(body.states.find((r) => r.id === 'on-air')!.label, 'LIVE');
});

// ------------------------------------------------------- PUT /admin/config

test('a save persists to disk at the next version, and the table goes live at once', async (t) => {
  const h = await boot(t);
  const cfg = defaultConfig();
  const next = {
    ...cfg,
    states: [...cfg.states, { id: 'lunch', label: 'AT LUNCH', color: '#ffffff', bgcolor: '#333333', description: '', busy: false, order: 5 }],
  };
  const res = await fetch(`${h.base}/admin/config`, { method: 'PUT', body: JSON.stringify(next) });
  assert.equal(res.status, 200);
  assert.equal(((await json(res)).config as OnAirConfig).version, 2);

  const onDisk = JSON.parse(await readFile(h.configFile, 'utf8')) as OnAirConfig;
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.states.some((r) => r.id === 'lunch'), true);

  // Live immediately - no restart, and no second write path (D-36).
  const state = await fetch(`${h.base}/state/lunch`, { method: 'POST' });
  assert.equal(state.status, 200);
  assert.equal((await json(state)).state, 'lunch');
});

test('the save is optimistic on version: a stale base is 409 with the current document', async (t) => {
  const h = await boot(t);
  const cfg = defaultConfig();
  await fetch(`${h.base}/admin/config`, { method: 'PUT', body: JSON.stringify(cfg) }); // -> v2
  // A second tab still holding v1 tries to save.
  const res = await fetch(`${h.base}/admin/config`, { method: 'PUT', body: JSON.stringify(cfg) });
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.match(String(body.error), /changed underneath you/);
  assert.equal((body.config as OnAirConfig).version, 2, 'so the UI can show what changed underneath');
});

test('an invalid document is 400 listing every problem, and changes nothing', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...defaultConfig(), port: -5, bind: 'wat' }),
  });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal((body.problems as string[]).length, 2);
  assert.equal((await json(await fetch(`${h.base}/admin/config`))).config !== undefined, true);
  assert.equal(((await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig).version, 1);
});

test('the admin UI gets no privileged route - GET /admin/config is the same document', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/config`);
  const body = await json(res);
  // Status and whole body first. This assertion failed exactly once in a full run on
  // 2026-08-25 and has not reproduced in fifteen since; reading `.port` off an undefined
  // `config` reported it as "Cannot read properties of undefined", which says nothing
  // about WHICH wrong answer came back. The three candidates - 501 (no config store
  // wired), 401 (the D-24 waiver refused) and the repair payload - are told apart by
  // exactly this line. Left in deliberately: an unreproduced flake is not a fixed one.
  assert.equal(res.status, 200, `expected the config document, got ${res.status}: ${JSON.stringify(body)}`);
  assert.notEqual(body.config, undefined, `no config in the body: ${JSON.stringify(body)}`);
  assert.equal((body.config as OnAirConfig).port, 8484);
  assert.equal(body.problem, undefined);
});

test('deleting the live row through a save resolves state to unknown, and says where from', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/recording`, { method: 'POST' });
  const cfg = defaultConfig();
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, states: cfg.states.filter((r) => r.id !== 'recording') }),
  });
  const s = await json(await fetch(`${h.base}/status`));
  assert.equal(s.state, UNKNOWN_ID);
  assert.equal(s.stateResolvedFrom, 'recording');
  assert.equal(s.busy, true, 'conspicuous, never calm');
});

// ------------------------------------------- a broken config never fails closed

test('AN UNPARSEABLE CONFIG STILL STARTS THE SERVICE, on loopback, with the problem visible', async (t) => {
  const h = await boot(t, {}, '{ not json at all');
  // The service is up. Launchd restarting forever with every reporting surface down is the
  // failure this is aimed at, on a machine nobody is sitting in front of.
  assert.equal((await fetch(`${h.base}/status`)).status, 200);
  const body = await json(await fetch(`${h.base}/admin/config`));
  const problem = body.problem as { errors: string[]; raw: string };
  assert.match(problem.errors[0]!, /unparseable JSON/);
  assert.equal(problem.raw, '{ not json at all', 'the raw text is served, so it can be repaired');
});

test('a repair view is served, and it shows the error and the raw text', async (t) => {
  const h = await boot(t, {}, '{ not json at all');
  const res = await fetch(`${h.base}/admin/repair`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /unparseable JSON/);
  assert.match(html, /not json at all/);
});

test('saving from the repair view is the repair: the problem clears', async (t) => {
  const h = await boot(t, {}, '{ not json at all');
  const res = await fetch(`${h.base}/admin/config`, { method: 'PUT', body: JSON.stringify(defaultConfig()) });
  assert.equal(res.status, 200);
  assert.equal((await json(await fetch(`${h.base}/admin/config`))).problem, undefined);
});

test('with a healthy config there is no repair view to serve', async (t) => {
  const h = await boot(t);
  assert.equal((await fetch(`${h.base}/admin/repair`)).status, 404);
});

// -------------------------------------------------------- rebind in place

test('a port change rebinds in place - the process never exits', async (t) => {
  const start = await freePort();
  const next = await freePort();
  const h = await boot(t, { port: undefined }, { ...defaultConfig(), port: start });
  assert.equal(h.app.port, start);
  const pidBefore = process.pid;

  const res = await fetch(`http://127.0.0.1:${start}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...defaultConfig(), port: next }),
  });
  assert.equal(res.status, 200);
  assert.equal(process.pid, pidBefore, 'never an exit - KeepAlive would make that a crash-loop');
  assert.equal(h.app.port, next);
  assert.equal((await fetch(`http://127.0.0.1:${next}/status`)).status, 200);
});

test('A REBIND THAT FAILS ROLLS BACK, KEEPS RUNNING, AND RETURNS 409', async (t) => {
  const start = await freePort();
  const h = await boot(t, { port: undefined }, { ...defaultConfig(), port: start });

  // Occupy a port on the wildcard, then ask the service to move onto it.
  const { createServer } = await import('node:http');
  const blocker = createServer(() => {});
  await new Promise<void>((r) => blocker.listen(0, r));
  const taken = (blocker.address() as { port: number }).port;
  t.after(() => new Promise<void>((r) => blocker.close(() => r())));

  const res = await fetch(`http://127.0.0.1:${start}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...defaultConfig(), port: taken }),
  });
  assert.equal(res.status, 409);
  assert.match(String((await json(res)).error), /rolled back/);

  // Still serving on the ORIGINAL port. "Restart and hope" is not safe to invoke from
  // across the house, and a process exit on a bad address is a KeepAlive crash-loop.
  assert.equal(h.app.port, start);
  assert.equal((await fetch(`http://127.0.0.1:${start}/status`)).status, 200);
  // And the rolled-back config is what is live AND what is on disk.
  assert.equal(h.app.config().port, start);
  assert.equal((JSON.parse(await readFile(h.configFile, 'utf8')) as OnAirConfig).port, start);
});

test('a missing interface binds loopback, keeps serving, and warns', async (t) => {
  const start = await freePort();
  const lines: string[] = [];
  const h = await boot(t, { port: undefined, log: (l) => lines.push(l) }, { ...defaultConfig(), port: start });
  const res = await fetch(`http://127.0.0.1:${start}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...defaultConfig(), port: start, bind: 'iface:definitely-not-real' }),
  });
  assert.equal(res.status, 200);
  // Loopback is always bound and is never a user choice - it is what the admin surface is
  // reached on, and a bind mode that turned it off would lock the door from the inside.
  assert.equal((await fetch(`http://127.0.0.1:${start}/status`)).status, 200);
  assert.ok(lines.some((l) => /not found/.test(l)), `expected a warning, got ${JSON.stringify(lines)}`);
});

test('first boot WRITES the document, so there is a file to hand-edit over SSH', async (t) => {
  const h = await boot(t);
  const onDisk = JSON.parse(await readFile(h.configFile, 'utf8')) as OnAirConfig;
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.states.length, SEED_ROWS.length);
  // A config file that does not exist until you use a UI is not "hand-editable, on a Pi,
  // over SSH, with no UI" - there has to be a file to edit.
});

test('seedConfig lifts config.env values into the document on the first boot only', async (t) => {
  const h = await boot(t, { seedConfig: (base) => ({ ...base, light: { ...base.light, host: '10.0.0.9' } }) });
  assert.equal((JSON.parse(await readFile(h.configFile, 'utf8')) as OnAirConfig).light.host, '10.0.0.9');
});

test('A FILE THAT FAILED TO LOAD IS NEVER OVERWRITTEN', async (t) => {
  const broken = '{ not json at all';
  const h = await boot(t, {}, broken);
  // Clobbering it would destroy the very thing the owner needs to read in the repair view.
  assert.equal(await readFile(h.configFile, 'utf8'), broken);
});

// ------------------------------------------------- D-42's version nudge, end to end

class NudgeDriver implements LightDriver {
  calls: string[] = [];
  versions: number[] = [];
  async set(id: string): Promise<string> {
    this.calls.push(id);
    return id;
  }
  async read(): Promise<string> {
    return this.calls.at(-1) ?? UNKNOWN_ID;
  }
  async setTableVersion(version: number): Promise<void> {
    this.versions.push(version);
  }
}

test('a state write nudges the device with the current table version', async (t) => {
  const driver = new NudgeDriver();
  const h = await boot(t, { driver });
  driver.versions.length = 0; // boot re-apply already wrote one
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  assert.deepEqual(driver.versions, [1], 'the nudge rides along with the state write');
});

test('a table edit nudges immediately, without waiting for the next state write', async (t) => {
  const driver = new NudgeDriver();
  const h = await boot(t, { driver });
  const before = driver.calls.length;
  driver.versions.length = 0;

  const cfg = defaultConfig();
  await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    // A pure PRESENTATION edit: same rows, same ids, one different colour. Nothing about
    // the state changes, so nothing would otherwise reach the device for up to 300s.
    body: JSON.stringify({
      ...cfg,
      states: cfg.states.map((r) => (r.id === 'on-air' ? { ...r, bgcolor: '#00ff00' } : r)),
    }),
  });

  assert.deepEqual(driver.versions, [2], 'the save nudges at the version it just wrote');
  assert.equal(driver.calls.length, before, 'and it is not a state write');
});

test('a driver that cannot be nudged does not break a save or a write', async (t) => {
  // StubDriver has no setTableVersion at all. The optional call must be exactly that.
  const driver = new StubDriver();
  const h = await boot(t, { driver });
  const cfg = defaultConfig();
  // Deliberately NOT a bind change: that rebinds, and with `port: 0` the service comes
  // back on a different ephemeral port, which fails this test for a reason that has
  // nothing to do with the nudge.
  const put = await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, states: cfg.states.map((r) => ({ ...r, description: 'edited' })) }),
  });
  assert.equal(put.status, 200);
  const write = await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  assert.equal(write.status, 200);
});

test('a nudge that throws is logged and does not fail the write', async (t) => {
  class ThrowingNudge extends NudgeDriver {
    override async setTableVersion(): Promise<void> {
      throw new Error('device fell over');
    }
  }
  const lines: string[] = [];
  const h = await boot(t, { driver: new ThrowingNudge(), log: (l: string) => lines.push(l) });
  const res = await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  // The write ALREADY SUCCEEDED by the time the nudge runs. Reporting a failure here
  // would tell the caller to retry a write that landed.
  assert.equal(res.status, 200);
  assert.equal((await json(res)).state, 'on-air');
  assert.equal(lines.some((l) => l.includes('version nudge failed')), true, lines.join('\n'));
});
