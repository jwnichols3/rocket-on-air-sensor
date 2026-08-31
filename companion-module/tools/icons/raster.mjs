// A tiny software rasteriser and PNG writer, so button art is GENERATED rather than pasted
// in as opaque base64 (#92).
//
// WHY NOT A LIBRARY. The art has to be regenerable: the ink colour of every icon is chosen
// from the background it will actually sit on, and those backgrounds come from the server's
// state table, which the owner edits. A PNG committed by hand goes stale the moment somebody
// changes a row's colour, and nothing would say so. This file plus `icons.mjs` is the whole
// toolchain, it is build-time only, and it adds no runtime dependency to the module.
//
// Everything is drawn 4x oversampled and box-downsampled at the end, which is where the
// antialiasing comes from - there is no per-primitive coverage maths anywhere below.

import { deflateSync } from 'node:zlib';

export const SCALE = 4;

export function rgba(r, g, b, a = 255) {
  return { r, g, b, a };
}

export const WHITE = rgba(255, 255, 255);
export const BLACK = rgba(0, 0, 0);

/** Relative luminance, WCAG 2.1. */
export function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two opaque colours. 1 = identical, 21 = black on white. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The ink that reads best ON `bg`.
 *
 * THIS IS THE FIX FOR THE UNREADABLE INTERRUPT BUTTON (#92). The row's own `color` is what
 * the table's owner chose for the row's own `bgcolor`; drawing it on the DIMMED background a
 * resting preset uses is a different question with a different answer, and for
 * INTERRUPTIBLE - #1a1a1a on amber quartered to #3a2905 - the answer was 1.4:1. Never assume;
 * measure against the background actually in use.
 */
export function inkFor(bg) {
  return contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
}

/** #rrggbb -> {r,g,b,a}. */
export function hex(s, fallback = BLACK) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s ?? ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return rgba((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** Scale a colour toward black. The module's `dim()` is >>2; this matches it exactly. */
export function dim(c) {
  return rgba(c.r >> 2, c.g >> 2, c.b >> 2, c.a);
}

/** Blend `fg` over an opaque `bg`, so contrast can be measured on translucent ink. */
export function over(fg, bg) {
  const a = fg.a / 255;
  return rgba(
    Math.round(fg.r * a + bg.r * (1 - a)),
    Math.round(fg.g * a + bg.g * (1 - a)),
    Math.round(fg.b * a + bg.b * (1 - a)),
  );
}

class Canvas {
  constructor(size) {
    this.size = size;
    this.w = size * SCALE;
    this.h = size * SCALE;
    // Straight (non-premultiplied) RGBA, matching what the PNG wants.
    this.buf = new Uint8ClampedArray(this.w * this.h * 4);
  }

  /**
   * Paint every subpixel for which `inside(x, y)` is true, in canvas units.
   *
   * `color === null` ERASES instead - it is destination-out, and it is how a crescent is cut
   * out of a disc. Without it every hollow shape would have to be filled with the background
   * colour, which is wrong the instant the art is composited onto a button whose colour a
   * feedback has changed.
   */
  paint(inside, color) {
    const { w, h, buf } = this;
    for (let py = 0; py < h; py++) {
      const y = (py + 0.5) / SCALE;
      for (let px = 0; px < w; px++) {
        const x = (px + 0.5) / SCALE;
        if (!inside(x, y)) continue;
        const i = (py * w + px) * 4;
        if (color === null) {
          buf[i + 3] = 0;
          continue;
        }
        const sa = color.a / 255;
        const da = buf[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) {
          buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
          continue;
        }
        buf[i] = (color.r * sa + buf[i] * da * (1 - sa)) / oa;
        buf[i + 1] = (color.g * sa + buf[i + 1] * da * (1 - sa)) / oa;
        buf[i + 2] = (color.b * sa + buf[i + 2] * da * (1 - sa)) / oa;
        buf[i + 3] = oa * 255;
      }
    }
    return this;
  }

  rect(x, y, w, h, color) {
    return this.paint((px, py) => px >= x && px < x + w && py >= y && py < y + h, color);
  }

  roundRect(x, y, w, h, r, color) {
    const rr = Math.min(r, w / 2, h / 2);
    return this.paint((px, py) => {
      if (px < x || px >= x + w || py < y || py >= y + h) return false;
      const cx = Math.min(Math.max(px, x + rr), x + w - rr);
      const cy = Math.min(Math.max(py, y + rr), y + h - rr);
      return (px - cx) ** 2 + (py - cy) ** 2 <= rr * rr;
    }, color);
  }

  circle(cx, cy, r, color) {
    return this.paint((px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r, color);
  }

  /** An annulus. `rIn` of 0 is just a disc. */
  ring(cx, cy, rOut, rIn, color) {
    return this.paint((px, py) => {
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      return d <= rOut * rOut && d >= rIn * rIn;
    }, color);
  }

  /** Part of an annulus. Angles in degrees, 0 = east, growing clockwise on screen. */
  arc(cx, cy, rOut, rIn, from, to, color) {
    const norm = (a) => ((a % 360) + 360) % 360;
    const a0 = norm(from);
    const span = norm(to - from) || 360;
    return this.paint((px, py) => {
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d > rOut * rOut || d < rIn * rIn) return false;
      const a = norm((Math.atan2(py - cy, px - cx) * 180) / Math.PI);
      return norm(a - a0) <= span;
    }, color);
  }

  /** Even-odd polygon fill. `pts` is [[x, y], ...]. */
  polygon(pts, color) {
    return this.paint((px, py) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, color);
  }

  /** A stroke of width `w`, with round caps unless `cap` is 'butt'. */
  line(x1, y1, x2, y2, w, color, cap = 'round') {
    const r = w / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    return this.paint((px, py) => {
      let t = ((px - x1) * dx + (py - y1) * dy) / len2;
      if (cap === 'butt') {
        if (t < 0 || t > 1) return false;
      } else {
        t = Math.min(1, Math.max(0, t));
      }
      const qx = x1 + t * dx;
      const qy = y1 + t * dy;
      return (px - qx) ** 2 + (py - qy) ** 2 <= r * r;
    }, color);
  }

  /** Downsample SCALE:1 and encode. Alpha is kept - the button's colour shows through. */
  toPng() {
    return encodePng(this.toRgba(), this.size, this.size);
  }

  /** The finished art as straight RGBA at 1:1, which is what both the PNG and the sheet want. */
  toRgba() {
    const { size, w, buf } = this;
    const out = Buffer.alloc(size * size * 4);
    const n = SCALE * SCALE;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            const i = ((y * SCALE + sy) * w + (x * SCALE + sx)) * 4;
            const sa = buf[i + 3] / 255;
            // Premultiply before averaging, or a transparent black subpixel drags the colour
            // of its neighbours toward black and every edge gets a dark fringe.
            r += buf[i] * sa;
            g += buf[i + 1] * sa;
            b += buf[i + 2] * sa;
            a += sa;
          }
        }
        const o = (y * size + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
        }
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
    return out;
  }

}

export function createCanvas(size = 72) {
  return new Canvas(size);
}

// ---- PNG ---------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(rgbaBuf, width, height) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgbaBuf.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
