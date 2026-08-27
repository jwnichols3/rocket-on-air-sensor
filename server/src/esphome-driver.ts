import type { LightDriver } from './driver.js';
import { UNKNOWN_ID } from './state.js';

export interface EsphomeDriverOptions {
  /** "10.42.12.77" or "elegoo-esp32.local". No scheme. */
  host: string;
  /** The ESPHome text NAME, not its object_id. Must match the YAML `name:`. */
  entity?: string;
  /** The ESPHome text NAME carrying the table version (D-42's nudge). */
  versionEntity?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  retries?: number;
  /** Correlated burst loss on this link makes a zero-gap retry worthless. */
  retryGapMs?: number;
  /** How many times to re-read while waiting for a write to actually land. */
  confirmTries?: number;
  confirmGapMs?: number;
  /**
   * How long the frame counter must sit still before the panel counts as frozen.
   *
   * MUST EXCEED THE PANEL'S SLOWEST LEGITIMATE REPAINT, with room for a miss. That is a
   * coupling to the firmware and it is stated here because it has already bitten once: #64
   * made the paint on-change with a 30s safety net, so an idle panel repaints twice a
   * minute - and against the old 20s default a perfectly healthy panel read as FROZEN and
   * `confirmed` sat at `unknown` forever.
   */
  frozenAfterMs?: number;
  log?: (line: string) => void;
}

/**
 * The freeze threshold, exported so a test can hold it against the firmware interval it is
 * calibrated to. 90s = three of the panel's 30s safety-net repaints (#64).
 */
export const DEFAULT_FROZEN_AFTER_MS = 90_000;

/** A wrong entity name or rejected credentials. A deploy bug, so never retried. */
export class DriverConfigError extends Error {}

/**
 * Drives an ESPHome `text` over web_server's REST API (ESPHome 2026.8.0, esp-idf).
 *
 *   POST /text/<Name>/set?value=<key>  -> 200, EMPTY body, applied AFTER the response.
 *                                         An invalid value is silently dropped, still 200.
 *   GET  /text/<Name>                  -> {"id","value","state","min_length","max_length","pattern"}
 *   GET  /sensor/Frames                -> {"id":"sensor/Frames","value":..,"state":".."}
 *
 * WHY `text` AND NOT `select` (D-38): a `select` asserts the FIRMWARE owns the set of valid
 * states. Here the server owns it and the panel is a renderer, which `text` encodes correctly.
 * The cost is that the device no longer rejects a key it does not know - validation is the
 * server's job now.
 *
 * This driver deliberately does NOT hold the state table. It reports the raw key the device
 * has, and the caller - which does hold the table - decides whether that is a row it knows.
 * Putting the table in here would mean two copies of the vocabulary that could disagree.
 *
 * NAME COUPLING: the URL segment is the entity `name:` in the firmware YAML
 * (web_server.cpp:167). Renaming there breaks every URL here. verifyEntity() catches it.
 */
export class EsphomeTextDriver implements LightDriver {
  private readonly host: string;
  private readonly base: string;
  private readonly entity: string;
  private readonly versionEntity: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryGapMs: number;
  private readonly confirmTries: number;
  private readonly confirmGapMs: number;
  private readonly frozenAfterMs: number;
  private readonly log: (line: string) => void;
  private lastFrames: number | null = null;
  private lastFrameChangeAt = 0;
  private lastVersionSent: number | null = null;
  private versionEntityMissing = false;
  /**
   * WHETHER THIS HOST IS ANSWERING, and since when. The log's whole job in an outage is to
   * answer two questions - *when did it go, and which one* - and describing every poll
   * answers neither. Measured on the live daemon log the day this was written: **1133
   * `[esphome-driver]` lines, 1127 of them two repeated strings** ("fetch failed" 910 times,
   * "The operation was aborted due to timeout" 217). One event, recorded a thousand times,
   * with no timestamp and no host on any of them (#59).
   *
   * So the driver holds the state and logs only the EDGES. Steady-state repeats are dropped
   * entirely rather than rate-limited: the second identical line already says nothing the
   * first did not, and a counter on the recovery line says it better.
   *
   * A host that FLAPS still logs per transition, which is the honest answer - alternating
   * results are a different fault from a dead panel and should not read like one. The
   * recovery line's failure count is what tells them apart at a glance.
   */
  private failingSince: number | null = null;
  private failedCalls = 0;
  private configErrorLogged = false;

