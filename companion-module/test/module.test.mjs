// Tests for the on-air Companion module (#44, rebuilt for #72-#76).
//
// The module class is exercised DIRECTLY, with the small part of the Companion host surface
// it touches stubbed out. That is deliberate: `@companion-module/base`'s runEntrypoint wants
// an IPC channel to a running Companion, so importing src/index.js as a module would try to
// start one. Instead the class is loaded with the entrypoint call neutralised, and the host
// callbacks are recorded.
//
// What this covers that the live install cannot cover repeatably: preset regeneration when
// tableVersion moves, which on the real server would mean editing Rocket's live state table
// for the sake of a test - and every failure path in #72-#76, which on the real server would
// mean unplugging the panel and killing the daemon mid-meeting.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { InstanceStatus } from '@companion-module/base'
import { startFakeServer } from './fake-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'index.js')

// Load the module source with runEntrypoint stubbed, and hand back the class.
//
// Written to a real file inside the package rather than imported as a data: URL, because a
// data: URL cannot resolve the bare specifier `@companion-module/base`. The file is
// generated, gitignored, and identical to src/index.js apart from the entrypoint line - so
// the tests exercise the shipped source, not a copy of it.
//
// It is written into src/ RATHER THAN test/, so that the source's own relative imports -
// `./icons.js` since #92 - resolve exactly where they do in the shipped module. Written
// beside the tests it resolved them beside the tests, and the whole suite died on a missing
// file that exists.
let cached
async function loadInstanceClass() {
	if (cached) return cached
	const src = readFileSync(SRC, 'utf8')
	const patched = src.replace(
		/runEntrypoint\(OnAirInstance, \[\]\)/,
		'export { OnAirInstance }',
	)
	if (!patched.includes('export { OnAirInstance }')) {
		throw new Error('the entrypoint line moved - this loader needs updating')
	}
	const generated = join(HERE, '..', 'src', '.instance.generated.mjs')
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
	const seen = { presets: {}, actions: {}, feedbacks: {}, variables: {}, status: [], logs: [], repaints: [] }

	inst.setPresetDefinitions = (p) => (seen.presets = p)
	inst.setActionDefinitions = (a) => (seen.actions = a)
	inst.setFeedbackDefinitions = (f) => (seen.feedbacks = f)
	inst.setVariableDefinitions = () => {}
	inst.setVariableValues = (v) => Object.assign(seen.variables, v)
	inst.updateStatus = (s, m) => seen.status.push([s, m])
	inst.log = (level, msg) => seen.logs.push(`${level}: ${msg}`)
	// RECORDED, not swallowed. A no-op stub means every assertion about feedbacks is made by
	// calling the callback by hand - so the code that asks Companion to REDRAW could be
	// deleted entirely and the suite would stay green.
	inst.checkFeedbacks = (...ids) => seen.repaints.push(ids)
	inst.parseVariablesInString = async (s) => s

	return { inst, seen, config: { host: '127.0.0.1', port: String(port), passphrase } }
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

/// The seed rows the fake server ships, including the reserved row the contract guarantees.
const SEED = [
	{ id: 'available', label: 'AVAILABLE', color: '#ffffff', bgcolor: '#0b6e2e', busy: false, order: 0 },
	{ id: 'on-air', label: 'ON AIR', color: '#ffffff', bgcolor: '#c1121f', busy: true, order: 1 },
	{ id: 'unknown', label: 'NO DATA', color: '#ff00ff', bgcolor: '#1a1a1a', busy: true, order: 99 },
]

// #92 doubled the deck: every state row and every panel button now generates a GRAPHIC
// preset and a WORDS one. `light` and `refresh` stay text-only - they are diagnostics, and a
// diagnostic that needs a caption to be understood should have one.
const UTILITY_PRESETS = [
	'light',
	'refresh',
	'panel_sleep',
	'panel_wake',
	'panel_toggle',
	'panel_sleep_words',
	'panel_wake_words',
	'panel_toggle_words',
	// #93. Not per-row - ONE key that walks all of them - so it lives here rather than in
	// `rowPresets`, and it exists whenever the table has any row at all.
	'state_cycle',
	'state_cycle_words',
]

/// Both presets a row generates.
const rowPresets = (id) => [`state_${id}`, `state_${id}_words`]

test('generates one preset per row, from the server table', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.deepEqual(
		Object.keys(seen.presets).sort(),
		[...UTILITY_PRESETS, ...rowPresets('available'), ...rowPresets('on-air'), ...rowPresets('unknown')].sort(),
	)

	// The caption is `label`. There is no `row.text` - looking for one returns undefined, which
	// is exactly the mistake the ticket warns about.
	assert.equal(seen.presets['state_on-air_words'].style.text, 'ON AIR')
	// And the GRAPHIC one carries no caption at all, because the picture is the whole message
	// (#92). A blank caption with no `png64` beside it would be a blank button.
	assert.equal(seen.presets['state_on-air'].style.text, '')
	assert.ok(seen.presets['state_on-air'].style.png64, 'the graphic preset has no art on it')
	// Colours copy across verbatim (D-31, D-42), on the LIT style. #c1121f -> packed.
	const lit = seen.presets['state_on-air'].feedbacks.find((f) => f.feedbackId === 'state_is')
	assert.equal(lit.style.bgcolor, 0xc1121f)
	assert.equal(lit.style.color, 0xffffff)
	// And the button at rest is DIMMER than that, or the feedback changes nothing and a deck
	// of five buttons looks identical whichever row is current.
	assert.notEqual(seen.presets['state_on-air'].style.bgcolor, lit.style.bgcolor)
	assert.ok(seen.presets['state_on-air'].style.bgcolor < lit.style.bgcolor)

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
		{ id: 'unknown', label: 'NO DATA', color: '#ff00ff', bgcolor: '#1a1a1a', busy: true, order: 99 },
	])
	await settle(600)

	assert.deepEqual(Object.keys(seen.presets).sort(), before, 'ids must not move when rows do')
	assert.equal(seen.presets['state_on-air_words'].style.text, 'LIVE NOW', 'but the caption follows the table')

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
	assert.equal(Object.keys(seen.presets).length, 3 * 2 + UTILITY_PRESETS.length)

	// A row the server adds later must arrive on its own - this is the whole point of
	// generating presets rather than hand-listing them.
	fake.editTable([
		...SEED,
		{ id: 'recording', label: 'RECORDING', color: '#ffffff', bgcolor: '#6a0dad', busy: true, order: 2 },
	])
	await settle(600)

	assert.ok(seen.presets['state_recording'], 'the new row should have generated a preset')
	assert.equal(
		seen.presets['state_recording'].feedbacks.find((f) => f.feedbackId === 'state_is').style.bgcolor,
		0x6a0dad,
	)
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
	assert.equal(seen.variables.state, 'on-air', 'and the change comes straight back')
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

