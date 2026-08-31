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
    bind: 'loopback', // #49: exclusive, so no other process can share this port
    driver: new StubDriver(),
    log: () => {},
  });
  t.after(() => app.close().catch(() => {}));
  return { app, configFile, base: `http://127.0.0.1:${app.port}` };
}

const json = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

/**
 * A STATUS ASSERTION THAT NAMES THE STRAY RESPONSE (#49).
 *
 * This file has now produced three of that ticket's witnesses, on three different tests, and
 * only ONE of them was instrumented - so the other two were recorded as "it went red once" and
 * taught us nothing. The most recent, a `200` that came back as something else during a
 * 20-run soak, is the whole argument for making this the default here rather than a thing
 * remembered at the two sites where it already paid off.
 *
 * `assert.equal(res.status, 200)` prints `403 !== 200`. That is exactly the information that
 * does NOT help: the interesting question is never "what did I want" but "whose answer is
 * this", and the route, the content type and the body all say so. The body is read from a
 * CLONE and only on the failing path, so a caller that goes on to parse the real body is
 * unaffected.
 */
async function expectStatus(res: Response, want: number, note?: string): Promise<void> {
  if (res.status === want) return;
  let body = '(unreadable)';
  try {
    body = (await res.clone().text()).slice(0, 400);
  } catch {
    /* already consumed - the status and headers below are still the useful part */
  }
  assert.fail(
    `wanted ${want}, got ${res.status} from ${res.url}${note === undefined ? '' : ` (${note})`}\n` +
      `  content-type: ${res.headers.get('content-type')}\n` +
      `  body: ${body}\n` +
      `  #49: if this status is one the requested route CANNOT produce, this is somebody ` +
      `else's response and the body above names whose.`,
  );
}

const bearer = (v: string) => ({ ...REMOTE, authorization: `Bearer ${v}` });

// ------------------------------------------------ the passphrase gates data

test('a data route demands the passphrase from a non-local client', async (t) => {
  const h = await boot(t);
  await expectStatus(await fetch(`${h.base}/status`, { headers: REMOTE }), 401);
  await expectStatus(await fetch(`${h.base}/status`, { headers: bearer(DEFAULT_PASSPHRASE) }), 200);
  await expectStatus(await fetch(`${h.base}/status`, { headers: bearer('wrong') }), 401);
});

test('every data route is gated, and the two public ones are not', async (t) => {
  const h = await boot(t);
  for (const path of ['/status', '/config/states', '/events']) {
    await expectStatus(await fetch(`${h.base}${path}`, { headers: REMOTE }), 401, path);
  }
  for (const path of ['/public/status', '/display']) {
    const res = await fetch(`${h.base}${path}`, { headers: REMOTE });
    await expectStatus(res, 200, path);
    await res.text();
  }
});

test('?passphrase= works where a header cannot, and ?token= is still accepted', async (t) => {
  const h = await boot(t);
  const p = DEFAULT_PASSPHRASE;
  await expectStatus(await fetch(`${h.base}/status?passphrase=${p}`, { headers: REMOTE }), 200);
  await expectStatus(await fetch(`${h.base}/status?token=${p}`, { headers: REMOTE }), 200);
});

test('a query credential is refused on a WRITE - it would land in logs and history', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/state/on-air?passphrase=${DEFAULT_PASSPHRASE}`, {
    method: 'POST',
    headers: REMOTE,
  });
  await expectStatus(res, 401);
});

// --------------------------------------- NEITHER credential on the other's routes

test('the passphrase does NOT open an admin route', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/config`, { headers: bearer(DEFAULT_PASSPHRASE) });
  await expectStatus(res, 401);
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
  await expectStatus(await fetch(`${h.base}/admin/config`, { headers: bearer(token) }), 200);
  // Two different trust questions. "You may reconfigure the system" is not "you may write
  // state", and conflating them would make the split D-35 exists to create decorative.
  await expectStatus(await fetch(`${h.base}/status`, { headers: bearer(token) }), 401);
});

