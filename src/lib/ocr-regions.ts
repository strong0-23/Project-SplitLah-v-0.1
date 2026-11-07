export interface OcrWord {
  text: string; confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
export const normaliseOcrToken = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Locate a single descriptor in OCR geometry. Never locate an item using its price. */
export function itemRegion(words: OcrWord[], description: string, width: number, height: number) {
  const key = normaliseOcrToken(description);
  if (!width || !height || key.length < 8 || /^(?:grand\s+total|subtotal)\b/i.test(description)) return null;
  const usable = words.filter(w => normaliseOcrToken(w.text));
  const matches: OcrWord[][] = [];
  for (let start = 0; start < usable.length; start++) {
    let joined = "";
    for (let end = start; end < Math.min(usable.length, start + 14); end++) {
      joined += normaliseOcrToken(usable[end]!.text);
      if (joined === key) matches.push(usable.slice(start, end + 1));
      if (joined.length >= key.length) break;
    }
  }
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  if (match.some(w => !Object.values(w.bbox).every(Number.isFinite) || w.bbox.x0 < 0 || w.bbox.y0 < 0 || w.bbox.x1 > width || w.bbox.y1 > height || w.bbox.y1 <= w.bbox.y0)) return null;
  const heights = match.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)]!;
  const meanX = match.reduce((s, w) => s + (w.bbox.x0 + w.bbox.x1) / 2, 0) / match.length;
  const meanY = match.reduce((s, w) => s + w.bbox.y1, 0) / match.length;
  const variance = match.reduce((s, w) => s + ((w.bbox.x0 + w.bbox.x1) / 2 - meanX) ** 2, 0);
  const slope = variance ? Math.max(-.18, Math.min(.18, match.reduce((s, w) => s + ((w.bbox.x0 + w.bbox.x1) / 2 - meanX) * (w.bbox.y1 - meanY), 0) / variance)) : 0;
  const ends = [meanY - slope * meanX, meanY + slope * (width - meanX)];
  const top = Math.max(0, Math.min(...match.map(w => w.bbox.y0), ...ends.map(y => y - lineHeight)) - .35 * lineHeight);
  const bottom = Math.min(height, Math.max(...match.map(w => w.bbox.y1), ...ends) + 2 * lineHeight);
  if (bottom - top > Math.min(height * .4, lineHeight * 5 + Math.abs(slope) * width)) return null;
  const numeric = words.filter(w => w.confidence >= 40 && /\d{2}|\d[.,]\d/.test(w.text)
    && w.bbox.y0 >= top && w.bbox.y1 <= bottom);
  // Only trim the background when a price-like token supplies an observed right edge.
  // With no such token retain the full paper width, rather than clipping unknown text.
  const right = numeric.length ? Math.min(width, Math.max(...match.map(w => w.bbox.x1), ...numeric.map(w => w.bbox.x1)) + lineHeight) : width;
  const left = Math.max(0, Math.min(...match.map(w => w.bbox.x0)) - .5 * lineHeight);
  return { left: left / width, right: right / width, top: top / height, bottom: bottom / height };
}
