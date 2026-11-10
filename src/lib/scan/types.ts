/**
 * Contracts shared by the receipt-scan modules. Nothing here depends on the DOM, React or an OCR SDK,
 * so any engine (Tesseract today, PaddleOCR or another later) can be plugged in behind `OcrEngine`.
 */

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One recognised word with its position on the prepared image. */
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: BBox;
}

/** What an engine returns for one image. `words` may be empty if the engine only gives text. */
export interface OcrPage {
  text: string;
  words: OcrWord[];
}

/**
 * Page-layout hint for the engine:
 * - column: one column of variable-size text (most receipts)
 * - block:  one uniform block (fallback when the column read is inconsistent)
 * - sparse: scattered text (orientation probes, very wide or damaged receipts)
 */
export type LayoutHint = "column" | "block" | "sparse";

export interface EngineProgress {
  status: string;
  progress: number;
}

/**
 * An on-device OCR engine. `load` must not send the image anywhere; only model files may be fetched.
 * `terminate` must be safe to call more than once, and while `load` or `recognize` is in flight.
 */
export interface OcrEngine {
  readonly name: string;
  /**
   * Optional time limit for `load`, in ms. When absent the workflow's default (`LOAD_TIMEOUT_MS`)
   * applies. An engine with a larger first download (PaddleOCR) can ask for more.
   */
  readonly loadTimeoutMs?: number;
  load(onProgress: (p: EngineProgress) => void): Promise<void>;
  recognize(image: Blob, layout: LayoutHint): Promise<OcrPage>;
  terminate(): Promise<void>;
}

export type Rotation = 0 | 90 | 180 | 270;
/** Crop as fractions (0..1) of the ORIENTED image. */
export type CropFractions = { left: number; top: number; right: number; bottom: number };

export interface ScanOptions {
  /** null = detect automatically. Rotation is clockwise. */
  rotation: Rotation | null;
  /** null = detect paper edges automatically. */
  crop: CropFractions | null;
}

export type OcrStage = "decode" | "load" | "orient" | "recognize" | "timeout";

export class OcrError extends Error {
  constructor(
    public stage: OcrStage,
    message: string,
  ) {
    super(message);
    this.name = "OcrError";
  }
}

export class OcrCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "OcrCancelled";
  }
}
