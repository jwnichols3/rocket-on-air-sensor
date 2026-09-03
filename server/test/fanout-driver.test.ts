import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LightDriver } from '../src/driver.js';
import { FanOutDriver, type DeviceSpec } from '../src/fanout-driver.js';
import { UNKNOWN_ID } from '../src/state.js';

/**
 * A driver stand-in with a settable outcome and a gate, so a test can hold a call open and
 * assert what the fan-out does WHILE it is in flight. That is the only way to test the
 * skip-if-in-flight rule: a driver that resolves immediately can never be caught busy.
 */
class FakeDriver implements LightDriver {
  sets: string[] = [];
  reads = 0;
  repaints = 0;
  glassReads = 0;
  sleeps: boolean[] = [];
  versions: number[] = [];
  /** What `set` returns. `throws` makes it reject instead. */
  answer: string | 'throws' = 'ok';
  /** When set, `set` blocks on this until the test resolves it. */
  gate: { promise: Promise<void>; open: () => void } | null = null;

  readonly host: string;

  constructor(host: string) {
    this.host = host;
  }

  static gated(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  }

  async set(stateId: string): Promise<string> {
    this.sets.push(stateId);
    if (this.gate) await this.gate.promise;
    if (this.answer === 'throws') throw new Error(`${this.host} is gone`);
    return this.answer === 'ok' ? stateId : this.answer;
  }
  async read(): Promise<string> {
    this.reads++;
    return this.answer === 'throws' ? UNKNOWN_ID : 'read-value';
  }
  async repainted(): Promise<boolean | null> {
    this.repaints++;
    return true;
  }
  async glassDark(): Promise<boolean | null> {
    this.glassReads++;
    return false;
  }
  async setPanelSleep(on: boolean): Promise<boolean> {
    this.sleeps.push(on);
    return true;
  }
  async setTableVersion(version: number): Promise<void> {
    this.versions.push(version);
  }
}

function spec(id: string, over: Partial<DeviceSpec> = {}): DeviceSpec {
  return {
    id,
    host: `${id}.local`,
    entity: 'PresenceKey',
    username: null,
    password: null,
    primary: false,
    ...over,
  };
}

/** Build a fan-out over the given specs, handing back the fakes by device id. */
function build(specs: DeviceSpec[]): {
  driver: FanOutDriver;
  made: Map<string, FakeDriver>;
  lines: string[];
} {
  const made = new Map<string, FakeDriver>();
  const lines: string[] = [];
  const driver = new FanOutDriver({
    specs,
    make: (s) => {
      const d = new FakeDriver(s.host);
      made.set(s.id, d);
      return d;
    },
    log: (l) => lines.push(l),
  });
  return { driver, made, lines };
}

const TWO = [spec('crow', { primary: true }), spec('elegoo')];

// ---------------------------------------------------------------- the primary decides

test('set writes to every device but returns the PRIMARY answer', async () => {
  const { driver, made } = build(TWO);
  made.get('elegoo')!.answer = 'stale-row';

  assert.equal(await driver.set('on-air'), 'on-air');
  assert.deepEqual(made.get('crow')!.sets, ['on-air']);
  await driver.settled();
  assert.deepEqual(made.get('elegoo')!.sets, ['on-air'], 'the secondary was never written to');
});

test('a THROWING secondary cannot change what set returns', async () => {
  const { driver, made } = build(TWO);
  made.get('elegoo')!.answer = 'throws';

  // The whole of D-87 in one assertion: a secondary that is gone is not a failed write.
  assert.equal(await driver.set('on-air'), 'on-air');
  await driver.settled();
  assert.equal(driver.health().find((h) => h.id === 'elegoo')!.reachable, false);
  assert.equal(driver.health().find((h) => h.id === 'crow')!.reachable, true);
});

test('a throwing PRIMARY still propagates, exactly as one driver did', async () => {
  const { driver, made } = build(TWO);
  made.get('crow')!.answer = 'throws';
  await assert.rejects(() => driver.set('on-air'), /crow\.local is gone/);
});

test('read, repainted and glassDark ask the PRIMARY and nobody else', async () => {
  // The primary is deliberately NOT first. With it first, `entries[0]` and "the primary"
  // are the same node and this test passes for a driver that just asks whoever is at the
  // front of the list. Measured: reordering is what makes that mutation bite.
  const { driver, made } = build([spec('elegoo'), spec('crow', { primary: true })]);
  assert.equal(await driver.read(), 'read-value');
  assert.equal(await driver.repainted(), true);
  assert.equal(await driver.glassDark(), false);

  assert.equal(made.get('crow')!.reads, 1);
  assert.equal(made.get('crow')!.repaints, 1);
  assert.equal(made.get('crow')!.glassReads, 1);
  const secondary = made.get('elegoo')!;
  assert.equal(secondary.reads + secondary.repaints + secondary.glassReads, 0, 'a secondary was polled');
});

