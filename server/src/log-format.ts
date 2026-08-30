// The two log helpers the driver wrote for D-109's edge logging, shared because the
// supervisor now logs edges too (#84) and a second copy of `humanMs` would drift.

/**
 * A timestamp on the line, because nothing else in this log has one and "when did the panel
 * go away" is the first question anyone asks of a device whose whole job is to be current.
 *
 * Deliberately only on the edge lines rather than on every line the service emits. Stamping
 * the sink would be the better log and it is a different change - it rewrites the output of
 * every component and the deploy tests that read it. An edge line that is stamped also
 * anchors the unstamped lines around it, which is most of the value for a tenth of the
 * blast radius.
 */
export function stamp(): string {
  return new Date().toISOString();
}

/** Coarse on purpose: "3h 2m" answers the question, "10932847ms" makes the reader do sums. */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