  constructor(opts: EsphomeDriverOptions) {
    this.host = opts.host;
    this.base = `http://${opts.host}`;
    this.entity = encodeURIComponent(opts.entity ?? 'PresenceKey');
    this.versionEntity = encodeURIComponent(opts.versionEntity ?? 'TableVersion');
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = opts.retries ?? 1;
    this.retryGapMs = opts.retryGapMs ?? 400;
    this.confirmTries = opts.confirmTries ?? 3;
    this.confirmGapMs = opts.confirmGapMs ?? 80;
    // 90s = three of the firmware's 30s safety-net repaints. Raise this if that interval
    // ever grows; a freeze detector calibrated below the panel's own idle rate does not
    // detect freezes, it manufactures them.
    this.frozenAfterMs = opts.frozenAfterMs ?? DEFAULT_FROZEN_AFTER_MS;
    this.log = opts.log ?? console.log;
    this.headers = opts.username
      ? { authorization: `Basic ${Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64')}` }
      : {};
  }

  /**
   * One-shot startup check, deliberately un-retried so it can distinguish the two
   * failures that must be told apart:
   *   throws DriverConfigError -> wrong entity name (404) or bad credentials (401). Loud.
   *   returns null             -> the device is unreachable. Not an error; do not crash.
   *   returns true             -> the entity is there.
   *
   * It asks the entity for nothing beyond its own existence. `select` could be asked for
   * its compiled option list, which let the service warn that firmware was stale; `text`
   * has no such list and is not supposed to (D-38). That check is gone, not replaced.
   */
  async verifyEntity(): Promise<true | null> {
    try {
      const res = await fetch(`${this.base}/text/${this.entity}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) {
        throw new DriverConfigError(`no text entity named "${this.entity}" on ${this.base}`);
      }
      if (res.status === 401) throw new DriverConfigError(`web_server auth rejected by ${this.base}`);
      if (!res.ok) return null;
      await res.arrayBuffer();
      this.reachable();
      return true;
    } catch (err) {
      if (err instanceof DriverConfigError) throw err;
      // No bespoke line here any more. Boot is the FIRST contact, so a dead host at startup
      // is an edge like any other and gets the same stamped, host-named line - which is the
      // one a person reads first when asking how long this has been going on.
      this.unreachable(err);
      return null;
    }
  }

  async set(stateId: string): Promise<string> {
    const url = `${this.base}/text/${this.entity}/set?value=${encodeURIComponent(stateId)}`;
    // fetch() with no body sends Content-Length: 0 and no Content-Type, which is what
    // the device requires - web_server_idf returns 411 if Content-Length is absent.
    const ok = await this.attempt(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) throw new DriverConfigError(`404 ${url}`);
      if (!res.ok) throw new Error(`POST ${res.status}`);
      await res.arrayBuffer();
      return true;
    });
    if (!ok) return UNKNOWN_ID;
    // The 200 proves nothing: it is sent before the value is applied, and an invalid
    // value is dropped in silence. Only the read-back is evidence. Under `text` the
    // silent drop is a LENGTH violation rather than enum membership (measured, D-44:
    // an over-length write and an empty write both returned 200 and changed nothing),
    // which is a different cause reaching the same conclusion.
    //
    // "Before the value is applied" is literal - web_server.cpp defers the action and
    // answers first - so a read-back issued immediately can still see the PREVIOUS
    // value. Re-read across that gap rather than reporting a state we just overwrote.
    // A write that genuinely never lands still reports the truth; it just costs a
    // couple of extra reads first.
    let got: string = UNKNOWN_ID;
    for (let i = 0; i < this.confirmTries; i++) {
      got = await this.read();
      if (got === stateId) return got;
      if (i < this.confirmTries - 1) await new Promise((r) => setTimeout(r, this.confirmGapMs));
    }
    return got;
  }

  /**
   * D-42's version nudge: writes the current table version to a small entity on the
   * device. A device holding a version it does not recognise re-pulls `GET /config/states`
   * at once, so an edit in the admin console reaches the panel in a round trip instead of
   * up to 300 seconds later.
   *
   * Three things this deliberately does NOT do:
   *   - It does not read back. The nudge is advisory; the pull is what carries the table,
   *     and a nudge that silently failed costs at most one 300s interval. Paying three
   *     extra reads for that on every state write is the wrong trade.
   *   - It does not retry a MISSING entity. Firmware older than #43 has no TableVersion
   *     and answers 404 forever. Logging that on every write would bury the log in a
   *     message about a feature that host does not have yet.
   *   - It does not cache a version it failed to send, so an unreachable device is nudged
   *     again on the next write rather than being written off.
   */
  async setTableVersion(version: number): Promise<void> {
    if (this.versionEntityMissing || this.lastVersionSent === version) return;
    const url = `${this.base}/text/${this.versionEntity}/set?value=${encodeURIComponent(String(version))}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.arrayBuffer();
      if (res.status === 404) {
        this.versionEntityMissing = true;
        this.log(`[esphome-driver] no "${this.versionEntity}" entity - firmware predates the version nudge`);
        return;
      }
      if (!res.ok) throw new Error(`POST ${res.status}`);
      this.lastVersionSent = version;
      this.reachable();
    } catch (err) {
      // The nudge does not get its own failure line. It is a request to the same host as
      // every other, so it feeds the same edge detector - otherwise a dead panel produces a
      // second stream of identical lines saying what the first stream already said.
      this.unreachable(err);
    }
  }

  async read(): Promise<string> {
    const body = await this.getJson(`${this.base}/text/${this.entity}`);
    const state = (body as { state?: unknown } | null)?.state;
    // An unreachable device, an unparseable body and a device holding an empty string are
    // all the same thing here: no evidence. `unknown` is a real row, and it is never calm.
    return typeof state === 'string' && state !== '' ? state : UNKNOWN_ID;
  }

  /**
   * Has the panel repainted? `true` advanced, `false` demonstrably stuck, `null` cannot
   * tell yet.
   *
   * An unchanged counter is NOT evidence the panel stopped. The device republishes
   * `Frames` on its own interval, so polling at a comparable rate sees the same value
   * twice as a matter of course - and reporting that as frozen drops `confirmed` to
   * `unknown` on a perfectly healthy panel. Only a counter that has sat still longer
   * than any plausible publish interval is real evidence.
   *
   * "Any plausible publish interval" is a moving target and it MOVED: it meant ~1s when
   * this was written, and #64 made the paint on-change so an idle panel now repaints once
   * per 30s. See `frozenAfterMs`.
   */
  async repainted(): Promise<boolean | null> {
    const body = await this.getJson(`${this.base}/sensor/Frames`);
    const n = Number((body as { value?: unknown } | null)?.value);
    if (!Number.isFinite(n)) return null;
    const prev = this.lastFrames;
    const now = Date.now();
    if (prev === null || n > prev) {
      this.lastFrames = n;
      this.lastFrameChangeAt = now;
      return prev === null ? null : true;
    }
    // A counter that went BACKWARDS means the device rebooted - which is a repaint, and
    // re-baselines the comparison rather than reading as 20 seconds of frozen panel.
    if (n < prev) {
      this.lastFrames = n;
      this.lastFrameChangeAt = now;
      return true;
    }
    return now - this.lastFrameChangeAt > this.frozenAfterMs ? false : null;
  }

  private async getJson(url: string): Promise<unknown> {
    return this.attempt(async () => {
      const res = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`GET ${res.status}`);
      return (await res.json()) as unknown;
    });
  }

