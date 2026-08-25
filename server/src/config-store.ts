import { constants as fsConstants } from 'node:fs';
import { open, rename, mkdir, readFile, chmod } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { ID_PATTERN, SEED_ROWS, SEED_SHORTCUTS, UNKNOWN_ID, type Shortcuts, type StateRow } from './state.js';

/**
 * The config document - one structured file, `~/.onair/config.json`, 0600 (D-36).
 *
 * KNOWLEDGE LEVEL. Slow, user-owned, hand-editable. `~/.onair/state.json` is the
 * operational level: fast, service-owned. **They never share a file** - different
 * lifetimes, different writers, permanently.
 */
export interface OnAirConfig {
  /** Monotonic. Bumped on every save; `tableVersion` on the wire reports it. */
  version: number;
  port: number;
  bind: BindMode;
  /** The state table (contract §1). */
  states: StateRow[];
  /** Which rows `/on` and `/off` resolve to. */
  shortcuts: Shortcuts;
  /** The device the server drives. Credentials live here rather than in the env (D-36). */
  light: { host: string | null; entity: string; username: string | null; password: string | null };
  /**
   * The shape only. The passphrase, the admin session and the Origin waiver are D-35 and
   * land with #40; this reserves the field so a config written now round-trips through
   * that change instead of being dropped by it.
   */
  auth: { passphrase: string | null };
}

/**
 * `bind` is a MODE, not an address (D-36). **Loopback is always bound and is never a user
 * choice** - this picks what *else* is bound.
 *
 * Measured in the #22 research: binding a single LAN address makes `127.0.0.1` return
 * ECONNREFUSED, which would silently disable the loopback waiver and therefore the admin
 * surface, from a UI whose only purpose is administration.
 */
export type BindMode = 'all' | 'loopback' | `iface:${string}`;

export const DEFAULT_PORT = 8484;

export function defaultConfig(): OnAirConfig {
  return {
    version: 1,
    port: DEFAULT_PORT,
    bind: 'all',
    states: SEED_ROWS.map((r) => ({ ...r })),
    shortcuts: { ...SEED_SHORTCUTS },
    light: { host: null, entity: 'PresenceKey', username: null, password: null },
    auth: { passphrase: null },
  };
}

export type Validated = { ok: true; config: OnAirConfig } | { ok: false; errors: string[] };

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * THE one validation function (D-36). The admin UI has no privileged path - it calls the
 * same route every other client would, and that route calls this.
 *
 * Home Assistant is the cautionary tale: `input_select`'s `set_options` service mutates
 * memory and never touches the storage collection, so it silently does not survive a
 * restart, while UI editing goes through an entirely separate path. Two writers, two
 * lifetimes, no reconciliation. There is no second way in here.
 */
export function validateConfig(raw: unknown): Validated {
  const errors: string[] = [];
  const fail = (m: string): void => void errors.push(m);
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['config must be a JSON object'] };
  const c = raw as Record<string, unknown>;
  const d = defaultConfig();

  const version = typeof c.version === 'number' && Number.isInteger(c.version) && c.version >= 1 ? c.version : null;
  if (version === null) fail('version must be an integer >= 1');

  const port = typeof c.port === 'number' && Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535 ? c.port : null;
  if (port === null) fail('port must be an integer 1-65535');

  const bind = parseBind(c.bind);
  if (bind === null) fail('bind must be "all", "loopback" or "iface:<name>"');

  const states = validateStates(c.states, fail);
  const shortcuts = validateShortcuts(c.shortcuts, states, fail);

  const lightRaw = (typeof c.light === 'object' && c.light !== null ? c.light : {}) as Record<string, unknown>;
  const light = {
    host: strOrNull(lightRaw.host),
    entity: typeof lightRaw.entity === 'string' && lightRaw.entity !== '' ? lightRaw.entity : d.light.entity,
    username: strOrNull(lightRaw.username),
    password: strOrNull(lightRaw.password),
  };
  const authRaw = (typeof c.auth === 'object' && c.auth !== null ? c.auth : {}) as Record<string, unknown>;
  const auth = { passphrase: strOrNull(authRaw.passphrase) };

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: { version: version!, port: port!, bind: bind!, states: states!, shortcuts: shortcuts!, light, auth },
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function parseBind(v: unknown): BindMode | null {
  if (v === 'all' || v === 'loopback') return v;
  if (typeof v === 'string' && v.startsWith('iface:') && v.length > 'iface:'.length) return v as BindMode;
  return null;
}

function validateStates(v: unknown, fail: (m: string) => void): StateRow[] | null {
  if (!Array.isArray(v)) {
    fail('states must be an array');
    return null;
  }
  const rows: StateRow[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of v.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      fail(`states[${i}] must be an object`);
      continue;
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!ID_PATTERN.test(id)) {
      fail(`states[${i}].id must match ${ID_PATTERN.source}`);
      continue;
    }
    if (seen.has(id)) {
      fail(`states[${i}].id "${id}" is a duplicate`);
      continue;
    }
    seen.add(id);
    const label = typeof r.label === 'string' ? r.label : '';
    if (label.length < 1 || label.length > 64) fail(`states[${i}].label must be 1..64 characters`);
    const color = typeof r.color === 'string' ? r.color : '';
    const bgcolor = typeof r.bgcolor === 'string' ? r.bgcolor : '';
    if (!HEX_COLOR.test(color)) fail(`states[${i}].color must be #rrggbb, lowercase`);
    if (!HEX_COLOR.test(bgcolor)) fail(`states[${i}].bgcolor must be #rrggbb, lowercase`);
    const description = typeof r.description === 'string' ? r.description : '';
    if (description.length > 200) fail(`states[${i}].description must be at most 200 characters`);
    if (typeof r.busy !== 'boolean') fail(`states[${i}].busy must be a boolean`);
    const order = typeof r.order === 'number' && Number.isInteger(r.order) && r.order >= 0 && r.order <= 999 ? r.order : null;
    if (order === null) fail(`states[${i}].order must be an integer 0-999`);
    rows.push({ id, label, color, bgcolor, description, busy: r.busy === true, order: order ?? 0 });
  }
  // `unknown` cannot be deleted and its busy is always true (D-34). Reinstated rather than
  // rejected: a config that has lost it is repaired, not refused, because refusing would
  // leave the owner with a file they cannot save from the UI that produced it.
  const u = rows.find((r) => r.id === UNKNOWN_ID);
  if (!u) rows.push({ ...SEED_ROWS[SEED_ROWS.length - 1]! });
  else u.busy = true;
  if (rows.length === 0) fail('states must contain at least one row');
  return rows;
}