test('BREAKING: `stale` is gone from the variables, the feedbacks and the fixture', async () => {
	// Not renamed and not aliased. A variable that silently resolves to nothing on a stream
	// deck is worse than one that is loudly absent, and an alias beside the real thing is a
	// decoy the next layout keys on (D-83). #72 found the last copy of it hiding in the fake
	// server, which is the fixture every other test in this file trusts.
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
	assert.equal('stale' in fake.status(), false, 'the fixture must not carry it either')

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
	// EVERY request, not just writes: `writes` only records POST /state, so a module that
	// happily polled /status without a passphrase would have passed this.
	assert.deepEqual(fake.requests, [], `expected no requests at all, got ${fake.requests.join(', ')}`)

	await inst.destroy()
	await fake.close()
})

// ---------------------------------------------------------------------------------------
// #72 - the poll is the correctness path, the stream is the fast path.

test('#72 a cold read: the state is published from the poll, with no stream at all', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setEventsAvailable(false)
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle(300)

	assert.equal(seen.variables.state, 'available', 'the poll alone must produce a correct state')
	assert.equal(seen.variables.connection, 'ok')
	assert.equal(seen.feedbacks.no_data.callback({}), false)

	await inst.destroy()
	await fake.close()
})

test('#72 the poll keeps the state fresh while the stream is down', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setEventsAvailable(false)
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, poll_ms: '200' })
	await settle(200)

	// Move the server's state by a route the module is not watching, so only the poll can
	// find it. `writes` stays empty: this change did not come from the module.
	const before = fake.writes.length
	fake.editTable(SEED)
	await new Promise((r) => setTimeout(r, 50))
	await fetch(`http://127.0.0.1:${port}/state/on-air?source=human:elsewhere`, {
		method: 'POST',
		headers: { Authorization: 'Bearer test-pass' },
	})
	await settle(600)

	assert.equal(seen.variables.state, 'on-air', 'the backstop poll must have found it')
	assert.equal(fake.writes.length, before + 1, 'and the module wrote nothing itself')

	await inst.destroy()
	await fake.close()
})

test('#72 a stream that is open but SILENT is reconnected by the watchdog', async () => {
	// The failure the server's 15 s keep-alive exists to expose, and the one the module used
	// to sit through forever: the socket is open, nothing is coming, and no error ever fires.
	// The threshold is configuration, so the test uses a short one rather than waiting 45 s.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, stream_watchdog_ms: '300', poll_ms: '30000' })
	await settle(300)
	const first = fake.eventsConnections
	assert.equal(first, 1, 'one connection to begin with')

	// The fake server says nothing further unless asked, which is exactly the fault.
	await settle(2500)

	assert.ok(
		fake.eventsConnections > first,
		`the watchdog must reconnect; connections stayed at ${fake.eventsConnections}`,
	)
	assert.ok(
		seen.logs.some((l) => /stream silent/.test(l)),
		'and it must say why',
	)
	assert.equal(seen.variables.state, 'available', 'and republish a correct state after reconnecting')
	assert.equal(seen.variables.connection, 'ok')

	await inst.destroy()
	await fake.close()
})

test('#72 the instance status tracks the module\'s own three conditions', async () => {
	// Before this, Ok was set once when the stream connected and never revisited: the
	// connection light stayed green while the deck was showing NO DATA.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, poll_ms: '30000' })
	await settle(300)
	assert.equal(seen.status.at(-1)[0], InstanceStatus.Ok)

	inst.lastContactAt = Date.now() - 61_000
	inst.tick()
	assert.equal(seen.status.at(-1)[0], InstanceStatus.UnknownWarning)
	assert.match(String(seen.status.at(-1)[1]), /not refreshing/)

	inst.lastContactAt = Date.now() - 1_801_000
	inst.tick()
	assert.equal(seen.status.at(-1)[0], InstanceStatus.ConnectionFailure)
	assert.match(String(seen.status.at(-1)[1]), /no data/)

	inst.lastContactAt = Date.now()
	inst.tick()
	assert.equal(seen.status.at(-1)[0], InstanceStatus.Ok, 'and it recovers without operator action')

	await inst.destroy()
	await fake.close()
})

