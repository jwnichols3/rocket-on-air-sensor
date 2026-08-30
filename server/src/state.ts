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
 * The original reason was authority - an unprefixed writer silently got human authority and
 * could break the owner's holds - and that reason is gone with the pin (D-126). The `400`
 * stays for a different and still-live one: `source` is the ONLY trace an external detector
 * leaves in this system (D-30), it is what four renderers draw, and a writer that cannot be
 * told apart from a human is a writer nobody can debug. The route a robot reaches for
 * demands the prefix so the provenance is honest (D-41).
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
 * mapped rather than dropped so a v1 client heartbeating `?source=detector` still reads as
 * a machine on every renderer; it no longer buys or loses any authority (D-126).
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
 * LAST WRITE WINS (contract §3, D-126).
 *
 * THE PIN RULE stood here, as `judgeWrite()` and `WriteVerdict`. It is retired: every write
 * with a valid body is applied, no `source` outranks another, and no earlier write can block
 * a later one. There is nothing left for this module to judge, so there is no function here.
 *
 * `auto:` and `human:` survive as PROVENANCE, not authority - nothing a `human:` source may
 * do is denied to an `auto:` one. Nothing in this server branches on `Source.kind` any more.
 *
 * What was deliberately given up, so nobody has to rediscover it: pinned at a busy row, an
 * `auto:` write to a calm row used to be refused and the light stayed ON. That was a real,
 * narrow false-OFF protection, and it only ever applied while a human had explicitly pinned.
 */

/** The persisted, in-memory state object. Everything else in §2 is derived at read time. */
/**
 * Why there is no confirmation. Three and not two, because a human surface has to tell
 * "dark on purpose" from "broken" to stop alarming, and "unreachable" from "reachable but
 * frozen" to be worth reading at all.
 */
export type ConfirmedReason = 'asleep' | 'not-repainting' | 'unreachable';

export interface OnAirState {
  /** A REFERENCE to a row, never a copy of one. */
  state: string;
  /** The row id the light acknowledged, read back from the device. Never guessed. */
  confirmed: string;
  source: string;
  updatedAt: string;
  message: string | null;
  /** Present ONLY when the live row was deleted and the state fell back to `unknown`. */
  stateResolvedFrom?: string;
  /**
   * WHY `confirmed` is `unknown`, when the server knows. Absent otherwise - including when
   * `confirmed` is a real row, and when it is `unknown` for a reason the server cannot name.
   *
   * Optional and additive on purpose (#82/#83), following `stateResolvedFrom` above:
   * `confirmed` keeps its type and its domain, so every deployed client keeps working
   * unchanged - which matters because Companion buttons are already on a physical deck.
   *
   * `asleep` is the one that is NOT a fault. A panel dark on schedule at 2am is healthy and
   * has no pixels to confirm; a client that escalates on it is crying wolf every night, and
   * a feature that does that is worse than not having it.
   */
  confirmedReason?: ConfirmedReason;
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
   * `unknown` and records where it came from (D-34). Used by the config store (#39).
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
   * Apply a state. It applies exactly what it is given - there is no precedence left to
   * consult and nothing here can refuse (D-126).
   */
  write(state: string, source: Source, now: Date = new Date()): OnAirState {
    const next: OnAirState = {
      ...this.state,
      state,
      // A new assertion is not yet evidence about the device. Re-earned by a real read.
      confirmed: UNKNOWN_ID,
      source: source.raw,
      updatedAt: now.toISOString(),
    };
    delete next.stateResolvedFrom;
    this.state = next;
    return this.get();
  }

  setConfirmed(confirmed: string, reason?: ConfirmedReason): OnAirState {
    // The reason is REPLACED, never merged: a stale "asleep" surviving into a genuine
    // outage would be the same lie as a stale `confirmed`, one level further out.
    const next = { ...this.state, confirmed };
    if (reason === undefined) delete next.confirmedReason;
    else next.confirmedReason = reason;
    this.state = next;
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
 * records the dead id. Deleting the live row is allowed - it just must never be silent, and
 * must never resolve to something calm.
 */
function resolveAgainst(s: OnAirState, table: StateTable): OnAirState {
  const out: OnAirState = { ...s };
  if (!table.has(out.state)) {
    out.stateResolvedFrom = out.state;
    out.state = UNKNOWN_ID;
  } else {
    delete out.stateResolvedFrom;
  }
  if (out.confirmed !== UNKNOWN_ID && !table.has(out.confirmed)) out.confirmed = UNKNOWN_ID;
  return out;
}
