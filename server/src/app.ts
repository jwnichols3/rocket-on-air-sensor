import type { Server } from 'node:http';
import {
  ConfigWriteError,
  defaultConfig,
  loadConfigFile,
  resolveBind,
  saveConfigFile,
  type OnAirConfig,
} from './config-store.js';
import { rotate, SessionStore } from './auth.js';
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
  /** Where the config document lives. Omitted in tests that do not exercise config. */
  configFile?: string;
  /** Overrides the config's port. The real environment still wins over the file (D-14). */
  port?: number;
  /**
   * `ONAIR_PASSPHRASE` (or the deprecated `ONAIR_TOKEN`) from the real environment. It
   * OVERRIDES the document's passphrase rather than gating separately - D-14's rule, and
   * the break-glass path for a box you can only reach over SSH.
   */
  token?: string;
  driver?: LightDriver;
  /** Built from the config's `light` block when not supplied. */
  makeDriver?: (config: OnAirConfig) => LightDriver | undefined;
  /**
   * Applied to the defaults when there is no config file yet, and then written out. This
   * is how `config.env`'s values become the document on an upgrading host - after which
   * the env file is only an overlay, which is what D-36 retired it to.
   */
  seedConfig?: (base: OnAirConfig) => OnAirConfig;
  log?: (line: string) => void;
  /** Test seam: overrides for the supervisor's timers. */
  supervise?: { pollMs?: number; reassertMs?: number; decayMs?: number };
}

export interface App {
  port: number;
  store: StateStore;
  /** Writes and supervisor ticks waiting on the shared queue. See #68. */
  writeQueueDepth: () => number;
  config: () => OnAirConfig;
  sessions: SessionStore;
  close: () => Promise<void>;
}

/**
 * Open one listener per address. Node's `Server` listens once, so N addresses on one port
 * is N `Server` objects sharing one set of handlers (measured working, #22). They share the
 * store, the write queue, the SSE hub and the WS bridge, so which listener a request
 * arrived on is invisible above this line.
 */
async function listenAll(
  make: () => Server,
  addresses: string[],
  port: number,
): Promise<{ servers: Server[]; port: number }> {
  const servers: Server[] = [];
  try {
    let bound = port;
    for (const address of addresses) {
      const server = make();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bound, address, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      // Port 0 means "any free port" - resolve it on the first listener so the rest land
      // on the SAME port rather than each getting its own.
      if (typeof addr === 'object' && addr !== null) bound = addr.port;
      servers.push(server);
    }
    return { servers, port: bound };
  } catch (err) {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    throw err;
  }
}

async function closeAll(servers: Server[]): Promise<void> {
  for (const s of servers) s.closeIdleConnections();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
}

/**
 * Stop accepting new connections, and DO NOT wait for in-flight requests to finish.
 *
 * This is not an optimisation, it is a deadlock fix. A rebind is triggered by a request,
 * and that request is itself one of the in-flight connections: awaiting the close means
 * `close()` waits for the response to be sent, while the response waits for `close()` to
 * return. The listening socket shuts immediately either way, which is all the rebind
 * actually needs - the new listener can take the port at once.
 *
 * The old sockets are swept a moment later, by which time our own response has flushed.
 * Anything still attached then is a keep-alive client, and it will reconnect to the new
 * listener on its next request.
 */
function stopAccepting(servers: Server[]): void {
  for (const s of servers) {
    s.close();
    s.closeIdleConnections();
  }
  setTimeout(() => {
    for (const s of servers) {
      s.closeIdleConnections();
      s.closeAllConnections();
    }
  }, 1000).unref();
}

