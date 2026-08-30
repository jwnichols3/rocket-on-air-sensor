// The Rocket On-Air Companion module (#44, rebuilt for #72-#76).
//
// Presets are generated from the server's own state table, so the buttons an operator drags
// onto a Stream Deck always match the states the server actually has. Row ids are immutable
// (D-31) and index never appears anywhere (D-34), so a placed button keeps working across
// table edits.
//
// WHY THE GATED ENDPOINTS AND NOT /public/*. The ticket steered toward `/public/events`
// because it needs no credential. `docs/api-contract.md` says the opposite, and names this
// module while doing it: "A renderer that holds a table must not use these. The ESP32,
// Companion and any other client take the state key from the gated endpoints and the look
// from GET /config/states." The contract wins - it is source of truth, and its reasoning is
// sound. `/public/*` is a RENDERING view for two dumb browser pages: it is free to change
// shape, and it carries no `confirmed`, no `hold` and no `source`. This module generates
// presets from the table, so it is a table-holder by definition.
//
// The cost is that the passphrase is required rather than optional. On the real deployment
// that costs nothing: Companion runs on another host, where the D-24 loopback waiver does
// not apply and the passphrase was already mandatory.
//
// THE POLL IS THE CORRECTNESS PATH; THE STREAM IS THE FAST PATH (D-119, #72). Section 3 of
// the contract says every renderer polls, and section 5 says push "is an optimisation, never
// a delivery guarantee". This module used to have neither a poll nor a stream watchdog, so a
// half-open socket froze it until the OS gave up and it never self-healed. Both are here now,
// and they feed one ingest path so it does not matter which of them learns something first.

import {
	InstanceBase,
	InstanceStatus,
	Regex,
	combineRgb,
	runEntrypoint,
} from '@companion-module/base'

/// The reserved row (contract section 1). It always exists in a real table and its `busy` is
/// always true; this is what the module falls back to before the first table pull, which is
/// the only moment there is no row to read. See reservedRow().
const RESERVED_ID = 'unknown'

/// A row's colours at rest, so the lit state has something to be brighter THAN. Without this
/// the base style and the `state_is` style are the same two colours and the feedback is a
/// visual no-op: a deck of five buttons looks identical whichever row is current.
function dim(packed) {
	const r = ((packed >> 16) & 255) >> 2
	const g = ((packed >> 8) & 255) >> 2
	const b = (packed & 255) >> 2
	return combineRgb(r, g, b)
}

