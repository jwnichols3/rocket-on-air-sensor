import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp, type App } from '../src/app.js';
import type { LightDriver } from '../src/driver.js';
import { defaultState, UNKNOWN_ID } from '../src/state.js';

class StubDriver implements LightDriver {
  async set(stateId: string): Promise<string> {
    return stateId;
  }
  async read(): Promise<string> {
    return 'unknown';
  }
}

// RFC 6455 section 1.3's worked example key/accept pair - lets tests assert the exact
// accept header without reimplementing the handshake hash themselves.
const FIXED_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const EXPECTED_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

interface WsFrame {
  opcode: number;
  payload: Buffer;
}

interface WsTestClient {
  socket: net.Socket;
  status: number;
  headers: Record<string, string>;
  nextFrame(): Promise<WsFrame>;
  nextJson(): Promise<Record<string, unknown>>;
  sendMasked(opcode: number, payload: Buffer): void;
  close(): void;
}

function maskPayload(payload: Buffer, maskKey: Buffer): Buffer {
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ maskKey[i % 4]!;
  return out;
}

/** Client->server frames must be masked per RFC 6455 - this test client always masks. */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = maskPayload(payload, maskKey);
  const len = payload.length;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    throw new Error('test client does not support frames this large');
  }
  return Buffer.concat([header, maskKey, masked]);
}

async function connectWs(port: number, path = '/events/ws', pipelinedBytes?: Buffer): Promise<WsTestClient> {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const req =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${FIXED_KEY}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`;
  // Concatenated into one write (rather than two) so that, over loopback, any bytes the
  // caller wants pipelined right after the handshake land in the same TCP segment as the
  // request - that's what exercises Node's upgrade 'head' buffer instead of a follow-up
  // 'data' event.
  const reqBuf = Buffer.from(req, 'utf8');
  socket.write(pipelinedBytes && pipelinedBytes.length > 0 ? Buffer.concat([reqBuf, pipelinedBytes]) : reqBuf);

  let buf = Buffer.alloc(0);
  const headerEnd = await new Promise<number>((resolve) => {
    function onData(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        socket.off('data', onData);
        resolve(idx);
      }
    }
    socket.on('data', onData);
  });

  const headerText = buf.subarray(0, headerEnd).toString('utf8');
  buf = buf.subarray(headerEnd + 4);
  const lines = headerText.split('\r\n');
  const status = Number(lines[0]!.split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  const frameQueue: WsFrame[] = [];
  const waiters: Array<(f: WsFrame) => void> = [];

  function tryParse(): void {
    for (;;) {
      if (buf.length < 2) return;
      const byte0 = buf[0]!;
      const byte1 = buf[1]!;
      const opcode = byte0 & 0x0f;
      let len = byte1 & 0x7f;
      let pos = 2;
      if (len === 126) {
        if (buf.length < pos + 2) return;
        len = buf.readUInt16BE(pos);
        pos += 2;
      } else if (len === 127) {
        if (buf.length < pos + 8) return;
        len = Number(buf.readBigUInt64BE(pos));
        pos += 8;
      }
      if (buf.length < pos + len) return;
      const payload = Buffer.from(buf.subarray(pos, pos + len));
      buf = buf.subarray(pos + len);
      const frame: WsFrame = { opcode, payload };
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frameQueue.push(frame);
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    tryParse();
  });
  tryParse(); // header read may have already buffered a full frame

  function nextFrame(): Promise<WsFrame> {
    const queued = frameQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  }

  async function nextJson(): Promise<Record<string, unknown>> {
    const frame = await nextFrame();
    assert.equal(frame.opcode, 0x1, `expected a text frame, got opcode ${frame.opcode}`);
    return JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
  }

  return {
    socket,
    status,
    headers,
    nextFrame,
    nextJson,
    sendMasked(opcode, payload) {
      socket.write(encodeClientFrame(opcode, payload));
    },
    close() {
      socket.destroy();
    },
  };
}

async function bootApp(opts: { token?: string } = {}): Promise<App> {
  const dir = await mkdtemp(join(tmpdir(), 'onair-ws-'));
  const stateFile = join(dir, 'state.json');
  // Seed at `available` so these tests exercise transport and transitions, not the boot
  // default (which is `dnd`, and has its own test in app-boot.test.ts).
  await writeFile(
    stateFile,
    JSON.stringify({ ...defaultState(), state: 'available', intended: 'off', tableVersion: 1 }),
    'utf8',
  );
  return createApp({ stateFile, port: 0, token: opts.token, driver: new StubDriver(), log: () => {} });
}

test('handshake + snapshot: 101, correct accept, first frame is status JSON', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  assert.equal(client.status, 101);
  assert.equal(client.headers['sec-websocket-accept'], EXPECTED_ACCEPT);
  assert.equal(client.headers['upgrade'], 'websocket');

  const snapshot = await client.nextJson();
  assert.equal(snapshot.intended, 'off');
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.confirmed, 'available');
  assert.equal(snapshot.message, null);
  assert.equal(typeof snapshot.ageSeconds, 'number');

  client.close();
  await app.close();
});

test('broadcast on write: POST /on produces a new frame with intended "on"', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  await client.nextJson(); // snapshot

  const framePromise = client.nextJson();
  const res = await fetch(`http://127.0.0.1:${app.port}/on`, { method: 'POST' });
  assert.equal(res.status, 200);
  const frame = await framePromise;
  assert.equal(frame.intended, 'on');

  client.close();
  await app.close();
});

