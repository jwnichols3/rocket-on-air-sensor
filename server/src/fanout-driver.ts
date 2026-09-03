import type { LightDriver } from './driver.js';
import { humanMs, stamp } from './log-format.js';
import { UNKNOWN_ID } from './state.js';

/**
 * One device, as the fan-out addresses it. The SPEC, not the driver: `reconfigure` compares
 * these to decide whether a device actually moved, so an untouched panel keeps the driver it
 * has - and with it the retry ladder, the frame counter and the `deadSince` gate that took a
 * measurement to calibrate.
 */
export interface DeviceSpec {
  id: string;
  host: string;
  entity: string;
  username: string | null;
  password: string | null;
  /** Exactly one enabled device is the primary. It is the one `confirmed` describes. */
  primary: boolean;
}

/** What `GET /admin/health` reports per device. */
export interface DeviceHealth {
  id: string;
  host: string;
  primary: boolean;
  /** `null` means NEVER CONTACTED, which is not the same thing as unreachable. */
  reachable: boolean | null;
  lastOkAt: string | null;
  lastError: string | null;
}

interface Entry {
  spec: DeviceSpec;
  driver: LightDriver;
  inFlight: boolean;
  reachable: boolean | null;
  lastOkAt: string | null;
  lastError: string | null;
  failingSince: number | null;
}

export interface FanOutOptions {
  specs: DeviceSpec[];
  make: (spec: DeviceSpec) => LightDriver;
  log?: (line: string) => void;
}

/** Two specs address the same device in the same way, so the driver can be kept. */
function sameSpec(a: DeviceSpec, b: DeviceSpec): boolean {
  return (
    a.host === b.host && a.entity === b.entity && a.username === b.username && a.password === b.password
  );
}

/**
 * SEVERAL PANELS, ONE AUTHORITATIVE (D-87, stage 3 of #57).
 *
 * `confirmed` cannot mean "every panel agreed". Rocket's Elegoo is a bench board that is
 * normally off, and an AND over all panels would make `confirmed` permanently false - the
 * system would report a fault as its resting state. So one panel is authoritative and every
 * other one is best-effort: written to, logged when it fails, and otherwise ignored.
 *
 * **That ruling is expressible as a DRIVER, which is why this class exists and why nothing
 * downstream changed.** `supervise.ts` still holds one `LightDriver`, `OnAirState` still
 * carries one `confirmed`, and the wire contract is untouched. `confirmed` goes on meaning a
 * genuine device read from the panel that matters, rather than a quorum that can be gamed by
 * plugging in more hardware.
 *
 * **The fan-out is PARALLEL, and that is load-bearing rather than tidy.** `writeChain` in
 * app.ts is ONE queue shared by every HTTP write and by the supervisor tick, so all device
 * I/O in the process serialises through it. #68 measured 6.4s for a single write against a
 * dead panel. Writing to secondaries in series would put that 6.4s per absent board inside
 * the queue every caller waits on, which is #68 reintroduced through the side door. So
 * `set()` resolves as soon as the PRIMARY answers and secondaries settle behind it.
 */
export class FanOutDriver implements LightDriver {
  private entries: Entry[] = [];
  private readonly make: (spec: DeviceSpec) => LightDriver;
  private readonly log: (line: string) => void;
  /** Outstanding secondary work, so a test (and close()) can wait for quiet. */
  private pending = new Set<Promise<void>>();

  constructor(opts: FanOutOptions) {
    this.make = opts.make;
    this.log = opts.log ?? console.log;
    this.reconfigure(opts.specs);
  }

  /**
   * Adopt a new device list, keeping the driver of every device that did not move.
   *
   * This is what makes an edit in the admin console take effect WITHOUT A RESTART. Before
   * this existed, `applyConfig` saved the document, returned 200, and left the process
   * driving the old panel until somebody restarted the daemon - the same silent-success
   * shape as an env-overridden field (D-79) and a stale binary (D-100).
   *
   * The fan-out reconfigures IN PLACE rather than being rebuilt, so the object captured by
   * `makeServer` and by the supervisor never changes and neither of them needs a rebuild
   * path at all.
   */
  reconfigure(specs: DeviceSpec[]): void {
    const previous = new Map(this.entries.map((e) => [e.spec.id, e]));
    this.entries = specs.map((spec) => {
      const old = previous.get(spec.id);
      if (old && sameSpec(old.spec, spec)) {
        previous.delete(spec.id);
        // Carry the health record across: a save that renamed a label must not make a panel
        // we have been talking to for a week look like one we have never met.
        old.spec = spec;
        return old;
      }
      return {
        spec,
        driver: this.make(spec),
        inFlight: false,
        reachable: null,
        lastOkAt: null,
        lastError: null,
        failingSince: null,
      };
    });
  }

