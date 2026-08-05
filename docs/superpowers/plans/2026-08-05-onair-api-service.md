# On-air API Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the on-air REST API from `docs/api-contract.md` (issue #3) in Node.js + TypeScript, running on the Mac Mini, with a pluggable no-op LightDriver.

**Architecture:** A zero-runtime-dependency Node service: `node:http` server, in-memory `StateStore` persisted atomically to a JSON file, and a `LightDriver` interface whose only implementation for now logs transitions and reports `unknown`. Boot re-applies persisted intended state to the driver.

**Tech Stack:** Node >= 22, TypeScript 5 (ESM, `nodenext`), dev-only deps (`typescript`, `tsx`, `@types/node`), built-in `node:test` runner. Zero production dependencies.

## Global Constraints

- The spec is `docs/api-contract.md` — field names (`intended`, `confirmed`, `source`, `updatedAt`, `ageSeconds`, `onAir`), status codes, and error shape `{"error": "<message>"}` are exact.
- Default port `8484` (`ONAIR_PORT` overrides). Optional auth only when `ONAIR_TOKEN` is set. State file default `~/.onair/state.json` (`ONAIR_STATE_FILE` overrides).
- Zero production npm dependencies. Dev dependencies: `typescript`, `tsx`, `@types/node` only.
- ESM throughout (`"type": "module"`); TS source imports use `.js` extensions (`from './state.js'`) — required by `nodenext` resolution; `tsx` maps them to `.ts` in tests.
- A write never fails because the light is unreachable: `intended` persists, `confirmed` becomes `"unknown"`.
- Persisted `confirmed` is always `"unknown"` (persist happens before the driver answers); the live value exists only in memory and is re-derived on boot.
- Run all commands from the repo root `/Users/john/code/rocket-on-air-sensor`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `test/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `node --import tsx --test test/`; `npm run build` runs `tsc` to `dist/`; later tasks add files under `src/` and `test/`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "onair-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "test": "node --import tsx --test test/",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Append to .gitignore**

Append these lines to the existing `.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 4: Install dev dependencies**

Run: `npm install --save-dev typescript tsx @types/node`
Expected: creates `package-lock.json` and `node_modules/`; exits 0.

- [ ] **Step 5: Write test/smoke.test.ts**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 6: Run the test suite**

Run: `npm test`
Expected: `pass 1`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json test/smoke.test.ts .gitignore
git commit -m "chore: scaffold Node/TypeScript project with built-in test runner"
```

---

### Task 2: State store

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type OnOff = 'on' | 'off'`; `type Confirmed = OnOff | 'unknown'`; `interface OnAirState { intended: OnOff; confirmed: Confirmed; source: string; updatedAt: string }`; `defaultState(now?: Date): OnAirState`; `isOnAirState(v: unknown): v is OnAirState`; `class StateStore { constructor(initial: OnAirState); get(): OnAirState; write(onAir: boolean, source: string, now?: Date): OnAirState; setConfirmed(c: Confirmed): OnAirState; ageSeconds(now?: Date): number }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/state.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultState, isOnAirState, StateStore } from '../src/state.js';

test('defaultState is off/unknown from boot', () => {
  const s = defaultState(new Date('2026-08-05T00:00:00Z'));
  assert.deepEqual(s, {
    intended: 'off',
    confirmed: 'unknown',
    source: 'boot',
    updatedAt: '2026-08-05T00:00:00.000Z',
  });
});

test('write sets intended/source/updatedAt and resets confirmed to unknown', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  store.setConfirmed('on');
  const now = new Date('2026-08-05T01:00:00Z');
  const state = store.write(true, 'detector', now);
  assert.equal(state.intended, 'on');
  assert.equal(state.confirmed, 'unknown');
  assert.equal(state.source, 'detector');
  assert.equal(state.updatedAt, now.toISOString());
});

test('setConfirmed updates only confirmed', () => {
  const store = new StateStore(defaultState());
  store.write(true, 'manual');
  const state = store.setConfirmed('on');
  assert.equal(state.confirmed, 'on');
  assert.equal(state.intended, 'on');
});

test('get returns a copy, not a live reference', () => {
  const store = new StateStore(defaultState());
  const a = store.get();
  a.intended = 'on';
  assert.equal(store.get().intended, 'off');
});

test('ageSeconds measures whole seconds since last write, never negative', () => {
  const store = new StateStore(defaultState(new Date('2026-08-05T00:00:00Z')));
  store.write(false, 'manual', new Date('2026-08-05T00:00:00Z'));
  assert.equal(store.ageSeconds(new Date('2026-08-05T00:00:42.400Z')), 42);
  assert.equal(store.ageSeconds(new Date('2026-08-04T23:59:00Z')), 0);
});

test('isOnAirState accepts valid state and rejects junk', () => {
  assert.equal(isOnAirState(defaultState()), true);
  assert.equal(isOnAirState(null), false);
  assert.equal(isOnAirState({ intended: 'maybe', confirmed: 'unknown', source: 'x', updatedAt: 'now' }), false);
  assert.equal(isOnAirState({ intended: 'on', confirmed: 'off', source: 7, updatedAt: 'now' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/state.js`.

