import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { createSseHub } from '../src/sse.js';
import { waitFor } from './wait-for.js';

class FakeRes {
  chunks: string[] = [];
  ended = false;
  headers: Record<string, string> = {};
  private closeHandlers: Array<() => void> = [];

  writeHead(_status: number, headers: Record<string, string>): this {
    this.headers = headers;
    return this;
  }
  write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };
  end(): this {
    this.ended = true;
    return this;
  }
  on(event: string, handler: () => void): this {
    if (event === 'close') this.closeHandlers.push(handler);
    return this;
  }
  emitClose(): void {
    for (const h of this.closeHandlers) h();
  }
}

const asRes = (f: FakeRes) => f as unknown as ServerResponse;

test('attach sends headers and a snapshot status event', () => {
  const hub = createSseHub();
  const res = new FakeRes();
  hub.attach(asRes(res), () => ({ intended: 'off' }));
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.chunks[0], 'event: status\ndata: {"intended":"off"}\n\n');
  assert.equal(hub.count(), 1);
  hub.closeAll();
});

test('broadcast reaches attached clients; closed clients are detached', () => {
  const hub = createSseHub();
  const a = new FakeRes();
  const b = new FakeRes();
  let intended = 'off';
  hub.attach(asRes(a), () => ({ intended }));
  hub.attach(asRes(b), () => ({ intended }));
  a.emitClose();
  intended = 'on';
  hub.broadcast();
  assert.equal(hub.count(), 1);
  assert.equal(a.chunks.length, 1); // snapshot only
  assert.equal(b.chunks.at(-1), 'event: status\ndata: {"intended":"on"}\n\n');
  hub.closeAll();
});

test('broadcast renders each client with ITS OWN snapshot, not one shared body (#88)', () => {
  // The bug: one hub serves the gated /events and the unauthenticated /public/events, and a
  // single payload written to both leaked source/confirmed/updatedAt to the public stream
  // while dropping the label/color/bgcolor the wall panel renders from.
  const hub = createSseHub();
  const gated = new FakeRes();
  const publik = new FakeRes();
  hub.attach(asRes(gated), () => ({ state: 'on-air', source: 'human:rocket', confirmed: 'on-air' }));
  hub.attach(asRes(publik), () => ({ state: 'on-air', label: 'ON AIR', color: '#fff' }));
  hub.broadcast();
  assert.match(gated.chunks.at(-1)!, /"source":"human:rocket"/);
  assert.doesNotMatch(publik.chunks.at(-1)!, /source|confirmed/);
  assert.match(publik.chunks.at(-1)!, /"label":"ON AIR"/);
  hub.closeAll();
});

test('closeAll ends every client and empties the hub', () => {
  const hub = createSseHub();
  const res = new FakeRes();
  hub.attach(asRes(res), () => ({}));
  hub.closeAll();
  assert.equal(res.ended, true);
  assert.equal(hub.count(), 0);
});

test('heartbeat sends fresh status events until detach', async () => {
  const hub = createSseHub(20);
  const res = new FakeRes();
  let n = 0;
  hub.attach(asRes(res), () => ({ n: ++n }));
  const status = (): string[] => res.chunks.filter((c) => c.startsWith('event: status'));
  // snapshot + at least 2 heartbeats. Waited for rather than slept for (#89): three events in
  // a 70ms window was a 1.17x margin against an unbounded load, and it lost 1 run in 5.
  await waitFor(() => status().length >= 3, () => `expected repeated heartbeats, got ${status().length}`);
  const statusEvents = status();
  assert.notEqual(statusEvents.at(-1), statusEvents[0]); // snapshot re-evaluated per beat
  hub.closeAll();
  const count = res.chunks.length;
  // This sleep STAYS. "nothing further is written" is an absence, and an absence cannot be
  // polled for. A slow machine only makes it pass more easily, which is the safe direction:
  // the failure it catches is a timer that kept firing, which no amount of load can fake.
  await sleep(50);
  assert.equal(res.chunks.length, count); // timer stopped
});

test('a throwing client is detached and does not break broadcast', () => {
  const hub = createSseHub();
  const bad = new FakeRes();
  const good = new FakeRes();
  hub.attach(asRes(bad), () => ({ x: 1 }));
  hub.attach(asRes(good), () => ({ x: 1 }));
  bad.write = () => {
    throw new Error('EPIPE');
  };
  hub.broadcast();
  assert.equal(hub.count(), 1);
  assert.ok(good.chunks.at(-1)!.includes('"x":1'));
  hub.closeAll();
});

test('a client whose heartbeat write throws is detached and its timer stops', async () => {
  const hub = createSseHub(20);
  const res = new FakeRes();
  hub.attach(asRes(res), () => ({}));
  res.write = () => {
    throw new Error('EPIPE');
  };
  await sleep(50); // first heartbeat throws -> detach
  assert.equal(hub.count(), 0);
  const count = res.chunks.length;
  await sleep(50);
  assert.equal(res.chunks.length, count); // timer cleared, no further attempts
});
