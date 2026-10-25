import type { Server } from 'node:http';
import {
  ConfigWriteError,
  defaultConfig,
  loadConfigFile,
  resolveBind,
  saveConfigFile,
  type BindMode,
  type OnAirConfig,
} from './config-store.js';
import { rotate, SessionStore } from './auth.js';
import { deviceSpecs } from './config.js';
import type { LightDriver } from './driver.js';
import { EsphomeTextDriver } from './esphome-driver.js';
import { FanOutDriver } from './fanout-driver.js';
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
  /** Name of the environment override, for the admin console; no secret is exposed. */
  tokenVariable?: 'ONAIR_PASSPHRASE' | 'ONAIR_TOKEN';
  /** Built from the config's `devices` list when not supplied, and never reconfigured. */
  driver?: LightDriver;
  /**
   * Applied to the defaults when there is no config file yet, and then written out. This
   * is how `config.env`'s values become the document on an upgrading host - after which
   * the env file is only an overlay, which is what D-36 retired it to.
   */
  seedConfig?: (base: OnAirConfig) => OnAirConfig;
  log?: (line: string) => void;
  /**
   * TEST SEAM: overrides the config's `bind`, exactly as `port` above overrides its port.
   *
   * It exists because of #49. A test app on `port: 0` takes the config default `bind: 'all'`,
   * which resolves to the dual-stack wildcard `::` - and a wildcard bind does NOT exclude
   * another process binding `127.0.0.1:P` specifically. Both succeed, and IPv4 traffic to
   * `127.0.0.1:P` reaches the MORE SPECIFIC bind, which is the stranger. That is how three
   * separate test failures came to be recorded as "a response belonging to a different
   * request": they were answers from a different PROCESS, on a port the OS had recycled.
   *
   * Tests that talk to `http://127.0.0.1:<port>` should pass `bind: 'loopback'`, which is
   * exclusive - nothing else can hold that address and port at the same time.
   *
   * It applies to the STARTING bind only. A later `PUT /admin/config` that changes `bind` is
   * honoured, because that is the behaviour the rebind tests exist to exercise.
   */
  bind?: BindMode;
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
 * The caller starts the old-socket sweep only when the operation finishes, leaving time
 * for its response to flush even if the device version nudge takes several seconds.
 * Anything still attached then is a keep-alive client, and it will reconnect to the new
 * listener on its next request.
 */
function stopAccepting(servers: Server[]): () => void {
  for (const s of servers) {
    s.close();
    s.closeIdleConnections();
  }
  return () => {
    setTimeout(() => {
      for (const s of servers) {
        s.closeIdleConnections();
        s.closeAllConnections();
      }
    }, 1000).unref();
  };
}

