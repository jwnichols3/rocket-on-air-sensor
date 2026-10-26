import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CompanionRpc, readControls, targetOrigin } from '../lib/companion-rpc.mjs';
import { inspectPackage } from '../lib/companion-package.mjs';
import { parseArgs, runDeployment } from '../companion-deploy.mjs';

const OLD_COMMIT = '1'.repeat(40), NEW_COMMIT = '2'.repeat(40);
async function artifact(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'onair-deploy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const module = join(dir, 'rocket-onair');
  await mkdir(join(module, 'companion'), { recursive: true });
  const code = 'export default class Module {}\n';
  const info = { version: '0.8.0', commit: NEW_COMMIT, dirty: false, builtAt: '2026-10-25T00:00:00Z',
    bundleSha256: createHash('sha256').update(code).digest('hex'), ...overrides };
  await writeFile(join(module, 'main.js'), code);
  await writeFile(join(module, 'package.json'), JSON.stringify({ version: '0.8.0', type: 'module' }));
  await writeFile(join(module, 'companion/manifest.json'), JSON.stringify({ id: 'rocket-onair', version: '0.8.0', type: 'connection' }));
  await writeFile(join(module, 'build-info.json'), JSON.stringify(info));
  const path = join(dir, 'module.tgz');
  execFileSync('tar', ['-czf', path, '-C', dir, 'rocket-onair'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return { dir, path };
}

// A protocol-level fake Companion, with plain JSON tRPC responses and real subscription
// start/data/stop envelopes. No live server or project configuration is used by these tests.
class FakeCompanion {
  constructor(options = {}) {
    this.options = options; this.calls = []; this.versions = ['0.7.3'];
    this.connection = { id: 'conn-a', label: 'On_Air', moduleId: 'rocket-onair', moduleVersionId: '0.7.3', enabled: true,
      updatePolicy: 'stable', collectionId: null, sortOrder: 0, ...options.connection };
    this.closed = 0; this.time = 0;
  }
  dependencies() {
    const server = this;
    class Socket extends EventTarget {
      constructor() { super(); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
      send(data) {
        const message = JSON.parse(data); server.calls.push(message);
        if (message.method === 'subscription.stop') return;
        queueMicrotask(() => {
          try {
            const data = server.handle(message);
            if (data === FakeCompanion.SILENT) return;
            if (message.method === 'subscription') this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result: { type: 'started' } }) }));
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result: { type: 'data', data } }) }));
          } catch {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, error: { message: 'secret-error-detail', data: { code: 'FORBIDDEN' } } }) }));
          }
        });
      }
      close() { this.readyState = 3; server.closed++; this.dispatchEvent(new Event('close')); }
    }
    return { connect: (target, options) => CompanionRpc.connect(target, { ...options, WebSocketClass: Socket }),
      now: () => server.time, sleep: async (ms) => { server.time += ms; } };
  }
  handle({ method, params: { path, input } }) {
    if (this.options.denied) throw Error('denied');
    const fresh = this.connection.moduleVersionId === '0.8.0';
    switch (path) {
      case 'appInfo.version': return { appVersion: this.options.hostVersion ?? '5.1.1', customModuleImportAllowed: this.options.importAllowed !== false };
      case 'instances.connections.watch': return [{ type: 'init', info: { 'conn-a': this.connection, unrelated: { secret: 'other-connection-secret' } } }];
      case 'instances.statuses.watch': return { type: 'init', statuses: { 'conn-a': { level: 'ok', category: 'good', message: 'sensitive-status-detail' } } };
      case 'variables.values.connection':
        assert.deepEqual(input, { label: 'On_Air' });
        return { module_version: this.connection.moduleVersionId, module_commit: fresh ? (this.options.badIdentity ? '3'.repeat(40) : NEW_COMMIT) : OLD_COMMIT,
          connection: 'ok', passphrase: 'never-output-this-secret' };
      case 'instances.modules.watch': return { type: 'init', info: { 'connection:rocket-onair': { installedVersions: this.versions.map(versionId => ({ versionId })) } } };
      case 'pages.watch': return { type: 'init', order: ['page-a'], pages: { 'page-a': { controls: { 2: { 1: 'bank:a', 2: 'bank:b' } } } } };
      case 'controls.watchControl': return { type: 'init', config: { type: 'button-layered', steps: [{ connectionId: 'conn-a', id: input.controlId }] }, runtime: {} };
      case 'instances.modulesManager.installModuleTar':
        assert.equal(method, 'mutation'); assert.equal(Buffer.from(input.tarBuffer, 'base64')[0], 0x1f);
        this.versions.push('0.8.0'); return null;
      case 'instances.connections.setModuleAndVersion':
        assert.equal(method, 'mutation'); assert.deepEqual(Object.keys(input).sort(), ['connectionId', 'moduleId', 'versionId']);
        assert.equal(input.connectionId, 'conn-a'); assert.equal(input.moduleId, 'rocket-onair');
        this.connection = { ...this.connection, moduleVersionId: input.versionId };
        return null;
      default: throw Error(`Unexpected endpoint ${path}`);
    }
  }
}
FakeCompanion.SILENT = Symbol('silent');
const options = (command, fixture, rest = {}) => ({ command, target: 'http://companion.invalid:8000', connectionId: 'conn-a',
  packagePath: command === 'deploy' ? fixture.path : undefined, backupDir: join(fixture.dir, 'receipts'), timeoutMs: 1000, controls: ['1/2/1', '1/2/2'], ...rest });

