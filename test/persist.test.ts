import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../src/persist.js';
import { defaultState, levelToOnOff, type PersistedState } from '../src/state.js';

async function tmpStateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'onair-test-'));
  return join(dir, 'nested', 'state.json');
}

function persisted(over: Partial<PersistedState> = {}): PersistedState {
  const base = defaultState(new Date('2026-08-05T00:00:00Z'));
  const merged = { ...base, ...over };
  return { ...merged, intended: over.intended ?? levelToOnOff(merged.level) };
}

/** The shape check shipped in the PREVIOUS binary, copied verbatim from src/state.ts
 *  @ 2105e61. A file we write must still satisfy it or a D-14 rollback bricks. */
function oldIsOnAirState(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    (s.intended === 'on' || s.intended === 'off') &&
    (s.confirmed === 'on' || s.confirmed === 'off' || s.confirmed === 'unknown') &&
    typeof s.source === 'string' &&
    typeof s.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(s.updatedAt)) &&
    (s.message === undefined || s.message === null || typeof s.message === 'string')
  );
}

test('save then load round-trips level, hold and message', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ level: 'interruptible', hold: 'interruptible', source: 'webui', message: 'BE QUIET' }));
  const loaded = await loadState(file);
  assert.equal(loaded?.level, 'interruptible');
  assert.equal(loaded?.hold, 'interruptible');
  assert.equal(loaded?.source, 'webui');
  assert.equal(loaded?.message, 'BE QUIET');
});

test('save leaves no tmp file behind', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  const entries = await readdir(join(file, '..'));
  assert.deepEqual(entries, ['state.json']);
});

test('load returns null when the file does not exist', async () => {
  const file = await tmpStateFile();
  assert.equal(await loadState(file), null);
});

test('loads a legacy state file (intended, no level) with level derived', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(
    file,
    JSON.stringify({ intended: 'on', confirmed: 'unknown', source: 'detector', updatedAt: '2026-08-05T00:00:00.000Z' }),
    'utf8',
  );
  const loaded = await loadState(file);
  assert.equal(loaded?.level, 'dnd', 'legacy on -> dnd');
  assert.equal(loaded?.message, null);
  assert.equal(loaded?.hold, null);
});

test('a legacy off file loads as available', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(
    file,
    JSON.stringify({ intended: 'off', confirmed: 'off', source: 'detector', updatedAt: '2026-08-05T00:00:00.000Z' }),
    'utf8',
  );
  assert.equal((await loadState(file))?.level, 'available');
});

test('reconciles a rolled-back file: {level:"available", intended:"on"} loads as dnd', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  // What the OLD binary writes back after being told ON AIR: it spreads the unknown
  // `level` through untouched while updating `intended`. Preferring `level` here is a
  // false-GREEN generator. Take the higher rung.
  await writeFile(
    file,
    JSON.stringify({
      level: 'available',
      intended: 'on',
      confirmed: 'unknown',
      source: 'detector',
      updatedAt: '2026-08-05T00:00:00.000Z',
    }),
    'utf8',
  );
  assert.equal((await loadState(file))?.level, 'dnd');
});

test('reconciliation never lowers: {level:"dnd", intended:"off"} loads as dnd', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(
    file,
    JSON.stringify({ level: 'dnd', intended: 'off', confirmed: 'unknown', source: 'x', updatedAt: '2026-08-05T00:00:00.000Z' }),
    'utf8',
  );
  assert.equal((await loadState(file))?.level, 'dnd');
});

test('a state file written by the new code still passes the previous shape validator', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ level: 'interruptible', hold: 'interruptible' }));
  const onDisk: unknown = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(oldIsOnAirState(onDisk), true, 'a D-14 rollback must not brick on our file');
  assert.equal((onDisk as PersistedState).intended, 'on', 'interruptible reads as on to an old binary');
});

test('a corrupt state file is quarantined and loads as dnd with a message', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ level: 'available' }));
  await writeFile(file, '{not json', 'utf8');
  const loaded = await loadState(file);
  assert.equal(loaded?.level, 'dnd', 'a quarantine must land on the safe rung');
  assert.equal(loaded?.source, 'recovered');
  assert.match(loaded?.message ?? '', /unparseable JSON/);
  const entries = await readdir(join(file, '..'));
  assert.equal(entries.some((e) => e.startsWith('state.json.corrupt-')), true, 'the bad bytes are kept');
});

test('a valid-JSON invalid-shape file is quarantined, not thrown', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(file, JSON.stringify({ intended: 'sideways' }), 'utf8');
  const loaded = await loadState(file);
  assert.equal(loaded?.level, 'dnd');
  assert.match(loaded?.message ?? '', /invalid shape/);
});

test('a file whose updatedAt does not parse is quarantined', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(
    file,
    JSON.stringify({ intended: 'on', confirmed: 'unknown', source: 'detector', updatedAt: 'yesterday' }),
    'utf8',
  );
  assert.match((await loadState(file))?.message ?? '', /invalid shape/);
});

test('load always returns confirmed unknown: a file is not evidence about the device', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ level: 'dnd', confirmed: 'dnd' }));
  assert.equal((await loadState(file))?.confirmed, 'unknown');
});

test('the hold survives a restart', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ level: 'interruptible', hold: 'interruptible' }));
  assert.equal((await loadState(file))?.hold, 'interruptible');
});
