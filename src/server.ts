import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LightDriver } from './driver.js';
import { DISPLAY_HTML } from './display.js';
import { createSseHub, type SseHub } from './sse.js';
import type { Confirmed, OnAirState, StateStore } from './state.js';

export interface ServerDeps {
  store: StateStore;
  driver: LightDriver;
  persist: (state: OnAirState) => Promise<void>;
  token?: string;
  hub?: SseHub;
}

const ROUTES: Record<string, string[]> = {
  '/status': ['GET'],
  '/state': ['PUT'],
  '/on': ['POST'],
  '/off': ['POST'],
  '/message': ['PUT', 'DELETE'],
  '/events': ['GET'],
  '/display': ['GET'],
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 200;

export function createApiServer(deps: ServerDeps): Server {
  if (deps.token !== undefined && deps.token.trim() === '') {
    throw new Error('token must be non-empty when provided');
  }

  const hub = deps.hub ?? createSseHub();

  let writeChain: Promise<void> = Promise.resolve();
  function enqueueWrite(run: () => Promise<void>): Promise<void> {
    const next = writeChain.then(run);
    writeChain = next.catch(() => {});
    return next;
  }

  return createServer((req, res) => {
    handle(req, res, deps, enqueueWrite, hub).catch((err) => {
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

function persistCurrent(deps: ServerDeps): Promise<void> {
  // Invariant: persisted confirmed is always "unknown" - the live value is memory-only.
  return deps.persist({ ...deps.store.get(), confirmed: 'unknown' });
}

function broadcastAndSend(res: ServerResponse, deps: ServerDeps, hub: SseHub): void {
  const body = statusBody(deps);
  hub.broadcast(body);
  sendJson(res, 200, body);
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
  await persistCurrent(deps);
  let confirmed: Confirmed;
  try {
    confirmed = await deps.driver.set(onAir);
  } catch {
    confirmed = 'unknown';
  }
  deps.store.setConfirmed(confirmed);
}

type EnqueueWrite = (run: () => Promise<void>) => Promise<void>;

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  enqueueWrite: EnqueueWrite,
  hub: SseHub,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (deps.token !== undefined) {
    const headerOk = req.headers.authorization === `Bearer ${deps.token}`;
    const queryOk = method === 'GET' && url.searchParams.get('token') === deps.token;
    if (!headerOk && !queryOk) {
      sendJson(res, 401, { error: 'missing or invalid bearer token' });
      return;
    }
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
        await persistCurrent(deps);
      });
      broadcastAndSend(res, deps, hub);
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
      await persistCurrent(deps);
    });
    broadcastAndSend(res, deps, hub);
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
    await enqueueWrite(() => doWrite(deps, onAir, source ?? 'manual'));
    broadcastAndSend(res, deps, hub);
    return;
  }

  // POST /on | /off
  await enqueueWrite(() => doWrite(deps, path === '/on', url.searchParams.get('source') ?? 'manual'));
  broadcastAndSend(res, deps, hub);
}
