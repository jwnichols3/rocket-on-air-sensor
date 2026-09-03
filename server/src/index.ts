#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { loadEnvOverlay } from './config.js';

/**
 * `config.env` has RETIRED as the config source (D-36). `~/.onair/config.json` holds the
 * document now. The env file survives as an **overlay** and nothing more, because a real
 * environment variable winning over the file is D-14's rule and the documented way to
 * unbrick a box over SSH.
 */
loadEnvOverlay();

const home = join(homedir(), '.onair');
const configFile = process.env.ONAIR_CONFIG_FILE ?? join(home, 'config.json');
const stateFile = process.env.ONAIR_STATE_FILE ?? join(home, 'state.json');

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    console.error(`ONAIR_PORT must be an integer 1-65535, got: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return Number(raw);
}

const token = process.env.ONAIR_TOKEN;
if (token !== undefined && token.trim() === '') {
  console.error('[onair] ONAIR_TOKEN is set but empty - either unset it (no auth) or provide a real token');
  process.exit(1);
}

const app = await createApp({
  configFile,
  stateFile,
  port: parsePort(process.env.ONAIR_PORT),
  token,
  // On a host upgrading from config.env, the first boot lifts the device settings out of
  // the env file and into the document, which is where they live from now on (D-36). The
  // env file keeps working as an overlay, so nothing breaks if this is wrong.
  seedConfig: (base) => ({
    ...base,
    port: parsePort(process.env.ONAIR_PORT) ?? base.port,
    light: {
      host: process.env.ONAIR_LIGHT_HOST ?? base.light.host,
      entity: process.env.ONAIR_LIGHT_ENTITY ?? base.light.entity,
      username: process.env.ONAIR_LIGHT_USER ?? base.light.username,
      password: process.env.ONAIR_LIGHT_PASS ?? base.light.password,
    },
  }),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
