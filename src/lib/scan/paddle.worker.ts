/// <reference lib="webworker" />
/**
 * Web Worker entry for the dev-only PaddleOCR engine. Bundled by Vite only when the engine switch
 * is compiled in (see engine-select.ts). The SDK is dynamically imported on the first "load".
 */
import { createPaddleRuntime, type PaddleInstance, type ToPaddleWorker } from "./paddle-runtime";

interface Cv {
  matFromImageData(data: ImageData): { delete(): void };
}

const handle = createPaddleRuntime(
  {
    async createSdk(options) {
      const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
      // The SDK passes ortOptions.wasmPaths straight to ONNX Runtime, which also accepts
      // { wasm: url }; the SDK's own type only lists the string form.
      type CreateOptions = NonNullable<Parameters<typeof PaddleOCR.create>[0]>;
      return (await PaddleOCR.create(
        options as unknown as CreateOptions,
      )) as unknown as PaddleInstance;
    },
    // Emitted next to the worker from the installed onnxruntime-web, so JS and WASM always match.
    ortUrls: {
      mjs: new URL(
        "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
        import.meta.url,
      ).href,
      wasm: new URL(
        "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
        import.meta.url,
      ).href,
    },
    async toInput(image, cv) {
      // The SDK's own Blob path draws on a DOM canvas, which a worker doesn't have; pass it an
      // OpenCV Mat (RGBA, as the SDK's canvas path produces) built from an OffscreenCanvas instead.
      const bitmap = await createImageBitmap(image);
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("No 2D canvas in this browser's workers.");
        ctx.drawImage(bitmap, 0, 0);
        const mat = (cv as Cv).matFromImageData(
          ctx.getImageData(0, 0, bitmap.width, bitmap.height),
        );
        return { input: mat, dispose: () => mat.delete() };
      } finally {
        bitmap.close();
      }
    },
  },
  (msg) => self.postMessage(msg),
);

self.onmessage = (e: MessageEvent<ToPaddleWorker>) => void handle(e.data);
