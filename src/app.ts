import type { Server } from 'node:http';
import { NoopDriver, type LightDriver } from './driver.js';
import { EsphomeSelectDriver } from './esphome-driver.js';
import { loadState, saveState } from './persist.js';
import { createApiServer, errorMessage } from './server.js';
import { createSseHub } from './sse.js';
import { defaultState, levelToOnOff, LEVELS, RANK, StateStore } from './state.js';
import { startSupervisor } from './supervise.js';
import { createWsBridge } from './ws.js';

export interface AppOptions {
  stateFile: string;
  port: number;
  token?: string;
  driver?: LightDriver;
  log?: (line: string) => void;
  /** Test seam: overrides for the supervisor's timers. */
  supervise?: { pollMs?: number; reassertMs?: number; decayMs?: number };
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

  // Startup config check. A wrong entity name is a deploy bug and must be loud, so
  // DriverConfigError propagates and stops the service. An unreachable device does not:
  // crash-looping on a dead light is the failure persist.ts was just fixed to avoid.
  if (driver instanceof EsphomeSelectDriver) {
    const options = await driver.verifyOptions();
    if (options !== null) {
      const want = [...LEVELS].sort().join(',');
      if ([...options].sort().join(',') !== want) {
        throw new Error(`device option list ${JSON.stringify(options)} != ${JSON.stringify(LEVELS)}`);
      }
    } else {
      log('[onair] light unreachable at boot; continuing with confirmed=unknown');
    }
  }

  // Invariant: recover after restart - re-apply the level to the light on boot, subject
  // to the ladder rule. A stale file must not push the device DOWN.
  try {
    const cur = await driver.read();
    const want = store.get().level;
    const fresh = store.ageSeconds() <= 90;
    if (cur !== 'unknown' && RANK[want] < RANK[cur] && !fresh) {
      log(`[onair] boot: device says ${cur}, our stale ${want} is lower - adopting the device`);
      // Adopt into `level`, not only `confirmed`. `level` is what every other renderer
      // draws, so adopting halfway leaves the browser page green beside a red panel -
      // the same lie in a different window. Raising is always ladder-legal, and a live
      // device read is fresh evidence of the higher rung.
      store.write(cur, 'device', new Date());
      store.setConfirmed(cur);
    } else {
      store.setConfirmed(await driver.set(want));
    }
  } catch (err) {
    log(`[onair] boot driver re-apply failed: ${errorMessage(err)}`);
    store.setConfirmed('unknown');
  }

  // One write queue, shared by the HTTP routes and the supervisor, so a supervisor
  // re-assert can never race a POST through the driver.
  let writeChain: Promise<void> = Promise.resolve();
  const enqueueWrite = (run: () => Promise<void>): Promise<void> => {
    const next = writeChain.then(run);
    writeChain = next.catch(() => {});
    return next;
  };

  const hub = createSseHub();
  const wsBridge = createWsBridge();
  const server: Server = createApiServer({
    store,
    driver,
    persist: (state) => saveState(opts.stateFile, state),
    enqueueWrite,
    token: opts.token,
    hub,
    ws: wsBridge,
    log,
    stateFile: opts.stateFile,
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : opts.port;
  log(`[onair] listening on :${port}, state file ${opts.stateFile}`);

  const supervisor = startSupervisor({
    store,
    driver,
    enqueue: enqueueWrite,
    log,
    onChange: (s) => {
      const body = { ...s, intended: levelToOnOff(s.level), ageSeconds: store.ageSeconds() };
      hub.broadcast(body);
      wsBridge.broadcast(body);
    },
    ...opts.supervise,
  });

  return {
    port,
    store,
    close: async () => {
      supervisor.stop(); // synchronous: never await an in-flight tick
      hub.closeAll();
      wsBridge.closeAll();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
