/**
 * Rebuilds receipt rows from word positions. Pure (no DOM/SDK).
 *
 * Engines often split one printed row into two text lines when the photo is slightly skewed or the
 * price sits far to the right. Grouping words by vertical position (following the row's slope)
 * keeps "ITEM ........ 7.80" together. Wide horizontal gaps become two spaces, so the parser can
 * see column boundaries (description | qty | unit price | total).
 */
import type { OcrPage, OcrWord } from "./types";

export const COLUMN_GAP = "  ";

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const yc = (w: OcrWord) => (w.bbox.y0 + w.bbox.y1) / 2;

/** Groups words into rows, top to bottom, left to right. */
export function groupRows(words: OcrWord[]): OcrWord[][] {
  const ws = words.filter((w) => w.text.trim() && w.bbox.x1 > w.bbox.x0 && w.bbox.y1 > w.bbox.y0);
  if (!ws.length) return [];
  const h = median(ws.map((w) => w.bbox.y1 - w.bbox.y0)) || 1;
  const tol = h * 0.55;
  const rows: OcrWord[][] = [];
  for (const w of [...ws].sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
    // Compare with the row's nearest word on the left so gently sloping rows stay together.
    let best: { row: OcrWord[]; d: number } | null = null;
    for (const row of rows) {
      const last = row[row.length - 1]!;
      if (last.bbox.x1 > w.bbox.x0 + h * 0.3) continue; // would overlap an existing word
      const d = Math.abs(yc(last) - yc(w));
      if (d <= tol && (!best || d < best.d)) best = { row, d };
    }
    if (best) best.row.push(w);
    else rows.push([w]);
  }
  return rows.sort((a, b) => median(a.map(yc)) - median(b.map(yc)));
}

/** Joins a row's words, marking wide gaps as column boundaries. */
export function rowText(row: OcrWord[]): string {
  const h = median(row.map((w) => w.bbox.y1 - w.bbox.y0)) || 1;
  let out = "";
  for (let i = 0; i < row.length; i++) {
    const w = row[i]!;
    if (i > 0) out += w.bbox.x0 - row[i - 1]!.bbox.x1 > h * 1.2 ? COLUMN_GAP : " ";
    out += w.text.trim();
  }
  return out;
}

/** Reading-order lines for the parser. Falls back to the engine's text when no word boxes exist. */
export function pageToLines(page: OcrPage): string[] {
  const rows = groupRows(page.words);
  if (rows.length) return rows.map(rowText).filter(Boolean);
  return page.text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, "").replace(/^\s+/, ""))
    .filter(Boolean);
}
