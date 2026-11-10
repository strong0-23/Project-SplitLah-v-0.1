/**
 * Scan workflow: decode → load engine → orient → crop + flatten → recognise → optional second pass.
 * Engine-agnostic (any `OcrEngine`), parser-agnostic (the caller scores text), cancellable at every
 * stage and time-bounded. Each stage reports its own user-facing error.
 */
import {
  autoCrop,
  decodeImage,
  flattenCanvas,
  MAX_PIXELS,
  PROBE_PIXELS,
  render,
  rotationCandidates,
  toBlob,
} from "./canvas";
import { pageToLines } from "./layout";
import { createTesseractEngine } from "./tesseract-engine";
import {
  OcrCancelled,
  OcrError,
  type CropFractions,
  type LayoutHint,
  type OcrEngine,
  type OcrPage,
  type OcrStage,
  type Rotation,
  type ScanOptions,
} from "./types";

export const LOAD_TIMEOUT_MS = 60_000;
export const SCAN_TIMEOUT_MS = 150_000;

export interface OcrProgress {
  stage: OcrStage;
  status: string;
  progress: number; // 0..1 overall
}

export interface OcrResult {
  /** Reading-order lines rebuilt from word positions (falls back to the engine's own text lines). */
  lines: string[];
  text: string;
  rotation: Rotation;
  crop: CropFractions | null;
  passes: number;
  engine: string;
}

/** Score supplied by the caller (keeps parsing out of this module). good=true skips the fallback pass. */
export type LinesScorer = (lines: string[]) => { score: number; good: boolean };

export interface ScanDeps {
  scorer: LinesScorer;
  createEngine?: () => OcrEngine;
}

/** Counts confident, horizontal real words. Sideways text yields few, tall boxes. Pure. */
export function orientationScore(page: OcrPage): number {
  return page.words.filter(
    (w) =>
      w.confidence > 70 &&
      w.text.replace(/[^A-Za-z0-9]/g, "").length >= 3 &&
      w.bbox.x1 - w.bbox.x0 > w.bbox.y1 - w.bbox.y0,
  ).length;
}

