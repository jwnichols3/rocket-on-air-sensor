import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NoopDriver, type LightDriver } from '../src/driver.js';
import { DEFAULT_FROZEN_AFTER_MS, DriverConfigError, EsphomeTextDriver, NIGHT_DARK } from '../src/esphome-driver.js';
import { UNKNOWN_ID } from '../src/state.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('noop driver logs the level and reports unknown', async () => {
  const lines: string[] = [];
  const driver = new NoopDriver((line) => lines.push(line));
  assert.equal(await driver.set('on-air'), UNKNOWN_ID);
  assert.equal(await driver.set('available'), UNKNOWN_ID);
  assert.equal(await driver.read(), UNKNOWN_ID);
  assert.deepEqual(lines, ['[noop-driver] light -> ON-AIR', '[noop-driver] light -> AVAILABLE']);
});

/**
 * A stand-in for the device's `text` entity: same URL shapes, same "the POST 200 proves
 * nothing" lie, and the same two silent-drop traps measured on the board (D-44) - a value
 * outside [min_length, max_length] is answered 200 and discarded.
 */
interface FakeDevice {
  base: string;
  host: string;
  posts: string[];
  /** Every value written to the TableVersion entity - D-42's version nudge. */
  versionPosts: string[];
  /** When true the device has no TableVersion entity, i.e. firmware older than #43. */
  noVersionEntity: boolean;
  /** What the `Night` text_sensor says. `null` = no such entity, i.e. firmware before #78. */
  night: string | null;
  /** Every GET of the Night sensor, so a skipped or latched read can be counted. */
  nightGets: number;
  gets: string[];
  auth: string[];
  value: string;
  minLength: number;
  maxLength: number;
  /** When set, the POST is accepted with 200 but the value is NOT applied. */
  swallowWrites: boolean;
  /** The device answers the POST BEFORE applying the value. This models that gap. */
  applyDelayMs: number;
  status: number | null;
  frames: number;
  close: () => Promise<void>;
}

async function fakeDevice(): Promise<FakeDevice> {
  const d: Partial<FakeDevice> = {
    posts: [], versionPosts: [], noVersionEntity: false, night: 'lit (daytime)', nightGets: 0,
    gets: [], auth: [], value: 'on-air', minLength: 1, maxLength: 64,
    swallowWrites: false, applyDelayMs: 0, status: null, frames: 0,
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    d.auth!.push(req.headers.authorization ?? '');
    if (d.status !== null && d.status !== undefined) {
      res.writeHead(d.status).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/text/PresenceKey/set') {
      // esp_http_server rejects a POST with no Content-Length before any handler runs.
      if (req.headers['content-length'] === undefined) {
        res.writeHead(411).end('Client must specify Content-Length');
        return;
      }
      const v = url.searchParams.get('value') ?? '';
      d.posts!.push(v);
      // The device answers BEFORE applying, and silently drops an invalid value.
      res.writeHead(200, { 'content-length': '0' }).end();
      const apply = (): void => {
        if (d.swallowWrites) return;
        if (v.length < d.minLength! || v.length > d.maxLength!) return;
        d.value = v;
      };
      if (d.applyDelayMs! > 0) setTimeout(apply, d.applyDelayMs!).unref();
      else apply();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/text/TableVersion/set') {
      if (d.noVersionEntity) {
        res.writeHead(404).end();
        return;
      }
      d.versionPosts!.push(url.searchParams.get('value') ?? '');
      res.writeHead(200, { 'content-length': '0' }).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/text/PresenceKey') {
      d.gets!.push(url.search);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'text/PresenceKey', value: d.value, state: d.value,
          min_length: d.minLength, max_length: d.maxLength, pattern: '',
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/text_sensor/Night') {
      d.nightGets!++;
      if (d.night === null) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: 'text_sensor/Night', value: d.night, state: d.night }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sensor/Frames') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ id: 'sensor/Frames', value: d.frames, state: String(d.frames) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  d.host = `127.0.0.1:${port}`;
  d.base = `http://${d.host}`;
  d.close = () => new Promise<void>((r) => server.close(() => r()));
  return d as FakeDevice;
}

function driverFor(d: FakeDevice, over: Record<string, unknown> = {}) {
  return new EsphomeTextDriver({ host: d.host, timeoutMs: 1000, retryGapMs: 1, log: () => {}, ...over });
}

test('set writes ?value= to the text entity and reports what the device read back', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.equal(await driver.set('interruptible'), 'interruptible');
  assert.deepEqual(d.posts, ['interruptible']);
  await d.close();
});

