import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import {
  changeMeNags,
  defaultAuth,
  passphraseAccepted,
  presentedCredential,
  SessionStore,
  timingSafeStringEqual,
  waiverApplies,
} from './auth.js';
import { envOverrides, effectiveLight } from './config.js';
import { validateConfig, type OnAirConfig } from './config-store.js';
import type { LightDriver } from './driver.js';
import { DISPLAY_HTML } from './display.js';
import { DOCS_HTML } from './docs-page.js';
import { escapeHtml, repairHtml } from './repair.js';
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
  /** Which rows `/on` and `/off` resolve to. Falls back to the seed when no config is loaded. */
  shortcuts?: Shortcuts;
  /** The live config document, and the one way to replace it. Supplied by app.ts. */
  config?: () => OnAirConfig;
  /**
   * Apply a validated config: persist it, swap the table in, rebind if the port or bind
   * mode moved. Resolves with an error message when the rebind failed and rolled back.
   */
  applyConfig?: (next: OnAirConfig) => Promise<{ ok: true } | { ok: false; status: 409 | 507; error: string }>;
  /** Set when the config file on disk could not be used, so the repair view is served. */
  configProblem?: () => { errors: string[]; raw: string } | undefined;
  /** Admin sessions. Shared across every listener, so which address you arrived on is invisible. */
  sessions?: SessionStore;
  /** Wipe everything back to shipped defaults. Supplied by app.ts. */
  factoryReset?: () => Promise<void>;
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
  '/docs': ['GET'],
  '/admin/health': ['GET'],
  '/admin/restart': ['POST'],
  '/config/states': ['GET'],
  '/admin/config': ['GET', 'PUT'],
  '/admin/repair': ['GET'],
  '/admin/session': ['POST', 'DELETE'],
  '/admin/factory-reset': ['POST'],
  '/public/status': ['GET'],
  '/public/events': ['GET'],
  '/': ['GET'],
  '/admin': ['GET'],
};

/**
 * The admin console's bundle, built by `npm run build -w admin-ui`.
 *
 * Read from disk on every request rather than cached at startup, deliberately: `onair
 * update` rebuilds it in place, and a cached copy would leave the running service serving
 * the previous console until someone restarted it - with no symptom except that a fix did
 * not appear. It is one file and a handful of requests a day.
 */
const ADMIN_BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin', 'index.html');

function serveAdminBundle(res: ServerResponse): void {
  let html: string;
  try {
    html = readFileSync(ADMIN_BUNDLE, 'utf8');
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('the admin console has not been built - run: npm run build -w admin-ui\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
}

/**
 * Which credential a route wants. **Neither is ever accepted on the other's routes**
 * (D-35): the passphrase says "you may read and write state", the admin session says "you
 * may reconfigure the system, including rotating the passphrase". Two different questions.
 */
function audienceFor(path: string): 'data' | 'admin' | 'public' {
  if (path === '/public/status' || path === '/public/events' || path === '/display') return 'public';
  // The client guide. Unauthenticated because it carries no credential and no configuration -
  // it is the repo's own markdown, and a 401 on the page that explains how to authenticate is
  // a door locked with the key inside.
  if (path === '/docs') return 'public';
  // The console's SHELL is unauthenticated and byte-identical for everyone; every value it
  // renders comes from a gated route (D-35). `/admin` exactly - not `/admin/` - so it does
  // not fall into the gated prefix below.
  if (path === '/' || path === '/admin') return 'public';
  // `/admin/session` is where you GO to get an admin credential, so it cannot demand one.
  if (path === '/admin/session') return 'public';
  if (path.startsWith('/admin/')) return 'admin';
  return 'data';
}
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

    // The WS upgrade cannot carry an Authorization header from a browser, which is why
    // `?passphrase=` exists at all - see presentedCredential.
    if (authorize(req, url, deps, boundPort(server), 'data')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n', () => socket.destroy());
      return;
    }

    ws.handleUpgrade(req, socket, () => statusBody(deps), head);
  });

  return server;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The auth block in force. Falls back to the shipped defaults when no config store is
 * wired up, which is what the older unit tests construct.
 */
