import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import {
  changeMeNags,
  defaultAuth,
  isLoopbackAddress,
  passphraseAccepted,
  presentedCredential,
  ROTATION_GRACE_MS,
  rotate,
  SessionStore,
  waiverApplies,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USER,
  DEFAULT_PASSPHRASE,
} from '../src/auth.js';

/** A request with just enough shape for the waiver to judge it. */
function req(over: {
  remote?: string;
  host?: string;
  origin?: string;
  fetchSite?: string;
  authorization?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (over.host !== undefined) headers.host = over.host;
  if (over.origin !== undefined) headers.origin = over.origin;
  if (over.fetchSite !== undefined) headers['sec-fetch-site'] = over.fetchSite;
  if (over.authorization !== undefined) headers.authorization = over.authorization;
  return { headers, socket: { remoteAddress: over.remote ?? '127.0.0.1' } } as unknown as IncomingMessage;
}

// ------------------------------------------------------------- credentials

test('the shipped defaults are the ones the decisions name', () => {
  const a = defaultAuth();
  assert.equal(a.passphrase, 'onair', 'D-43: a fixed default, not a random one');
  assert.equal(a.adminUser, 'rocket');
  assert.equal(a.adminPassword, 'ESP32');
  // Deliberately NOT the same value: reusing the admin password as the passphrase would
  // collapse the two-credential separation D-35 exists to create.
  assert.notEqual(DEFAULT_PASSPHRASE, DEFAULT_ADMIN_PASSWORD);
  assert.equal(DEFAULT_ADMIN_USER, 'rocket');
});

test('a change-me nag fires while either credential is still shipped', () => {
  assert.deepEqual(changeMeNags(defaultAuth()), { passphrase: true, adminPassword: true });
  const changed = { ...defaultAuth(), passphrase: 'x', adminPassword: 'y' };
  assert.deepEqual(changeMeNags(changed), { passphrase: false, adminPassword: false });
});

test('rotation keeps the previous passphrase working for 60 minutes, then stops', () => {
  const t0 = 1_000_000;
  const rotated = rotate(defaultAuth(), { ...defaultAuth(), passphrase: 'new-one' }, t0);
  assert.equal(rotated.passphrase, 'new-one');
  assert.equal(rotated.previous, 'onair');

  assert.equal(passphraseAccepted(rotated, 'new-one', t0), true);
  assert.equal(passphraseAccepted(rotated, 'onair', t0), true, 'the walk-around-the-house window');
  assert.equal(passphraseAccepted(rotated, 'onair', t0 + ROTATION_GRACE_MS - 1), true);
  assert.equal(passphraseAccepted(rotated, 'onair', t0 + ROTATION_GRACE_MS), false, 'and then it stops');
  assert.equal(passphraseAccepted(rotated, 'nonsense', t0), false);
});

test('rotating to the same value is not a rotation', () => {
  const a = defaultAuth();
  assert.equal(rotate(a, { ...a }).previous, null, 'no grace window for a no-op');
});

test('a rotation must NOT discard other credential changes made in the same save', () => {
  // The first version of this took only the new passphrase and returned {...live, passphrase},
  // which silently threw away an admin password submitted alongside it: the save reported
  // success and persisted the old one. Anything that merges credentials merges all of them.
  const live = defaultAuth();
  const submitted = { ...live, passphrase: 'new-pass', adminPassword: 'new-admin', adminUser: 'someone' };
  const merged = rotate(live, submitted, 0);
  assert.equal(merged.passphrase, 'new-pass');
  assert.equal(merged.adminPassword, 'new-admin');
  assert.equal(merged.adminUser, 'someone');
  assert.equal(merged.previous, live.passphrase);

  // ...and the same when only the admin password changes, with no rotation at all.
  const adminOnly = rotate(live, { ...live, adminPassword: 'new-admin' }, 0);
  assert.equal(adminOnly.adminPassword, 'new-admin');
  assert.equal(adminOnly.previous, null, 'and no grace window, because nothing rotated');
});

test('an in-flight grace window survives a save that does not touch the passphrase', () => {
  const t0 = 1_000;
  const rotated = rotate(defaultAuth(), { ...defaultAuth(), passphrase: 'new-one' }, t0);
  // A client submitting a stale document must not be able to end someone else's grace
  // period as a side effect of saving something unrelated.
  const later = rotate(rotated, { ...rotated, previous: null, previousUntil: null }, t0 + 1);
  assert.equal(later.previous, 'onair');
  assert.equal(later.previousUntil, rotated.previousUntil);
});

test('the credential is read from the header, then ?passphrase=, then the deprecated ?token=', () => {
  const u = (q: string) => new URL(`http://x/status${q}`);
  assert.equal(presentedCredential(req({ authorization: 'Bearer abc' }), u('')), 'abc');
  assert.equal(presentedCredential(req(), u('?passphrase=p')), 'p');
  assert.equal(presentedCredential(req(), u('?token=t')), 't', 'nothing on the LAN breaks the day this lands');
  // A header beats a query param, so a correct client is never downgraded by a stale URL.
  assert.equal(presentedCredential(req({ authorization: 'Bearer abc' }), u('?token=t')), 'abc');
  assert.equal(presentedCredential(req(), u('')), null);
});

// ------------------------------------------------------- THE WAIVER (D-24)

const PORT = 8484;

test('the waiver applies to a genuine local request', () => {
  assert.equal(waiverApplies(req({ host: '127.0.0.1:8484' }), PORT), true);
  assert.equal(waiverApplies(req({ host: 'localhost:8484' }), PORT), true);
  assert.equal(waiverApplies(req({ remote: '::1', host: '[::1]:8484' }), PORT), true);
  assert.equal(waiverApplies(req({ host: 'localhost:8484', origin: 'http://localhost:8484' }), PORT), true);
  assert.equal(waiverApplies(req({ host: 'localhost:8484', fetchSite: 'same-origin' }), PORT), true);
  assert.equal(waiverApplies(req({ host: 'localhost:8484', fetchSite: 'none' }), PORT), true);
});

test('D-24 ATTACK 1: a page on another address POSTing at a loopback port is REFUSED', () => {
  // MEASURED. The server saw remote 127.0.0.1 with origin http://10.42.14.189:9099, because
  // a no-body, no-Content-Type POST is a CORS-simple request needing no preflight. A
  // remoteAddress check passes this - which is why "it is localhost, so that is not a
  // security hole" is false.
  const attack = req({
    remote: '127.0.0.1',
    host: '127.0.0.1:8484',
    origin: 'http://10.42.14.189:9099',
    fetchSite: 'cross-site',
  });
  assert.equal(waiverApplies(attack, PORT), false);
  // And still refused with the Sec-Fetch-Site header stripped, so the rejection does not
  // depend on a header an attacker controls.
  assert.equal(waiverApplies(req({ host: '127.0.0.1:8484', origin: 'http://10.42.14.189:9099' }), PORT), false);
});

test('D-24 ATTACK 2: a different PORT on the same host is REFUSED', () => {
  // MEASURED. This one returned Sec-Fetch-Site: same-site, so rejecting only `cross-site`
  // also fails - a port is not part of a "site". Origin was present and wrong in both cases.
  const attack = req({
    remote: '127.0.0.1',
    host: '127.0.0.1:8484',
    origin: 'http://127.0.0.1:9099',
    fetchSite: 'same-site',
  });
  assert.equal(waiverApplies(attack, PORT), false);
  assert.equal(waiverApplies(req({ host: '127.0.0.1:8484', origin: 'http://localhost:9099' }), PORT), false);
});

test('every clause of the waiver is load-bearing on its own', () => {
  assert.equal(waiverApplies(req({ remote: '10.42.14.189', host: '127.0.0.1:8484' }), PORT), false, 'not loopback');
  assert.equal(waiverApplies(req({ host: '10.42.14.189:8484' }), PORT), false, 'Host is not a loopback name');
  assert.equal(waiverApplies(req({ host: '127.0.0.1:9099' }), PORT), false, 'Host names another port');
  assert.equal(waiverApplies(req({}), PORT), false, 'no Host header at all');
  assert.equal(waiverApplies(req({ host: '127.0.0.1:8484', fetchSite: 'same-site' }), PORT), false);
  assert.equal(waiverApplies(req({ host: '127.0.0.1:8484', fetchSite: 'cross-site' }), PORT), false);
  assert.equal(waiverApplies(req({ host: '127.0.0.1:8484', origin: 'not a url' }), PORT), false);
});

test('isLoopbackAddress covers the forms Node actually hands over', () => {
  for (const good of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
    assert.equal(isLoopbackAddress(good), true, good);
  }
  for (const bad of ['10.42.14.189', '::ffff:10.42.14.189', '128.0.0.1', undefined, '']) {
    assert.equal(isLoopbackAddress(bad), false, String(bad));
  }
});

// -------------------------------------------------------------- sessions

test('a session validates until it expires, and sliding keeps it alive', () => {
  const store = new SessionStore(1000);
  const { token } = store.create(0);
  assert.equal(store.validate(token, 500), true);
  // Sliding: that check moved the expiry to 1500.
  assert.equal(store.validate(token, 1400), true);
  assert.equal(store.validate(token, 2500), false, 'and eventually it does expire');
  assert.equal(store.validate(token, 2400), false, 'an expired session is gone, not resurrected');
});

test('an unknown token is never valid, and tokens are unguessable', () => {
  const store = new SessionStore();
  assert.equal(store.validate('made-up'), false);
  const a = store.create().token;
  const b = store.create().token;
  assert.notEqual(a, b);
  assert.equal(a.length >= 40, true, 'a 32-byte random, base64url');
});

test('destroyAll drops every session - what a password change and a factory reset need', () => {
  const store = new SessionStore();
  const a = store.create().token;
  store.create();
  assert.equal(store.size, 2);
  store.destroyAll();
  assert.equal(store.size, 0);
  assert.equal(store.validate(a), false);
});