// ------------------------------------------------------------ admin sessions

test('the admin login takes user + password, and issues a bearer session - no cookie', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/session`, {
    method: 'POST',
    headers: REMOTE,
    body: JSON.stringify({ user: DEFAULT_ADMIN_USER, password: DEFAULT_ADMIN_PASSWORD }),
  });
  await expectStatus(res, 200);
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
  await expectStatus(res, 401);
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
  await expectStatus(await fetch(`${h.base}/admin/config`, { headers: bearer(token) }), 200);
  await fetch(`${h.base}/admin/session`, { method: 'DELETE', headers: bearer(token) });
  await expectStatus(await fetch(`${h.base}/admin/config`, { headers: bearer(token) }), 401);
});

// ------------------------------------------------------------- THE WAIVER

test('locally, both credentials are invisible - the waiver grants a full admin session', async (t) => {
  const h = await boot(t);
  // No credential at all, from loopback with our Host and no foreign Origin.
  await expectStatus(await fetch(`${h.base}/status`), 200);
  await expectStatus(await fetch(`${h.base}/admin/config`), 200);
  const res = await fetch(`${h.base}/admin/session`, { method: 'POST' });
  await expectStatus(res, 200);
  assert.equal((await json(res)).via, 'waiver', 'this is what pays for having no cookie');
});

test('D-24 ATTACK 1 over HTTP: a foreign Origin from loopback is refused', async (t) => {
  const h = await boot(t);
  // Measured: the server sees remote 127.0.0.1 with origin http://10.42.14.189:9099.
  const res = await fetch(`${h.base}/state/on-air`, { method: 'POST', headers: REMOTE });
  await expectStatus(res, 401);
  assert.equal((await json(await fetch(`${h.base}/status`))).state, UNKNOWN_ID, 'and it changed nothing');
});

test('D-24 ATTACK 2 over HTTP: another port on the same host is refused', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/admin/config`, {
    headers: { origin: 'http://127.0.0.1:9099', 'sec-fetch-site': 'same-site' },
  });
  // A port is not part of a "site", so rejecting only `cross-site` would have let this in.
  await expectStatus(res, 401);
});

// ---------------------------------------------------------------- rotation

test('rotating the passphrase keeps the previous one working, and persists the window', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  const res = await fetch(`${h.base}/admin/config`, {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, auth: { ...cfg.auth, passphrase: 'brand-new' } }),
  });
  await expectStatus(res, 200);
  await expectStatus(await fetch(`${h.base}/status`, { headers: bearer('brand-new') }), 200);
  // The walk around the house: the ESP32 and Companion are still hand-configured with the
  // old one and keep working while you go and update them.
  await expectStatus(await fetch(`${h.base}/status`, { headers: bearer(DEFAULT_PASSPHRASE) }), 200);
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
  await expectStatus(await fetch(`${h.base}/admin/config`, { headers: bearer(token) }), 401);
});

