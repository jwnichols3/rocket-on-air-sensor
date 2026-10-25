import { readFileSync } from 'node:fs';

export interface BuildInfo {
  version: string | null;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string | null;
}

/** Read once from the build itself. The checkout may have moved since this process started. */
export function readBuildInfo(file = new URL('./build-info.json', import.meta.url)): BuildInfo {
  const unknown: BuildInfo = { version: null, commit: null, dirty: null, builtAt: null };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return unknown;
    return {
      version: typeof data.version === 'string' ? data.version : null,
      commit: typeof data.commit === 'string' && /^[0-9a-f]{40}$/.test(data.commit) ? data.commit : null,
      dirty: typeof data.dirty === 'boolean' ? data.dirty : null,
      builtAt: typeof data.builtAt === 'string' && Number.isFinite(Date.parse(data.builtAt)) ? data.builtAt : null,
    };
  } catch { return unknown; }
}

export const BUILD_INFO: Readonly<BuildInfo> = Object.freeze(readBuildInfo());
