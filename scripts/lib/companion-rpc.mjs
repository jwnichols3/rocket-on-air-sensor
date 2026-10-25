// Companion 5.1 admin RPC, using the same plain JSON WebSocket protocol as its web UI.
// Source contracts: bitfocus/companion v5.1.1, lib/UI/TRPC.ts and router definitions.
export function targetOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('An explicit http(s) Companion origin is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) throw new Error('Target must be an http(s) origin without credentials, path, query or fragment');
  return url.origin;
}

export class CompanionRpc {
  static async connect(target, { timeoutMs = 10_000, WebSocketClass = WebSocket } = {}) {
    const origin = targetOrigin(target);
    const socket = new WebSocketClass(origin.replace(/^http/, 'ws') + '/trpc');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Companion WebSocket connection timed out')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Companion WebSocket connection failed; check target and access')); }, { once: true });
    });
    return new CompanionRpc(socket, timeoutMs);
  }

  constructor(socket, timeoutMs = 10_000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      if (data === 'PING') { socket.send('PONG'); return; }
      let messages;
      try { const parsed = JSON.parse(String(data)); messages = Array.isArray(parsed) ? parsed : [parsed]; }
      catch { this.failAll(new Error('Companion returned malformed RPC data')); return; }
      for (const message of messages) {
        const request = this.pending.get(message.id);
        if (!request) continue;
        if (message.error) {
          const code = message.error.data?.code;
          request.finish(new Error(`Companion rejected ${request.path}${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? ` (${code})` : ''}; check admin access and version`));
        } else if (message.result?.type === 'data' || (message.result && !message.result.type)) {
          request.finish(null, message.result.data);
        } else if (message.result?.type === 'stopped') {
          request.finish(new Error(`Companion ended ${request.path} before a snapshot`));
        }
      }
    });
    socket.addEventListener('error', () => this.failAll(new Error('Companion WebSocket failed')));
    socket.addEventListener('close', () => this.failAll(new Error('Companion WebSocket closed')));
  }

  call(method, path, input, { timeoutMs = this.timeoutMs } = {}) {
    if (!['query', 'subscription', 'mutation'].includes(method)) throw new Error('Invalid RPC method');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (error, data) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (method === 'subscription' && this.socket.readyState === 1) {
          try { this.socket.send(JSON.stringify({ id, method: 'subscription.stop' })); } catch { /* Closing the socket also stops it. */ }
        }
        if (error) reject(error); else resolve(data);
      };
      const timer = setTimeout(() => finish(new Error(`Companion ${path} timed out`)), timeoutMs);
      this.pending.set(id, { finish, path });
      try { this.socket.send(JSON.stringify({ id, method, params: { path, ...(input === undefined ? {} : { input }) } })); }
      catch { finish(new Error(`Could not send Companion ${path}`)); }
    });
  }

  query(path, input, options) { return this.call('query', path, input, options); }
  first(path, input, options) { return this.call('subscription', path, input, options); }
  mutation(path, input, options) { return this.call('mutation', path, input, options); }
  failAll(error) { for (const { finish } of [...this.pending.values()]) finish(error); }
  close() { this.failAll(new Error('Companion client closed')); this.socket.close(); }
}

export async function readConnection(rpc, connectionId) {
  if (typeof connectionId !== 'string' || !connectionId.trim()) throw new Error('An explicit connection ID is required');
  const updates = await rpc.first('instances.connections.watch');
  const initial = Array.isArray(updates) ? updates.find((entry) => entry.type === 'init') : null;
  const connection = initial?.info?.[connectionId];
  if (!connection) throw new Error('The requested Companion connection was not found');
  if (connection.moduleId !== 'rocket-onair') throw new Error('The requested connection is not the rocket-onair module');
  return connection;
}

export async function readRuntime(rpc, connection) {
  const [snapshot, values] = await Promise.all([
    rpc.first('instances.statuses.watch'),
    rpc.query('variables.values.connection', { label: connection.label }),
  ]);
  const status = snapshot?.type === 'init' ? snapshot.statuses?.[connection.id] : undefined;
  return { status, values: values ?? {} };
}

export function parseLocation(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*\/\d+\/\d+$/.test(value)) throw new Error('Control locations use page/row/column, with page starting at 1');
  const [pageNumber, row, column] = value.split('/').map(Number);
  if (![pageNumber, row, column].every(Number.isSafeInteger)) throw new Error('Control location is too large');
  return { pageNumber, row, column };
}

export async function readControls(rpc, locations) {
  if (!locations.length) return [];
  const parsed = locations.map(parseLocation);
  const pages = await rpc.first('pages.watch');
  if (pages?.type !== 'init' || !Array.isArray(pages.order)) throw new Error('Companion pages snapshot is unsupported');
  const controls = [];
  for (const location of parsed) {
    const pageId = pages.order[location.pageNumber - 1];
    const page = pages.pages?.[pageId];
    const controlId = page?.controls?.[location.row]?.[location.column];
    if (!controlId) throw new Error(`No control exists at ${location.pageNumber}/${location.row}/${location.column}`);
    const control = await rpc.first('controls.watchControl', { controlId });
    if (control?.type !== 'init' || !control.config) throw new Error('Companion control snapshot is unsupported');
    controls.push({ location, pageId, controlId, config: control.config, runtime: control.runtime });
  }
  return controls;
}
