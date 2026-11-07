/**
 * Tesseract.js adapter behind the `OcrEngine` contract. The SDK is dynamically imported so it never
 * enters the SSR/initial bundle. Worker/core/language files come from the jsDelivr CDN on first use;
 * the image itself never leaves the browser.
 */
import type { EngineProgress, LayoutHint, OcrEngine, OcrPage } from "./types";

type TWorker = Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>;

/** Tesseract page-segmentation modes for each layout hint. */
const PSM: Record<LayoutHint, string> = { column: "4", block: "6", sparse: "11" };

export function createTesseractEngine(lang = "eng"): OcrEngine {
  let worker: TWorker | null = null;
  let pending: Promise<TWorker> | null = null;
  let dead = false;
  let onProgress: (p: EngineProgress) => void = () => undefined;

  return {
    name: "tesseract",
    async load(report) {
      onProgress = report;
      const mod = await import("tesseract.js");
      if (dead) throw new Error("terminated");
      pending = mod.createWorker(lang, mod.OEM.LSTM_ONLY, {
        logger: (m: { status: string; progress: number }) => {
          const status =
            m.status === "recognizing text"
              ? "Reading text"
              : m.status.replace(/^\w/, (c) => c.toUpperCase());
          onProgress({ status, progress: m.progress ?? 0 });
        },
        errorHandler: () => undefined,
      });
      // A worker that finishes starting after terminate() is stopped straight away.
      pending.then(
        (w) => {
          if (dead) void w.terminate().catch(() => undefined);
        },
        () => undefined,
      );
      worker = await pending;
      if (dead) throw new Error("terminated");
      await worker.setParameters({ user_defined_dpi: "300", preserve_interword_spaces: "1" });
    },
    async recognize(image, layout): Promise<OcrPage> {
      if (!worker) throw new Error("Engine not loaded");
      await worker.setParameters({ tessedit_pageseg_mode: PSM[layout] as never });
      const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
      const words = (data.words ?? []).map((w) => ({
        text: w.text,
        confidence: w.confidence,
        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
      }));
      return { text: data.text ?? "", words };
    },
    async terminate() {
      dead = true;
      if (worker) await worker.terminate().catch(() => undefined);
      else if (pending)
        pending
          .then(
            (w) => w.terminate(),
            () => undefined,
          )
          .catch(() => undefined);
    },
  };
}