test('the POST carries a Content-Length: the device answers 411 without one', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  // A 411 would fail the write outright, so a successful set proves the header went out.
  assert.equal(await driver.set('available'), 'available');
  await d.close();
});

test('a 200 that did not apply is caught by the read-back, not trusted', async () => {
  const d = await fakeDevice();
  d.swallowWrites = true;
  const driver = driverFor(d);
  assert.equal(await driver.set('available'), 'on-air', 'the read-back must win over the 200');
  await d.close();
});

test('an over-length value is answered 200 and dropped; only the read-back sees it', async () => {
  const d = await fakeDevice();
  d.maxLength = 3; // "available" no longer fits, exactly as a too-long row id would not
  const driver = driverFor(d);
  assert.equal(await driver.set('available'), 'on-air', 'a length violation must not be reported as applied');
  await d.close();
});

test('read reports the device state, and unknown when it is unreachable', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  d.value = 'available';
  assert.equal(await driver.read(), 'available');
  await d.close();
  assert.equal(await driver.read(), UNKNOWN_ID, 'a dead device is unknown, never a state');
});

test('read reports the raw key, even one this build has never heard of', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  // `text` accepts arbitrary keys (measured, D-44), and this driver deliberately does NOT
  // hold the state table - it reports what the device has and the caller, which does hold
  // the table, decides whether that is a row it knows. Two copies of the vocabulary is one
  // more than can be kept in agreement.
  d.value = 'focus-block';
  assert.equal(await driver.read(), 'focus-block');
  await d.close();
});

test('an empty or unreadable device value is unknown, never a bare empty string', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  d.value = '';
  // "" is not a state, and a renderer handed one draws nothing - which looks exactly like
  // a calm panel. It must arrive as `unknown`, which is a real row and is never calm.
  assert.equal(await driver.read(), UNKNOWN_ID);
  await d.close();
  assert.equal(await driver.read(), UNKNOWN_ID, 'and so is a dead device');
});

test('set never throws when the device is gone', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  await d.close();
  assert.equal(await driver.set('on-air'), UNKNOWN_ID);
});

test('basic auth is sent pre-emptively on every request', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { username: 'onair', password: 'hunter2' });
  await driver.set('on-air');
  const expected = `Basic ${Buffer.from('onair:hunter2').toString('base64')}`;
  assert.equal(d.auth.length >= 2, true, 'both the POST and the read-back are authenticated');
  assert.deepEqual([...new Set(d.auth)], [expected]);
  await d.close();
});

test('verifyEntity confirms the entity is there, and asks it for nothing else', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.equal(await driver.verifyEntity(), true);
  // The device no longer declares a set of valid states, so there is no option list to
  // compare against and no stale-firmware warning to derive from one (D-38).
  await d.close();
});

test('verifyEntity throws DriverConfigError on 404: a wrong entity name is a deploy bug', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { entity: 'Nope' });
  await assert.rejects(() => driver.verifyEntity(), DriverConfigError);
  await d.close();
});

test('verifyEntity throws DriverConfigError on 401', async () => {
  const d = await fakeDevice();
  d.status = 401;
  const driver = driverFor(d);
  await assert.rejects(() => driver.verifyEntity(), DriverConfigError);
  await d.close();
});

test('verifyEntity returns null for an unreachable device: do not crash on a dead light', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  await d.close();
  assert.equal(await driver.verifyEntity(), null);
});

test('repainted reports true as soon as the frame counter advances', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d);
  assert.equal(await driver.repainted(), null, 'the first call has nothing to compare to');
  d.frames = 7;
  assert.equal(await driver.repainted(), true);
  await d.close();
});

test('repainted says "cannot tell", not "frozen", while the sensor has yet to republish', async () => {
  const d = await fakeDevice();
  // The device publishes Frames on its own interval. Polling faster than that sees the
  // same value twice, which is not evidence the panel stopped - and calling it frozen
  // drops `confirmed` to unknown on a perfectly healthy panel.
  const driver = driverFor(d, { frozenAfterMs: 10_000 });
  await driver.repainted();
  assert.equal(await driver.repainted(), null, 'an unchanged counter alone proves nothing');
  await d.close();
});

