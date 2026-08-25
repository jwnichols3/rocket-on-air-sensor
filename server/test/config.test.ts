import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/**
 * A port that is free right now. These two tests spawn the REAL service, and a hardcoded
 * port is a flake by construction - anything else on the machine holding it (an orphaned
 * run, another checkout) fails the test for a reason that has nothing to do with the code.
 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:http');
  const s = createServer(() => {});
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
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
  // ONAIR_CONFIG_FILE too, and not only ONAIR_CONFIG: this spawns the REAL service, and
  // since the config document is now written on first boot (D-36), leaving it unset made
  // this test write ~/.onair/config.json on the machine running it. It did - once.
  const configJson = join(dir, 'config.json');
  const port = await freePort();
  await writeFile(configFile, `ONAIR_PORT=${port}\nONAIR_STATE_FILE=${stateFile}\n`, 'utf8');

  // ONAIR_PORT must NOT be in the child's env - if it were, that alone would
  // explain a listening port and wouldn't prove the config file was read.
  const { ONAIR_PORT: _dropped, ...envWithoutPort } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: pkgRoot,
    env: { ...envWithoutPort, ONAIR_CONFIG: configFile, ONAIR_CONFIG_FILE: configJson },
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

test('the spawned service writes its config document where it is told, and nowhere else', async () => {
  const dir = await tmpDir();
  const configJson = join(dir, 'config.json');
  const stateFile = join(dir, 'state.json');
  const port = await freePort();
  const { ONAIR_PORT: _dropped, ...env } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: pkgRoot,
    env: { ...env, ONAIR_CONFIG_FILE: configJson, ONAIR_STATE_FILE: stateFile, ONAIR_PORT: String(port), ONAIR_CONFIG: join(dir, 'none.env') },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`);
        await res.text();
        // The document went to the path it was given. Before this was asserted, a test
        // that spawned the real service wrote into the developer's own ~/.onair.
        assert.equal(existsSync(configJson), true, 'the document is written where told');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.fail(`server on port ${port} never came up`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
