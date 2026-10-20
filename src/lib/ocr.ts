/**
 * On-device OCR. Tesseract.js is lazy-loaded only when a scan starts. It runs in a Web Worker;
 * worker/core/language files are fetched from the jsDelivr CDN on first use. The image itself
 * never leaves the browser.
 *
 * Pipeline (each stage reports its own errors): decode → load recogniser → orient → crop +
 * illumination flattening at near-native resolution → recognise (single-column layout) → optional
 * second pass (uniform block layout) only when the caller's score says the first pass is inconsistent.
 */
import { detectPaperBounds, flattenIllumination, type Rect } from "./preprocess";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** Long-side cap for recognition. Phone receipts need ~1000px+ across the paper to stay legible. */
const MAX_DIMENSION = 3000;
const PROBE_DIMENSION = 1000;
const PREVIEW_DIMENSION = 900;
export const LOAD_TIMEOUT_MS = 60_000;
export const SCAN_TIMEOUT_MS = 150_000;

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
  constructor(public stage: OcrStage, message: string) {
    super(message);
    this.name = "OcrError";
  }
}
export class OcrCancelled extends Error {
  constructor() { super("Cancelled"); this.name = "OcrCancelled"; }
}

export function validateImageFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Please choose a JPEG, PNG or WebP image.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return `Image is too large (${(file.size / 1048576).toFixed(1)} MB). Maximum is 10 MB.`;
  return null;
}

export async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new OcrError("decode", "This image couldn't be opened. Try a different photo, or save it as JPEG/PNG first.");
  }
}

function orientedSize(b: ImageBitmap, rot: Rotation) {
  return rot % 180 === 0 ? { w: b.width, h: b.height } : { w: b.height, h: b.width };
}

/** Draws the bitmap rotated (clockwise) and cropped, scaled so the long side ≤ maxDim. */
function render(b: ImageBitmap, rot: Rotation, crop: CropFractions | null, maxDim: number): HTMLCanvasElement {
  const { w: ow, h: oh } = orientedSize(b, rot);
  const c = crop ?? { left: 0, top: 0, right: 1, bottom: 1 };
  const cw = Math.max(1, (c.right - c.left) * ow);
  const ch = Math.max(1, (c.bottom - c.top) * oh);
  const scale = Math.min(1, maxDim / Math.max(cw, ch));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cw * scale));
  canvas.height = Math.max(1, Math.round(ch * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new OcrError("decode", "Image processing is not supported in this browser.");
  ctx.imageSmoothingQuality = "high";
  ctx.scale(scale, scale);
  ctx.translate(-c.left * ow, -c.top * oh);
  ctx.translate(ow / 2, oh / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(b, -b.width / 2, -b.height / 2);
  return canvas;
}

function flattenCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = flattenIllumination({ data: img.data, width: img.width, height: img.height });
  const prepared = ctx.createImageData(out.width, out.height);
  prepared.data.set(out.data);
  ctx.putImageData(prepared, 0, 0);
  return canvas;
}

/** Auto-detects the paper region in the oriented image as crop fractions (null = no clear edge). */
function autoCrop(b: ImageBitmap, rot: Rotation): CropFractions | null {
  const small = render(b, rot, null, 500);
  const ctx = small.getContext("2d")!;
  const img = ctx.getImageData(0, 0, small.width, small.height);
  const r: Rect | null = detectPaperBounds({ data: img.data, width: img.width, height: img.height });
  if (!r) return null;
  return { left: r.x / img.width, top: r.y / img.height, right: (r.x + r.width) / img.width, bottom: (r.y + r.height) / img.height };
}

const toBlob = (c: HTMLCanvasElement) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new OcrError("decode", "Could not prepare the image."))), "image/png"));

/** Guess for orientation probing order: receipts are portrait, so landscape photos are likely sideways. */
function rotationCandidates(b: ImageBitmap): Rotation[] {
  return b.width > b.height ? [270, 90, 0, 180] : [0, 180, 270, 90];
}

/** Prepared (oriented, cropped, flattened) preview so the user sees what the recogniser will read. */
export async function preparePreview(file: File, opts: ScanOptions): Promise<{ blob: Blob; rotation: Rotation; crop: CropFractions | null; autoRotation: boolean }> {
  const b = await decodeImage(file);
  try {
    const rotation = opts.rotation ?? rotationCandidates(b)[0]!;
    const crop = opts.crop ?? autoCrop(b, rotation);
    const blob = await toBlob(flattenCanvas(render(b, rotation, crop, PREVIEW_DIMENSION)));
    return { blob, rotation, crop, autoRotation: opts.rotation === null };
  } finally {
    b.close();
  }
}

export interface OcrProgress {
  stage: OcrStage;
  status: string;
  progress: number; // 0..1 overall
}

export interface OcrResult {
  text: string;
  rotation: Rotation;
  crop: CropFractions | null;
  passes: number;
}

/** Score callback supplied by the caller (keeps parsing out of this module). good=true skips fallback. */
export type TextScorer = (text: string) => { score: number; good: boolean };

type TWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;

