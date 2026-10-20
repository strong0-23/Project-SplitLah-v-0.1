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

export interface Rect { x: number; y: number; width: number; height: number }

function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** Longest contiguous run of indices whose value passes `min`, tolerating short gaps. */
function longestRun(frac: Float32Array, min: number, gap: number): [number, number] | null {
  let best: [number, number] | null = null, start = -1, lastOk = -1;
  for (let i = 0; i <= frac.length; i++) {
    const ok = i < frac.length && frac[i]! >= min;
    if (ok) { if (start < 0) start = i; lastOk = i; }
    else if (start >= 0 && (i - lastOk > gap || i === frac.length)) {
      if (!best || lastOk - start > best[1] - best[0]) best = [start, lastOk];
      start = -1;
    }
  }
  return best;
}

/**
 * Finds the bright paper region against a darker background. Returns null when no clear
 * paper/background separation exists (e.g. the photo is already tightly cropped).
 */
export function detectPaperBounds(src: Pixels): Rect | null {
  const { width: w, height: h, data } = src;
  const step = Math.max(1, Math.round(Math.max(w, h) / 400));
  const sw = Math.floor(w / step), sh = Math.floor(h / step);
  const g = new Uint8Array(sw * sh);
  const hist = new Uint32Array(256);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const p = (y * step * w + x * step) * 4;
    const v = Math.round(0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!);
    g[y * sw + x] = v;
    hist[v]!++;
  }
  const thr = otsu(hist, sw * sh);
  const cols = new Float32Array(sw);
  for (let x = 0; x < sw; x++) { let c = 0; for (let y = 0; y < sh; y++) if (g[y * sw + x]! > thr) c++; cols[x] = c / sh; }
  const cr = longestRun(cols, 0.5, Math.ceil(sw * 0.02));
  if (!cr) return null;
  const rows = new Float32Array(sh);
  const cw = cr[1] - cr[0] + 1;
  for (let y = 0; y < sh; y++) { let c = 0; for (let x = cr[0]; x <= cr[1]; x++) if (g[y * sw + x]! > thr) c++; rows[y] = c / cw; }
  const rr = longestRun(rows, 0.3, Math.ceil(sh * 0.06));
  if (!rr) return null;
  const pad = Math.round(Math.max(w, h) * 0.015);
  const x0 = Math.max(0, cr[0] * step - pad), x1 = Math.min(w, (cr[1] + 1) * step + pad);
  const y0 = Math.max(0, rr[0] * step - pad), y1 = Math.min(h, (rr[1] + 1) * step + pad);
  const area = ((x1 - x0) * (y1 - y0)) / (w * h);
  if (area < 0.15 || area > 0.92) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