- [ ] **Step 3: Write src/state.ts**

```ts
export type OnOff = 'on' | 'off';
export type Confirmed = OnOff | 'unknown';

export interface OnAirState {
  intended: OnOff;
  confirmed: Confirmed;
  source: string;
  updatedAt: string;
}

export function defaultState(now: Date = new Date()): OnAirState {
  return { intended: 'off', confirmed: 'unknown', source: 'boot', updatedAt: now.toISOString() };
}

export function isOnAirState(v: unknown): v is OnAirState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    (s.intended === 'on' || s.intended === 'off') &&
    (s.confirmed === 'on' || s.confirmed === 'off' || s.confirmed === 'unknown') &&
    typeof s.source === 'string' &&
    typeof s.updatedAt === 'string'
  );
}

export class StateStore {
  private state: OnAirState;

  constructor(initial: OnAirState) {
    this.state = { ...initial };
  }

  get(): OnAirState {
    return { ...this.state };
  }

  write(onAir: boolean, source: string, now: Date = new Date()): OnAirState {
    this.state = {
      intended: onAir ? 'on' : 'off',
      confirmed: 'unknown',
      source,
      updatedAt: now.toISOString(),
    };
    return this.get();
  }

  setConfirmed(confirmed: Confirmed): OnAirState {
    this.state = { ...this.state, confirmed };
    return this.get();
  }

  ageSeconds(now: Date = new Date()): number {
    const age = (now.getTime() - Date.parse(this.state.updatedAt)) / 1000;
    return Math.max(0, Math.floor(age));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests pass (smoke + 6 state tests), exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "feat: state store with intended/confirmed model and staleness"
```

---

### Task 3: Atomic persistence

**Files:**
- Create: `src/persist.ts`
- Test: `test/persist.test.ts`

**Interfaces:**
- Consumes: `OnAirState`, `isOnAirState` from `./state.js`.
- Produces: `loadState(file: string): Promise<OnAirState | null>` (null when missing; throws on corrupt JSON or invalid shape — fail fast); `saveState(file: string, state: OnAirState): Promise<void>` (mkdir -p, write `<file>.tmp`, rename over `<file>`).

- [ ] **Step 1: Write the failing test**

```ts
// test/persist.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadState, saveState } from '../src/persist.js';
import { defaultState } from '../src/state.js';

async function tmpStateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'onair-test-'));
  return join(dir, 'nested', 'state.json');
}

test('save then load round-trips and creates parent dirs', async () => {
  const file = await tmpStateFile();
  const state = { ...defaultState(), intended: 'on' as const, source: 'detector' };
  await saveState(file, state);
  assert.deepEqual(await loadState(file), state);
});

test('save leaves no tmp file behind', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  const entries = await readdir(join(file, '..'));
  assert.deepEqual(entries, ['state.json']);
});

test('load returns null when the file does not exist', async () => {
  const file = await tmpStateFile();
  assert.equal(await loadState(file), null);
});

test('load throws on corrupt JSON', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  await writeFile(file, '{not json', 'utf8');
  await assert.rejects(() => loadState(file));
});

test('load throws on valid JSON with invalid shape', async () => {
  const file = await tmpStateFile();
  await saveState(file, defaultState());
  await writeFile(file, JSON.stringify({ intended: 'sideways' }), 'utf8');
  await assert.rejects(() => loadState(file), /invalid shape/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/persist.js`.

