import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultState, UNKNOWN_ID, type OnAirState, type PersistedState } from './state.js';

/**
 * The v1 ladder, mapped to v2 row ids, ONCE, on read.
 *
 * This is a migration, not a fallback. D-34's rule - an id that is not in the table
 * resolves to `unknown` - is right for a row the owner deleted, but wrong here: a v1 file
 * saying `dnd` is not a dangling reference, it is the same meaning in the old vocabulary,
 * and resolving it to NO DATA would flip a live panel to the fault appearance on the
 * upgrade restart. `dnd` and `on-air` are both `busy: true`, so the meaning is preserved.
 *
 * There is exactly one installed host, and this exists to carry its state file across that
 * one restart. It can be deleted once that has happened.
 */
const V1_LEVELS: Record<string, string> = {
  dnd: 'on-air',
  interruptible: 'interruptible',
  available: 'available',
};

/**
 * Read the state file.
 *
 * Returns `null` only for a genuine first boot (ENOENT). Anything unreadable is
 * quarantined and replaced by `defaultState()` - which is `unknown`, the conspicuous
 * state - rather than thrown. Throwing was never loud: `src/index.ts` has no try/catch,
 * so launchd restarts forever and every surface that could report the problem is down.
 */
export async function loadState(file: string, log: (line: string) => void = () => {}): Promise<OnAirState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return quarantine(file, raw, 'unparseable JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) return quarantine(file, raw, 'invalid shape');

  const p = parsed as Record<string, unknown>;
  if (typeof p.updatedAt !== 'string' || Number.isNaN(Date.parse(p.updatedAt))) {
    return quarantine(file, raw, 'invalid shape');
  }

  let state: string | undefined;
  let migratedFrom: string | undefined;
  if (typeof p.state === 'string' && p.state !== '') {
    state = p.state;
  } else if (typeof p.level === 'string' && V1_LEVELS[p.level] !== undefined) {
    state = V1_LEVELS[p.level];
    migratedFrom = p.level;
  } else if (p.intended === 'on' || p.intended === 'off') {
    // A file old enough to predate `level` entirely. `on` was never more specific than
    // "the camera may be live", which is exactly what `on-air` means.
    state = p.intended === 'on' ? 'on-air' : 'available';
    migratedFrom = `intended=${p.intended}`;
  }
  if (state === undefined) return quarantine(file, raw, 'invalid shape');
  if (migratedFrom !== undefined) {
    log(`[onair] migrated v1 state file: ${migratedFrom} -> ${state}`);
  }

  const holdRaw = p.hold;
  const hold = typeof holdRaw === 'string' && holdRaw !== '' ? (V1_LEVELS[holdRaw] ?? holdRaw) : null;

  return {
    state,
    // A file records intent, never evidence about the device. Confirmation is re-earned
    // by a real read at boot.
    confirmed: UNKNOWN_ID,
    hold,
    source: typeof p.source === 'string' ? p.source : 'human:boot',
    updatedAt: p.updatedAt,
    message: typeof p.message === 'string' ? p.message : null,
  };
}

async function quarantine(file: string, raw: string, why: string): Promise<OnAirState> {
  const dest = `${file}.corrupt-${Date.now()}`;
  await writeFile(dest, raw, 'utf8').catch(() => {});
  const s = defaultState();
  s.source = 'human:recovered';
  s.message = `state file was ${why}; quarantined to ${dest}`;
  return s;
}

export async function saveState(file: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