test('repainted does report frozen once the counter has been static long enough', async () => {
  const d = await fakeDevice();
  const driver = driverFor(d, { frozenAfterMs: 30 });
  await driver.repainted();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await driver.repainted(), false, 'a genuinely stuck panel must still be caught');
  await d.close();
});

test('the freeze threshold clears the panel\'s own idle repaint rate, with margin', () => {
  // A REGRESSION GUARD ACROSS TWO COMPONENTS, and it is here because the bug already
  // happened. #64 made the firmware paint on-change with a 30s safety net, so an idle panel
  // repaints twice a minute; against the old 20s default every healthy panel read as FROZEN
  // and `confirmed` sat at `unknown` indefinitely. A freeze detector calibrated below the
  // panel's own idle rate does not detect freezes, it manufactures them.
  //
  // Read from the firmware rather than restated, so moving the interval fails HERE rather
  // than silently on the glass.
  const core = readFileSync(join(REPO, 'firmware', 'configs', 'onair-core.yaml'), 'utf8');
  const match = /repaint safety net[\s\S]*?- interval: (\d+)s/.exec(core);
  assert.ok(match, 'the firmware repaint safety net moved or was renamed - re-check this coupling');
  const safetyNetMs = Number(match[1]) * 1000;
  assert.ok(
    DEFAULT_FROZEN_AFTER_MS >= safetyNetMs * 2,
    `frozenAfterMs ${DEFAULT_FROZEN_AFTER_MS}ms must clear the ${safetyNetMs}ms repaint interval ` +
      'with room for a missed publish',
  );
});

test('a transient failure is retried once', async () => {
  const d = await fakeDevice();
  d.status = 503;
  const driver = driverFor(d, { retries: 1 });
  const before = d.auth.length;
  assert.equal(await driver.read(), 'unknown');
  assert.equal(d.auth.length - before, 2, 'one attempt plus one retry');
  await d.close();
});

test('set waits out the apply gap: the device answers the POST before the value lands', async () => {
  const d = await fakeDevice();
  d.applyDelayMs = 120; // the 200 arrives first; an immediate read-back sees the OLD value
  const driver = driverFor(d);
  assert.equal(await driver.set('interruptible'), 'interruptible', 'must not report the pre-write value');
  await d.close();
});

test('set still reports the truth when the write genuinely never applies', async () => {
  const d = await fakeDevice();
  d.swallowWrites = true;
  const driver = driverFor(d);
  assert.equal(await driver.set('available'), 'on-air', 'a dropped value must not be papered over by retries');
  await d.close();
});

// ---- D-42's version nudge -------------------------------------------------------

test('the version nudge writes the version to its own entity, and only when it moves', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  const driver = driverFor(d);
  await driver.setTableVersion(6);
  await driver.setTableVersion(6);
  await driver.setTableVersion(6);
  assert.deepEqual(d.versionPosts, ['6'], 'an unchanged version is not worth a request');
  await driver.setTableVersion(7);
  assert.deepEqual(d.versionPosts, ['6', '7']);
  // It must not touch the state entity. Configuration does not travel on the state path.
  assert.deepEqual(d.posts, [], 'the nudge is not a state write');
});

test('firmware with no TableVersion entity is written off after one 404, not once per write', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  d.noVersionEntity = true;
  const lines: string[] = [];
  const driver = driverFor(d, { log: (l: string) => lines.push(l) });
  await driver.setTableVersion(6);
  await driver.setTableVersion(7);
  await driver.setTableVersion(8);
  // One message, not three. A host running pre-#43 firmware would otherwise get a line
  // in its log on every single state write, about a feature it does not have.
  assert.equal(lines.filter((l) => l.includes('predates the version nudge')).length, 1);
});

test('a nudge that did not get through is retried on the next one', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  d.status = 503; // the device is up but not answering this
  // AT PRODUCTION SETTINGS. This needed `reprobeMs: 0` for one afternoon, between #68 and
  // D-132, and that opt-out was the bug reporting itself: the window was armed by a
  // single-shot failure, so it swallowed the retry this test exists to prove. Only an
  // exhausted ladder arms it now, and `setTableVersion` has no ladder, so the second call
  // goes to the wire exactly as it does in service.
  const driver = driverFor(d);
  await driver.setTableVersion(6);
  assert.deepEqual(d.versionPosts, [], 'nothing was recorded');
  d.status = null;
  await driver.setTableVersion(6);
  // Caching a version that was never delivered would leave the device holding an old
  // table until its next 300s poll, with the server believing it had been told.
  assert.deepEqual(d.versionPosts, ['6'], 'the same version is sent again after a failure');
});