- [ ] **Step 3: Write src/persist.ts**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isOnAirState, type OnAirState } from './state.js';

export async function loadState(file: string): Promise<OnAirState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isOnAirState(parsed)) throw new Error(`state file ${file} has invalid shape`);
  return parsed;
}

export async function saveState(file: string, state: OnAirState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/persist.ts test/persist.test.ts
git commit -m "feat: atomic JSON state persistence (tmp + rename)"
```

---

### Task 4: LightDriver interface and no-op driver

**Files:**
- Create: `src/driver.ts`
- Test: `test/driver.test.ts`

**Interfaces:**
- Consumes: `Confirmed` from `./state.js`.
- Produces: `interface LightDriver { set(onAir: boolean): Promise<Confirmed> }`; `class NoopDriver implements LightDriver { constructor(log?: (line: string) => void) }` — logs each transition, always resolves `'unknown'`.

- [ ] **Step 1: Write the failing test**

```ts
// test/driver.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoopDriver } from '../src/driver.js';

test('noop driver logs the transition and reports unknown', async () => {
  const lines: string[] = [];
  const driver = new NoopDriver((line) => lines.push(line));
  assert.equal(await driver.set(true), 'unknown');
  assert.equal(await driver.set(false), 'unknown');
  assert.deepEqual(lines, ['[noop-driver] light -> ON', '[noop-driver] light -> OFF']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/driver.js`.

- [ ] **Step 3: Write src/driver.ts**

```ts
import type { Confirmed } from './state.js';

export interface LightDriver {
  set(onAir: boolean): Promise<Confirmed>;
}

export class NoopDriver implements LightDriver {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async set(onAir: boolean): Promise<Confirmed> {
    this.log(`[noop-driver] light -> ${onAir ? 'ON' : 'OFF'}`);
    return 'unknown';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/driver.ts test/driver.test.ts
git commit -m "feat: LightDriver interface with logging no-op driver"
```

---

### Task 5: HTTP server

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `StateStore`, `OnAirState`, `Confirmed` from `./state.js`; `LightDriver` from `./driver.js`.
- Produces: `interface ServerDeps { store: StateStore; driver: LightDriver; persist: (state: OnAirState) => Promise<void>; token?: string }`; `createApiServer(deps: ServerDeps): http.Server` (not yet listening — caller calls `.listen()`).

- [ ] **Step 1: Write the failing test**

```ts
// test/server.test.ts
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test } from 'node:test';
import type { LightDriver } from '../src/driver.js';
import { createApiServer, type ServerDeps } from '../src/server.js';
import { defaultState, StateStore, type Confirmed, type OnAirState } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: boolean[] = [];
  result: Confirmed = 'on';
  fail = false;

  async set(onAir: boolean): Promise<Confirmed> {
    this.calls.push(onAir);
    if (this.fail) throw new Error('light unreachable');
    return this.result;
  }
}

interface Harness {
  base: string;
  driver: StubDriver;
  persisted: OnAirState[];
  close: () => Promise<void>;
}

async function boot(token?: string): Promise<Harness> {
  const driver = new StubDriver();
  const persisted: OnAirState[] = [];
  const deps: ServerDeps = {
    store: new StateStore(defaultState()),
    driver,
    persist: async (state) => {
      persisted.push(state);
    },
    token,
  };
  const server: Server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    driver,
    persisted,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test('GET /status returns state plus ageSeconds', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'off');
  assert.equal(body.confirmed, 'unknown');
  assert.equal(typeof body.ageSeconds, 'number');
  await h.close();
});

test('PUT /state turns on, persists, and reports driver confirmation', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, {
    method: 'PUT',
    body: JSON.stringify({ onAir: true, source: 'detector' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'on');
  assert.equal(body.source, 'detector');
  assert.deepEqual(h.driver.calls, [true]);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0]!.intended, 'on');
  assert.equal(h.persisted[0]!.confirmed, 'unknown');
  await h.close();
});

test('PUT /state defaults source to manual', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: false }) });
  const body = await res.json();
  assert.equal(body.source, 'manual');
  await h.close();
});

