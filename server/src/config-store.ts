import { constants as fsConstants } from 'node:fs';
import { open, rename, mkdir, readFile, chmod } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { defaultAuth, type AuthBlock } from './auth.js';
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
  /**
   * Every device the server drives (D-87, stage 3 of #57). Credentials live here rather
   * than in the env (D-36).
   */
  devices: DeviceRow[];
  /**
   * THE PRIMARY DEVICE, PROJECTED. Read-only: `devices` is the truth and this is derived
   * from whichever row is `primary`, on every validate.
   *
   * It is kept because 43 source references and every existing test read it, and because
   * the env overlay (D-14/D-79) is written over `light.host` and friends. Deleting it would
   * turn a contained change into a rewrite of the whole surface for no behavioural gain.
   */
  light: LightBlock;
  /** The passphrase and the admin credentials (D-35, D-43). Why this file is 0600. */
  auth: AuthBlock;
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

export interface LightBlock {
  host: string | null;
  entity: string;
  username: string | null;
  password: string | null;
}

/**
 * One on-air light, as the config document holds it.
 *
 * Shaped like a state row on purpose - an immutable `id`, a freely editable `label`, and a
 * presentation-only `order` - because the admin console's row editor is the only
 * list-editing pattern this project has and a second one would be a second thing to learn.
 */
export interface DeviceRow {
  /** Immutable slug, the only addressable handle. Never renamed (D-31/D-34). */
  id: string;
  /** Human phrase. Freely editable, never a key. */
  label: string;
  host: string | null;
  entity: string;
  username: string | null;
  password: string | null;
  /** Written to only when true. An absent bench board is a normal condition (D-87). */
  enabled: boolean;
  /**
   * Exactly one row is the primary, and it is the one `confirmed` describes.
   *
   * D-87: `confirmed` cannot mean "every panel agreed" - a bench board that is off for
   * weeks would make an AND over all panels permanently false and the system would report a
   * fault as its resting state.
   */
  primary: boolean;
  /** Display sort hint. Presentation only, never an address (D-31/D-34). */
  order: number;
}

const DEFAULT_ENTITY = 'PresenceKey';

/** The primary device, as a `light` block. The one place that projection is expressed. */
export function projectLight(devices: DeviceRow[]): LightBlock {
  const p = devices.find((d) => d.primary);
  if (!p) return { host: null, entity: DEFAULT_ENTITY, username: null, password: null };
  return { host: p.host, entity: p.entity, username: p.username, password: p.password };
}

export const DEFAULT_PORT = 8484;

