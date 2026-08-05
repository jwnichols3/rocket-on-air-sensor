# On-air Display Page + Message API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #8 per `docs/superpowers/specs/2026-08-05-onair-display-design.md`: a `message` resource, an SSE `/events` endpoint, and a self-contained `/display` tally page.

**Architecture:** `message: string | null` joins the persisted state (on-air writes never touch it). A small SSE hub module (`src/sse.ts`) owns connection lifecycle; the server broadcasts a status snapshot after every queued write. `/display` serves one inline HTML string from `src/display.ts`.

**Tech Stack:** unchanged - Node >= 22, TypeScript ESM, zero production deps, node:test + tsx.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-onair-display-design.md`; contract: `docs/api-contract.md`. Exact values: message max 200 chars (400 on empty/missing/oversized `text`), SSE event name `status`, heartbeat comment `:hb` every 15s, stale threshold 300s client-side, `?token=` accepted on GET `/status` `/events` `/display` only.
- On-air writes (`/state`, `/on`, `/off`) and boot must never modify `message`. Message writes never modify `intended`/`confirmed`/`source`/`updatedAt`.
- State files written before this feature (no `message` key) must load, with `message` as `null`.
- All writes (state and message) go through the existing `enqueueWrite` chain in `src/server.ts`.
- Zero production npm dependencies. ESM; TS source imports use `.js` extensions.
- Before every commit: `npm test` AND `npx tsc --noEmit` both clean.
- Run all commands from the repo root `/Users/john/code/rocket-on-air-sensor`.

## Current-code anchors (verified 2026-08-05)

`src/server.ts` has `createApiServer(deps: ServerDeps)` with a `ROUTES` table, an `enqueueWrite` promise chain in the closure, `handle(req, res, deps, enqueueWrite)`, helpers `sendJson`/`statusBody`/`readBody`/`doWrite`. `src/app.ts` `createApp` boots, re-applies intended, listens, returns `{port, store, close}`. Auth is currently header-only at the top of `handle`.

---

### Task 1: `message` in state model and persistence

**Files:**
- Modify: `src/state.ts`, `src/persist.ts`
- Test: `test/state.test.ts` (modify), `test/persist.test.ts` (modify)

**Interfaces:**
- Consumes: existing `OnAirState`, `StateStore`, `loadState`.
- Produces: `OnAirState` gains `message: string | null`; `StateStore.setMessage(text: string): OnAirState` and `StateStore.clearMessage(): OnAirState` (neither touches `updatedAt`); `write()` preserves `message`; `loadState` normalizes an absent `message` key to `null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/state.test.ts`:

```ts
test('setMessage and clearMessage change only message', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  const withMsg = store.setMessage('BE QUIET');
  assert.equal(withMsg.message, 'BE QUIET');
  assert.equal(withMsg.updatedAt, '2026-08-05T00:00:00.000Z');
  const cleared = store.clearMessage();
  assert.equal(cleared.message, null);
});

test('on-air write preserves an existing message', () => {
  const store = new StateStore(defaultState());
  store.setMessage('BE QUIET');
  const state = store.write(true, 'detector');
  assert.equal(state.message, 'BE QUIET');
  assert.equal(state.intended, 'on');
});
```

Update the existing `defaultState is off/unknown from boot` test's `deepEqual` expectation to include `message: null`:

```ts
  assert.deepEqual(s, {
    intended: 'off',
    confirmed: 'unknown',
    source: 'boot',
    updatedAt: '2026-08-05T00:00:00.000Z',
    message: null,
  });
```

Append to `test/persist.test.ts`:

```ts
test('pre-message state files load with message null', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  await writeFile(
    file,
    JSON.stringify({ intended: 'on', confirmed: 'unknown', source: 'detector', updatedAt: '2026-08-05T00:00:00.000Z' }),
    'utf8',
  );
  const loaded = await loadState(file);
  assert.equal(loaded?.message, null);
  assert.equal(loaded?.intended, 'on');
});

