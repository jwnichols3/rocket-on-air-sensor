import type { Server } from 'node:http';
import { NoopDriver, type LightDriver } from './driver.js';
import { EsphomeTextDriver } from './esphome-driver.js';
import { loadState, saveState } from './persist.js';
import { createApiServer, errorMessage } from './server.js';
import { createSseHub } from './sse.js';
import { defaultState, StateStore, StateTable, UNKNOWN_ID } from './state.js';
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
  const loaded = await loadState(opts.stateFile, log);
  // The seed table, hardcoded for this ticket. #39 loads it from the config document and
  // hands it to store.setTable().
  const store = new StateStore(loaded ?? defaultState(), new StateTable());

  // Startup config check. A wrong entity name is a deploy bug and must be loud, so
  // DriverConfigError propagates and stops the service. An unreachable device does not:
  // crash-looping on a dead light is the failure persist.ts was just fixed to avoid.
  //
  // It checks that the entity EXISTS and nothing more. The old check also compared the
  // device's compiled option list against LEVELS and refused to start on a mismatch;
  // under `text` there is no such list, by design (D-38), so a firmware/server skew is
  // no longer detectable here. It shows up where it now belongs: as a read-back that
  // does not match, i.e. `confirmed: unknown`.
  if (driver instanceof EsphomeTextDriver) {
    if ((await driver.verifyEntity()) === null) {
      log('[onair] light unreachable at boot; continuing with confirmed=unknown');
    }
  }

  // Invariant: recover after restart - re-apply the state to the light on boot, subject to
  // THE BUSY RULE. A stale file must not push the device from busy to calm.
  try {
    const table = store.getTable();
    const cur = await driver.read();
    const want = store.get().state;
    const stale = store.stale();
    if (cur !== UNKNOWN_ID && table.has(cur) && table.busy(cur) && !table.busy(want) && stale) {
      log(`[onair] boot: device says ${cur}, our stale ${want} is calm - adopting the device`);
      // Adopt into `state`, not only `confirmed`. `state` is what every other renderer
      // draws, so adopting halfway leaves the browser page green beside a red panel - the
      // same lie in a different window. Moving to a busy row is always allowed, and a live
      // device read is fresh evidence.
      store.write(cur, { kind: 'auto', label: 'device', raw: 'auto:device' }, new Date());
      store.setConfirmed(cur);
    } else {
      const got = await driver.set(want);
      store.setConfirmed(table.has(got) ? got : UNKNOWN_ID);
    }
  } catch (err) {
    log(`[onair] boot driver re-apply failed: ${errorMessage(err)}`);
    store.setConfirmed(UNKNOWN_ID);
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
    onChange: () => {
      const body = store.status();
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
