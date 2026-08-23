import type { LightDriver } from './driver.js';
import { isLevel, type Confirmed, type Level } from './state.js';

export interface EsphomeDriverOptions {
  /** "10.42.12.77" or "elegoo-esp32.local". No scheme. */
  host: string;
  /** The ESPHome select NAME, not its object_id. Must match the YAML `name:`. */
  entity?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  retries?: number;
  /** Correlated burst loss on this link makes a zero-gap retry worthless. */
  retryGapMs?: number;
  log?: (line: string) => void;
}

/** A wrong entity name or rejected credentials. A deploy bug, so never retried. */
export class DriverConfigError extends Error {}

/**
 * Drives an ESPHome `select` over web_server's REST API (ESPHome 2026.8.0, esp-idf).
 *
 *   POST /select/<Name>/set?option=<level>  -> 200, EMPTY body, applied AFTER the response.
 *                                              An invalid option is silently dropped, still 200.
 *   GET  /select/<Name>                     -> {"id":"select/<Name>","value":"..","state":".."}
 *   GET  /sensor/Frames                     -> {"id":"sensor/Frames","value":..,"state":".."}
 *
 * NAME COUPLING: the URL segment is the entity `name:` in configs/elegoo-esp32.yaml
 * (web_server.cpp:167). Renaming there breaks every URL here. verifyOptions() catches it.
 */
export class EsphomeSelectDriver implements LightDriver {
  private readonly base: string;
  private readonly entity: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryGapMs: number;
  private readonly log: (line: string) => void;
  private lastFrames: number | null = null;

  constructor(opts: EsphomeDriverOptions) {
    this.base = `http://${opts.host}`;
    this.entity = encodeURIComponent(opts.entity ?? 'Presence');
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = opts.retries ?? 1;
    this.retryGapMs = opts.retryGapMs ?? 400;
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
   */
  async verifyOptions(): Promise<string[] | null> {
    try {
      const res = await fetch(`${this.base}/select/${this.entity}?detail=all`, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) {
        throw new DriverConfigError(`no select entity named "${this.entity}" on ${this.base}`);
      }
      if (res.status === 401) throw new DriverConfigError(`web_server auth rejected by ${this.base}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { option?: unknown };
      return Array.isArray(body.option) ? (body.option as string[]) : null;
    } catch (err) {
      if (err instanceof DriverConfigError) throw err;
      this.log(`[esphome-driver] verifyOptions: device unreachable (${errText(err)})`);
      return null;
    }
  }

  async set(level: Level): Promise<Confirmed> {
    const url = `${this.base}/select/${this.entity}/set?option=${level}`;
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
    if (!ok) return 'unknown';
    // The 200 proves nothing: it is sent before the value is applied, and an invalid
    // option is dropped in silence. Only the read-back is evidence.
    return this.read();
  }

  async read(): Promise<Confirmed> {
    const body = await this.getJson(`${this.base}/select/${this.entity}`);
    const state = (body as { state?: unknown } | null)?.state;
    return isLevel(state) ? state : 'unknown';
  }

  /** true if the device's frame counter advanced since the previous call. */
  async repainted(): Promise<boolean | null> {
    const body = await this.getJson(`${this.base}/sensor/Frames`);
    const n = Number((body as { value?: unknown } | null)?.value);
    if (!Number.isFinite(n)) return null;
    const prev = this.lastFrames;
    this.lastFrames = n;
    return prev === null ? null : n > prev;
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
