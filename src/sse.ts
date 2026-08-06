import type { ServerResponse } from 'node:http';

export interface SseHub {
  attach(res: ServerResponse, snapshot: () => unknown): void;
  broadcast(data: unknown): void;
  closeAll(): void;
  count(): number;
}

function statusEvent(data: unknown): string {
  return `event: status\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseHub(heartbeatMs = 15_000): SseHub {
  const clients = new Set<ServerResponse>();
  const timers = new Map<ServerResponse, NodeJS.Timeout>();

  function detach(res: ServerResponse): void {
    const timer = timers.get(res);
    if (timer !== undefined) clearInterval(timer);
    timers.delete(res);
    clients.delete(res);
  }

  return {
    attach(res, snapshot) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(statusEvent(snapshot()));
      clients.add(res);
      const timer = setInterval(() => {
        try {
          res.write(statusEvent(snapshot()));
        } catch {
          detach(res);
        }
      }, heartbeatMs);
      timer.unref?.();
      timers.set(res, timer);
      res.on('close', () => detach(res));
    },
    broadcast(data) {
      const payload = statusEvent(data);
      for (const res of [...clients]) {
        try {
          res.write(payload);
        } catch {
          detach(res);
        }
      }
    },
    closeAll() {
      for (const res of [...clients]) {
        detach(res);
        res.end();
      }
    },
    count: () => clients.size,
  };
}
