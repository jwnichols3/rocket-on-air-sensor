import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export interface WsBridge {
  handleUpgrade(req: IncomingMessage, socket: Duplex, snapshot: () => unknown, head?: Buffer): void;
  broadcast(data: unknown): void;
  closeAll(): void;
  count(): number;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 64 * 1024;

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function createWsBridge(heartbeatMs = 15_000): WsBridge {
  const clients = new Set<Duplex>();
  const timers = new Map<Duplex, NodeJS.Timeout>();

  function detach(socket: Duplex): void {
    const timer = timers.get(socket);
    if (timer !== undefined) clearInterval(timer);
    timers.delete(socket);
    clients.delete(socket);
  }

  function sendText(socket: Duplex, data: unknown): void {
    socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(data), 'utf8')));
  }

  // Parses as many complete client frames as are buffered, handling close/ping and
  // ignoring everything else; returns the unconsumed remainder. Throws on malformed or
  // oversized frames - callers must catch and destroy the socket, never let this escape
  // the 'data' handler.
  //
  // Deliberately does not enforce the RFC 6455 MUST on client frames being masked: if the
  // mask bit is unset we just use the payload as-is instead of failing the connection. This
  // endpoint is server-push-only (we never act on inbound application data, only ping/close),
  // so accepting a technically-invalid unmasked frame is harmless and one less way for an
  // otherwise-fine client to get disconnected.
  function consumeFrames(socket: Duplex, buf: Buffer): Buffer {
    let remaining: Buffer = buf;
    for (;;) {
      if (remaining.length < 2) return remaining;
      const byte0 = remaining[0]!;
      const byte1 = remaining[1]!;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let len = byte1 & 0x7f;
      let pos = 2;

      if (len === 126) {
        if (remaining.length < pos + 2) return remaining;
        len = remaining.readUInt16BE(pos);
        pos += 2;
      } else if (len === 127) {
        if (remaining.length < pos + 8) return remaining;
        const big = remaining.readBigUInt64BE(pos);
        pos += 8;
        if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('inbound frame too large');
        len = Number(big);
      }
      if (len > MAX_FRAME_BYTES) throw new Error('inbound frame too large');

      let maskKey: Buffer | undefined;
      if (masked) {
        if (remaining.length < pos + 4) return remaining;
        maskKey = remaining.subarray(pos, pos + 4);
        pos += 4;
      }

      if (remaining.length < pos + len) return remaining;
      let payload = remaining.subarray(pos, pos + len);
      if (masked && maskKey) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ maskKey[i % 4]!;
        payload = unmasked;
      }
      remaining = remaining.subarray(pos + len);

      if (opcode === OPCODE_CLOSE) {
        try {
          socket.write(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0)));
        } catch {
          // best effort - socket is going away regardless
        }
        detach(socket);
        socket.destroy();
        return Buffer.alloc(0);
      } else if (opcode === OPCODE_PING) {
        try {
          socket.write(encodeFrame(OPCODE_PONG, payload));
        } catch {
          detach(socket);
        }
      }
      // all other opcodes: ignored, but the loop above already advanced past the frame
    }
  }

  return {
    handleUpgrade(req, socket, snapshot, head) {
      // Attached first, before any write - a socket-level error during the handshake
      // itself (e.g. the peer resetting the connection) must not crash the process for
      // want of an 'error' listener.
      socket.on('error', () => detach(socket));

      const upgradeHeader = req.headers.upgrade;
      const key = req.headers['sec-websocket-key'];
      const isWebSocketUpgrade = typeof upgradeHeader === 'string' && upgradeHeader.toLowerCase() === 'websocket';
      if (!isWebSocketUpgrade || typeof key !== 'string' || key.trim() === '') {
        // end()'s callback fires once the reply is flushed and the writable side is
        // done - only then do we force-destroy, so a slow/lingering peer can't stop the
        // socket from ever closing (a bare end() alone waits for the peer's own FIN,
        // which a half-open or dead peer may never send).
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n', () => socket.destroy());
        return;
      }

      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );

      try {
        sendText(socket, snapshot());
      } catch {
        socket.destroy();
        return;
      }
      clients.add(socket);

      const timer = setInterval(() => {
        try {
          sendText(socket, snapshot());
        } catch {
          detach(socket);
        }
      }, heartbeatMs);
      timer.unref?.();
      timers.set(socket, timer);

      let buf: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          buf = consumeFrames(socket, buf);
        } catch {
          detach(socket);
          socket.destroy();
        }
      });
      socket.on('close', () => detach(socket));

      // Bytes the client pipelined immediately after the handshake request (before we'd
      // even attached the 'data' listener above) arrive via Node's upgrade 'head' buffer
      // instead of a 'data' event - e.g. a ping sent in the same write as the handshake.
      // Seed the parser with them now so nothing is silently dropped.
      if (head && head.length > 0) {
        buf = Buffer.concat([buf, head]);
        try {
          buf = consumeFrames(socket, buf);
        } catch {
          detach(socket);
          socket.destroy();
        }
      }
    },
    broadcast(data) {
      for (const socket of [...clients]) {
        try {
          sendText(socket, data);
        } catch {
          detach(socket);
        }
      }
    },
    closeAll() {
      for (const socket of [...clients]) {
        let destroyed = false;
        const forceDestroy = (): void => {
          if (destroyed) return;
          destroyed = true;
          clearTimeout(fallback);
          socket.destroy();
        };
        // A bare end() only sends our FIN and then waits for the peer's own FIN before
        // the socket fully closes - a half-open client (or one that's just gone dark at
        // shutdown) may never send it, hanging server.close() forever. So: destroy once
        // the close frame is flushed (the common case), and destroy unconditionally
        // after ~1s regardless (covers a jammed send buffer where the callback itself
        // never fires). Whichever runs first cancels the other via `destroyed`.
        const fallback = setTimeout(forceDestroy, 1_000);
        fallback.unref?.();
        try {
          socket.end(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0)), forceDestroy);
        } catch {
          forceDestroy();
        }
        detach(socket);
      }
    },
    count: () => clients.size,
  };
}