// ---------------------------------------------------------------------------------------
// D-126 - the pin is retired. Nothing holds a state; the last write wins.

test('BREAKING: the pin is gone from the actions, feedbacks, variables and the fixture', async () => {
	// Modelled on the `stale` test above, and for the same reason. D-120 gave this module a
	// Hold option, two pin actions, two `held` feedbacks, two variables and two utility presets;
	// every one of them is gone, not disabled and not renamed. A control that is still there and
	// does nothing is the decoy that removal was written against - and on a Stream Deck it is a
	// physical key that lies.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	for (const id of ['pin_current_state', 'release_hold']) {
		assert.equal(id in seen.actions, false, `${id} must be gone from the actions`)
	}
	assert.equal(
		seen.actions.set_state.options.some((o) => o.id === 'hold'),
		false,
		'and set_state must not offer a Hold option',
	)
	for (const id of ['held', 'held_to_this_state']) {
		assert.equal(id in seen.feedbacks, false, `${id} must be gone from the feedbacks`)
	}
	// checkAll() is the site a half-finished removal hides in: it names its feedback ids as
	// strings, so a retired one there asks Companion to redraw something that was never
	// registered, on every single payload, and nothing else in this suite looks at the list.
	assert.ok(seen.repaints.length > 0, 'something must have asked for a repaint')
	for (const ids of seen.repaints) {
		for (const id of ids) {
			assert.ok(id in seen.feedbacks, `a repaint names a feedback that is not registered: ${id}`)
		}
	}
	for (const id of ['hold', 'hold_label']) {
		assert.equal(id in seen.variables, false, `${id} must be gone from the variables`)
		assert.equal(inst.buildVariables().some((v) => v.variableId === id), false)
	}
	assert.equal('hold' in fake.status(), false, 'the fixture must not carry it either')

	// And a press is an ordinary write. A button placed before the upgrade still carries
	// `hold: 'pin'` in its saved options; the callback ignores it and sends no `?hold=`.
	await seen.actions.set_state.callback({ options: { state: 'on-air', hold: 'pin' } })
	await settle(150)
	assert.deepEqual(fake.writes.at(-1), { id: 'on-air', source: 'companion' })

	await inst.destroy()
	await fake.close()
})

// ---------------------------------------------------------------------------------------
// #74 - `confirmed` is evidence about the light, and it gets two feedbacks because it
// describes two different faults.

test('#74 confirmed unknown is "not confirming", not "disagrees"', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setConfirmed('unknown')
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal(seen.feedbacks.light_not_confirming.callback({}), true)
	assert.equal(seen.feedbacks.light_disagrees.callback({}), false)

	await inst.destroy()
	await fake.close()
})

test('#74 a light holding another row is "disagrees", not "not confirming"', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setConfirmed('available')
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	await seen.actions.set_state.callback({ options: { state: 'on-air' } })
	await settle(150)

	assert.equal(seen.variables.state, 'on-air')
	assert.equal(seen.variables.confirmed, 'available')
	assert.equal(seen.feedbacks.light_disagrees.callback({}), true)
	assert.equal(seen.feedbacks.light_not_confirming.callback({}), false)

	await inst.destroy()
	await fake.close()
})

test('#74 an agreeing light lights neither feedback', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal(seen.variables.state, seen.variables.confirmed)
	assert.equal(seen.feedbacks.light_not_confirming.callback({}), false)
	assert.equal(seen.feedbacks.light_disagrees.callback({}), false)

	await inst.destroy()
	await fake.close()
})

test('#74 a write publishes from the RESPONSE, with no stream event delivered', async () => {
	// The server answers a write with the full status body, after the write and after the
	// light attempt. With the stream unavailable and the poll parked far away, the only place
	// these values can have come from is that response.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setEventsAvailable(false)
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, poll_ms: '60000' })
	await settle(300)
	assert.equal(seen.variables.state, 'available')

	fake.setConfirmed('unknown')
	await seen.actions.set_state.callback({ options: { state: 'on-air' } })
	await settle(150)

	assert.equal(seen.variables.state, 'on-air')
	assert.equal(seen.variables.confirmed, 'unknown', 'confirmed came from the write response')
	assert.equal(seen.variables.source, 'human:companion', 'and so did source')
	assert.equal(seen.feedbacks.light_not_confirming.callback({}), true)

	await inst.destroy()
	await fake.close()
})

test('#82 a panel dark on schedule is NOT "not confirming"', async () => {
	// Eight hours a night, every night, `confirmed` reads unknown by design. A Stream Deck
	// button lit blue from 23:00 to 07:00 about a panel that is working perfectly is a lamp
	// you learn to ignore, and a lamp you ignore is worse than no lamp.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setConfirmed('unknown')
	fake.setConfirmedReason('asleep')
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal(seen.feedbacks.light_not_confirming.callback({}), false, 'the alarm must be dark')
	assert.equal(seen.feedbacks.panel_asleep.callback({}), true)
	assert.equal(seen.feedbacks.light_disagrees.callback({}), false)
	assert.equal(seen.variables.confirmed, 'unknown', 'confirmed itself is unchanged and still honest')
	assert.equal(seen.variables.confirmed_reason, 'asleep')

	await inst.destroy()
	await fake.close()
})