test('a driver with no device to nudge is not required to have the method', () => {
  // The interface makes it optional so NoopDriver stays honest rather than pretending.
  const noop: LightDriver = new NoopDriver(() => {});
  assert.equal(noop.setTableVersion, undefined);
});

// ============================================================ #59: the failure log's edges

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

test('A DEAD HOST IS ONE LINE, NOT ONE PER CALL - and it says when, and which one', async () => {
  const d = await fakeDevice();
  const host = d.host;
  await d.close(); // nothing is listening now: every call refuses

  const lines: string[] = [];
  const driver = new EsphomeTextDriver({
    host,
    timeoutMs: 300,
    retries: 0,
    retryGapMs: 1,
    log: (l: string) => lines.push(l),
  });

  for (let i = 0; i < 12; i++) await driver.set('on-air');
  await driver.read();
  await driver.setTableVersion(4); // the nudge must not open a SECOND stream of repeats

  // The measured behaviour before this: 1133 lines in the live daemon log, 1127 of them two
  // repeated strings, recording one event over and over.
  assert.equal(lines.length, 1, `expected one edge, got ${JSON.stringify(lines)}`);
  assert.match(lines[0]!, /UNREACHABLE/);
  assert.match(lines[0]!, ISO, 'no timestamp means no answer to "when did it stop"');
  assert.ok(lines[0]!.includes(host), `the line must name WHICH device: ${lines[0]}`);
});

test('coming back is the other edge, and it carries how long and how much was lost', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  const lines: string[] = [];
  // AT PRODUCTION SETTINGS, restored by D-132. It walks a host down and back on consecutive
  // calls, and the recovering call is a `set()` - which is never gated, because skipping a
  // write costs the light rather than costing the server knowledge.
  const driver = driverFor(d, { retries: 0, log: (l: string) => lines.push(l) });

  d.status = 503; // up, but answering nothing useful
  await driver.set('on-air');
  await driver.set('on-air');
  await driver.set('on-air');
  assert.equal(lines.length, 1, 'still one line while it stays down');

  d.status = null;
  assert.equal(await driver.set('on-air'), 'on-air');
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /BACK after \d+s and 3 failed calls/);
  assert.match(lines[1]!, ISO);
  assert.ok(lines[1]!.includes(d.host));

  // And a SECOND outage is a second edge - the state resets, it does not latch.
  d.status = 503;
  await driver.set('on-air');
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /UNREACHABLE/);
});

test('a config error is said once, not once per write', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  const lines: string[] = [];
  // A name the fake device does not serve: 404, which is DriverConfigError - a deploy bug
  // that will fail identically forever, so the hundredth line is worth what the first was.
  const driver = driverFor(d, { entity: 'NotAnEntity', retries: 0, log: (l: string) => lines.push(l) });
  for (let i = 0; i < 5; i++) await driver.set('on-air');
  assert.equal(lines.length, 1, `expected one CONFIG line, got ${JSON.stringify(lines)}`);
  assert.match(lines[0]!, /CONFIG:/);
  assert.match(lines[0]!, ISO);
  assert.ok(lines[0]!.includes(d.host));
});

test('the boot check is the first contact, so a dead host at boot is an edge like any other', async () => {
  const d = await fakeDevice();
  const host = d.host;
  await d.close();
  const lines: string[] = [];
  const driver = new EsphomeTextDriver({ host, timeoutMs: 300, retries: 0, log: (l: string) => lines.push(l) });
  assert.equal(await driver.verifyEntity(), null);
  await driver.set('on-air');
  // One line, and it is the stamped host-named one - not verifyEntity's old bespoke text
  // followed by a stream of anonymous ones.
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(lines[0]!, /UNREACHABLE/);
  assert.ok(lines[0]!.includes(host));
});

// ================================================== #82: can anyone SEE the pixels?

test('glassDark reads the panel\'s own Night verdict', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  const driver = driverFor(d);
  d.night = 'dark';
  assert.equal(await driver.glassDark(), true);
  assert.equal(driver.nightReason(), 'dark');
  for (const lit of ['lit (daytime)', 'lit (schedule off)', 'lit (no time yet)', 'lit (woken by a state change)', 'lit (holding off - busy or no data)']) {
    d.night = lit;
    assert.equal(await driver.glassDark(), false, lit);
    assert.equal(driver.nightReason(), lit);
  }
});

