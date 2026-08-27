/**
 * The state table and the state object - contract v2, §1 and §2.
 *
 * The three-rung ladder (`available < interruptible < dnd`) is gone. What replaced it is
 * an UNORDERED table of rows, each carrying a `busy` flag, and the whole safety model
 * rides on that flag rather than on rank (D-31, D-32).
 *
 * The one thing that ever appears on the wire as an address is a row's `id`. Not its
 * index, not its `order`, not its `label` - a reorder is cosmetic and must never change
 * what a client resolves to (D-34).
 */

/** A row in the state table (§1). */
export interface StateRow {
  /** Immutable. The only addressable handle. */
  id: string;
  /** The human phrase every renderer draws. Freely edited, never a key. */
  label: string;
  /** `#rrggbb`, lowercase. Presentation - reaches clients via the profile, never on a state change (D-42). */
  color: string;
  bgcolor: string;
  /** A comment for humans. Never load-bearing. */
  description: string;
  /** Does this state mean the camera may be live. This field carries the safety model. */
  busy: boolean;
  /** Display sort hint. NEVER an address. */
  order: number;
}

/** `^[a-z0-9][a-z0-9-]{0,31}$` - 32 chars max, so it fits the device's `text` entity. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The one reserved row (D-34). It cannot be deleted, its `busy` is forced `true`, and it
 * is where every dangling reference resolves. A Null Object, not a ladder in disguise:
 * it carries no rank and nothing is ordered against it.
 */
export const UNKNOWN_ID = 'unknown';

/** Shipped defaults (§1). The owner's to change once the config store lands (#39). */
export const SEED_ROWS: readonly StateRow[] = Object.freeze([
  { id: 'available', label: 'AVAILABLE', busy: false, bgcolor: '#0b6e2e', color: '#ffffff', description: '', order: 0 },
  { id: 'on-air', label: 'ON AIR', busy: true, bgcolor: '#c1121f', color: '#ffffff', description: '', order: 1 },
  { id: 'interruptible', label: 'INTERRUPTIBLE', busy: false, bgcolor: '#e8a317', color: '#1a1a1a', description: '', order: 2 },
  { id: 'recording', label: 'RECORDING', busy: true, bgcolor: '#6a0dad', color: '#ffffff', description: '', order: 3 },
  { id: UNKNOWN_ID, label: 'NO DATA', busy: true, bgcolor: '#1a1a1a', color: '#ff00ff', description: '', order: 99 },
].map((r) => Object.freeze(r)) as StateRow[]);

/**
 * `/on` and `/off` resolve through these, and are `409` when unset (§5). Explicit rather
 * than derived on purpose: "fall back to the first row" is a bad rule when the first row
 * is ON AIR. Seeded here; #39 moves them into the config document.
 */
export interface Shortcuts {
  on: string | null;
  off: string | null;
}
export const SEED_SHORTCUTS: Shortcuts = Object.freeze({ on: 'on-air', off: 'available' });

/**
 * The table in force. Immutable once constructed - a config save builds a new one and
 * bumps `version`, which is what `tableVersion` on the wire reports.
 */
export class StateTable {
  private readonly byId: Map<string, StateRow>;
  readonly version: number;

