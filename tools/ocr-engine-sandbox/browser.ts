import { adaptPaddleTextBoxes } from './adapter';

declare const __FROZEN_MODULE_BASE__: string;
const frozen = __FROZEN_MODULE_BASE__;
const moduleAt = (name: string) => import(/* @vite-ignore */ `${frozen}${name}.ts`);
const fileFrom = (data: string, name: string) => new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name, { type: 'image/jpeg' });
export async function runtime() {
  return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated, webgpu: !!(navigator as Navigator & { gpu?: unknown }).gpu, devicePixelRatio, timeOrigin: performance.timeOrigin };
}

export async function tesseract(data: string, name: string, scanOptions: unknown) {
  const { runOcr } = await moduleAt('ocr');
  const { scoreOcrText } = await moduleAt('scan-score');
  const { parseOcrResult } = await moduleAt('receipt-reading');
  const { computeTotals } = await moduleAt('bill');
  const events: unknown[] = [];
  const start = performance.now();
  try {
    const ocr = await runOcr(fileFrom(data, name), scanOptions, (p: unknown) => events.push({ ...(p as object), elapsedMs: performance.now() - start }), new AbortController().signal, scoreOcrText, { includeWords: true });
    const recognitionMs = performance.now() - start;
    const parsed = parseOcrResult(ocr);
    return { ocr, parsed, totals: computeTotals(parsed.receipt), recognitionMs, durationMs: performance.now() - start, events, error: null };
  } catch (error) {
    const e = error as Error & { stage?: string };
    return { durationMs: performance.now() - start, events, error: { stage: e.stage ?? 'unknown', name: e.name, message: e.message } };
  }
}

let paddle: Awaited<ReturnType<typeof import('@paddleocr/paddleocr-js')['PaddleOCR']['create']>> | undefined;
export const paddleSettings = {
  lang: 'en', ocrVersion: 'PP-OCRv5', worker: false, initialize: false,
  textDetectionModelName: 'PP-OCRv5_mobile_det', textRecognitionModelName: 'PP-OCRv5_mobile_rec',
  textDetectionModelAsset: { url: '/engine-assets/PP-OCRv5_mobile_det.tar' },
  textRecognitionModelAsset: { url: '/engine-assets/PP-OCRv5_mobile_rec.tar' },
  textDetectionBatchSize: 1, textRecognitionBatchSize: 1,
  ortOptions: { backend: 'wasm' as const, numThreads: 1, simd: true, wasmPaths: '/ort-assets/' },
};
export async function initializePaddle() {
  const start = performance.now();
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
  paddle = await PaddleOCR.create(paddleSettings);
  const initialization = await paddle.initialize();
  return { durationMs: performance.now() - start, initialization, settings: paddleSettings };
}

export async function predictPaddle(data: string, name: string, limit = 960) {
  if (!paddle) throw new Error('PaddleOCR not initialized');
  const { parseReceiptText } = await moduleAt('parser');
  const { computeTotals } = await moduleAt('bill');
  const settings = { textDetLimitSideLen: limit, textDetLimitType: 'max' as const, textDetMaxSideLimit: 4000, textDetThresh: .3, textDetBoxThresh: .6, textDetUnclipRatio: 2, textRecScoreThresh: 0 };
  const start = performance.now();
  try {
    const [ocr] = await paddle.predict(fileFrom(data, name), settings);
    if (!ocr) throw new Error('PaddleOCR returned no image result');
    const recognitionMs = performance.now() - start;
    let adapted;
    try { adapted = adaptPaddleTextBoxes(ocr.items); } catch (error) { return { ocr, settings, recognitionMs, durationMs: performance.now() - start, error: { stage: 'adapter', message: String(error) } }; }
    const adapterMs = performance.now() - start - recognitionMs;
    try {
      const parsed = parseReceiptText(adapted.text);
      return { ocr, adapted, parsed, settings, totals: computeTotals(parsed.receipt), recognitionMs, adapterMs, durationMs: performance.now() - start, error: null };
    } catch (error) { return { ocr, adapted, settings, recognitionMs, adapterMs, durationMs: performance.now() - start, error: { stage: 'parser', message: String(error) } }; }
  } catch (error) { const e = error as Error; return { settings, durationMs: performance.now() - start, error: { stage: 'recognition', name: e.name, message: e.message } }; }
}
