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
