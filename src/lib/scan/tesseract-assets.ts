/**
 * Self-hosted Tesseract files (owner-approved, brief Batch 2b step 5). Pure data.
 *
 * The worker, the two LSTM cores (SIMD and non-SIMD; tesseract.js picks one per device) and the
 * `eng` model are served from the app's own static assets (`public/tesseract/`) at pinned versions,
 * instead of jsDelivr. There is deliberately no CDN fallback: if a file is missing, loading fails
 * with the usual "couldn't load the scanner" error rather than silently reaching a third party.
 *
 * Sources (npm registry, tarball integrity and registry signature checked, Batch 2b):
 *   tesseract.js 5.1.1          dist/worker.min.js                    Apache-2.0
 *   tesseract.js-core 5.1.1     tesseract-core{-simd,}-lstm.wasm.js   Apache-2.0
 *   @tesseract.js-data/eng 1.0.0  4.0.0_best_int/eng.traineddata.gz   (tessdata, Apache-2.0)
 * These are the same files tesseract.js 5.1.1 fetches from jsDelivr by default with OEM.LSTM_ONLY.
 * `tesseract-assets.test.ts` checks every file's size and SHA-256, and that the versions match the
 * installed packages, so an upgrade can't leave stale copies behind.
 */

export const TESSERACT_VERSION = "5.1.1";
export const TESSERACT_CORE_VERSION = "5.1.1";
export const TESSERACT_LANG_DATA = "4.0.0_best_int";

/** Paths under the site root (served from `public/`). */
export const TESSERACT_PATHS = {
  worker: `/tesseract/${TESSERACT_VERSION}/worker.min.js`,
  /** A directory: tesseract.js appends tesseract-core-simd-lstm.wasm.js or -lstm.wasm.js. */
  core: `/tesseract/${TESSERACT_CORE_VERSION}/core`,
  /** A directory: tesseract.js appends `<lang>.traineddata.gz`. */
  lang: `/tesseract/lang/eng/${TESSERACT_LANG_DATA}`,
} as const;

/** Every self-hosted file with its pinned size and SHA-256 (paths relative to `public/`). */
export const TESSERACT_ASSET_MANIFEST: ReadonlyArray<{
  path: string;
  bytes: number;
  sha256: string;
}> = [
  {
    path: `tesseract/${TESSERACT_VERSION}/worker.min.js`,
    bytes: 123724,
    sha256: "aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc",
  },
  {
    path: `tesseract/${TESSERACT_CORE_VERSION}/core/tesseract-core-simd-lstm.wasm.js`,
    bytes: 3938657,
    sha256: "ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf",
  },
  {
    path: `tesseract/${TESSERACT_CORE_VERSION}/core/tesseract-core-lstm.wasm.js`,
    bytes: 3938277,
    sha256: "8f04aa0cc81e7bde33f80e92fa01a7a665f0b4884d098acf5de9c7104a11dfaa",
  },
  {
    path: `tesseract/lang/eng/${TESSERACT_LANG_DATA}/eng.traineddata.gz`,
    bytes: 2952873,
    sha256: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
  },
];

/**
 * Absolute same-origin URLs for tesseract.js. Absolute, because the worker resolves the core and
 * language paths against its own URL, not the page's.
 */
export function tesseractAssetUrls(origin: string): {
  workerPath: string;
  corePath: string;
  langPath: string;
} {
  const at = (p: string) => new URL(p, origin).href;
  return {
    workerPath: at(TESSERACT_PATHS.worker),
    corePath: at(TESSERACT_PATHS.core),
    langPath: at(TESSERACT_PATHS.lang),
  };
}