test('message round-trips through save and load', async () => {
  const file = await tmpStateFile();
  await saveState(file, { ...defaultState(), message: 'BE QUIET' });
  assert.equal((await loadState(file))?.message, 'BE QUIET');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL - `setMessage is not a function`, deepEqual mismatch, message undefined.

- [ ] **Step 3: Implement**

In `src/state.ts`, change `OnAirState`, `defaultState`, `isOnAirState`, and `StateStore`:

```ts
export interface OnAirState {
  intended: OnOff;
  confirmed: Confirmed;
  source: string;
  updatedAt: string;
  message: string | null;
}

export function defaultState(now: Date = new Date()): OnAirState {
  return { intended: 'off', confirmed: 'unknown', source: 'boot', updatedAt: now.toISOString(), message: null };
}

export function isOnAirState(v: unknown): v is OnAirState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    (s.intended === 'on' || s.intended === 'off') &&
    (s.confirmed === 'on' || s.confirmed === 'off' || s.confirmed === 'unknown') &&
    typeof s.source === 'string' &&
    typeof s.updatedAt === 'string' &&
    (s.message === undefined || s.message === null || typeof s.message === 'string')
  );
}
```

In `StateStore`, change `write` to preserve `message`, and add the two methods:

```ts
  write(onAir: boolean, source: string, now: Date = new Date()): OnAirState {
    this.state = {
      ...this.state,
      intended: onAir ? 'on' : 'off',
      confirmed: 'unknown',
      source,
      updatedAt: now.toISOString(),
    };
    return this.get();
  }

  setMessage(text: string): OnAirState {
    this.state = { ...this.state, message: text };
    return this.get();
  }

  clearMessage(): OnAirState {
    this.state = { ...this.state, message: null };
    return this.get();
  }
```

In `src/persist.ts`, normalize the absent key in `loadState` (replace the final two lines of the function):

```ts
  if (!isOnAirState(parsed)) throw new Error(`state file ${file} has invalid shape`);
  return { ...parsed, message: (parsed as { message?: string | null }).message ?? null };
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all pass (27 + 4 new = 31), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/persist.ts test/state.test.ts test/persist.test.ts
git commit -m "feat: message field in state - independent of on-air writes, back-compat load"
```

---

### Task 2: SSE hub module

**Files:**
- Create: `src/sse.ts`
- Test: `test/sse.test.ts`

**Interfaces:**
- Consumes: `node:http` `ServerResponse` type only.
- Produces: `interface SseHub { attach(res: ServerResponse, snapshot: () => unknown): void; broadcast(data: unknown): void; closeAll(): void; count(): number }`; `createSseHub(heartbeatMs = 15_000): SseHub`. `attach` writes SSE headers, sends one `status` event with `snapshot()`, starts a heartbeat comment timer, detaches on `close`.

- [ ] **Step 1: Write the failing test**

```ts
// test/sse.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL - cannot find module `../src/sse.js`.

- [ ] **Step 3: Write src/sse.ts**

```ts
import type { ServerResponse } from 'node:http';

export interface SseHub {
  attach(res: ServerResponse, snapshot: () => unknown): void;
  broadcast(data: unknown): void;
  closeAll(): void;
  count(): number;
}

function statusEvent(data: unknown): string {
  return `event: status\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseHub(heartbeatMs = 15_000): SseHub {
  const clients = new Set<ServerResponse>();
  const timers = new Map<ServerResponse, NodeJS.Timeout>();

  function detach(res: ServerResponse): void {
    const timer = timers.get(res);
    if (timer !== undefined) clearInterval(timer);
    timers.delete(res);
    clients.delete(res);
  }

  return {
    attach(res, snapshot) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(statusEvent(snapshot()));
      clients.add(res);
      const timer = setInterval(() => res.write(':hb\n\n'), heartbeatMs);
      timer.unref?.();
      timers.set(res, timer);
      res.on('close', () => detach(res));
    },
    broadcast(data) {
      const payload = statusEvent(data);
      for (const res of clients) res.write(payload);
    },
    closeAll() {
      for (const res of [...clients]) {
        detach(res);
        res.end();
      }
    },
    count: () => clients.size,
  };
}
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all pass (31 + 4 = 35), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/sse.ts test/sse.test.ts
git commit -m "feat: SSE hub - attach/broadcast/heartbeat/closeAll"
```

---

### Task 3: display page, new routes, query-token auth, broadcasts

**Files:**
- Create: `src/display.ts`
- Modify: `src/server.ts`
- Test: `test/server.test.ts` (append)

**Interfaces:**
- Consumes: `SseHub`/`createSseHub` from `./sse.js` (Task 2), `setMessage`/`clearMessage` (Task 1).
- Produces: `ServerDeps` gains optional `hub?: SseHub` (default: internal `createSseHub()`); routes `PUT|DELETE /message`, `GET /events`, `GET /display`; `?token=` accepted on GETs; every successful write broadcasts a status snapshot. `src/display.ts` exports `DISPLAY_HTML: string`.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.ts` (uses the existing `boot()` helper and `StubDriver`):

```ts
test('PUT /message sets, DELETE clears; on-air fields untouched', async () => {
  const h = await boot();
  const set = await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'BE QUIET' }) });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.equal(setBody.message, 'BE QUIET');
  assert.equal(setBody.intended, 'off');
  assert.equal(h.persisted.at(-1)!.message, 'BE QUIET');
  const del = await fetch(`${h.base}/message`, { method: 'DELETE' });
  assert.equal((await del.json()).message, null);
  const delAgain = await fetch(`${h.base}/message`, { method: 'DELETE' });
  assert.equal(delAgain.status, 200); // idempotent
  await h.close();
});

