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
  /** Also refreshes the device's own STALE watchdog. */
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
   * THE BUSY RULE, in code (contract §3, D-32).
   *
   * > The server never moves from a `busy: true` state to a `busy: false` state, and never
   * > asserts a `busy: false` state to a renderer, on the strength of evidence that is
   * > stale. Moving to or staying at `busy: true` is always allowed.
   *
   * This is the ladder rule's replacement, and the substitution is exact: what used to be
   * "never lower the rung without fresh evidence" is now "never go calm without fresh
   * evidence". There is no rank left to compare, and there does not need to be - `busy` was
   * always the only thing the rank encoded that mattered.
   */
  function mayAssert(want: string): boolean {
    const table = o.store.getTable();
    if (table.busy(want)) return true; // busy is always allowed, fresh or not
    return !o.store.stale();
  }

  async function tick(): Promise<void> {
    const table = o.store.getTable();
    const want = o.store.get().state;
    const due = Date.now() - lastAssertAt >= reassertMs;

    // The heartbeat, but only if we are allowed to assert `want` right now. Withholding it
    // is not a state change - it is withdrawal of a liveness assertion, which lets the
    // device's own watchdog trip into NO DATA instead of a confidently stale calm.
    let got: string;
    if (due && mayAssert(want)) {
      got = await o.driver.set(want);
      if (got === want) lastAssertAt = Date.now(); // ONLY a successful set() refreshes it
    } else {
      got = await o.driver.read();
    }

    if (got !== UNKNOWN_ID && got !== want) {
      // A device holding a key that is not in the table is not evidence of anything this
      // system can adopt - it is a stale firmware or a hand-poked entity. Re-assert over it.
      const adoptable = table.has(got);
      if (!adoptable || mayAssert(want)) {
        if (!adoptable) log(`[supervisor] device holds "${got}", which is not in the table - re-asserting ${want}`);
        else log(`[supervisor] device says ${got}, want ${want} - re-asserting`);
        got = await o.driver.set(want);
        if (got === want) lastAssertAt = Date.now();
      } else {
        // Deferring is not the same as disagreeing forever. `state` is what every other
        // renderer draws, so leaving it stale strands them on the old value and re-logs this
        // same line every tick with nothing converging. Adopt the device's state - moving to
        // a busy row is always allowed, and a live read is the freshest evidence there is.
        log(`[supervisor] device says ${got}, our stale ${want} is calm - adopting the device`);
        o.store.write(got, { kind: 'auto', label: 'device', raw: 'auto:device' });
        o.onChange(o.store.get());
      }
    }

    // Re-read: the deferral branch above may have adopted the device's state.
    const settled = o.store.get().state;

    // confirmed must describe PIXELS, not a variable.
    let painting: boolean | null = null;
    if (got === settled && o.driver.repainted) painting = await o.driver.repainted();

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
