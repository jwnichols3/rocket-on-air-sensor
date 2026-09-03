import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeviceRow } from './config-store.js';
import type { DeviceSpec } from './fanout-driver.js';

/**
 * Loads ONAIR_* values from an env file into process.env, if present.
 *
 * **This is an OVERLAY, not the config source.** `~/.onair/config.json` is the config
 * document (D-36); `config.env` retired as the source and survives only for this, because
 * a real environment variable winning over the file is D-14's rule and the documented way
 * to unbrick a box over SSH.
 *
 * Resolution order for the file path: explicit `path` argument, then `ONAIR_CONFIG`, then
 * `~/.onair/config.env`. Real environment variables already set always win over values in
 * the file - that's how `process.loadEnvFile` behaves, and this function does not fight it.
 *
 * A missing file is not an error (sensible defaults apply). Any other failure (e.g. the
 * path is a directory) is rethrown.
 */
export function loadEnvOverlay(path?: string): void {
  const resolved = path ?? process.env.ONAIR_CONFIG ?? join(homedir(), '.onair', 'config.env');
  try {
    process.loadEnvFile(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/** @deprecated Kept so existing callers and tests keep compiling. Use `loadEnvOverlay`. */
export const loadConfig = loadEnvOverlay;

// ---------------------------------------------------------------------------
// WHAT THE ENVIRONMENT IS OVERRIDING (D-79, #53)
//
// The overlay outranks the config document, deliberately - that is D-14's rule and the
// documented way to point a box at a different light over SSH when its own UI cannot be
// reached. The cost is that a field in the admin console can render a value the running
// service is ignoring: type a new address, stage it, save it, get a success, and the server
// carries on talking to the old one. Silently.
//
// `deploy/onair`'s `cmd_ui` already resolves the overlay first for exactly this reason, and
// deploy/test-ui.sh pins it with a test called "the overlay wins over the document". The
// resolution lived in three places and the web console had the only copy that got it wrong.
// It lives HERE now, once, and index.ts and the admin route both call it - which is the
// actual fix. Reporting the override is only how the page stops lying about it.

/** The env var that outranks each config key. Order is the order the console shows them. */
export const ENV_OVERRIDABLE: ReadonlyArray<{ key: string; variable: string }> = [
  { key: 'light.host', variable: 'ONAIR_LIGHT_HOST' },
  { key: 'light.entity', variable: 'ONAIR_LIGHT_ENTITY' },
  { key: 'light.username', variable: 'ONAIR_LIGHT_USER' },
  { key: 'light.password', variable: 'ONAIR_LIGHT_PASS' },
];

export type EnvOverride = { key: string; variable: string };

/**
 * Which config keys the environment is currently overriding.
 *
 * **NAMES ONLY, NEVER VALUES.** `ONAIR_LIGHT_PASS` is a device credential, and while this
 * travels on a gated route today, a list of names is useful to every caller and a list of
 * values is useful to none of them. There is no reason to put a secret on a wire that does
 * not need it.
 *
 * An empty string counts as unset: `ONAIR_LIGHT_HOST=` in the overlay file is someone
 * clearing it, not someone pointing the service at a host called "".
 */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): EnvOverride[] {
  return ENV_OVERRIDABLE.filter((o) => {
    const v = env[o.variable];
    return v !== undefined && v !== '';
  }).map((o) => ({ key: o.key, variable: o.variable }));
}

/**
 * Re-exported from the config document rather than redeclared: two structurally identical
 * types drift the moment one of them gains a field.
 */
export type { LightBlock } from './config-store.js';
type LightBlock = import('./config-store.js').LightBlock;

/**
 * The device settings the service is ACTUALLY using: the overlay over the document.
 *
 * The one place this precedence is expressed. index.ts builds its driver from this, and the
 * admin route reports the resulting host from it, so the console cannot drift from the
 * driver the way it did before.
 */
export function effectiveLight(light: LightBlock, env: NodeJS.ProcessEnv = process.env): LightBlock {
  const pick = (variable: string, fallback: string | null): string | null => {
    const v = env[variable];
    return v !== undefined && v !== '' ? v : fallback;
  };
  return {
    host: pick('ONAIR_LIGHT_HOST', light.host),
    entity: pick('ONAIR_LIGHT_ENTITY', light.entity) ?? light.entity,
    username: pick('ONAIR_LIGHT_USER', light.username),
    password: pick('ONAIR_LIGHT_PASS', light.password),
  };
}

/**
 * Every device the server should actually drive, with the env overlay applied.
 *
 * THE OVERLAY LANDS ON THE PRIMARY ROW AND NOWHERE ELSE. `ONAIR_LIGHT_HOST` is the
 * documented way to point a box at a different light over SSH when its own UI cannot be
 * reached (D-14), and "the light" in that sentence has always meant the one that matters.
 * Applying it to every row would repoint an entire wall at one address; applying it to none
 * would delete the escape hatch. Secondary devices are document-only.
 *
 * Rows with no address are dropped rather than driven, which is the list-shaped version of
 * `if (!light.host) return undefined` - a device somebody added but has not addressed yet is
 * not an error, it is an unfinished row.
 */
export function deviceSpecs(devices: DeviceRow[], env: NodeJS.ProcessEnv = process.env): DeviceSpec[] {
  return devices
    .filter((d) => d.enabled)
    .map((d) => {
      const conn = { host: d.host, entity: d.entity, username: d.username, password: d.password };
      // Taken from the ROW, not from `config.light`. `light` is a projection of this same
      // row so the two agree in any validated document - but deriving the primary's address
      // from the projection would mean a bug that let them drift silently repointed the one
      // panel that matters. The row is the truth; `light` is the view of it.
      const resolved = d.primary ? effectiveLight(conn, env) : conn;
      return { id: d.id, ...resolved, primary: d.primary };
    })
    .filter((s): s is DeviceSpec => s.host !== null && s.host !== '');
}
