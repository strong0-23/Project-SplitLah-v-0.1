/**
 * The PaddleOCR side of the dev-only Paddle engine. It runs inside the engine's Web Worker
 * (`paddle.worker.ts`) and talks to the main thread through the messages below. The SDK and the
 * image decoder are injected, so the contract tests can run this with a fake SDK.
 *
 * Only model and runtime files are fetched (same origin). The image arrives as a Blob from the main
 * thread and never leaves the device.
 */
import { PADDLE_PREDICT_SETTINGS, paddleCreateOptions } from "./paddle-assets";

/** One recognised text segment as the SDK returns it (polygon in image pixels, score 0..1). */
export interface PaddleItem {
  poly: number[][];
  text: string;
  score: number;
}

export type ToPaddleWorker =
  { type: "load"; id: number; origin: string } | { type: "recognize"; id: number; image: Blob };

export type FromPaddleWorker =
  | { type: "progress"; status: string; progress: number }
  | { type: "loaded"; id: number }
  | { type: "result"; id: number; items: PaddleItem[] }
  | { type: "error"; id: number; message: string };

/** The parts of the SDK instance the engine uses. `cv` is the SDK's own OpenCV.js (ready after `initialize`). */
export interface PaddleInstance {
  initialize(): Promise<unknown>;
  predict(
    input: unknown,
    params: typeof PADDLE_PREDICT_SETTINGS,
  ): Promise<Array<{ items: PaddleItem[] }>>;
  dispose(): Promise<void>;
  cv?: unknown;
}

export interface PaddleRuntimeDeps {
  /** `(await import("@paddleocr/paddleocr-js")).PaddleOCR.create` in the worker; a fake in tests. */
  createSdk(options: ReturnType<typeof paddleCreateOptions>): Promise<PaddleInstance>;
  /** URLs of the ONNX Runtime glue module and WASM file emitted with the worker. */
  ortUrls: { mjs: string; wasm: string };
  /** Turns the image into SDK input (an OpenCV Mat in the worker), with a disposer. */
  toInput(image: Blob, cv: unknown): Promise<{ input: unknown; dispose(): void }>;
}

/** Returns the worker's message handler. One SDK instance per worker; the worker is the unit of cleanup. */
export function createPaddleRuntime(
  deps: PaddleRuntimeDeps,
  post: (msg: FromPaddleWorker) => void,
): (msg: ToPaddleWorker) => Promise<void> {
  let ocr: PaddleInstance | null = null;
  const fail = (id: number, e: unknown) =>
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });

  return async (msg) => {
    if (msg.type === "load") {
      try {
        post({ type: "progress", status: "Loading PaddleOCR", progress: 0 });
        ocr = await deps.createSdk(paddleCreateOptions(msg.origin, deps.ortUrls));
        post({ type: "progress", status: "Loading Paddle models", progress: 0.3 });
        await ocr.initialize();
        if (!ocr.cv) throw new Error("PaddleOCR started without its image library.");
        post({ type: "progress", status: "Paddle ready", progress: 1 });
        post({ type: "loaded", id: msg.id });
      } catch (e) {
        fail(msg.id, e);
      }
      return;
    }
    if (!ocr) return fail(msg.id, new Error("Engine not loaded"));
    let prepared: { input: unknown; dispose(): void } | null = null;
    try {
      prepared = await deps.toInput(msg.image, ocr.cv);
      const [res] = await ocr.predict(prepared.input, PADDLE_PREDICT_SETTINGS);
      post({ type: "result", id: msg.id, items: res?.items ?? [] });
    } catch (e) {
      fail(msg.id, e);
    } finally {
      prepared?.dispose();
    }
  };
}
