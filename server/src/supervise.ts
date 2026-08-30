import type { LightDriver } from './driver.js';
import { humanMs, stamp } from './log-format.js';
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

  const host = o.driver.host ?? '(no host)';

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastAssertAt = Date.now();
  let lastGoodAt = Date.now();

  /**
   * WHETHER THE PANEL IS REPAINTING, and since when (#84).
   *
   * This line used to fire on every tick - `pollMs` defaults to 5000, so a panel frozen for
   * an hour wrote it 720 times, with no timestamp and no host on any of them. That is the
   * census D-109 took of the driver: 1133 lines, 1127 of them two repeated strings, one
   * event recorded a thousand times. D-109 fixed the driver and left this line alone.
   *
   * So the supervisor holds the state and logs only the EDGES, exactly as the driver does.
   * Steady-state repeats are DROPPED rather than rate-limited: the second identical line
   * says nothing the first did not, and the recovery line's tick count says it better. A
   * panel that FLAPS still logs per transition - alternating results are a different fault
   * from a dead one and must not read like one.
   */
  let frozenSince: number | null = null;
  let frozenTicks = 0;

  /** The panel is not repainting. Silent unless that is news. */
  function notRepainting(): void {
    frozenTicks++;
    if (frozenSince !== null) return;
    frozenSince = Date.now();
    log(`[supervisor] ${stamp()} ${host} NOT REPAINTING: device state agrees but the glass is not moving`);
  }

  /**
   * The panel repainted. Silent unless that is news - which it is exactly once, on the way
   * back, and then the line carries how long the glass was still and how many ticks reported
   * it, which is what tells a flapping panel from a dead one.
   *
   * Called ONLY on a `true` reading. `null` is "cannot tell yet", and treating no evidence
   * as recovery would log a panel back to health it never reached.
   */
  function repainting(): void {
    if (frozenSince === null) return;
    const stillFor = humanMs(Date.now() - frozenSince);
    const n = frozenTicks;
    frozenSince = null;
    frozenTicks = 0;
    log(`[supervisor] ${stamp()} ${host} REPAINTING after ${stillFor} and ${n} frozen ${n === 1 ? 'tick' : 'ticks'}`);
  }

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

    if (painting === true) repainting();
    else if (painting === false) notRepainting();

    let next: string;
    if (got === settled && painting !== false) {
      lastGoodAt = Date.now();
      next = settled;
    } else if (painting === false) {
      next = UNKNOWN_ID;
    } else if (Date.now() - lastGoodAt > decayMs) {
      next = UNKNOWN_ID; // an admission of ignorance, never a claim
    } else {
      next = o.store.get().confirmed; // hold briefly through a single blip
    }

    if (next !== o.store.get().confirmed) o.onChange(o.store.setConfirmed(next));

    // D-42's version nudge lives here rather than on the write path (#68). The driver
    // caches the last version it sent, so on a healthy panel this is a no-op that touches
    // no socket; on a panel that missed `applyConfig`'s nudge it is the retry, which is the
    // whole reason the write path used to carry one.
    if (o.driver.setTableVersion) {
      await bestEffort('setTableVersion', () => o.driver.setTableVersion!(o.store.getTable().version), undefined);
    }
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
