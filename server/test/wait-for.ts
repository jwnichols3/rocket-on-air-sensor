// Wait for a condition instead of sleeping and counting (#89).
//
// Two tests here asserted "the timer keeps firing" as `sleep(N)` then `assert(count >= 3)`.
// That encodes a PROPERTY as a race against the scheduler, and under load the scheduler wins:
// measured on this machine at load average 164 - ordinary studio software, not an agent
// workload - `sse.test.ts` failed 1 run in 5, and two consecutive `npm run verify` runs failed
// on a different one of the two tests each time.
//
// That matters more than a rerun. This project has no CI by design, so `npm run verify` is the
// only gate, and a gate that goes red for reasons unrelated to the change trains you to re-run
// instead of read. The run where it bit was the one verifying a system-wide contract change,
// which is exactly when a spurious red is most expensive.
//
// Raising the sleep was rejected: it trades flakiness for a slower suite and only moves a
// threshold that is still fixed against a load that is still unbounded. Lowering the assertion
// to `>= 2` was rejected: two events do not demonstrate "keeps firing". Polling passes
// immediately on a quiet machine, survives a loaded one, and still goes red when the heartbeat
// genuinely stops - which is the behaviour under test.

import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Poll `condition` until it holds, then return. Throws at `timeoutMs`.
 *
 * The deadline is generous ON PURPOSE and is not a timing assertion: it is the point at which
 * "not yet" becomes "never". Tightening it to something that looks like the expected duration
 * reintroduces exactly the margin this helper exists to remove.
 *
 * `message` is evaluated on failure only, so pass a thunk when the diagnosis needs the live
 * count - that is the part of the old assertions worth keeping.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string | (() => string),
  timeoutMs = 2000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // AWAITED. An async predicate returns a Promise, and a Promise is truthy, so a bare
    // `if (condition())` would return on the first tick and pass everything. That is a
    // silently-green test, which is worse than the flake this helper replaced.
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms: ${typeof message === 'function' ? message() : message}`,
      );
    }
    await sleep(stepMs);
  }
}
