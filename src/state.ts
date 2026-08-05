export type OnOff = 'on' | 'off';
export type Confirmed = OnOff | 'unknown';

export interface OnAirState {
  intended: OnOff;
  confirmed: Confirmed;
  source: string;
  updatedAt: string;
  message: string | null;
}

export function defaultState(now: Date = new Date()): OnAirState {
  return { intended: 'off', confirmed: 'unknown', source: 'boot', updatedAt: now.toISOString(), message: null };
}

export function isOnAirState(v: unknown): v is OnAirState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    (s.intended === 'on' || s.intended === 'off') &&
    (s.confirmed === 'on' || s.confirmed === 'off' || s.confirmed === 'unknown') &&
    typeof s.source === 'string' &&
    typeof s.updatedAt === 'string' &&
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

  write(onAir: boolean, source: string, now: Date = new Date()): OnAirState {
    this.state = {
      ...this.state,
      intended: onAir ? 'on' : 'off',
      confirmed: 'unknown',
      source,
      updatedAt: now.toISOString(),
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
