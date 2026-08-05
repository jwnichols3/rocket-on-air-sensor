import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../src/persist.js';
import { defaultState } from '../src/state.js';

async function tmpStateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'onair-test-'));
  return join(dir, 'nested', 'state.json');
}

test('save then load round-trips and creates parent dirs', async () => {
  const file = await tmpStateFile();
  const state = { ...defaultState(), intended: 'on' as const, source: 'detector' };
  await saveState(file, state);
  assert.deepEqual(await loadState(file), state);
});

test('save leaves no tmp file behind', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  const entries = await readdir(join(file, '..'));
  assert.deepEqual(entries, ['state.json']);
});

test('load returns null when the file does not exist', async () => {
  const file = await tmpStateFile();
  assert.equal(await loadState(file), null);
});

test('load throws on corrupt JSON', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  await writeFile(file, '{not json', 'utf8');
  await assert.rejects(() => loadState(file));
});

test('load throws on valid JSON with invalid shape', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  await writeFile(file, JSON.stringify({ intended: 'sideways' }), 'utf8');
  await assert.rejects(() => loadState(file), /invalid shape/);
});

test('pre-message state files load with message null', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  await writeFile(
    file,
    JSON.stringify({ intended: 'on', confirmed: 'unknown', source: 'detector', updatedAt: '2026-08-05T00:00:00.000Z' }),
    'utf8',
  );
  const loaded = await loadState(file);
  assert.equal(loaded?.message, null);
  assert.equal(loaded?.intended, 'on');
});

test('message round-trips through save and load', async () => {
  const file = await tmpStateFile();
  await saveState(file, { ...defaultState(), message: 'BE QUIET' });
  assert.equal((await loadState(file))?.message, 'BE QUIET');
});
