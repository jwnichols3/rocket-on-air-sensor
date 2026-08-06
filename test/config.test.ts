import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'onair-config-test-'));
}

test('values load from the file', async () => {
  const dir = await tmpDir();
  const file = join(dir, 'config.env');
  await writeFile(file, 'TESTCFG_LOAD=from-file\n', 'utf8');
  loadConfig(file);
  assert.equal(process.env.TESTCFG_LOAD, 'from-file');
});

test('a pre-set real env var wins over the file', async () => {
  const dir = await tmpDir();
  const file = join(dir, 'config.env');
  await writeFile(file, 'TESTCFG_WINS=from-file\n', 'utf8');
  process.env.TESTCFG_WINS = 'from-env';
  loadConfig(file);
  assert.equal(process.env.TESTCFG_WINS, 'from-env');
  delete process.env.TESTCFG_WINS;
});

test('missing file is silent', async () => {
  const dir = await tmpDir();
  const file = join(dir, 'does-not-exist.env');
  assert.doesNotThrow(() => loadConfig(file));
});

test('malformed line is ignored, valid lines still load', async () => {
  const dir = await tmpDir();
  const file = join(dir, 'config.env');
  await writeFile(file, 'this is not a valid line\nTESTCFG_MALFORMED=still-loads\n', 'utf8');
  loadConfig(file);
  assert.equal(process.env.TESTCFG_MALFORMED, 'still-loads');
});

test('ONAIR_CONFIG env var overrides the default path', async () => {
  const dir = await tmpDir();
  const file = join(dir, 'config.env');
  await writeFile(file, 'TESTCFG_ONAIR_OVERRIDE=via-onair-config\n', 'utf8');
  process.env.ONAIR_CONFIG = file;
  loadConfig();
  assert.equal(process.env.TESTCFG_ONAIR_OVERRIDE, 'via-onair-config');
  delete process.env.ONAIR_CONFIG;
});

test('path-is-a-directory throws', async () => {
  const dir = await tmpDir();
  const asDir = join(dir, 'a-directory');
  await mkdir(asDir);
  assert.throws(() => loadConfig(asDir));
});
