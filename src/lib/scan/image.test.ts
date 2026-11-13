/**
 * Pure pixel preprocessing (WO-001, D14): crop safety, flattening, printed-row detection.
 * Synthetic pixel arrays only.
 */
import { describe, expect, it } from "vitest";
import {
  detectPaperBounds,
  flattenIllumination,
  inkRowProfile,
  PARTLY_READ_SHARE,
  unreadPrintShare,
  widenRowsToPaper,
  type Pixels,
} from "./image";

/** A grey image built from a function of (x, y) → grey level. */
function grey(w: number, h: number, f: (x: number, y: number) => number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = f(x, y);
      data[p + 3] = 255;
    }
  return { data, width: w, height: h };
}

/** Thin dark "text" strokes every 20 rows, on the paper's middle columns. */
const isText = (x: number, y: number, x0: number, x1: number) =>
  x > x0 + 10 && x < x1 - 10 && y % 20 < 3 && x % 7 < 4;

const W = 200;
const H = 400;
const PAPER = { x0: 60, x1: 140, y0: 20, y1: 380 };
const onPaper = (x: number, y: number) =>
  x >= PAPER.x0 && x < PAPER.x1 && y >= PAPER.y0 && y < PAPER.y1;

/** Dark background, bright paper with text; `shade(y)` darkens paper and background alike. */
function receiptPhoto(shade: (y: number) => number): Pixels {
  return grey(W, H, (x, y) => {
    const base = onPaper(x, y) ? (isText(x, y, PAPER.x0, PAPER.x1) ? 30 : 220) : 35;
    return Math.round(base * shade(y));
  });
}

/** A shadow band across the lower part of the photo (paper and background alike). */
const shadowBand = (y: number) => (y >= 160 && y < 300 ? 0.38 : 1);

describe("detectPaperBounds: the crop never cuts the paper (D14)", () => {
  it("finds the paper of an even-lit photo, with a margin, unchanged by the safety check", () => {
    const r = detectPaperBounds(receiptPhoto(() => 1))!;
    expect(r).not.toBeNull();
    expect(r.x).toBeLessThanOrEqual(PAPER.x0);
    expect(r.x + r.width).toBeGreaterThanOrEqual(PAPER.x1);
    expect(r.y).toBeLessThanOrEqual(PAPER.y0);
    expect(r.y + r.height).toBeGreaterThanOrEqual(PAPER.y1);
    // The margin stays small: the crop does not run on into the background.
    expect(r.y + r.height).toBeLessThanOrEqual(PAPER.y1 + 12);
    expect(r.width).toBeLessThan(W * 0.6);
  });

  it("keeps the paper (and its text) below a shadow band across the photo", () => {
    const r = detectPaperBounds(receiptPhoto(shadowBand))!;
    expect(r).not.toBeNull();
    expect(r.y + r.height).toBeGreaterThanOrEqual(PAPER.y1); // the text below the shadow stays
    expect(r.y + r.height).toBeLessThanOrEqual(PAPER.y1 + 12);
  });

  it("refuses a row run that would cut the paper: it is widened to the paper's end", () => {
    // Downsampled grid as detectPaperBounds builds it (step 1 at this size).
    const img = receiptPhoto(shadowBand);
    const g = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = img.data[i * 4]!;
    // A run that stops where the shadow starts (what the global threshold alone finds).
    const [top, bottom] = widenRowsToPaper(g, W, H, [PAPER.x0, PAPER.x1 - 1], [PAPER.y0, 159]);
    expect(top).toBeLessThanOrEqual(PAPER.y0);
    expect(bottom).toBeGreaterThanOrEqual(PAPER.y1 - 4);
    expect(bottom).toBeLessThan(PAPER.y1 + 4); // never into the background below
  });

  it("does not widen into background beyond the paper", () => {
    const img = receiptPhoto(() => 1);
    const g = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = img.data[i * 4]!;
    const run: [number, number] = [PAPER.y0, PAPER.y1 - 1];
    expect(widenRowsToPaper(g, W, H, [PAPER.x0, PAPER.x1 - 1], run)).toEqual(run);
  });

  it("drops the crop on a side where no background beside the paper can be measured", () => {
    // Paper across the full width: nothing proves the rows beyond the run are background.
    const img = grey(W, H, (x, y) => (y >= 20 && y < 380 ? 220 : 35));
    const g = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = img.data[i * 4]!;
    expect(widenRowsToPaper(g, W, H, [0, W - 1], [20, 200])).toEqual([0, H - 1]);
  });

  it("drops the crop when the widened paper fills almost the whole photo", () => {
    const img = grey(W, H, (x, y) => {
      const paper = x >= 4 && x < W - 4;
      return Math.round((paper ? 220 : 35) * shadowBand(y));
    });
    expect(detectPaperBounds(img)).toBeNull();
  });
});

describe("flattenIllumination", () => {
  it("leaves an even-lit page even (within tolerance)", () => {
    const out = flattenIllumination(
      grey(60, 60, () => 200),
      6,
    );
    const values = new Set<number>();
    for (let i = 0; i < 60 * 60; i++) values.add(out.data[i * 4]!);
    for (const v of values) expect(Math.abs(v - 234)).toBeLessThanOrEqual(2);
  });

  it("brings shadowed paper up to the same level as lit paper, keeping ink dark", () => {
    const img = grey(120, 120, (x, y) => {
      const ink = y % 20 < 2 && x % 5 < 3;
      return Math.round((ink ? 40 : 210) * (y >= 60 ? 0.4 : 1));
    });
    const out = flattenIllumination(img, 10);
    const at = (x: number, y: number) => out.data[(y * 120 + x) * 4]!;
    expect(Math.abs(at(4, 30) - at(4, 90))).toBeLessThanOrEqual(10); // paper, lit vs shadow
    expect(at(0, 100)).toBeLessThan(110); // ink in the shadow stays ink
  });
});

describe("printed rows and the partly-read check (D14)", () => {
  const page = grey(100, 200, (x, y) => (y % 20 < 4 && x > 20 && x < 80 && x % 4 < 2 ? 20 : 235));

  it("marks rows holding print, ignoring the outer 10% of each side", () => {
    const rows = inkRowProfile(page);
    expect(rows[0]).toBe(1);
    expect(rows[10]).toBe(0);
    const edgeOnly = grey(100, 10, (x) => (x < 8 || x > 92 ? 0 : 235));
    expect([...inkRowProfile(edgeOnly)].every((v) => v === 0)).toBe(true);
  });

  it("measures the share of printed rows no word covers", () => {
    const rows = inkRowProfile(page);
    const words = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ y0: i * 20, y1: i * 20 + 4 }));
    expect(unreadPrintShare(rows, words(10))).toBe(0); // every printed row read
    expect(unreadPrintShare(rows, words(2))).toBeGreaterThanOrEqual(PARTLY_READ_SHARE); // stops early
    expect(unreadPrintShare(new Uint8Array(5), words(1))).toBe(0); // nothing printed
  });
});
