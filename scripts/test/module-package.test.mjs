import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t, mismatch = false) {
  const root = await mkdtemp(join(tmpdir(), 'onair-module-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = join(root, 'companion-module');
  await mkdir(join(module, 'src'), { recursive: true });
  await mkdir(join(module, 'companion'), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'));
  for (const file of ['build.mjs', 'package.mjs']) await copyFile(join(repo, 'companion-module', file), join(module, file));
  await writeFile(join(module, 'package.json'), JSON.stringify({ type: 'module', version: '0.7.3' }));
  await writeFile(join(module, 'companion/manifest.json'), JSON.stringify({ id: 'rocket-onair', version: mismatch ? '0.7.2' : '0.7.3' }));
  await writeFile(join(module, 'src/index.js'), 'export const marker = "test fixture";\n');
  return module;
}
const run = (module, script) => execFileSync(process.execPath, [join(module, script)], { cwd: module, encoding: 'utf8', stdio: 'pipe' });

test('module build refuses manifest/package version drift before creating a sideload', async (t) => {
  const module = await fixture(t, true);
  assert.throws(() => run(module, 'build.mjs'), /version/i);
});

test('built runtime identity matches package metadata and archive validation catches modified code', async (t) => {
  const module = await fixture(t);
  await copyFile(join(repo, 'companion-module/src/build-info.js'), join(module, 'src/build-info.js'));
  await writeFile(join(module, 'src/index.js'), 'export { MODULE_BUILD_INFO } from "./build-info.js";\n');
  run(module, 'build.mjs');
  const { MODULE_BUILD_INFO } = await import(pathToFileURL(join(module, 'dist/main.js')));
  const info = JSON.parse(await readFile(join(module, 'dist/build-info.json'), 'utf8'));
  assert.deepEqual(MODULE_BUILD_INFO, { version: '0.7.3', commit: null, dirty: null, builtAt: info.builtAt });
  assert.match(info.bundleSha256, /^[0-9a-f]{64}$/);
  assert(Number.isFinite(Date.parse(info.builtAt)));
  assert.match(run(module, 'package.mjs'), /packaged/);
  const archive = join(module, 'pkg/rocket-onair-0.7.3.tgz');
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert(entries.includes('rocket-onair/build-info.json'));
  assert.equal(entries.some((entry) => entry.split('/').some((part) => part.startsWith('._'))), false);
  await writeFile(join(module, 'dist/main.js'), '// modified after stamping\n');
  assert.throws(() => run(module, 'package.mjs'), /bundle.*hash|hash.*bundle/i);
});
