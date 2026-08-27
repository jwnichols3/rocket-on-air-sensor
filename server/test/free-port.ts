// A port for a test that has to name one. Shared, because both suites that spawn the real
// service had their own copy of this and both copies had the same two bugs (#58).
import { createServer } from 'node:http';

/**
 * THE BAND, and why it is not the ephemeral range.
 *
 * The reported flake was `EADDRINUSE :::54460` during a rebind test. 54460 is inside the OS
 * ephemeral range - macOS allocates 49152-65535, Linux 32768-60999 - so a port handed out by
 * `listen(0)` and then released can be taken back by ANY other connection on the machine
 * before the test binds it: a browser tab, another test file, an outbound fetch. Probing a
 * port and then using it is inherently a gap, and picking from the one range the kernel hands
 * out at random makes that gap as wide as it can be.
 *
 * 20000-32767 is below both ephemeral ranges, so nothing on the machine will spontaneously
 * land here. Anything squatting in this band is a real long-lived service, which the probe
 * below finds and skips.
 */
const BAND_FIRST = 20_000;
const BAND_LAST = 32_767;
const BAND_SIZE = BAND_LAST - BAND_FIRST + 1;

/**
 * ONE SLICE OF THE BAND PER PROCESS. The test runner gives each test FILE its own process and
 * runs them concurrently, so "probe it, then let the caller bind it" is a race between files
 * as much as against the machine. Two processes that never look at the same port cannot lose
 * that race at all.
 *
 * `pid % SLICES` and not a hash: the runner spawns its workers back to back, so their pids
 * are near-consecutive and land in distinct slices. A hash would scatter them and let two
 * collide for no reason.
 */
const SLICES = 64;
const SLICE_SIZE = Math.floor(BAND_SIZE / SLICES);
const SLICE_FIRST = BAND_FIRST + (process.pid % SLICES) * SLICE_SIZE;
let cursor = 0;

/**
 * A port that is free right now, proven on the SAME scope the service binds.
 *
 * `resolveBind('all')` returns `['::']` and `listenAll()` binds that - the dual-stack
 * wildcard. The old helper probed `127.0.0.1`, which is a strictly smaller claim: a port
 * held on `::1`, or on a LAN address, is free on loopback and NOT free on the wildcard. The
 * reported failure was exactly that shape, and the ticket's own fix direction pointed at the
 * wrong code - the `blocker` it named already binds atomically.
 *
 * Still not atomic, and it cannot be: the service does its own `listen()`, so proving a port
 * free and taking it are always two steps. What is gone is both reasons the gap could
 * actually lose - the port is no longer one the kernel might reissue, and "free" now means
 * free where it will be bound.
 */
export async function freePort(): Promise<number> {
  for (let i = 0; i < SLICE_SIZE; i++) {
    const port = SLICE_FIRST + (cursor++ % SLICE_SIZE);
    if (await bindable(port)) return port;
  }
  throw new Error(`no free port in ${SLICE_FIRST}..${SLICE_FIRST + SLICE_SIZE - 1}`);
}

/** Binds the wildcard, exactly as listenAll() does, and closes again. */
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer(() => {});
    s.once('error', () => resolve(false));
    // No host: the dual-stack wildcard, which is what `bind: 'all'` resolves to.
    s.listen(port, () => s.close(() => resolve(true)));
  });
}