  /**
   * Runs fn with `retries` extra attempts, spaced by retryGapMs. Returns null instead of
   * throwing: a dead light must never take the service down. A DriverConfigError is not
   * retried - it will fail identically every time.
   */
  private async attempt<T>(fn: () => Promise<T>): Promise<T | null> {
    let last: unknown;
    for (let i = 0; i <= this.retries; i++) {
      try {
        const value = await fn();
        this.reachable();
        return value;
      } catch (err) {
        if (err instanceof DriverConfigError) {
          // A wrong entity name or rejected credentials fails identically forever, so the
          // hundredth line is worth exactly as much as the first. Said once, then silent
          // until this host answers again - which is the only event that can change it.
          if (!this.configErrorLogged) {
            this.configErrorLogged = true;
            this.log(`[esphome-driver] ${stamp()} ${this.host} CONFIG: ${errText(err)}`);
          }
          return null;
        }
        last = err;
        if (i < this.retries) await new Promise((r) => setTimeout(r, this.retryGapMs));
      }
    }
    this.unreachable(last);
    return null;
  }

  /**
   * A call got through. Silent unless that is news - which it is exactly once, on the way
   * back up, and then the line carries the two numbers a person actually wants: how long the
   * host was gone and how much traffic it swallowed while it was.
   */
  private reachable(): void {
    if (this.failingSince === null) return;
    const downFor = humanMs(Date.now() - this.failingSince);
    const n = this.failedCalls;
    this.failingSince = null;
    this.failedCalls = 0;
    this.configErrorLogged = false;
    this.log(`[esphome-driver] ${stamp()} ${this.host} BACK after ${downFor} and ${n} failed ${n === 1 ? 'call' : 'calls'}`);
  }

  /** A call failed. Only the first one after a success is worth a line. */
  private unreachable(err: unknown): void {
    this.failedCalls++;
    if (this.failingSince !== null) return;
    this.failingSince = Date.now();
    this.log(`[esphome-driver] ${stamp()} ${this.host} UNREACHABLE: ${errText(err)}`);
  }
}

/**
 * A timestamp on the line, because nothing else in this log has one and "when did the panel
 * go away" is the first question anyone asks of a device whose whole job is to be current.
 *
 * Deliberately only on these lines rather than on every line the service emits. Stamping the
 * sink would be the better log and it is a different change - it rewrites the output of every
 * component and the deploy tests that read it. An edge line that is stamped also anchors the
 * unstamped lines around it, which is most of the value for a tenth of the blast radius.
 */
function stamp(): string {
  return new Date().toISOString();
}

/** Coarse on purpose: "3h 2m" answers the question, "10932847ms" makes the reader do sums. */
function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
