import { timingSafeEqual } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import type { LightDriver } from './driver.js';
import { DISPLAY_HTML } from './display.js';
import { createSseHub, type SseHub } from './sse.js';
import {
  coerceSource,
  parseSource,
  SEED_SHORTCUTS,
  UNKNOWN_ID,
  type Shortcuts,
  type Source,
  type StateStore,
  type StatusBody,
} from './state.js';
import { UI_HTML } from './ui.js';
import { createWsBridge, type WsBridge } from './ws.js';

export interface ServerDeps {
  store: StateStore;
  driver: LightDriver;
  persist: (state: import('./state.js').PersistedState) => Promise<void>;
  /** Shared write queue. When absent the server makes its own; app.ts passes the same
   *  one to the supervisor so supervisor writes serialise with HTTP writes. */
  enqueueWrite?: EnqueueWrite;
  token?: string;
  hub?: SseHub;
  ws?: WsBridge;
  log?: (line: string) => void;
  /** State file path, used only for the /admin/health writability check. */
  stateFile?: string;
  /** Called (once) to actually exit the process for POST /admin/restart. Defaults to process.exit(0). */
  exitFn?: () => void;
  /** Which rows `/on` and `/off` resolve to. Seeded here; #39 moves them into the config document. */
  shortcuts?: Shortcuts;
}

