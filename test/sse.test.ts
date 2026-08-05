import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { createSseHub } from '../src/sse.js';

class FakeRes {
  chunks: string[] = [];
  ended = false;
  headers: Record<string, string> = {};
  private closeHandlers: Array<() => void> = [];

  writeHead(_status: number, headers: Record<string, string>): this {
    this.headers = headers;
    return this;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
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
  hub.attach(asRes(a), () => ({}));
  hub.attach(asRes(b), () => ({}));
  a.emitClose();
  hub.broadcast({ intended: 'on' });
  assert.equal(hub.count(), 1);
  assert.equal(a.chunks.length, 1); // snapshot only
  assert.equal(b.chunks.at(-1), 'event: status\ndata: {"intended":"on"}\n\n');
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

test('heartbeat comments flow until detach', async () => {
  const hub = createSseHub(20);
  const res = new FakeRes();
  hub.attach(asRes(res), () => ({}));
  await sleep(70);
  assert.ok(res.chunks.filter((c) => c === ':hb\n\n').length >= 2);
  hub.closeAll();
  const count = res.chunks.length;
  await sleep(50);
  assert.equal(res.chunks.length, count); // timer stopped
});
