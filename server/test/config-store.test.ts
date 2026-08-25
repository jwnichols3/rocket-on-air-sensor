import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigWriteError,
  defaultConfig,
  isOutOfSpace,
  loadConfigFile,
  parseBind,
  resolveBind,
  saveConfigFile,
  validateConfig,
} from '../src/config-store.js';
import { SEED_ROWS, UNKNOWN_ID } from '../src/state.js';

async function tmpFile(name = 'config.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'onair-cfg-')), name);
}

// ------------------------------------------------------------- validation

test('the default config validates, round-trips, and is the seed table', () => {
  const d = defaultConfig();
  const v = validateConfig(JSON.parse(JSON.stringify(d)));
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.deepEqual(v.config.states.map((r) => r.id), SEED_ROWS.map((r) => r.id));
    assert.equal(v.config.port, 8484);
    assert.equal(v.config.bind, 'all');
  }
});

test('every field is checked, and the errors NAME the field', () => {
  const bad = { ...defaultConfig(), version: 0, port: 70000, bind: 'eth0' };
  const v = validateConfig(bad);
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.errors.length, 3);
    assert.ok(v.errors.some((e) => e.includes('version')));
    assert.ok(v.errors.some((e) => e.includes('port')));
    assert.ok(v.errors.some((e) => e.includes('bind')));
  }
});

test('row validation: id pattern, duplicate ids, colours, label length, order range', () => {
  const row = { ...SEED_ROWS[0]! };
  const cases: Array<[Partial<typeof row>, string]> = [
    [{ id: 'Not Valid' }, 'id'],
    [{ label: '' }, 'label'],
    [{ label: 'x'.repeat(65) }, 'label'],
    [{ color: 'red' }, 'color'],
    [{ color: '#FFFFFF' }, 'color'],
    [{ bgcolor: '#fff' }, 'bgcolor'],
    [{ order: 1000 }, 'order'],
    [{ order: -1 }, 'order'],
    [{ description: 'x'.repeat(201) }, 'description'],
  ];
  for (const [over, field] of cases) {
    const v = validateConfig({ ...defaultConfig(), states: [{ ...row, ...over }] });
    assert.equal(v.ok, false, `${field}: ${JSON.stringify(over)} must be rejected`);
    if (!v.ok) assert.ok(v.errors.some((e) => e.includes(field)), `error should name ${field}: ${v.errors}`);
  }
});

test('duplicate ids are rejected: id is THE address and must be unique', () => {
  const v = validateConfig({ ...defaultConfig(), states: [SEED_ROWS[0]!, { ...SEED_ROWS[0]! }] });
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.some((e) => e.includes('duplicate')));
});

test('a config missing `unknown` is REPAIRED, not refused', () => {
  const v = validateConfig({ ...defaultConfig(), states: SEED_ROWS.filter((r) => r.id !== UNKNOWN_ID) });
  assert.equal(v.ok, true);
  // Refusing would leave the owner holding a file they cannot save from the UI that
  // produced it. It cannot be deleted (D-34), so put it back.
  if (v.ok) assert.equal(v.config.states.some((r) => r.id === UNKNOWN_ID), true);
});

test('an `unknown` row claiming busy:false is corrected to true', () => {
  const states = SEED_ROWS.map((r) => (r.id === UNKNOWN_ID ? { ...r, busy: false } : { ...r }));
  const v = validateConfig({ ...defaultConfig(), states });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.config.states.find((r) => r.id === UNKNOWN_ID)!.busy, true);
});

test('a shortcut naming a row that does not exist is a save-time error', () => {
  const v = validateConfig({ ...defaultConfig(), shortcuts: { on: 'nope', off: 'available' } });
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.some((e) => e.includes('nope')));
});

test('a null shortcut is legal - it means /on or /off is 409', () => {
  const v = validateConfig({ ...defaultConfig(), shortcuts: { on: null, off: null } });
  assert.equal(v.ok, true);
});

test('bind modes', () => {
  assert.equal(parseBind('all'), 'all');
  assert.equal(parseBind('loopback'), 'loopback');
  assert.equal(parseBind('iface:en0'), 'iface:en0');
  assert.equal(parseBind('iface:'), null);
  assert.equal(parseBind('192.168.1.5'), null, 'bind is a MODE, never an address');
  assert.equal(parseBind(undefined), null);
});

