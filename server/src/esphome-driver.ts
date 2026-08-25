import type { LightDriver } from './driver.js';
import { UNKNOWN_ID } from './state.js';

export interface EsphomeDriverOptions {
  /** "10.42.12.77" or "elegoo-esp32.local". No scheme. */
  host: string;
  /** The ESPHome text NAME, not its object_id. Must match the YAML `name:`. */
  entity?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  retries?: number;
  /** Correlated burst loss on this link makes a zero-gap retry worthless. */
  retryGapMs?: number;
  /** How many times to re-read while waiting for a write to actually land. */
  confirmTries?: number;
  confirmGapMs?: number;
  /** How long the frame counter must sit still before the panel counts as frozen. */
  frozenAfterMs?: number;
  log?: (line: string) => void;
}

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
  private readonly base: string;
  private readonly entity: string;
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

  constructor(opts: EsphomeDriverOptions) {
    this.base = `http://${opts.host}`;
    this.entity = encodeURIComponent(opts.entity ?? 'PresenceKey');
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = opts.retries ?? 1;
    this.retryGapMs = opts.retryGapMs ?? 400;
    this.confirmTries = opts.confirmTries ?? 3;
    this.confirmGapMs = opts.confirmGapMs ?? 80;
    this.frozenAfterMs = opts.frozenAfterMs ?? 20_000;
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
      return true;
    } catch (err) {
      if (err instanceof DriverConfigError) throw err;
      this.log(`[esphome-driver] verifyEntity: device unreachable (${errText(err)})`);
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
        return await fn();
      } catch (err) {
        if (err instanceof DriverConfigError) {
          this.log(`[esphome-driver] CONFIG: ${errText(err)}`);
          return null;
        }
        last = err;
        if (i < this.retries) await new Promise((r) => setTimeout(r, this.retryGapMs));
      }
    }
    this.log(`[esphome-driver] ${errText(last)}`);
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
