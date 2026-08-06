import type { Server } from 'node:http';
import { NoopDriver, type LightDriver } from './driver.js';
import { loadState, saveState } from './persist.js';
import { createApiServer } from './server.js';
import { createSseHub } from './sse.js';
import { defaultState, StateStore } from './state.js';

export interface AppOptions {
  stateFile: string;
  port: number;
  token?: string;
  driver?: LightDriver;
  log?: (line: string) => void;
}

export interface App {
  port: number;
  store: StateStore;
  close: () => Promise<void>;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const log = opts.log ?? console.log;
  const driver = opts.driver ?? new NoopDriver(log);
  const loaded = await loadState(opts.stateFile);
  const store = new StateStore(loaded ?? defaultState());

  // Invariant: recover after restart - re-apply intended state to the light on boot.
  try {
    store.setConfirmed(await driver.set(store.get().intended === 'on'));
  } catch (err) {
    log(`[onair] boot driver re-apply failed: ${(err as Error).message}`);
    store.setConfirmed('unknown');
  }

  const hub = createSseHub();
  const server: Server = createApiServer({
    store,
    driver,
    persist: (state) => saveState(opts.stateFile, state),
    token: opts.token,
    hub,
    log,
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  log(`[onair] listening on :${port}, state file ${opts.stateFile}`);

  return {
    port,
    store,
    close: () =>
      new Promise((resolve, reject) => {
        hub.closeAll();
        server.closeIdleConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