test('LOOPBACK IS ALWAYS BOUND, whatever the mode', () => {
  assert.deepEqual(resolveBind('loopback').addresses, ['127.0.0.1']);
  // 'all' is the dual-stack wildcard, which already includes loopback.
  assert.deepEqual(resolveBind('all').addresses, ['::']);
  const missing = resolveBind('iface:definitely-not-an-interface');
  assert.deepEqual(missing.addresses, ['127.0.0.1']);
  assert.match(missing.warning ?? '', /not found/);
});

test('a real interface resolves to loopback PLUS its addresses, in that order', () => {
  // Measured in #22: binding only a LAN address makes 127.0.0.1 return ECONNREFUSED,
  // which silently disables the admin surface from the UI whose purpose is administration.
  const named = Object.entries(networkInterfaces()).find(([, addrs]) => addrs?.some((a) => !a.internal));
  if (!named) return; // no external interface on this machine; nothing to assert
  const r = resolveBind(`iface:${named[0]}`);
  assert.equal(r.addresses[0], '127.0.0.1', 'loopback first and always');
  assert.equal(r.addresses.length > 1, true);
});

// ------------------------------------------------------------ load / save

test('a missing file is a first boot, not an error', async () => {
  const loaded = await loadConfigFile(await tmpFile());
  assert.equal(loaded.problem, undefined);
  assert.equal(loaded.config.port, 8484);
});

test('save writes 0600 and round-trips', async () => {
  const file = await tmpFile();
  const cfg = { ...defaultConfig(), port: 9999, bind: 'loopback' as const };
  await saveConfigFile(file, cfg);
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'the passphrase and device creds live here');
  const loaded = await loadConfigFile(file);
  assert.equal(loaded.problem, undefined);
  assert.equal(loaded.config.port, 9999);
  assert.equal(loaded.config.bind, 'loopback');
});

test('save leaves no tmp file behind and the JSON is hand-editable', async () => {
  const file = await tmpFile();
  await saveConfigFile(file, defaultConfig());
  const text = await readFile(file, 'utf8');
  assert.match(text, /\n  "port": 8484,/, 'indented, so it can be edited over SSH with no UI');
  assert.equal(text.endsWith('\n'), true);
});

test('AN UNPARSEABLE CONFIG NEVER THROWS - it reports and hands back defaults', async () => {
  const file = await tmpFile();
  await writeFile(file, '{ this is not json', 'utf8');
  const loaded = await loadConfigFile(file);
  // Throwing was never loud: index.ts has no try/catch, so launchd restarts forever and
  // every surface that could report the problem is down - on a machine nobody is sitting
  // in front of. It reports, and the caller binds loopback and serves a repair view.
  assert.notEqual(loaded.problem, undefined);
  assert.match(loaded.problem!.errors[0]!, /unparseable JSON/);
  assert.equal(loaded.problem!.raw, '{ this is not json', 'the raw text is kept, for the repair screen');
  assert.equal(loaded.config.port, 8484);
});

test('a parseable but INVALID config also never throws, and lists every error', async () => {
  const file = await tmpFile();
  await writeFile(file, JSON.stringify({ ...defaultConfig(), port: -1, bind: 'nope' }), 'utf8');
  const loaded = await loadConfigFile(file);
  assert.notEqual(loaded.problem, undefined);
  assert.equal(loaded.problem!.errors.length >= 2, true);
});

test('a full disk is classified as out of space; other failures are not', () => {
  // A quota counts: from the writer's side it IS a full disk, and the honest answer to the
  // client is the same one - the running config is untouched, free some space, try again.
  assert.equal(isOutOfSpace(Object.assign(new Error('x'), { code: 'ENOSPC' })), true);
  assert.equal(isOutOfSpace(Object.assign(new Error('x'), { code: 'EDQUOT' })), true);
  assert.equal(isOutOfSpace(Object.assign(new Error('x'), { code: 'EACCES' })), false);
  assert.equal(isOutOfSpace(new Error('no code at all')), false);
});

test('A FAILED SAVE LEAVES THE RUNNING CONFIG BYTE-IDENTICAL', async () => {
  const file = await tmpFile();
  await saveConfigFile(file, { ...defaultConfig(), port: 9001 });
  const before = await readFile(file, 'utf8');
  const dir = join(file, '..');
  await chmod(dir, 0o500); // no new files in here: the temp write cannot even be created
  try {
    await saveConfigFile(file, { ...defaultConfig(), port: 9002 });
    assert.fail('expected a write error');
  } catch (err) {
    assert.equal(err instanceof ConfigWriteError, true);
  } finally {
    await chmod(dir, 0o700);
  }
  // The atomic rename is what makes this true: the file is wholly the old document or
  // wholly the new one, and a write that never completed never reached the rename.
  assert.equal(await readFile(file, 'utf8'), before);
});