// `POST /state/{id}` is matched separately - it is the one route with a variable segment.
// `onAir`, `POST /available`, `POST /interruptible` and `POST /dnd` are GONE (contract §5).
const ROUTES: Record<string, string[]> = {
  '/status': ['GET'],
  '/state': ['PUT'],
  '/on': ['POST'],
  '/off': ['POST'],
  '/message': ['PUT', 'DELETE'],
  '/events': ['GET'],
  '/display': ['GET'],
  '/ui': ['GET'],
  '/admin/health': ['GET'],
  '/admin/restart': ['POST'],
};
const STATE_ID_PATH = /^\/state\/([^/]+)$/;

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
  const enqueueWrite: EnqueueWrite =
    deps.enqueueWrite ??
    ((run) => {
      const next = writeChain.then(run);
      writeChain = next.catch(() => {});
      return next;
    });

  // Declared before assignment so the request handler below can close over the
  // eventual Server instance (needed for /admin/health's bound-port lookup);
  // it's only ever read once a request has arrived, by which point listen()
  // has already assigned it.
  let server: Server;
  server = createServer((req, res) => {
    handle(req, res, deps, enqueueWrite, hub, ws, log, server).catch((err) => {
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

// Every derived field - `busy`, `intended`, `ageSeconds`, `stale`, `tableVersion` - is
// computed at serialisation, so none of them can drift from `state`. Presentation
// (`label`, `color`, `bgcolor`) is deliberately NOT here: it travels with the profile
// (D-42), and putting it on a payload written many times an hour would weld configuration
// into the state protocol permanently.
function statusBody(deps: ServerDeps): StatusBody {
  return deps.store.status();
}

function persistCurrent(deps: ServerDeps): Promise<void> {
  return deps.persist(deps.store.persisted());
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
  stateId: string,
  source: Source,
  log: (line: string) => void,
  hold?: boolean,
): Promise<void> {
  const applied = deps.store.write(stateId, source, new Date(), hold).state;
  await persistCurrent(deps);
  // A write always succeeds if the body is valid (contract §7). An unreachable light is
  // not a failed write - it surfaces as `confirmed: "unknown"`.
  let confirmed: string;
  try {
    confirmed = await deps.driver.set(applied);
  } catch (err) {
    log(`[onair] driver.set(${applied}) failed: ${errorMessage(err)}`);
    confirmed = UNKNOWN_ID;
  }
  // The device can hold any string. Only a row this server knows is evidence of anything.
  deps.store.setConfirmed(deps.store.getTable().has(confirmed) ? confirmed : UNKNOWN_ID);
}

/** `?hold=1|true` pins, `?hold=0|false` releases, absent leaves it alone. */
function holdFromQuery(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return undefined;
}

type EnqueueWrite = (run: () => Promise<void>) => Promise<void>;

function isStateFileWritable(stateFile: string | undefined): boolean {
  if (stateFile === undefined) return false;
  try {
    accessSync(stateFile, fsConstants.W_OK);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    // State file doesn't exist yet - what matters is whether it *could* be created.
    try {
      accessSync(dirname(stateFile), fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function boundPort(server: Server): number {
  const address = server.address();
  // Falls back to 0 if called before listen() resolves; routes only run once the
  // server is listening and handling a real connection, so this is unreachable in practice.
  return typeof address === 'object' && address !== null ? address.port : 0;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  enqueueWrite: EnqueueWrite,
  hub: SseHub,
  ws: WsBridge,
  log: (line: string) => void,
  server: Server,
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

  // `/state/{id}` is the one route with a variable segment, so it is matched rather than
  // looked up. It still goes through the same 404/405 gate: an id that is not a row is a
  // 400 further down (with the valid ids), NOT a 404 - the path is real, the name is wrong.
  const allowed = STATE_ID_PATH.test(path) ? ['POST'] : ROUTES[path];
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

  if (path === '/admin/health') {
    sendJson(res, 200, {
      uptime: process.uptime(),
      pid: process.pid,
      nodeVersion: process.version,
      port: boundPort(server),
      stateFileWritable: isStateFileWritable(deps.stateFile),
    });
    return;
  }

  if (path === '/admin/restart') {
    if (deps.token === undefined) {
      sendJson(res, 403, { error: 'restart requires ONAIR_TOKEN to be configured' });
      return;
    }
    sendJson(res, 202, { restarting: true });
    const exitFn = deps.exitFn ?? (() => process.exit(0));
    let exited = false;
    const doExit = (): void => {
      if (exited) return;
      exited = true;
      exitFn();
    };
    res.on('finish', doExit);
    res.on('close', doExit);
    setTimeout(doExit, 250).unref();
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

  if (path === '/ui') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(UI_HTML);
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
    let state: unknown;
    let source: unknown;
    let hold: unknown;
    try {
      const body: unknown = JSON.parse(await readBody(req));
      ({ state, source, hold } = body as { state?: unknown; source?: unknown; hold?: unknown });
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${errorMessage(err)}` });
      return;
    }
    if (state === undefined) {
      sendJson(res, 400, { error: 'body must contain state' });
      return;
    }
    if (typeof state !== 'string') {
      sendJson(res, 400, { error: 'state must be a string' });
      return;
    }
    if (hold !== undefined && typeof hold !== 'boolean') {
      sendJson(res, 400, { error: 'hold must be a boolean' });
      return;
    }
    // STRICT on this route, and only this route. It is what an automated client uses, so
    // a forgotten prefix must be a 400 rather than a silent grant of human authority
    // (D-41, §4). The convenience routes below are lenient on purpose.
    const parsed = parseSource(source);
    if (!parsed) {
      sendJson(res, 400, { error: 'source must be prefixed auto: or human:' });
      return;
    }
    if (!checkState(res, deps, state)) return;
    await enqueueWrite(() => doWrite(deps, state, parsed, log, hold as boolean | undefined));
    broadcastAndSend(res, deps, hub, ws);
    return;
  }

  // POST /state/{id} - the curl and Shortcuts surface. `source` is optional here.
  const byId = STATE_ID_PATH.exec(path);
  if (byId) {
    const id = decodeURIComponent(byId[1]!);
    if (!checkState(res, deps, id)) return;
    const source = coerceSource(url.searchParams.get('source'));
    const hold = holdFromQuery(url.searchParams.get('hold'));
    await enqueueWrite(() => doWrite(deps, id, source, log, hold));
    broadcastAndSend(res, deps, hub, ws);
    return;
  }

  // POST /on | /off - they no longer NAME a state, they resolve through configuration.
  // "Fall back to the first row" is a bad rule when the first row is ON AIR, so an unset
  // shortcut is a 409 rather than a guess.
  const shortcuts = deps.shortcuts ?? SEED_SHORTCUTS;
  const target = path === '/on' ? shortcuts.on : shortcuts.off;
  if (target === null || target === undefined) {
    sendJson(res, 409, { error: `no shortcut row is configured for ${path}` });
    return;
  }
  if (!checkState(res, deps, target)) return;
  const source = coerceSource(url.searchParams.get('source'));
  const hold = holdFromQuery(url.searchParams.get('hold'));
  await enqueueWrite(() => doWrite(deps, target, source, log, hold));
  broadcastAndSend(res, deps, hub, ws);
}

/**
 * An unknown id is a `400` that LISTS the valid ids - never accept-and-fall-back. A typo
 * that resolved to something would eventually resolve to something calm, and that is the
 * invariant violation this system exists to prevent (D-34).
 */
function checkState(res: ServerResponse, deps: ServerDeps, id: string): boolean {
  const table = deps.store.getTable();
  if (table.has(id)) return true;
  sendJson(res, 400, { error: `unknown state '${id}'`, validStates: table.ids() });
  return false;
}

