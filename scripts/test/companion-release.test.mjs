import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseReleaseArgs, releaseModule } from '../companion-release.mjs';
import { inspectPackage } from '../lib/companion-package.mjs';

const SECRET = 'private-firmware-test-value';
const SHA = (bytes) => createHash('sha256').update(bytes).digest('hex');
function git(repo, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', stdio: 'pipe', env: { ...process.env,
      GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }).trim();
}

async function harness(t, overrides = {}) {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'onair-release-command-')));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const write = async (file, contents, mode) => {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), contents, mode ? { mode } : undefined);
  };
  const docs = {
    'package.json': { name: 'release-test', version: '0.2.0', private: true },
    'server/package.json': { version: '0.2.0' },
    'admin-ui/package.json': { version: '0.2.0' },
    'companion-module/package.json': { version: '0.8.0' },
    'companion-module/companion/manifest.json': { id: 'rocket-onair', version: '0.8.0' },
    'package-lock.json': { version: '0.2.0', lockfileVersion: 3, packages: {
      '': { version: '0.2.0' }, server: { version: '0.2.0' }, 'admin-ui': { version: '0.2.0' },
      'companion-module': { version: '0.8.0' },
    } },
  };
  for (const [file, value] of Object.entries(docs)) await write(file, JSON.stringify(value));
  await write('deploy/swiftbar/onair.5s.sh', '# <xbar.version>v0.2.0</xbar.version>\n');
  await write('firmware/configs/secrets.yaml.example', 'password: example\n');
  await write('README.md', 'reviewed source\n');
  await write('.gitignore', 'node_modules/\n.venv/\nserver/dist/\nserver/public/admin/\ncompanion-module/dist/\ncompanion-module/pkg/\nfirmware/configs/secrets.yaml\n');
  git(repo, 'init', '--quiet'); git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'Fixture source');
  const commit = git(repo, 'rev-parse', 'HEAD');
  // These ignored files represent the live assets and private environment in the caller.
  await write('server/dist/index.js', 'LIVE RECEIVER');
  await write('server/public/admin/index.html', 'LIVE CONSOLE');
  await write('node_modules/source-sentinel', 'EXISTING DEPENDENCIES');
  await write('firmware/.venv/bin/python', '#!/bin/sh\nexit 0\n', 0o755);
  await write('firmware/.venv/bin/esphome', '#!/bin/sh\nexit 0\n', 0o755);
  await write('firmware/configs/secrets.yaml', `password: ${SECRET}\n`, 0o600);
  await write('companion-module/pkg/rocket-onair-0.8.0.tgz', 'PREVIOUS ARCHIVE');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  const calls = [], clones = [];
  let deployed;
  const options = { target: 'http://companion.invalid:8000', connectionId: 'explicit-connection', controls: ['1/2/1'] };
  const dependencies = {
    repo,
    runCommand: async (command, args, { cwd, env }) => {
      calls.push({ command, args, cwd });
      if (command === 'git') {
        if (args[0] === 'clone') clones.push(args.at(-1));
        return git(cwd, ...args);
      }
      assert.equal(command, 'npm');
      assert(env, 'npm children need an explicitly isolated runtime environment');
      assert.deepEqual(Object.keys(env).filter(name => name.startsWith('ONAIR_')), []);
      assert.equal(env.PATH, process.env.PATH);
      assert.equal(env.HOME, process.env.HOME);
      assert.notEqual(cwd, repo, 'npm must never build in the caller checkout');
      assert.equal(git(cwd, 'rev-parse', 'HEAD'), commit);
      assert.equal(await realpath(join(cwd, 'firmware/.venv')), await realpath(join(repo, 'firmware/.venv')));
      assert.equal(await readFile(join(cwd, 'firmware/configs/secrets.yaml'), 'utf8'), `password: ${SECRET}\n`);
      assert.equal((await stat(join(cwd, 'firmware/configs/secrets.yaml'))).mode & 0o777, 0o600);
      if (args[0] === 'ci') {
        assert.deepEqual(args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
        await assert.rejects(access(join(cwd, 'node_modules')), { code: 'ENOENT' });
        await mkdir(join(cwd, 'node_modules'));
        await writeFile(join(cwd, 'node_modules/from-lock'), SHA(await readFile(join(cwd, 'package-lock.json'))));
      } else if (args[1] === 'verify') {
        assert.equal(await readFile(join(cwd, 'node_modules/from-lock'), 'utf8'), SHA(await readFile(join(repo, 'package-lock.json'))));
        await mkdir(join(cwd, 'server/dist'), { recursive: true });
        await mkdir(join(cwd, 'server/public/admin'), { recursive: true });
        // A real fake-build write makes a wrong cwd damage the sentinels and fail the test.
        await writeFile(join(cwd, 'server/dist/index.js'), 'ISOLATED VERIFY RECEIVER');
        await writeFile(join(cwd, 'server/public/admin/index.html'), 'ISOLATED VERIFY CONSOLE');
        await writeFile(join(cwd, 'node_modules/verified'), 'yes');
        if (overrides.advanceSource) {
          await writeFile(join(repo, 'README.md'), 'concurrent change\n');
          git(repo, 'add', 'README.md'); git(repo, 'commit', '--quiet', '-m', 'Concurrent source change');
        }
      } else {
        assert.deepEqual(args, ['run', 'package', '--workspace', 'companion-module']);
        assert.equal(await readFile(join(cwd, 'node_modules/verified'), 'utf8'), 'yes');
        const stage = join(cwd, 'companion-module/dist/rocket-onair');
        await mkdir(join(stage, 'companion'), { recursive: true });
        const code = 'export const marker = "isolated build";\n';
        await writeFile(join(stage, 'main.js'), code);
        await writeFile(join(stage, 'package.json'), JSON.stringify({ version: '0.8.0', type: 'module' }));
        await writeFile(join(stage, 'companion/manifest.json'), JSON.stringify({ id: 'rocket-onair', type: 'connection', version: '0.8.0' }));
        await writeFile(join(stage, 'build-info.json'), JSON.stringify({ version: '0.8.0', commit: overrides.wrongBuild ? 'c'.repeat(40) : commit,
          dirty: false, builtAt: new Date().toISOString(), bundleSha256: SHA(code) }));
        await mkdir(join(cwd, 'companion-module/pkg'), { recursive: true });
        execFileSync('tar', ['-czf', join(cwd, 'companion-module/pkg/rocket-onair-0.8.0.tgz'), '-C', dirname(stage), 'rocket-onair'], {
          env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'pipe',
        });
      }
      if (args[0] === overrides.failStep || args[1] === overrides.failStep) throw new Error(`failed ${overrides.failStep}`);
      return '';
    },
    deploy: async (input) => {
      deployed = input;
      for (const clone of clones) await assert.rejects(access(clone), { code: 'ENOENT' });
      const artifact = await inspectPackage(input.packagePath);
      assert.equal(artifact.info.commit, commit);
      assert.equal(artifact.archiveSha256, input.expectedArchiveSha256);
      return { result: 'deployed', version: '0.8.0' };
    },
  };
  const assertCallerUnchanged = async () => {
    assert.equal(await readFile(join(repo, 'server/dist/index.js'), 'utf8'), 'LIVE RECEIVER');
    assert.equal(await readFile(join(repo, 'server/public/admin/index.html'), 'utf8'), 'LIVE CONSOLE');
    assert.equal(await readFile(join(repo, 'node_modules/source-sentinel'), 'utf8'), 'EXISTING DEPENDENCIES');
    assert.equal(await readFile(join(repo, 'firmware/.venv/bin/esphome'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal(await readFile(join(repo, 'firmware/configs/secrets.yaml'), 'utf8'), `password: ${SECRET}\n`);
    for (const clone of clones) await assert.rejects(access(clone), { code: 'ENOENT' });
  };
  return { repo, commit, calls, clones, options, dependencies, assertCallerUnchanged, deployed: () => deployed };
}

test('release verifies/packages an isolated real Git clone and returns only its pinned artifact', async (t) => {
  const h = await harness(t);
  const result = await releaseModule(h.options, h.dependencies);
  assert.equal(result.verifiedCommit, h.commit);
  assert.equal(h.clones.length, 1);
  assert.deepEqual(h.calls.filter(c => c.command === 'npm').map(c => c.args), [
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'verify'], ['run', 'package', '--workspace', 'companion-module'],
  ]);
  assert.equal(h.deployed().packagePath, join(h.repo, 'companion-module/pkg/rocket-onair-0.8.0.tgz'));
  assert.equal(h.deployed().target, h.options.target);
  assert.equal(h.deployed().connectionId, h.options.connectionId);
  assert.deepEqual(h.deployed().controls, ['1/2/1']);
  assert.equal(h.deployed().expectedCommit, h.commit);
  assert.equal(await readFile(result.checksumFile, 'utf8'), `${h.deployed().expectedArchiveSha256}  rocket-onair-0.8.0.tgz\n`);
  assert(h.calls.every(c => !['push', 'commit', 'tag'].includes(c.args[0])), 'publication remains explicit');
  await h.assertCallerUnchanged();
  assert.equal(git(h.repo, 'status', '--porcelain'), '');
});

test('dependency, verification and packaging failures clean the clone and preserve live caller assets', async (t) => {
  for (const failStep of ['ci', 'verify', 'package']) {
    const h = await harness(t, { failStep });
    await assert.rejects(releaseModule(h.options, h.dependencies), new RegExp(`failed ${failStep}`));
    assert.equal(h.deployed(), undefined);
    await h.assertCallerUnchanged();
    assert.equal(await readFile(join(h.repo, 'companion-module/pkg/rocket-onair-0.8.0.tgz'), 'utf8'), 'PREVIOUS ARCHIVE');
  }
});

test('missing firmware prerequisites fail clearly before cloning or deploying', async (t) => {
  const h = await harness(t);
  await rm(join(h.repo, 'firmware/.venv/bin/esphome'));
  await assert.rejects(releaseModule(h.options, h.dependencies), /firmware:setup/);
  assert.equal(h.clones.length, 0);
  const missingSecrets = await harness(t);
  await rm(join(missingSecrets.repo, 'firmware/configs/secrets.yaml'));
  await assert.rejects(releaseModule(missingSecrets.options, missingSecrets.dependencies), /secrets.yaml/);
  assert.equal(missingSecrets.clones.length, 0);
});

test('dirty caller and committed version drift stop before cloning or deploying', async (t) => {
  const dirty = await harness(t);
  await writeFile(join(dirty.repo, 'README.md'), 'uncommitted\n');
  await assert.rejects(releaseModule(dirty.options, dirty.dependencies), /local changes/);
  assert.equal(dirty.clones.length, 0);
  const drift = await harness(t);
  await writeFile(join(drift.repo, 'server/package.json'), JSON.stringify({ version: '0.1.0' }));
  git(drift.repo, 'add', 'server/package.json'); git(drift.repo, 'commit', '--quiet', '-m', 'Version drift');
  await assert.rejects(releaseModule(drift.options, drift.dependencies), /Version drift/);
  assert.equal(drift.clones.length, 0);
});

test('caller commit movement and wrong artifact identity stop deployment and artifact replacement', async (t) => {
  for (const override of [{ advanceSource: true }, { wrongBuild: true }]) {
    const h = await harness(t, override);
    await assert.rejects(releaseModule(h.options, h.dependencies), /changed|tested clean revision/);
    assert.equal(h.deployed(), undefined);
    await h.assertCallerUnchanged();
    assert.equal(await readFile(join(h.repo, 'companion-module/pkg/rocket-onair-0.8.0.tgz'), 'utf8'), 'PREVIOUS ARCHIVE');
  }
});

test('release has no implicit target and cannot substitute an existing package or rollback backup', () => {
  assert.throws(() => parseReleaseArgs([]), /value|origin|target/i);
  assert.throws(() => parseReleaseArgs(['--target', 'http://companion.invalid:8000']), /connection/);
  assert.throws(() => parseReleaseArgs(['--package', 'something.tgz']), /builds its own package/);
  assert.throws(() => parseReleaseArgs(['--backup', 'before.json']), /builds its own package/);
});

test('operator runtime overrides never reach isolated installs, tests or builds', async (t) => {
  const h = await harness(t);
  const keys = ['ONAIR_LIGHT_HOST', 'ONAIR_STATE_FILE', 'ONAIR_CONFIG', 'ONAIR_CONFIG_FILE', 'ONAIR_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  for (const key of keys) process.env[key] = `operator-${key.toLowerCase()}`;
  await releaseModule(h.options, h.dependencies);
  for (const key of keys) assert.equal(process.env[key], `operator-${key.toLowerCase()}`);
  await h.assertCallerUnchanged();
});
