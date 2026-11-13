/**
 * Pure pixel preprocessing for OCR (no DOM). Works on RGBA buffers so it can be unit-tested and
 * reused from a canvas. Flattens uneven lighting (coloured casts, shadows, glare) by dividing each
 * pixel by a local background estimate, which keeps thin receipt strokes intact at full resolution.
 */
export interface Pixels {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

/** Luminance greyscale + illumination flattening. Returns a new RGBA buffer (grey in RGB). */
export function flattenIllumination(src: Pixels, radius?: number): Pixels {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const grey = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    grey[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  }
  const r = radius ?? Math.max(12, Math.round(Math.min(w, h) / 45));
  // Integral image for O(1) box means.
  const W1 = w + 1;
  const ii = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += grey[y * w + x]!;
      ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1]! + row;
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = ii[y1 * W1 + x1]! - ii[y0 * W1 + x1]! - ii[y1 * W1 + x0]! + ii[y0 * W1 + x0]!;
      const mean = sum / ((y1 - y0) * (x1 - x0)) + 1;
      const v = Math.min(255, (grey[y * w + x]! / mean) * 235);
      const p = (y * w + x) * 4;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0,
    wB = 0,
    best = 0,
    thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB,
      mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/** Longest contiguous run of indices whose value passes `min`, tolerating short gaps. */
function longestRun(frac: Float32Array, min: number, gap: number): [number, number] | null {
  let best: [number, number] | null = null,
    start = -1,
    lastOk = -1;
  for (let i = 0; i <= frac.length; i++) {
    const ok = i < frac.length && frac[i]! >= min;
    if (ok) {
      if (start < 0) start = i;
      lastOk = i;
    } else if (start >= 0 && (i - lastOk > gap || i === frac.length)) {
      if (!best || lastOk - start > best[1] - best[0]) best = [start, lastOk];
      start = -1;
    }
  }
  return best;
}

/** Median of a list of grey values (0..255) via a histogram. -1 when empty. */
function medianOf(values: Uint8Array, count: number): number {
  if (!count) return -1;
  const hist = new Uint32Array(256);
  for (let i = 0; i < count; i++) hist[values[i]!]!++;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v]!;
    if (seen * 2 >= count) return v;
  }
  return 255;
}

/** Paper is clearly brighter than the background beside it (also under a shadow or colour cast). */
export const PAPER_RATIO = 1.5;
export const PAPER_MIN_STEP = 24;

/**
 * Is the strip of rows [y0, y1) still paper between columns [x0, x1]? It is when its middle part is
 * clearly brighter than the background beside the crop in the same rows. A shadow darkens paper and
 * background alike, so the comparison holds across a shadow edge where a global threshold fails.
 * Returns null when there is too little background beside the crop to compare with: then nothing
 * proves the strip is background, so the caller keeps it. Pure.
 */
function rowsArePaper(
  g: Uint8Array,
  sw: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): boolean | null {
  const cw = x1 - x0 + 1;
  const margin = Math.max(1, Math.round(sw * 0.02));
  const ix0 = x0 + Math.floor(cw * 0.15);
  const ix1 = x1 - Math.floor(cw * 0.15);
  const inner = new Uint8Array((ix1 - ix0 + 1) * (y1 - y0));
  const beside = new Uint8Array(sw * (y1 - y0));
  let ni = 0;
  let nb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = ix0; x <= ix1; x++) inner[ni++] = g[y * sw + x]!;
    for (let x = 0; x < sw; x++)
      if (x < x0 - margin || x > x1 + margin) beside[nb++] = g[y * sw + x]!;
  }
  if (nb < Math.max(2, Math.round(sw * 0.03)) * (y1 - y0)) return null;
  const paper = medianOf(inner, ni);
  const bg = medianOf(beside, nb);
  return paper >= bg * PAPER_RATIO && paper - bg >= PAPER_MIN_STEP;
}

/**
 * Crop safety (WO-001, D14): a crop must never cut the paper, because text can only be on the paper.
 * From each end of the row run [top, bottom], strips beyond it are checked with `rowsArePaper`; while
 * they are still paper the run is widened, tolerating short gaps (a fold or a dense row of text).
 * When the paper fills the width, so no background beside it can be measured, a strip cannot be
 * shown to be background and the run is widened all the way (the crop is dropped on that side).
 * Works on the downsampled grey grid of `detectPaperBounds`. Pure; exported for tests.
 */
export function widenRowsToPaper(
  g: Uint8Array,
  sw: number,
  sh: number,
  cols: [number, number],
  rows: [number, number],
): [number, number] {
  const strip = Math.max(1, Math.round(sh * 0.01));
  const maxGap = Math.max(1, Math.round(sh * 0.03));
  const widen = (from: number, dir: 1 | -1): number => {
    let edge = from;
    let pos = from;
    for (;;) {
      const a = dir > 0 ? pos + 1 : Math.max(0, pos - strip);
      const b = dir > 0 ? Math.min(sh, pos + 1 + strip) : pos;
      if (a >= b) break;
      if (rowsArePaper(g, sw, cols[0], cols[1], a, b) !== false) {
        pos = dir > 0 ? b - 1 : a;
        edge = pos;
      } else {
        pos = dir > 0 ? b - 1 : a;
        if (Math.abs(pos - edge) > maxGap) break;
      }
    }
    return edge;
  };
  return [widen(rows[0], -1), widen(rows[1], 1)];
}