  constructor(rows: readonly StateRow[] = SEED_ROWS, version = 1) {
    this.byId = new Map(rows.map((r) => [r.id, r]));
    // `unknown` always exists and its busy is always true (D-34). Enforced here rather
    // than trusted, because every dangling reference in the system lands on it.
    const u = this.byId.get(UNKNOWN_ID);
    this.byId.set(UNKNOWN_ID, u ? { ...u, busy: true } : { ...SEED_ROWS[SEED_ROWS.length - 1]! });
    this.version = version;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The row, or `undefined`. Callers that need a row for a possibly-dead id use `resolve`. */
  row(id: string): StateRow | undefined {
    return this.byId.get(id);
  }

  /** Every id, in `order` then id - a display order, never an address space. */
  ids(): string[] {
    return [...this.byId.values()]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((r) => r.id);
  }

  rows(): StateRow[] {
    return this.ids().map((id) => this.byId.get(id)!);
  }

  /**
   * `busy` for an id, defaulting to TRUE for one that is not in the table. The default is
   * the whole point: an unknown id must never read as calm.
   */
  busy(id: string): boolean {
    return this.byId.get(id)?.busy ?? true;
  }
}

/** `kind:label` (§4). The only trace an external detector leaves in this system. */
export interface Source {
  kind: 'auto' | 'human';
  label: string;
  /** The canonical `kind:label` string, which is what is stored and served. */
  raw: string;
}

const SOURCE_PATTERN = /^(auto|human):(.{1,32})$/;

/**
 * Strict parse, for `PUT /state`: the prefix is REQUIRED and a missing one is a `400`.
 *
 * An earlier draft was forgiving everywhere, so an automated writer that forgot the prefix
 * silently got human authority and could break the owner's holds. In a system whose whole
 * invariant is "false OFF is worse than false ON" that is the wrong direction to fail, so
 * the route a robot reaches for demands the prefix (D-41).
 */
export function parseSource(raw: unknown): Source | null {
  if (typeof raw !== 'string') return null;
  const m = SOURCE_PATTERN.exec(raw.trim());
  if (!m) return null;
  return { kind: m[1] as 'auto' | 'human', label: m[2]!, raw: `${m[1]}:${m[2]}` };
}

/**
 * Lenient parse, for the convenience routes (`POST /state/{id}`, `/on`, `/off`) - the curl
 * and Shortcuts surface, where a human is typing (D-41). Missing becomes
 * `human:anonymous`; an unprefixed label becomes `human:<label>`.
 *
 * `detector` is the one legacy bare value carried across, as `auto:detector` (§4). It is
 * mapped rather than dropped because a v1 client heartbeating `?source=detector` must not
 * silently acquire the authority to break a hold.
 */
export function coerceSource(raw: unknown): Source {
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: 'human', label: 'anonymous', raw: 'human:anonymous' };
  const trimmed = raw.trim();
  const strict = parseSource(trimmed);
  if (strict) return strict;
  if (trimmed === 'detector') return { kind: 'auto', label: 'detector', raw: 'auto:detector' };
  const label = trimmed.slice(0, 32);
  return { kind: 'human', label, raw: `human:${label}` };
}

/**
 * The answer to "may this write land?". `ok: false` carries the status the route sends and
 * the sentence the client reads.
 */
export type WriteVerdict = { ok: true } | { ok: false; status: 403 | 409; error: string };

/**
 * THE PIN RULE, in code (contract §3, D-32).
 *
 * > While a hold is set, a write from an `auto:` source is applied only if it moves the
 * > system from a `busy: false` state to a `busy: true` state. Every other automated write
 * > is refused (409) and the held state stands. A `human:` write always applies.
 *
 * The single carve-out is the whole design. A naive pin is a documented production failure,
 * not a hypothetical: Teams ships `user-preferred state > session-level states`, so someone
 * who prefers Available and then joins a call shows **Available**. Teams can afford a
 * wrong-but-chosen chat status; a light whose only job is to say whether a camera is live
 * cannot. The carve-out means a pin can hold you calm against a detector that thinks the
 * meeting ended, but never against one that thinks it started.
 *
 * A pin at a `busy: false` row is therefore a floor in the only sense that ever mattered,
 * without any ordering: escalation in, no de-escalation out.
 */
export function judgeWrite(
  current: OnAirState,
  table: StateTable,
  next: string,
  source: Source,
  hold?: boolean,
): WriteVerdict {
  // Authority first. An `auto:` source touching the pin at all is a 403 even when the pin
  // would also have refused the state change - reporting THAT as a 409 would tell the
  // client to back off and wait, when what it needs to do is fix its `source`.
  if (hold !== undefined && source.kind !== 'human') {
    return { ok: false, status: 403, error: 'only a human: source may set or clear a hold' };
  }
  if (current.hold === null || source.kind === 'human') return { ok: true };

  const movingToBusy = !table.busy(current.state) && table.busy(next);
  if (movingToBusy) return { ok: true };
  return {
    ok: false,
    status: 409,
    error: `state is held at '${current.hold}'; an automated write may only escalate to a busy state`,
  };
}

/** The persisted, in-memory state object. Everything else in §2 is derived at read time. */
export interface OnAirState {
  /** A REFERENCE to a row, never a copy of one. */
  state: string;
  /** The row id the light acknowledged, read back from the device. Never guessed. */
  confirmed: string;
  /** The pinned row id, or null for the auto regime. */
  hold: string | null;
  source: string;
  updatedAt: string;
  message: string | null;
  /** Present ONLY when the live row was deleted and the state fell back to `unknown`. */
  stateResolvedFrom?: string;
}

/** The §2 object as it goes on the wire, with the derived fields filled in. */
export interface StatusBody extends OnAirState {
  busy: boolean;
  intended: 'on' | 'off';
  /**
   * Provenance, not a judgement (D-91). The server reports how long ago the state was
   * written and never branches on it; deciding what age MEANS is the client's job.
   */
  ageSeconds: number;
  tableVersion: number;
}

/**
 * What lands on disk. `intended` is rollback insurance - typed so a refactor cannot delete
 * it without a compile error - and `tableVersion` records which vocabulary was in force.
 */
