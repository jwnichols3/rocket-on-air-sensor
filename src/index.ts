import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.ONAIR_PORT ?? 8484);
const stateFile = process.env.ONAIR_STATE_FILE ?? join(homedir(), '.onair', 'state.json');
const token = process.env.ONAIR_TOKEN;

const app = await createApp({ port, stateFile, token });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