test('driver failure still succeeds the write with confirmed unknown', async () => {
  const h = await boot();
  h.driver.fail = true;
  const res = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: true }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'unknown');
  assert.equal(h.persisted.length, 1);
  await h.close();
});

test('POST /on and /off are manual conveniences with ?source= override', async () => {
  const h = await boot();
  let body = await (await fetch(`${h.base}/on`, { method: 'POST' })).json();
  assert.equal(body.intended, 'on');
  assert.equal(body.source, 'manual');
  body = await (await fetch(`${h.base}/off?source=shortcut`, { method: 'POST' })).json();
  assert.equal(body.intended, 'off');
  assert.equal(body.source, 'shortcut');
  assert.deepEqual(h.driver.calls, [true, false]);
  await h.close();
});

test('malformed and invalid bodies get 400 with error shape', async () => {
  const h = await boot();
  const bad = await fetch(`${h.base}/state`, { method: 'PUT', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json()).error, 'string');
  const wrongType = await fetch(`${h.base}/state`, { method: 'PUT', body: JSON.stringify({ onAir: 'yes' }) });
  assert.equal(wrongType.status, 400);
  assert.deepEqual(h.driver.calls, []);
  await h.close();
});

test('unknown path 404, wrong method 405', async () => {
  const h = await boot();
  assert.equal((await fetch(`${h.base}/nope`)).status, 404);
  assert.equal((await fetch(`${h.base}/status`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${h.base}/on`)).status, 405);
  await h.close();
});

test('token gate: 401 without or with wrong bearer, 200 with right one', async () => {
  const h = await boot('sekrit');
  assert.equal((await fetch(`${h.base}/status`)).status, 401);
  assert.equal(
    (await fetch(`${h.base}/status`, { headers: { authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${h.base}/status`, { headers: { authorization: 'Bearer sekrit' } })).status,
    200,
  );
  await h.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/server.js`.

- [ ] **Step 3: Write src/server.ts**

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LightDriver } from './driver.js';
import type { Confirmed, OnAirState, StateStore } from './state.js';

export interface ServerDeps {
  store: StateStore;
  driver: LightDriver;
  persist: (state: OnAirState) => Promise<void>;
  token?: string;
}

const ROUTES: Record<string, string[]> = {
  '/status': ['GET'],
  '/state': ['PUT'],
  '/on': ['POST'],
  '/off': ['POST'],
};

const MAX_BODY_BYTES = 16 * 1024;

export function createApiServer(deps: ServerDeps): Server {
  return createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      sendJson(res, 500, { error: `internal error: ${(err as Error).message}` });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body)}\n`);
}

