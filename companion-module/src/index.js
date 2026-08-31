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
// shape, and it carries no `confirmed` and no `source`. This module generates
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

import { ICONS } from './icons.js'

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

/// WCAG relative luminance of a packed colour.
function luminance(packed) {
	const chan = (c) => {
		const s = c / 255
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * chan((packed >> 16) & 255) + 0.7152 * chan((packed >> 8) & 255) + 0.0722 * chan(packed & 255)
}

/// WCAG contrast ratio. 1 is invisible, 21 is black on white, 4.5 is the AA floor for text.
function contrast(a, b) {
	const la = luminance(a)
	const lb = luminance(b)
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The caption colour that can actually be read on `bgcolor` (#92).
 *
 * THE TABLE'S COLOURS ARE STILL USED VERBATIM (D-31, D-42) - `preferred` wins whenever it
 * clears AA, and on the LIT button it always does, because the owner chose those two colours
 * for each other. This exists for the button at REST, whose background is `dim()` of the
 * owner's colour and is therefore a colour the owner never picked ink for.
 *
 * INTERRUPTIBLE is the case that forced it: #1a1a1a on amber quartered to #3a2805 measures
 * 1.23:1. Not "a bit dim" - invisible. Nothing in the module noticed, because nothing was
 * measuring; the row's own colour was simply assumed to work everywhere it was pasted.
 */
function readableInk(preferred, bgcolor) {
	if (contrast(preferred, bgcolor) >= 4.5) return preferred
	const white = combineRgb(255, 255, 255)
	const black = combineRgb(0, 0, 0)
	return contrast(white, bgcolor) >= contrast(black, bgcolor) ? white : black
}

/// The art for `name`, inked for whatever `bgcolor` it is about to be drawn on. Undefined when
/// there is no icon for that name, which a caller must treat as "no picture", not as an error.
function icon(name, bgcolor) {
	const art = ICONS[name]
	if (!art) return undefined
	const white = combineRgb(255, 255, 255)
	const black = combineRgb(0, 0, 0)
	return contrast(white, bgcolor) >= contrast(black, bgcolor) ? art.light : art.dark
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

	/// The `confirmed` verdict (#74), as distinct faults rather than one lamp.
	///
	/// FOUR VERDICTS SINCE #82, not three. The panel goes black on a schedule, so `confirmed`
	/// reads unknown for eight hours every night by design - and a button that lights
	/// "not confirming" from 23:00 to 07:00 about a panel that is working perfectly is a lamp
	/// you learn to ignore, which is worse than no lamp at all.
	///
	/// `asleep` is read from `confirmedReason`, which the server omits whenever it cannot name
	/// a reason. So this defaults to `unconfirmed`: nothing here turns an unexplained unknown
	/// into a reassurance, which would be a false OK - the same family of failure as a false OFF.
	confirmation() {
		const s = this.current
		const v = this.view()
		// With no data at all, or with the state given up, `confirmed` is about a state we are
		// no longer claiming. Saying the light disagrees with a state we have withdrawn would
		// put a second alarm on the same fact.
		if (!s || v.connection === 'no data') return 'none'
		const c = s.confirmed
		if (c === undefined || c === null || c === '' || c === RESERVED_ID) {
			return s.confirmedReason === 'asleep' ? 'asleep' : 'unconfirmed'
		}
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
			{ variableId: 'confirmed_reason', name: 'Why confirmed is unknown (asleep / not-repainting / unreachable)' },
			{ variableId: 'source', name: 'Who wrote the state' },
			// BREAKING: `stale` is gone, not renamed. It was a judgement the server no longer
			// makes, and a variable that silently resolves to nothing on a stream deck is worse
			// than one that is loudly absent.
			//
			// BREAKING (D-126): `hold` and `hold_label` went the same way when the pin was
			// retired. There is no held row to name any more - the last write wins - so a
			// caption referencing $(rocket-onair:hold) resolves to nothing and must be edited
			// by hand.
			{ variableId: 'connection', name: 'Connection to the server (ok / not refreshing / no data)' },
			{ variableId: 'seconds_since_contact', name: 'Seconds since the server last answered' },
			{ variableId: 'age_seconds', name: 'Seconds since the last write (provenance only)' },
			{ variableId: 'table_version', name: 'State table version' },
		]
	}

	publishVariables() {
		const s = this.current
		const v = this.view()
		this.setVariableValues({
			state: v.state,
			label: v.label,
			busy: v.busy ? 'yes' : 'no',
			confirmed: s?.confirmed ?? '',
			// Empty when the server named no reason, which is most of the time. A button that
			// shows `confirmed` alone reads "unknown" all night with no way to tell a healthy
			// dark panel from a dead one; this is that way (#82).
			confirmed_reason: s?.confirmedReason ?? '',
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
				],
				callback: async (event) => {
					const id = await this.parseVariablesInString(String(event.options.state ?? ''))
					await this.setState(id)
				},
			},
			cycle_state: {
				name: 'Cycle to the next state',
				description:
					'Walks the selected rows in table order and wraps, so one key replaces a row of ' +
					'them: press until the state you want comes up. The SERVER decides which row is ' +
					'next, from the ring this button sends - so three fast presses advance three ' +
					'stops rather than all computing the same one from a status that has not caught ' +
					'up yet. A state the ring does not name (NO DATA at boot) goes to the first entry.',
				options: [
					{
						type: 'multidropdown',
						id: 'ring',
						label: 'States in the cycle',
						// Everything but the reserved row. NO DATA is the server saying it does not
						// know; it is not a state a person chooses, and a cycle that stops there
						// would be asserting ignorance on purpose.
						default: this.states.filter((r) => r.id !== RESERVED_ID).map((r) => r.id),
						choices,
					},
				],
				callback: async (event) => {
					// SORTED BACK INTO TABLE ORDER. The picker hands back the order they were
					// CLICKED, which would make the cycle depend on how somebody filled in a form
					// months ago. The order that means something is the owner's, from the table.
					const picked = new Set(Array.isArray(event.options.ring) ? event.options.ring : [])
					await this.cycleState(this.states.map((r) => r.id).filter((id) => picked.has(id)))
				},
			},
			panel_sleep: {
				name: 'Panel: sleep (darken the glass)',
				description:
					'Asks the panel to turn its glass off now, independently of the nightly schedule. ' +
					'The panel REFUSES while the current row is busy, so this does nothing during a ' +
					'call - and a call starting while it is asleep lights it. It also clears itself at ' +
					'the panel\'s scheduled wake time. Watch $(confirmed_reason) or the "Panel asleep ' +
					'on schedule" feedback for what actually happened.',
				options: [],
				callback: async () => {
					await this.panelSleep(true)
				},
			},
			panel_wake: {
				name: 'Panel: wake (light the glass)',
				description: 'Asks the panel to turn its glass back on. Always allowed - waking is never refused.',
				options: [],
				callback: async () => {
					await this.panelSleep(false)
				},
			},
			panel_toggle: {
				name: 'Panel: sleep/wake toggle',
				description:
					'One button for both. The SERVER reads the panel\'s glass and sends the opposite - ' +
					'dark wakes, lit sleeps - so this button keeps no memory of its own presses and cannot ' +
					'drift out of step with the panel. A sleep refused by a busy row leaves the next press ' +
					'still meaning sleep, and a panel already dark on its nightly schedule wakes.',
				options: [],
				callback: async () => {
					await this.panelSleep('toggle')
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
	 * Darken or light the panel's glass (#91).
	 *
	 * NOT A STATE WRITE, and the distinction is the whole of it: `state`, `source` and
	 * `updatedAt` are untouched. The light goes on holding whatever row it was asserting; it
	 * simply stops showing it. So there is nothing to `ingest()` from the response and no
	 * variable to publish here - what changed shows up as `confirmedReason` on the next poll.
	 *
	 * `delivered:false` is a real outcome and not an exception. It means the server could not
	 * reach the panel, which is the same thing `confirmed: unknown` says about a state write,
	 * and it is logged rather than raised for the same reason (D-123): the operator wants to
	 * know, and the instance is not broken.
	 */
	async panelSleep(command) {
		// `true`/`false` from the two one-way buttons, `'toggle'` from the one-button form. The
		// booleans are kept rather than replaced with strings so #91's two actions read the same
		// as they always did at their call sites.
		const what = command === 'toggle' ? 'toggle' : command ? 'sleep' : 'wake'
		const timeout = num(this.config.write_timeout_ms, 20000, 1000)
		try {
			const res = await fetch(`${this.base()}/panel/${what}`, {
				method: 'POST',
				headers: this.headers(),
				signal: AbortSignal.timeout(timeout),
			})
			if (this.stopping) return
			if (res.ok) {
				let delivered = null
				let asked = null
				try {
					const body = await res.json()
					delivered = body?.delivered ?? null
					asked = body?.asked ?? null
				} catch {
					/* a 200 with an unreadable body; the poll will settle it */
				}
				if (delivered === false) {
					this.log('warn', `panel ${what}: the server could not reach the panel. Nothing changed on the glass.`)
				} else if (what === 'toggle' && asked) {
					// WHICH WAY IT WENT IS THE ONE THING A TOGGLE CANNOT SHOW ON ITS OWN FACE. The
					// server decided, from a reading this module never saw; logging its answer is
					// what makes a press that did the opposite of what the operator expected
					// explainable afterwards instead of a mystery.
					this.log('info', `panel toggle: the glass was ${asked === 'sleep' ? 'lit' : 'dark'}, sent ${asked}`)
				}
				// A SUCCESSFUL SLEEP IS NOT A DARK PANEL. The panel refuses while the row is
				// busy, so the honest thing to report is that we asked. The answer arrives as
				// confirmedReason on the next poll, which is where the feedback reads it.
				void this.poll()
				return
			}
			let detail = `${res.status}`
			try {
				const body = await res.json()
				if (body?.error) detail = body.error
			} catch {
				/* no JSON body; the status alone is what we have */
			}
			// 501 is the one worth recognising: an older server, or one wired to a driver that
			// models no device. Nothing the operator can fix from the deck, but "not supported"
			// beats a bare number.
			this.log('error', `panel ${what} failed: ${detail}`)
		} catch (err) {
			if (err.name === 'TimeoutError') {
				this.log('warn', `panel ${what}: no answer within ${timeout} ms. It may still have landed.`)
				return
			}
			this.log('error', `panel ${what} failed: ${err.message}`)
		}
	}

	async setState(id) {
		if (!id) {
			this.log('warn', 'set state: no state id')
			return
		}

		// A PRESS IS JUST A WRITE (D-126). It used to have to warn that it might silently clear
		// somebody's pin; there is no pin now, so LAST WRITE WINS is the whole rule - this write
		// lands, and the detector's next one replaces it.
		const params = new URLSearchParams({ source: 'companion' })
		await this.postWrite(`/state/${encodeURIComponent(id)}?${params}`, `set state "${id}"`)
	}

	/**
	 * ADVANCE ONE STOP AROUND A RING OF ROWS (#93).
	 *
	 * The ring goes ON THE WIRE and the SERVER decides which row is next, which is the whole
	 * design and not an implementation detail. This module has `state` from a stream that is
	 * usually fresh, so computing the successor here would pass every test - and then fail in
	 * the field, because the way a human uses this button is three fast jabs to get two rows
	 * along. All three land inside one round trip, all three read the same `state`, and all
	 * three write the same successor. The server computes it inside its write queue, where each
	 * press can see the one before it.
	 */
	async cycleState(ring) {
		const ids = ring.filter((id) => typeof id === 'string' && id !== '')
		if (!ids.length) {
			this.log('warn', 'cycle state: no states selected on this button')
			return
		}
		const params = new URLSearchParams({ source: 'companion', ring: ids.join(',') })
		await this.postWrite(`/cycle?${params}`, `cycle state (${ids.join(' -> ')})`)
	}

	/**
	 * The one POST both state buttons make. Shared rather than duplicated because everything
	 * interesting about it is in the error handling - the 400 that lists the valid rows, and
	 * the timeout that is an unknown outcome rather than a failure - and a second copy would
	 * drift from this one exactly where it matters.
	 *
	 * `what` is the phrase for the log line, already naming what was attempted.
	 */
	async postWrite(path, what) {
		const timeout = num(this.config.write_timeout_ms, 20000, 1000)
		try {
			const res = await fetch(`${this.base()}${path}`, {
				method: 'POST',
				headers: this.headers(),
				signal: AbortSignal.timeout(timeout),
			})
			if (this.stopping) return
			if (res.ok) {
				// PUBLISH FROM THE RESPONSE (D-121, #74). The server answers a write with the
				// full GET /status body, AFTER the write and AFTER the light attempt - so it
				// already carries `confirmed` and `source`. Waiting for the stream to echo them
				// means a press that failed to reach the lamp shows the fault whenever the next
				// event happens to arrive, instead of immediately.
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
			// There is deliberately no 409 branch here. Since the pin was retired (D-126) no
			// write is ever refused - LAST WRITE WINS - and the only 409 this route can still
			// produce is `POST /on` or `/off` with no shortcut row configured, which this
			// module never calls. The generic error line below covers it if that ever changes.
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
			this.log('error', `${what} failed: ${detail}`)
		} catch (err) {
			// A TIMEOUT IS AN UNKNOWN OUTCOME, NOT A FAILURE (D-123, #76). Issue #68 measured
			// two writes that blocked for 6.4 s and 13.2 s against a powered-off panel and
			// BOTH SUCCEEDED. Reporting that as a failed write, and dropping the whole
			// instance to ConnectionFailure, told the operator the opposite of the truth.
			// Section 7: clients that care check `confirmed`, not the status code.
			if (err.name === 'TimeoutError') {
				this.log(
					'warn',
					`${what}: no answer within ${timeout} ms. The write may still have ` +
						`succeeded - the next poll will say. Not retrying: the server latches.`,
				)
				return
			}
			this.log('error', `${what} failed: ${err.message}`)
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
					'True when the server has no evidence from the light: `confirmed` reads unknown and the ' +
					'panel is unreachable, frozen, or unexplained. This is the server admitting ignorance, ' +
					'not a claim that the light is wrong. It is FALSE while the panel is dark on its night ' +
					'schedule - that is healthy, and there is a separate feedback for it.',
				defaultStyle: { color: white, bgcolor: combineRgb(27, 64, 121) },
				options: [],
				callback: () => this.confirmation() === 'unconfirmed',
			},
			panel_asleep: {
				type: 'boolean',
				name: 'Panel asleep on schedule',
				description:
					'True when the panel is deliberately dark on its night schedule. `confirmed` reads ' +
					'unknown throughout, which is honest - there are no pixels to confirm - but it is NOT ' +
					'a fault and must not be treated as one.',
				defaultStyle: { color: combineRgb(120, 120, 130), bgcolor: black },
				options: [],
				callback: () => this.confirmation() === 'asleep',
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
		}
	}

	// ---- presets, generated from the table --------------------------------------------------

	buildPresets() {
		const presets = {}
		const white = combineRgb(255, 255, 255)
		const black = combineRgb(0, 0, 0)
		// The amber a `connection_lost` feedback paints over ANY state button. It is a third
		// background the art has to survive, and it is not in the table - so the icon is re-inked
		// for it explicitly. Left out, white art sits on amber at 2.1:1 exactly when the operator
		// most needs to read which state has gone stale.
		const AMBER = combineRgb(232, 163, 23)

		for (const row of this.states) {
			const lit = rgb(row.bgcolor, black)
			const rest = dim(lit)
			const owner = rgb(row.color, white)
			// TWO INKS, NOT ONE. The owner's colour on the owner's background; a measured one on
			// the dimmed background the owner never chose ink for. See readableInk().
			const litInk = readableInk(owner, lit)
			const restInk = readableInk(owner, rest)
			const reserved = this.reservedRow()
			const reservedBg = rgb(reserved.bgcolor, black)

			// A ROW WITH NO ART FALLS BACK TO ITS WORDS. The table is the owner's and they can add
			// rows; a row this module has no icon for would otherwise generate a blank button, which
			// is the silent-drop failure contract section 6 forbids for state ids and which is no
			// better here. `icon()` returning undefined leaves `png64` unset, so the caption has to
			// carry it.
			const art = ICONS[row.id] !== undefined
			const caption = art ? '' : row.label

			const stateFeedbacks = (withArt) => [
				{
					feedbackId: 'state_is',
					options: { state: row.id },
					// Lit in the row's OWN colours, dimmed when it is not the current state, so a deck
					// of buttons reads as one indicator rather than five.
					style: {
						color: litInk,
						bgcolor: lit,
						...(withArt ? { png64: icon(row.id, lit) } : {}),
					},
				},
				{
					feedbackId: 'connection_lost',
					options: {},
					style: {
						color: readableInk(black, AMBER),
						bgcolor: AMBER,
						...(withArt ? { png64: icon(row.id, AMBER) } : {}),
					},
				},
				{
					feedbackId: 'no_data',
					options: {},
					style: {
						text: withArt && ICONS[reserved.id] !== undefined ? '' : reserved.label,
						size: 'auto',
						color: readableInk(rgb(reserved.color, white), reservedBg),
						bgcolor: reservedBg,
						...(withArt ? { png64: icon(reserved.id, reservedBg) } : {}),
					},
				},
			]

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
					text: caption,
					size: 'auto',
					color: restInk,
					bgcolor: rest,
					png64: icon(row.id, rest),
				},
				steps: [{ down: [{ actionId: 'set_state', options: { state: row.id } }], up: [] }],
				// ORDER IS THE PRIORITY (D-122, #75). Later feedbacks win, so the state's own
				// colours are laid down first and the two connection marks last:
				// dark-because-dead must never be painted over by anything.
				feedbacks: stateFeedbacks(true),
			}

			// THE SAME BUTTON IN WORDS. Not a lesser version - an icon is faster to read once you
			// know it and useless before that, and which of those an operator is depends on the
			// operator. Both sets are generated from the same row, wear the same feedbacks and
			// write the same state, so a deck can mix them freely.
			presets[`state_${row.id}_words`] = {
				type: 'button',
				category: 'States (words)',
				name: `${row.label} (words)`,
				style: {
					text: row.label, // the caption field is `label`; there is no `row.text`
					size: 'auto',
					color: restInk,
					bgcolor: rest,
				},
				steps: [{ down: [{ actionId: 'set_state', options: { state: row.id } }], up: [] }],
				feedbacks: stateFeedbacks(false),
			}
		}

		// ONE KEY FOR THE WHOLE TABLE (#93). Rocket's ask: a deck with two buttons instead of
		// five - this one walks the rows, the panel toggle darkens the glass.
		//
		// IT WEARS THE CURRENT STATE, which is not decoration. A cycle button you cannot read is
		// useless in the way that matters: the method of use is "press until the one I want comes
		// up", and that needs the button to say which one is up. So it carries the same `state_is`
		// feedback the row buttons carry, once per row, and looks exactly like whichever row is
		// current. The cost is that it is indistinguishable from a plain state button at a glance;
		// the operator knows which key they placed, and the alternative is a button that makes
		// them look somewhere else to use it.
		if (this.states.length) {
			const ring = this.states.filter((r) => r.id !== RESERVED_ID).map((r) => r.id)
			const CYCLE_BG = combineRgb(40, 40, 40)
			const reserved = this.reservedRow()
			const reservedBg = rgb(reserved.bgcolor, black)

			const cycle = (key, category, withArt) => {
				presets[`state_cycle${key}`] = {
					type: 'button',
					category,
					name: 'Next state (cycle)',
					// The resting face is only ever seen before the first status arrives. After that
					// a `state_is` always matches, because `unknown` is a row too.
					style: {
						text: withArt ? '' : 'NEXT\nSTATE',
						size: '14',
						color: readableInk(white, CYCLE_BG),
						bgcolor: CYCLE_BG,
						...(withArt ? { png64: icon('cycle', CYCLE_BG) } : {}),
					},
					steps: [{ down: [{ actionId: 'cycle_state', options: { ring } }], up: [] }],
					// SAME PRIORITY ORDER AS THE ROW BUTTONS (D-122): the rows first, the two
					// connection marks last, so dark-because-dead is never painted over.
					feedbacks: [
						...this.states.map((row) => {
							const lit = rgb(row.bgcolor, black)
							return {
								feedbackId: 'state_is',
								options: { state: row.id },
								style: {
									text: withArt && ICONS[row.id] !== undefined ? '' : row.label,
									size: 'auto',
									color: readableInk(rgb(row.color, white), lit),
									bgcolor: lit,
									...(withArt ? { png64: icon(row.id, lit) } : {}),
								},
							}
						}),
						{
							feedbackId: 'connection_lost',
							options: {},
							style: {
								text: withArt ? '' : 'NO\nCONTACT',
								size: '14',
								color: readableInk(black, AMBER),
								bgcolor: AMBER,
								...(withArt ? { png64: icon('cycle', AMBER) } : {}),
							},
						},
						{
							feedbackId: 'no_data',
							options: {},
							style: {
								text: withArt && ICONS[reserved.id] !== undefined ? '' : reserved.label,
								size: 'auto',
								color: readableInk(rgb(reserved.color, white), reservedBg),
								bgcolor: reservedBg,
								...(withArt ? { png64: icon(reserved.id, reservedBg) } : {}),
							},
						},
					],
				}
			}

			cycle('', 'States', true)
			cycle('_words', 'States (words)', false)
		}

		if (this.states.length) {
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

		// THE PANEL BUTTONS. #91 shipped two, and they stay: a one-way button is the thing you
		// want on a wall when you know which way you mean. #92 adds the toggle beside them
		// because a deck has finite buttons and the common case is one press either way.
		const SLEEP_BG = combineRgb(40, 40, 40)
		const ASLEEP_BG = combineRgb(0, 0, 0)
		const WAKE_BG = combineRgb(200, 200, 205)

		const panel = (key, category, withArt) => {
			const word = (text, bg) => ({
				text: withArt ? '' : text,
				size: '14',
				color: readableInk(combineRgb(255, 255, 255), bg),
				bgcolor: bg,
			})
			const art = (name, bg) => (withArt ? { png64: icon(name, bg) } : {})

			presets[`panel_sleep${key}`] = {
				type: 'button',
				category,
				name: 'Panel sleep',
				style: { ...word('PANEL\nSLEEP', SLEEP_BG), ...art('sleep', SLEEP_BG) },
				steps: [{ down: [{ actionId: 'panel_sleep', options: {} }], up: [] }],
				// It wears the asleep feedback so it reports the panel's ANSWER rather than the
				// press: the panel refuses a sleep while the row is busy, and a button that lit up
				// on the press would be lying during a call - the one time anybody is looking.
				feedbacks: [
					{
						feedbackId: 'panel_asleep',
						options: {},
						style: {
							text: withArt ? '' : 'PANEL\nASLEEP',
							size: '14',
							color: combineRgb(120, 120, 130),
							bgcolor: ASLEEP_BG,
							...art('sleep', ASLEEP_BG),
						},
					},
				],
			}

			presets[`panel_wake${key}`] = {
				type: 'button',
				category,
				name: 'Panel wake',
				style: { ...word('PANEL\nWAKE', WAKE_BG), ...art('wake', WAKE_BG) },
				steps: [{ down: [{ actionId: 'panel_wake', options: {} }], up: [] }],
				feedbacks: [],
			}

			// THE TOGGLE SHOWS THE PANEL, AND THE AFFORDANCE FALLS OUT OF THAT. At rest it wears
			// the moon on dark: the glass is lit, press to darken it. Asleep it goes to the sun on
			// a bright ground: the glass is dark, press to light it. The background carries the
			// STATE and the icon carries WHAT THE PRESS WILL DO, which is the one thing a toggle
			// cannot say by its position - it has none.
			presets[`panel_toggle${key}`] = {
				type: 'button',
				category,
				name: 'Panel sleep/wake toggle',
				style: { ...word('PANEL\nSLEEP?', SLEEP_BG), ...art('sleep', SLEEP_BG) },
				steps: [{ down: [{ actionId: 'panel_toggle', options: {} }], up: [] }],
				feedbacks: [
					{
						feedbackId: 'panel_asleep',
						options: {},
						style: {
							text: withArt ? '' : 'PANEL\nWAKE?',
							size: '14',
							color: readableInk(combineRgb(255, 255, 255), WAKE_BG),
							bgcolor: WAKE_BG,
							...art('wake', WAKE_BG),
						},
					},
				],
			}
		}

		panel('', 'Panel', true)
		panel('_words', 'Panel (words)', false)

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
