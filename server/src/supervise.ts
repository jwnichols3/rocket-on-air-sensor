import type { LightDriver } from './driver.js';
import { UNKNOWN_ID, type OnAirState, type StateStore } from './state.js';

export interface SuperviseOptions {
  store: StateStore;
  driver: LightDriver;
  /** Wrap every store/driver mutation, so supervisor writes serialise with HTTP writes. */
  enqueue: (run: () => Promise<void>) => Promise<void>;
  /** Called only when `confirmed` actually changes: one event per transition. */
  onChange: (state: OnAirState) => void;
  pollMs?: number;
  /** How often to re-push `state` to the panel. A NOTIFICATION, not a delivery guarantee (D-92). */
  reassertMs?: number;
  decayMs?: number;
  log?: (line: string) => void;
}

export function startSupervisor(o: SuperviseOptions): { stop: () => void } {
  const pollMs = o.pollMs ?? 5000;
  const reassertMs = o.reassertMs ?? 60000;
  const decayMs = o.decayMs ?? 30000;
  const log = o.log ?? console.log;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastAssertAt = Date.now();
  let lastGoodAt = Date.now();

  /**
   * THE BUSY RULE'S SERVER HALF IS GONE (D-91, superseding the server half of D-32). The
   * supervisor used to withhold a calm assertion once the state was 90s old, and to adopt
   * the device's busy reading over its own. Both were the server reading a clock to decide
   * what the state IS. It latches now: `want` is asserted whenever it is due, at any age,
   * and a device that disagrees is re-asserted over rather than believed. The judgement
   * that used to live here now lives in each renderer, about its own connection.
   */

  /**
   * PUSH IS BEST EFFORT (D-92). A driver that throws is a panel that is not listening, and
   * that is not an error the supervisor propagates: it is logged and reported as `unknown`,
   * which is "no evidence" rather than a claim. Letting the throw escape would abandon the
   * tick before the `confirmed` bookkeeping below, so a panel that fell over mid-tick would
   * freeze `confirmed` at its last good value forever instead of decaying it.
   */
  async function bestEffort<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log(`[supervisor] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  async function tick(): Promise<void> {
    const table = o.store.getTable();
    const want = o.store.get().state;
    const due = Date.now() - lastAssertAt >= reassertMs;

    let got: string;
    if (due) {
      got = await bestEffort(`set(${want})`, () => o.driver.set(want), UNKNOWN_ID);
      if (got === want) lastAssertAt = Date.now(); // ONLY a successful set() refreshes it
    } else {
      got = await bestEffort('read()', () => o.driver.read(), UNKNOWN_ID);
    }

    if (got !== UNKNOWN_ID && got !== want) {
      // The device is a RENDERER, not a source. Whatever it holds got there from this
      // server or from a hand-poked entity; either way it is never newer than `want`.
      log(
        table.has(got)
          ? `[supervisor] device says ${got}, want ${want} - re-asserting`
          : `[supervisor] device holds "${got}", which is not in the table - re-asserting ${want}`,
      );
      got = await bestEffort(`set(${want})`, () => o.driver.set(want), UNKNOWN_ID);
      if (got === want) lastAssertAt = Date.now();
    }

    const settled = want;

    // confirmed must describe PIXELS, not a variable.
    let painting: boolean | null = null;
    if (got === settled && o.driver.repainted) {
      painting = await bestEffort('repainted()', () => o.driver.repainted!(), null);
    }

    let next: string;
    if (got === settled && painting !== false) {
      lastGoodAt = Date.now();
      next = settled;
    } else if (painting === false) {
      log('[supervisor] device state agrees but the panel is not repainting');
      next = UNKNOWN_ID;
    } else if (Date.now() - lastGoodAt > decayMs) {
      next = UNKNOWN_ID; // an admission of ignorance, never a claim
    } else {
      next = o.store.get().confirmed; // hold briefly through a single blip
    }

    if (next !== o.store.get().confirmed) o.onChange(o.store.setConfirmed(next));
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      o.enqueue(tick)
        .catch((err) => log(`[supervisor] ${String(err)}`))
        .finally(schedule);
    }, pollMs);
    timer.unref?.();
  }
  schedule();

  // stop() is SYNCHRONOUS and does not await an in-flight tick: close() is asserted to
  // resolve fast, and awaiting a multi-second driver.set would break that. Abandoning the
  // queue's promise chain is safe - tick() only mutates an in-memory store the process is
  // about to drop.
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
