// The Rocket On-Air Companion module (#44).
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

import {
	InstanceBase,
	InstanceStatus,
	Regex,
	combineRgb,
	runEntrypoint,
} from '@companion-module/base'

/// #rrggbb -> Companion's packed integer. The table's colours are used verbatim (D-31, D-42).
function rgb(hex, fallback) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''))
	if (!m) return fallback
	const n = parseInt(m[1], 16)
	return combineRgb((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

class OnAirInstance extends InstanceBase {
	async init(config) {
		this.config = config ?? {}
		this.states = []
		this.tableVersion = null
		this.current = null
		this.abort = null
		this.retryTimer = null
		this.stopping = false

		this.setActionDefinitions(this.buildActions())
		this.setFeedbackDefinitions(this.buildFeedbacks())
		this.setVariableDefinitions(this.buildVariables())

		await this.refreshTable()
		this.connectStream()
	}

	async destroy() {
		this.stopping = true
		if (this.retryTimer) clearTimeout(this.retryTimer)
		if (this.abort) this.abort.abort()
	}

	async configUpdated(config) {
		this.config = config ?? {}
		if (this.abort) this.abort.abort()
		if (this.retryTimer) clearTimeout(this.retryTimer)
		await this.refreshTable()
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
		]
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
			this.updateStatus(InstanceStatus.BadConfig, 'passphrase required')
			return false
		}
		try {
			const res = await fetch(`${this.base()}/config/states`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(5000),
			})
			if (res.status === 401) {
				this.updateStatus(InstanceStatus.AuthenticationFailure, 'passphrase rejected')
				return false
			}
			if (!res.ok) {
				this.updateStatus(InstanceStatus.UnknownError, `GET /config/states -> ${res.status}`)
				return false
			}
			const body = await res.json()
			this.states = Array.isArray(body.states) ? body.states : []
			this.tableVersion = body.version ?? null
			this.log('info', `state table v${this.tableVersion}, ${this.states.length} rows`)

			// Definitions are repeatedly callable and diff-patched to the UI, so regenerating
			// costs nothing and needs no restart.
			this.setActionDefinitions(this.buildActions())
			this.setFeedbackDefinitions(this.buildFeedbacks())
			this.setVariableDefinitions(this.buildVariables())
			this.setPresetDefinitions(this.buildPresets())
			this.publishVariables()
			this.checkFeedbacks('state_is', 'busy')
			return true
		} catch (err) {
			this.updateStatus(InstanceStatus.ConnectionFailure, `state table: ${err.message}`)
			return false
		}
	}

	// ---- the live state stream ----------------------------------------------------------

	connectStream() {
		if (this.stopping || !this.config.passphrase) return
		this.abort = new AbortController()

		// SSE parsed by hand rather than with EventSource, because fetch can carry the
		// Authorization header and EventSource cannot. One connection at a time.
		fetch(`${this.base()}/events`, {
			headers: { ...this.headers(), Accept: 'text/event-stream' },
			signal: this.abort.signal,
		})
			.then(async (res) => {
				if (res.status === 401) {
					this.updateStatus(InstanceStatus.AuthenticationFailure, 'passphrase rejected')
					return this.scheduleRetry(30000)
				}
				if (!res.ok || !res.body) {
					this.updateStatus(InstanceStatus.ConnectionFailure, `GET /events -> ${res.status}`)
					return this.scheduleRetry()
				}
				this.updateStatus(InstanceStatus.Ok)
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
				if (!this.stopping) {
					this.updateStatus(InstanceStatus.Disconnected, 'stream ended')
					this.scheduleRetry()
				}
			})
			.catch((err) => {
				if (this.stopping || err.name === 'AbortError') return
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
				this.scheduleRetry()
			})
	}

	scheduleRetry(ms = 5000) {
		if (this.stopping) return
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = setTimeout(() => this.connectStream(), ms)
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
		if (!payload || typeof payload !== 'object' || payload.state === undefined) return

		this.current = payload

		// tableVersion moves whenever the table is saved. That is the regeneration trigger -
		// no polling, and no restart.
		if (payload.tableVersion !== undefined && payload.tableVersion !== this.tableVersion) {
			this.log('info', `table version ${this.tableVersion} -> ${payload.tableVersion}, regenerating`)
			this.refreshTable()
		}

		this.publishVariables()
		this.checkFeedbacks('state_is', 'busy')
	}

	// ---- variables ------------------------------------------------------------------------

	buildVariables() {
		return [
			{ variableId: 'state', name: 'Current state id' },
			{ variableId: 'label', name: 'Current state label' },
			{ variableId: 'busy', name: 'Busy (yes/no)' },
			{ variableId: 'confirmed', name: 'Confirmed by the light' },
			{ variableId: 'hold', name: 'Hold' },
			{ variableId: 'source', name: 'Who wrote the state' },
			{ variableId: 'stale', name: 'Stale (yes/no)' },
			{ variableId: 'age_seconds', name: 'Seconds since the last write' },
			{ variableId: 'table_version', name: 'State table version' },
		]
	}

	publishVariables() {
		const s = this.current
		const row = s ? this.states.find((r) => r.id === s.state) : null
		this.setVariableValues({
			state: s?.state ?? '',
			label: row?.label ?? s?.label ?? '',
			busy: s?.busy ? 'yes' : 'no',
			confirmed: s?.confirmed ?? '',
			hold: s?.hold ?? '',
			source: s?.source ?? '',
			stale: s?.stale ? 'yes' : 'no',
			age_seconds: s?.ageSeconds ?? '',
			table_version: this.tableVersion ?? '',
		})
	}

	// ---- actions ---------------------------------------------------------------------------

	buildActions() {
		const choices = this.states.map((r) => ({ id: r.id, label: `${r.label} (${r.id})` }))
		return {
			set_state: {
				name: 'Set state',
				options: [
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						default: choices[0]?.id ?? '',
						choices: choices.length ? choices : [{ id: '', label: '(no table yet)' }],
						allowCustom: true,
					},
				],
				callback: async (event) => {
					const id = await this.parseVariablesInString(String(event.options.state ?? ''))
					await this.setState(id)
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

	async setState(id) {
		if (!id) {
			this.log('warn', 'set state: no state id')
			return
		}
		try {
			const res = await fetch(`${this.base()}/state/${encodeURIComponent(id)}?source=companion`, {
				method: 'POST',
				headers: this.headers(),
				signal: AbortSignal.timeout(5000),
			})
			if (res.ok) return

			// A button bound to a row the server no longer has must SAY SO. The server hands
			// back the list of ids that would have worked, and putting that in front of the
			// operator is the difference between "the button is broken" and "that row is gone,
			// here is what exists".
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
			this.updateStatus(InstanceStatus.UnknownWarning, `set "${id}": ${detail}`)
		} catch (err) {
			this.log('error', `set state "${id}" failed: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		}
	}

	// ---- feedbacks --------------------------------------------------------------------------

	buildFeedbacks() {
		const choices = this.states.map((r) => ({ id: r.id, label: `${r.label} (${r.id})` }))
		return {
			state_is: {
				type: 'boolean',
				name: 'State is',
				description: 'True when the light is showing this state',
				defaultStyle: { color: combineRgb(255, 255, 255), bgcolor: combineRgb(193, 18, 31) },
				options: [
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						default: choices[0]?.id ?? '',
						choices: choices.length ? choices : [{ id: '', label: '(no table yet)' }],
						allowCustom: true,
					},
				],
				callback: (feedback) => this.current?.state === feedback.options.state,
			},
			busy: {
				type: 'boolean',
				name: 'Busy',
				description:
					'True when the current row is busy. This is the server\'s own flag, not a colour test - ' +
					'THE BUSY RULE (D-32) is what it means.',
				defaultStyle: { color: combineRgb(255, 255, 255), bgcolor: combineRgb(193, 18, 31) },
				options: [],
				callback: () => this.current?.busy === true,
			},
			stale: {
				type: 'boolean',
				name: 'Stale',
				description: 'True when the server has no fresh evidence for the current state',
				defaultStyle: { color: combineRgb(0, 0, 0), bgcolor: combineRgb(232, 163, 23) },
				options: [],
				callback: () => this.current?.stale === true,
			},
		}
	}

	// ---- presets, generated from the table --------------------------------------------------

	buildPresets() {
		const presets = {}
		for (const row of this.states) {
			// STABLE ID, keyed on the row id and nothing else. Row ids are immutable (D-31) and
			// index never appears (D-34), so a preset keeps its identity across a table edit -
			// which is what makes 5.1's live-linked preset references work when they land.
			presets[`state_${row.id}`] = {
				type: 'button',
				category: 'States',
				name: row.label,
				style: {
					text: row.label, // the caption field is `label`; there is no `row.text`
					size: 'auto',
					color: rgb(row.color, combineRgb(255, 255, 255)),
					bgcolor: rgb(row.bgcolor, combineRgb(0, 0, 0)),
				},
				steps: [{ down: [{ actionId: 'set_state', options: { state: row.id } }], up: [] }],
				feedbacks: [
					{
						feedbackId: 'state_is',
						options: { state: row.id },
						// Lit in the row's OWN colours, dimmed when it is not the current state, so a
						// deck of buttons reads as one indicator rather than five.
						style: {
							color: rgb(row.color, combineRgb(255, 255, 255)),
							bgcolor: rgb(row.bgcolor, combineRgb(0, 0, 0)),
						},
					},
				],
			}
		}

		presets.refresh = {
			type: 'button',
			category: 'Utility',
			name: 'Refresh table',
			style: { text: 'REFRESH\\nTABLE', size: '14', color: combineRgb(255, 255, 255), bgcolor: combineRgb(40, 40, 40) },
			steps: [{ down: [{ actionId: 'refresh_table', options: {} }], up: [] }],
			feedbacks: [],
		}
		return presets
	}
}

runEntrypoint(OnAirInstance, [])