test('#82 an UNEXPLAINED unknown still lights the alarm - absence is not reassurance', async () => {
	// The half that matters more. `confirmedReason` is absent whenever the server cannot name
	// one, including between a write and the supervisor's next tick. Reading absent as "fine"
	// would be a false OK, which is the same family of failure as a false OFF.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setConfirmed('unknown') // and NO reason
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal(seen.feedbacks.light_not_confirming.callback({}), true)
	assert.equal(seen.feedbacks.panel_asleep.callback({}), false)
	assert.equal(seen.variables.confirmed_reason, '')

	await inst.destroy()
	await fake.close()
})

test('#82 a genuinely unreachable panel still lights the alarm', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setConfirmed('unknown')
	fake.setConfirmedReason('unreachable')
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	assert.equal(seen.feedbacks.light_not_confirming.callback({}), true)
	assert.equal(seen.feedbacks.panel_asleep.callback({}), false)

	await inst.destroy()
	await fake.close()
})

test('#74 the four "something is off" feedbacks have four distinct default styles', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	// FIVE since #82 - `panel_asleep` joined the family, and it must not be mistaken at a
	// glance for any of the four that mean something is wrong.
	const family = ['connection_lost', 'no_data', 'light_not_confirming', 'light_disagrees', 'panel_asleep']
	const styles = family.map((id) => {
		const s = seen.feedbacks[id].defaultStyle
		assert.ok(s, `${id} needs a default style`)
		return `${s.color}/${s.bgcolor}`
	})
	assert.equal(new Set(styles).size, family.length, `five states need five looks, got ${styles.join(' ')}`)

	await inst.destroy()
	await fake.close()
})

// ---------------------------------------------------------------------------------------
// #75 - the generated presets carry the marks, and the reserved row's look is the owner's.

test('#75 every generated state preset carries the connection marks, marks last', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	for (const row of SEED) {
		const preset = seen.presets[`state_${row.id}`]
		assert.ok(preset, `${row.id} must have a preset`)
		const ids = preset.feedbacks.map((f) => f.feedbackId)
		assert.ok(ids.includes('state_is'), `${row.id} keeps its state feedback`)
		// The three #75 names, in #75's order. Later feedbacks win in Companion, so the marks
		// must sit after the row's own colours - a deck that goes quiet during an outage is
		// the defect this closes.
		assert.deepEqual(
			ids.filter((id) => ['state_is', 'connection_lost', 'no_data'].includes(id)),
			['state_is', 'connection_lost', 'no_data'],
			`${row.id}: marks must come after the state, in order`,
		)
		assert.equal(ids.at(-1), 'no_data', `${row.id}: nothing may paint over NO DATA`)
	}

	await inst.destroy()
	await fake.close()
})

test('#75 the reserved row\'s label and colours come from the table, not from a literal', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	// The owner relabels and recolours the reserved row, which section 1 explicitly allows.
	fake.editTable([
		SEED[0],
		SEED[1],
		{ id: 'unknown', label: 'SERVER GONE', color: '#00ff00', bgcolor: '#123456', busy: true, order: 99 },
	])
	await settle(600)

	inst.lastContactAt = Date.now() - 1_801_000
	inst.publishVariables()

	assert.equal(inst.view().label, 'SERVER GONE', 'view() must read the row')
	assert.equal(seen.variables.label, 'SERVER GONE')
	assert.equal(seen.feedbacks.no_data.defaultStyle.color, 0x00ff00)
	assert.equal(seen.feedbacks.no_data.defaultStyle.bgcolor, 0x123456)

	for (const key of ['state_on-air', 'state_on-air_words']) {
		const mark = seen.presets[key].feedbacks.find((f) => f.feedbackId === 'no_data')
		assert.equal(mark.style.color, 0x00ff00, `and so must the mark on ${key}`)
		assert.equal(mark.style.bgcolor, 0x123456)
	}
	// The WORDS preset says it in words; the GRAPHIC one says it in the reserved row's icon and
	// blanks the caption. Both are the owner's relabelled row - one of them just draws it.
	const words = seen.presets['state_on-air_words'].feedbacks.find((f) => f.feedbackId === 'no_data')
	assert.equal(words.style.text, 'SERVER GONE')
	const graphic = seen.presets['state_on-air'].feedbacks.find((f) => f.feedbackId === 'no_data')
	assert.equal(graphic.style.text, '')
	assert.ok(graphic.style.png64, 'the graphic no-data mark lost its art and drew nothing at all')

	await inst.destroy()
	await fake.close()
})

test('#75 no hardcoded reserved-row presentation, and no v1 label residue, in the source', async () => {
	const src = readFileSync(SRC, 'utf8')
	assert.equal(/255,\s*0,\s*255/.test(src), false, 'the magenta literal must be gone')
	assert.equal(/\bs\.label\b/.test(src), false, 'presentation left the state payload in D-42')
})

// ---------------------------------------------------------------------------------------
// #76 - a slow write is not a failed write.

