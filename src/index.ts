import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';

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

const app = await createApp({ port, stateFile, token });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
