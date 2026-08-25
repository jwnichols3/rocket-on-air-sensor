import { UNKNOWN_ID } from './state.js';

export interface LightDriver {
  /** Command the device, then read back. Returns what the device confirmed. Never throws. */
  set(stateId: string): Promise<string>;
  /** Read the device's own current state id. `unknown` if unreachable. Never throws. */
  read(): Promise<string>;
  /** Has the panel repainted since the last call? `null` = the driver cannot tell. */
  repainted?(): Promise<boolean | null>;
}

export class NoopDriver implements LightDriver {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async set(stateId: string): Promise<string> {
    this.log(`[noop-driver] light -> ${stateId.toUpperCase()}`);
    return UNKNOWN_ID;
  }

  async read(): Promise<string> {
    return UNKNOWN_ID;
  }
}