test('ping -> pong: server echoes payload on a pong opcode', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  await client.nextJson(); // snapshot

  client.sendMasked(0x9, Buffer.from('hi', 'utf8'));
  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0x0a);
  assert.equal(frame.payload.toString('utf8'), 'hi');

  client.close();
  await app.close();
});

test('close handling: server replies close and socket ends; app.close() still resolves fast', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  await client.nextJson(); // snapshot

  // 'close' rather than 'end': the server tears the socket down with destroy() after
  // writing the close frame, which may surface as a plain FIN or a reset depending on
  // the OS - 'close' fires either way, 'end' would not on a reset.
  const closePromise = new Promise<void>((resolve) => client.socket.once('close', resolve));
  client.socket.on('error', () => {}); // a reset surfaces as ECONNRESET here; ignore it
  client.sendMasked(0x8, Buffer.alloc(0));
  const frame = await client.nextFrame();
  assert.equal(frame.opcode, 0x08);
  await closePromise;

  const start = Date.now();
  await app.close();
  assert.ok(Date.now() - start < 2000, 'app.close() should resolve promptly after the client closed');
});

test('token gating: upgrade without token 401s; ?token= succeeds', async () => {
  const app = await bootApp({ token: 'sekrit' });

  const unauthed = await connectWs(app.port);
  assert.equal(unauthed.status, 401);

  const authed = await connectWs(app.port, '/events/ws?token=sekrit');
  assert.equal(authed.status, 101);
  const snapshot = await authed.nextJson();
  assert.equal(snapshot.intended, 'off');

  authed.close();
  await app.close();
});

test('shutdown: app.close() resolves while a WS client is connected', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  await client.nextJson(); // snapshot
  await app.close();
  client.close();
});

test('404 on wrong upgrade path', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port, '/nope');
  assert.equal(client.status, 404);
  await app.close();
});

test('SSE parity: PUT /message shows up on the WS stream too', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  await client.nextJson(); // snapshot

  const framePromise = client.nextJson();
  await fetch(`http://127.0.0.1:${app.port}/message`, {
    method: 'PUT',
    body: JSON.stringify({ text: 'HI' }),
  });
  const frame = await framePromise;
  assert.equal(frame.message, 'HI');

  client.close();
  await app.close();
});

test('a ping split across two writes still parses; two frames in one write are both handled', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  await client.nextJson(); // snapshot

  // Split write: the frame header/mask/payload for a masked ping "hi" arrives in two
  // pieces with a gap - the parser must hold the partial frame in its buffer rather than
  // choke on it.
  const pingFrame = encodeClientFrame(0x9, Buffer.from('hi', 'utf8'));
  client.socket.write(pingFrame.subarray(0, 3));
  await sleep(20);
  client.socket.write(pingFrame.subarray(3));
  const pong1 = await client.nextFrame();
  assert.equal(pong1.opcode, 0x0a);
  assert.equal(pong1.payload.toString('utf8'), 'hi');

  // Two complete frames concatenated into a single write - the parser must consume both
  // in one pass, not just the first.
  const frameA = encodeClientFrame(0x9, Buffer.from('a', 'utf8'));
  const frameB = encodeClientFrame(0x9, Buffer.from('b', 'utf8'));
  client.socket.write(Buffer.concat([frameA, frameB]));
  const pongA = await client.nextFrame();
  const pongB = await client.nextFrame();
  assert.equal(pongA.payload.toString('utf8'), 'a');
  assert.equal(pongB.payload.toString('utf8'), 'b');

  client.close();
  await app.close();
});

