// The environment outranks the config document, and the console has to say so (D-79, #53).
//
// The precedence itself is D-14's rule and is NOT under test here as something to change -
// it is the documented way to point a box at a different light over SSH. What is under test
// is that the resolution lives in ONE place and is reported honestly, because the bug was
// that server/src/index.ts held the only copy and the admin console could not see it.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { effectiveLight, envOverrides } from '../src/config.js';

const DOC = { host: '10.0.0.9', entity: 'PresenceKey', username: 'doc-user', password: 'doc-pass' };

test('with a clean environment nothing is reported as overridden', () => {
  assert.deepEqual(envOverrides({}), []);
  assert.deepEqual(effectiveLight(DOC, {}), DOC);
});

test('a set variable is named, and the effective value follows it', () => {
  const env = { ONAIR_LIGHT_HOST: '10.0.0.99' } as NodeJS.ProcessEnv;
  assert.deepEqual(envOverrides(env), [{ key: 'light.host', variable: 'ONAIR_LIGHT_HOST' }]);
  assert.equal(effectiveLight(DOC, env).host, '10.0.0.99', 'the overlay wins (D-14)');
  assert.equal(effectiveLight(DOC, env).entity, 'PresenceKey', 'and only for the key it names');
});

test('an EMPTY variable is someone clearing it, not a host called ""', () => {
  const env = { ONAIR_LIGHT_HOST: '' } as NodeJS.ProcessEnv;
  assert.deepEqual(envOverrides(env), [], 'an empty value is not an override');
  assert.equal(effectiveLight(DOC, env).host, '10.0.0.9', 'so the document still applies');
});

test('every device key can be overridden, and each names its own variable', () => {
  const env = {
    ONAIR_LIGHT_HOST: 'h', ONAIR_LIGHT_ENTITY: 'e',
    ONAIR_LIGHT_USER: 'u', ONAIR_LIGHT_PASS: 'p',
  } as NodeJS.ProcessEnv;
  assert.deepEqual(envOverrides(env).map((o) => o.key),
    ['light.host', 'light.entity', 'light.username', 'light.password']);
  assert.deepEqual(effectiveLight(DOC, env), { host: 'h', entity: 'e', username: 'u', password: 'p' });
});

async function boot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-env-'));
  const app = await createApp({
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config.json'),
    port: 0,
    bind: 'loopback', // #49: exclusive, so no other process can share this port
    log: () => {},
  });
  t.after(() => app.close().catch(() => {}));
  return `http://127.0.0.1:${app.port}`;
}

test('GET /admin/config reports the overrides BY NAME and never their values', async (t) => {
  const base = await boot(t);
  const before = { host: process.env.ONAIR_LIGHT_HOST, pass: process.env.ONAIR_LIGHT_PASS };
  process.env.ONAIR_LIGHT_HOST = '10.0.0.77';
  process.env.ONAIR_LIGHT_PASS = 'a-device-credential-that-must-not-travel';
  t.after(() => {
    if (before.host === undefined) delete process.env.ONAIR_LIGHT_HOST;
    else process.env.ONAIR_LIGHT_HOST = before.host;
    if (before.pass === undefined) delete process.env.ONAIR_LIGHT_PASS;
    else process.env.ONAIR_LIGHT_PASS = before.pass;
  });

  const res = await fetch(`${base}/admin/config`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as {
    env: { overrides: { key: string; variable: string }[]; effective: Record<string, unknown> };
  };

  assert.deepEqual(body.env.overrides.map((o) => o.key).sort(), ['light.host', 'light.password']);
  assert.equal(body.env.overrides.find((o) => o.key === 'light.host')?.variable, 'ONAIR_LIGHT_HOST');
  assert.equal(body.env.effective.host, '10.0.0.77', 'the EFFECTIVE host, so a link cannot point at the wrong box');

  // A credential is NAMED as overridden and never valued. `host` and `entity` are neither
  // secret nor useful to withhold - an empty box reads as "not configured", which is a
  // different claim from "set elsewhere".
  assert.deepEqual(Object.keys(body.env.effective).sort(), ['entity', 'host']);
  assert.equal('username' in body.env.effective, false, 'a device credential must not be valued');
  assert.equal('password' in body.env.effective, false, 'a device credential must not be valued');

  // THE ONE THING THIS ROUTE MUST NEVER DO. ONAIR_LIGHT_PASS is a device credential and a
  // list of names is useful to every caller while a list of values is useful to none.
  assert.equal(text.includes('a-device-credential-that-must-not-travel'), false,
    'an overridden secret leaked into the response');
});

test('the route is gated - the override list is not public either', async (t) => {
  const base = await boot(t);
  const remote = { origin: 'http://10.42.14.189:9099' };
  assert.equal((await fetch(`${base}/admin/config`, { headers: remote })).status, 401);
});