test('PUT /message validation: missing, empty, oversized text get 400', async () => {
  const h = await boot();
  for (const body of [JSON.stringify({}), JSON.stringify({ text: '' }), JSON.stringify({ text: 'x'.repeat(201) })]) {
    const res = await fetch(`${h.base}/message`, { method: 'PUT', body });
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, 'string');
  }
  await h.close();
});

test('heartbeat re-PUT of /state leaves the message intact', async () => {
  const h = await boot();
  await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'BE QUIET' }) });
  await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: true, source: 'detector' }) });
  const status = await (await fetch(`${h.base}/status`)).json();
  assert.equal(status.message, 'BE QUIET');
  assert.equal(status.intended, 'on');
  await h.close();
});

test('GET /display serves the self-contained page', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/display`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /EventSource/);
  assert.match(html, /ON AIR/);
  await h.close();
});

test('token via query works on GETs only', async () => {
  const h = await boot('sekrit');
  assert.equal((await fetch(`${h.base}/status?token=sekrit`)).status, 200);
  assert.equal((await fetch(`${h.base}/status?token=wrong`)).status, 401);
  assert.equal((await fetch(`${h.base}/display?token=sekrit`)).status, 200);
  const write = await fetch(`${h.base}/state?token=sekrit`, { method: 'PUT', body: JSON.stringify({ onAir: true }) });
  assert.equal(write.status, 401); // writes require the header
  await h.close();
});

test('GET /events sends a snapshot then an event per write', async () => {
  const h = await boot();
  const controller = new AbortController();
  const eventsPromise = (async () => {
    const res = await fetch(`${h.base}/events`, { signal: controller.signal });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events: Array<Record<string, unknown>> = [];
    while (events.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine !== undefined) events.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
      }
    }
    return events;
  })();
  await sleep(50);
  await fetch(`${h.base}/on`, { method: 'POST' });
  await fetch(`${h.base}/message`, { method: 'PUT', body: JSON.stringify({ text: 'HI' }) });
  const events = await eventsPromise;
  assert.equal(events[0]!.intended, 'off'); // snapshot
  assert.equal(events[1]!.intended, 'on'); // after POST /on
  assert.equal(events[2]!.message, 'HI'); // after PUT /message
  controller.abort();
  await h.close();
});
```

Add the import at the top of `test/server.test.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL - 404 on `/message`, `/display`, `/events`; 401 on query-token cases.

- [ ] **Step 3: Write src/display.ts**

```ts
// Self-contained tally page. No external resources - it must render on a kiosk
// with no network beyond the API host. Served by GET /display.
export const DISPLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>On Air</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #111; cursor: none; overflow: hidden;
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
    transition: background 0.2s;
  }
  #word {
    font-weight: 800; letter-spacing: 0.08em; text-align: center;
    line-height: 1.1; padding: 0 4vw; overflow-wrap: anywhere;
  }
  body.on { background: #b30000; }
  body.on #word { color: #fff; }
  body.off { background: #111; }
  body.off #word { color: #3a3a3a; }
  #overlay {
    position: fixed; inset: 0; display: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,0.85); color: #ffb300;
    font-size: 8vw; font-weight: 700; letter-spacing: 0.1em;
  }
  body.disconnected #overlay { display: flex; }
  #stale {
    position: fixed; top: 2vh; right: 2vw; display: none;
    color: #ffb300; font-size: 3vw; font-weight: 600;
  }
  body.stale #stale { display: block; }