function statusBody(deps: ServerDeps): OnAirState & { ageSeconds: number } {
  return { ...deps.store.get(), ageSeconds: deps.store.ageSeconds() };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function doWrite(deps: ServerDeps, onAir: boolean, source: string): Promise<void> {
  deps.store.write(onAir, source);
  await deps.persist(deps.store.get());
  let confirmed: Confirmed;
  try {
    confirmed = await deps.driver.set(onAir);
  } catch {
    confirmed = 'unknown';
  }
  deps.store.setConfirmed(confirmed);
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (deps.token !== undefined && req.headers.authorization !== `Bearer ${deps.token}`) {
    sendJson(res, 401, { error: 'missing or invalid bearer token' });
    return;
  }

  const allowed = ROUTES[path];
  if (!allowed) {
    sendJson(res, 404, { error: `unknown path: ${path}` });
    return;
  }
  if (!allowed.includes(method)) {
    sendJson(res, 405, { error: `${method} not allowed on ${path}` });
    return;
  }

  if (path === '/status') {
    sendJson(res, 200, statusBody(deps));
    return;
  }

  if (path === '/state') {
    let onAir: unknown;
    let source: unknown;
    try {
      const body: unknown = JSON.parse(await readBody(req));
      ({ onAir, source } = body as { onAir?: unknown; source?: unknown });
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${(err as Error).message}` });
      return;
    }
    if (typeof onAir !== 'boolean') {
      sendJson(res, 400, { error: 'onAir must be a boolean' });
      return;
    }
    if (source !== undefined && typeof source !== 'string') {
      sendJson(res, 400, { error: 'source must be a string' });
      return;
    }
    await doWrite(deps, onAir, source ?? 'manual');
    sendJson(res, 200, statusBody(deps));
    return;
  }

  // POST /on | /off
  await doWrite(deps, path === '/on', url.searchParams.get('source') ?? 'manual');
  sendJson(res, 200, statusBody(deps));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all tests pass (including all 9 server tests), exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: HTTP API - status, state writes, aliases, auth, error shapes"
```

---

### Task 6: App wiring, boot re-apply, and entrypoint

**Files:**
- Create: `src/app.ts`, `src/index.ts`
- Test: `test/app.test.ts`

**Interfaces:**
- Consumes: everything above — `createApiServer`, `loadState`/`saveState`, `NoopDriver`, `StateStore`, `defaultState`.
- Produces: `interface AppOptions { stateFile: string; port: number; token?: string; driver?: LightDriver; log?: (line: string) => void }`; `interface App { port: number; store: StateStore; close(): Promise<void> }`; `createApp(opts: AppOptions): Promise<App>` — loads persisted state (or default), re-applies intended to the driver, starts listening. `src/index.ts` reads `ONAIR_PORT`/`ONAIR_TOKEN`/`ONAIR_STATE_FILE` env vars and handles SIGINT/SIGTERM.

- [ ] **Step 1: Write the failing test**

```ts
// test/app.test.ts
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import type { Confirmed } from '../src/state.js';

class StubDriver implements LightDriver {
  calls: boolean[] = [];
  async set(onAir: boolean): Promise<Confirmed> {
    this.calls.push(onAir);
    return onAir ? 'on' : 'off';
  }
}

test('state survives a restart and boot re-applies intended to the driver', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');

  const driver1 = new StubDriver();
  const app1 = await createApp({ stateFile, port: 0, driver: driver1, log: () => {} });
  assert.deepEqual(driver1.calls, [false]); // boot re-applies default OFF
  const res = await fetch(`http://127.0.0.1:${app1.port}/state`, {
    method: 'PUT',
    body: JSON.stringify({ onAir: true, source: 'detector' }),
  });
  assert.equal(res.status, 200);
  await app1.close();

  const driver2 = new StubDriver();
  const app2 = await createApp({ stateFile, port: 0, driver: driver2, log: () => {} });
  assert.deepEqual(driver2.calls, [true]); // boot re-applies persisted ON
  const body = await (await fetch(`http://127.0.0.1:${app2.port}/status`)).json();
  assert.equal(body.intended, 'on');
  assert.equal(body.confirmed, 'on');
  assert.equal(body.source, 'detector');
  await app2.close();
});

test('token from options gates the API end to end', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'onair-app-')), 'state.json');
  const app = await createApp({ stateFile, port: 0, token: 'tok', driver: new StubDriver(), log: () => {} });
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/status`)).status, 401);
  assert.equal(
    (await fetch(`http://127.0.0.1:${app.port}/status`, { headers: { authorization: 'Bearer tok' } })).status,
    200,
  );
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/app.js`.

- [ ] **Step 3: Write src/app.ts**

```ts
import type { Server } from 'node:http';
import { NoopDriver, type LightDriver } from './driver.js';
import { loadState, saveState } from './persist.js';
import { createApiServer } from './server.js';
import { defaultState, StateStore } from './state.js';

