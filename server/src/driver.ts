import type { Confirmed, Level } from './state.js';

export interface LightDriver {
  /** Command the device, then read back. Returns what the device confirmed. Never throws. */
  set(level: Level): Promise<Confirmed>;
  /** Read the device's own current level. 'unknown' if unreachable/unparseable. Never throws. */
  read(): Promise<Confirmed>;
  /** Has the panel repainted since the last call? `null` = the driver cannot tell. */
  repainted?(): Promise<boolean | null>;
}

export class NoopDriver implements LightDriver {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async set(level: Level): Promise<Confirmed> {
    this.log(`[noop-driver] light -> ${level.toUpperCase()}`);
    return 'unknown';
  }

  async read(): Promise<Confirmed> {
    return 'unknown';
  }
}
