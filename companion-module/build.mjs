// Bundles the module the way Companion modules actually ship: ONE CommonJS main.js with
// @companion-module/base inlined, no node_modules alongside it. Verified against the store
// module that loads on this host - generic-websocket 2.3.1 is exactly that shape, with an
// empty `dependencies` and a bundled base.
//
// Output goes to dist/, which is also the staging root for the sideload .tgz:
//   dist/companion/manifest.json
//   dist/main.js
//   dist/package.json
import { build } from 'esbuild'
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'

mkdirSync('dist/companion', { recursive: true })

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/main.js',
  // The host talks to the module over an IPC channel it owns; these are its, not ours.
  external: ['electron'],
  logLevel: 'info',
})

copyFileSync('companion/manifest.json', 'dist/companion/manifest.json')

// The sideloaded package.json carries no dependencies, because everything is in the bundle.
// `type` must be commonjs to match the bundle format, or node refuses the entrypoint.
const manifest = JSON.parse(readFileSync('companion/manifest.json', 'utf8'))
writeFileSync(
  'dist/package.json',
  JSON.stringify(
    { name: 'companion-module-' + manifest.id, version: manifest.version, type: 'commonjs', main: 'main.js' },
    null,
    2,
  ) + '\n',
)
console.log('bundled -> dist/')
