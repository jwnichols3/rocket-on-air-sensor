import type { ServerResponse } from 'node:http';

export interface SseHub {
  attach(res: ServerResponse, snapshot: () => unknown): void;
  /**
   * Push the CURRENT status to every client, each rendered by its own snapshot.
   *
   * It takes no payload on purpose (#88). It used to take one, and one body written to
   * every client meant a single hub serving two audiences sent the GATED body to the
   * unauthenticated `/public/events` on every state change: `source`, `confirmed`,
   * `updatedAt` and `intended` to any LAN client, and - because that body has no
   * `label`/`color`/`bgcolor` - a wall panel that fell back to the raw state id in the
   * reserved row's colours until the next 15s heartbeat repainted it.
   *
   * The heartbeat was always per-connection and always correct. Broadcast is now the same
   * mechanism, so the two cannot drift again: there is no longer a body for a caller to
   * get wrong.
   */
  broadcast(): void;
  closeAll(): void;
  count(): number;
}

function statusEvent(data: unknown): string {
  return `event: status\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseHub(heartbeatMs = 15_000): SseHub {
  // The snapshot is the client's AUDIENCE, not a cached value: `/events` attaches with the
  // gated body and `/public/events` with the public one, and holding the function is what
  // lets every write to that client be rendered for the right one.
  const clients = new Map<ServerResponse, () => unknown>();
  const timers = new Map<ServerResponse, NodeJS.Timeout>();

  function detach(res: ServerResponse): void {
    const timer = timers.get(res);
    if (timer !== undefined) clearInterval(timer);
    timers.delete(res);
    clients.delete(res);
  }

  /** Write to one client, detaching it if the socket is gone. */
  function send(res: ServerResponse, snapshot: () => unknown): void {
    try {
      res.write(statusEvent(snapshot()));
    } catch {
      detach(res);
    }
  }

  return {
    attach(res, snapshot) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(statusEvent(snapshot()));
      clients.set(res, snapshot);
      const timer = setInterval(() => send(res, snapshot), heartbeatMs);
      timer.unref?.();
      timers.set(res, timer);
      res.on('close', () => detach(res));
    },
    broadcast() {
      for (const [res, snapshot] of [...clients]) send(res, snapshot);
    },
    closeAll() {
      for (const res of [...clients.keys()]) {
        detach(res);
        res.end();
      }
    },
    count: () => clients.size,
  };
}