/**
 * Finds the bright paper region against a darker background. Returns null when no clear
 * paper/background separation exists (e.g. the photo is already tightly cropped).
 *
 * The row run found with the global threshold is then widened while the rows beyond it are still
 * paper (`widenRowsToPaper`), so a shadow band across the receipt never ends the crop early. If the
 * widened region covers almost the whole photo, there is no crop (null).
 */
export function detectPaperBounds(src: Pixels): Rect | null {
  const { width: w, height: h, data } = src;
  const step = Math.max(1, Math.round(Math.max(w, h) / 400));
  const sw = Math.floor(w / step),
    sh = Math.floor(h / step);
  const g = new Uint8Array(sw * sh);
  const hist = new Uint32Array(256);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const p = (y * step * w + x * step) * 4;
      const v = Math.round(0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!);
      g[y * sw + x] = v;
      hist[v]!++;
    }
  const thr = otsu(hist, sw * sh);
  const cols = new Float32Array(sw);
  for (let x = 0; x < sw; x++) {
    let c = 0;
    for (let y = 0; y < sh; y++) if (g[y * sw + x]! > thr) c++;
    cols[x] = c / sh;
  }
  const cr = longestRun(cols, 0.5, Math.ceil(sw * 0.02));
  if (!cr) return null;
  const rows = new Float32Array(sh);
  const cw = cr[1] - cr[0] + 1;
  for (let y = 0; y < sh; y++) {
    let c = 0;
    for (let x = cr[0]; x <= cr[1]; x++) if (g[y * sw + x]! > thr) c++;
    rows[y] = c / cw;
  }
  const found = longestRun(rows, 0.3, Math.ceil(sh * 0.06));
  if (!found) return null;
  const rr = widenRowsToPaper(g, sw, sh, cr, found);
  const pad = Math.round(Math.max(w, h) * 0.015);
  const x0 = Math.max(0, cr[0] * step - pad),
    x1 = Math.min(w, (cr[1] + 1) * step + pad);
  const y0 = Math.max(0, rr[0] * step - pad),
    y1 = Math.min(h, (rr[1] + 1) * step + pad);
  const area = ((x1 - x0) * (y1 - y0)) / (w * h);
  if (area < 0.15 || area > 0.92) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A flattened pixel this dark is ink (flattened paper sits near 235). */
export const INK_LEVEL = 110;

/**
 * Which rows of a flattened image hold print (WO-001, D14): a row is printed when enough pixels in
 * its middle 80% are ink-dark. The outer 10% on each side are left out, so a sliver of background
 * kept by the crop margin never counts. Returns one 0/1 per row. Pure.
 */
export function inkRowProfile(src: Pixels): Uint8Array {
  const { width: w, height: h, data } = src;
  const x0 = Math.floor(w * 0.1);
  const x1 = Math.ceil(w * 0.9);
  const need = Math.max(2, Math.round((x1 - x0) * 0.004));
  const out = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = x0; x < x1 && n < need; x++) if (data[(y * w + x) * 4]! < INK_LEVEL) n++;
    out[y] = n >= need ? 1 : 0;
  }
  return out;
}

/**
 * A reading is "partly read" when at least this share of the printed rows has no recognised word
 * (WO-001, D14). Logos, QR codes and barcodes are printed but hold no words, so the line is well
 * above what they take on a normal receipt.
 */
export const PARTLY_READ_SHARE = 0.35;

export interface WordBand {
  y0: number;
  y1: number;
}

/**
 * Share (0..1) of the printed rows that no recognised word covers. Each word covers its own rows
 * plus half a typical word height above and below (line spacing). 0 when nothing is printed. Pure.
 */
export function unreadPrintShare(inkRows: Uint8Array, words: readonly WordBand[]): number {
  const h = inkRows.length;
  let printed = 0;
  for (let y = 0; y < h; y++) printed += inkRows[y]!;
  if (!printed) return 0;
  const heights = words
    .map((b) => b.y1 - b.y0)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const pad = heights.length ? Math.ceil(heights[Math.floor(heights.length / 2)]! / 2) : 0;
  const covered = new Uint8Array(h);
  for (const b of words) {
    const a = Math.max(0, Math.floor(b.y0) - pad);
    const z = Math.min(h - 1, Math.ceil(b.y1) + pad);
    for (let y = a; y <= z; y++) covered[y] = 1;
  }
  let unread = 0;
  for (let y = 0; y < h; y++) if (inkRows[y] && !covered[y]) unread++;
  return unread / printed;
}