test('#76 the default write timeout clears the measured worst case from #68', async () => {
	const OnAir = await loadInstanceClass()
	const inst = Object.create(OnAir.prototype)
	const field = inst.getConfigFields().find((f) => f.id === 'write_timeout_ms')
	assert.ok(field, 'the timeout must be configuration, not a constant')
	// #68 measured 6.4 s on POST /state/{id} and 13.2 s on PUT /state, both SUCCEEDING,
	// against a panel that was powered off.
	assert.ok(Number(field.default) >= 13_200, `default ${field.default} must clear #68's 13.2 s`)
	const help = inst.getConfigFields().find((f) => f.id === 'write-intro')
	assert.match(String(help.value), /13\.2 s/, 'and the field must say where the number comes from')
})

test('#76 a write slower than the old 5 s ceiling completes and is NOT a failure', async () => {
	// The proportions of #68, scaled so the suite does not spend half a minute asleep: the
	// server answers well past the timeout that used to be hardcoded, and inside the one
	// configured here. Before this ticket the action aborted, logged a failure, and dropped
	// the whole instance to ConnectionFailure - while the state was live on the server.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, write_timeout_ms: '6000', poll_ms: '30000' })
	await settle(300)
	const statusesBefore = seen.status.length

	fake.setWriteDelay(1500)
	await seen.actions.set_state.callback({ options: { state: 'on-air' } })

	assert.equal(seen.variables.state, 'on-air', 'the action must wait for the answer and publish it')
	assert.equal(
		seen.status.slice(statusesBefore).some(([s]) => s === InstanceStatus.ConnectionFailure),
		false,
		'a slow write is not a connection failure',
	)
	assert.equal(seen.logs.some((l) => /^error: set state/.test(l)), false, 'and it is not an error')

	await inst.destroy()
	await fake.close()
})

test('#76 a write that runs out of time is an UNKNOWN outcome, and the module recovers', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, write_timeout_ms: '1000', poll_ms: '30000' })
	await settle(300)
	const statusesBefore = seen.status.length

	fake.setWriteDelay(2500)
	await seen.actions.set_state.callback({ options: { state: 'on-air' } })

	const note = seen.logs.find((l) => /no answer within 1000 ms/.test(l))
	assert.ok(note, `expected an unknown-outcome note, got ${JSON.stringify(seen.logs.slice(-3))}`)
	assert.match(note, /^warn:/, 'unknown is a warning, not an error')
	assert.match(note, /may still have\s+succeeded/, 'and it must say so - #68 measured two that did')
	assert.equal(
		seen.status.slice(statusesBefore).some(([s]) => s === InstanceStatus.ConnectionFailure),
		false,
		'and it must not drop the instance',
	)
	assert.equal(seen.logs.filter((l) => /set state "on-air"/.test(l)).length, 1, 'and it must not retry')

	// The server did take the write. The next poll settles it, with no operator action.
	assert.equal(fake.status().state, 'on-air')
	assert.equal(await inst.poll(), true)
	assert.equal(seen.variables.state, 'on-air')

	await inst.destroy()
	await fake.close()
})

// ---------------------------------------------------------------------------------------
// What the adversarial review found. Each of these fails against the code as it was.

test('a row the module has no entry for draws the RESERVED appearance, never nothing', async () => {
	// Contract section 6: "It must never silently drop it - a state that degrades to nothing
	// looks exactly like a calm one."
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, poll_ms: '30000' })
	await settle()

	// A state id that is not in the table this module holds.
	inst.current = { ...inst.current, state: 'invented-tomorrow', busy: true }
	inst.publishVariables()

	assert.equal(seen.variables.label, 'NO DATA', 'the reserved row lends its appearance')
	assert.notEqual(seen.variables.label, '', 'and it is never blank')
	assert.equal(seen.variables.state, 'invented-tomorrow', 'while the id itself is reported honestly')

	await inst.destroy()
	await fake.close()
})

test('configUpdated forgets the previous server and republishes at once', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	// Start against a wrong passphrase, so a fault is latched on the connection light.
	await inst.init({ ...config, passphrase: 'wrong', poll_ms: '30000' })
	await settle(300)
	assert.ok(seen.status.some(([s]) => String(s).toLowerCase().includes('auth')))

	// Now fix it. The fault must clear rather than sticking on a suppressed duplicate.
	await inst.configUpdated({ ...config, passphrase: 'test-pass', poll_ms: '30000' })
	await settle(300)

	assert.equal(seen.status.at(-1)[0], InstanceStatus.Ok, `stale fault stuck: ${JSON.stringify(seen.status.at(-1))}`)
	assert.equal(seen.variables.state, 'available')

	await inst.destroy()
	await fake.close()
})

test('repointed at an unreachable host, it does not report the OLD server\'s state as current', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, poll_ms: '30000' })
	await settle()
	assert.equal(seen.variables.connection, 'ok')
	assert.equal(seen.variables.state, 'available')

	// A port nothing is listening on. Carrying the old box's state across would show one
	// server's answer as though the new one had given it, with every threshold reading healthy.
	await inst.configUpdated({ ...config, port: '1', poll_ms: '30000' })
	await settle(300)

	assert.equal(seen.variables.connection, 'no data', 'it must fail CLOSED, not inherit')
	assert.equal(seen.variables.busy, 'yes', 'and land conspicuous, never calm')

	await inst.destroy()
	await fake.close()
})

