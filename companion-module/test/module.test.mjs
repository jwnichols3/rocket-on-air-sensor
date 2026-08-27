// Tests for the on-air Companion module (#44).
//
// The module class is exercised DIRECTLY, with the small part of the Companion host surface
// it touches stubbed out. That is deliberate: `@companion-module/base`'s runEntrypoint wants
// an IPC channel to a running Companion, so importing src/index.js as a module would try to
// start one. Instead the class is loaded with the entrypoint call neutralised, and the host
// callbacks are recorded.
//
// What this covers that the live install cannot cover repeatably: preset regeneration when
// tableVersion moves, which on the real server would mean editing Rocket's live state table
// for the sake of a test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { startFakeServer } from './fake-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// Load the module source with runEntrypoint stubbed, and hand back the class.
//
// Written to a real file inside the package rather than imported as a data: URL, because a
// data: URL cannot resolve the bare specifier `@companion-module/base`. The file is
// generated, gitignored, and identical to src/index.js apart from the entrypoint line - so
// the tests exercise the shipped source, not a copy of it.
let cached
async function loadInstanceClass() {
	if (cached) return cached
	const src = readFileSync(join(HERE, '..', 'src', 'index.js'), 'utf8')
	const patched = src.replace(
		/runEntrypoint\(OnAirInstance, \[\]\)/,
		'export { OnAirInstance }',
	)
	if (!patched.includes('export { OnAirInstance }')) {
		throw new Error('the entrypoint line moved - this loader needs updating')
	}
	const generated = join(HERE, '.instance.generated.mjs')
	writeFileSync(generated, patched)
	const mod = await import(pathToFileURL(generated).href)
	cached = mod.OnAirInstance
	return cached
}

/// Records every host callback the module makes, so assertions are about what Companion
/// would have been told rather than about the module's own internals.
function makeInstance(OnAir, port, passphrase) {
	// NOT `new OnAir(...)`. InstanceBase's constructor rejects manual construction and then
	// builds an IpcWrapper, which wants a live channel to a running Companion. Object.create
	// gives an object on the real prototype chain without running that constructor, so the
	// module's OWN methods are the ones under test - which is the point. Everything the module
	// calls on the host is stubbed below as an own property.
	const inst = Object.create(OnAir.prototype)
	const seen = { presets: {}, actions: {}, feedbacks: {}, variables: {}, status: [], logs: [] }

	inst.setPresetDefinitions = (p) => (seen.presets = p)
	inst.setActionDefinitions = (a) => (seen.actions = a)
	inst.setFeedbackDefinitions = (f) => (seen.feedbacks = f)
	inst.setVariableDefinitions = () => {}
	inst.setVariableValues = (v) => Object.assign(seen.variables, v)
	inst.updateStatus = (s, m) => seen.status.push([s, m])
	inst.log = (level, msg) => seen.logs.push(`${level}: ${msg}`)
	inst.checkFeedbacks = () => {}
	inst.parseVariablesInString = async (s) => s

	return { inst, seen, config: { host: '127.0.0.1', port: String(port), passphrase } }
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

test('generates one preset per row, from the server table', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.deepEqual(Object.keys(seen.presets).sort(), ['refresh', 'state_available', 'state_on-air'])

	// The caption is `label`. There is no `row.text` - looking for one returns undefined, which
	// is exactly the mistake the ticket warns about.
	assert.equal(seen.presets['state_on-air'].style.text, 'ON AIR')
	// Colours copy across verbatim (D-31, D-42). #c1121f -> packed.
	assert.equal(seen.presets['state_on-air'].style.bgcolor, 0xc1121f)
	assert.equal(seen.presets['state_on-air'].style.color, 0xffffff)

	await inst.destroy()
	await fake.close()
})