</style>
</head>
<body class="off">
  <div id="word">OFF AIR</div>
  <div id="stale">STALE</div>
  <div id="overlay">DISCONNECTED</div>
  <script>
    var STALE_AFTER_SECONDS = 300;
    var token = new URLSearchParams(location.search).get('token');
    var es = new EventSource('/events' + (token ? '?token=' + encodeURIComponent(token) : ''));
    var word = document.getElementById('word');
    var last = null;
    var lastAt = 0;

    function effectiveAgeSeconds() {
      if (last === null) return 0;
      return last.ageSeconds + (Date.now() - lastAt) / 1000;
    }

    function refreshStale() {
      var stale = last !== null && last.source === 'detector' && effectiveAgeSeconds() > STALE_AFTER_SECONDS;
      document.body.classList.toggle('stale', stale);
    }

    function render(s) {
      var on = s.intended === 'on';
      document.body.classList.toggle('on', on);
      document.body.classList.toggle('off', !on);
      var text = (s.message !== null && s.message !== undefined) ? s.message : (on ? 'ON AIR' : 'OFF AIR');
      word.textContent = text;
      word.style.fontSize = text.length > 12 ? '9vw' : '18vw';
      refreshStale();
    }

    es.addEventListener('status', function (e) {
      document.body.classList.remove('disconnected');
      last = JSON.parse(e.data);
      lastAt = Date.now();
      render(last);
    });
    es.onerror = function () {
      document.body.classList.add('disconnected');
    };
    setInterval(refreshStale, 30000);
  </script>
</body>
</html>
`;
```

- [ ] **Step 4: Modify src/server.ts**

Apply these changes:

1. Add imports:

```ts
import { DISPLAY_HTML } from './display.js';
import { createSseHub, type SseHub } from './sse.js';
```

2. `ServerDeps` gains `hub?: SseHub;` after `token?: string;`.

3. Extend `ROUTES`:

```ts
const ROUTES: Record<string, string[]> = {
  '/status': ['GET'],
  '/state': ['PUT'],
  '/on': ['POST'],
  '/off': ['POST'],
  '/message': ['PUT', 'DELETE'],
  '/events': ['GET'],
  '/display': ['GET'],
};
```

4. Add `const MAX_MESSAGE_CHARS = 200;` next to `MAX_BODY_BYTES`.

5. In `createApiServer`, resolve the hub and pass it through:

```ts
  const hub = deps.hub ?? createSseHub();

  return createServer((req, res) => {
    handle(req, res, deps, enqueueWrite, hub).catch((err) => {
      sendJson(res, 500, { error: `internal error: ${(err as Error).message}` });
    });
  });
```

6. In `handle` (signature gains `hub: SseHub` as the fifth parameter), replace the auth block - `?token=` counts only for GETs:

```ts
  if (deps.token !== undefined) {
    const headerOk = req.headers.authorization === `Bearer ${deps.token}`;
    const queryOk = method === 'GET' && url.searchParams.get('token') === deps.token;
    if (!headerOk && !queryOk) {
      sendJson(res, 401, { error: 'missing or invalid bearer token' });
      return;
    }
  }
```

7. Add the new routes after the `/status` branch:

```ts
  if (path === '/events') {
    hub.attach(res, () => statusBody(deps));
    return;
  }

  if (path === '/display') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DISPLAY_HTML);
    return;
  }

  if (path === '/message') {
    if (method === 'DELETE') {
      await enqueueWrite(async () => {
        deps.store.clearMessage();
        await deps.persist(deps.store.get());
      });
      hub.broadcast(statusBody(deps));
      sendJson(res, 200, statusBody(deps));
      return;
    }
    let text: unknown;
    try {
      const body: unknown = JSON.parse(await readBody(req));
      ({ text } = body as { text?: unknown });
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${(err as Error).message}` });
      return;
    }
    if (typeof text !== 'string' || text.trim() === '') {
      sendJson(res, 400, { error: 'text must be a non-empty string' });
      return;
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      sendJson(res, 400, { error: `text must be at most ${MAX_MESSAGE_CHARS} characters` });
      return;
    }
    const messageText: string = text;
    await enqueueWrite(async () => {
      deps.store.setMessage(messageText);
      await deps.persist(deps.store.get());
    });
    hub.broadcast(statusBody(deps));
    sendJson(res, 200, statusBody(deps));
    return;
  }
```

8. Broadcast after the two existing state-write call sites (`/state` and `/on|/off`): insert `hub.broadcast(statusBody(deps));` between the `await enqueueWrite(...)` line and the `sendJson(res, 200, statusBody(deps));` line in both places.

- [ ] **Step 5: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all pass (35 + 6 = 41), tsc clean. If `h.close()` hangs in the events test, the abort must happen before close (it does in the test code above).

- [ ] **Step 6: Commit**

```bash
git add src/display.ts src/server.ts test/server.test.ts
git commit -m "feat: /message, /events (SSE), /display routes with query-token reads"
```

---

### Task 4: app wiring - hub lifecycle and clean shutdown

**Files:**
- Modify: `src/app.ts`
- Test: `test/app.test.ts` (append)

**Interfaces:**
- Consumes: `createSseHub` (Task 2), `hub` dep on `createApiServer` (Task 3).
- Produces: `createApp` owns a hub, passes it to the server, and `close()` runs `hub.closeAll()` + `server.closeIdleConnections()` before `server.close()` so open SSE streams cannot hang shutdown. `App` unchanged externally.

- [ ] **Step 1: Write the failing test**

Append to `test/app.test.ts`:

```ts
test('message survives a restart', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const app1 = await createApp({ stateFile, port: 0, driver: new StubDriver(), log: () => {} });
  await fetch(`http://127.0.0.1:${app1.port}/message`, { method: 'PUT', body: JSON.stringify({ text: 'BRB' }) });
  await app1.close();
  const app2 = await createApp({ stateFile, port: 0, driver: new StubDriver(), log: () => {} });
  const body = await (await fetch(`http://127.0.0.1:${app2.port}/status`)).json();
  assert.equal(body.message, 'BRB');
  await app2.close();
});

