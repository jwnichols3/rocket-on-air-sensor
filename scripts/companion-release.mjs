#!/usr/bin/env node
// One local release command: validate, run the full gate, package, and deploy one module.
// Git publication and version changes remain explicit, reviewed operations.
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions } from './version.mjs';
import { inspectPackage } from './lib/companion-package.mjs';
import { parseArgs, runDeployment } from './companion-deploy.mjs';

export function parseReleaseArgs(args) {
  if (args.includes('--package') || args.includes('--backup')) {
    throw new Error('module:release builds its own package; use module:deploy for existing artifacts or rollback');
  }
  return parseArgs(['deploy', ...args, '--package', '<built-by-release>']);
}

function runCommand(command, args, { cwd, capture = false, timeoutMs = 600_000, env }) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs,
    env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' }) ?? '';
}

async function cleanCommit(repo, run) {
  const git = async (...args) => String(await run('git', args, { cwd: repo, capture: true, timeoutMs: 10_000 })).trim();
  const top = await git('rev-parse', '--show-toplevel');
  if (await realpath(top) !== repo) throw new Error('Run the release from this project checkout, not a nested source archive');
  if (await git('status', '--porcelain')) throw new Error('Commit or remove local changes before releasing; no deployment attempted');
  const commit = await git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Cannot identify a committed release revision');
  return commit;
}

async function firmwarePrerequisites(repo) {
  const venv = join(repo, 'firmware', '.venv');
  const secrets = join(repo, 'firmware', 'configs', 'secrets.yaml');
  try {
    await access(join(venv, 'bin', 'python'), constants.X_OK);
    await access(join(venv, 'bin', 'esphome'), constants.X_OK);
  } catch { throw new Error('Firmware verification runtime is missing; run npm run firmware:setup before releasing'); }
  try {
    if (!(await stat(secrets)).isFile()) throw new Error();
    await access(secrets, constants.R_OK);
  } catch { throw new Error('Firmware verification needs a readable firmware/configs/secrets.yaml; its contents are never printed'); }
  return { venv: await realpath(venv), secrets };
}

async function writeArtifact(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, content); await rename(temp, path); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}

export async function releaseModule(options, dependencies = {}) {
  // Reuse the artifact command's target validation without invoking it or opening a socket.
  const validated = parseReleaseArgs([
    '--target', options.target, '--connection', options.connectionId,
    ...(options.controls ?? []).flatMap((location) => ['--control', location]),
    ...(options.backupDir ? ['--backup-dir', options.backupDir] : []),
    ...(options.timeoutMs !== undefined ? ['--timeout-ms', String(options.timeoutMs)] : []),
  ]);
  const repo = await realpath(dependencies.repo ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const run = dependencies.runCommand ?? runCommand;
  const startingCommit = await cleanCommit(repo, run);
  await (dependencies.checkVersions ?? checkVersions)(repo);
  const module = JSON.parse(await readFile(join(repo, 'companion-module/package.json'), 'utf8'));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(module.version ?? '')) throw new Error('The module needs a stable version before release');
  const archiveName = `rocket-onair-${module.version}.tgz`;
  const prerequisites = await firmwarePrerequisites(repo);
  const isolation = await realpath(await mkdtemp(join(tmpdir(), 'onair-module-release-')));
  await chmod(isolation, 0o700);
  const checkout = join(isolation, 'checkout');
  let artifact;
  try {
    // A private clone has real commit metadata without registering or changing a caller
    // worktree. No hard links or shared objects connect its writes to the source checkout.
    await run('git', ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', repo, checkout],
      { cwd: isolation, timeoutMs: 120_000 });
    await run('git', ['checkout', '--quiet', '--detach', startingCommit], { cwd: checkout, timeoutMs: 30_000 });
    if (await cleanCommit(checkout, run) !== startingCommit) throw new Error('Isolated checkout is not the requested clean revision');
    // A directory-only ".venv/" ignore rule does not cover a symlink. This is private
    // clone plumbing, so exclude it locally rather than changing tracked project files.
    await appendFile(join(checkout, '.git', 'info', 'exclude'), '\n/firmware/.venv\n');
    await symlink(prerequisites.venv, join(checkout, 'firmware', '.venv'), 'dir');
    await writeFile(join(checkout, 'firmware', 'configs', 'secrets.yaml'),
      await readFile(prerequisites.secrets), { mode: 0o600, flag: 'wx' });
    await (dependencies.checkVersions ?? checkVersions)(checkout);
    // Runtime overrides can repoint otherwise-isolated test processes at live state
    // files or devices. Keep npm/PATH/HOME settings, but never inherit ONAIR_*.
    const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ONAIR_')));
    // Always install from this commit's lockfile. The caller's node_modules and live
    // server/dist and server/public/admin are never used as build destinations.
    await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: checkout, env: buildEnv });
    await run('npm', ['run', 'verify'], { cwd: checkout, env: buildEnv });
    if (await cleanCommit(checkout, run) !== startingCommit) throw new Error('Verification modified tracked source; no deployment attempted');
    await run('npm', ['run', 'package', '--workspace', 'companion-module'], { cwd: checkout, env: buildEnv });
    if (await cleanCommit(checkout, run) !== startingCommit) throw new Error('Packaging modified tracked source; no deployment attempted');
    artifact = await (dependencies.inspectPackage ?? inspectPackage)(join(checkout, 'companion-module', 'pkg', archiveName));
    if (artifact.info.version !== module.version || artifact.info.commit !== startingCommit || artifact.info.dirty !== false) {
      throw new Error('Built package does not identify the tested clean revision; no deployment attempted');
    }
    if (!/^[0-9a-f]{64}$/.test(artifact.archiveSha256 ?? '')) throw new Error('Built package checksum is unavailable; no deployment attempted');
  } finally {
    // This directory was created by this invocation. Cleanup also removes its private
    // secrets copy on success and failure; the linked verification runtime is not followed.
    await rm(isolation, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  if (await cleanCommit(repo, run) !== startingCommit) throw new Error('Caller checkout changed during release preparation; no deployment attempted');
  const packagePath = join(repo, 'companion-module', 'pkg', archiveName);
  await mkdir(dirname(packagePath), { recursive: true });
  await writeArtifact(packagePath, artifact.bytes);
  const checksumFile = `${packagePath}.sha256`;
  await writeArtifact(checksumFile, `${artifact.archiveSha256}  ${basename(packagePath)}\n`);
  const result = await (dependencies.deploy ?? runDeployment)({
    ...validated, packagePath, expectedCommit: startingCommit, expectedArchiveSha256: artifact.archiveSha256,
  });
  return { ...result, verifiedCommit: startingCommit, checksumFile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseReleaseArgs(process.argv.slice(2));
    console.log(JSON.stringify(await releaseModule(parsed), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Module release failed');
    process.exitCode = 1;
  }
}
