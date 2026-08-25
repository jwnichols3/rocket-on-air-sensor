import { timingSafeEqual } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import type { LightDriver } from './driver.js';
import { DISPLAY_HTML } from './display.js';
import { createSseHub, type SseHub } from './sse.js';
import {
  isLevel,
  levelToOnOff,
  onAirToLevel,
  LEVELS,
  type Confirmed,
  type Level,
  type OnAirState,
  type OnOff,
  type PersistedState,
  type StateStore,
} from './state.js';
import { UI_HTML } from './ui.js';
import { createWsBridge, type WsBridge } from './ws.js';

export interface ServerDeps {
  store: StateStore;
  driver: LightDriver;
  persist: (state: PersistedState) => Promise<void>;
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
}

const ROUTES: Record<string, string[]> = {
  '/status': ['GET'],
  '/state': ['PUT'],
  '/on': ['POST'],
  '/off': ['POST'],
  '/available': ['POST'],
  '/interruptible': ['POST'],
  '/dnd': ['POST'],
  '/message': ['PUT', 'DELETE'],
  '/events': ['GET'],
  '/display': ['GET'],
  '/ui': ['GET'],
  '/admin/health': ['GET'],
  '/admin/restart': ['POST'],
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

function statusBody(deps: ServerDeps): OnAirState & { intended: OnOff; ageSeconds: number } {
  const s = deps.store.get();
  // `intended` is computed at serialisation, so it can never drift from `level`.
  return { ...s, intended: levelToOnOff(s.level), ageSeconds: deps.store.ageSeconds() };
}

function persistCurrent(deps: ServerDeps): Promise<void> {
  const s = deps.store.get();
  // Typed, never cast: `intended` is rollback insurance, and a cast here would let a
  // future refactor delete it with no type error and no failing test.
  // Invariant: persisted confirmed is always "unknown" - the live value is memory-only.
  const out: PersistedState = { ...s, intended: levelToOnOff(s.level), confirmed: 'unknown' };
  return deps.persist(out);
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
  level: Level,
  source: string,
  log: (line: string) => void,
  hold?: boolean,
): Promise<void> {
  // write() may clamp a detector request UP to the hold floor, so the level we drive
  // onto the light is the one the store settled on, never the one that was requested.
  const applied = deps.store.write(level, source, new Date(), hold).level;
  await persistCurrent(deps);
  let confirmed: Confirmed;
  try {
    confirmed = await deps.driver.set(applied);
  } catch (err) {
    log(`[onair] driver.set(${applied}) failed: ${errorMessage(err)}`);
    confirmed = 'unknown';
  }
  deps.store.setConfirmed(confirmed);
}

const PATH_LEVEL: Record<string, Level> = {
  '/on': 'dnd',
  '/off': 'available',
  '/dnd': 'dnd',
  '/interruptible': 'interruptible',
  '/available': 'available',
};

/** `?hold=1|true` pins the floor, `?hold=0|false` releases it, absent leaves it alone. */
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
    let level: unknown;
    let onAir: unknown;
    let source: unknown;
    let hold: unknown;
    try {
      const body: unknown = JSON.parse(await readBody(req));
      ({ level, onAir, source, hold } = body as {
        level?: unknown;
        onAir?: unknown;
        source?: unknown;
        hold?: unknown;
      });
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${errorMessage(err)}` });
      return;
    }
    if (source !== undefined && typeof source !== 'string') {
      sendJson(res, 400, { error: 'source must be a string' });
      return;
    }
    if (hold !== undefined && typeof hold !== 'boolean') {
      sendJson(res, 400, { error: 'hold must be a boolean' });
      return;
    }

    let target: Level;
    if (level !== undefined) {
      if (!isLevel(level)) {
        sendJson(res, 400, { error: `level must be one of ${LEVELS.join(', ')}` });
        return;
      }
      if (onAir !== undefined) {
        if (typeof onAir !== 'boolean') {
          sendJson(res, 400, { error: 'onAir must be a boolean' });
          return;
        }
        // Never silently pick one. A client sending both and meaning different things
        // has a bug, and guessing which half to believe is how a false green ships.
        if (levelToOnOff(level) !== (onAir ? 'on' : 'off')) {
          sendJson(res, 400, { error: 'level and onAir disagree' });
          return;
        }
      }
      target = level;
    } else if (typeof onAir === 'boolean') {
      target = onAirToLevel(onAir);
    } else {
      sendJson(res, 400, { error: 'body must contain level or onAir' });
      return;
    }

    if (!checkHold(res, target, hold as boolean | undefined)) return;
    await enqueueWrite(() => doWrite(deps, target, source ?? 'manual', log, hold as boolean | undefined));
    broadcastAndSend(res, deps, hub, ws);
    return;
  }

  // POST /on | /off | /available | /interruptible | /dnd
  const target = PATH_LEVEL[path]!;
  const hold = holdFromQuery(url.searchParams.get('hold'));
  if (!checkHold(res, target, hold)) return;
  await enqueueWrite(() => doWrite(deps, target, url.searchParams.get('source') ?? 'manual', log, hold));
  broadcastAndSend(res, deps, hub, ws);
}

/**
 * A floor at the bottom rung is either a no-op or, read the other way, a lever for
 * forcing green against the detector. Reject it rather than quietly ignoring it.
 */
function checkHold(res: ServerResponse, level: Level, hold: boolean | undefined): boolean {
  if (hold === true && level === 'available') {
    sendJson(res, 400, { error: 'hold cannot be set at available: a floor at the bottom rung is not a hold' });
    return false;
  }
  return true;
}