test('inbound frame declaring an oversized (>64KB) payload destroys the connection', async () => {
  const app = await bootApp();
  const client = await connectWs(app.port);
  await client.nextJson(); // snapshot

  const closePromise = new Promise<void>((resolve) => client.socket.once('close', resolve));
  client.socket.on('error', () => {}); // the abrupt destroy may surface as a reset here

  // A masked binary frame (opcode 0x2) declaring a 128-bit-encoded length of 200,000
  // bytes - well over the 64KB cap. The server must reject this from the length header
  // alone, without waiting for (or requiring) the declared payload to actually arrive.
  const header = Buffer.alloc(2 + 8);
  header[0] = 0x80 | 0x2;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(200_000), 2);
  client.socket.write(header);

  await closePromise;
  await app.close();
});

test('upgrade request missing Sec-WebSocket-Key gets 400 and the socket ends', async () => {
  const app = await bootApp();
  const socket = net.connect(app.port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => {});

  const req =
    `GET /events/ws HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${app.port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`; // no Sec-WebSocket-Key
  socket.write(req);

  const closePromise = new Promise<void>((resolve) => socket.once('close', resolve));
  const status = await new Promise<number>((resolve) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx !== -1) resolve(Number(buf.subarray(0, idx).toString('utf8').split('\r\n')[0]!.split(' ')[1]));
    });
  });
  assert.equal(status, 400);
  await closePromise;

  await app.close();
});

test('a ping pipelined in the same write as the handshake still gets a pong (head bytes)', async () => {
  const app = await bootApp();
  const pingFrame = encodeClientFrame(0x9, Buffer.from('pipe', 'utf8'));
  const client = await connectWs(app.port, '/events/ws', pingFrame);

  const snapshot = await client.nextFrame();
  assert.equal(snapshot.opcode, 0x1);

  const pong = await client.nextFrame();
  assert.equal(pong.opcode, 0x0a);
  assert.equal(pong.payload.toString('utf8'), 'pipe');

  client.close();
  await app.close();
});

test('shutdown does not hang on a half-open peer that never sends its own FIN', async () => {
  const app = await bootApp();

  // allowHalfOpen:true is the key: a normal net.Socket auto-sends its own FIN once it
  // reads EOF (the server's close-frame-then-FIN from closeAll), which is what let the
  // earlier end()-only fix look safe in probes. A half-open client - or a dead/frozen
  // real-world peer that stops responding at the TCP level - never does that, so it's
  // the actual regression case: closeAll()'s socket.end() alone would wait forever for a
  // FIN this socket will never send back.
  const socket = net.connect({ port: app.port, host: '127.0.0.1', allowHalfOpen: true });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => {});

  const req =
    `GET /events/ws HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${app.port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${FIXED_KEY}\r\n` +
    `Sec-WebSocket-Version: 13\r\n\r\n`;
  socket.write(req);

  // Read past the handshake response and the first (snapshot) frame, so the connection
  // is genuinely "up" before we test shutdown - not just stuck mid-handshake.
  let buf = Buffer.alloc(0);
  let headerParsed = false;
  await new Promise<void>((resolve) => {
    function onData(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);
      if (!headerParsed) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        buf = buf.subarray(idx + 4);
        headerParsed = true;
      }
      if (buf.length < 2) return;
      const byte1 = buf[1]!;
      let len = byte1 & 0x7f;
      let pos = 2;
      if (len === 126) {
        if (buf.length < pos + 2) return;
        len = buf.readUInt16BE(pos);
        pos += 2;
      }
      if (buf.length < pos + len) return;
      socket.off('data', onData);
      resolve();
    }
    socket.on('data', onData);
  });

  const outcome = await Promise.race([
    app.close().then(() => 'closed' as const),
    sleep(3000).then(() => 'timeout' as const),
  ]);
  socket.destroy();
  assert.equal(outcome, 'closed', 'app.close() must not hang on a half-open peer at shutdown');
});
