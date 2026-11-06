/**
 * Receipt scanning — public API. UI code imports from "@/lib/scan" only.
 *
 *   image.ts            pure pixel preprocessing (lighting, paper bounds)
 *   canvas.ts           browser adapter: decode/rotate/crop/scale on a canvas
 *   tesseract-engine.ts OCR engine adapter (swap-in point for other engines)
 *   layout.ts           pure: word boxes → reading-order rows with column gaps
 *   numbers.ts          pure: locale-aware amounts, currency detection
 *   lexicon.ts          pure: receipt vocabulary and label classification
 *   items.ts            pure: item-row shapes (qty/unit/total, weighed goods)
 *   reconcile.ts        pure: tax inclusive/exclusive, consistency score
 *   parse.ts            pure: lines → draft Receipt
 *   scan.ts             workflow: image → engine → rows, cancellable and time-bounded
 */
import { isConsistent, parseReceiptLines, scoreParse, type ParseResult } from "./parse";
import { runOcr, type OcrProgress, type ScanDeps } from "./scan";
import type { CropFractions, OcrEngine, Rotation, ScanOptions } from "./types";

export { ACCEPTED_TYPES, MAX_UPLOAD_BYTES, preparePreview, validateImageFile } from "./canvas";
export {
  parseReceiptLines,
  parseReceiptText,
  scoreParse,
  isConsistent,
  type ParseResult,
} from "./parse";
export { runOcr, LOAD_TIMEOUT_MS, SCAN_TIMEOUT_MS, type OcrProgress, type OcrResult } from "./scan";
export { createTesseractEngine } from "./tesseract-engine";
export {
  OcrCancelled,
  OcrError,
  type CropFractions,
  type OcrEngine,
  type Rotation,
  type ScanOptions,
} from "./types";

export interface ScanReceiptResult extends ParseResult {
  rotation: Rotation;
  crop: CropFractions | null;
  passes: number;
}

/** Full scan: photo → draft receipt. The photo stays on the device. */
export async function scanReceipt(
  file: File,
  opts: ScanOptions,
  onProgress: (p: OcrProgress) => void,
  signal: AbortSignal,
  createEngine?: () => OcrEngine,
): Promise<ScanReceiptResult> {
  const deps: ScanDeps = {
    scorer: (lines) => {
      const { receipt } = parseReceiptLines(lines);
      return { score: scoreParse(receipt), good: isConsistent(receipt) };
    },
    ...(createEngine ? { createEngine } : {}),
  };
  const res = await runOcr(file, opts, onProgress, signal, deps);
  const parsed = parseReceiptLines(res.lines); // raw text shown to the user = the rows the parser read
  return { ...parsed, rotation: res.rotation, crop: res.crop, passes: res.passes };
}
