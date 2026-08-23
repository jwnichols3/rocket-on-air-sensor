import type { LightDriver } from './driver.js';
import { RANK, type Confirmed, type Level, type OnAirState, type StateStore } from './state.js';

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
  /** Matches the device's STALE_MS. */
  freshS?: number;
  log?: (line: string) => void;
}

export function startSupervisor(o: SuperviseOptions): { stop: () => void } {
  const pollMs = o.pollMs ?? 5000;
  const reassertMs = o.reassertMs ?? 60000;
  const decayMs = o.decayMs ?? 30000;
  const freshS = o.freshS ?? 90;
  const log = o.log ?? console.log;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastAssertAt = Date.now();
  let lastGoodAt = Date.now();

  /**
   * THE LADDER RULE, in code. Raising or matching is always allowed; lowering requires
   * fresh evidence. Absence of information never renders below dnd.
   */
  function mayAssert(want: Level, got: Confirmed): boolean {
    const fresh = o.store.ageSeconds() <= freshS;
    if (got === 'unknown') return fresh || want !== 'available';
    return RANK[want] >= RANK[got] || fresh;
  }

  async function tick(): Promise<void> {
    const want = o.store.get().level;
    const due = Date.now() - lastAssertAt >= reassertMs;

    // The heartbeat, but only if we are allowed to assert `want` right now. Withholding
    // it is not a state change - it is withdrawal of a liveness assertion, which lets
    // the device's own watchdog trip into NO DATA instead of a confidently stale calm.
    let got: Confirmed;
    if (due && mayAssert(want, 'unknown')) {
      got = await o.driver.set(want);
      if (got === want) lastAssertAt = Date.now(); // ONLY a successful set() refreshes it
    } else {
      got = await o.driver.read();
    }

    if (got !== 'unknown' && got !== want) {
      if (mayAssert(want, got)) {
        log(`[supervisor] device says ${got}, want ${want} - re-asserting`);
        got = await o.driver.set(want);
        if (got === want) lastAssertAt = Date.now();
      } else {
        // Deferring is not the same as disagreeing forever. `level` is what every other
        // renderer draws, so leaving it stale strands them on the old value and re-logs
        // this same line every tick with nothing converging. Adopt the device's rung -
        // raising is always ladder-legal, and a live read is the freshest evidence there
        // is. `want` is recomputed below so the rest of the tick sees the new level.
        log(`[supervisor] device says ${got}, our stale ${want} is lower - adopting the device`);
        o.store.write(got, 'device');
        o.onChange(o.store.get());
      }
    }

    // Re-read: the deferral branch above may have adopted the device's rung.
    const settled = o.store.get().level;

    // confirmed must describe PIXELS, not a variable.
    let painting: boolean | null = null;
    if (got === settled && o.driver.repainted) painting = await o.driver.repainted();

    let next: Confirmed;
    if (got === settled && painting !== false) {
      lastGoodAt = Date.now();
      next = settled;
    } else if (painting === false) {
      log('[supervisor] device state agrees but the panel is not repainting');
      next = 'unknown';
    } else if (Date.now() - lastGoodAt > decayMs) {
      next = 'unknown'; // an admission of ignorance, never a claim
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
  // resolve fast, and awaiting a multi-second driver.set would break that. Abandoning
  // the queue's promise chain is safe - tick() only mutates an in-memory store the
  // process is about to drop.
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
