import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { LightDriver } from './driver.js';
import { DISPLAY_HTML } from './display.js';
import { createSseHub, type SseHub } from './sse.js';
import type { Confirmed, OnAirState, StateStore } from './state.js';
import { createWsBridge, type WsBridge } from './ws.js';

export interface ServerDeps {
  store: StateStore;
  driver: LightDriver;
  persist: (state: OnAirState) => Promise<void>;
  token?: string;
  hub?: SseHub;
  ws?: WsBridge;
  log?: (line: string) => void;
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
  const ws = deps.ws ?? createWsBridge();
  const log = deps.log ?? console.log;

  let writeChain: Promise<void> = Promise.resolve();
  function enqueueWrite(run: () => Promise<void>): Promise<void> {
    const next = writeChain.then(run);
    writeChain = next.catch(() => {});
    return next;
  }

  const server = createServer((req, res) => {
    handle(req, res, deps, enqueueWrite, hub, ws, log).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: `internal error: ${errorMessage(err)}` });
      } else {
        // Can't send a JSON error once headers are out; destroy so the client sees a clear
        // connection failure instead of a silently hung or truncated response.
        res.destroy();
        log(`[onair] response failed after headers sent: ${errorMessage(err)}`);
      }
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Standard hardening: attached before anything else can fail, so a socket-level
    // error while we're still deciding 404/401/handoff doesn't crash the process. Once
    // handleUpgrade takes over below it attaches its own (real) error handler.
    socket.on('error', () => {});

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/events/ws') {
      // end()'s callback forces the socket closed once the reply is flushed, rather than
      // waiting on the peer's own FIN (which a half-open or dead peer may never send).
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n', () => socket.destroy());
      return;
    }

    if (deps.token !== undefined) {
      const authHeader = req.headers.authorization;
      const headerOk = typeof authHeader === 'string' && timingSafeStringEqual(authHeader, `Bearer ${deps.token}`);
      const queryToken = url.searchParams.get('token');
      const queryOk = queryToken !== null && timingSafeStringEqual(queryToken, deps.token);
      if (!headerOk && !queryOk) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n', () => socket.destroy());
        return;
      }
    }

    ws.handleUpgrade(req, socket, () => statusBody(deps), head);
  });

  return server;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Early length-mismatch return leaks token length via timing — accepted for this LAN threat model.
  // timingSafeEqual throws on length mismatch; unequal lengths are already not a match.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

function broadcastAndSend(res: ServerResponse, deps: ServerDeps, hub: SseHub, ws: WsBridge): void {
  const body = statusBody(deps);
  hub.broadcast(body);
  ws.broadcast(body);
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

async function doWrite(
  deps: ServerDeps,
  onAir: boolean,
  source: string,
  log: (line: string) => void,
): Promise<void> {
  deps.store.write(onAir, source);
  await persistCurrent(deps);
  let confirmed: Confirmed;
  try {
    confirmed = await deps.driver.set(onAir);
  } catch (err) {
    log(`[onair] driver.set(${onAir}) failed: ${errorMessage(err)}`);
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
  ws: WsBridge,
  log: (line: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (deps.token !== undefined) {
    const authHeader = req.headers.authorization;
    const headerOk = typeof authHeader === 'string' && timingSafeStringEqual(authHeader, `Bearer ${deps.token}`);
    const queryToken = url.searchParams.get('token');
    const queryOk = method === 'GET' && queryToken !== null && timingSafeStringEqual(queryToken, deps.token);
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

  // Drain the body for every route below that doesn't call readBody() itself, so an
  // unread body doesn't stall the socket and break keep-alive for the next request.
  // This condition must list exactly the routes/methods that call readBody() below —
  // adding a body-reading route without updating it will cause req.resume() to eat the body first.
  const willReadBody = (path === '/state' || path === '/message') && method === 'PUT';
  if (!willReadBody) req.resume();

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
      broadcastAndSend(res, deps, hub, ws);
      return;
    }
    let text: unknown;
    try {
      const body: unknown = JSON.parse(await readBody(req));
      ({ text } = body as { text?: unknown });
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${errorMessage(err)}` });
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
    broadcastAndSend(res, deps, hub, ws);
    return;
  }

  if (path === '/state') {
    let onAir: unknown;
    let source: unknown;
    try {
      const body: unknown = JSON.parse(await readBody(req));
      ({ onAir, source } = body as { onAir?: unknown; source?: unknown });
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${errorMessage(err)}` });
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
    await enqueueWrite(() => doWrite(deps, onAir, source ?? 'manual', log));
    broadcastAndSend(res, deps, hub, ws);
    return;
  }

  // POST /on | /off
  await enqueueWrite(() => doWrite(deps, path === '/on', url.searchParams.get('source') ?? 'manual', log));
  broadcastAndSend(res, deps, hub, ws);
}