test('an empty credential in the config is a validation error, never bypassable auth', async (t) => {
  const h = await boot(t);
  const cfg = (await json(await fetch(`${h.base}/admin/config`))).config as OnAirConfig;
  for (const key of ['passphrase', 'adminUser', 'adminPassword'] as const) {
    const res = await fetch(`${h.base}/admin/config`, {
      method: 'PUT',
      body: JSON.stringify({ ...cfg, auth: { ...cfg.auth, [key]: '' } }),
    });
    await expectStatus(res, 400, key);
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
  await expectStatus(noBody, 403);
  const wrong = await fetch(`${h.base}/admin/factory-reset`, { method: 'POST', body: JSON.stringify({ password: 'x' }) });
  await expectStatus(wrong, 403);
});

test('factory reset restores the shipped defaults', async (t) => {
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
  await fetch(`${h.base}/state/interruptible`, { method: 'POST' });

  const res = await fetch(`${h.base}/admin/factory-reset`, {
    method: 'POST',
    body: JSON.stringify({ password: DEFAULT_ADMIN_PASSWORD }),
  });
  await expectStatus(res, 200);
  const after = (await json(res)).config as OnAirConfig;
  assert.equal(after.auth.passphrase, DEFAULT_PASSPHRASE, 'a FIXED default, not a random one (D-43)');
  assert.equal(after.auth.adminUser, DEFAULT_ADMIN_USER);
  assert.equal(after.auth.adminPassword, DEFAULT_ADMIN_PASSWORD);
  assert.equal(after.bind, 'all');
  assert.equal(after.port, 8484);
  assert.equal(after.states.some((r) => r.id === 'recording'), true, 'the seed table is back');

  const status = await json(await fetch(`${h.base}/status`));
  assert.equal(status.state, UNKNOWN_ID);
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
  await expectStatus(await fetch(`${h.base}/admin/config`, { headers: bearer(token) }), 401);
});

// -------------------------------------------------------- the public pair

test('GET /public/status is thin, resolved for rendering, and leaks nothing', async (t) => {
  const h = await boot(t);
  await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  const body = await json(await fetch(`${h.base}/public/status`, { headers: REMOTE }));
  assert.deepEqual(Object.keys(body).sort(), ['ageSeconds', 'bgcolor', 'busy', 'color', 'label', 'message', 'state', 'tableVersion']);
  assert.equal(body.state, 'on-air');
  assert.equal(body.label, 'ON AIR');
  assert.equal(body.bgcolor, '#c1121f');
  // No passphrase, no config, no source, no device detail.
  // `message` is present because /display needs it and cannot read the gated stream. It
  // discloses nothing the panel on the wall does not already show.
  // `hold` is NOT in this list, deliberately: it exists nowhere since D-126, and guarding
  // a name the system no longer has is the decoy-beside-the-real-thing pattern D-83 rejects.
  for (const forbidden of ['source', 'confirmed', 'passphrase', 'auth', 'light']) {
    assert.equal(forbidden in body, false, forbidden);
  }
});

test('GET /public/events streams the same thin view, unauthenticated', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/public/events`, { headers: REMOTE });
  await expectStatus(res, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value!);
  assert.match(first, /"label"/);
  assert.equal(/"source"/.test(first), false);
  await reader.cancel();
});

/**
 * Read SSE `status` events off a live stream until `want` of them have arrived.
 *
 * The existing coverage read only the FIRST event, which is the per-connection snapshot and
 * was always correct. The bug (#88) was in the CHANGE event, which is why nothing caught it.
 */
async function statusEvents(res: Response, want: number, trigger: () => Promise<void>): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = decoder.decode((await reader.read()).value!); // the snapshot, before any change
  await trigger();
  const out = (): unknown[] =>
    buf
      .split('\n\n')
      .filter((b) => b.startsWith('event: status'))
      .map((b) => JSON.parse(b.slice(b.indexOf('data: ') + 6)) as unknown);
  const deadline = Date.now() + 5000;
  while (out().length < want && Date.now() < deadline) {
    buf += decoder.decode((await reader.read()).value!);
  }
  await reader.cancel();
  const events = out();
  assert.ok(events.length >= want, `wanted ${want} status events, got ${events.length}: ${buf}`);
  return events;
}

const PUBLIC_KEYS = ['ageSeconds', 'bgcolor', 'busy', 'color', 'label', 'message', 'state', 'tableVersion'];

test('the CHANGE event on /public/events is the thin view too, not the gated body (#88)', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/public/events`, { headers: REMOTE });
  const [, change] = await statusEvents(res, 2, async () => {
    await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  });
  const body = change as Record<string, unknown>;
  // Exactly the eight public keys. `deepEqual` on the sorted key list and not a forbidden
  // list: a forbidden list only catches the leaks somebody thought of, and this leak was
  // four fields nobody had thought of.
  assert.deepEqual(Object.keys(body).sort(), PUBLIC_KEYS, JSON.stringify(body));
  assert.equal(body.state, 'on-air');
  // The half that broke the wall panel rather than the half that leaked: without these the
  // renderer falls back to the raw state id in the reserved row's colours, and shows
  // "ON-AIR" in magenta on near-black until the next 15s heartbeat repaints it.
  assert.equal(body.label, 'ON AIR');
  assert.equal(body.bgcolor, '#c1121f');
});