export function defaultConfig(): OnAirConfig {
  return {
    version: 1,
    port: DEFAULT_PORT,
    bind: 'all',
    states: SEED_ROWS.map((r) => ({ ...r })),
    shortcuts: { ...SEED_SHORTCUTS },
    devices: [],
    light: { host: null, entity: DEFAULT_ENTITY, username: null, password: null },
    auth: defaultAuth(),
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
  const light: LightBlock = {
    host: strOrNull(lightRaw.host),
    entity: typeof lightRaw.entity === 'string' && lightRaw.entity !== '' ? lightRaw.entity : d.light.entity,
    username: strOrNull(lightRaw.username),
    password: strOrNull(lightRaw.password),
  };

  // THE ONE PRECEDENCE RULE, and it is also the migration.
  //
  //   `devices` ABSENT  -> an old client or an old file. One row is synthesised from `light`.
  //   `devices` PRESENT -> `devices` is the truth and `light` is recomputed from the primary.
  //
  // and, because `light` is still a writable-looking key on a document every client
  // round-trips: a payload whose `light` CONTRADICTS its own `devices` is refused rather
  // than quietly resolved either way.
  //
  // That third rule is not defensive programming, it is the whole point. `GET /admin/config`
  // returns `devices` now, so any old client that fetches, edits `light` and puts it back
  // would otherwise get a 200 and no change - the exact silent-success failure this project
  // keeps being bitten by (D-79's overridden field, D-100's stale binary). Guessing which
  // half the caller meant would be worse: it makes the outcome depend on a heuristic nobody
  // can see. A 400 that names the fix cannot be misread.
  //
  // No version branch is needed, and that matters: `config.version` is a SAVE COUNTER, not
  // a schema version, and nothing in this file has ever branched on it.
  //
  // An EMPTY `devices` cannot contradict anything - it names no primary to disagree with -
  // so it falls back to the `light` projection rather than being treated as "no devices,
  // and I mean it". That is what lets index.ts's first-boot `seedConfig` keep folding
  // ONAIR_LIGHT_* into a default document without tripping the check below.
  const declared = Array.isArray(c.devices) ? validateDevices(c.devices, fail) : null;
  const devices = declared !== null && declared.length > 0 ? declared : deviceFromLight(light, d.light);
  if (declared !== null && declared.length > 0 && c.light !== undefined) {
    const projected = projectLight(devices);
    const disagrees = (Object.keys(projected) as Array<keyof LightBlock>).filter((k) => projected[k] !== light[k]);
    if (disagrees.length > 0) {
      fail(
        `light.${disagrees.join(', light.')} disagrees with the primary device - ` +
          '`light` is a read-only projection of the primary row, so edit `devices` instead ' +
          '(or omit `light` and it will be recomputed)',
      );
    }
  }

  const auth = validateAuth(c.auth, fail);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      version: version!,
      port: port!,
      bind: bind!,
      states: states!,
      shortcuts: shortcuts!,
      devices: devices!,
      // Derived, never stored independently. Two representations of one truth is how they
      // drift; this makes drift impossible by construction.
      light: projectLight(devices!),
      auth,
    },
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * An EMPTY passphrase or admin password is a validation error, never bypassable auth
 * (contract §8). The failure mode being designed against is a config edit that silently
 * turns the door off, which is the one mistake here that has no visible symptom.
 */
function validateAuth(v: unknown, fail: (m: string) => void): AuthBlock {
  const a = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const d = defaultAuth();
  const required = (key: 'passphrase' | 'adminUser' | 'adminPassword'): string => {
    const raw = a[key];
    // ABSENT (undefined or null) means "not configured" and takes the shipped default.
    // EMPTY means someone typed nothing into a credential field, which is a different
    // thing and is an error - an empty credential is never bypassable auth (§8). The null
    // case is not hypothetical: the config document shipped one release with
    // `auth: { passphrase: null }` as a reserved field, and rejecting that would put an
    // upgrading host into the repair view on loopback, taking the light off the LAN.
    if (raw === undefined || raw === null) return d[key];
    if (typeof raw !== 'string' || raw.trim() === '') {
      fail(`auth.${key} must be a non-empty string - an empty credential is never bypassable auth`);
      return d[key];
    }
    return raw;
  };
  const previous = strOrNull(a.previous);
  const previousUntil = typeof a.previousUntil === 'number' && Number.isFinite(a.previousUntil) ? a.previousUntil : null;
  return {
    passphrase: required('passphrase'),
    adminUser: required('adminUser'),
    adminPassword: required('adminPassword'),
    // The rotation window is persisted so a restart mid-rotation does not cut the clients
    // that have not been updated yet.
    previous: previousUntil === null ? null : previous,
    previousUntil: previous === null ? null : previousUntil,
  };
}

export function parseBind(v: unknown): BindMode | null {
  if (v === 'all' || v === 'loopback') return v;
  if (typeof v === 'string' && v.startsWith('iface:') && v.length > 'iface:'.length) return v as BindMode;
  return null;
}

/**
 * An old document, or an old client, that knows only `light`.
 *
 * A WHOLLY DEFAULT `light` yields NO devices, which is the correct reading of a fresh
 * install: `light.host: null` has always meant "no light", `makeDriver` returns undefined
 * and `NoopDriver` takes over. Any non-default field yields one row, so an operator who set
 * only a custom entity name does not silently lose it.
 */
function deviceFromLight(light: LightBlock, dflt: LightBlock): DeviceRow[] {
  const untouched =
    light.host === dflt.host &&
    light.entity === dflt.entity &&
    light.username === dflt.username &&
    light.password === dflt.password;
  if (untouched) return [];
  return [
    {
      id: 'primary',
      label: 'On-air light',
      host: light.host,
      entity: light.entity,
      username: light.username,
      password: light.password,
      enabled: true,
      primary: true,
      order: 0,
    },
  ];
}

/**
 * Unlike `light`, which cannot produce an error at all, a device row is validated properly.
 * A typo in a device list is a thing an operator can now make, so it has to be catchable.
 */
function validateDevices(v: unknown[], fail: (m: string) => void): DeviceRow[] {
  const rows: DeviceRow[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of v.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      fail(`devices[${i}] must be an object`);
      continue;
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!ID_PATTERN.test(id)) {
      fail(`devices[${i}].id must match ${ID_PATTERN.source}`);
      continue;
    }
    if (seen.has(id)) {
      fail(`devices[${i}].id "${id}" is a duplicate`);
      continue;
    }
    seen.add(id);
    const label = typeof r.label === 'string' ? r.label : '';
    if (label.length < 1 || label.length > 64) fail(`devices[${i}].label must be 1..64 characters`);
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') fail(`devices[${i}].enabled must be a boolean`);
    if (r.primary !== undefined && typeof r.primary !== 'boolean') fail(`devices[${i}].primary must be a boolean`);
    const order = typeof r.order === 'number' && Number.isInteger(r.order) && r.order >= 0 && r.order <= 999 ? r.order : null;
    if (order === null) fail(`devices[${i}].order must be an integer 0-999`);
    rows.push({
      id,
      label,
      host: strOrNull(r.host),
      entity: typeof r.entity === 'string' && r.entity !== '' ? r.entity : DEFAULT_ENTITY,
      username: strOrNull(r.username),
      password: strOrNull(r.password),
      enabled: r.enabled !== false,
      primary: r.primary === true,
      order: order ?? 0,
    });
  }

  // AN EMPTY LIST IS LEGAL and means no light - today's behaviour when `light.host` is null.
  // Requiring a primary unconditionally would make a fresh install fail validation before
  // its first device has been typed in.
  if (rows.length === 0) return rows;

  const primaries = rows.filter((r) => r.primary);
  if (primaries.length === 0) fail('exactly one device must be primary - it is the one `confirmed` describes');
  else if (primaries.length > 1)
    fail(`exactly one device must be primary, got ${primaries.length}: ${primaries.map((r) => r.id).join(', ')}`);
  // A DISABLED PRIMARY IS A CONTRADICTION, not a preference: it is the row `confirmed`
  // describes, so switching it off would leave `confirmed` describing a panel the server has
  // agreed never to write to.
  else if (!primaries[0]!.enabled) fail(`the primary device "${primaries[0]!.id}" cannot be disabled`);
  return rows;
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
    // On the route, an UNSET shortcut is a `409` and one naming a row that does not exist is
    // a `400` from `checkState` - two different codes, and this comment used to claim both
    // were the `409`. Here it is neither: it is a save-time error, because the owner is
    // looking at the UI and can fix it now.
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