function authOf(deps: ServerDeps) {
  return deps.config?.().auth ?? defaultAuth();
}

/**
 * May this request proceed? Returns null when it may, or the error to send.
 *
 * The order matters: the WAIVER is checked first, because at home it is what makes both
 * credentials invisible, and it is a strictly narrower condition than either of them.
 */
function authorize(
  req: IncomingMessage,
  url: URL,
  deps: ServerDeps,
  ourPort: number,
  audience: 'data' | 'admin' | 'public',
): { status: 401; error: string } | null {
  if (audience === 'public') return null;

  // The deployment seam: a service started with an explicit token gates on that alone.
  // This is what keeps the older tests, and any host still driven by ONAIR_TOKEN, working.
  if (deps.config === undefined) {
    if (deps.token === undefined) return null;
    const presented = presentedCredential(req, url);
    if (presented !== null && timingSafeStringEqual(presented, deps.token)) return null;
    return { status: 401, error: 'missing or invalid bearer token' };
  }

  if (waiverApplies(req, ourPort)) return null;

  const presented = presentedCredential(req, url);
  if (audience === 'data') {
    if (presented !== null && passphraseAccepted(authOf(deps), presented)) return null;
    return { status: 401, error: 'missing or invalid passphrase' };
  }
  // Admin. ONLY a session token - the passphrase is not accepted here, and vice versa.
  if (presented !== null && deps.sessions?.validate(presented)) return null;
  return { status: 401, error: 'missing or invalid admin session' };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body)}\n`);
}

/** Is this a browser asking for a page, rather than a client asking for data? */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * The 401 a person sees, as opposed to the one a program sees.
 *
 * SAYS NOTHING THE JSON DOES NOT. It does not name which credential was missing, does not
 * echo what was presented, and reads identically whether the caller got the audience wrong
 * or had no credential at all - D-35's two audiences stay indistinguishable to an
 * unauthenticated caller, and this page is not the place to start leaking that.
 *
 * What it adds is the thing the JSON cannot: where to go. The D-24 waiver makes this
 * invisible from the machine itself, which is exactly why it went unnoticed for so long -
 * the only person who ever sees a 401 in a browser is someone on another machine, i.e. the
 * one with the least context.
 */
function unauthorizedPage(error: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>On-Air - 401</title>
<style>body{margin:0;padding:2rem;background:#0f1113;color:#e8eaed;
font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:34rem;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .3rem}p{color:#aab4bd}code{font-family:ui-monospace,Menlo,monospace}
a{color:#8fd6a3}</style></head><body><main>
<h1>401 &mdash; ${escapeHtml(error)}</h1>
<p>This route needs a credential. Nothing here says which one you are missing, on purpose.</p>
<p>The admin console is at <a href="/">/</a> and signs you in with the admin password.
The public display at <a href="/display">/display</a> needs nothing.</p>
<p>Machine clients send the passphrase as <code>Authorization: Bearer &lt;passphrase&gt;</code>.
Requests from the machine running the service are waived and need neither.</p>
</main></body></html>
`;
}

// Every derived field - `busy`, `intended`, `ageSeconds`, `tableVersion` - is
// computed at serialisation, so none of them can drift from `state`. Presentation
// (`label`, `color`, `bgcolor`) is deliberately NOT here: it travels with the profile
// (D-42), and putting it on a payload written many times an hour would weld configuration
// into the state protocol permanently.
function statusBody(deps: ServerDeps): StatusBody {
  return deps.store.status();
}

/**
 * The unauthenticated view: the current row already RESOLVED for rendering. It is not the
 * state contract and no machine client should read it - it has no `source`, no `confirmed`,
 * and it is free to change shape to suit the two pages it serves.
 */
