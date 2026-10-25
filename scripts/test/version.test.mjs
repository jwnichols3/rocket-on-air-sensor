import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { checkVersions, setVersion } from '../version.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'onair-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': { name: 'product', version: '0.2.0', private: true },
    'server/package.json': { name: 'server', version: '0.2.0' },
    'admin-ui/package.json': { name: 'admin', version: '0.2.0' },
    'companion-module/package.json': { name: 'companion', version: '0.7.2' },
    'companion-module/companion/manifest.json': { id: 'companion', version: '0.7.2' },
    'package-lock.json': { version: '0.2.0', packages: {
      '': { version: '0.2.0' }, server: { version: '0.2.0' }, 'admin-ui': { version: '0.2.0' },
      'companion-module': { version: '0.7.2' }, 'node_modules/example': { version: '9.0.0' },
    } },
  };
  for (const [path, doc] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(doc));
  }
  await mkdir(join(root, 'deploy/swiftbar'), { recursive: true });
  await writeFile(join(root, 'deploy/swiftbar/onair.5s.sh'), '#!/bin/bash\n# <xbar.version>v0.2.0</xbar.version>\necho still-here\n');
  await chmod(join(root, 'deploy/swiftbar/onair.5s.sh'), 0o755);
  return root;
}
const json = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));

test('a consistent product keeps Companion independently versioned', async (t) => {
  assert.equal(await checkVersions(await fixture(t)), '0.2.0');
});

test('a bump synchronizes manifests, lock records and About without changing other versions or plugin code', async (t) => {
  const root = await fixture(t);
  const mask = process.umask(0o077);
  try { assert.equal(await setVersion(root, 'minor'), '0.3.0'); } finally { process.umask(mask); }
  assert.equal(await checkVersions(root), '0.3.0');
  assert.equal((await stat(join(root, 'deploy/swiftbar/onair.5s.sh'))).mode & 0o777, 0o755);
  assert.equal((await json(root, 'companion-module/package.json')).version, '0.7.2');
  assert.equal((await json(root, 'package-lock.json')).packages['node_modules/example'].version, '9.0.0');
  assert.match(await readFile(join(root, 'deploy/swiftbar/onair.5s.sh'), 'utf8'), /v0\.3\.0.*\necho still-here/s);
  assert.equal(await setVersion(root, 'patch'), '0.3.1');
  assert.equal(await setVersion(root, '1.0.0'), '1.0.0');
  assert.equal(await setVersion(root, 'major'), '2.0.0');
});

test('missing and duplicate About metadata are refused before any version changes', async (t) => {
  for (const content of ['#!/bin/bash\n', '# <xbar.version>v0.2.0</xbar.version>\n# <xbar.version>v0.2.0</xbar.version>\n']) {
    const root = await fixture(t);
    await writeFile(join(root, 'deploy/swiftbar/onair.5s.sh'), content);
    await assert.rejects(checkVersions(root), /exactly one/);
    await assert.rejects(setVersion(root, 'minor'), /exactly one/);
    assert.equal((await json(root, 'package.json')).version, '0.2.0');
  }
});

test('lockfile, workspace and plugin drift all fail the check', async (t) => {
  const root = await fixture(t);
  const lock = await json(root, 'package-lock.json');
  lock.packages.server.version = '0.1.0';
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  await writeFile(join(root, 'admin-ui/package.json'), JSON.stringify({ version: '0.0.0' }));
  await writeFile(join(root, 'deploy/swiftbar/onair.5s.sh'), '# <xbar.version>v0.1.0</xbar.version>\n');
  await assert.rejects(checkVersions(root), (err) => /packages\["server"\]/.test(err.message) && /admin-ui\/package/.test(err.message) && /onair\.5s/.test(err.message));
});

test('invalid, overflowing and backwards versions cannot modify files', async (t) => {
  const root = await fixture(t);
  const before = await readFile(join(root, 'package.json'), 'utf8');
  for (const version of ['v1.0.0', '01.2.3', '1.2', '1.0.0-beta.1', '9007199254740992.0.0', '0.1.9']) {
    await assert.rejects(setVersion(root, version));
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before);
  }
});

test('a missing lock workspace record is refused rather than fabricated', async (t) => {
  const root = await fixture(t);
  const lock = await json(root, 'package-lock.json');
  delete lock.packages.server;
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(setVersion(root, 'patch'), /missing packages/);
  assert.equal((await json(root, 'package.json')).version, '0.2.0');
});


test('Companion manifest drift is rejected independently of product version', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'companion-module/companion/manifest.json'), JSON.stringify({ version: '0.6.0' }));
  await assert.rejects(checkVersions(root), /companion.*manifest/);
});

test('a module-only bump keeps product and SwiftBar unchanged and synchronizes all module version records', async (t) => {
  const root = await fixture(t);
  const { setModuleVersion } = await import('../version.mjs');
  const plugin = await readFile(join(root, 'deploy/swiftbar/onair.5s.sh'), 'utf8');
  assert.equal(await setModuleVersion(root, 'patch'), '0.7.3');
  assert.equal((await json(root, 'companion-module/package.json')).version, '0.7.3');
  assert.equal((await json(root, 'companion-module/companion/manifest.json')).version, '0.7.3');
  assert.equal((await json(root, 'package-lock.json')).packages['companion-module'].version, '0.7.3');
  assert.equal(await checkVersions(root), '0.2.0');
  assert.equal(await readFile(join(root, 'deploy/swiftbar/onair.5s.sh'), 'utf8'), plugin);
  await assert.rejects(setModuleVersion(root, '0.7.2'), /backwards/);
});
