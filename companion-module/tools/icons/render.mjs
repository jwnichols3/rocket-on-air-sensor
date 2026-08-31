// Render one icon variant to PNGs and to a contact sheet.
//
//   node tools/icons/render.mjs <variant.mjs> <outdir>
//
// The sheet is the point: it puts every icon on BOTH the surface it rests on and the surface
// it lights up on, at true button size and again at 2x, so "is this readable" can be answered
// by looking rather than asserted. A judge that only ever sees the art on one background is
// the vacuous check this whole repo keeps re-learning about.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas, encodePng, rgba } from './raster.mjs';
import { ICON_NAMES, TABLE_FALLBACK, UTILITY, surfaces } from './palette.mjs';

const SIZE = 72;
const GUT = 14;
const PAGE = rgba(90, 90, 96); // mid grey: both a near-black tile and a near-white one show up

export function allSurfaces(rows = TABLE_FALLBACK) {
  return surfaces([...rows, ...UTILITY]);
}

/** One icon on one surface, as straight RGBA at 1:1. */
export function renderIcon(draw, surface, size = SIZE) {
  const c = createCanvas(size);
  draw(c, { ink: surface.ink, bg: surface.bg, size, surface: surface.variant, id: surface.id });
  return c;
}

function blit(page, pw, ph, rgbaBuf, sw, sh, ox, oy, bg, zoom = 1) {
  for (let y = 0; y < sh * zoom; y++) {
    for (let x = 0; x < sw * zoom; x++) {
      const i = (Math.floor(y / zoom) * sw + Math.floor(x / zoom)) * 4;
      const px = ox + x;
      const py = oy + y;
      if (px < 0 || py < 0 || px >= pw || py >= ph) continue;
      const a = rgbaBuf[i + 3] / 255;
      const j = (py * pw + px) * 4;
      page[j] = rgbaBuf[i] * a + bg.r * (1 - a);
      page[j + 1] = rgbaBuf[i + 1] * a + bg.g * (1 - a);
      page[j + 2] = rgbaBuf[i + 2] * a + bg.b * (1 - a);
      page[j + 3] = 255;
    }
  }
}

/**
 * A grid: one row per icon, columns [dim@72, lit@72, dim@144, lit@144].
 *
 * Row order is `ICON_NAMES` and NOTHING on the sheet says which row is which, on purpose -
 * these icons have to work with no words next to them, so a judge is told the order in
 * prose and has to match the picture to the meaning the same way an operator would.
 */
export function contactSheet(icons, rows = TABLE_FALLBACK) {
  const surf = allSurfaces(rows);
  const byId = new Map();
  for (const s of surf) byId.set(`${s.id}:${s.variant}`, s);

  const cols = [
    { zoom: 1, variant: 'dim' },
    { zoom: 1, variant: 'lit' },
    { zoom: 2, variant: 'dim' },
    { zoom: 2, variant: 'lit' },
  ];
  const rowH = SIZE * 2 + GUT;
  const pw = GUT + cols.reduce((a, c) => a + SIZE * c.zoom + GUT, 0);
  const ph = GUT + ICON_NAMES.length * rowH;
  const page = Buffer.alloc(pw * ph * 4);
  for (let i = 0; i < pw * ph; i++) {
    page[i * 4] = PAGE.r;
    page[i * 4 + 1] = PAGE.g;
    page[i * 4 + 2] = PAGE.b;
    page[i * 4 + 3] = 255;
  }

  ICON_NAMES.forEach((name, r) => {
    const draw = icons[name];
    if (!draw) throw new Error(`variant is missing an icon for "${name}"`);
    let x = GUT;
    const y = GUT + r * rowH;
    for (const col of cols) {
      const s = byId.get(`${name}:${col.variant}`);
      const art = renderIcon(draw, s).toRgba();
      blit(page, pw, ph, art, SIZE, SIZE, x, y, s.bg, col.zoom);
      x += SIZE * col.zoom + GUT;
    }
  });
  return encodePng(page, pw, ph);
}

export async function main() {
  const [variantPath, outDir] = process.argv.slice(2);
  if (!variantPath || !outDir) {
    console.error('usage: node render.mjs <variant.mjs> <outdir>');
    process.exit(2);
  }
  const mod = await import(resolve(variantPath));
  const icons = mod.ICONS ?? mod.default;
  mkdirSync(outDir, { recursive: true });
  for (const s of allSurfaces()) {
    if (!icons[s.id]) continue;
    writeFileSync(`${outDir}/${s.id}-${s.variant}.png`, renderIcon(icons[s.id], s).toPng());
  }
  writeFileSync(`${outDir}/sheet.png`, contactSheet(icons));
  console.log(`wrote ${outDir}/sheet.png`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
