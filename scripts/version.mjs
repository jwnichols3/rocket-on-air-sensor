#!/usr/bin/env node
// Root package.json is the product version. Keep the static About metadata in sync.
import { readFile, writeFile, rename, stat, rm, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_PACKAGES = ['package.json', 'server/package.json', 'admin-ui/package.json'];
const PLUGIN = 'deploy/swiftbar/onair.5s.sh';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_FIELD = /^# <xbar\.version>([^<\r\n]+)<\/xbar\.version>\r?$/gm;

function parseVersion(value) {
  const match = typeof value === 'string' && STABLE_VERSION.exec(value);
  if (!match || match.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error(`Expected a stable MAJOR.MINOR.PATCH version, got ${JSON.stringify(value)}`);
  }
  return match.slice(1).map(Number);
}

async function load(root) {
  const paths = [...PRODUCT_PACKAGES, 'companion-module/package.json', 'package-lock.json'];
  const docs = Object.fromEntries(await Promise.all(paths.map(async (path) =>
    [path, JSON.parse(await readFile(join(root, path), 'utf8'))])));
  const plugin = await readFile(join(root, PLUGIN), 'utf8');
  const fields = [...plugin.matchAll(VERSION_FIELD)];
  const allFields = [...plugin.matchAll(/<xbar\.version>/g)];
  if (fields.length !== 1 || allFields.length !== 1) {
    throw new Error(`${PLUGIN} must contain exactly one '# <xbar.version>vVERSION</xbar.version>' field`);
  }
  for (const path of ['package.json', 'companion-module/package.json']) parseVersion(docs[path].version);
  const lock = docs['package-lock.json'];
  for (const path of ['', 'server', 'admin-ui', 'companion-module']) {
    if (!lock.packages?.[path] || typeof lock.packages[path] !== 'object') {
      throw new Error(`package-lock.json is missing packages[${JSON.stringify(path)}]`);
    }
  }
  return { docs, plugin, pluginVersion: fields[0][1] };
}

export async function checkVersions(root) {
  const { docs, pluginVersion } = await load(root);
  const version = docs['package.json'].version;
  const expected = [
    ...PRODUCT_PACKAGES.map((path) => [path, docs[path].version, version]),
    ['package-lock.json version', docs['package-lock.json'].version, version],
    ...['', 'server', 'admin-ui'].map((path) =>
      [`package-lock.json packages[${JSON.stringify(path)}]`, docs['package-lock.json'].packages[path].version, version]),
    ['package-lock.json packages["companion-module"]', docs['package-lock.json'].packages['companion-module'].version,
      docs['companion-module/package.json'].version],
    [PLUGIN, pluginVersion, `v${version}`],
  ];
  const errors = expected.filter(([, actual, wanted]) => actual !== wanted)
    .map(([path, actual, wanted]) => `${path}: expected ${wanted}, got ${JSON.stringify(actual)}`);
  if (errors.length) throw new Error(`Version drift:\n${errors.join('\n')}`);
  return version;
}

export async function setVersion(root, requested) {
  const { docs, plugin } = await load(root);
  const current = parseVersion(docs['package.json'].version);
  let next;
  if (['major', 'minor', 'patch'].includes(requested)) {
    const part = ['major', 'minor', 'patch'].indexOf(requested);
    next = current.map((n, i) => i < part ? n : i === part ? n + 1 : 0).join('.');
  } else next = requested;
  const parsed = parseVersion(next);
  const firstDifference = parsed.findIndex((n, i) => n !== current[i]);
  if (firstDifference !== -1 && parsed[firstDifference] < current[firstDifference]) {
    throw new Error('Version updates cannot go backwards; revert the release commit to undo a bump.');
  }
  for (const path of PRODUCT_PACKAGES) docs[path].version = next;
  const lock = docs['package-lock.json'];
  lock.version = next;
  for (const path of ['', 'server', 'admin-ui']) lock.packages[path].version = next;
  // Companion has an independent version, but its lock entry must describe its manifest.
  lock.packages['companion-module'].version = docs['companion-module/package.json'].version;
  const writes = [
    ...[...PRODUCT_PACKAGES, 'package-lock.json'].map((path) => [path, JSON.stringify(docs[path], null, 2) + '\n']),
    [PLUGIN, plugin.replace(VERSION_FIELD, `# <xbar.version>v${next}</xbar.version>`)],
  ];
  // All shape/version validation is complete before touching any file. Writes are local
  // source edits only; this command never builds, commits, tags, or contacts GitHub.
  for (const [path, content] of writes) {
    const target = join(root, path);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const mode = (await stat(target)).mode & 0o777;
      await writeFile(temp, content, { mode });
      await chmod(temp, mode); // Preserve executable bits even with a restrictive umask.
      await rename(temp, target);
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  await checkVersions(root);
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [command, value, ...rest] = process.argv.slice(2);
  try {
    if (rest.length || !['check', 'set'].includes(command) || (command === 'check' ? value !== undefined : value === undefined)) {
      throw new Error('Usage: node scripts/version.mjs check | set <patch|minor|major|MAJOR.MINOR.PATCH>');
    }
    const version = command === 'check' ? await checkVersions(root) : await setVersion(root, value);
    console.log(`${command === 'check' ? 'Product version consistent' : 'Product version updated'}: ${version} (SwiftBar v${version})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
