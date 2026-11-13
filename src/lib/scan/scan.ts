/**
 * Scan workflow: decode → load engine → orient → crop + flatten → recognise → optional second pass.
 * Engine-agnostic (any `OcrEngine`), parser-agnostic (the caller scores text), cancellable at every
 * stage and time-bounded. Each stage reports its own user-facing error.
 */
import {
  assertCanvasReadable,
  autoCrop,
  decodeImage,
  flattenCanvas,
  inkRows,
  MAX_PIXELS,
  PROBE_PIXELS,
  render,
  rotationCandidates,
  toBlob,
} from "./canvas";
import { singleUseLease, type EnginePool } from "./engine-pool";
import { PARTLY_READ_SHARE, unreadPrintShare } from "./image";
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
  /**
   * The chosen reading left a large share of the printed rows without any word (D14): the photo
   * was probably only partly read. False when the engine gives no word positions.
   */
  partlyRead: boolean;
}

/** Score supplied by the caller (keeps parsing out of this module). good=true skips the fallback pass. */
export type LinesScorer = (lines: string[]) => { score: number; good: boolean };

export interface ScanDeps {
  scorer: LinesScorer;
  createEngine?: () => OcrEngine;
  /**
   * Keeps a loaded engine between scans (engine-pool.ts). Without one, the engine is created,
   * loaded and terminated for this scan only.
   */
  pool?: EnginePool;
}

const longWord = (w: OcrPage["words"][number]) => w.text.replace(/[^A-Za-z0-9]/g, "").length >= 3;

/** Counts confident, horizontal real words. Sideways text yields few, tall boxes. Pure. */
export function orientationScore(page: OcrPage): number {
  return page.words.filter(
    (w) => w.confidence > 70 && longWord(w) && w.bbox.x1 - w.bbox.x0 > w.bbox.y1 - w.bbox.y0,
  ).length;
}

/**
 * Did this reading leave much of the printed area unread (D14)? Compares the rows that hold print on
 * the prepared image with the rows covered by recognised words. Pure.
 */
export function readingLooksPartial(inkRowsOfImage: Uint8Array, page: OcrPage): boolean {
  const words = page.words.filter((w) => w.confidence > 30 && w.text.trim().length > 0);
  if (!words.length) return false;
  return (
    unreadPrintShare(
      inkRowsOfImage,
      words.map((w) => w.bbox),
    ) >= PARTLY_READ_SHARE
  );
}

/** A probe this good may end the orientation search early (with `ORIENT_EARLY_SHARE`). */
export const ORIENT_EARLY_SCORE = 12;
/** Share of a probe's longer words that must be confident before the search stops early. */
export const ORIENT_EARLY_SHARE = 0.35;

/**
 * May the orientation search stop at this probe (D14)? Upside-down text still gives some confident,
 * wide words (often a dozen or more on a long receipt), but only as a small share of the words read;
 * upright text gives a large share. So a probe stops the search only when it has enough confident
 * words AND they are a fair share of its longer words; otherwise the remaining rotations are probed
 * and the best score wins. Pure.
 */
export function orientationSettled(page: OcrPage): boolean {
  const score = orientationScore(page);
  const long = page.words.filter(longWord).length;
  return score >= ORIENT_EARLY_SCORE && score >= ORIENT_EARLY_SHARE * long;
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
  const factory = deps.createEngine ?? createTesseractEngine;
  // The engine reports progress through this scan's `report` while the scan holds it.
  const forward = (p: { status: string; progress: number }) => report(p.status, p.progress);
  const lease = deps.pool
    ? deps.pool.acquire(factory, forward)
    : singleUseLease(factory(), forward);
  const engine = lease.engine;
  let succeeded = false;
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

  // Cancel or timeout: stop the engine at once (a running recognition ends) and mark it for reload.
  const killOnAbort = () => {
    void lease.discard();
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
    assertCanvasReadable(); // before any download: a blocked canvas makes every read blank
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
    if (!lease.needsLoad) report("Text recogniser ready", 1);
    else report("Loading text recogniser", 0);
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    if (lease.needsLoad)
      try {
        await guard(
          Promise.race([
            lease.load(),
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
        const probe = await recognize(
          flattenCanvas(render(bitmap, rot, autoCrop(bitmap, rot), PROBE_PIXELS)),
          "block",
        );
        const score = orientationScore(probe);
        if (score > best.score) best = { rot, score };
        if (orientationSettled(probe)) break;
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
    const partlyRead = page.words.length > 0 && readingLooksPartial(inkRows(full), page);
    succeeded = true;
    return { lines, text: page.text, rotation, crop, passes, engine: engine.name, partlyRead };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    ctrl.signal.removeEventListener("abort", killOnAbort);
    ctrl.abort(); // no stale progress from this scan after it ends
    bitmap?.close();
    // Success: keep the engine for the next scan (a pool keeps it; a single-use lease terminates
    // it). Any failure (error, cancel, timeout, an engine that loads after its limit) discards it.
    if (succeeded) await lease.release();
    else await lease.discard();
  }
}
