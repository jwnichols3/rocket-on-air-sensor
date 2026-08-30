// Builds the sideload tarball Companion's "Import custom module" accepts.
//
// This exists because the two things that break the import are invisible and neither of them
// looks like a packaging problem when it bites:
//
//   1. macOS `tar` writes AppleDouble `._*` entries, and the first is `._.` - a name with ONE
//      path component. Companion extracts with `strip: 1` and no ignore filter, so that strips
//      to an empty name and the install dies with EISDIR pointing at the module directory.
//      COPYFILE_DISABLE=1 suppresses them.
//   2. Companion finds the manifest by treating the first DIRECTORY entry as the prefix to
//      trim. A tarball with no directory entries, or one rooted at `.`, never matches
//      `companion/manifest.json` and is rejected as "Doesn't look like a valid module" - which
//      reads like a manifest fault and is not one.
//
// Both were measured, not guessed. Doing this by hand is how they come back.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const here = resolve(import.meta.dirname)
const dist = join(here, 'dist')

if (!existsSync(join(dist, 'main.js')) || !existsSync(join(dist, 'companion', 'manifest.json'))) {
	console.error('dist/ is not built. Run: npm run build --workspace companion-module')
	process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(dist, 'companion', 'manifest.json'), 'utf8'))
const name = manifest.id
const out = join(here, 'pkg', `${name}-${manifest.version}.tgz`)

// The staging root is named after the module id, so the tarball's single top-level directory
// entry is a real name - see (2) above.
const stage = mkdtempSync(join(tmpdir(), 'onair-stage-'))
try {
	cpSync(dist, join(stage, name), { recursive: true })
	mkdirSync(join(here, 'pkg'), { recursive: true })
	rmSync(out, { force: true })
	execFileSync('tar', ['-czf', out, '-C', stage, name], {
		stdio: 'inherit',
		env: { ...process.env, COPYFILE_DISABLE: '1' },
	})
} finally {
	rmSync(stage, { recursive: true, force: true })
}

// Prove the two properties rather than trusting them. A tarball that fails either of these
// is rejected by Companion with a message that points somewhere else entirely.
const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split('\n').filter(Boolean)
const appleDouble = listing.filter((e) => e.split('/').some((seg) => seg.startsWith('._')))
if (appleDouble.length) {
	console.error(`AppleDouble entries survived, the import will fail with EISDIR: ${appleDouble.join(', ')}`)
	process.exit(1)
}
const firstDir = listing.find((e) => e.endsWith('/'))
if (firstDir !== `${name}/`) {
	console.error(`the first directory entry must be "${name}/", got ${firstDir ?? '(none)'}`)
	process.exit(1)
}
if (!listing.includes(`${name}/companion/manifest.json`)) {
	console.error('the manifest is not where Companion looks for it')
	process.exit(1)
}

console.log(`packaged -> ${out}`)
console.log(`  ${listing.length} entries, top-level "${name}/", no AppleDouble, manifest present`)
console.log('  Companion: Modules -> Import custom module -> choose this .tgz')