test('CLI requires explicit target/connection and rejects credential-bearing URLs and irrelevant commands', () => {
  assert.throws(() => parseArgs(['deploy']), /explicit|origin/i);
  assert.throws(() => parseArgs(['inspect', '--target', 'http://localhost:8000']), /connection/);
  assert.throws(() => targetOrigin('http://user:secret@host:8000'), /credentials/);
  assert.throws(() => targetOrigin('http://host:8000/?token=secret'), /credentials/);
  assert.throws(() => parseArgs(['press', '--target', 'http://localhost:8000', '--connection', 'x']), /Usage/);
  assert.equal(parseArgs(['inspect', '--target', 'http://localhost:8000', '--connection', 'x']).command, 'inspect');
});

test('inspect is read-only, snapshots only requested controls privately, and prints no secrets', async (t) => {
  const f = await artifact(t), server = new FakeCompanion();
  const result = await runDeployment(options('inspect', f), server.dependencies());
  assert.equal(server.calls.some(c => c.method === 'mutation'), false);
  assert(server.calls.some(c => c.method === 'subscription.stop'), 'one-shot subscriptions must be stopped');
  assert.equal(result.controlCount, 2); assert.equal(server.closed, 1);
  assert.equal((await stat(result.backupFile)).mode & 0o777, 0o600);
  const backup = JSON.parse(await readFile(result.backupFile, 'utf8'));
  assert.deepEqual(backup.controls.map(c => c.controlId), ['bank:a', 'bank:b']);
  const serialized = JSON.stringify(result) + await readFile(result.receiptFile, 'utf8') + JSON.stringify(backup);
  for (const secret of ['never-output-this-secret', 'other-connection-secret', 'sensitive-status-detail']) assert.equal(serialized.includes(secret), false);
});

test('deploy imports, activates and verifies identity without rewriting connection options or controls', async (t) => {
  const f = await artifact(t), server = new FakeCompanion(); const before = { ...server.connection };
  const result = await runDeployment(options('deploy', f), server.dependencies());
  assert.equal(result.result, 'deployed'); assert.equal(result.commit, NEW_COMMIT);
  assert.deepEqual(server.calls.filter(c => c.method === 'mutation').map(c => c.params.path), [
    'instances.modulesManager.installModuleTar', 'instances.connections.setModuleAndVersion',
  ]);
  assert.deepEqual(server.connection, { ...before, moduleVersionId: '0.8.0' });
  assert(server.versions.includes('0.7.3'), 'rollback version remains installed');
});

test('bad running identity automatically restores the previous version and records failure', async (t) => {
  const f = await artifact(t), server = new FakeCompanion({ badIdentity: true });
  await assert.rejects(runDeployment(options('deploy', f), server.dependencies()), /Previous version restored/);
  assert.equal(server.connection.moduleVersionId, '0.7.3');
  assert.deepEqual(server.calls.filter(c => c.params?.path === 'instances.connections.setModuleAndVersion').map(c => c.params.input.versionId), ['0.8.0', '0.7.3']);
});