function publicBody(deps: ServerDeps): Record<string, unknown> {
  const s = deps.store.status();
  const table = deps.store.getTable();
  // A state with no row resolves to the RESERVED row's look, not to a hardcoded colour:
  // `unknown` cannot be deleted (D-34) and the owner may have restyled it, so borrowing it
  // is both always possible and always what they chose to mean "something is wrong".
  const row = table.row(s.state) ?? table.row(UNKNOWN_ID)!;
  return {
    state: s.state,
    label: row.label,
    color: row.color,
    bgcolor: row.bgcolor,
    busy: s.busy,
    // D-9: a message may never replace or obscure the state word, but /display is served
    // unauthenticated and therefore cannot read the gated stream - so it has to arrive
    // here. It discloses nothing the panel on the wall does not already show.
    message: s.message,
    ageSeconds: s.ageSeconds,
    tableVersion: s.tableVersion,
  };
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
): Promise<void> {
  const applied = deps.store.write(stateId, source, new Date()).state;
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
  // D-42's version nudge, on the path that already writes to the device. A no-op unless
  // the version moved, and never a reason for the write to fail - the write already
  // succeeded, and a device that missed the nudge re-pulls on its own interval.
  try {
    await deps.driver.setTableVersion?.(deps.store.getTable().version);
  } catch (err) {
    log(`[onair] version nudge failed: ${errorMessage(err)}`);
  }
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

  const denied = authorize(req, url, deps, boundPort(server), audienceFor(path));
  if (denied) {
    // Same status, same information, different medium. A client that did not ask for HTML
    // - which is every existing one, and every test - gets the JSON body byte for byte.
    if (wantsHtml(req)) {
      res.writeHead(denied.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(unauthorizedPage(denied.error));
      return;
    }
    sendJson(res, denied.status, { error: denied.error });
    return;
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
  const willReadBody =
    ((path === '/state' || path === '/message') && method === 'PUT') ||
    (path === '/admin/config' && method === 'PUT') ||
    (path === '/admin/session' && method === 'POST') ||
    path === '/admin/factory-reset';
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

  // The state table, for renderers and for Companion preset generation. Self-describing,
  // so a client asks what states exist rather than being compiled with them.
  if (path === '/config/states') {
    const table = deps.store.getTable();
    const etag = `"${table.version}"`;
    // The ESP32 polls this every 300s. `If-None-Match` makes the steady state a 304, which
    // is the difference between a poll that costs a header and one that costs a table.
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag, 'cache-control': 'no-cache' });
    res.end(`${JSON.stringify({ version: table.version, updatedAt: deps.store.get().updatedAt, states: table.rows() })}\n`);
    return;
  }

  // ---- the two unauthenticated endpoints (D-35, §5) -------------------------------
  //
  // Deliberately THIN, and a rendering VIEW of the state rather than the state contract:
  // no passphrase, no config, no source, no device detail. They exist because
  // /display and the landing page are served unauthenticated and therefore cannot read the
  // gated stream - and because colour lives in the table now, so the server has to resolve
  // the row for a page that holds none. A renderer that DOES hold a table must not use
  // these; it takes the key from the gated routes and the look from GET /config/states.
  if (path === '/public/status') {
    sendJson(res, 200, publicBody(deps));
    return;
  }
  if (path === '/public/events') {
    hub.attach(res, () => publicBody(deps));
    return;
  }

  if (path === '/admin/session') {
    if (method === 'DELETE') {
      const presented = presentedCredential(req, url);
      if (presented) deps.sessions?.destroy(presented);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (deps.sessions === undefined) {
      sendJson(res, 501, { error: 'no session store is wired up' });
      return;
    }
    // Either nothing (the waiver applies) or {user, password}. At home the SPA
    // re-establishes silently on every page load, which is what pays for having no cookie.
    let user: unknown;
    let password: unknown;
    const raw = await readBody(req);
    if (raw.trim() !== '') {
      try {
        ({ user, password } = JSON.parse(raw) as { user?: unknown; password?: unknown });
      } catch (err) {
        sendJson(res, 400, { error: `malformed JSON body: ${errorMessage(err)}` });
        return;
      }
    }
    const auth = authOf(deps);
    const byWaiver = raw.trim() === '' && waiverApplies(req, boundPort(server));
    const byPassword =
      typeof user === 'string' &&
      typeof password === 'string' &&
      timingSafeStringEqual(user, auth.adminUser) &&
      timingSafeStringEqual(password, auth.adminPassword);
    if (!byWaiver && !byPassword) {
      sendJson(res, 401, { error: 'admin login failed' });
      return;
    }
    const session = deps.sessions.create();
    sendJson(res, 200, { ...session, via: byWaiver ? 'waiver' : 'password', nags: changeMeNags(auth) });
    return;
  }

  if (path === '/admin/factory-reset') {
    if (deps.factoryReset === undefined) {
      sendJson(res, 501, { error: 'no config store is wired up' });
      return;
    }
    // THE ONE CARVE-OUT (D-35): the admin password is always required here, from any
    // origin, INCLUDING loopback. Everything else an admin session can do is recoverable;
    // a factory reset on a box across the house is the lockout path, and one password
    // prompt in its lifetime is a fair price. Revealing the passphrase is deliberately NOT
    // carved out - Rocket has to read it to type it into the ESP32 and Companion.
    let password: unknown;
    try {
      ({ password } = JSON.parse(await readBody(req)) as { password?: unknown });
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${errorMessage(err)}` });
      return;
    }
    if (typeof password !== 'string' || !timingSafeStringEqual(password, authOf(deps).adminPassword)) {
      sendJson(res, 403, { error: 'factory reset requires the admin password, from any origin' });
      return;
    }
    await deps.factoryReset();
    deps.sessions?.destroyAll();
    sendJson(res, 200, { ok: true, config: deps.config?.() });
    return;
  }

  // Served ONLY while the config on disk is unusable. A 404 the rest of the time is the
  // honest answer: there is nothing to repair.
  if (path === '/admin/repair') {
    const p = deps.configProblem?.();
    if (p === undefined) {
      sendJson(res, 404, { error: 'nothing to repair: the config loaded cleanly' });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(repairHtml(p));
    return;
  }

  if (path === '/admin/config') {
    if (deps.config === undefined || deps.applyConfig === undefined) {
      sendJson(res, 501, { error: 'no config store is wired up' });
      return;
    }
    if (method === 'GET') {
      // `env` tells the console which fields it must NOT present as authoritative, and what
      // the service is actually driving. Names of the overriding variables, never their
      // values (D-79). `lightHost` is the resolved address and is not a secret - it is a LAN
      // address, and the document beside it in this same response already carries one.
      const cfg = deps.config();
      const eff = effectiveLight(cfg.light);
      sendJson(res, 200, {
        config: cfg,
        problem: deps.configProblem?.(),
        env: {
          overrides: envOverrides(),
          // The EFFECTIVE non-credential values, so an overridden field shows what is
          // actually in force rather than an empty box that reads as "not configured".
          // `username` and `password` are deliberately absent: they are a device credential,
          // and a field that says "Set by ONAIR_LIGHT_PASS" already tells you where to look.
          effective: { host: eff.host, entity: eff.entity },
        },
      });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { error: `malformed JSON body: ${errorMessage(err)}` });
      return;
    }
    const validated = validateConfig(body);
    if (!validated.ok) {
      sendJson(res, 400, { error: 'invalid config', problems: validated.errors });
      return;
    }
    // OPTIMISTIC CONCURRENCY. The submitted document carries the version it was based on;
    // if the live one has moved since, the save is refused with the current document so the
    // UI can show what changed underneath rather than silently overwriting it.
    const live = deps.config();
    if (validated.config.version !== live.version) {
      sendJson(res, 409, {
        error: `config has changed underneath you (yours ${validated.config.version}, current ${live.version})`,
        config: live,
      });
      return;
    }
    const applied = await deps.applyConfig({ ...validated.config, version: live.version + 1 });
    if (!applied.ok) {
      sendJson(res, applied.status, { error: applied.error, config: deps.config() });
      return;
    }
    sendJson(res, 200, { config: deps.config() });
    return;
  }

  if (path === '/events') {
    hub.attach(res, () => statusBody(deps));
    return;
  }

  if (path === '/' || path === '/admin') {
    serveAdminBundle(res);
    return;
  }

  if (path === '/display') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DISPLAY_HTML);
    return;
  }

  // GENERATED from docs/client-api-guide.md - see server/tools/gen-docs.mjs. Static, so it
  // costs a string write and discloses nothing a caller could not read in the repo.
  if (path === '/docs') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DOCS_HTML);
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
    try {
      const body: unknown = JSON.parse(await readBody(req));
      ({ state, source } = body as { state?: unknown; source?: unknown });
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
    // `hold` used to be read here and a non-boolean was a `400`. Retired (D-126), and
    // deliberately NOT replaced by a "hold is retired" rejection: VCREC is external (D-30)
    // and cannot be edited in lockstep, and a rejected body means the state write is
    // DISCARDED - a false OFF manufactured by a field name. A retired rider must never veto
    // a state assertion, so `hold` now joins every other unknown key and is ignored.

    // STRICT on this route, and only this route. It is what an automated client uses, so a
    // forgotten prefix must be a 400 rather than a silent relabelling as `human:anonymous`.
    // There is no authority to grant any more (D-126) - the reason is provenance: `source` is
    // the detector's only trace (D-30) and a writer nobody can tell from a human is a writer
    // nobody can debug. The convenience routes below are lenient on purpose (D-41, §4).
    const parsed = parseSource(source);
    if (!parsed) {
      sendJson(res, 400, { error: 'source must be prefixed auto: or human:' });
      return;
    }
    if (!checkState(res, deps, state)) return;
    await enqueueWrite(() => doWrite(deps, state, parsed, log));
    broadcastAndSend(res, deps, hub, ws);
    return;
  }

  // POST /state/{id} - the curl and Shortcuts surface. `source` is optional here.
  const byId = STATE_ID_PATH.exec(path);
  if (byId) {
    const id = decodeURIComponent(byId[1]!);
    if (!checkState(res, deps, id)) return;
    const source = coerceSource(url.searchParams.get('source'));
    // `?hold=` is read by nothing now (D-126). Ignored rather than rejected, for the reason
    // spelled out on `PUT /state` above - and doubly so here, because this is the surface a
    // phone Shortcut reaches, where a refusal would leave the light asserting ON AIR after
    // the human already said they were done.
    await enqueueWrite(() => doWrite(deps, id, source, log));
    broadcastAndSend(res, deps, hub, ws);
    return;
  }

  // POST /on | /off - they no longer NAME a state, they resolve through configuration.
  // "Fall back to the first row" is a bad rule when the first row is ON AIR, so an unset
  // shortcut is a 409 rather than a guess.
  const shortcuts = deps.config?.().shortcuts ?? deps.shortcuts ?? SEED_SHORTCUTS;
  const target = path === '/on' ? shortcuts.on : shortcuts.off;
  if (target === null || target === undefined) {
    sendJson(res, 409, { error: `no shortcut row is configured for ${path}` });
    return;
  }
  if (!checkState(res, deps, target)) return;
  const source = coerceSource(url.searchParams.get('source'));
  await enqueueWrite(() => doWrite(deps, target, source, log));
  broadcastAndSend(res, deps, hub, ws);
}

/**
 * THE PIN RULE stood at the door here, as `PIN_SOURCE` and `refuseWrite` - the settle-back
 * that drove the light to the held row and answered `403`/`409` with the status body merged
 * into the error. Retired with the rule itself (D-126). LAST WRITE WINS: a state route can
 * no longer refuse a write, so there is nothing to settle back to and no `human:hold` source
 * to write it under.
 *
 * Two consequences worth stating rather than leaving to be rediscovered. No state route
 * answers `403` any more - `403` is admin-only: factory reset without the admin password, and
 * restart, which gates on a `ServerDeps.token` that `app.ts` never supplies and is therefore
 * unconditional in the shipped service. And no 4xx body anywhere in this server carries state
 * fields now: this was the only place that merged one in, so every error body is `{error}`
 * plus at most one of three context fields - `validStates` on an unknown state id, `problems`
 * on a config document that failed validation, or the live `config` on a refused save.
 */

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

