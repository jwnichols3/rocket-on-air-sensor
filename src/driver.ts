import type { Confirmed } from './state.js';

export interface LightDriver {
  set(onAir: boolean): Promise<Confirmed>;
}

export class NoopDriver implements LightDriver {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async set(onAir: boolean): Promise<Confirmed> {
    this.log(`[noop-driver] light -> ${onAir ? 'ON' : 'OFF'}`);
    return 'unknown';
  }
}