test('close() completes while an SSE client is connected', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const app = await createApp({ stateFile, port: 0, driver: new StubDriver(), log: () => {} });
  const res = await fetch(`http://127.0.0.1:${app.port}/events`);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  await app.close(); // must resolve despite the open stream
  assert.ok(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the SSE-close test hangs or times out (open stream blocks `server.close`); the restart test may pass already - that is fine, keep it as a regression net. Use the timeout as the failure signal; if the runner hangs > 30s, Ctrl-C and proceed.

- [ ] **Step 3: Modify src/app.ts**

Add the import and wire the hub:

```ts
import { createSseHub } from './sse.js';
```

In `createApp`, create the hub before the server and pass it in; change `close`:

```ts
  const hub = createSseHub();
  const server: Server = createApiServer({
    store,
    driver,
    persist: (state) => saveState(opts.stateFile, state),
    token: opts.token,
    hub,
  });
```

```ts
    close: () =>
      new Promise((resolve, reject) => {
        hub.closeAll();
        server.closeIdleConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all pass (41 + 2 = 43), no hangs, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts test/app.test.ts
git commit -m "feat: app owns SSE hub; shutdown closes streams before server.close"
```

---

### Task 5: acceptance run and issue #8 close-out

**Files:**
- Modify: `README.md` (extend the "Running the API" section with one display line)

**Interfaces:**
- Consumes: the finished service.
- Produces: verified acceptance evidence on issue #8.

- [ ] **Step 1: Full suite and build**

Run: `npm test && npm run build`
Expected: 43/43, tsc emits dist/.

- [ ] **Step 2: Live acceptance with curl**

```bash
ONAIR_STATE_FILE=/tmp/onair-accept8/state.json node dist/index.js &
sleep 1
curl -s http://localhost:8484/status
curl -s -X POST http://localhost:8484/on
curl -s -X PUT http://localhost:8484/message -d '{"text": "BE QUIET"}'
curl -s http://localhost:8484/status
curl -s -N --max-time 3 http://localhost:8484/events || true   # shows snapshot event frame
curl -s -X DELETE http://localhost:8484/message
curl -s http://localhost:8484/display | head -5
kill %1
# restart: message + state must survive
ONAIR_STATE_FILE=/tmp/onair-accept8/state.json node dist/index.js &
sleep 1
curl -s http://localhost:8484/status
kill %1
```

Expected: message appears then clears in status; `/events` frame starts `event: status`; `/display` returns HTML; after restart `intended` is `"on"` (message was deleted before restart, so `message` is `null` - state persisted either way).

- [ ] **Step 3: Update README.md**

In the "Running the API" section, append:

```markdown
Interim tally display: open `http://<host>:8484/display` fullscreen (kiosk). Set a
custom message with `curl -X PUT :8484/message -d '{"text": "BE QUIET"}'`, clear with
`DELETE /message`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: display page usage"
```

- [ ] **Step 5: Report on issue #8**

Post the acceptance transcript with `gh issue comment 8`, confirm the acceptance criteria (live flip, message set/clear without hiding state color - browser check is done by the controller - restart persistence, old-state-file compat covered by tests), and close with `gh issue close 8`. The controller performs a real-browser check of `/display` before the issue is closed.

---

## Self-Review Notes

- Spec coverage: message resource + validation (T1/T3), heartbeat-proof message (T1 write() + T3 test), back-compat load (T1), SSE snapshot/event/heartbeat/cleanup (T2/T3/T4), display page incl. overlays and stale logic (T3), `?token=` reads (T3), shutdown with open streams (T4), acceptance (T5).
- Display's DISCONNECTED and stale behavior are client-side and get their real check via the controller's browser pass in T5; automated tests assert the page's delivery and the server contract, not pixels.
- Test-count expectations (31/35/41/43) assume the current suite of 27; if counts drift, the pass/fail signal is what matters.
