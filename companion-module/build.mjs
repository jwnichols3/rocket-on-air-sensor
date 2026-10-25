// Build the self-contained CommonJS module and stamp the identity into its running code.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const here = resolve(import.meta.dirname)
const repo = realpathSync(join(here, '..'))
const dist = join(here, 'dist')
const manifest = JSON.parse(readFileSync(join(here, 'companion/manifest.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
if (manifest.version !== pkg.version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
  throw new Error('Module manifest and package versions must match a stable MAJOR.MINOR.PATCH version')
}
let commit = null
let dirty = null
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
try {
  // A source archive nested in another repository does not inherit that repository's identity.
  if (realpathSync(git('rev-parse', '--show-toplevel')) === repo) {
    commit = git('rev-parse', 'HEAD')
    dirty = git('status', '--porcelain').length > 0
  }
} catch { /* Archives have no commit provenance. */ }
const info = { version: manifest.version, commit, dirty, builtAt: new Date().toISOString() }
mkdirSync(join(dist, 'companion'), { recursive: true })
await build({
  absWorkingDir: here,
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(dist, 'main.js'),
  define: { __ONAIR_MODULE_BUILD__: JSON.stringify(info) },
  external: ['electron'],
  logLevel: 'info',
})
copyFileSync(join(here, 'companion/manifest.json'), join(dist, 'companion/manifest.json'))
writeFileSync(join(dist, 'package.json'), JSON.stringify({
  name: 'companion-module-' + manifest.id, version: manifest.version, type: 'commonjs', main: 'main.js',
}, null, 2) + '\n')
const bundleSha256 = createHash('sha256').update(readFileSync(join(dist, 'main.js'))).digest('hex')
writeFileSync(join(dist, 'build-info.json'), JSON.stringify({ ...info, bundleSha256 }, null, 2) + '\n')
console.log(`bundled module ${info.version}, commit ${commit ?? 'unknown'}${dirty ? ' (modified)' : ''} -> dist/`)
