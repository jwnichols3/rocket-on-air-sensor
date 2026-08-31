import type { LightDriver } from './driver.js';
import { humanMs, stamp } from './log-format.js';
import { UNKNOWN_ID, type ConfirmedReason, type OnAirState, type StateStore } from './state.js';

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

  /**
   * WHETHER THE GLASS IS OFF ON PURPOSE, and since when (#82). Same edge discipline as
   * above, and it has to be an edge for a reason this one does not share: the panel is dark
   * for EIGHT HOURS a night, so a per-tick line would be roughly 5,760 of them before
   * breakfast, every night, about a panel that is working perfectly.
   */
  let darkSince: number | null = null;

  /**
   * THE LAST THING `glassDark()` ACTUALLY TOLD US (D-132).
   *
   * `glassDark()` returns `null` when it cannot tell, and the first version of this let a
   * `null` fall through into the positive branch - so one dropped packet on the Night sensor
   * published `confirmed: on-air` about a panel that was black, which is precisely the lie
   * #82 was written to remove. Measured before the fix: three consecutive ticks claiming a
   * confirmation of pixels nobody could see.
   *
   * So a `null` HOLDS the last real answer instead of being read as "lit", exactly as
   * `confirmed` itself holds through a single blip. It starts `null`, so a driver that has
   * never successfully read the entity - old firmware, no such sensor - behaves as it always
   * did. And if the reading is ever held forever, it is held at `unknown`, which is an
   * admission of ignorance rather than a claim.
   */
  let lastGlass: boolean | null = null;

  /** The panel went dark on schedule. Not a fault, and the line must not read like one. */
  function goingDark(): void {
    if (darkSince !== null) return;
    darkSince = Date.now();
    // NOT "on schedule". Since #91 the glass can also be dark because somebody pressed a
    // button, and the supervisor cannot tell the two apart - it sees one boolean. A line
    // that named the schedule would be wrong half the time, about the half a person is most
    // likely to be reading it for.
    log(`[supervisor] ${stamp()} ${host} ASLEEP: the glass is dark, confirmed is unknown until it wakes`);
  }

  /** The glass came back. Silent unless that is news. */
  function wakingUp(): void {
    if (darkSince === null) return;
    const asleepFor = humanMs(Date.now() - darkSince);
    darkSince = null;
    log(`[supervisor] ${stamp()} ${host} AWAKE after ${asleepFor}`);
  }

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

    /**
     * CAN ANYONE SEE THE PIXELS? A different question from whether they changed, and the
     * one the old code never asked (#82). The display lambda keeps running with the
     * backlight off, so `Frames` advances all night and `repainted()` says `true` about a
     * panel emitting nothing at all.
     */
    let dark: boolean | null = null;
    if (got === settled && o.driver.glassDark) {
      dark = await bestEffort('glassDark()', () => o.driver.glassDark!(), null);
      if (dark === null) dark = lastGlass; // hold the last real answer through a blip
      else lastGlass = dark;
    }

    if (dark === true) goingDark();
    else if (dark === false) wakingUp();
    if (painting === true) repainting();
    else if (painting === false) notRepainting();

    const cur = o.store.get();
    let next: string;
    let reason: ConfirmedReason | undefined;
    if (dark === true) {
      // FIRST, and it has to be. A dark panel IS repainting, so this test placed any later
      // falls straight through into `next = settled` and reports a confirmation of pixels
      // nobody can see. `unknown` here is this system's word for "no evidence" - never for
      // "broken" - and `asleep` is what stops every surface downstream reading it as a fault.
      next = UNKNOWN_ID;
      reason = 'asleep';
    } else if (got === settled && painting !== false) {
      lastGoodAt = Date.now();
      next = settled;
    } else if (painting === false) {
      next = UNKNOWN_ID;
      reason = 'not-repainting';
    } else if (Date.now() - lastGoodAt > decayMs) {
      next = UNKNOWN_ID; // an admission of ignorance, never a claim
      reason = 'unreachable';
    } else {
      next = cur.confirmed; // hold briefly through a single blip
      reason = cur.confirmedReason;
    }

    // The REASON is part of the change. A panel that goes from frozen to asleep has the
    // same `confirmed` either way, and a surface that alarms on one and not the other has
    // to be told - otherwise the admin console stays yellow through a healthy night.
    if (next !== cur.confirmed || reason !== cur.confirmedReason) {
      o.onChange(o.store.setConfirmed(next, reason));
    }

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