test('an explicit rollback uses only a matching private backup and preserves imported versions', async (t) => {
  const f = await artifact(t), server = new FakeCompanion();
  const deployed = await runDeployment(options('deploy', f), server.dependencies());
  const result = await runDeployment(options('rollback', f, { backupPath: deployed.backupFile }), server.dependencies());
  assert.equal(result.result, 'rolled-back'); assert.equal(server.connection.moduleVersionId, '0.7.3');
  assert(server.versions.includes('0.8.0'));
  await assert.rejects(runDeployment(options('rollback', f, { backupPath: deployed.backupFile, target: 'http://another.invalid:8000' }), server.dependencies()), /does not match/);
});

test('unsupported host, wrong module and missing import permission fail before any mutation', async (t) => {
  const f = await artifact(t);
  for (const config of [{ hostVersion: '5.2.0' }, { connection: { moduleId: 'other-module' } }, { importAllowed: false }]) {
    const server = new FakeCompanion(config);
    await assert.rejects(runDeployment(options('deploy', f), server.dependencies()));
    assert.equal(server.calls.some(c => c.method === 'mutation'), false);
  }
});

test('dirty or tampered packages fail locally before connecting to Companion', async (t) => {
  const dirty = await artifact(t, { dirty: true });
  await assert.rejects(inspectPackage(dirty.path), /clean committed/);
  const bad = await artifact(t, { bundleSha256: '0'.repeat(64) });
  let contacted = false;
  await assert.rejects(runDeployment(options('deploy', bad), { connect: async () => { contacted = true; } }), /SHA-256/);
  assert.equal(contacted, false);
});

test('RPC timeouts stop subscriptions and errors do not expose remote messages', async () => {
  const server = new FakeCompanion(); server.handle = () => FakeCompanion.SILENT;
  const rpc = await server.dependencies().connect('http://companion.invalid:8000', { timeoutMs: 50 });
  try { await assert.rejects(rpc.first('pages.watch'), /timed out/); } finally { rpc.close(); }
  assert(server.calls.some(c => c.method === 'subscription.stop'));
  const denied = new FakeCompanion({ denied: true });
  const rpc2 = await denied.dependencies().connect('http://companion.invalid:8000', {});
  try { await assert.rejects(rpc2.query('appInfo.version'), e => /FORBIDDEN/.test(e.message) && !e.message.includes('secret-error-detail')); }
  finally { rpc2.close(); }
});

test('already active identity is a no-op, but an unverified duplicate version is refused', async (t) => {
  const f = await artifact(t), server = new FakeCompanion();
  server.versions.push('0.8.0'); server.connection.moduleVersionId = '0.8.0';
  const active = await runDeployment(options('deploy', f), server.dependencies());
  assert.equal(active.result, 'already-active');
  assert.equal(server.calls.some(c => c.method === 'mutation'), false);
  server.connection.moduleVersionId = '0.7.3';
  await assert.rejects(runDeployment(options('deploy', f), server.dependencies()), /already installed/);
});

test('failed activation never overwrites another operator changing the module', async (t) => {
  const f = await artifact(t), server = new FakeCompanion({ badIdentity: true });
  const handle = server.handle.bind(server);
  server.handle = (message) => {
    const result = handle(message);
    if (message.params.path === 'instances.connections.setModuleAndVersion' && message.params.input.versionId === '0.8.0') {
      server.connection.moduleId = 'another-module';
    }
    return result;
  };
  await assert.rejects(runDeployment(options('deploy', f), server.dependencies()), /manual verification/);
  assert.equal(server.connection.moduleId, 'another-module');
  assert.equal(server.calls.filter(c => c.params?.path === 'instances.connections.setModuleAndVersion').length, 1);
});

test('malformed rollback data does not echo private contents or contact Companion', async (t) => {
  const f = await artifact(t), file = join(f.dir, 'broken.json');
  await writeFile(file, 'private-credential-data is not JSON');
  let called = false;
  await assert.rejects(runDeployment(options('rollback', f, { backupPath: file }), {
    connect: async () => { called = true; },
  }), error => /invalid JSON/.test(error.message) && !error.message.includes('private-credential-data'));
  assert.equal(called, false);
});

test('source release pins commit and archive bytes before any network call', async (t) => {
  const f = await artifact(t);
  for (const mismatch of [{ expectedCommit: 'f'.repeat(40) }, { expectedArchiveSha256: 'f'.repeat(64) }]) {
    let contacted = false;
    await assert.rejects(runDeployment(options('deploy', f, mismatch), {
      connect: async () => { contacted = true; },
    }), /changed after source verification/);
    assert.equal(contacted, false);
  }
});
