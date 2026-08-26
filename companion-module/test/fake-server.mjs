// A stand-in for the on-air server, just enough of it to drive the module.
//
// Exists so the module's behaviour can be tested without touching Rocket's live config. The
// criterion "presets regenerate when tableVersion moves" is otherwise only provable by
// editing the real state table, which is a change to a running system for the sake of a test.
// Here the version can be bumped as often as we like, and the test is repeatable.
//
// Implements only what the module reads: GET /config/states, GET /events (SSE), and
// POST /state/{id}. Auth is the contract's Bearer form, and it is enforced, because
// "the module sends the passphrase" is one of the things worth proving.

import { createServer } from 'node:http'

export function startFakeServer({ passphrase = 'test-pass' } = {}) {
	let version = 1
	let states = [
		{ id: 'available', label: 'AVAILABLE', color: '#ffffff', bgcolor: '#0b6e2e', busy: false, order: 0 },
		{ id: 'on-air', label: 'ON AIR', color: '#ffffff', bgcolor: '#c1121f', busy: true, order: 1 },
	]
	let current = 'available'
	const clients = new Set()
	const writes = []

	const payload = () => {
		const row = states.find((r) => r.id === current)
		return JSON.stringify({
			state: current,
			confirmed: current,
			hold: null,
			source: 'human:test',
			busy: !!row?.busy,
			ageSeconds: 0,
			stale: false,
			tableVersion: version,
			updatedAt: new Date(0).toISOString(),
		})
	}

	const broadcast = () => {
		for (const res of clients) res.write(`event: status\ndata: ${payload()}\n\n`)
	}

	const authed = (req) => req.headers.authorization === `Bearer ${passphrase}`

	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://x')

		if (!authed(req)) {
			res.writeHead(401, { 'Content-Type': 'application/json' })
			return res.end('{"error":"unauthorized"}')
		}

		if (url.pathname === '/config/states') {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			return res.end(JSON.stringify({ version, states }))
		}

		if (url.pathname === '/events') {
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
			current = id
			broadcast()
			res.writeHead(200, { 'Content-Type': 'application/json' })
			return res.end(payload())
		}

		res.writeHead(404)
		res.end()
	})

	return {
		server,
		listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
		close: () => {
			for (const res of clients) res.end()
			return new Promise((r) => server.close(r))
		},
		writes,
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
	}
}