export async function createApp(opts: AppOptions): Promise<App> {
  const log = opts.log ?? console.log;
  /** A real environment variable always wins over the file - D-14's rule, and the SSH escape hatch. */
  const effectivePort = (c: OnAirConfig): number => opts.port ?? c.port;

  // --- config: a broken file NEVER stops the service (D-36) ---------------------------
  const loaded = opts.configFile
    ? await loadConfigFile(opts.configFile)
    : { config: defaultConfig(), fromDisk: true, problem: undefined };
  let config = loaded.config;
  let problem = loaded.problem;

  // First boot: write the document out. A config file that does not exist until you use a
  // UI is not "hand-editable over SSH with no UI" (D-36) - there has to be a file to edit.
  // A file that failed to LOAD is never overwritten here; that is what the repair view is
  // for, and clobbering it would destroy the thing the owner needs to read.
  if (opts.configFile && !problem && !loaded.fromDisk) {
    config = opts.seedConfig ? opts.seedConfig(config) : config;
    try {
      await saveConfigFile(opts.configFile, config);
      log(`[onair] wrote a starting config to ${opts.configFile}`);
    } catch (err) {
      // Not fatal: the service runs on the in-memory document either way.
      log(`[onair] could not write a starting config: ${errorMessage(err)}`);
    }
  }
  // The env credential wins over the file, and is folded in here so there is exactly ONE
  // passphrase in play rather than two gates that could disagree.
  if (opts.token !== undefined) config = { ...config, auth: { ...config.auth, passphrase: opts.token } };
  if (problem) {
    log(`[onair] CONFIG UNUSABLE - starting on loopback with defaults, serving the repair view:`);
    for (const e of problem.errors) log(`[onair]   ${e}`);
  }

  // Annotated, not inferred: the inferred union includes NoopDriver, which has no
  // `setTableVersion`, and TypeScript refuses `?.` on a union where one member lacks the
  // property outright. The interface is what every caller here is entitled to assume.
  const driver: LightDriver =
    opts.driver ?? opts.makeDriver?.(config) ?? driverFor(config, log) ?? new NoopDriver(log);

  const stateLoaded = await loadState(opts.stateFile, log);
  const store = new StateStore(stateLoaded ?? defaultState(), new StateTable(config.states, config.version));

  // Startup config check. A wrong entity name is a deploy bug and must be loud, so
  // DriverConfigError propagates and stops the service. An unreachable device does not:
  // crash-looping on a dead light is the failure persist.ts was just fixed to avoid.
  //
  // It checks that the entity EXISTS and nothing more. `select` could be asked for its
  // compiled option list; `text` has no such list by design (D-38), so a firmware/server
  // skew now surfaces as a read-back that does not match, i.e. `confirmed: unknown`.
  if (driver instanceof EsphomeTextDriver) {
    if ((await driver.verifyEntity()) === null) {
      log('[onair] light unreachable at boot; continuing with confirmed=unknown');
    }
  }

  // Invariant: recover after restart - re-apply the persisted state to the light on boot.
  //
  // Unconditionally, since D-91. This used to adopt a busy reading off the device when the
  // persisted state was calm and older than 90s, which was the server reading a clock to
  // decide what the state IS. The state is latched: the file is the last explicit write and
  // the device only ever holds an echo of an earlier one, so there is nothing here to adopt.
  try {
    const table = store.getTable();
    const want = store.get().state;
    const got = await driver.set(want);
    store.setConfirmed(table.has(got) ? got : UNKNOWN_ID);
  } catch (err) {
    log(`[onair] boot driver re-apply failed: ${errorMessage(err)}`);
    store.setConfirmed(UNKNOWN_ID);
  }

  // One write queue, shared by the HTTP routes and the supervisor, so a supervisor
  // re-assert can never race a POST through the driver.
  let writeChain: Promise<void> = Promise.resolve();
  // HOW MANY WRITES ARE WAITING. The defect in #68 is a queue that grows without bound while
  // the panel is away, and wall-clock timings are a proxy for it that a loaded machine ruins.
  // This is the thing itself, so a test can assert it.
  let queued = 0;
  const enqueueWrite = (run: () => Promise<void>): Promise<void> => {
    queued++;
    const next = writeChain.then(run);
    writeChain = next.catch(() => {});
    return next.finally(() => {
      queued--;
    });
  };

  const hub = createSseHub();
  const wsBridge = createWsBridge();
  const sessions = new SessionStore();
  let servers: Server[] = [];
  let boundPort = 0;

  const makeServer = (): Server =>
    createApiServer({
      store,
      driver,
      persist: (state) => saveState(opts.stateFile, state),
      enqueueWrite,
      hub,
      ws: wsBridge,
      log,
      stateFile: opts.stateFile,
      config: () => config,
      configProblem: () => problem,
      applyConfig,
      sessions,
      factoryReset,
    });

  /**
   * Everything back to shipped defaults (D-35, amended by D-43 on the passphrase): admin
   * credentials to `rocket`/`ESP32`, the passphrase to `onair`, the table to the seed rows,
   * live state `unknown`, `bind` to `all`, port to 8484.
   *
   * The device credentials are kept. They are not ours to reset - they were compiled into
   * the firmware (D-17) and a reset that silently forgot them would take the light offline
   * with no error, which is the opposite of what someone reaching for a factory reset wants.
   */
  async function factoryReset(): Promise<void> {
    const fresh = { ...defaultConfig(), version: config.version + 1, light: { ...config.light } };
    if (opts.configFile) await saveConfigFile(opts.configFile, fresh);
    config = fresh;
    problem = undefined;
    store.setTable(new StateTable(fresh.states, fresh.version));
    store.write(UNKNOWN_ID, { kind: 'human', label: 'factory-reset', raw: 'human:factory-reset' });
    await saveState(opts.stateFile, store.persisted());
    log('[onair] factory reset: credentials, table, state and bind are back to defaults');
  }

  /**
   * The one apply path (D-36). Persist first, then swap the table in, then rebind if the
   * port or bind mode moved.
   *
   * **It never exits.** A rebind that fails rolls back to the previous listeners and
   * answers `409` - "restart and hope" is not safe to invoke from across the house, and
   * under KeepAlive a process exit on a bad address is a crash-loop.
   */
  async function applyConfig(input: OnAirConfig): Promise<{ ok: true } | { ok: false; status: 409 | 507; error: string }> {
    let next = input;
    // A passphrase change starts the 60-minute grace window, so the ESP32, Companion and
    // the detector degrade on a schedule instead of all at once.
    next = { ...next, auth: rotate(config.auth, next.auth) };
    if (opts.configFile) {
      try {
        await saveConfigFile(opts.configFile, next);
      } catch (err) {
        // ENOSPC leaves the running config untouched - that is what the atomic write buys.
        if (err instanceof ConfigWriteError && err.outOfSpace) {
          return { ok: false, status: 507, error: `config not saved: ${err.message}` };
        }
        return { ok: false, status: 409, error: `config not saved: ${errorMessage(err)}` };
      }
    }
    // The env override wins over the document (D-14), so a port change in the document is
    // not a rebind while it is set - otherwise a save would silently undo the escape hatch
    // someone used to get the service back up.
    const rebinding = effectivePort(next) !== effectivePort(config) || next.bind !== config.bind;
    const previous = config;
    // A changed admin password invalidates every live session: the point of changing it is
    // that whoever knew the old one stops being admin.
    if (next.auth.adminPassword !== config.auth.adminPassword) sessions.destroyAll();
    config = next;
    problem = undefined; // a successful save is the repair
    store.setTable(new StateTable(next.states, next.version));
    // Nudge here as well as on a state write (D-42). Without this a pure presentation
    // edit - renaming a row, changing a colour - reaches the panel only when the next
    // state write happens, which on a quiet afternoon is hours. The nudge is what makes
    // an edit in the console feel like it did something.
    try {
      await driver.setTableVersion?.(next.version);
    } catch (err) {
      log(`[onair] version nudge failed: ${errorMessage(err)}`);
    }

    if (!rebinding) return { ok: true };

    const target = resolveBind(next.bind);
    if (target.warning) log(`[onair] ${target.warning}`);
    // Stop accepting BEFORE binding: the new addresses usually overlap the old ones on the
    // same port, so binding first would just be EADDRINUSE against ourselves.
    stopAccepting(servers);
    try {
      const opened = await listenAll(makeServer, target.addresses, effectivePort(next));
      servers = opened.servers;
      boundPort = opened.port;
      log(`[onair] rebound to ${target.addresses.join(', ')} on :${boundPort}`);
      return { ok: true };
    } catch (err) {
      log(`[onair] rebind failed (${errorMessage(err)}) - rolling back to :${previous.port}`);
      config = previous;
      store.setTable(new StateTable(previous.states, previous.version));
      if (opts.configFile) await saveConfigFile(opts.configFile, previous).catch(() => {});
      try {
        const back = await listenAll(makeServer, resolveBind(previous.bind).addresses, effectivePort(previous));
        servers = back.servers;
        boundPort = back.port;
      } catch (err2) {
        // Never fail closed. If even the old binding will not come back, loopback is the
        // last resort that still leaves an admin surface to fix this from.
        log(`[onair] rollback bind ALSO failed (${errorMessage(err2)}) - falling back to loopback`);
        const last = await listenAll(makeServer, ['127.0.0.1'], effectivePort(previous));
        servers = last.servers;
        boundPort = last.port;
      }
      return { ok: false, status: 409, error: `rebind failed and was rolled back: ${errorMessage(err)}` };
    }
  }

  // A config the service could not read is a config it must not act on: bind loopback,
  // start anyway, and serve the repair view. The port override still applies so a test or
  // an operator can pin it.
  const startBind = problem ? 'loopback' : config.bind;
  const resolved = resolveBind(startBind);
  if (resolved.warning) log(`[onair] ${resolved.warning}`);
  const opened = await listenAll(makeServer, resolved.addresses, effectivePort(config));
  servers = opened.servers;
  boundPort = opened.port;
  log(`[onair] listening on ${resolved.addresses.join(', ')}:${boundPort}, state file ${opts.stateFile}`);

  const supervisor = startSupervisor({
    store,
    driver,
    enqueue: enqueueWrite,
    log,
    onChange: () => {
      const body = store.status();
      hub.broadcast(); // per connection: /public/events must not see the gated body (#88)
      wsBridge.broadcast(body);
    },
    ...opts.supervise,
  });

  return {
    get port() {
      return boundPort;
    },
    store,
    writeQueueDepth: () => queued,
    config: () => config,
    sessions,
    close: async () => {
      supervisor.stop(); // synchronous: never await an in-flight tick
      hub.closeAll();
      wsBridge.closeAll();
      await closeAll(servers);
    },
  };
}

/** The device driver described by the config's `light` block, or nothing. */
function driverFor(config: OnAirConfig, log: (line: string) => void): LightDriver | undefined {
  if (!config.light.host) return undefined;
  return new EsphomeTextDriver({
    host: config.light.host,
    entity: config.light.entity,
    username: config.light.username ?? undefined,
    password: config.light.password ?? undefined,
    log,
  });
}
