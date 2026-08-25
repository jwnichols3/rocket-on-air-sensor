import { timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Two credentials, two audiences, and NEITHER is accepted on the other's routes (D-35).
 *
 * The passphrase says "you may read and write state." The admin session says "you may
 * reconfigure the system, including rotating the passphrase." That is a sharpening of D-27,
 * not a reversal: D-27 rejected splitting the *data* credential into read and write halves,
 * and that still stands - there is one passphrase, no read/write split.
 */
export type Audience = 'data' | 'admin';

/** D-43: a fixed default, Rocket's call, overriding D-35's recommendation of a random one. */
export const DEFAULT_PASSPHRASE = 'onair';
/** D-35: literally as spoken, with the exposure explained and accepted. */
export const DEFAULT_ADMIN_USER = 'rocket';
export const DEFAULT_ADMIN_PASSWORD = 'ESP32';

/** How long a rotated passphrase keeps working. Turns a simultaneous outage into a walk. */
export const ROTATION_GRACE_MS = 60 * 60 * 1000;
/** Sessions are in memory only; a restart logs everyone out and at home that is invisible. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthBlock {
  passphrase: string;
  /** The passphrase this one replaced, honoured until `previousUntil`. */
  previous: string | null;
  /** Epoch ms. Null when there is no rotation in flight. */
  previousUntil: number | null;
  adminUser: string;
  adminPassword: string;
}

export function defaultAuth(): AuthBlock {
  return {
    passphrase: DEFAULT_PASSPHRASE,
    previous: null,
    previousUntil: null,
    adminUser: DEFAULT_ADMIN_USER,
    adminPassword: DEFAULT_ADMIN_PASSWORD,
  };
}

/** True when either credential is still at its shipped value, so the UI can nag (D-43). */
export function changeMeNags(auth: AuthBlock): { passphrase: boolean; adminPassword: boolean } {
  return {
    passphrase: auth.passphrase === DEFAULT_PASSPHRASE,
    adminPassword: auth.adminPassword === DEFAULT_ADMIN_PASSWORD,
  };
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Early length-mismatch return leaks length via timing - accepted for this LAN threat
  // model. timingSafeEqual throws on a length mismatch, and unequal lengths are not a match.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Does this passphrase open the door? Accepts the previous one inside the grace window.
 *
 * Rotating the passphrase breaks every hand-configured machine client at once - the ESP32,
 * Companion, the detector. That is inherent and not fixable. The grace window converts a
 * simultaneous outage into a walk around the house.
 */
export function passphraseAccepted(auth: AuthBlock, presented: string, now = Date.now()): boolean {
  if (timingSafeStringEqual(presented, auth.passphrase)) return true;
  if (auth.previous === null || auth.previousUntil === null || now >= auth.previousUntil) return false;
  return timingSafeStringEqual(presented, auth.previous);
}

/**
 * Merge an incoming auth block over the live one, starting the grace window if - and only
 * if - the passphrase actually changed.
 *
 * It takes and returns whole BLOCKS rather than a passphrase, deliberately. An earlier
 * version took the new passphrase and returned `{...liveAuth, passphrase}`, which quietly
 * discarded any admin credential change in the same save: submitting a new admin password
 * appeared to succeed, persisted the OLD one, and left the sessions alone. Anything that
 * merges credentials has to merge all of them or none.
 *
 * The rotation window is carried forward when nothing rotated, so a client submitting a
 * stale document cannot end someone else's grace period as a side effect.
 */
export function rotate(live: AuthBlock, next: AuthBlock, now = Date.now()): AuthBlock {
  if (next.passphrase === live.passphrase) {
    return { ...next, previous: live.previous, previousUntil: live.previousUntil };
  }
  return { ...next, previous: live.passphrase, previousUntil: now + ROTATION_GRACE_MS };
}

// --------------------------------------------------------------- the waiver

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return a === '::1' || a === '127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Split "host:port" or "[::1]:port" without inventing a URL parser. */
function splitHostPort(value: string): { host: string; port: string | null } {
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return { host: value, port: null };
    const rest = value.slice(close + 1);
    return { host: value.slice(0, close + 1), port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const colon = value.lastIndexOf(':');
  if (colon === -1) return { host: value, port: null };
  return { host: value.slice(0, colon), port: value.slice(colon + 1) };
}

/**
 * D-24, IMPLEMENTED VERBATIM. The credential is waived only when the connection is from
 * loopback **and** `Host` names a loopback name on our port **and** `Origin` is absent or
 * exactly one of ours - **and never** when `Sec-Fetch-Site` is present and is anything
 * other than `same-origin` or `none`.
 *
 * Every clause is load-bearing, and two of them exist because of a MEASURED attack:
 *
 *  1. A page served from another address performed a CORS-simple `POST` against a loopback
 *     port. The server saw `remote: 127.0.0.1` with `origin: http://10.42.14.189:9099`. A
 *     `remoteAddress` check alone passes that attack, which is why the owner's original
 *     "it is localhost, so that is not a security hole" is false.
 *  2. Repeating it from a different PORT on the same host returned
 *     `Sec-Fetch-Site: same-site` - so rejecting only `cross-site` also fails, because a
 *     port is not part of a "site". `Origin` was present and wrong in both cases.
 *
 * Explicitly NOT protected: malware already running as this user (it can read the config
 * file and take the passphrase, so demanding one buys nothing) and a second human account
 * on this Mac (accepted; single-user machine - revisit if that changes).
 */
export function waiverApplies(req: IncomingMessage, ourPort: number): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) return false;

  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string') return false;
  const { host, port } = splitHostPort(hostHeader);
  if (!LOOPBACK_HOSTNAMES.has(host.toLowerCase())) return false;
  // A Host naming our loopback name but ANOTHER port is not us.
  if (port !== null && port !== String(ourPort)) return false;
  if (port === null && ourPort !== 80) return false;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return false;
    const originPort = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port;
    if (originPort !== String(ourPort)) return false;
  }

  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  return true;
}

// -------------------------------------------------------------- sessions

/**
 * In-memory admin sessions, 12 hours, sliding. NO COOKIE (D-35): a cookie brings CSRF back
 * into scope on a server whose write routes are deliberately CORS-simple. A header cannot
 * be forged cross-origin without a preflight, so CSRF on admin routes is structurally
 * impossible rather than defended against.
 *
 * Cost: a page refresh logs you out. At home that is invisible - the SPA re-establishes
 * under the D-24 waiver with no prompt.
 */
export class SessionStore {
  private readonly sessions = new Map<string, number>();

  constructor(private readonly ttlMs: number = SESSION_TTL_MS) {}

  create(now = Date.now()): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.sessions.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** Valid? And if so, slide the expiry forward. */
  validate(token: string, now = Date.now()): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (now >= expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    this.sessions.set(token, now + this.ttlMs);
    return true;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }

  /** Every session dies. Used by a rotation of the admin password and by factory reset. */
  destroyAll(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * The bearer value on a request, from the header or the documented query fallbacks.
 *
 * The query fallbacks are accepted on **GET only**, deliberately. They exist for the three
 * places a header is impossible - `EventSource`, the WebSocket upgrade, a remote kiosk
 * navigation - and all three are GETs. Allowing them on a write would put the credential in
 * server logs and browser history for the sake of nothing that needs it.
 *
 * `?token=` is the deprecated alias, accepted so nothing on the LAN breaks the day the
 * passphrase lands.
 */
export function presentedCredential(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  if ((req.method ?? 'GET') !== 'GET') return null;
  return url.searchParams.get('passphrase') ?? url.searchParams.get('token');
}