test('preset ids are stable across a table edit, and index never appears', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	const before = Object.keys(seen.presets).sort()

	// Reorder the rows and rename a label. A placed button holds the preset's id forever
	// (5.0.x copies the preset), so an id keyed on anything but the immutable row id would
	// break every button on the deck.
	fake.editTable([
		{ id: 'on-air', label: 'LIVE NOW', color: '#ffffff', bgcolor: '#c1121f', busy: true, order: 0 },
		{ id: 'available', label: 'FREE', color: '#ffffff', bgcolor: '#0b6e2e', busy: false, order: 1 },
	])
	await settle(600)

	assert.deepEqual(Object.keys(seen.presets).sort(), before, 'ids must not move when rows do')
	assert.equal(seen.presets['state_on-air'].style.text, 'LIVE NOW', 'but the caption follows the table')

	for (const [id, preset] of Object.entries(seen.presets)) {
		const wire = JSON.stringify(preset)
		assert.ok(!/"index"/.test(wire), `${id} must not carry an index (D-34)`)
	}

	await inst.destroy()
	await fake.close()
})

test('presets regenerate when tableVersion moves, with no restart', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	assert.equal(Object.keys(seen.presets).length, 3)

	// A row the server adds later must arrive on its own - this is the whole point of
	// generating presets rather than hand-listing them.
	fake.editTable([
		{ id: 'available', label: 'AVAILABLE', color: '#ffffff', bgcolor: '#0b6e2e', busy: false, order: 0 },
		{ id: 'on-air', label: 'ON AIR', color: '#ffffff', bgcolor: '#c1121f', busy: true, order: 1 },
		{ id: 'recording', label: 'RECORDING', color: '#ffffff', bgcolor: '#6a0dad', busy: true, order: 2 },
	])
	await settle(600)

	assert.ok(seen.presets['state_recording'], 'the new row should have generated a preset')
	assert.equal(seen.presets['state_recording'].style.bgcolor, 0x6a0dad)
	assert.equal(seen.variables.table_version, fake.version)

	await inst.destroy()
	await fake.close()
})

test('the action sets state by row id, and tags itself as companion', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	await seen.actions.set_state.callback({ options: { state: 'on-air' } })
	await settle(200)

	assert.deepEqual(fake.writes.at(-1), { id: 'on-air', source: 'companion' })
	assert.equal(seen.variables.state, 'on-air', 'and the stream carries the change back')
	assert.equal(seen.variables.busy, 'yes')

	await inst.destroy()
	await fake.close()
})

test('a button bound to a row the server no longer has surfaces validStates', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	await seen.actions.set_state.callback({ options: { state: 'deleted-row' } })
	await settle(200)

	const complaint = seen.logs.find((l) => l.includes('deleted-row'))
	assert.ok(complaint, 'it must complain at all rather than fail silently')
	assert.match(complaint, /unknown state 'deleted-row'/)
	assert.match(complaint, /valid states: available, on-air/, 'and say what would have worked')

	await inst.destroy()
	await fake.close()
})

test('feedback follows the live state', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal(seen.feedbacks.state_is.callback({ options: { state: 'available' } }), true)
	assert.equal(seen.feedbacks.state_is.callback({ options: { state: 'on-air' } }), false)
	assert.equal(seen.feedbacks.busy.callback({}), false)

	await seen.actions.set_state.callback({ options: { state: 'on-air' } })
	await settle(200)

	assert.equal(seen.feedbacks.state_is.callback({ options: { state: 'on-air' } }), true)
	assert.equal(seen.feedbacks.busy.callback({}), true, 'busy is the server\'s flag, not a colour test')

	await inst.destroy()
	await fake.close()
})

// ---------------------------------------------------------------------------------------
// THE CLIENT CONTRACT (D-91/D-92). The module judges its own connection now; `stale` is gone
// from the server and from here. The tests wind `lastContactAt` back rather than waiting out
// a real threshold - the clock is the module's own, which is the entire point.

test('condition 1 - the server is answering: the state is reported plainly', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal(seen.variables.connection, 'ok')
	assert.equal(seen.variables.state, 'available')
	assert.equal(seen.feedbacks.connection_lost.callback({}), false)
	assert.equal(seen.feedbacks.no_data.callback({}), false)

	await inst.destroy()
	await fake.close()
})

