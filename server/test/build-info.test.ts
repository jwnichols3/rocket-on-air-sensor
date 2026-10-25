import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readBuildInfo } from '../src/build-info.js';

test('missing or malformed build metadata reports unknown instead of the current checkout', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-build-info-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = pathToFileURL(join(dir, 'build-info.json'));
  assert.deepEqual(readBuildInfo(file), { version: null, commit: null, dirty: null, builtAt: null });
  await writeFile(file, '{broken');
  assert.equal(readBuildInfo(file).commit, null);
  await writeFile(file, JSON.stringify({ version: '0.1.0', commit: 'not-a-commit', dirty: 'no', builtAt: 'yesterday' }));
  assert.deepEqual(readBuildInfo(file), { version: '0.1.0', commit: null, dirty: null, builtAt: null });
});

test('the build generator stamps an explicit staging directory independently of cwd', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-build-stamp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../tools/gen-build-info.mjs', import.meta.url));
  execFileSync(process.execPath, [script, dir], { cwd: tmpdir(), stdio: 'pipe' });
  const metadata = readBuildInfo(pathToFileURL(join(dir, 'build-info.json')));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(metadata.version, pkg.version);
  assert(metadata.builtAt && Number.isFinite(Date.parse(metadata.builtAt)));
  assert(metadata.commit === null || /^[0-9a-f]{40}$/.test(metadata.commit));
  assert(metadata.dirty === null || typeof metadata.dirty === 'boolean');
});
