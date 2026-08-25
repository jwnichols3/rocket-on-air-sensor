import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Loads ONAIR_* config from an env file into process.env, if present.
 *
 * Resolution order for the file path: explicit `path` argument, then
 * `ONAIR_CONFIG`, then `~/.onair/config.env`. Real environment variables
 * already set always win over values in the file - that's how
 * `process.loadEnvFile` behaves, and this function does not fight it.
 *
 * A missing file is not an error (sensible defaults apply). Any other
 * failure (e.g. the path is a directory) is rethrown.
 */
export function loadConfig(path?: string): void {
  const resolved = path ?? process.env.ONAIR_CONFIG ?? join(homedir(), '.onair', 'config.env');
  try {
    process.loadEnvFile(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