export async function runOcr(
  file: File,
  opts: ScanOptions,
  onProgress: (p: OcrProgress) => void,
  signal: AbortSignal,
  scorer: TextScorer,
): Promise<OcrResult> {
  // Internal controller combines user cancel + overall time bound.
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal.aborted) throw new OcrCancelled();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, SCAN_TIMEOUT_MS);

  let stage: OcrStage = "decode";
  let range: [number, number] = [0, 0.05];
  const report = (status: string, p: number) => {
    if (ctrl.signal.aborted) return; // never emit stale progress after cancel/timeout
    onProgress({ stage, status, progress: range[0] + (range[1] - range[0]) * Math.min(1, Math.max(0, p)) });
  };
  const check = () => {
    if (ctrl.signal.aborted) throw timedOut ? new OcrError("timeout", "Scanning took too long. Try cropping closer to the receipt, or enter the items manually.") : new OcrCancelled();
  };
  /** Races a promise against cancellation so no stage can hang uncancellable. */
  const guard = <T,>(p: Promise<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      const a = () => { try { check(); } catch (e) { rej(e); } };
      ctrl.signal.addEventListener("abort", a, { once: true });
      if (ctrl.signal.aborted) a();
      p.then(res, rej).finally(() => ctrl.signal.removeEventListener("abort", a));
    });

  let worker: TWorker | null = null;
  let pendingWorker: Promise<TWorker> | null = null;
  const killOnAbort = () => { void worker?.terminate().catch(() => undefined); };
  ctrl.signal.addEventListener("abort", killOnAbort);
  let bitmap: ImageBitmap | null = null;

  try {
    report("Opening image", 0);
    const decoding = decodeImage(file);
    void decoding.then((b) => { if (ctrl.signal.aborted) b.close(); }, () => undefined);
    bitmap = await guard(decoding);
    check();

    stage = "load";
    range = [0.05, 0.25];
    report("Loading text recogniser", 0);
    let mod: typeof import("tesseract.js");
    try {
      mod = await guard(import("tesseract.js"));
    } catch (e) {
      if (e instanceof OcrCancelled || e instanceof OcrError) throw e;
      throw new OcrError("load", "Couldn't load the text recogniser. Check your connection and try again.");
    }
    check();
    let logStatus = "";
    pendingWorker = mod.createWorker("eng", mod.OEM.LSTM_ONLY, {
      logger: (m: { status: string; progress: number }) => {
        logStatus = m.status;
        if (m.status === "recognizing text") report("Reading text", m.progress ?? 0);
        else report(m.status.replace(/^\w/, (c) => c.toUpperCase()), m.progress ?? 0);
      },
      errorHandler: () => undefined,
    });
    // If cancelled while the worker is still starting, terminate it as soon as it exists.
    pendingWorker.then((w) => { if (ctrl.signal.aborted) void w.terminate().catch(() => undefined); }, () => undefined);
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      worker = await guard(Promise.race([
        pendingWorker,
        new Promise<never>((_, rej) => { loadTimer = setTimeout(() => rej(new OcrError("load", "The text recogniser took too long to download. Check your connection and try again.")), LOAD_TIMEOUT_MS); }),
      ]));
    } catch (e) {
      if (e instanceof OcrCancelled || e instanceof OcrError) throw e;
      throw new OcrError("load", `Couldn't start the text recogniser (${logStatus || "network"}). Check your connection and try again.`);
    } finally {
      clearTimeout(loadTimer);
    }
    check();
    await guard(worker.setParameters({ user_defined_dpi: "300", preserve_interword_spaces: "1" }));

    const recognize = async (canvas: HTMLCanvasElement, psm: string) => {
      await guard(worker!.setParameters({ tessedit_pageseg_mode: psm as never }));
      const blob = await guard(toBlob(canvas));
      check();
      try {
        const { data } = await guard(worker!.recognize(blob));
        check();
        return data;
      } catch (e) {
        if (e instanceof OcrCancelled || e instanceof OcrError) throw e;
        throw new OcrError("recognize", "The text recogniser failed on this image. Try rotating or cropping it, or enter items manually.");
      }
    };

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
        report(`Checking orientation`, 0);
        const probe = flattenCanvas(render(bitmap, rot, autoCrop(bitmap, rot), PROBE_DIMENSION));
        const data = await recognize(probe, "6");
        // Count confident, horizontal real words. Sideways text yields few, tall boxes.
        const score = data.words.filter((w) => w.confidence > 70 && w.text.replace(/[^A-Za-z0-9]/g, "").length >= 3 && w.bbox.x1 - w.bbox.x0 > w.bbox.y1 - w.bbox.y0).length;
        if (score > best.score) best = { rot, score };
        if (score >= 12) break;
      }
      if (best.score < 3) throw new OcrError("orient", "No readable text was found. Rotate the photo so the text is upright, crop to the receipt, or retake it in better light.");
      rotation = best.rot;
    }
    check();

    stage = "recognize";
    range = [0.45, 0.8];
    const crop = opts.crop ?? autoCrop(bitmap, rotation);
    const full = flattenCanvas(render(bitmap, rotation, crop, MAX_DIMENSION));
    bitmap.close();
    bitmap = null;
    report("Reading text", 0);
    const first = await recognize(full, "4"); // single column of variable-size text: suits receipts
    let text = first.text ?? "";
    let passes = 1;
    const s1 = scorer(text);
    if (!s1.good) {
      // Fallback only when the first reading is internally inconsistent.
      range = [0.8, 1];
      report("Double-checking", 0);
      const second = await recognize(full, "6");
      passes = 2;
      const s2 = scorer(second.text ?? "");
      if (s2.score > s1.score) text = second.text ?? "";
    }
    check();
    if (!text.trim()) throw new OcrError("recognize", "No text was found. Rotate the photo so the text is upright, crop to the receipt, or retake it in better light.");
    return { text, rotation, crop, passes };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    ctrl.signal.removeEventListener("abort", killOnAbort);
    // Also stop a worker that resolves after a load timeout or another failed stage.
    ctrl.abort();
    bitmap?.close();
    if (worker) await worker.terminate().catch(() => undefined);
    else if (pendingWorker) pendingWorker.then((w) => w.terminate(), () => undefined).catch(() => undefined);
  }
}

