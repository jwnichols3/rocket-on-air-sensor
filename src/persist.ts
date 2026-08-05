import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isOnAirState, type OnAirState } from './state.js';

export async function loadState(file: string): Promise<OnAirState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isOnAirState(parsed)) throw new Error(`state file ${file} has invalid shape`);
  return parsed;
}

export async function saveState(file: string, state: OnAirState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