test('an OLD WRITE on a live connection is still the state - the D-91 headline', async () => {
	// A state nobody has rewritten for two hours, on a server that is answering, is simply
	// the state. This is the case that used to read as stale everywhere in the system.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	inst.current = { ...inst.current, ageSeconds: 7200 }
	inst.publishVariables()

	assert.equal(seen.variables.connection, 'ok', 'ageSeconds is provenance and decides nothing')
	assert.equal(seen.variables.state, 'available')
	assert.equal(seen.feedbacks.no_data.callback({}), false)

	await inst.destroy()
	await fake.close()
})

test('condition 2 - contact lost: the last known state is HELD, and says so', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	inst.lastContactAt = Date.now() - 61_000
	inst.publishVariables()

	assert.equal(seen.variables.state, 'available', 'it does not go blank')
	assert.equal(seen.variables.connection, 'not refreshing')
	assert.equal(seen.feedbacks.connection_lost.callback({}), true)
	assert.equal(seen.feedbacks.no_data.callback({}), false, 'it does not give up 29 minutes early')
	assert.equal(seen.feedbacks.state_is.callback({ options: { state: 'available' } }), true)

	await inst.destroy()
	await fake.close()
})

test('condition 3 - thirty minutes: the state is given up, and lands BUSY not calm', async () => {
	// The reserved row carries busy: true (D-34). A stream deck going dark because the server
	// died is a false OFF on a physical control, which is the failure this product prevents.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	inst.lastContactAt = Date.now() - 1_801_000
	inst.publishVariables()

	assert.equal(seen.variables.state, 'unknown')
	assert.equal(seen.variables.label, 'NO DATA')
	assert.equal(seen.variables.busy, 'yes', 'the degenerate path is conspicuous, never calm')
	assert.equal(seen.variables.connection, 'no data')
	assert.equal(seen.feedbacks.no_data.callback({}), true)
	assert.equal(seen.feedbacks.busy.callback({}), true)
	assert.equal(seen.feedbacks.state_is.callback({ options: { state: 'available' } }), false,
		'it must stop claiming the row it can no longer confirm')

	await inst.destroy()
	await fake.close()
})

test('the two thresholds are CONFIGURATION, and are not chained', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, lost_ms: '5000', no_data_ms: '20000' })
	await settle()

	inst.lastContactAt = Date.now() - 6_000
	inst.publishVariables()
	assert.equal(seen.variables.connection, 'not refreshing', 'a 5s window marks at 6s')

	inst.lastContactAt = Date.now() - 19_000
	inst.publishVariables()
	assert.equal(seen.variables.connection, 'not refreshing', '19s is still condition 2')

	inst.lastContactAt = Date.now() - 21_000
	inst.publishVariables()
	assert.equal(seen.variables.connection, 'no data')

	await inst.destroy()
	await fake.close()
})

test('BREAKING: `stale` is gone from the variables and the feedbacks, with no alias', async () => {
	// Not renamed and not aliased. A variable that silently resolves to nothing on a stream
	// deck is worse than one that is loudly absent, and an alias beside the real thing is a
	// decoy the next layout keys on (D-83).
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal('stale' in seen.variables, false)
	assert.equal('stale' in seen.feedbacks, false)
	assert.equal(inst.buildVariables().some((v) => v.variableId === 'stale'), false)
	assert.equal(seen.variables.connection !== undefined, true, 'and it is replaced, not just removed')

	await inst.destroy()
	await fake.close()
})

test('a wrong passphrase is reported as an auth failure, not a generic error', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer({ passphrase: 'the-right-one' })
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'the-wrong-one')

	await inst.init(config)
	await settle(300)

	assert.ok(
		seen.status.some(([s]) => String(s).toLowerCase().includes('auth')),
		`expected an authentication failure, got ${JSON.stringify(seen.status)}`,
	)

	await inst.destroy()
	await fake.close()
})

test('no passphrase is a config problem, and nothing is attempted', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, '')

	await inst.init(config)
	await settle(200)

	assert.ok(seen.status.some(([, m]) => /passphrase required/.test(String(m))))
	assert.equal(fake.writes.length, 0)

	await inst.destroy()
	await fake.close()
})
