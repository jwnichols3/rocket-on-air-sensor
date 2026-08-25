import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  defaultState,
  higher,
  isLevel,
  isOnAirState,
  levelToOnOff,
  type Level,
  type OnAirState,
  type PersistedState,
} from './state.js';

/**
 * Read the state file.
 *
 * Returns `null` only for a genuine first boot (ENOENT). Anything unreadable is
 * quarantined and replaced by `defaultState()` - which is `dnd`, the safe rung -
 * rather than thrown. Throwing was never loud: `src/index.ts` has no try/catch, so
 * launchd restarts forever and every surface that could report the problem is down.
 */
export async function loadState(file: string): Promise<OnAirState | null> {
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
  if (!isOnAirState(parsed)) return quarantine(file, raw, 'invalid shape');

  const p = parsed as { level?: unknown; intended?: unknown; hold?: unknown; message?: string | null };
  // Reconcile on the ladder, never by precedence. A rolled-back binary spreads a stale
  // `level` through untouched while writing a fresh `intended`, so preferring `level`
  // is a false-GREEN generator. But `intended` is only three-valued-blind evidence:
  // when the two AGREE the file is self-consistent and `level` is authoritative, which
  // is the only way `interruptible` survives a restart. Take the higher rung solely
  // when they contradict each other.
  const fromLevel: Level = isLevel(p.level) ? p.level : 'available';
  const fromLegacy: Level = p.intended === 'on' ? 'dnd' : 'available';
  const agree = p.intended === undefined || levelToOnOff(fromLevel) === p.intended;
  return {
    ...(parsed as OnAirState),
    level: agree ? fromLevel : higher(fromLevel, fromLegacy),
    // A file records intent, never evidence about the device. Confirmation is re-earned
    // by a real read at boot.
    confirmed: 'unknown',
    hold: p.hold === 'interruptible' || p.hold === 'dnd' ? p.hold : null,
    message: p.message ?? null,
  };
}

async function quarantine(file: string, raw: string, why: string): Promise<OnAirState> {
  const dest = `${file}.corrupt-${Date.now()}`;
  await writeFile(dest, raw, 'utf8').catch(() => {});
  const s = defaultState();
  s.source = 'recovered';
  s.message = `state file was ${why}; quarantined to ${dest}`;
  return s;
}

export async function saveState(file: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