/// #rrggbb -> Companion's packed integer. The table's colours are used verbatim (D-31, D-42).
function rgb(hex, fallback) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''))
	if (!m) return fallback
	const n = parseInt(m[1], 16)
	return combineRgb((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

/// A number from a config text field, with a floor and a default. Companion hands these back
/// as strings, and an operator who empties the box must get the default rather than a zero
/// timer that spins the event loop.
function num(raw, fallback, min = 0) {
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) return fallback
	return Math.max(min, n)
}

class OnAirInstance extends InstanceBase {
	async init(config) {
		this.config = config ?? {}
		this.states = []
		this.tableVersion = null
		this.current = null
		// When the server last answered - on EITHER path. Every threshold is measured from
		// here; see view().
		this.lastContactAt = 0
		// When the stream last delivered a parseable payload, which is what the watchdog
		// judges. Separate from lastContactAt because a healthy poll must not keep a dead
		// stream alive: the whole point of the watchdog is to notice a socket that is open
		// and silent.
		this.lastStreamAt = 0
		this.streamOpen = false
		// The last connection verdict published, so the liveness timer only redraws on a
		// transition rather than once a second forever.
		this.lastConnection = 'no data'
		// A sticky fault that outranks the connection-derived status: a bad config or a
		// rejected passphrase is not something the thresholds can describe.
		this.fault = null
		this.lastStatusKey = null
		this.abort = null
		this.retryTimer = null
		this.livenessTimer = null
		this.pollTimer = null
		// One poll at a time. The timeout is several intervals long, so without this two polls
		// can be in flight at once and the SECOND can answer first - leaving the first to
		// overwrite fresh state with stale state and bump lastContactAt while doing it. On a
		// system whose cardinal sin is a false OFF, that is not a race worth leaving open.
		this.polling = false
		this.stopping = false

		this.setActionDefinitions(this.buildActions())
		this.setFeedbackDefinitions(this.buildFeedbacks())
		this.setVariableDefinitions(this.buildVariables())

		// CROSSING A THRESHOLD IS A CHANGE WITH NOTHING ARRIVING TO ANNOUNCE IT. Every other
		// redraw in this module is triggered by a payload; this one cannot be, because the
		// whole point is that payloads have stopped. Without it a dead server leaves every
		// button frozen on its last confident reading forever.
		//
		// It also runs the stream watchdog, for the same reason: nothing arrives to say that
		// nothing is arriving.
		this.livenessTimer = setInterval(() => this.tick(), 1000)
		this.livenessTimer.unref?.()

		await this.refreshTable()
		// COLD READ. Before #72 the module had no state at all until the first stream event,
		// so a Stream Deck came up blank against a perfectly healthy server whose state had
		// not changed recently. The poll answers on startup, not on the next change.
		await this.poll()
		// A SERVER THAT NEVER ANSWERED still owes the operator a connection light. Nothing
		// below this line will publish one on its own: the liveness timer only speaks on a
		// TRANSITION, and 'no data' is where lastConnection starts.
		this.publishStatus()
		this.startPolling()
		this.connectStream()
	}

	async destroy() {
		this.stopping = true
		if (this.retryTimer) clearTimeout(this.retryTimer)
		if (this.livenessTimer) clearInterval(this.livenessTimer)
		if (this.pollTimer) clearInterval(this.pollTimer)
		if (this.abort) this.abort.abort()
	}

	async configUpdated(config) {
		this.config = config ?? {}
		if (this.abort) this.abort.abort()
		if (this.retryTimer) clearTimeout(this.retryTimer)
		if (this.pollTimer) clearInterval(this.pollTimer)

		// FORGET THE PREVIOUS SERVER. `host` may have just changed, and carrying the old box's
		// state across would present one server's answer as though the new one had given it -
		// with `lastContactAt` recent, so every threshold reads healthy against a machine this
		// instance has never reached. Dropping to 'no data' is the fail-CLOSED direction.
		this.current = null
		this.lastContactAt = 0
		this.lastStreamAt = 0
		this.streamOpen = false
		this.lastConnection = 'no data'
		this.fault = null
		// Cleared too, or publishStatus() suppresses the first status after the change as a
		// duplicate and a fault message from the OLD config sticks on the connection light
		// forever.
		this.lastStatusKey = null

		await this.refreshTable()
		await this.poll()
		this.publishStatus()
		this.publishVariables()
		this.checkAll()
		this.startPolling()
		this.connectStream()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'intro',
				width: 12,
				label: 'On-Air server',
				value:
					'Presets are generated from the server\'s state table and regenerate when it changes. ' +
					'The passphrase is required: this module holds a table, so it reads the gated endpoints.',
			},
			{ type: 'textinput', id: 'host', label: 'Host', width: 6, default: 'localhost', required: true },
			{
				type: 'textinput',
				id: 'port',
				label: 'Port',
				width: 3,
				default: '8484',
				regex: Regex.PORT,
				required: true,
			},
			{ type: 'textinput', id: 'passphrase', label: 'Passphrase', width: 12, required: true },
			{
				type: 'static-text',
				id: 'liveness-intro',
				width: 12,
				label: 'Losing the server',
				value:
					'This module judges its own connection (D-91). The server latches state and never ' +
					'decays it, so a state nobody has rewritten for hours is still the state - what these ' +
					'two thresholds measure is how long since the SERVER last answered. They are ' +
					'independent and both run from that same instant; the second is not counted from the ' +
					'first.',
			},
			{
				type: 'textinput',
				id: 'lost_ms',
				label: 'Say "not refreshing" after (ms)',
				width: 6,
				default: '60000',
				regex: Regex.NUMBER,
			},
			{
				type: 'textinput',
				id: 'no_data_ms',
				label: 'Give the state up after (ms)',
				width: 6,
				default: '1800000',
				regex: Regex.NUMBER,
			},
			{
				type: 'static-text',
				id: 'transport-intro',
				width: 12,
				label: 'Poll and stream',
				value:
					'The poll is what makes the state correct; the stream is what makes it instant. The ' +
					'contract\'s cadence is 1000 ms (range 250..60000). The stream watchdog reconnects a ' +
					'socket that is open but silent - the server sends a keep-alive every 15 s, so three ' +
					'missed ones is the default.',
			},
			{
				type: 'textinput',
				id: 'poll_ms',
				label: 'Poll GET /status every (ms)',
				width: 6,
				default: '1000',
				regex: Regex.NUMBER,
			},
			{
				type: 'textinput',
				id: 'stream_watchdog_ms',
				label: 'Reconnect a silent stream after (ms)',
				width: 6,
				default: '45000',
				regex: Regex.NUMBER,
			},
			{
				type: 'static-text',
				id: 'write-intro',
				width: 12,
				label: 'Writes',
				value:
					'A state write drives the physical light before it answers. Issue #68 measured 6.4 s ' +
					'for POST /state/{id} and 13.2 s for PUT /state against a panel that was powered off - ' +
					'and BOTH WRITES SUCCEEDED. The default clears that worst case with margin. A write ' +
					'that runs out of time is reported as an unknown outcome, never as a failure: the ' +
					'next poll says what actually happened.',
			},
			{
				type: 'textinput',
				id: 'write_timeout_ms',
				label: 'Give a write up after (ms)',
				width: 6,
				default: '20000',
				regex: Regex.NUMBER,
			},
		]
	}

	// ---- the clock, and everything that only a clock can notice -----------------------------

	tick() {
		if (this.stopping) return

		// THE STREAM WATCHDOG (#72). A socket that is open and silent is the failure the
		// server's 15 s keep-alive exists to expose, and until now the module consumed that
		// keep-alive only as a timestamp. Aborting the reader makes the fetch reject, which
		// lands in the existing retry path - so recovery is the code that already worked.
		//
		// Reconnecting from the stream's error handler was rejected: D-98 paid for that
		// lesson on /display, where onerror fires instantly against a downed server and a
		// reconnect inside it is a tight loop against a box that is already struggling.
		const watchdogMs = num(this.config.stream_watchdog_ms, 45000, 1)
		if (this.streamOpen && this.lastStreamAt !== 0 && Date.now() - this.lastStreamAt > watchdogMs) {
			this.log('warn', `stream silent for over ${watchdogMs} ms, reconnecting`)
			this.streamOpen = false
			if (this.abort) this.abort.abort()
			this.scheduleRetry(0)
		}

		const before = this.lastConnection
		const now = this.view().connection
		if (now === before) return
		this.lastConnection = now
		this.publishStatus()
		this.publishVariables()
		this.checkAll()
	}

	startPolling() {
		if (this.pollTimer) clearInterval(this.pollTimer)
		const every = num(this.config.poll_ms, 1000, 250)
		this.pollTimer = setInterval(() => {
			if (this.stopping) return
			void this.poll()
		}, every)
		this.pollTimer.unref?.()
	}

	/**
	 * THE CORRECTNESS PATH. `GET /status` at the contract's cadence, used as a cold read on
	 * startup and as the backstop thereafter. A failed poll deliberately says nothing: the
	 * thresholds in view() are what report a server that has stopped answering, and a poll
	 * that logs on every failure would produce one line a second against a downed box.
	 */
	async poll() {
		if (this.stopping || this.polling || !this.config.passphrase) return false
		this.polling = true
		try {
			const res = await fetch(`${this.base()}/status`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(Math.max(1000, num(this.config.poll_ms, 1000, 250) * 5)),
			})
			if (res.status === 401) {
				this.setFault(InstanceStatus.AuthenticationFailure, 'passphrase rejected')
				return false
			}
			if (!res.ok) return false
			const body = await res.json()
			// Re-checked AFTER the await: destroy() can land while this is in flight, and
			// publishing to a torn-down instance is a call into a host that has gone.
			if (this.stopping) return false
			this.ingest(body)
			return true
		} catch {
			return false
		} finally {
			this.polling = false
		}
	}

	/**
	 * THE ONE DOOR every status payload comes through, whichever transport carried it. The
	 * poll and the stream disagreeing about which of them is authoritative is exactly the bug
	 * this shape prevents.
	 */
	ingest(payload) {
		if (!payload || typeof payload !== 'object' || payload.state === undefined) return false

		this.current = payload
		// CONTACT. Only a parseable status payload counts: an unparseable one is not the
		// server talking to us, and counting it would let a server emitting garbage hold
		// every button confident forever - the fail-OPEN direction.
		this.lastContactAt = Date.now()
		this.clearFault()

		// tableVersion moves whenever the table is saved. That is the regeneration trigger -
		// no polling of the table, and no restart.
		if (payload.tableVersion !== undefined && payload.tableVersion !== this.tableVersion) {
			this.log('info', `table version ${this.tableVersion} -> ${payload.tableVersion}, regenerating`)
			void this.refreshTable()
		}

		this.publishStatus()
		this.publishVariables()
		this.checkAll()
		return true
	}

	checkAll() {
		this.checkFeedbacks(
			'state_is',
			'busy',
			'connection_lost',
			'no_data',
			'light_not_confirming',
			'light_disagrees',
			'held',
			'held_to_this_state',
		)
	}

	// ---- what Companion's own connection light says ------------------------------------------

	/**
	 * INSTANCE STATUS TRACKS THIS MODULE'S OWN VIEW (#72). Before this, `Ok` was set when the
	 * stream connected and never revisited, so the connection light stayed green while the
	 * deck was showing NO DATA. A fault (bad config, rejected passphrase) outranks the
	 * connection, because no threshold describes it.
	 */
	publishStatus() {
		let status
		let message
		if (this.fault) {
			;[status, message] = this.fault
		} else {
			const c = this.view().connection
			status =
				c === 'ok'
					? InstanceStatus.Ok
					: c === 'not refreshing'
						? InstanceStatus.UnknownWarning
						: InstanceStatus.ConnectionFailure
			message = c === 'ok' ? undefined : c
		}
		const key = `${status}|${message ?? ''}`
		if (key === this.lastStatusKey) return
		this.lastStatusKey = key
		this.updateStatus(status, message)
	}

	setFault(status, message) {
		this.fault = [status, message]
		this.publishStatus()
	}

	clearFault() {
		if (!this.fault) return
		this.fault = null
		this.publishStatus()
	}

	// ---- the view: the module's single source of truth about what it may claim ----------------

	/**
	 * THE CLIENT CONTRACT (D-91/D-92), and the module's single source of truth about what it
	 * is entitled to claim. Every variable and every feedback goes through here.
	 *
	 * Three conditions, both thresholds measured from the LAST TIME THE SERVER ANSWERED, on
	 * our own clock. Nothing reads a field off the wire to decide this: `stale` is gone from
	 * the server because it was a judgement, and `ageSeconds` is provenance about the WRITE,
	 * which decides nothing now that the server latches state.
	 */
	view() {
		const lostMs = num(this.config.lost_ms, 60000, 1)
		const noDataMs = num(this.config.no_data_ms, 1800000, 1)
		const gap = this.lastContactAt === 0 ? Infinity : Date.now() - this.lastContactAt
		const s = this.current

		// CONDITION 3, and the reserved row is deliberate. `unknown` carries `busy: true`
		// (D-34) because every degenerate path in this system lands on a conspicuous state,
		// never a calm one - a stream deck going dark because the server died is a false OFF
		// on a physical control, which is the failure this product exists to prevent.
		//
		// Its LOOK is the owner's, not ours (D-122, #75): the label and colours come from the
		// row in the table, so relabelling `unknown` to SERVER GONE reaches the Stream Deck
		// like it reaches every other renderer.
		if (!s || gap > noDataMs) {
			const row = this.reservedRow()
			return { state: row.id, label: row.label, busy: true, connection: 'no data', lostFor: gap }
		}
		// CONTRACT SECTION 6: "A renderer is handed an `id` it does not know -> it must draw the
		// `unknown` appearance. It must NEVER silently drop it - a state that degrades to
		// nothing looks exactly like a calm one." An empty label was that silent drop.
		const row = this.states.find((r) => r.id === s.state) ?? this.reservedRow()
		// CONDITION 2 holds the last known state unchanged and says so through `connection`.
		// It does NOT rewrite `busy`: the state has not changed, the server latches it, and
		// the honest report is the state we last heard plus the fact that we are no longer
		// hearing it.
		return {
			state: s.state,
			label: row.label ?? '',
			busy: s.busy === true,
			connection: gap > lostMs ? 'not refreshing' : 'ok',
			lostFor: gap,
		}
	}

	/**
	 * The reserved row as the OWNER has it. The literal is the bootstrap only - before the
	 * first table pull there is no row to read, and that is the one moment it can be reached.
	 */
	reservedRow() {
		return (
			this.states.find((r) => r.id === RESERVED_ID) ?? {
				id: RESERVED_ID,
				label: 'NO DATA',
				color: '#ffffff',
				bgcolor: '#000000',
				busy: true,
			}
		)
	}

	/// The `confirmed` verdict (#74), as two distinct faults rather than one lamp.
	confirmation() {
		const s = this.current
		const v = this.view()
		// With no data at all, or with the state given up, `confirmed` is about a state we are
		// no longer claiming. Saying the light disagrees with a state we have withdrawn would
		// put a second alarm on the same fact.
		if (!s || v.connection === 'no data') return 'none'
		const c = s.confirmed
		if (c === undefined || c === null || c === '' || c === RESERVED_ID) return 'unconfirmed'
		return c === v.state ? 'agrees' : 'disagrees'
	}

	base() {
		const host = String(this.config.host || 'localhost').trim()
		const port = String(this.config.port || '8484').trim()
		return `http://${host}:${port}`
	}

	headers() {
		// Authorization: Bearer is the contract's preferred form for anything that can send a
		// header. `?passphrase=` exists only for EventSource and the WebSocket upgrade, which
		// cannot - and this module uses fetch, which can.
		const pass = String(this.config.passphrase || '')
		return pass ? { Authorization: `Bearer ${pass}` } : {}
	}

	// ---- the state table, which is where presets come from ------------------------------

	async refreshTable() {
		if (!this.config.passphrase) {
			this.setFault(InstanceStatus.BadConfig, 'passphrase required')
			return false
		}
		try {
			const res = await fetch(`${this.base()}/config/states`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(5000),
			})
			if (res.status === 401) {
				this.setFault(InstanceStatus.AuthenticationFailure, 'passphrase rejected')
				return false
			}
			if (!res.ok) {
				this.log('error', `GET /config/states -> ${res.status}`)
				return false
			}
			const body = await res.json()
			this.states = Array.isArray(body.states) ? body.states : []
			this.tableVersion = body.version ?? null
			this.clearFault()
			this.log('info', `state table v${this.tableVersion}, ${this.states.length} rows`)

			// Definitions are repeatedly callable and diff-patched to the UI, so regenerating
			// costs nothing and needs no restart.
			this.setActionDefinitions(this.buildActions())
			this.setFeedbackDefinitions(this.buildFeedbacks())
			this.setVariableDefinitions(this.buildVariables())
			this.setPresetDefinitions(this.buildPresets())
			this.publishVariables()
			this.checkAll()
			return true
		} catch (err) {
			this.log('error', `state table: ${err.message}`)
			return false
		}
	}

	// ---- the live state stream ----------------------------------------------------------

	connectStream() {
		if (this.stopping || !this.config.passphrase) return
		this.abort = new AbortController()
		const abort = this.abort

		// SSE parsed by hand rather than with EventSource, because fetch can carry the
		// Authorization header and EventSource cannot. One connection at a time.
		fetch(`${this.base()}/events`, {
			headers: { ...this.headers(), Accept: 'text/event-stream' },
			signal: abort.signal,
		})
			.then(async (res) => {
				if (res.status === 401) {
					this.setFault(InstanceStatus.AuthenticationFailure, 'passphrase rejected')
					return this.scheduleRetry(30000)
				}
				if (!res.ok || !res.body) {
					this.log('error', `GET /events -> ${res.status}`)
					return this.scheduleRetry()
				}
				// OPENING A SOCKET IS NOT CONTACT (D-98). The watchdog clock starts here so a
				// stream that connects and then says nothing is caught; `lastContactAt` still
				// moves only on a parseable payload.
				this.streamOpen = true
				this.lastStreamAt = Date.now()
				const reader = res.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ''
				for (;;) {
					const { value, done } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					let cut
					while ((cut = buffer.indexOf('\n\n')) !== -1) {
						this.handleEvent(buffer.slice(0, cut))
						buffer = buffer.slice(cut + 2)
					}
				}
				if (this.abort === abort) this.streamOpen = false
				if (!this.stopping) this.scheduleRetry()
			})
			.catch((err) => {
				// Only if this is still the live connection: the watchdog replaces the
				// controller before this rejection lands, and clearing the new stream's flag
				// from the old stream's failure would make the watchdog fire again at once.
				if (this.abort === abort) this.streamOpen = false
				if (this.stopping) return
				// An AbortError here is either destroy() or the watchdog, and the watchdog has
				// already scheduled its own reconnect.
				if (err.name === 'AbortError') return
				this.log('error', `stream: ${err.message}`)
				this.scheduleRetry()
			})
	}

	scheduleRetry(ms = 5000) {
		if (this.stopping) return
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = setTimeout(() => this.connectStream(), ms)
		this.retryTimer.unref?.()
	}

	handleEvent(chunk) {
		const dataLines = chunk
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trim())
		if (!dataLines.length) return
		let payload
		try {
			payload = JSON.parse(dataLines.join('\n'))
		} catch {
			return // a keep-alive comment, or something not for us
		}
		// The watchdog is satisfied by the stream being ALIVE, which a keep-alive `status`
		// event proves even when the payload is one this module cannot use.
		this.lastStreamAt = Date.now()
		this.ingest(payload)
	}

	// ---- variables ------------------------------------------------------------------------

	buildVariables() {
		return [
			{ variableId: 'state', name: 'Current state id' },
			{ variableId: 'label', name: 'Current state label' },
			{ variableId: 'busy', name: 'Busy (yes/no)' },
			{ variableId: 'confirmed', name: 'Confirmed by the light' },
			{ variableId: 'hold', name: 'Held state id (empty when nothing is pinned)' },
			{ variableId: 'hold_label', name: 'Held state label (empty when nothing is pinned)' },
			{ variableId: 'source', name: 'Who wrote the state' },
			// BREAKING: `stale` is gone, not renamed. It was a judgement the server no longer
			// makes, and a variable that silently resolves to nothing on a stream deck is worse
			// than one that is loudly absent.
			{ variableId: 'connection', name: 'Connection to the server (ok / not refreshing / no data)' },
			{ variableId: 'seconds_since_contact', name: 'Seconds since the server last answered' },
			{ variableId: 'age_seconds', name: 'Seconds since the last write (provenance only)' },
			{ variableId: 'table_version', name: 'State table version' },
		]
	}

	publishVariables() {
		const s = this.current
		const v = this.view()
		const held = s?.hold ?? null
		this.setVariableValues({
			state: v.state,
			label: v.label,
			busy: v.busy ? 'yes' : 'no',
			confirmed: s?.confirmed ?? '',
			hold: held ?? '',
			hold_label: held ? (this.states.find((r) => r.id === held)?.label ?? held) : '',
			source: s?.source ?? '',
			connection: v.connection,
			seconds_since_contact: Number.isFinite(v.lostFor) ? Math.floor(v.lostFor / 1000) : '',
			age_seconds: s?.ageSeconds ?? '',
			table_version: this.tableVersion ?? '',
		})
	}

	// ---- actions ---------------------------------------------------------------------------

	buildActions() {
		const choices = this.stateChoices()
		return {
			set_state: {
				name: 'Set state',
				options: [
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						default: choices[0]?.id ?? '',
						choices,
						allowCustom: true,
					},
					{
						// THE PIN, MADE EXPLICIT (D-120, #73). `leave` is what every existing
						// button already does, so an upgrade changes nothing until an operator
						// asks it to.
						type: 'dropdown',
						id: 'hold',
						label: 'Hold',
						default: 'leave',
						choices: [
							{ id: 'leave', label: 'Leave the hold alone' },
							{ id: 'pin', label: 'Pin to this state' },
							{ id: 'release', label: 'Release the hold' },
						],
					},
				],
				callback: async (event) => {
					const id = await this.parseVariablesInString(String(event.options.state ?? ''))
					await this.setState(id, { hold: String(event.options.hold ?? 'leave') })
				},
			},
			pin_current_state: {
				name: 'Pin the current state (hold)',
				options: [],
				callback: async () => {
					// `current.state`, not `view().state`: once the module has given the state
					// up, view() reports the RESERVED row, and pinning `unknown` would freeze
					// every renderer on NO DATA until a human noticed.
					if (!this.current || this.view().connection === 'no data') {
						this.log('warn', 'pin: no fresh state from the server, refusing to pin')
						return
					}
					await this.setState(this.current.state, { hold: 'pin' })
				},
			},
			release_hold: {
				name: 'Release the hold',
				options: [],
				callback: async () => {
					const held = this.current?.hold ?? null
					if (!held) {
						this.log('info', 'release hold: nothing is pinned')
						return
					}
					// RELEASING MUST NOT MOVE THE LIGHT, and the row it writes is what decides
					// that. `POST /state/{id}` ALWAYS sets the row named in the path - there is
					// no clear-the-pin-only route - so writing the HELD row here would drag the
					// light back to it.
					//
					// That is a FALSE OFF in the contract's own worked example: pin
					// `interruptible` (busy false), let the detector escalate to `on-air` (busy
					// true, camera live, pin survives by the carve-out), then press UNPIN. The
					// held row is calm and the live row is not. Writing the CURRENT row instead
					// is idempotent - the state it names is the state already showing - so the
					// pin goes and nothing else moves.
					const v = this.view()
					if (v.connection === 'no data') {
						this.log('warn', 'release hold: no fresh data from the server, refusing to write')
						return
					}
					await this.setState(this.current.state, { hold: 'release' })
				},
			},
			refresh_table: {
				name: 'Refresh the state table now',
				options: [],
				callback: async () => {
					await this.refreshTable()
				},
			},
		}
	}

	stateChoices() {
		const choices = this.states.map((r) => ({ id: r.id, label: `${r.label} (${r.id})` }))
		return choices.length ? choices : [{ id: '', label: '(no table yet)' }]
	}

	/**
	 * `hold` is `leave` | `pin` | `release`, mapped onto the contract's `?hold=1` / `?hold=0`
	 * / absent.
	 */
	async setState(id, { hold = 'leave' } = {}) {
		if (!id) {
			this.log('warn', 'set state: no state id')
			return
		}

		// A PRESS THAT DROPS A PIN SAYS SO (D-120, #73). The module sends an unprefixed
		// `source`, which the server reads as `human:companion` - and section 3's PIN RULE
		// says a human write naming a state other than the held one releases the hold. That
		// is the correct rule (a thumb on a physical key IS a human) and calling this
		// automation to dodge it would make `source` lie. The defect was that it happened in
		// silence.
		const held = this.current?.hold ?? null
		if (held && hold === 'leave' && held !== id) {
			this.log(
				'warn',
				`set state "${id}" releases the hold on "${held}" - a human write naming another state ` +
					`clears the pin (contract section 3). Use the Hold option if that was not intended.`,
			)
		}

		const params = new URLSearchParams({ source: 'companion' })
		if (hold === 'pin') params.set('hold', '1')
		else if (hold === 'release') params.set('hold', '0')

		const timeout = num(this.config.write_timeout_ms, 20000, 1000)
		try {
			const res = await fetch(`${this.base()}/state/${encodeURIComponent(id)}?${params}`, {
				method: 'POST',
				headers: this.headers(),
				signal: AbortSignal.timeout(timeout),
			})
			if (this.stopping) return
			if (res.ok) {
				// PUBLISH FROM THE RESPONSE (D-121, #74). The server answers a write with the
				// full GET /status body, AFTER the write and AFTER the light attempt - so it
				// already carries `confirmed`, `hold` and `source`. Waiting for the stream to
				// echo them means a press that failed to reach the lamp shows the fault
				// whenever the next event happens to arrive, instead of immediately.
				try {
					this.ingest(await res.json())
				} catch {
					/* a 200 with an unreadable body; the poll will settle it */
				}
				return
			}

			// A button bound to a row the server no longer has must SAY SO. The server hands
			// back the list of ids that would have worked, and putting that in front of the
			// operator is the difference between "the button is broken" and "that row is gone,
			// here is what exists".
			//
			// There is deliberately no 409 branch here. A 409 on this route is the pin rule
			// refusing an AUTOMATED write, and this module's writes are `human:companion` -
			// a human write always applies (contract section 3). A branch for it would be
			// unreachable code claiming to handle a case that cannot arrive.
			let detail = `${res.status}`
			try {
				const body = await res.json()
				if (body?.error) detail = body.error
				if (Array.isArray(body?.validStates) && body.validStates.length) {
					detail += ` - valid states: ${body.validStates.join(', ')}`
				}
			} catch {
				/* no JSON body; the status alone is what we have */
			}
			this.log('error', `set state "${id}" failed: ${detail}`)
		} catch (err) {
			// A TIMEOUT IS AN UNKNOWN OUTCOME, NOT A FAILURE (D-123, #76). Issue #68 measured
			// two writes that blocked for 6.4 s and 13.2 s against a powered-off panel and
			// BOTH SUCCEEDED. Reporting that as a failed write, and dropping the whole
			// instance to ConnectionFailure, told the operator the opposite of the truth.
			// Section 7: clients that care check `confirmed`, not the status code.
			if (err.name === 'TimeoutError') {
				this.log(
					'warn',
					`set state "${id}": no answer within ${timeout} ms. The write may still have ` +
						`succeeded - the next poll will say. Not retrying: the server latches.`,
				)
				return
			}
			this.log('error', `set state "${id}" failed: ${err.message}`)
		}
	}

	// ---- feedbacks --------------------------------------------------------------------------

	buildFeedbacks() {
		const choices = this.stateChoices()
		const reserved = this.reservedRow()
		const white = combineRgb(255, 255, 255)
		const black = combineRgb(0, 0, 0)
		return {
			state_is: {
				type: 'boolean',
				name: 'State is',
				description: 'True when the light is showing this state',
				defaultStyle: { color: white, bgcolor: combineRgb(193, 18, 31) },
				options: [
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						default: choices[0]?.id ?? '',
						choices,
						allowCustom: true,
					},
				],
				// Through view(), not through `current`, so a button stops claiming its row once
				// the module has given the state up. Reading `current` directly here would leave
				// a stream deck lit for the last row it heard about, indefinitely.
				callback: (feedback) => this.view().state === feedback.options.state,
			},
			busy: {
				type: 'boolean',
				name: 'Busy',
				description:
					'True when the current row is busy. This is the server\'s own flag, not a colour test - ' +
					'THE BUSY RULE (D-32) is what it means.',
				defaultStyle: { color: white, bgcolor: combineRgb(193, 18, 31) },
				options: [],
				callback: () => this.view().busy,
			},
			// FOUR FEEDBACKS IN THE "SOMETHING IS OFF" FAMILY, FOUR DISTINCT LOOKS (#74). An
			// operator who cannot tell them apart at a glance has four feedbacks that mean one
			// thing. Amber = the server went quiet. The reserved row's own colours = we gave the
			// state up. Navy = no evidence from the lamp. White = the lamp says something else.
			connection_lost: {
				type: 'boolean',
				name: 'Not refreshing',
				description:
					'True when the server has not answered for longer than the configured window. The ' +
					'state shown is the last one it reported, not a current reading.',
				defaultStyle: { color: black, bgcolor: combineRgb(232, 163, 23) },
				options: [],
				callback: () => this.view().connection === 'not refreshing',
			},
			no_data: {
				type: 'boolean',
				name: 'No data',
				description:
					'True once the server has been silent long enough that the module has given the ' +
					'state up entirely. Drawn in the reserved row\'s own colours, as the owner set them.',
				// THE OWNER'S COLOURS, NOT OURS (D-122, #75). This used to be a magenta literal
				// that happened to match the seed `unknown` row rather than being read from it.
				defaultStyle: { color: rgb(reserved.color, white), bgcolor: rgb(reserved.bgcolor, black) },
				options: [],
				callback: () => this.view().connection === 'no data',
			},
			light_not_confirming: {
				type: 'boolean',
				name: 'Light not confirming',
				description:
					'True when the server has no evidence from the light: `confirmed` reads unknown. The ' +
					'panel is unreachable or frozen. This is the server admitting ignorance, not a claim ' +
					'that the light is wrong.',
				defaultStyle: { color: white, bgcolor: combineRgb(27, 64, 121) },
				options: [],
				callback: () => this.confirmation() === 'unconfirmed',
			},
			light_disagrees: {
				type: 'boolean',
				name: 'Light disagrees',
				description:
					'True when the light acknowledges a row the server did not ask for. A different fault ' +
					'from "not confirming", with a different fix.',
				defaultStyle: { color: black, bgcolor: white },
				options: [],
				callback: () => this.confirmation() === 'disagrees',
			},
			held: {
				type: 'boolean',
				name: 'A hold is in force',
				description: 'True whenever any row is pinned, whichever row it is.',
				defaultStyle: { color: black, bgcolor: combineRgb(142, 202, 230) },
				options: [],
				callback: () => Boolean(this.current?.hold),
			},
			held_to_this_state: {
				type: 'boolean',
				name: 'Held to this state',
				description: 'True when the hold pins the row this button sets.',
				defaultStyle: { color: black, bgcolor: combineRgb(142, 202, 230) },
				options: [
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						default: choices[0]?.id ?? '',
						choices,
						allowCustom: true,
					},
				],
				callback: (feedback) => Boolean(this.current?.hold) && this.current.hold === feedback.options.state,
			},
		}
	}

	// ---- presets, generated from the table --------------------------------------------------

	buildPresets() {
		const presets = {}
		for (const row of this.states) {
			const color = rgb(row.color, combineRgb(255, 255, 255))
			const bgcolor = rgb(row.bgcolor, combineRgb(0, 0, 0))
			// STABLE ID, keyed on the row id and nothing else. Row ids are immutable (D-31) and
			// index never appears (D-34), so a preset keeps its identity across a table edit -
			// which is what makes 5.1's live-linked preset references work when they land.
			presets[`state_${row.id}`] = {
				type: 'button',
				category: 'States',
				name: row.label,
				// AT REST the row is dimmed; `state_is` lights it in full. The button therefore
				// SAYS something by changing, which is the whole job of a state indicator.
				style: {
					text: row.label, // the caption field is `label`; there is no `row.text`
					size: 'auto',
					color,
					bgcolor: dim(bgcolor),
				},
				steps: [{ down: [{ actionId: 'set_state', options: { state: row.id, hold: 'leave' } }], up: [] }],
				// ORDER IS THE PRIORITY (D-122, #75). Later feedbacks win, so the state's own
				// colours are laid down first, the pin badge next, and the two connection marks
				// last: dark-because-dead must never be painted over by anything.
				feedbacks: [
					{
						feedbackId: 'state_is',
						options: { state: row.id },
						// Lit in the row's OWN colours, dimmed when it is not the current state, so a
						// deck of buttons reads as one indicator rather than five.
						style: { color, bgcolor },
					},
					{
						feedbackId: 'held_to_this_state',
						options: { state: row.id },
						// The badge keeps the row's colours and changes the caption, so a pinned
						// button still reads as its own state - it just says it is pinned.
						style: { text: `PIN\n${row.label}`, size: 'auto', color, bgcolor: dim(bgcolor) },
					},
					{
						feedbackId: 'connection_lost',
						options: {},
						style: { color: combineRgb(0, 0, 0), bgcolor: combineRgb(232, 163, 23) },
					},
					{
						feedbackId: 'no_data',
						options: {},
						style: {
							text: this.reservedRow().label,
							size: 'auto',
							color: rgb(this.reservedRow().color, combineRgb(255, 255, 255)),
							bgcolor: rgb(this.reservedRow().bgcolor, combineRgb(0, 0, 0)),
						},
					},
				],
			}
		}

		if (this.states.length) {
			presets.pin = {
				type: 'button',
				category: 'Utility',
				name: 'Pin the current state',
				style: { text: 'PIN', size: '18', color: combineRgb(0, 0, 0), bgcolor: combineRgb(142, 202, 230) },
				steps: [{ down: [{ actionId: 'pin_current_state', options: {} }], up: [] }],
				feedbacks: [{ feedbackId: 'held', options: {} }],
			}
			presets.unpin = {
				type: 'button',
				category: 'Utility',
				name: 'Release the hold',
				style: { text: 'UNPIN', size: '18', color: combineRgb(255, 255, 255), bgcolor: combineRgb(60, 60, 60) },
				steps: [{ down: [{ actionId: 'release_hold', options: {} }], up: [] }],
				feedbacks: [{ feedbackId: 'held', options: {} }],
			}
			presets.light = {
				type: 'button',
				category: 'Utility',
				name: 'Light health',
				style: { text: 'LIGHT\nOK', size: '14', color: combineRgb(255, 255, 255), bgcolor: combineRgb(11, 110, 46) },
				steps: [{ down: [], up: [] }],
				// Full styles, not partial ones: a preset feedback with a `style` replaces the
				// feedback's defaultStyle rather than merging into it, so a text-only override
				// would drop the colour that makes the two faults distinguishable.
				feedbacks: [
					{
						feedbackId: 'light_not_confirming',
						options: {},
						style: {
							text: 'LIGHT\nNO ACK',
							size: '14',
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(27, 64, 121),
						},
					},
					{
						feedbackId: 'light_disagrees',
						options: {},
						style: {
							text: 'LIGHT\nDISAGREES',
							size: '14',
							color: combineRgb(0, 0, 0),
							bgcolor: combineRgb(255, 255, 255),
						},
					},
				],
			}
		}

		presets.refresh = {
			type: 'button',
			category: 'Utility',
			name: 'Refresh table',
			style: { text: 'REFRESH\nTABLE', size: '14', color: combineRgb(255, 255, 255), bgcolor: combineRgb(40, 40, 40) },
			steps: [{ down: [{ actionId: 'refresh_table', options: {} }], up: [] }],
			feedbacks: [],
		}
		return presets
	}
}

runEntrypoint(OnAirInstance, [])