test('host names the primary, so every log line already written keeps naming it', () => {
  const { driver } = build(TWO);
  assert.equal(driver.host, 'crow.local');
});

// ---------------------------------------------------------------- fan-out of commands

test('panel sleep reaches every device and reports the primary', async () => {
  const { driver, made } = build(TWO);
  assert.equal(await driver.setPanelSleep(true), true);
  await driver.settled();
  assert.deepEqual(made.get('crow')!.sleeps, [true]);
  assert.deepEqual(made.get('elegoo')!.sleeps, [true], 'the second panel stayed lit');
});

test('the table-version nudge reaches every device', async () => {
  const { driver, made } = build(TWO);
  await driver.setTableVersion(12);
  await driver.settled();
  assert.deepEqual(made.get('crow')!.versions, [12]);
  assert.deepEqual(made.get('elegoo')!.versions, [12]);
});

// ---------------------------------------------------------------- the queue protections

test('a secondary whose write is still IN FLIGHT is skipped, not queued behind itself', async () => {
  const { driver, made } = build(TWO);
  const elegoo = made.get('elegoo')!;
  elegoo.gate = FakeDriver.gated();

  await driver.set('on-air');
  await driver.set('available');
  await driver.set('recording');

  // #68's defect is a queue that grows without bound while a panel is away. The dead board
  // has exactly ONE outstanding call; the two later writes were dropped, not stacked.
  assert.deepEqual(elegoo.sets, ['on-air'], `expected one in-flight write, got [${elegoo.sets.join(',')}]`);
  assert.deepEqual(made.get('crow')!.sets, ['on-air', 'available', 'recording'], 'the primary was throttled too');
  elegoo.gate.open();
  await driver.settled();
});

test('set does NOT wait for a slow secondary', async () => {
  const { driver, made } = build(TWO);
  const elegoo = made.get('elegoo')!;
  elegoo.gate = FakeDriver.gated();

  // If this awaited the secondary it would hang here forever, because nothing opens the
  // gate until after the assertion. That is the 6.4s-per-dead-panel stall from #68, and it
  // would land inside the ONE write queue every HTTP caller shares.
  assert.equal(await driver.set('on-air'), 'on-air');
  elegoo.gate.open();
  await driver.settled();
});

// ---------------------------------------------------------------- no devices at all

test('with NO devices the fan-out is a noop that admits it knows nothing', async () => {
  const { driver } = build([]);
  assert.equal(driver.host, undefined);
  assert.equal(await driver.set('on-air'), UNKNOWN_ID);
  assert.equal(await driver.read(), UNKNOWN_ID);
  assert.equal(await driver.repainted(), null);
  assert.equal(await driver.glassDark(), null);
  assert.equal(await driver.setPanelSleep(true), false);
  assert.deepEqual(driver.health(), []);
});

// ---------------------------------------------------------------- reconfigure

test('reconfigure KEEPS the driver for an unchanged device', async () => {
  const { driver, made } = build(TWO);
  const before = made.get('elegoo')!;
  await driver.set('on-air');
  await driver.settled();

  driver.reconfigure([spec('crow', { primary: true }), spec('elegoo')]);

  // Same instance, so its retry ladder, frame counter and dead-since state survive a save
  // that had nothing to do with it. A rebuild would silently reset all of that.
  assert.equal(made.get('elegoo'), before, 'the untouched device was rebuilt');
});

test('reconfigure REPLACES a device whose address moved', async () => {
  const { driver, made } = build(TWO);
  const before = made.get('elegoo')!;

  driver.reconfigure([spec('crow', { primary: true }), spec('elegoo', { host: '10.0.0.9' })]);

  assert.notEqual(made.get('elegoo'), before, 'the moved device kept talking to the old address');
  assert.equal(driver.health().find((h) => h.id === 'elegoo')!.host, '10.0.0.9');
});

test('reconfigure replaces a device whose CREDENTIALS moved', () => {
  const { driver, made } = build(TWO);
  const before = made.get('elegoo')!;
  driver.reconfigure([spec('crow', { primary: true }), spec('elegoo', { password: 'new' })]);
  assert.notEqual(made.get('elegoo'), before, 'a credential change never reached the device');
});