test('the module asks Companion to REDRAW, it does not just hold correct values', async () => {
	// Every other feedback assertion in this file calls the callback by hand. Without this,
	// deleting every checkFeedbacks() call would leave the suite green and the deck frozen.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, poll_ms: '30000' })
	await settle()
	assert.ok(seen.repaints.length > 0, 'a status must trigger a repaint')
	assert.ok(seen.repaints.some((ids) => ids.includes('state_is')))

	// And a threshold crossing, which no payload announces.
	seen.repaints.length = 0
	inst.lastContactAt = Date.now() - 61_000
	inst.tick()
	assert.ok(seen.repaints.length > 0, 'crossing a threshold must repaint too')
	assert.ok(seen.repaints.some((ids) => ids.includes('connection_lost')))

	await inst.destroy()
	await fake.close()
})

test('tick() alone carries the display across both thresholds', async () => {
	// The threshold tests elsewhere call publishVariables() by hand, which proves view() and
	// not the timer that has to call it.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, poll_ms: '30000' })
	await settle()

	inst.lastContactAt = Date.now() - 61_000
	inst.tick()
	assert.equal(seen.variables.connection, 'not refreshing')

	inst.lastContactAt = Date.now() - 1_801_000
	inst.tick()
	assert.equal(seen.variables.connection, 'no data')
	assert.equal(seen.variables.busy, 'yes')

	await inst.destroy()
	await fake.close()
})

test('#72 a stream that is QUIET BUT ALIVE is left alone', async () => {
	// The other half of the watchdog, and the one that matters for not thrashing a healthy
	// server: the real hub sends a keep-alive every 15 s precisely so a client can tell the
	// difference between a silent stream and a dead one.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, stream_watchdog_ms: '1200', poll_ms: '30000' })
	await settle(300)
	fake.startKeepAlive(300)
	const first = fake.eventsConnections

	await settle(2500)

	assert.equal(fake.eventsConnections, first, 'a keep-alive must satisfy the watchdog')
	assert.equal(seen.logs.some((l) => /stream silent/.test(l)), false)
	assert.equal(seen.variables.connection, 'ok')

	await inst.destroy()
	await fake.close()
})

test('#76 a write slower than the OLD 5 s ceiling still completes and is not a failure', async () => {
	// Above the 5000 that used to be hardcoded, so this exercises the actual regression rather
	// than a scaled-down analogue of it. #68 measured 6.4 s and 13.2 s, both succeeding.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init({ ...config, write_timeout_ms: '15000', poll_ms: '30000' })
	await settle(300)
	const statusesBefore = seen.status.length

	fake.setWriteDelay(6500)
	await seen.actions.set_state.callback({ options: { state: 'on-air' } })

	assert.equal(seen.variables.state, 'on-air', 'a 6.5 s write is a write')
	assert.equal(
		seen.status.slice(statusesBefore).some(([s]) => s === InstanceStatus.ConnectionFailure),
		false,
	)
	assert.equal(seen.logs.some((l) => /^error: set state/.test(l)), false)

	await inst.destroy()
	await fake.close()
})

test('button captions carry real line breaks, not a literal backslash-n', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	// `parseEscapeCharacters` in @companion-module/base is documented as applying to action
	// and feedback OPTION values, not to preset button text - so a literal \n here draws as
	// the two characters. A real newline is a line break under any reading.
	const captions = [
		seen.presets.refresh.style.text,
		seen.presets.light.style.text,
		...seen.presets.light.feedbacks.map((f) => f.style.text),
	]
	for (const c of captions) {
		assert.equal(/\\n/.test(c), false, `literal backslash-n in ${JSON.stringify(c)}`)
		assert.ok(c.includes('\n'), `expected a real newline in ${JSON.stringify(c)}`)
	}

	await inst.destroy()
	await fake.close()
})

// ---------------------------------------------------------------------------------------
// #91 - a button that darkens the panel, and one that lights it again.

test('#91 sleep and wake POST to /panel/*, and are NOT state writes', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	const writesBefore = fake.writes.length

	await seen.actions.panel_sleep.callback({ options: {} })
	await settle(150)
	await seen.actions.panel_wake.callback({ options: {} })
	await settle(150)

	const panelCalls = fake.requests.filter((r) => r.includes('/panel/'))
	assert.deepEqual(panelCalls, ['POST /panel/sleep', 'POST /panel/wake'])
	assert.equal(fake.panelAsleep, false, 'the wake did not land on the fixture')
	// SLEEPING IS NOT A STATE WRITE. The light goes on holding whatever row it was
	// asserting; it simply stops showing it. A sleep that moved the state would be a
	// button that changes what the room is told, which is the opposite of the intent.
	assert.equal(fake.writes.length, writesBefore, 'darkening the glass wrote a state')
})

test('#91 the sleep preset wears the asleep feedback, so it reports the ANSWER not the press', async () => {
	// The panel refuses a sleep while the row is busy, so "asked to sleep" and "is asleep"
	// come apart exactly when it matters. A button that lit up on the press would be lying
	// during a call - the one time anybody is looking at it.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	const sleep = seen.presets.panel_sleep
	assert.ok(sleep, 'no panel sleep preset')
	assert.deepEqual(sleep.steps[0].down, [{ actionId: 'panel_sleep', options: {} }])
	assert.ok(
		sleep.feedbacks.some((f) => f.feedbackId === 'panel_asleep'),
		'the sleep button does not report whether the panel actually went dark',
	)
	// And wake carries none: waking is never refused, so there is nothing to report.
	assert.deepEqual(seen.presets.panel_wake.feedbacks, [])
})

