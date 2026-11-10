/**
 * PaddleOCR adapter behind the `OcrEngine` contract (dev-only challenger, Batch 2b; Tesseract stays
 * the default). The SDK runs in a dedicated Web Worker (`paddle.worker.ts`), so the page stays
 * responsive and `terminate()` really stops a running recognition. This module is reached only
 * through a dynamic import from `engine-select.ts`, which is compiled out of production builds.
 *
 * Model files come from the app's own origin; the image is posted to the worker as a Blob and never
 * leaves the device.
 */
import { PADDLE_LOAD_TIMEOUT_MS } from "./paddle-assets";
import type { FromPaddleWorker, PaddleItem, ToPaddleWorker } from "./paddle-runtime";
import type { EngineProgress, OcrEngine, OcrPage, OcrWord } from "./types";

/** The parts of `Worker` the engine uses (a fake in the contract tests). */
export interface WorkerLike {
  postMessage(msg: ToPaddleWorker): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<FromPaddleWorker>) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface PaddleEngineOptions {
  createWorker?: () => WorkerLike;
  /** Origin the model files are served from; defaults to the page's origin. */
  origin?: string;
}

const defaultWorker = (): WorkerLike =>
  new Worker(new URL("./paddle.worker.ts", import.meta.url), {
    type: "module",
    name: "paddle-ocr",
  }) as unknown as WorkerLike;

/**
 * Paddle segments → the shared `OcrPage` format. Each segment (often several words) becomes one
 * `OcrWord`: its polygon's bounding box, and its 0..1 score scaled to Tesseract's 0..100, so
 * `layout.ts` and the orientation check treat both engines alike. Text is never changed.
 */
export function paddleItemsToPage(items: readonly PaddleItem[]): OcrPage {
  const words: OcrWord[] = [];
  for (const it of items) {
    const text = it.text.trim();
    const xs = it.poly.map((p) => p[0]).filter((v): v is number => Number.isFinite(v));
    const ys = it.poly.map((p) => p[1]).filter((v): v is number => Number.isFinite(v));
    if (!text || !xs.length || !ys.length) continue;
    words.push({
      text,
      confidence: Math.round(Math.min(1, Math.max(0, it.score)) * 1000) / 10,
      bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
    });
  }
  const yc = (w: OcrWord) => (w.bbox.y0 + w.bbox.y1) / 2;
  const ordered = [...words].sort((a, b) => yc(a) - yc(b) || a.bbox.x0 - b.bbox.x0);
  return { text: ordered.map((w) => w.text).join("\n"), words };
}

export function createPaddleEngine(opts: PaddleEngineOptions = {}): OcrEngine {
  let worker: WorkerLike | null = null;
  let dead = false;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (m: FromPaddleWorker) => void; reject: (e: Error) => void }
  >();
  let onProgress: (p: EngineProgress) => void = () => undefined;

  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const request = (build: (id: number) => ToPaddleWorker): Promise<FromPaddleWorker> => {
    if (dead) return Promise.reject(new Error("terminated"));
    if (!worker) return Promise.reject(new Error("Engine not loaded"));
    const id = nextId++;
    const w = worker;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage(build(id));
    });
  };

  return {
    name: "paddle",
    loadTimeoutMs: PADDLE_LOAD_TIMEOUT_MS,
    async load(report) {
      onProgress = report;
      if (dead) throw new Error("terminated");
      worker = (opts.createWorker ?? defaultWorker)();
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "progress") return onProgress({ status: m.status, progress: m.progress });
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === "error") p.reject(new Error(m.message));
        else p.resolve(m);
      };
      worker.onerror = () => failAll(new Error("The PaddleOCR worker stopped."));
      const origin = opts.origin ?? globalThis.location.origin;
      await request((id) => ({ type: "load", id, origin }));
      if (dead) throw new Error("terminated");
    },
    async recognize(image): Promise<OcrPage> {
      // Paddle detects text lines itself, so the layout hint has no equivalent and is ignored.
      const m = await request((id) => ({ type: "recognize", id, image }));
      if (m.type !== "result") throw new Error("Unexpected PaddleOCR reply");
      return paddleItemsToPage(m.items);
    },
    async terminate() {
      // Ending the worker stops any running inference and frees the SDK's memory. Safe to repeat.
      dead = true;
      worker?.terminate();
      worker = null;
      failAll(new Error("terminated"));
    },
  };
}