test('the CHANGE event on /events keeps the gated shape (#88)', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/events?passphrase=${DEFAULT_PASSPHRASE}`, { headers: REMOTE });
  await expectStatus(res, 200);
  const [, change] = await statusEvents(res, 2, async () => {
    await fetch(`${h.base}/state/on-air`, { method: 'POST' });
  });
  const body = change as Record<string, unknown>;
  assert.equal(body.state, 'on-air');
  // The gated audience is the one entitled to provenance. Narrowing the public stream must
  // not have narrowed this one with it.
  for (const required of ['source', 'confirmed', 'updatedAt', 'busy', 'intended']) {
    assert.ok(required in body, `${required} missing: ${JSON.stringify(body)}`);
  }
  assert.equal(body.source, 'human:anonymous');
});

// ------------------------------------------------ the 401 a person sees (#48)

test('a browser gets a readable 401; everything else gets the JSON byte for byte', async (t) => {
  const h = await boot(t);

  // The JSON path is pinned FIRST and deliberately: this change adds a branch in front of
  // every 401 the service sends, and every existing client and test is on the other side
  // of it. A regression here is silent - a client parsing JSON would just start failing.
  const asClient = await fetch(`${h.base}/status`, { headers: REMOTE });
  const clientBody = await asClient.text();
  // SELF-DIAGNOSING, because this assertion caught something once and could not be made to
  // do it again: a `403` on `/status`, which no handler in this service can produce. That
  // is a response belonging to a DIFFERENT request, so if it recurs the useful evidence is
  // which one - the body names the route it came from. See the note in `boot`.
  const why = `${asClient.status} ${asClient.headers.get('content-type')} from ${h.base}/status: ${clientBody}`;
  await expectStatus(asClient, 401, why);
  assert.equal(asClient.headers.get('content-type'), 'application/json', why);
  assert.equal(clientBody, '{"error":"missing or invalid passphrase"}\n', why);

  const asBrowser = await fetch(`${h.base}/status`, {
    headers: { ...REMOTE, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  await expectStatus(asBrowser, 401, 'still a 401 - the medium changed, not the answer');
  assert.match(asBrowser.headers.get('content-type') ?? '', /^text\/html/);
  const page = await asBrowser.text();
  assert.match(page, /<!doctype html>/i);
  assert.match(page, /401/);
  // The thing the JSON could not say: where to go.
  assert.match(page, /href="\/"/);
  assert.match(page, /href="\/display"/);
});

test('the readable 401 says no more than the JSON does', async (t) => {
  const h = await boot(t);
  const html = { ...REMOTE, accept: 'text/html' };

  // D-35's two audiences must stay indistinguishable to an unauthenticated caller. A page
  // that helpfully said "you sent a passphrase but this needs an admin session" would be a
  // credential oracle, which is exactly what the JSON is careful not to be.
  const data = await (await fetch(`${h.base}/status`, { headers: html })).text();
  const admin = await (await fetch(`${h.base}/admin/config`, { headers: html })).text();

  for (const page of [data, admin]) {
    assert.doesNotMatch(page, new RegExp(DEFAULT_PASSPHRASE), 'never echoes a credential');
    assert.doesNotMatch(page, new RegExp(DEFAULT_ADMIN_PASSWORD), 'never echoes a credential');
  }
  // The only difference between them is the error string the JSON already returns.
  assert.equal(
    data.replace('missing or invalid passphrase', 'X'),
    admin.replace('missing or invalid admin session', 'X'),
    'the two pages differ only where the JSON already differs',
  );
});

test('a presented-but-wrong credential gets the readable 401 too', async (t) => {
  const h = await boot(t);
  const res = await fetch(`${h.base}/status`, {
    headers: { ...bearer('wrong'), accept: 'text/html' },
  });
  await expectStatus(res, 401);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
});
