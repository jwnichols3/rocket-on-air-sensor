// The surfaces the art has to survive, and the ink chosen for each of them.
//
// EVERY ICON IS DRAWN TWICE, once for the resting button and once for the lit one, because
// they are different backgrounds and the readable ink is not the same colour on both. The
// resting preset dims the row colour by >>2 (`dim()` in src/index.js); INTERRUPTIBLE's own
// #1a1a1a ink on that dimmed amber measures 1.23:1, which is the unreadable button in #92.
//
// The state colours are the shipped table (v11). They are a SNAPSHOT for the generator, not
// a second source of truth: `npm run icons` re-reads them from a live server when it can
// reach one, and falls back to this so the build works offline. If a row's colour is edited
// and the icons are not rebuilt, the art stays legible either way - it is monochrome ink
// chosen by contrast, and the two surfaces bracket everything between them.

import { dim, hex, inkFor } from './raster.mjs';

export const TABLE_FALLBACK = [
  { id: 'available', bgcolor: '#0b6e2e' },
  { id: 'on-air', bgcolor: '#c1121f' },
  { id: 'interruptible', bgcolor: '#e8a317' },
  { id: 'recording', bgcolor: '#6a0dad' },
  { id: 'unknown', bgcolor: '#1a1a1a' },
];

/// The two utility buttons are not table rows, so their colours live here. Deliberately
/// neutral: they are not states, and dressing them in state colours would say they were.
export const UTILITY = [
  { id: 'sleep', bgcolor: '#282828' },
  { id: 'wake', bgcolor: '#c8c8cd' },
  // The cycle button's RESTING colour only. In use it wears whatever row the deck is on, so
  // this row of the contact sheet under-states the job: judge that icon by looking down the
  // state rows, which are the backgrounds it actually gets painted onto (#93).
  { id: 'cycle', bgcolor: '#282828' },
];

/**
 * Every surface an icon must be legible on: the row at rest (dimmed) and the row lit.
 *
 * `unknown` is the exception and it is deliberate. Its background is already near-black, so
 * dimming it further changes nothing a human can see, and the reserved row is drawn in the
 * OWNER's colours by the `no_data` feedback (D-122) rather than in a dimmed version of them.
 */
export function surfaces(rows) {
  const out = [];
  for (const row of rows) {
    const lit = hex(row.bgcolor);
    out.push({ id: row.id, variant: 'lit', bg: lit, ink: inkFor(lit) });
    const rest = dim(lit);
    out.push({ id: row.id, variant: 'dim', bg: rest, ink: inkFor(rest) });
  }
  return out;
}

/** The icon names a variant must supply, in the order the contact sheet lays them out. */
export const ICON_NAMES = ['available', 'on-air', 'interruptible', 'recording', 'unknown', 'sleep', 'wake', 'cycle'];
