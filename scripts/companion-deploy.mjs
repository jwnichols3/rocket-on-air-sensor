#!/usr/bin/env node
// Bounded deploy/rollback for Companion 5.1 admin RPC. No default host or connection.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanionRpc, targetOrigin, readConnection, readRuntime, readControls, parseLocation } from './lib/companion-rpc.mjs';
import { inspectPackage } from './lib/companion-package.mjs';

export const USAGE = `Usage:
  npm run module:deploy -- inspect --target http://companion-host:8000 --connection ID [--control 1/2/1] [--backup-dir DIR]
  npm run module:deploy -- deploy --target http://companion-host:8000 --connection ID --package PATH [--control 1/2/1] [--backup-dir DIR]
  npm run module:deploy -- rollback --target http://companion-host:8000 --connection ID --backup PATH
Optional: --timeout-ms 60000 (1000..300000). Inspect performs no RPC mutations.
Deploy imports a fresh version, activates only the named connection, verifies identity/health,
and restores its previous version if activation fails. Controls are snapshotted, never rewritten.`;

export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['inspect', 'deploy', 'rollback'].includes(command)) throw new Error(USAGE);
  const values = { command, controls: [] };
  const keys = new Map([['--target', 'target'], ['--connection', 'connectionId'], ['--package', 'packagePath'],
    ['--backup', 'backupPath'], ['--backup-dir', 'backupDir'], ['--timeout-ms', 'timeoutMs']]);
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error('Every option requires a value');
    if (flag === '--control') { parseLocation(value); values.controls.push(value); continue; }
    const key = keys.get(flag);
    if (!key || values[key] !== undefined) throw new Error(`Unknown or repeated option: ${flag}`);
    values[key] = value;
  }
  values.target = targetOrigin(values.target);
  if (!values.connectionId?.trim()) throw new Error('An explicit --connection ID is required');
  if (command === 'deploy' && !values.packagePath) throw new Error('Deploy requires --package');
  if (command === 'rollback' && !values.backupPath) throw new Error('Rollback requires --backup');
  if ((command !== 'deploy' && values.packagePath) || (command !== 'rollback' && values.backupPath)) throw new Error('Package and backup options belong to their respective commands');
  values.timeoutMs = values.timeoutMs === undefined ? 60_000 : Number(values.timeoutMs);
  if (!Number.isSafeInteger(values.timeoutMs) || values.timeoutMs < 1000 || values.timeoutMs > 300_000) throw new Error('Timeout must be an integer from 1000 to 300000 ms');
  if (new Set(values.controls).size !== values.controls.length) throw new Error('Control locations must be unique');
  return values;
}

