#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { EsphomeTextDriver } from './esphome-driver.js';

loadConfig();

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 8484;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    console.error(`ONAIR_PORT must be an integer 1-65535, got: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return Number(raw);
}

const port = parsePort(process.env.ONAIR_PORT);
const stateFile = process.env.ONAIR_STATE_FILE ?? join(homedir(), '.onair', 'state.json');
const token = process.env.ONAIR_TOKEN;
if (token !== undefined && token.trim() === '') {
  console.error('[onair] ONAIR_TOKEN is set but empty - either unset it (no auth) or provide a real token');
  process.exit(1);
}

// No ONAIR_LIGHT_HOST means the NoopDriver, i.e. unchanged behaviour.
const lightHost = process.env.ONAIR_LIGHT_HOST;
const driver = lightHost
  ? new EsphomeTextDriver({
      host: lightHost,
      entity: process.env.ONAIR_LIGHT_ENTITY ?? 'PresenceKey',
      username: process.env.ONAIR_LIGHT_USER,
      password: process.env.ONAIR_LIGHT_PASS,
    })
  : undefined;

const app = await createApp({ port, stateFile, token, driver });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