function validateShortcuts(v: unknown, states: StateRow[] | null, fail: (m: string) => void): Shortcuts | null {
  const s = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const ids = new Set((states ?? []).map((r) => r.id));
  const one = (key: 'on' | 'off'): string | null => {
    const raw = s[key];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') {
      fail(`shortcuts.${key} must be a row id or null`);
      return null;
    }
    // A shortcut naming a row that does not exist is a `409` on the route, but here it is
    // a save-time error: the owner is looking at the UI and can fix it now.
    if (states !== null && !ids.has(raw)) fail(`shortcuts.${key} names "${raw}", which is not a row`);
    return raw;
  };
  return { on: one('on'), off: one('off') };
}

/** What `loadConfigFile` returns. A broken file NEVER throws - see D-36. */
export interface LoadedConfig {
  config: OnAirConfig;
  /** False when there was no file at all, which is a first boot rather than a fault. */
  fromDisk: boolean;
  /** Present when the file on disk could not be used. The service starts anyway. */
  problem?: { errors: string[]; raw: string };
}

/**
 * Read the config document. **A broken config never stops the service** (D-36): it comes
 * back with `problem` set and the defaults in `config`, and the caller binds loopback,
 * starts, and serves a repair view. Throwing here would mean launchd restarts forever with
 * every surface that could report the problem down - which is the failure this design is
 * aimed at, on a machine Rocket is not sitting in front of.
 */
export async function loadConfigFile(file: string): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: defaultConfig(), fromDisk: false };
    return { config: defaultConfig(), fromDisk: true, problem: { errors: [`cannot read ${file}: ${String(err)}`], raw: '' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: defaultConfig(), fromDisk: true, problem: { errors: [`unparseable JSON: ${String(err)}`], raw } };
  }
  const v = validateConfig(parsed);
  if (!v.ok) return { config: defaultConfig(), fromDisk: true, problem: { errors: v.errors, raw } };
  return { config: v.config, fromDisk: true };
}

/** Thrown by saveConfigFile when the write fails. `outOfSpace` becomes a `507`. */
export class ConfigWriteError extends Error {
  constructor(message: string, readonly outOfSpace: boolean) {
    super(message);
  }
}

/**
 * Is this the disk being full? `EDQUOT` counts: from the writer's side a quota is a full
 * disk, and the honest answer to the client is the same one - the running config is
 * untouched, free some space and try again.
 */
export function isOutOfSpace(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

/**
 * Atomic write: temp file, `fsync`, `rename`. The file on disk is either wholly the old
 * document or wholly the new one, never half - which is the whole reason the running
 * config survives ENOSPC untouched.
 *
 * 0600 is set on the temp file BEFORE any content is written to it, so the passphrase and
 * the device credentials are never briefly world-readable.
 */
export async function saveConfigFile(file: string, config: OnAirConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = `${JSON.stringify(config, null, 2)}\n`;
  let handle;
  try {
    handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
    await chmod(tmp, 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } catch (err) {
    throw new ConfigWriteError(`cannot write ${tmp}: ${String(err)}`, isOutOfSpace(err));
  } finally {
    await handle?.close().catch(() => {});
  }
  await rename(tmp, file);
}

/**
 * Resolve a bind mode to the addresses to listen on. **Loopback is always in the list.**
 *
 * The interface NAME is resolved here, at every startup, rather than an address being
 * stored: a stored address goes stale, and `EADDRNOTAVAIL` under KeepAlive is a
 * crash-loop. A missing interface yields loopback only, plus a warning - it binds, it
 * starts, and it can be fixed from the UI it is still serving.
 */
export function resolveBind(mode: BindMode): { addresses: string[]; warning?: string } {
  const loopback = ['127.0.0.1'];
  if (mode === 'loopback') return { addresses: loopback };
  if (mode === 'all') return { addresses: ['::'] }; // dual-stack, which already includes loopback
  const name = mode.slice('iface:'.length);
  const iface = networkInterfaces()[name];
  if (!iface || iface.length === 0) {
    return { addresses: loopback, warning: `interface "${name}" not found; bound loopback only` };
  }
  const addrs = iface.filter((a) => !a.internal).map((a) => a.address);
  if (addrs.length === 0) {
    return { addresses: loopback, warning: `interface "${name}" has no external address; bound loopback only` };
  }
  // Loopback first and always: binding only a LAN address makes 127.0.0.1 refuse, which
  // would disable the admin surface from the UI whose purpose is administration.
  return { addresses: [...loopback, ...addrs] };
}
