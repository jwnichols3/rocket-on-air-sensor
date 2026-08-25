import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

// The `server` workspace root, not the repo root - D-37 put the service under
// server/, and this spawns `src/index.ts` relative to it.
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

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

test('the real service loads its config file before reading ONAIR_PORT', async () => {
  const dir = await tmpDir();
  const configFile = join(dir, 'config.env');
  const stateFile = join(dir, 'state.json');
  const port = 18473;
  await writeFile(configFile, `ONAIR_PORT=${port}\nONAIR_STATE_FILE=${stateFile}\n`, 'utf8');

  // ONAIR_PORT must NOT be in the child's env - if it were, that alone would
  // explain a listening port and wouldn't prove the config file was read.
  const { ONAIR_PORT: _dropped, ...envWithoutPort } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: pkgRoot,
    env: { ...envWithoutPort, ONAIR_CONFIG: configFile },
    stdio: 'ignore',
  });

  try {
    const deadline = Date.now() + 5000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        assert.equal(res.status, 200);
        await res.text();
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.fail(`server on port ${port} never came up: ${String(lastError)}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