test('#91 a server that cannot darken a panel is logged, not raised', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	fake.setPanelSleepStatus(501)
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	const before = seen.status.slice()

	await seen.actions.panel_sleep.callback({ options: {} })
	await settle(150)

	// An older server, or one wired to a driver that models no device. Nothing the operator
	// can fix from the deck, and it does not make the CONNECTION broken - the state surface
	// is still working perfectly. D-123's rule, applied to a different route.
	assert.ok(
		seen.logs.some((l) => /^error: panel sleep failed/.test(l)),
		JSON.stringify(seen.logs),
	)
	assert.deepEqual(seen.status, before, 'a 501 on an optional route changed the instance status')
})

// ---------------------------------------------------------------------------------------
// #92 - one button for both, and art that can actually be read.

test('#92 the toggle POSTs to /panel/toggle and lets the SERVER decide the direction', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	const writesBefore = fake.writes.length

	await seen.actions.panel_toggle.callback({ options: {} })
	await settle(150)
	assert.equal(fake.panelAsleep, true, 'the first press did not darken the panel')
	await seen.actions.panel_toggle.callback({ options: {} })
	await settle(150)
	assert.equal(fake.panelAsleep, false, 'the second press did not wake it')

	// ONE ROUTE, TWICE. The module never sends /panel/sleep or /panel/wake for a toggle press
	// and never decides the direction itself: it has no fresh reading of the glass to decide
	// from, and guessing from a poll that may be seconds old is how a toggle desynchronises.
	assert.deepEqual(
		fake.requests.filter((r) => r.includes('/panel/')),
		['POST /panel/toggle', 'POST /panel/toggle'],
	)
	assert.equal(fake.writes.length, writesBefore, 'toggling the glass wrote a state')
})

test('#92 the toggle logs which way the server actually went', async () => {
	// The one thing a toggle cannot show on its own face: it has no position. The server
	// decided from a reading this module never saw, so a press that did the opposite of what
	// the operator expected has to be explainable afterwards.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	await seen.actions.panel_toggle.callback({ options: {} })
	await settle(150)

	assert.ok(
		seen.logs.some((l) => /panel toggle: the glass was lit, sent sleep/.test(l)),
		`no direction in the log: ${JSON.stringify(seen.logs.slice(-4))}`,
	)
})

test('#92 the toggle preset shows the panel, and changes what it offers when asleep', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	const t = seen.presets.panel_toggle
	assert.ok(t, 'no toggle preset')
	assert.deepEqual(t.steps[0].down, [{ actionId: 'panel_toggle', options: {} }])

	const asleep = t.feedbacks.find((f) => f.feedbackId === 'panel_asleep')
	assert.ok(asleep, 'the toggle does not report whether the panel is dark')
	// The two faces must differ in BOTH channels. The background carries the state and the
	// icon carries what the press will do; a feedback that changed only one of them would
	// leave a button that either lies about the state or lies about the action.
	assert.notEqual(asleep.style.bgcolor, t.style.bgcolor, 'the asleep face is the same colour')
	assert.notEqual(asleep.style.png64, t.style.png64, 'the asleep face offers the same action')

	// And the words version says it in words rather than going blank.
	assert.equal(seen.presets.panel_toggle_words.style.text, 'PANEL\nSLEEP?')
	assert.equal(
		seen.presets.panel_toggle_words.feedbacks.find((f) => f.feedbackId === 'panel_asleep').style.text,
		'PANEL\nWAKE?',
	)
	assert.equal(seen.presets.panel_toggle_words.style.png64, undefined, 'the words preset carries art')
})

test('#92 every generated button clears 4.5:1, on the resting face and the lit one', async () => {
	// THE BUG THIS TICKET OPENED WITH. INTERRUPTIBLE is #1a1a1a ink on #e8a317, and the
	// resting button dims that background to #3a2805 - where the owner's ink measures 1.23:1.
	// Nothing noticed, because nothing was measuring: the row's colour was assumed to work
	// everywhere it was pasted.
	const lum = (packed) => {
		const chan = (c) => {
			const s = c / 255
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
		}
		return 0.2126 * chan((packed >> 16) & 255) + 0.7152 * chan((packed >> 8) & 255) + 0.0722 * chan(packed & 255)
	}
	const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	fake.editTable([
		...SEED,
		{ id: 'interruptible', label: 'INTERRUPTIBLE', color: '#1a1a1a', bgcolor: '#e8a317', busy: false, order: 2 },
	])
	await settle(600)

	// The amber row must be present, or this test passes by testing nothing.
	assert.ok(seen.presets['state_interruptible_words'], 'the amber row never arrived')

	const faces = []
	for (const [key, preset] of Object.entries(seen.presets)) {
		faces.push([`${key} at rest`, preset.style.color, preset.style.bgcolor])
		for (const f of preset.feedbacks ?? []) {
			// A feedback style may override one channel and inherit the other, which is exactly
			// where an unreadable pair can hide - so measure the pair as COMPOSED.
			faces.push([
				`${key} + ${f.feedbackId}`,
				f.style?.color ?? preset.style.color,
				f.style?.bgcolor ?? preset.style.bgcolor,
			])
		}
	}

	const bad = faces.filter(([, color, bg]) => ratio(color, bg) < 4.5)
	assert.deepEqual(
		bad.map(([what, c, b]) => `${what}: ${ratio(c, b).toFixed(2)}:1`),
		[],
		'a generated button cannot be read',
	)
	// The specific one, named, so this cannot pass by generating no amber button at all.
	const rest = seen.presets['state_interruptible_words'].style
	assert.ok(ratio(rest.color, rest.bgcolor) >= 4.5, 'INTERRUPTIBLE at rest is unreadable again')
})