test('reconfigure DROPS a removed device and stops writing to it', async () => {
  const { driver, made } = build(TWO);
  const gone = made.get('elegoo')!;

  driver.reconfigure([spec('crow', { primary: true })]);
  await driver.set('on-air');
  await driver.settled();

  assert.deepEqual(gone.sets, [], 'a deleted device was still being driven');
  assert.deepEqual(driver.health().map((h) => h.id), ['crow']);
});

test('reconfigure can move which device is PRIMARY', async () => {
  const { driver, made } = build(TWO);
  driver.reconfigure([spec('crow'), spec('elegoo', { primary: true })]);

  assert.equal(driver.host, 'elegoo.local');
  await driver.read();
  assert.equal(made.get('elegoo')!.reads, 1);
  assert.equal(made.get('crow')!.reads, 0, 'read still went to the old primary');
});

// ---------------------------------------------------------------- health and the log edge

test('health starts as null - never contacted is not the same as unreachable', () => {
  const { driver } = build(TWO);
  assert.deepEqual(
    driver.health().map((h) => [h.id, h.reachable, h.lastOkAt, h.lastError]),
    [
      ['crow', null, null, null],
      ['elegoo', null, null, null],
    ],
  );
});

test('the failure log fires on the EDGE and names the host (#59)', async () => {
  const { driver, made, lines } = build(TWO);
  const elegoo = made.get('elegoo')!;
  elegoo.answer = 'throws';

  await driver.set('on-air');
  await driver.settled();
  await driver.set('available');
  await driver.settled();
  await driver.set('recording');
  await driver.settled();

  // 915 identical lines is what #59 was filed about. Three failures, ONE line.
  const failures = lines.filter((l) => l.includes('elegoo.local') && l.includes('FAILING'));
  assert.equal(failures.length, 1, `expected one edge line, got ${failures.length}: ${lines.join(' | ')}`);
  assert.match(failures[0], /elegoo\.local/, 'the line does not say WHICH panel');

  elegoo.answer = 'ok';
  await driver.set('on-air');
  await driver.settled();
  const back = lines.filter((l) => l.includes('elegoo.local') && l.includes('RECOVERED'));
  assert.equal(back.length, 1, 'the recovery edge was never logged');
});

test('health records the primary and the reachable flag per device', async () => {
  const { driver, made } = build(TWO);
  made.get('elegoo')!.answer = 'throws';
  await driver.set('on-air');
  await driver.settled();

  const byId = new Map(driver.health().map((h) => [h.id, h]));
  assert.equal(byId.get('crow')!.primary, true);
  assert.equal(byId.get('elegoo')!.primary, false);
  assert.equal(byId.get('crow')!.reachable, true);
  assert.ok(byId.get('crow')!.lastOkAt, 'a reachable device has no lastOkAt');
  assert.equal(byId.get('elegoo')!.reachable, false);
  assert.match(byId.get('elegoo')!.lastError!, /is gone/);
});

test('a dead secondary never reaches the process as an UNHANDLED REJECTION', async () => {
  // Node's default for an unhandled rejection is to kill the process. A bench board that is
  // switched off must not be able to take the on-air daemon down with it - that is a false
  // OFF caused by the panel that matters least.
  //
  // This test must NOT call settled(): settled() awaits every pending call and would handle
  // the rejection itself, masking exactly the defect being tested. Nothing in production
  // calls settled(), so the unhandled path is the production path.
  const seen: unknown[] = [];
  const onUnhandled = (err: unknown): void => void seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { driver, made } = build(TWO);
    made.get('elegoo')!.answer = 'throws';
    assert.equal(await driver.set('on-air'), 'on-air');
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, [], `a dead secondary raised ${seen.length} unhandled rejection(s)`);
});

test('writing the `unknown` row carries NO evidence about reachability', async () => {
  // `unknown` is both a real row a panel can display (D-34) AND the sentinel every driver
  // returns when it cannot reach the device - the same string. So a write of `unknown` to a
  // board that is switched off reads back `unknown` and is indistinguishable from a perfect
  // write. It must therefore claim nothing either way.
  //
  // This is not hypothetical: the boot re-apply writes the persisted state, which is
  // `unknown` on a fresh install, and it used to mark an absent bench board reachable with
  // a `lastOkAt` it had never earned.
  const { driver } = build(TWO);
  await driver.set(UNKNOWN_ID);
  await driver.settled();
  assert.deepEqual(
    driver.health().map((h) => [h.id, h.reachable, h.lastOkAt]),
    [
      ['crow', null, null],
      ['elegoo', null, null],
    ],
    'an unknown write was taken as proof the panel is alive',
  );
});