export async function createApp(opts: AppOptions): Promise<App> {
  const log = opts.log ?? console.log;
  if (opts.token !== undefined && opts.token.trim() === '') throw new Error('passphrase override must be non-empty');
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
  // Keep the document separate from the environment. Authorization applies the override
  // on every request, so saves and reset cannot remove it or write it into the document.
  if (problem) {
    log(`[onair] CONFIG UNUSABLE - starting on loopback with defaults, serving the repair view:`);
    for (const e of problem.errors) log(`[onair]   ${e}`);
  }

  // Annotated, not inferred: the inferred union includes NoopDriver, which has no
  // `setTableVersion`, and TypeScript refuses `?.` on a union where one member lacks the
  // property outright. The interface is what every caller here is entitled to assume.
  const driver: LightDriver = opts.driver ?? driverFor(config, log);

  const stateLoaded = await loadState(opts.stateFile, log);
  const store = new StateStore(stateLoaded ?? defaultState(), new StateTable(config.states, config.version));

  // Startup config check. A wrong entity name is a deploy bug and must be loud, so
  // DriverConfigError propagates and stops the service. An unreachable device does not:
  // crash-looping on a dead light is the failure persist.ts was just fixed to avoid.
  //
  // It checks that the entity EXISTS and nothing more. `select` could be asked for its
  // compiled option list; `text` has no such list by design (D-38), so a firmware/server
  // skew now surfaces as a read-back that does not match, i.e. `confirmed: unknown`.
  //
  // ONLY THE PRIMARY MAY STOP THE SERVICE. A `DriverConfigError` from the authoritative
  // panel is a deploy bug and stays loud, exactly as it was when there was one light. A
  // secondary that is misconfigured is logged and marked unreachable instead: a typo typed
  // into the admin console must not brick the daemon at its next restart, because a daemon
  // that will not start is a false OFF with extra steps - caused by the panel that matters
  // least.
  const bootPrimary = driver instanceof FanOutDriver ? driver.primaryDriver() : driver;
  if (bootPrimary instanceof EsphomeTextDriver) {
    if ((await bootPrimary.verifyEntity()) === null) {
      log('[onair] light unreachable at boot; continuing with confirmed=unknown');
    }
  }
  if (driver instanceof FanOutDriver) {
    for (const s of driver.secondaryDrivers()) {
      if (!(s.driver instanceof EsphomeTextDriver)) continue;
      try {
        if ((await s.driver.verifyEntity()) === null) {
          log(`[onair] secondary ${s.host} unreachable at boot; it is best-effort, continuing`);
        }
      } catch (err) {
        // Caught on purpose, and this catch IS the feature.
        log(`[onair] secondary ${s.host} is misconfigured and will be skipped: ${errorMessage(err)}`);
        driver.markUnreachable(s.id, errorMessage(err));
      }
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
  let supervisor: ReturnType<typeof startSupervisor> | undefined;

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
      passphraseOverride: opts.token,
      passphraseVariable: opts.tokenVariable ?? 'ONAIR_TOKEN',
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
   *
   * IT IS `devices` THAT IS CARRIED, NOT `light`. `light` is a projection of the primary
   * device now, so carrying it forward over a default (empty) device list would recompute it
   * straight back to `host: null` - a reset that forgets the light after all, by exactly the
   * route this comment says not to take. Caught by "factory reset KEEPS the device
   * credentials", which is what that test is for.
   */
  type ConfigResult = { ok: true } | { ok: false; status: 409 | 507; error: string };

  const retiringListeners: Array<() => void> = [];

  async function serializeConfig(run: () => Promise<ConfigResult>): Promise<ConfigResult> {
    let result: ConfigResult;
    await enqueueWrite(async () => {
      try { result = await run(); } finally {
        for (const retire of retiringListeners.splice(0)) retire();
      }
    });
    return result!;
  }

  async function factoryReset(): Promise<ConfigResult> {
    return serializeConfig(async () => {
      const fresh = {
        ...defaultConfig(),
        version: config.version + 1,
        devices: config.devices.map((d) => ({ ...d })),
        light: { ...config.light },
      };
      const result = await commitConfig(fresh);
      if (!result.ok) return result;
      store.write(UNKNOWN_ID, { kind: 'human', label: 'factory-reset', raw: 'human:factory-reset' });
      store.clearMessage();
      await saveState(opts.stateFile, store.persisted());
      try { await driver.set(UNKNOWN_ID); } catch (err) {
        log(`[onair] factory reset device write failed: ${errorMessage(err)}`);
      }
      store.setConfirmed(UNKNOWN_ID);
      hub.broadcast();
      wsBridge.broadcast(store.status());
      log('[onair] factory reset: credentials, table, state and bind are back to defaults');
      return result;
    });
  }

  // The version comparison and the complete application share the state-write queue.
  // Checking in the HTTP handler allowed two editors to pass before either saved, and
  // configuration could also swap a driver while a state write was using it.
  async function applyConfig(input: OnAirConfig): Promise<ConfigResult> {
    return serializeConfig(async () => {
      if (input.version !== config.version) {
        return { ok: false, status: 409,
          error: `config has changed underneath you (yours ${input.version}, current ${config.version})` };
      }
      return commitConfig({ ...input, version: config.version + 1, auth: rotate(config.auth, input.auth) });
    });
  }

  /**
   * Persist and establish the listener before changing table, driver, or credentials.
   * A rejected rebind must never send a table nudge, forget the current row, or revoke
   * sessions. State writes and supervisor ticks cannot run during this operation.
   */
  async function commitConfig(next: OnAirConfig): Promise<ConfigResult> {
    const previous = config;
    if (opts.configFile) {
      try {
        await saveConfigFile(opts.configFile, next);
      } catch (err) {
        return { ok: false, status: err instanceof ConfigWriteError && err.outOfSpace ? 507 : 409,
          error: `config not saved: ${errorMessage(err)}` };
      }
    }
    const rebinding = effectivePort(next) !== effectivePort(previous) || next.bind !== previous.bind;
    if (rebinding) {
      const target = resolveBind(next.bind);
      if (target.warning) log(`[onair] ${target.warning}`);
      retiringListeners.push(stopAccepting(servers));
      try {
        const opened = await listenAll(makeServer, target.addresses, effectivePort(next));
        servers = opened.servers;
        boundPort = opened.port;
        log(`[onair] rebound to ${target.addresses.join(', ')} on :${boundPort}`);
      } catch (err) {
        let rollbackError = '';
        if (opts.configFile) {
          try { await saveConfigFile(opts.configFile, previous); } catch (diskError) {
            rollbackError = `; restoring the config file also failed: ${errorMessage(diskError)}`;
          }
        }
        try {
          const back = await listenAll(makeServer, resolveBind(previous.bind).addresses, effectivePort(previous));
          servers = back.servers;
          boundPort = back.port;
        } catch (bindError) {
          log(`[onair] rollback bind ALSO failed (${errorMessage(bindError)}) - falling back to loopback`);
          const last = await listenAll(makeServer, ['127.0.0.1'], effectivePort(previous));
          servers = last.servers;
          boundPort = last.port;
        }
        log(`[onair] rebind failed (${errorMessage(err)}) - restored previous listeners${rollbackError}`);
        return { ok: false, status: 409,
          error: `rebind failed and was rolled back: ${errorMessage(err)}${rollbackError}` };
      }
    }

    config = next;
    problem = undefined;
    store.setTable(new StateTable(next.states, next.version));
    if (driver instanceof FanOutDriver) {
      const previousPrimary = driver.primaryDriver();
      driver.reconfigure(deviceSpecs(next.devices));
      if (driver.primaryDriver() !== previousPrimary) {
        // Fan-out preserves a driver only when its id and connection are unchanged.
        // A label edit or secondary change therefore keeps the primary's evidence.
        store.setConfirmed(UNKNOWN_ID);
        supervisor?.resetEvidence();
      }
    }
    if (next.auth.adminPassword !== previous.auth.adminPassword) sessions.destroyAll();
    try { await driver.setTableVersion?.(next.version); } catch (err) {
      log(`[onair] version nudge failed: ${errorMessage(err)}`);
    }
    hub.broadcast();
    wsBridge.broadcast(store.status());
    return { ok: true };
  }

  // A config the service could not read is a config it must not act on: bind loopback,
  // start anyway, and serve the repair view. The port override still applies so a test or
  // an operator can pin it.
  const startBind = problem ? 'loopback' : (opts.bind ?? config.bind);
  const resolved = resolveBind(startBind);
  if (resolved.warning) log(`[onair] ${resolved.warning}`);
  const opened = await listenAll(makeServer, resolved.addresses, effectivePort(config));
  servers = opened.servers;
  boundPort = opened.port;
  log(`[onair] listening on ${resolved.addresses.join(', ')}:${boundPort}, state file ${opts.stateFile}`);

  supervisor = startSupervisor({
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
      supervisor?.stop(); // synchronous: never await an in-flight tick
      hub.closeAll();
      wsBridge.closeAll();
      await closeAll(servers);
    },
  };
}

/** The device driver described by the config's `light` block, or nothing. */
/**
 * The fan-out over every enabled, addressed device (D-87, stage 3 of #57).
 *
 * `undefined` when there is nothing to drive, so `NoopDriver` still takes over on a fresh
 * install exactly as it did when this read `if (!config.light.host) return undefined`.
 *
 * The env overlay is applied inside `deviceSpecs`, which is the one expression of that
 * precedence (D-79). It used to be written out in index.ts's `makeDriver`, and having it in
 * two places is what let the admin console render a value the driver had already overridden.
 */
function driverFor(config: OnAirConfig, log: (line: string) => void): FanOutDriver {
  // ALWAYS a fan-out, even over zero devices. An empty one already behaves as a noop - it
  // returns `unknown` and drives nothing - and building it unconditionally is what lets the
  // FIRST device added on a fresh install take effect without a restart. A NoopDriver here
  // could never be reconfigured into a real one, so that install would save, report success
  // and go on driving nothing.
  const specs = deviceSpecs(config.devices);
  return new FanOutDriver({
    specs,
    make: (spec) =>
      new EsphomeTextDriver({
        host: spec.host,
        entity: spec.entity,
        username: spec.username ?? undefined,
        password: spec.password ?? undefined,
        log,
      }),
    log,
  });
}
