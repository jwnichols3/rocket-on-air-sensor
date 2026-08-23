export type Level = 'available' | 'interruptible' | 'dnd';
export type OnOff = 'on' | 'off';
export type Confirmed = Level | 'unknown';

/** The floor a human has pinned `level` at. Never `available`: a floor at the bottom
 *  rung is either a no-op or a lever for forcing green against the detector. */
export type Hold = 'interruptible' | 'dnd' | null;

/** Device option order. Index 0 is `dnd` deliberately - every degenerate path on the
 *  device (first boot, corrupt NVS, a changed options list) lands on `options[0]`. */
export const LEVELS = ['dnd', 'interruptible', 'available'] as const;
export const RANK: Record<Level, number> = { available: 0, interruptible: 1, dnd: 2 };

/** The source string that gets clamped by the hold. Everything else - including an
 *  absent source - is treated as manual, which is the safe direction. */
export const DETECTOR_SOURCE = 'detector';

export function isLevel(v: unknown): v is Level {
  return v === 'available' || v === 'interruptible' || v === 'dnd';
}

/** Derived, never stored in memory. The wire/disk `intended` field is always this. */
export function levelToOnOff(level: Level): OnOff {
  return level === 'available' ? 'off' : 'on';
}

/** Legacy boolean -> ladder. `true` rounds UP to dnd: a client that can only say
 *  yes/no is telling you it does not know how bad it is. */
export function onAirToLevel(onAir: boolean): Level {
  return onAir ? 'dnd' : 'available';
}

/** The higher rung wins. Used wherever two sources of level information disagree. */
export function higher(a: Level, b: Level): Level {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface OnAirState {
  level: Level;
  confirmed: Confirmed;
  source: string;
  updatedAt: string;
  message: string | null;
  hold: Hold;
}

/** What actually lands on disk. `intended` is rollback insurance, typed so it cannot
 *  be deleted by a refactor without a compile error. */
export type PersistedState = OnAirState & { intended: OnOff };

export function defaultState(now: Date = new Date()): OnAirState {
  return {
    level: 'dnd',
    confirmed: 'unknown',
    source: 'boot',
    updatedAt: now.toISOString(),
    message: null,
    hold: null,
  };
}

export function isOnAirState(v: unknown): v is OnAirState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  // Accept EITHER a new file (level) OR a legacy one (intended, no level). Extra keys
  // stay permitted - that is what makes a rollback to the previous binary work.
  const levelOk = isLevel(s.level) || s.intended === 'on' || s.intended === 'off';
  const confirmedOk = s.confirmed === 'unknown' || isLevel(s.confirmed) || s.confirmed === 'on' || s.confirmed === 'off';
  const holdOk = s.hold === undefined || s.hold === null || s.hold === 'interruptible' || s.hold === 'dnd';
  return (
    levelOk &&
    confirmedOk &&
    holdOk &&
    typeof s.source === 'string' &&
    typeof s.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(s.updatedAt)) &&
    (s.message === undefined || s.message === null || typeof s.message === 'string')
  );
}

export class StateStore {
  private state: OnAirState;

  constructor(initial: OnAirState) {
    this.state = { ...initial };
  }

  get(): OnAirState {
    return { ...this.state };
  }

  /**
   * Apply a level.
   *
   * `hold` is the floor (D-19). A `detector` write is clamped UP to the floor and may
   * never touch it; any other source applies its level as given and may set (`true`)
   * or clear (`false`) it. Passing `undefined` leaves the floor alone.
   */
  write(level: Level, source: string, now: Date = new Date(), hold?: boolean): OnAirState {
    const fromDetector = source === DETECTOR_SOURCE;
    let nextHold = this.state.hold;

    if (!fromDetector) {
      if (hold === true) nextHold = level === 'available' ? null : level;
      else if (hold === false) nextHold = null;
      // A human asking for a rung BELOW the floor releases the floor. Keeping it would
      // let the next detector write silently undo an explicit human instruction, and
      // would leave `level` and `hold` contradicting each other in GET /status.
      if (nextHold !== null && RANK[level] < RANK[nextHold]) nextHold = null;
    }

    const floor: Level = fromDetector ? (this.state.hold ?? 'available') : 'available';
    this.state = {
      ...this.state,
      level: higher(level, floor),
      confirmed: 'unknown',
      source,
      updatedAt: now.toISOString(),
      hold: nextHold,
    };
    return this.get();
  }

  setConfirmed(confirmed: Confirmed): OnAirState {
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
}