export interface AppOptions {
  stateFile: string;
  port: number;
  token?: string;
  driver?: LightDriver;
  log?: (line: string) => void;
}

export interface App {
  port: number;
  store: StateStore;
  close: () => Promise<void>;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const log = opts.log ?? console.log;
  const driver = opts.driver ?? new NoopDriver(log);
  const loaded = await loadState(opts.stateFile);
  const store = new StateStore(loaded ?? defaultState());

  // Invariant: recover after restart - re-apply intended state to the light on boot.
  try {
    store.setConfirmed(await driver.set(store.get().intended === 'on'));
  } catch {
    store.setConfirmed('unknown');
  }

  const server: Server = createApiServer({
    store,
    driver,
    persist: (state) => saveState(opts.stateFile, state),
    token: opts.token,
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  log(`[onair] listening on :${port}, state file ${opts.stateFile}`);

  return {
    port,
    store,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
```

- [ ] **Step 4: Write src/index.ts**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.ONAIR_PORT ?? 8484);
const stateFile = process.env.ONAIR_STATE_FILE ?? join(homedir(), '.onair', 'state.json');
const token = process.env.ONAIR_TOKEN;

const app = await createApp({ port, stateFile, token });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
```

- [ ] **Step 5: Run tests and the type-checked build**

Run: `npm test && npm run build`
Expected: all tests pass; `tsc` exits 0 and emits `dist/`.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/index.ts test/app.test.ts
git commit -m "feat: app wiring with boot re-apply and env-configured entrypoint"
```

---

### Task 7: Acceptance run and ticket close-out

**Files:**
- Modify: `README.md` (add a short "Running the API" section)

**Interfaces:**
- Consumes: the finished service (`npm run dev` / `node dist/index.js`).
- Produces: verified acceptance evidence on issue #3.

- [ ] **Step 1: Run the full suite one more time**

Run: `npm test && npm run build`
Expected: everything passes.

- [ ] **Step 2: Boot the real service and exercise it with curl**

Run (from repo root):

```bash
ONAIR_STATE_FILE=/tmp/onair-accept/state.json node dist/index.js &
sleep 1
curl -s http://localhost:8484/status
curl -s -X POST http://localhost:8484/on
curl -s -X PUT http://localhost:8484/state -d '{"onAir": true, "source": "detector"}'
curl -s http://localhost:8484/status
kill %1
# restart to prove persistence
ONAIR_STATE_FILE=/tmp/onair-accept/state.json node dist/index.js &
sleep 1
curl -s http://localhost:8484/status
kill %1
```

Expected: status starts `{"intended":"off",...}`; after the writes, `intended` is `"on"` with `source` `"detector"`; the noop driver logs `light -> ON` transitions; after restart, `intended` is still `"on"`. Also test LAN reachability with the Mac's LAN IP (`ipconfig getifaddr en0`) in place of `localhost`.

- [ ] **Step 3: Add "Running the API" to README.md**

Append:

```markdown
## Running the API

```sh
npm install && npm run build && npm start   # or: npm run dev
```

Config via env: `ONAIR_PORT` (default 8484), `ONAIR_STATE_FILE` (default `~/.onair/state.json`), `ONAIR_TOKEN` (optional bearer auth). Contract: `docs/api-contract.md`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: how to run the on-air API"
```

- [ ] **Step 5: Report on issue #3**

Post the curl transcript as a comment with `gh issue comment 3`, confirm all acceptance criteria (LAN curl set/read, restart persistence, unit tests, logging no-op driver), and close the issue with `gh issue close 3`.

---

## Self-Review Notes

- Spec coverage: every `docs/api-contract.md` requirement maps to a task — status/ageSeconds (T2/T5), PUT + aliases + source default (T5), light-failure-is-not-write-failure (T5), persisted-confirmed-is-unknown (T5 test), restart re-apply (T6), token auth (T5/T6), error shapes 400/401/404/405 (T5), port/env config (T6), acceptance curl + persistence (T7).
- Deliberately out of scope: heartbeat is client-side (no server work); systemd/npx packaging is issue #4; real light driver is issue #6.