  private primaryEntry(): Entry | undefined {
    return this.entries.find((e) => e.spec.primary);
  }

  /**
   * The authoritative device's driver, so a caller can run a check that only the primary is
   * entitled to fail on.
   *
   * Boot's `verifyEntity()` is the one that matters: a wrong entity name is a deploy bug and
   * must be loud, so a `DriverConfigError` there stops the service. Only the PRIMARY keeps
   * that power - a secondary with a mistyped entity name that could kill the daemon would
   * mean a typo in the admin console bricks the service at its next restart, which is a
   * false OFF with extra steps.
   */
  primaryDriver(): LightDriver | undefined {
    return this.primaryEntry()?.driver;
  }

  /** Every non-authoritative driver, paired with its id so a failure can name the row. */
  secondaryDrivers(): Array<{ id: string; host: string; driver: LightDriver }> {
    return this.secondaries().map((e) => ({ id: e.spec.id, host: e.spec.host, driver: e.driver }));
  }

  /** Record a verdict reached outside the fan-out, e.g. boot verification. */
  markUnreachable(id: string, error: string): void {
    const e = this.entries.find((x) => x.spec.id === id);
    if (e) this.record(e, new Error(error));
  }

  private secondaries(): Entry[] {
    return this.entries.filter((e) => !e.spec.primary);
  }

  get host(): string | undefined {
    return this.primaryEntry()?.spec.host;
  }

  health(): DeviceHealth[] {
    return this.entries.map((e) => ({
      id: e.spec.id,
      host: e.spec.host,
      primary: e.spec.primary,
      reachable: e.reachable,
      lastOkAt: e.lastOkAt,
      lastError: e.lastError,
    }));
  }

  /** Resolves when every outstanding secondary call has settled. Tests and shutdown. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * Record an outcome, and log only the EDGES.
   *
   * #59 was filed about 915 consecutive identical lines that could say neither WHEN a panel
   * went away nor WHICH one. Steady-state repeats are dropped rather than rate-limited: the
   * second identical line says nothing the first did not. A panel that FLAPS still logs per
   * transition, because alternating results are a different fault from a dead one and must
   * not read like one.
   */
  private record(e: Entry, err: unknown): void {
    if (err === undefined) {
      e.reachable = true;
      e.lastOkAt = new Date().toISOString();
      e.lastError = null;
      if (e.failingSince !== null) {
        const down = humanMs(Date.now() - e.failingSince);
        e.failingSince = null;
        this.log(`[fanout] ${stamp()} ${e.spec.host} RECOVERED after ${down}`);
      }
      return;
    }
    e.reachable = false;
    e.lastError = err instanceof Error ? err.message : String(err);
    if (e.failingSince === null) {
      e.failingSince = Date.now();
      this.log(`[fanout] ${stamp()} ${e.spec.host} FAILING: ${e.lastError}`);
    }
  }

  /**
   * Run a secondary call without ever letting it be observed by the caller.
   *
   * A device with a call still in flight is SKIPPED rather than queued behind itself. #68's
   * defect is a queue that grows without bound while a panel is away; a board that is gone
   * for a week must hold at most one outstanding call, not a week of them.
   */
  private fire<T>(e: Entry, run: () => Promise<T>, verdict?: (out: T) => string | undefined): void {
    if (e.inFlight) return;
    e.inFlight = true;
    const p = run().then(
      (out) => {
        // NO VERDICT MEANS NO EVIDENCE, so health is left exactly as it was.
        //
        // `setTableVersion` returns void and swallows its own errors, so it always resolves
        // - including against a board that is switched off. Recording that as a success
        // marked a dead panel healthy on every supervisor tick, which is the console lying
        // about the one thing this route exists to tell the truth about. A REJECTION is
        // still evidence and is still recorded, below; a bare resolution is not.
        if (verdict === undefined) return;
        const bad = verdict(out);
        this.record(e, bad === undefined ? undefined : new Error(bad));
      },
      (err) => void this.record(e, err),
    );
    const tracked = p.finally(() => {
      e.inFlight = false;
      this.pending.delete(tracked);
    });
    this.pending.add(tracked);
  }

