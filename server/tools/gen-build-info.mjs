// Stamp the built files, never infer their revision from a checkout at request time.
// Optional output directory is relative to the caller; default is server/dist.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = await realpath(join(server, '..'));
const out = process.argv[2] ? resolve(process.argv[2]) : join(server, 'dist');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let commit = null;
let dirty = null;
try {
  // Archives nested inside another checkout do not belong to that checkout's revision.
  if (await realpath(git('rev-parse', '--show-toplevel')) === repo) {
    commit = git('rev-parse', 'HEAD');
    dirty = git('status', '--porcelain').length > 0;
  }
} catch { /* Source archives honestly have no Git provenance. */ }
const { version } = JSON.parse(await readFile(join(server, 'package.json'), 'utf8'));
const metadata = { version, commit, dirty, builtAt: new Date().toISOString() };
await mkdir(out, { recursive: true });
const file = join(out, 'build-info.json');
const temp = `${file}.${process.pid}.tmp`;
await writeFile(temp, JSON.stringify(metadata, null, 2) + '\n');
await rename(temp, file);
console.log(`build identity: ${commit ?? 'unknown revision'}${dirty === true ? ' (modified checkout)' : ''}`);