function cleanRuntime(runtime) {
  return {
    level: typeof runtime.status?.level === 'string' && /^[A-Za-z _]+$/.test(runtime.status.level) ? runtime.status.level : null,
    connection: ['ok', 'not refreshing', 'no data'].includes(runtime.values.connection) ? runtime.values.connection : null,
    moduleVersion: /^\d+\.\d+\.\d+$/.test(runtime.values.module_version ?? '') ? runtime.values.module_version : null,
    moduleCommit: /^[0-9a-f]{40}$/.test(runtime.values.module_commit ?? '') ? runtime.values.module_commit : null,
  };
}
function healthy(runtime) { return runtime.status?.level === 'ok' && runtime.values.connection === 'ok'; }
function metadata(connection) {
  const { id, label, moduleId, moduleVersionId, enabled, updatePolicy, collectionId, sortOrder } = connection;
  return { id, label, moduleId, moduleVersionId, enabled, updatePolicy, collectionId, sortOrder };
}
async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
}
async function newJobDirectory(base) {
  const directory = join(base ?? join(homedir(), '.onair', 'companion-deployments'), `${Date.now()}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}
async function installedVersions(rpc) {
  const modules = await rpc.first('instances.modules.watch');
  const versions = modules?.type === 'init' ? modules.info?.['connection:rocket-onair']?.installedVersions : null;
  if (!Array.isArray(versions)) throw new Error('Companion module-version snapshot is unsupported');
  return versions.map((entry) => entry.versionId);
}
async function activate(rpc, connectionId, version) {
  const result = await rpc.mutation('instances.connections.setModuleAndVersion', { connectionId, moduleId: 'rocket-onair', versionId: version });
  if (result !== null) throw new Error('Companion rejected module activation; inspect that connection in the admin UI');
}
async function verifyRunning(rpc, connectionId, expected, timeoutMs, { now, sleep }) {
  const deadline = now() + timeoutMs;
  do {
    const connection = await readConnection(rpc, connectionId);
    const runtime = await readRuntime(rpc, connection);
    if (connection.moduleVersionId === expected.version && connection.enabled && healthy(runtime)
      && (expected.requireIdentity ? runtime.values.module_version === expected.version : !runtime.values.module_version || runtime.values.module_version === expected.version)
      && (!expected.commit || runtime.values.module_commit === expected.commit)) return { connection, runtime };
    await sleep(500);
  } while (now() < deadline);
  throw new Error('Activated module did not report the expected running identity and healthy Receiver connection');
}

export async function runDeployment(options, dependencies = {}) {
  // Validate targeting even for callers using the exported function rather than CLI parsing.
  if (!['inspect', 'deploy', 'rollback'].includes(options.command)) throw new Error('Unsupported deployment command');
  const target = targetOrigin(options.target);
  if (!options.connectionId?.trim()) throw new Error('An explicit connection ID is required');
  if (options.command === 'deploy' && typeof options.packagePath !== 'string') throw new Error('Deploy requires an explicit package path');
  if (options.command === 'rollback' && typeof options.backupPath !== 'string') throw new Error('Rollback requires an explicit backup path');
  const clock = { now: dependencies.now ?? Date.now, sleep: dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))) };
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new Error('Timeout must be an integer from 1000 to 300000 ms');
  if ((options.controls ?? []).length > 64) throw new Error('At most 64 explicitly selected controls can be snapshotted');
  const artifact = options.command === 'deploy' ? await inspectPackage(options.packagePath) : null;
  let prior;
  if (options.command === 'rollback') {
    const raw = await readFile(options.backupPath, 'utf8');
    try { prior = JSON.parse(raw); } catch { throw new Error('Rollback backup is invalid JSON'); }
    if (prior.schema !== 1 || prior.target !== target || prior.connection?.id !== options.connectionId || prior.connection?.moduleId !== 'rocket-onair') {
      throw new Error('Rollback backup does not match this target and connection');
    }
    if (!/^\d+\.\d+\.\d+$/.test(prior.connection.moduleVersionId ?? '')
      || (prior.runtime?.moduleCommit !== null && !/^[0-9a-f]{40}$/.test(prior.runtime?.moduleCommit ?? ''))) throw new Error('Rollback backup has invalid module identity');
  }
  const rpc = await (dependencies.connect ?? CompanionRpc.connect)(target, { timeoutMs: Math.min(timeoutMs, 10_000) });
  let failureReceipt, failureReceiptFile;
  let receiptWritten = false;
  try {
    const app = await rpc.query('appInfo.version');
    if (!/^5\.1\.\d+(?:[+-].*)?$/.test(app?.appVersion ?? '')) throw new Error('This deployment helper supports Companion 5.1.x; review its admin RPC before using another version');
    const connection = await readConnection(rpc, options.connectionId);
    const runtime = await readRuntime(rpc, connection);
    const controls = await readControls(rpc, options.controls ?? []);
    const directory = await newJobDirectory(options.backupDir);
    const backupFile = join(directory, 'before.json'), receiptFile = join(directory, 'receipt.json');
    const backup = { schema: 1, target, capturedAt: new Date(clock.now()).toISOString(), companionVersion: app.appVersion,
      connection: metadata(connection), runtime: cleanRuntime(runtime), controls,
      candidate: artifact ? { version: artifact.info.version, commit: artifact.info.commit, sha256: artifact.archiveSha256 } : null };
    await privateJson(backupFile, backup);
    const receipt = { command: options.command, companionVersion: app.appVersion, moduleId: 'rocket-onair',
      selectedVersion: connection.moduleVersionId, runtime: cleanRuntime(runtime), controlCount: controls.length, backupFile };
    failureReceipt = receipt;
    failureReceiptFile = receiptFile;
    if (options.command === 'inspect') { await privateJson(receiptFile, receipt); return { ...receipt, receiptFile }; }
    if (!connection.enabled) throw new Error('The target connection is disabled; deployment does not change its enabled state');
    const oldVersion = connection.moduleVersionId;
    if (typeof oldVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(oldVersion)) throw new Error('An explicit selected module version is required for safe rollback');
    const versions = await installedVersions(rpc);
    if (!versions.includes(oldVersion)) throw new Error('The currently selected rollback version is not installed');
    const expected = options.command === 'rollback'
      ? { version: prior.connection.moduleVersionId, commit: prior.runtime?.moduleCommit, requireIdentity: !!prior.runtime?.moduleVersion }
      : { version: artifact.info.version, commit: artifact.info.commit, requireIdentity: true };
    if (connection.moduleVersionId === expected.version && healthy(runtime) && (!expected.commit || runtime.values.module_commit === expected.commit)
      && (!expected.requireIdentity || runtime.values.module_version === expected.version)) {
      const done = { ...receipt, result: 'already-active', version: expected.version, commit: expected.commit ?? null };
      await privateJson(receiptFile, done); return { ...done, receiptFile };
    }
    if (options.command === 'rollback' && !versions.includes(expected.version)) throw new Error('The previous module version is no longer installed');
    if (artifact) {
      if (!app.customModuleImportAllowed) throw new Error('Companion does not allow module imports from this client; use an approved local admin session or enable the documented import permission');
      if (versions.includes(expected.version)) throw new Error('That version is already installed but its running build is unverified; inspect it or publish a new version instead of overwriting it');
      const installed = await rpc.mutation('instances.modulesManager.installModuleTar', { tarBuffer: artifact.bytes.toString('base64') }, { timeoutMs });
      if (installed !== null) throw new Error('Companion rejected the module import; check import permission and package details in its admin UI');
      if (!(await installedVersions(rpc)).includes(expected.version)) throw new Error('Imported version did not appear in the module inventory');
    }
    // Recheck immediately before activation, so a concurrent operator edit is not overwritten.
    const current = await readConnection(rpc, options.connectionId);
    if (JSON.stringify(metadata(current)) !== JSON.stringify(metadata(connection))) throw new Error('Connection changed during preparation; activation stopped');
    let activationAttempted = false;
    try {
      activationAttempted = true;
      await activate(rpc, options.connectionId, expected.version);
      const active = await verifyRunning(rpc, options.connectionId, expected, timeoutMs, clock);
      const done = { ...receipt, result: options.command === 'rollback' ? 'rolled-back' : 'deployed',
        version: expected.version, commit: expected.commit ?? null, runtime: cleanRuntime(active.runtime) };
      await privateJson(receiptFile, done); return { ...done, receiptFile };
    } catch (error) {
      let restored = false;
      if (activationAttempted) {
        const current = await readConnection(rpc, options.connectionId).catch(() => null);
        if (current?.moduleVersionId === oldVersion) {
          try {
            await verifyRunning(rpc, options.connectionId, { version: oldVersion, commit: backup.runtime.moduleCommit,
              requireIdentity: !!backup.runtime.moduleVersion }, timeoutMs, clock);
            restored = true;
          } catch { /* A selected but unhealthy previous module is not verified recovery. */ }
        }
        else if (current?.moduleVersionId === expected.version) {
          try {
            await activate(rpc, options.connectionId, oldVersion);
            await verifyRunning(rpc, options.connectionId, { version: oldVersion, commit: backup.runtime.moduleCommit,
              requireIdentity: !!backup.runtime.moduleVersion }, timeoutMs, clock);
            restored = true;
          } catch { /* Receipt directs the operator to the preserved previous version. */ }
        }
      }
      const failed = { ...receipt, result: 'failed', version: expected.version, previousVersionRestored: restored,
        error: error instanceof Error ? error.message : 'Module deployment failed' };
      await privateJson(receiptFile, failed);
      receiptWritten = true;
      throw new Error(`${failed.error}. Previous version ${restored ? 'restored' : 'requires manual verification'}; receipt: ${receiptFile}`);
    }
  } catch (error) {
    if (failureReceiptFile && !receiptWritten) {
      const message = error instanceof Error ? error.message : 'Module deployment failed';
      await privateJson(failureReceiptFile, { ...failureReceipt, result: 'failed', error: message }).catch(() => {});
      throw new Error(`${message}; receipt: ${failureReceiptFile}`);
    }
    throw error;
  } finally { rpc.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runDeployment(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Companion deployment failed'); process.exitCode = 1; }
}