export async function runOcr(
  file: File,
  opts: ScanOptions,
  onProgress: (p: OcrProgress) => void,
  signal: AbortSignal,
  deps: ScanDeps,
): Promise<OcrResult> {
  const ctrl = new AbortController(); // user cancel + overall time bound
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal.aborted) throw new OcrCancelled();
  const engine = (deps.createEngine ?? createTesseractEngine)();
  // An engine may ask for a longer load limit; the overall bound grows by the same amount, so the
  // recognition stages keep the time they had.
  const loadTimeoutMs = engine.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(
    () => {
      timedOut = true;
      ctrl.abort();
    },
    SCAN_TIMEOUT_MS + Math.max(0, loadTimeoutMs - LOAD_TIMEOUT_MS),
  );

  let stage: OcrStage = "decode";
  let range: [number, number] = [0, 0.05];
  const report = (status: string, p: number) => {
    if (ctrl.signal.aborted) return; // never emit stale progress after cancel/timeout
    onProgress({
      stage,
      status,
      progress: range[0] + (range[1] - range[0]) * Math.min(1, Math.max(0, p)),
    });
  };
  const check = () => {
    if (ctrl.signal.aborted)
      throw timedOut
        ? new OcrError(
            "timeout",
            "Scanning took too long. Try cropping closer to the receipt, or enter the items manually.",
          )
        : new OcrCancelled();
  };
  /** Races a promise against cancellation so no stage can hang uncancellable. */
  const guard = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      const a = () => {
        try {
          check();
        } catch (e) {
          rej(e);
        }
      };
      ctrl.signal.addEventListener("abort", a, { once: true });
      if (ctrl.signal.aborted) a();
      p.then(res, rej).finally(() => ctrl.signal.removeEventListener("abort", a));
    });

  const killOnAbort = () => {
    void engine.terminate();
  };
  ctrl.signal.addEventListener("abort", killOnAbort);
  let bitmap: ImageBitmap | null = null;

  const recognize = async (canvas: HTMLCanvasElement, layout: LayoutHint): Promise<OcrPage> => {
    const blob = await guard(toBlob(canvas));
    check();
    try {
      const page = await guard(engine.recognize(blob, layout));
      check();
      return page;
    } catch (e) {
      if (e instanceof OcrCancelled || e instanceof OcrError) throw e;
      throw new OcrError(
        "recognize",
        "The text recogniser failed on this image. Try rotating or cropping it, or enter items manually.",
      );
    }
  };

  try {
    report("Opening image", 0);
    const decoding = decodeImage(file);
    void decoding.then(
      (b) => {
        if (ctrl.signal.aborted) b.close();
      },
      () => undefined,
    );
    bitmap = await guard(decoding);
    check();

    stage = "load";
    range = [0.05, 0.25];
    report("Loading text recogniser", 0);
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await guard(
        Promise.race([
          engine.load((p) => report(p.status, p.progress)),
          new Promise<never>((_, rej) => {
            loadTimer = setTimeout(
              () =>
                rej(
                  new OcrError(
                    "load",
                    "The text recogniser took too long to download. Check your connection and try again.",
                  ),
                ),
              loadTimeoutMs,
            );
          }),
        ]),
      );
    } catch (e) {
      if (e instanceof OcrCancelled || e instanceof OcrError) throw e;
      throw new OcrError(
        "load",
        "Couldn't start the text recogniser. Check your connection and try again.",
      );
    } finally {
      clearTimeout(loadTimer);
    }
    check();

    // Orientation: quick low-resolution probes, best guess first; stop as soon as one reads well.
    stage = "orient";
    range = [0.25, 0.45];
    let rotation: Rotation;
    if (opts.rotation !== null) {
      rotation = opts.rotation;
    } else {
      const cands = rotationCandidates(bitmap);
      let best: { rot: Rotation; score: number } = { rot: cands[0]!, score: -1 };
      for (let i = 0; i < cands.length; i++) {
        const rot = cands[i]!;
        range = [0.25 + (0.2 * i) / cands.length, 0.25 + (0.2 * (i + 1)) / cands.length];
        report("Checking orientation", 0);
        const score = orientationScore(
          await recognize(
            flattenCanvas(render(bitmap, rot, autoCrop(bitmap, rot), PROBE_PIXELS)),
            "block",
          ),
        );
        if (score > best.score) best = { rot, score };
        if (score >= 12) break;
      }
      if (best.score < 3)
        throw new OcrError(
          "orient",
          "No readable text was found. Rotate the photo so the text is upright, crop to the receipt, or retake it in better light.",
        );
      rotation = best.rot;
    }
    check();

    stage = "recognize";
    range = [0.45, 0.8];
    const crop = opts.crop ?? autoCrop(bitmap, rotation);
    const full = flattenCanvas(render(bitmap, rotation, crop, MAX_PIXELS));
    bitmap.close();
    bitmap = null;
    report("Reading text", 0);
    const first = await recognize(full, "column");
    let page = first;
    let lines = pageToLines(first);
    let passes = 1;
    const s1 = deps.scorer(lines);
    if (!s1.good) {
      // Fallback only when the first reading is internally inconsistent.
      range = [0.8, 1];
      report("Double-checking", 0);
      const second = await recognize(full, "block");
      passes = 2;
      const lines2 = pageToLines(second);
      if (deps.scorer(lines2).score > s1.score) {
        page = second;
        lines = lines2;
      }
    }
    check();
    if (!page.text.trim() && lines.length === 0)
      throw new OcrError(
        "recognize",
        "No text was found. Rotate the photo so the text is upright, crop to the receipt, or retake it in better light.",
      );
    return { lines, text: page.text, rotation, crop, passes, engine: engine.name };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    ctrl.signal.removeEventListener("abort", killOnAbort);
    ctrl.abort(); // also stops an engine that resolves after a load timeout or a failed stage
    bitmap?.close();
    await engine.terminate();
  }
}
