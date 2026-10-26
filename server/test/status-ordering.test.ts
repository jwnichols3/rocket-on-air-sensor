import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { createApiServer } from '../src/server.js';
import { createSseHub } from '../src/sse.js';
import { createWsBridge } from '../src/ws.js';
import { defaultState, SEED_ROWS, StateStore, StateTable, type StatusBody } from '../src/state.js';
import { waitFor } from './wait-for.js';

const at = new Date('2026-10-25T12:00:00Z');
const human = { kind: 'human' as const, label: 'ordering-test', raw: 'human:ordering-test' };
type Ordered = { receiverInstanceId: string; statusSequence: number };
const order = (value: unknown): Ordered => {
  const s = value as Ordered;
  assert.match(s.receiverInstanceId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert(Number.isSafeInteger(s.statusSequence) && s.statusSequence > 0, 'positive safe sequence required');
  return { receiverInstanceId: s.receiverInstanceId, statusSequence: s.statusSequence };
};

test('reads and age changes keep one ordering token, while actual observations advance it', () => {
  const store = new StateStore(defaultState(at));
  const initial = order(store.status(at));
  assert.deepEqual(order(store.status(new Date(at.getTime() + 90_000))), initial);
  const advance = (change: () => void) => {
    const before = order(store.status(at));
    change();
    const after = order(store.status(at));
    assert.equal(after.receiverInstanceId, initial.receiverInstanceId);
    assert(after.statusSequence > before.statusSequence);
  };
  advance(() => { store.write('available', human, at); });
  advance(() => { store.setConfirmed('available'); });
  // Physical observations do not change updatedAt, but are still ordered separately.
  advance(() => { store.setConfirmed('unknown', 'asleep'); });
  advance(() => { store.setConfirmed('unknown', 'unreachable'); });
  assert.equal(store.status(at).updatedAt, at.toISOString());
  advance(() => { store.setMessage('A message'); });
  const unchanged = order(store.status(at));
  store.setMessage('A message');
  store.setConfirmed('unknown', 'unreachable');
  assert.deepEqual(order(store.status(at)), unchanged);
  advance(() => { store.clearMessage(); });
  advance(() => { store.write('available', { ...human, raw: 'human:other' }, at); });
  // Wall-clock corrections cannot roll the ordering counter backward.
  advance(() => { store.write('on-air', human, new Date(at.getTime() - 60_000)); });
});

test('table edits, row resolution and no-op table replacement have explicit ordering', () => {
  const store = new StateStore(defaultState(at));
  store.write('recording', human, at);
  store.setConfirmed('recording');
  const before = order(store.status(at));
  store.setTable(new StateTable(SEED_ROWS.map((row) => ({
    bgcolor: row.bgcolor, label: row.label, color: row.color, busy: row.busy,
    description: row.description, order: row.order, id: row.id,
  }))));
  assert.deepEqual(order(store.status(at)), before, 'identical table is not a new observation');
  store.setTable(new StateTable(SEED_ROWS.map((row) => row.id === 'recording' ? { ...row, label: 'LIVE' } : row)));
  const renamed = order(store.status(at));
  assert(renamed.statusSequence > before.statusSequence, 'presentation edits also affect public snapshots');
  store.setTable(new StateTable(SEED_ROWS.filter((row) => row.id !== 'recording'), 2));
  const removed = store.status(at);
  assert(order(removed).statusSequence > renamed.statusSequence);
  assert.equal(removed.stateResolvedFrom, 'recording');
  assert.equal(removed.state, 'unknown');
});

test('a Receiver restart changes its identity and never restores the old sequence from disk state', () => {
  const first = new StateStore(defaultState(at));
  for (let i = 0; i < 5; i++) first.setMessage(`message ${i}`);
  const previous = order(first.status(at));
  const persisted = first.persisted();
  assert.equal('receiverInstanceId' in persisted, false);
  assert.equal('statusSequence' in persisted, false);
  const restarted = new StateStore(persisted);
  const next = order(restarted.status(at));
  assert.notEqual(next.receiverInstanceId, previous.receiverInstanceId);
  assert(next.statusSequence < previous.statusSequence, 'a new instance starts its own counter');
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  return `http://127.0.0.1:${addr.port}`;
}
async function stream(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => { controller.abort(); },
    next: async (): Promise<unknown> => {
      const deadline = setTimeout(() => controller.abort(), 3000);
      try {
        while (!buffer.includes('\n\n')) {
          const { done, value } = await reader.read();
          assert.equal(done, false, 'stream ended before an observation');
          buffer += decoder.decode(value, { stream: true });
        }
        const end = buffer.indexOf('\n\n');
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
      } finally { clearTimeout(deadline); }
    },
  };
}

test('poll, public view, both SSE audiences, WebSocket and write reply share ordering across listeners', async () => {
  const store = new StateStore(defaultState(at));
  const hub = createSseHub();
  const bridge = createWsBridge();
  const make = () => createApiServer({ store, hub, ws: bridge, driver: { set: async (id) => id, read: async () => 'unknown' },
    persist: async () => {}, log: () => {} });
  const servers = [make(), make()];
  const [a, b] = await Promise.all(servers.map(listen));
  const streams: Awaited<ReturnType<typeof stream>>[] = [];
  let socket: WebSocket | undefined;
  try {
    const first = order(await (await fetch(a + '/status')).json());
    assert.deepEqual(order(await (await fetch(b + '/status')).json()), first);
    assert.deepEqual(order(await (await fetch(a + '/public/status')).json()), first);
    streams.push(await stream(a + '/events'), await stream(b + '/public/events'));
    for (const s of streams) assert.deepEqual(order(await s.next()), first);
    const frames: unknown[] = [];
    socket = new WebSocket(a.replace('http:', 'ws:') + '/events/ws');
    socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
    await waitFor(() => frames.length === 1, 'WebSocket initial snapshot');
    assert.deepEqual(order(frames[0]), first);
    const reply = await (await fetch(b + '/state/on-air', { method: 'POST' })).json();
    const latest = order(reply);
    assert(latest.statusSequence > first.statusSequence);
    for (const s of streams) assert.deepEqual(order(await s.next()), latest);
    await waitFor(() => frames.length === 2, 'WebSocket write observation');
    assert.deepEqual(order(frames[1]), latest);
    assert.deepEqual(order(await (await fetch(a + '/status')).json()), latest);
    assert.deepEqual(order(await (await fetch(b + '/public/status')).json()), latest);
    // A delayed poll can now be rejected by its token even with no wall-clock comparison.
    assert(first.statusSequence < latest.statusSequence);
    assert.equal(first.receiverInstanceId, latest.receiverInstanceId);
  } finally {
    for (const s of streams) s.close();
    socket?.close();
    hub.closeAll(); bridge.closeAll();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test('real config save and factory reset advance ordering without persisting transport identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onair-ordering-'));
  const stateFile = join(dir, 'state.json');
  const configFile = join(dir, 'config.json');
  const app = await createApp({ stateFile, configFile, port: 0, bind: 'loopback',
    driver: { set: async (id) => id, read: async () => 'unknown' },
    supervise: { pollMs: 3600000 }, log: () => {} });
  const base = () => `http://127.0.0.1:${app.port}`;
  try {
    const first = order(await (await fetch(base() + '/status')).json());
    const config = app.config();
    const save = await fetch(base() + '/admin/config', { method: 'PUT', body: JSON.stringify({
      ...config, states: config.states.map((row) => row.id === 'available' ? { ...row, label: 'READY' } : row),
    }) });
    assert.equal(save.status, 200); await save.text();
    const saved = order(await (await fetch(base() + '/status')).json());
    assert(saved.statusSequence > first.statusSequence);
    const reset = await fetch(base() + '/admin/factory-reset', { method: 'POST', body: JSON.stringify({ password: config.auth.adminPassword }) });
    assert.equal(reset.status, 200); await reset.text();
    const fresh = order(await (await fetch(base() + '/status')).json());
    assert.equal(fresh.receiverInstanceId, first.receiverInstanceId, 'reset is not a process restart');
    assert(fresh.statusSequence > saved.statusSequence);
    const disk = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<StatusBody>;
    assert.equal('statusSequence' in disk, false);
    assert.equal('receiverInstanceId' in disk, false);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