test('firmware with no Night sensor is written off after one 404, and is NOT an outage', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  d.night = null; // firmware older than #78
  const lines: string[] = [];
  const driver = driverFor(d, { retries: 0, log: (l: string) => lines.push(l) });

  assert.equal(await driver.glassDark(), null);
  const after = d.nightGets;
  for (let i = 0; i < 5; i++) assert.equal(await driver.glassDark(), null);
  assert.equal(d.nightGets, after, 'a missing entity is asked for once, not once per tick');

  // THE TRAP. getJson() routes a non-ok response into attempt(), which retries it and then
  // calls unreachable() - so a 404 from old firmware would have logged a permanent
  // UNREACHABLE edge about a panel that is perfectly healthy, and the driver would have
  // stopped talking to it under #68's skip window.
  assert.equal(lines.filter((l) => l.includes('UNREACHABLE')).length, 0, lines.join('\n'));
  assert.equal(lines.filter((l) => l.includes('predates the night schedule')).length, 1, lines.join('\n'));

  // And it must not have poisoned the rest of the driver.
  assert.equal(await driver.set('available'), 'available');
});

test('the Night 404 CLOSES an open outage edge - a 404 is still an answer', async (t) => {
  const d = await fakeDevice();
  t.after(() => d.close());
  const lines: string[] = [];
  // reprobeMs: 0 HERE IS DELIBERATE and is not the opt-out D-132 removed elsewhere. This
  // test is about the 404 branch inside glassDark(), and glassDark IS gated - correctly, it
  // is a poll. Without this the call under test would be skipped rather than reaching the
  // branch, and the test would pass while proving nothing.
  const driver = driverFor(d, { retries: 0, reprobeMs: 0, log: (l: string) => lines.push(l) });

  d.status = 503;
  await driver.set('on-air');
  assert.equal(lines.filter((l) => l.includes('UNREACHABLE')).length, 1, lines.join('\n'));

  // The host comes back, and the very first call to reach it is the one that discovers the
  // Night entity is missing. If that path did not report the host reachable, the BACK line
  // would be swallowed and the log would say the host was still gone.
  d.status = null;
  d.night = null;
  assert.equal(await driver.glassDark(), null);
  assert.equal(lines.filter((l) => l.includes('BACK after')).length, 1, lines.join('\n'));
});

test('glassDark reports null rather than "lit" when it cannot tell', async (t) => {
  const d = await fakeDevice();
  const driver = driverFor(d, { retries: 0, timeoutMs: 300 });
  await d.close(); // nothing is listening
  // NOT false. Guessing "lit" is the false confirmation this whole ticket exists to stop:
  // it would put the supervisor straight back into the branch that claims pixels.
  assert.equal(await driver.glassDark(), null);
});

test('the NIGHT_DARK constant matches what the firmware can actually emit', () => {
  // A REGRESSION GUARD ACROSS TWO COMPONENTS, the same shape as the freeze-threshold guard
  // above and here for the same reason: the server decides "the glass is off" by comparing
  // a string to a string a YAML lambda returns. Renaming it there and not here does not
  // fail a build - it silently reports every dark panel as lit, which is the bug this
  // ticket closes, restored. D-106 is the record of what that costs.
  const core = readFileSync(join(REPO, 'firmware', 'configs', 'onair-core.yaml'), 'utf8');
  const block = /name: "Night"[\s\S]*?lambda: \|-\n([\s\S]*?)\n  - platform:/.exec(core);
  assert.ok(block, 'the Night text_sensor moved or was renamed - re-check this coupling');
  const returns = [...block[1]!.matchAll(/return \{"([^"]*)"\}/g)].map((m) => m[1]!);
  assert.ok(returns.length >= 2, `expected several verdicts, got ${JSON.stringify(returns)}`);
  assert.ok(
    returns.includes(NIGHT_DARK),
    `NIGHT_DARK is "${NIGHT_DARK}" and the firmware can never emit it: ${JSON.stringify(returns)}`,
  );
  // Exactly one verdict means dark. If the firmware ever grows a second, this server reads
  // it as lit and the panel is confirmed while black.
  assert.equal(
    returns.filter((r) => !r.startsWith('lit')).length,
    1,
    `exactly one Night verdict may mean dark, got ${JSON.stringify(returns)}`,
  );
});
