// Presentation state for one panel command. No networking, timers, or optimistic glass state.
// Call observe only for status observations accepted by the module's existing ordering gate.
const PHYSICAL = new Set(['awake', 'asleep', 'unknown'])
const ACTIVE = new Set(['sending', 'delivered', 'checking'])
const awaitingLateConfirmation = (op) => op?.phase === 'uncertain' && op.result === 'not-confirmed' && op.deliveredAt !== null
const DEFAULT_REQUEST_MS = 20_000

function duration(value, name) {
 if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite duration`)
 return value
}
function observation(value) {
 if (!value || !PHYSICAL.has(value.physical)) return null
 const id = value.receiverInstanceId ?? null
 const sequence = value.statusSequence ?? null
 const modern = typeof id === 'string' && id.length > 0 && Number.isSafeInteger(sequence) && sequence > 0
 if (!modern && (id !== null || sequence !== null)) return null
 const revision = value.revision ?? (modern ? 0 : null)
 if (!Number.isSafeInteger(revision) || revision < 0) return null
 return { receiverInstanceId: id, statusSequence: sequence, revision, physical: value.physical, busy: value.busy === true }
}
function newer(next, previous) {
 if (!previous) return true
 return next.receiverInstanceId === null ? next.revision > previous.revision : next.statusSequence > previous.statusSequence
}

export class PanelProgress {
 constructor({ now = () => performance.now(), estimateMs = 10_000, confirmMs = 20_000 } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a monotonic clock function')
  this.now = now
  this.estimateMs = duration(estimateMs, 'estimateMs')
  this.confirmMs = duration(confirmMs, 'confirmMs')
  if (this.confirmMs < this.estimateMs) throw new RangeError('confirmMs must cover the estimate window')
  this.lastTime = 0
  this.nextId = 0
  this.operation = null
 }

 time() {
  const current = this.now()
  if (!Number.isFinite(current)) throw new RangeError('now must return finite milliseconds')
  this.lastTime = Math.max(this.lastTime, current)
  return this.lastTime
 }

 advance(time = this.time()) {
  const op = this.operation
  if (!op || !ACTIVE.has(op.phase)) return
  if (op.phase === 'sending') {
   if (time >= op.requestDeadline) this.finish('uncertain', 'request-timeout')
  } else if (time >= op.confirmDeadline) this.finish('uncertain', 'not-confirmed')
  else if (time >= op.estimateDeadline) op.phase = 'checking'
 }

 begin({ kind, generation, observation: initial, requestTimeoutMs = DEFAULT_REQUEST_MS } = {}) {
  if (!['toggle', 'sleep', 'wake'].includes(kind)) throw new TypeError('kind must be toggle, sleep, or wake')
  const requestMs = duration(requestTimeoutMs, 'requestTimeoutMs')
  const time = this.time()
  this.advance(time)
  if (kind === 'toggle' && this.operation && ACTIVE.has(this.operation.phase)) {
   return { started: false, token: this.operation.token }
  }
  // Explicit sleep/wake is an override. A replacement token fences the old completion.
  const initialObservation = observation(initial)
  const token = Object.freeze({ id: ++this.nextId, generation })
  this.operation = {
   token, kind, phase: 'sending', result: null,
   target: kind === 'toggle' ? null : kind === 'sleep' ? 'asleep' : 'awake',
   startedAt: time, requestDeadline: time + requestMs,
   deliveredAt: null, estimateDeadline: null, confirmDeadline: null,
   lastObservation: initialObservation,
   lastPhysical: initialObservation?.physical ?? 'unknown',
   transitions: new Set(),
  }
  return { started: true, token }
 }

 current(token) {
  this.advance()
  return this.operation?.token === token && ACTIVE.has(this.operation.phase)
 }

 delivered(token, { delivered, asked, wasDark } = {}) {
  if (!this.current(token)) return false
  const op = this.operation
  if (op.phase !== 'sending') return false
  if (delivered !== true) {
   this.finish('uncertain', delivered === false ? 'undelivered' : 'unknown')
   return true
  }
  if (!['sleep', 'wake'].includes(asked)
   || (op.kind !== 'toggle' && op.kind !== asked)
   || (op.kind === 'toggle' && typeof wasDark === 'boolean' && (wasDark ? 'wake' : 'sleep') !== asked)) {
   this.finish('uncertain', 'unexpected-response')
   return true
  }
  const time = this.time()
  op.target = asked === 'sleep' ? 'asleep' : 'awake'
  op.phase = 'delivered'
  op.deliveredAt = time
  op.estimateDeadline = time + this.estimateMs
  op.confirmDeadline = time + this.confirmMs
  this.reconcile()
  return true
 }

 rejected(token, { reason = 'unknown' } = {}) {
  if (!this.current(token)) return false
  this.finish(reason === 'rejected' ? 'rejected' : 'uncertain', ['rejected', 'undelivered', 'unknown'].includes(reason) ? reason : 'unknown')
  return true
 }

 observe(value) {
  this.advance()
  const op = this.operation
  if (!op || (!ACTIVE.has(op.phase) && op.phase !== 'held' && !awaitingLateConfirmation(op))) return false
  const next = observation(value)
  if (!next) return false
  const previous = op.lastObservation
  if (previous && next.receiverInstanceId !== previous.receiverInstanceId) {
   this.finish(op.phase === 'held' ? 'idle' : 'uncertain', 'receiver-changed')
   return false
  }
  if (!newer(next, previous)) return false
  op.lastObservation = next
  // An unrelated state/table/message update may advance the sequence. It is not a
  // physical transition. Unknown observations cannot invent either endpoint.
  if (next.physical !== 'unknown') {
   if (op.lastPhysical !== 'unknown' && op.lastPhysical !== next.physical) op.transitions.add(next.physical)
   op.lastPhysical = next.physical
  }
  if (op.phase === 'held') {
   // A busy badge describes the present condition, not an indefinite historical latch.
   if (!next.busy) this.finish('idle', 'busy')
  } else this.reconcile()
  return true
 }

 reconcile() {
  const op = this.operation
  if (!op || (!['delivered', 'checking'].includes(op.phase) && !awaitingLateConfirmation(op))) return
  const latest = op.lastObservation
  // This also handles a transition that arrived over SSE before HTTP delivery returned.
  // A delivered but unconfirmed notice can clear on late proof; it stays inactive and
  // does not accept late HTTP replies or restart its deadline while waiting for that proof.
  // If wasDark disagreed with the cached starting face, an unchanged target cannot pass:
  // the tracker must have observed the opposite physical state followed by this target.
  if (latest?.physical === op.target && op.transitions.has(op.target)) this.finish('confirmed', 'confirmed')
  else if (!awaitingLateConfirmation(op) && op.target === 'asleep' && latest?.busy === true && latest.physical !== 'asleep') this.finish('held', 'busy')
 }

 finish(phase, result) {
  this.operation.phase = phase
  this.operation.result = result
 }

 cancel(reason = 'cancelled') {
  if (['cancelled', 'reset', 'configuration', 'destroy'].includes(reason)) {
   this.operation = null
  } else if (this.operation && (ACTIVE.has(this.operation.phase) || awaitingLateConfirmation(this.operation))) {
   // Contact loss ends correlation visibly. It is not proof a delivered command failed.
   this.finish('uncertain', typeof reason === 'string' ? reason : 'unknown')
  }
 }

 view() {
  const time = this.time()
  this.advance(time)
  const op = this.operation
  if (!op) return { phase: 'idle', active: false, needsTick: false, kind: null, target: null,
   remainingSeconds: null, fraction: null, elapsedSeconds: 0, overtimeSeconds: 0, result: null }
  const active = ACTIVE.has(op.phase)
  const estimating = op.phase === 'delivered' || op.phase === 'checking'
  const remaining = estimating ? Math.max(0, op.estimateDeadline - time) : null
  return { phase: op.phase, active, needsTick: active, kind: op.kind, target: op.target,
   remainingSeconds: remaining === null ? null : Math.ceil(remaining / 1000),
   fraction: remaining === null ? null : Math.max(0, Math.min(1, remaining / this.estimateMs)),
   elapsedSeconds: Math.floor(Math.max(0, time - op.startedAt) / 1000),
   overtimeSeconds: op.phase === 'checking' ? Math.floor(Math.max(0, time - op.estimateDeadline) / 1000) : 0,
   result: op.result }
 }
}