test('#92 art is inked for the surface it lands on, including the amber fault mark', async () => {
	// The art ships as a white-ink render and a black-ink one, and the module picks per
	// background. Three different backgrounds appear on ONE state button - resting, lit, and
	// the amber a `connection_lost` feedback paints over the top - and the amber one is the
	// easy one to forget, because it is not in the table at all.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	const preset = seen.presets['state_on-air']
	const lost = preset.feedbacks.find((f) => f.feedbackId === 'connection_lost')
	assert.ok(lost.style.png64, 'the amber fault mark drops the art entirely')
	// Amber is a LIGHT background and the resting red is a dark one, so these two must not be
	// the same render. Equal here means one of them is unreadable.
	assert.notEqual(lost.style.png64, preset.style.png64, 'the same ink was used on amber and on dark red')
})

// ---- #93, one key for the whole table -------------------------------------------------

test('#93 cycling POSTs to /cycle and lets the SERVER pick the successor', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	assert.equal(seen.variables.state, 'available')

	await seen.actions.cycle_state.callback({ options: { ring: ['available', 'on-air'] } })
	await settle(150)
	assert.equal(seen.variables.state, 'on-air')
	// AND IT WRAPS. Two rows is the smallest ring that can, and a modulo that is really a
	// clamp passes the first press and fails here.
	await seen.actions.cycle_state.callback({ options: { ring: ['available', 'on-air'] } })
	await settle(150)
	assert.equal(seen.variables.state, 'available')

	// Never /state/{id}. The module is not allowed to name the row: it would have to read a
	// status that may be a round trip behind to know which one.
	assert.deepEqual(
		fake.requests.filter((r) => r.startsWith('POST ')),
		['POST /cycle', 'POST /cycle'],
	)
	await inst.destroy()
	await fake.close()
})

test('#93 three presses inside one round trip advance THREE stops, not one', async () => {
	// The failure this whole design exists to prevent, and the only test that can see it. A
	// module that computed the successor from its own `state` passes every single-press test
	// and then does this wrong in the field - because the way a human uses a cycle button is
	// to jab it until the right row comes up, and the status has not caught up in between.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	const ring = ['available', 'on-air', 'unknown']
	// Fired together, deliberately not awaited in turn.
	await Promise.all([
		seen.actions.cycle_state.callback({ options: { ring } }),
		seen.actions.cycle_state.callback({ options: { ring } }),
		seen.actions.cycle_state.callback({ options: { ring } }),
	])
	await settle(200)
	assert.equal(fake.status().state, 'available', 'three presses around a ring of three should return to the start')
	assert.equal(fake.requests.filter((r) => r === 'POST /cycle').length, 3)

	await inst.destroy()
	await fake.close()
})

test('#93 the ring goes out in TABLE order, not the order the boxes were ticked', async () => {
	// The picker hands back click order. Left alone, the cycle a deck walks would depend on
	// how somebody filled in a form months ago rather than on the order the owner curates in
	// the admin console - and two buttons built from the same rows would disagree.
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	await seen.actions.cycle_state.callback({ options: { ring: ['unknown', 'available', 'on-air'] } })
	await settle(150)
	assert.deepEqual(fake.cycles, ['available,on-air,unknown'])

	await inst.destroy()
	await fake.close()
})

test('#93 a cycle button with nothing ticked warns and writes nothing', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()
	const before = fake.requests.length

	await seen.actions.cycle_state.callback({ options: { ring: [] } })
	await settle(150)
	assert.equal(fake.requests.length, before, 'an empty ring reached the server')
	assert.ok(
		seen.logs.some((l) => /^warn: cycle state: no states selected/.test(l)),
		'an empty ring should say so rather than failing silently',
	)

	await inst.destroy()
	await fake.close()
})

test('#93 the cycle preset wears the current row, so it can be pressed until the right one comes up', async () => {
	const OnAir = await loadInstanceClass()
	const fake = startFakeServer()
	const port = await fake.listen()
	const { inst, seen, config } = makeInstance(OnAir, port, 'test-pass')

	await inst.init(config)
	await settle()

	const preset = seen.presets.state_cycle
	assert.ok(preset, 'no cycle preset was generated')
	// The default ring excludes the reserved row: NO DATA is the server admitting ignorance,
	// not a state anyone chooses, and a cycle that stopped there would assert it on purpose.
	assert.deepEqual(preset.steps[0].down[0].options.ring, ['available', 'on-air'])

	// One `state_is` per row - INCLUDING the reserved one, which the ring leaves out. The
	// button must be able to SHOW a state it will not write.
	const shown = preset.feedbacks.filter((f) => f.feedbackId === 'state_is').map((f) => f.options.state)
	assert.deepEqual(shown, ['available', 'on-air', 'unknown'])
	assert.equal(preset.feedbacks.find((f) => f.options.state === 'on-air').style.bgcolor, 0xc1121f)
	// And the words variant says which row in words, or the button is unreadable in the one
	// mode chosen because icons are not.
	assert.equal(
		seen.presets.state_cycle_words.feedbacks.find((f) => f.options.state === 'on-air').style.text,
		'ON AIR',
	)

	await inst.destroy()
	await fake.close()
})