  /**
   * Run a primary call, recording health but changing nothing else about its behaviour.
   *
   * THE VERDICT IS READ FROM THE RESULT, NOT FROM THE CALL RESOLVING, and that distinction
   * is the whole of it: `EsphomeTextDriver` never throws - a panel that is switched off
   * answers `unknown` rather than rejecting (D-92, push is best effort). Treating "it
   * resolved" as "it is reachable" therefore reported a dead board as healthy, which is a
   * console lying about the one thing this route was added to tell the truth about.
   */
  private async onPrimary<T>(e: Entry, run: () => Promise<T>, verdict?: (out: T) => string | undefined): Promise<T> {
    try {
      const out = await run();
      // No verdict means no evidence - see `fire`. A rejection still records, below.
      if (verdict !== undefined) {
        const bad = verdict(out);
        this.record(e, bad === undefined ? undefined : new Error(bad));
      }
      return out;
    } catch (err) {
      this.record(e, err);
      throw err;
    }
  }

  /**
   * A write is delivered when the device reports back the value we asked for.
   *
   * WRITING THE `unknown` ROW CARRIES NO EVIDENCE, and that is not a corner case. `unknown`
   * is both a real row a panel can display (D-34) and the sentinel every driver returns when
   * it cannot reach the device - the same string. So `set('unknown')` against a board that
   * is switched off reads back `unknown` and looks like a perfect write. Measured: the boot
   * re-apply writes the persisted state, which is `unknown` on a fresh install, and it
   * marked an absent bench board reachable with a `lastOkAt` it had never earned.
   *
   * `undefined` here means "no verdict", which leaves health untouched rather than claiming
   * either way.
   */
  private static wrote(want: string): ((got: string) => string | undefined) | undefined {
    if (want === UNKNOWN_ID) return undefined;
    return (got) => (got === want ? undefined : `asked for "${want}", device reported "${got}"`);
  }

  async set(stateId: string): Promise<string> {
    const verdict = FanOutDriver.wrote(stateId);
    for (const e of this.secondaries()) this.fire(e, () => e.driver.set(stateId), verdict);
    const primary = this.primaryEntry();
    if (!primary) return UNKNOWN_ID;
    return this.onPrimary(primary, () => primary.driver.set(stateId), verdict);
  }

  async read(): Promise<string> {
    const primary = this.primaryEntry();
    if (!primary) return UNKNOWN_ID;
    // `unknown` from a read means unreachable - that is the driver's own contract for it.
    return this.onPrimary(primary, () => primary.driver.read(), (got) =>
      got === UNKNOWN_ID ? 'read back unknown' : undefined,
    );
  }

  /**
   * THE PRIMARY AND NOBODY ELSE, for all three readings.
   *
   * `confirmed` describes one panel's pixels. Asking a secondary whether it repainted, or
   * whether its glass is dark, would put a second panel's answer into a field the contract
   * says is about the authoritative one - and D-87 rules that out explicitly.
   */
  async repainted(): Promise<boolean | null> {
    const primary = this.primaryEntry();
    if (!primary?.driver.repainted) return null;
    return primary.driver.repainted();
  }

  async glassDark(): Promise<boolean | null> {
    const primary = this.primaryEntry();
    if (!primary?.driver.glassDark) return null;
    return primary.driver.glassDark();
  }

  /**
   * Every panel darkens, and the primary is what gets reported.
   *
   * A sleep button that darkened one of two panels in the room would be a worse answer than
   * one that darkened neither, because the room would look attended to.
   */
  async setPanelSleep(on: boolean): Promise<boolean> {
    for (const e of this.secondaries()) {
      if (e.driver.setPanelSleep) {
        this.fire(e, () => e.driver.setPanelSleep!(on), (ok) => (ok ? undefined : 'the sleep command did not land'));
      }
    }
    const primary = this.primaryEntry();
    if (!primary?.driver.setPanelSleep) return false;
    return this.onPrimary(primary, () => primary.driver.setPanelSleep!(on), (ok) =>
      ok ? undefined : 'the sleep command did not land',
    );
  }

  /** D-42's version nudge, to every panel: they all pull the same table. */
  async setTableVersion(version: number): Promise<void> {
    for (const e of this.secondaries()) {
      if (e.driver.setTableVersion) this.fire(e, () => e.driver.setTableVersion!(version));
    }
    const primary = this.primaryEntry();
    if (!primary?.driver.setTableVersion) return;
    await this.onPrimary(primary, () => primary.driver.setTableVersion!(version));
  }
}
