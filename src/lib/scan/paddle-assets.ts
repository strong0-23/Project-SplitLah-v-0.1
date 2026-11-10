/**
 * PaddleOCR (dev-only challenger engine, Batch 2b) settings and self-hosted model files. Pure data.
 *
 * Models: the owner's pinned PP-OCRv5 mobile archives in `public/paddle/` (see its PROVENANCE.md),
 * fetched from the app's own origin only. The ONNX Runtime glue module and WASM file are emitted by
 * Vite from the installed `onnxruntime-web` (exact pin) when the Paddle worker is built, so they
 * always match the runtime JS. Settings are the sandbox's fixed "Paddle960" configuration.
 */

export const PADDLE_SDK_VERSION = "0.4.2";
export const PADDLE_ORT_VERSION = "1.22.0";

/** Paddle's own load limit (owner decision, 11 Nov 2026). PROVISIONAL until the 2c phone timings. */
export const PADDLE_LOAD_TIMEOUT_MS = 120_000;

/** Site-root paths of the self-hosted model archives (served from `public/`). */
export const PADDLE_MODEL_PATHS = {
  det: "/paddle/PP-OCRv5_mobile_det.tar",
  rec: "/paddle/PP-OCRv5_mobile_rec.tar",
} as const;

/** Pinned size and SHA-256 of each model archive (paths relative to `public/`). */
export const PADDLE_MODEL_MANIFEST: ReadonlyArray<{ path: string; bytes: number; sha256: string }> =
  [
    {
      path: "paddle/PP-OCRv5_mobile_det.tar",
      bytes: 4843520,
      sha256: "781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30",
    },
    {
      path: "paddle/PP-OCRv5_mobile_rec.tar",
      bytes: 16701440,
      sha256: "f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c",
    },
  ];

/** SDK create options. Model and runtime URLs are absolute, same-origin, and passed in. */
export function paddleCreateOptions(origin: string, ort: { mjs: string; wasm: string }) {
  const at = (p: string) => new URL(p, origin).href;
  return {
    lang: "en",
    ocrVersion: "PP-OCRv5",
    textDetectionModelName: "PP-OCRv5_mobile_det",
    textRecognitionModelName: "PP-OCRv5_mobile_rec",
    textDetectionModelAsset: { url: at(PADDLE_MODEL_PATHS.det) },
    textRecognitionModelAsset: { url: at(PADDLE_MODEL_PATHS.rec) },
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: 1,
    // The app runs the SDK inside its own Web Worker (paddle.worker.ts), so the SDK's worker is off.
    worker: false,
    initialize: false,
    // WASM backend, one thread (no SharedArrayBuffer / cross-origin isolation needed), SIMD on.
    // wasmPaths: the runtime's glue module and WASM binary, both emitted from the installed package.
    ortOptions: {
      backend: "wasm" as const,
      numThreads: 1,
      simd: true,
      wasmPaths: { mjs: ort.mjs, wasm: ort.wasm },
    },
  };
}

/** Per-image settings: the sandbox's fixed "Paddle960" configuration. */
export const PADDLE_PREDICT_SETTINGS = {
  textDetLimitSideLen: 960,
  textDetLimitType: "max" as const,
  textDetMaxSideLimit: 4000,
  textDetThresh: 0.3,
  textDetBoxThresh: 0.6,
  textDetUnclipRatio: 2,
  textRecScoreThresh: 0,
};