export type PersistedState = OnAirState & { intended: 'on' | 'off'; tableVersion: number };

export function defaultState(now: Date = new Date()): OnAirState {
  return {
    // Not `available`. Every degenerate path in this system lands on a conspicuous
    // state, never a calm one (D-34).
    state: UNKNOWN_ID,
    confirmed: UNKNOWN_ID,
    hold: null,
    source: 'human:boot',
    updatedAt: now.toISOString(),
    message: null,
  };
}

export class StateStore {
  private state: OnAirState;
  private table: StateTable;

  constructor(initial: OnAirState, table: StateTable = new StateTable()) {
    this.table = table;
    this.state = resolveAgainst(initial, table);
  }

  get(): OnAirState {
    return { ...this.state };
  }

  getTable(): StateTable {
    return this.table;
  }

  /**
   * Swap the table in and re-resolve. A live row that no longer exists falls back to
   * `unknown` and records where it came from; a pinned row that no longer exists releases
   * the pin in the same operation (D-34). Used by the config store (#39).
   */
  setTable(table: StateTable): OnAirState {
    this.table = table;
    this.state = resolveAgainst(this.state, table);
    return this.get();
  }

  busy(): boolean {
    return this.table.busy(this.state.state);
  }

  /**
   * Apply a state.
   *
   * THE PIN RULE IS NOT HERE. This applies what it is given and manages the pin's value;
   * deciding whether an `auto:` write is allowed to land while a pin is set is the
   * supervisor-and-route policy that #38 adds. Until then a pin is recorded and reported
   * but does not refuse anything.
   */
  write(state: string, source: Source, now: Date = new Date(), hold?: boolean): OnAirState {
    let nextHold = this.state.hold;
    if (hold === true) nextHold = state;
    else if (hold === false) nextHold = null;
    // A human write naming a state other than the held one releases the pin (§3). Applied
    // here so the store can never report a `hold` that contradicts `state`.
    else if (source.kind === 'human' && nextHold !== null && nextHold !== state) nextHold = null;

    const next: OnAirState = {
      ...this.state,
      state,
      // A new assertion is not yet evidence about the device. Re-earned by a real read.
      confirmed: UNKNOWN_ID,
      hold: nextHold,
      source: source.raw,
      updatedAt: now.toISOString(),
    };
    delete next.stateResolvedFrom;
    this.state = next;
    return this.get();
  }

  /** Clear or set the pin outright. Used by factory reset; routes go through `write`. */
  setHold(hold: string | null): OnAirState {
    this.state = { ...this.state, hold };
    return this.get();
  }

  setConfirmed(confirmed: string): OnAirState {
    this.state = { ...this.state, confirmed };
    return this.get();
  }

  setMessage(text: string): OnAirState {
    this.state = { ...this.state, message: text };
    return this.get();
  }

  clearMessage(): OnAirState {
    this.state = { ...this.state, message: null };
    return this.get();
  }

  ageSeconds(now: Date = new Date()): number {
    const age = (now.getTime() - Date.parse(this.state.updatedAt)) / 1000;
    return Math.max(0, Math.floor(age));
  }

  /** The §2 object, with every derived field computed at read time so none can drift. */
  status(now: Date = new Date()): StatusBody {
    const s = this.get();
    const busy = this.table.busy(s.state);
    return {
      ...s,
      busy,
      intended: busy ? 'on' : 'off',
      ageSeconds: this.ageSeconds(now),
      tableVersion: this.table.version,
    };
  }

  /** What goes to disk. `confirmed` is memory-only: a file records intent, never evidence. */
  persisted(): PersistedState {
    const s = this.get();
    return {
      ...s,
      confirmed: UNKNOWN_ID,
      intended: this.table.busy(s.state) ? 'on' : 'off',
      tableVersion: this.table.version,
    };
  }
}

/**
 * Resolve a state object against a table: a live row that is gone becomes `unknown` and
 * records the dead id; a pin on a row that is gone is released. Deleting the live row is
 * allowed - it just must never be silent, and must never resolve to something calm.
 */
function resolveAgainst(s: OnAirState, table: StateTable): OnAirState {
  const out: OnAirState = { ...s };
  if (!table.has(out.state)) {
    out.stateResolvedFrom = out.state;
    out.state = UNKNOWN_ID;
  } else {
    delete out.stateResolvedFrom;
  }
  if (out.hold !== null && !table.has(out.hold)) out.hold = null;
  if (out.confirmed !== UNKNOWN_ID && !table.has(out.confirmed)) out.confirmed = UNKNOWN_ID;
  return out;
}
