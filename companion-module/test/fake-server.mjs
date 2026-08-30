// A stand-in for the on-air server, just enough of it to drive the module.
//
// Exists so the module's behaviour can be tested without touching Rocket's live config. The
// criterion "presets regenerate when tableVersion moves" is otherwise only provable by
// editing the real state table, which is a change to a running system for the sake of a test.
// Here the version can be bumped as often as we like, and the test is repeatable.
//
// Implements only what the module reads: GET /status, GET /config/states, GET /events (SSE),
// and POST /state/{id}. Auth is the contract's Bearer form, and it is enforced, because "the
// module sends the passphrase" is one of the things worth proving.
//
// It also implements the parts of the server that the module's FAILURE paths need, because
// those are the paths #72-#76 are about: a stream that can be made unavailable, a stream that
// stays open and silent, a write that can be made slow, and a `confirmed` that can be made to
// disagree with `state`.

import { createServer } from 'node:http'

export function startFakeServer({ passphrase = 'test-pass' } = {}) {
	let version = 1
	let states = [
		{ id: 'available', label: 'AVAILABLE', color: '#ffffff', bgcolor: '#0b6e2e', busy: false, order: 0 },
		{ id: 'on-air', label: 'ON AIR', color: '#ffffff', bgcolor: '#c1121f', busy: true, order: 1 },
		{ id: 'unknown', label: 'NO DATA', color: '#ff00ff', bgcolor: '#1a1a1a', busy: true, order: 99 },
	]
	let current = 'available'
	// `null` means "the light agrees", which is the ordinary case. A test that wants a
	// disagreeing or unreachable panel pins it to something else.
	let confirmedOverride = null
	// The server omits `confirmedReason` whenever it cannot name one, so `null` here is the
	// ordinary case and the fixture must NOT emit the key at all when it is null (#82).
	let confirmedReason = null
	let writeDelayMs = 0
	let eventsAvailable = true
	let source = 'human:seed'
	let keepAlive = null
	const clients = new Set()
	const writes = []
	const requests = []
	let eventsConnections = 0

	const status = () => {
		const row = states.find((r) => r.id === current)
		return {
			state: current,
			busy: !!row?.busy,
			intended: row?.busy ? 'on' : 'off',
			confirmed: confirmedOverride ?? current,
			...(confirmedReason === null ? {} : { confirmedReason }),
			source,
			updatedAt: new Date(0).toISOString(),
			ageSeconds: 0,
			// NO `stale` and NO `hold`. Both were deleted from the wire - `stale` by D-91, `hold`
			// by D-126 - and a fixture that still emits one is the decoy-beside-the-real-thing that
			// D-104 refuses in the module itself.
			tableVersion: version,
			message: null,
		}
	}

	const payload = () => JSON.stringify(status())

	const broadcast = () => {
		for (const res of clients) res.write(`event: status\ndata: ${payload()}\n\n`)
	}

	const authed = (req) => req.headers.authorization === `Bearer ${passphrase}`

	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://x')
		requests.push(`${req.method} ${url.pathname}`)

		if (!authed(req)) {
			res.writeHead(401, { 'Content-Type': 'application/json' })
			return res.end('{"error":"unauthorized"}')
		}

		if (url.pathname === '/status') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			return res.end(payload())
		}

		if (url.pathname === '/config/states') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			return res.end(JSON.stringify({ version, states }))
		}

		if (url.pathname === '/events') {
			if (!eventsAvailable) {
				res.writeHead(503, { 'Content-Type': 'application/json' })
				return res.end('{"error":"stream off"}')
			}
			eventsConnections += 1
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
			res.write(`event: status\ndata: ${payload()}\n\n`)
			clients.add(res)
			req.on('close', () => clients.delete(res))
			return
		}

		if (req.method === 'POST' && url.pathname.startsWith('/state/')) {
			const id = decodeURIComponent(url.pathname.slice('/state/'.length))
			writes.push({ id, source: url.searchParams.get('source') })
			if (!states.some((r) => r.id === id)) {
				res.writeHead(400, { 'Content-Type': 'application/json' })
				return res.end(JSON.stringify({ error: `unknown state '${id}'`, validStates: states.map((r) => r.id) }))
			}
			// `coerceSource`, as the real server does it: a bare label becomes `human:<label>`,
			// an unset one becomes `human:anonymous`. A fixture that answers with a CONSTANT
			// source lets a test claim it read the write's response when it read the seed.
			const raw = url.searchParams.get('source')
			source = raw ? (/^(auto|human):/.test(raw) ? raw : `human:${raw}`) : 'human:anonymous'
			// LAST WRITE WINS (D-126). The fixture used to reproduce the human half of THE PIN
			// RULE here - pin, release, and the silent release of somebody else's pin. There is no
			// precedence left to emulate: every write with a valid body is applied.
			current = id

			const answer = () => {
				broadcast()
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(payload())
			}
			// A SLOW WRITE IS STILL A WRITE. Issue #68 measured 6.4 s and 13.2 s against a
			// powered-off panel, both succeeding, which is the whole of #76.
			if (writeDelayMs > 0) setTimeout(answer, writeDelayMs).unref?.()
			else answer()
			return
		}

		res.writeHead(404)
		res.end()
	})

	return {
		server,
		listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
		close: () => {
			if (keepAlive) clearInterval(keepAlive)
			for (const res of clients) res.end()
			return new Promise((r) => server.close(r))
		},
		writes,
		requests,
		status,
		/// The real SSE hub emits a `status` event every 15 s per connection, "so a client can
		/// detect a dead stream". Without it here, a fixture that goes silent is the ONLY
		/// stream the watchdog is ever tested against - and the case that must NOT reconnect,
		/// a stream that is quiet but alive, goes unproven.
		startKeepAlive: (ms) => {
			if (keepAlive) clearInterval(keepAlive)
			keepAlive = setInterval(broadcast, ms)
			keepAlive.unref?.()
		},
		/// Bumps the table and announces it the way the real server does: a `status` event
		/// carrying the new tableVersion. That event is the module's regeneration trigger.
		editTable: (next) => {
			states = next
			version += 1
			broadcast()
			return version
		},
		get version() {
			return version
		},
		/// What the light acknowledges. `'unknown'` is the server admitting ignorance; any
		/// other row id that is not `state` is the light disagreeing.
		setConfirmed: (id) => {
			confirmedOverride = id
		},
		/// Why `confirmed` is unknown, when the server knows (#82). `null` omits the field.
		setConfirmedReason: (reason) => {
			confirmedReason = reason
		},
		setWriteDelay: (ms) => {
			writeDelayMs = ms
		},
		setEventsAvailable: (ok) => {
			eventsAvailable = ok
		},
		/// Drops every attached SSE client WITHOUT closing the socket cleanly is not
		/// something a test can ask a server to do; what it can do is simply stop talking,
		/// which is the default. This reports how many times the module has (re)connected,
		/// which is how the watchdog is observed.
		get eventsConnections() {
			return eventsConnections
		},
	}
}
