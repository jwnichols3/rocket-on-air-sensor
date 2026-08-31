import { UNKNOWN_ID } from './state.js';

export interface LightDriver {
  /**
   * The device this driver talks to, for logs. Optional because a driver that models no
   * device (NoopDriver) has no host to name - but a log line about a panel that does not
   * say WHICH panel is half a line, which is D-109's finding and #84's.
   */
  readonly host?: string;
  /** Command the device, then read back. Returns what the device confirmed. Never throws. */
  set(stateId: string): Promise<string>;
  /** Read the device's own current state id. `unknown` if unreachable. Never throws. */
  read(): Promise<string>;
  /** Has the panel repainted since the last call? `null` = the driver cannot tell. */
  repainted?(): Promise<boolean | null>;
  /**
   * Is the panel's glass deliberately dark? `null` = the driver cannot tell - no such
   * entity, or the host is not answering.
   *
   * SEPARATE FROM `repainted()` on purpose. "Did the pixels change" and "can anyone see
   * them" are different questions with different answers, and folding them into one boolean
   * is exactly what let a panel dark on schedule report itself as confirmed (#82): the
   * display lambda keeps running and `Frames` keeps advancing with the backlight off.
   */
  glassDark?(): Promise<boolean | null>;
  /**
   * Ask the panel to darken its glass now, or to light it again. Resolves `true` when the
   * command reached the device, `false` when it did not.
   *
   * A COMMAND, NOT A STATE. It says what the operator asked for; whether the glass actually
   * went dark comes back through `glassDark()` on the supervisor's next tick, because the
   * panel refuses a sleep while the row is busy and the server is not the place that
   * decides that. Read the outcome from `confirmedReason`, never from this return value.
   */
  setPanelSleep?(on: boolean): Promise<boolean>;
  /**
   * Tell the device which table version is current, so a device holding an older one
   * re-pulls at once instead of waiting out its 300s interval (D-42's version nudge).
   *
   * This is a TRIGGER, not a push: no configuration travels on this path, and the server
   * still keeps no device registry beyond the one host it already writes to. Optional,
   * because a driver that does not model a device (NoopDriver) has nothing to nudge.
   * Never throws - a light that cannot be nudged is not a failed write.
   */
  setTableVersion?(version: number): Promise<void>;
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
