import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../src/persist.js';
import { defaultState, StateTable, UNKNOWN_ID, type PersistedState } from '../src/state.js';

async function tmpStateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'onair-test-'));
  return join(dir, 'nested', 'state.json');
}

const TABLE = new StateTable();

function persisted(over: Partial<PersistedState> = {}): PersistedState {
  const base = defaultState(new Date('2026-08-05T00:00:00Z'));
  const merged = { ...base, ...over };
  return {
    ...merged,
    intended: over.intended ?? (TABLE.busy(merged.state) ? 'on' : 'off'),
    tableVersion: over.tableVersion ?? TABLE.version,
  };
}

test('save then load round-trips state, hold and message', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ state: 'interruptible', hold: 'interruptible', message: 'back at 3' }));
  const loaded = await loadState(file);
  assert.equal(loaded?.state, 'interruptible');
  assert.equal(loaded?.hold, 'interruptible');
  assert.equal(loaded?.message, 'back at 3');
});

test('save leaves no tmp file behind', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ state: 'on-air' }));
  const entries = await readdir(join(file, '..'));
  assert.deepEqual(entries, ['state.json']);
});

test('load returns null when the file does not exist', async () => {
  const file = await tmpStateFile();
  assert.equal(await loadState(file), null);
});

test('load always returns confirmed unknown: a file is not evidence about the device', async () => {
  const file = await tmpStateFile();
  await saveState(file, { ...persisted({ state: 'on-air' }), confirmed: 'on-air' });
  assert.equal((await loadState(file))?.confirmed, UNKNOWN_ID);
});

test('the hold survives a restart', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ state: 'interruptible', hold: 'interruptible' }));
  assert.equal((await loadState(file))?.hold, 'interruptible');
});

// ------------------------------------------------- the one-time v1 migration

test('a v1 file saying level:"dnd" loads as on-air, not as unknown', async () => {
  const file = await tmpStateFile();
  // D-34 says an id that is not in the table resolves to `unknown`. That is right for a
  // row the owner DELETED and wrong here: `dnd` is the same meaning in the old vocabulary,
  // and resolving it to NO DATA would flip the live panel to the fault appearance on the
  // upgrade restart. Both are busy, so the meaning is preserved exactly.
  await writeFile(file.replace('/nested/', '/'), '', 'utf8').catch(() => {});
  await saveState(file, { intended: 'on', confirmed: 'unknown', level: 'dnd', source: 'webui', hold: null,
    updatedAt: '2026-08-23T19:17:20.304Z', message: null } as unknown as PersistedState);
  const lines: string[] = [];
  const loaded = await loadState(file, (l) => lines.push(l));
  assert.equal(loaded?.state, 'on-air');
  assert.equal(TABLE.busy(loaded!.state), true, 'the migration must not make a busy state calm');
  assert.equal(lines.length, 1, 'the migration says so out loud');
  assert.match(lines[0]!, /dnd -> on-air/);
});

test('the other two v1 levels map straight across', async () => {
  for (const [level, expected] of [['interruptible', 'interruptible'], ['available', 'available']] as const) {
    const file = await tmpStateFile();
    await saveState(file, { intended: 'off', confirmed: 'unknown', level, source: 'x', hold: null,
      updatedAt: '2026-08-23T19:17:20.304Z', message: null } as unknown as PersistedState);
    assert.equal((await loadState(file))?.state, expected);
  }
});

test('a v1 hold is migrated with the same map', async () => {
  const file = await tmpStateFile();
  await saveState(file, { intended: 'on', confirmed: 'unknown', level: 'dnd', hold: 'dnd', source: 'x',
    updatedAt: '2026-08-23T19:17:20.304Z', message: null } as unknown as PersistedState);
  assert.equal((await loadState(file))?.hold, 'on-air');
});

test('a file older than `level` (intended only) still loads, on the busy side', async () => {
  const file = await tmpStateFile();
  await saveState(file, { intended: 'on', confirmed: 'unknown', source: 'x',
    updatedAt: '2026-08-05T00:00:00Z', message: null } as unknown as PersistedState);
  assert.equal((await loadState(file))?.state, 'on-air');
});

test('a v2 file wins over any legacy field beside it', async () => {
  const file = await tmpStateFile();
  await saveState(file, { state: 'recording', level: 'available', intended: 'off', confirmed: 'unknown',
    source: 'x', hold: null, updatedAt: '2026-08-24T00:00:00Z', message: null } as unknown as PersistedState);
  assert.equal((await loadState(file))?.state, 'recording');
});

// ------------------------------------------------------------- corrupt files

test('a corrupt state file is quarantined and loads as unknown with a message', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ state: 'on-air' }));
  await writeFile(file, '{not json', 'utf8');
  const loaded = await loadState(file);
  assert.equal(loaded?.state, UNKNOWN_ID, 'a degenerate path lands somewhere conspicuous');
  assert.match(loaded?.message ?? '', /quarantined/);
  const entries = await readdir(join(file, '..'));
  assert.equal(entries.some((e) => e.includes('.corrupt-')), true);
});

test('a valid-JSON invalid-shape file is quarantined, not thrown', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(file, JSON.stringify({ nope: true }), 'utf8');
  const loaded = await loadState(file);
  assert.equal(loaded?.state, UNKNOWN_ID);
  assert.match(loaded?.message ?? '', /invalid shape/);
});

test('a file whose updatedAt does not parse is quarantined', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(file, JSON.stringify({ state: 'on-air', updatedAt: 'nope' }), 'utf8');
  assert.match((await loadState(file))?.message ?? '', /invalid shape/);
});

test('a file with a parseable date but no usable state is quarantined, never guessed', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted());
  await writeFile(file, JSON.stringify({ updatedAt: '2026-08-24T00:00:00Z', source: 'x' }), 'utf8');
  const loaded = await loadState(file);
  assert.equal(loaded?.state, UNKNOWN_ID);
  assert.match(loaded?.message ?? '', /invalid shape/);
});

test('what lands on disk carries state, intended and tableVersion', async () => {
  const file = await tmpStateFile();
  await saveState(file, persisted({ state: 'on-air' }));
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(raw.state, 'on-air');
  assert.equal(raw.intended, 'on');
  assert.equal(raw.tableVersion, 1);
  assert.equal(raw.confirmed, UNKNOWN_ID);
});
