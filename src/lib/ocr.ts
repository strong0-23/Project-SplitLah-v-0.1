/**
 * On-device OCR. Tesseract.js is lazy-loaded only when a scan starts. It runs in a Web Worker;
 * worker/core/language files are fetched from the jsDelivr CDN on first use. The image itself
 * never leaves the browser.
 *
 * Pipeline (each stage reports its own errors): decode → load recogniser → orient → crop +
 * illumination flattening at near-native resolution → recognise (single-column layout) → optional
 * second pass (uniform block layout), then an original-colour fallback if still inconsistent.
 */
import { detectPaperBounds, flattenIllumination, grayscale, type Rect } from "./preprocess";
import { itemRegion, type OcrWord } from "./ocr-regions";

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

function flattenCanvas(canvas: HTMLCanvasElement, channel: "luminance" | "blue" = "luminance", radiusScale = 1, illumination = true): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = { data: img.data, width: img.width, height: img.height };
  const radius = radiusScale === 1 ? undefined : Math.max(1, Math.round(Math.max(12, Math.round(Math.min(img.width, img.height) / 45)) * radiusScale));
  const out = illumination ? flattenIllumination(pixels, radius, channel) : grayscale(pixels, channel);
  const prepared = ctx.createImageData(out.width, out.height);
  prepared.data.set(out.data);
  ctx.putImageData(prepared, 0, 0);
  return canvas;
}

function fineRotate(canvas: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  if (!degrees) return canvas;
  const angle = degrees * Math.PI / 180;
  const out = document.createElement("canvas");
  out.width = Math.ceil(Math.abs(canvas.width * Math.cos(angle)) + Math.abs(canvas.height * Math.sin(angle)));
  out.height = Math.ceil(Math.abs(canvas.height * Math.cos(angle)) + Math.abs(canvas.width * Math.sin(angle)));
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2); ctx.rotate(angle);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
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
  /** In-memory diagnostics; private regression reports may retain these, never app storage. */
  attempts: { text: string; preprocessing: "flattened" | "original" | "blue-adaptive" | "grayscale"; pageSegmentation: "4" | "6"; score: number | null; good: boolean; words?: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[];
  selectedAttempt: number;
  itemReadings?: { itemIndex: number; description: string; sourceAttempt: number; crop: CropFractions; attempts: { text: string; words: OcrWord[]; pageSegmentation: "4" | "6" }[]; error?: string }[];
}

/** Development experiments only. Omitting this argument preserves the normal pipeline. */
export interface OcrDiagnostics {
  maxDimension?: number;
  lighting?: "adaptive" | "blue-adaptive" | "grayscale" | "original";
  radiusScale?: number;
  fineRotationDegrees?: number;
  includeWords?: boolean;
  itemRegions?: boolean;
  onPrepared?: (image: { blob: Blob; width: number; height: number; preprocessing: OcrResult["attempts"][number]["preprocessing"] }) => Promise<void>;
}

/** Score callback supplied by the caller (keeps parsing out of this module). good=true skips fallback. */
export type TextScorer = (text: string) => { score: number; good: boolean; recoveryItems?: { index: number; description: string }[] };

type TWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;

export async function runOcr(
  file: File,
  opts: ScanOptions,
  onProgress: (p: OcrProgress) => void,
  signal: AbortSignal,
  scorer: TextScorer,
  diagnostic?: OcrDiagnostics,
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
    const maxDimension = Math.min(6000, Math.max(64, diagnostic?.maxDimension ?? MAX_DIMENSION));
    const radiusScale = Math.min(4, Math.max(0.25, diagnostic?.radiusScale ?? 1));
    const fineRotation = Math.min(10, Math.max(-10, diagnostic?.fineRotationDegrees ?? 0));
    const lighting = diagnostic?.lighting ?? "adaptive";
    const preprocessing = lighting === "adaptive" ? "flattened" : lighting;
    let full = fineRotate(render(bitmap, rotation, crop, maxDimension), fineRotation);
    if (lighting !== "original") full = flattenCanvas(full, lighting === "blue-adaptive" ? "blue" : "luminance", radiusScale, lighting !== "grayscale");
    if (diagnostic?.onPrepared) await guard(diagnostic.onPrepared({ blob: await guard(toBlob(full)), width: full.width, height: full.height, preprocessing }));
    report("Reading text", 0);
    const first = await recognize(full, "4"); // single column of variable-size text: suits receipts
    let text = first.text ?? "";
    let passes = 1;
    const s1 = scorer(text);
    const attempts: OcrResult["attempts"] = [];
    const record = (candidate: string, preprocessing: OcrResult["attempts"][number]["preprocessing"], pageSegmentation: "4" | "6", rating: ReturnType<TextScorer>, words: OcrResult["attempts"][number]["words"]) => {
      attempts.push({ text: candidate, preprocessing, pageSegmentation, score: Number.isFinite(rating.score) ? rating.score : null, good: rating.good,
        ...(diagnostic?.includeWords ? { words: words?.map(w => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })) ?? [] } : {}) });
    };
    record(text, preprocessing, "4", s1, first.words);
    let best = s1;
    let bestData = first;
    let selectedAttempt = 0;
    if (!s1.good) {
      // Fallback only when the first reading is internally inconsistent.
      range = [0.8, 0.9];
      report("Double-checking", 0);
      const second = await recognize(full, "6");
      passes = 2;
      const s2 = scorer(second.text ?? "");
      record(second.text ?? "", preprocessing, "6", s2, second.words);
      if (s2.score > best.score) { text = second.text ?? ""; best = s2; bestData = second; selectedAttempt = 1; }
    }
    if (!best.good) {
      // Lighting correction can remove faint strokes. Try the same crop without it.
      // Experimental colour readings must pass acceptance before replacing recovered
      // rows: a sparse, damaged parse can score higher merely by losing uncertain rows.
      // A reading with no recovered items (-Infinity) can still be rescued.
      range = [0.9, 1];
      report("Checking original colours", 0);
      const original = fineRotate(render(bitmap, rotation, crop, maxDimension), fineRotation);
      if (diagnostic?.onPrepared) await guard(diagnostic.onPrepared({ blob: await guard(toBlob(original)), width: original.width, height: original.height, preprocessing: "original" }));
      const third = await recognize(original, "6");
      const candidate = third.text ?? "";
      const s3 = scorer(candidate);
      record(candidate, "original", "6", s3, third.words);
      passes = 3;
      if (s3.score > best.score && (s3.good || best.score === Number.NEGATIVE_INFINITY)) {
        text = candidate;
        best = s3; bestData = third;
        selectedAttempt = 2;
      }
    }
    const itemReadings: NonNullable<OcrResult["itemReadings"]> = [];
    // Item geometry, never reference answers or totals, determines native-resolution
    // row crops. At most two unresolved rows are checked; known-price rows are untouched.
    if ((diagnostic?.itemRegions ?? true) && fineRotation === 0) for (const item of (best.recoveryItems ?? []).slice(0, 2)) {
      const region = itemRegion(bestData.words ?? [], item.description, full.width, full.height);
      if (!region) continue;
      const base = crop ?? { left: 0, top: 0, right: 1, bottom: 1 };
      const rowCrop = { left: base.left + (base.right - base.left) * region.left, right: base.left + (base.right - base.left) * region.right, top: base.top + (base.bottom - base.top) * region.top, bottom: base.top + (base.bottom - base.top) * region.bottom };
      const reading: NonNullable<OcrResult["itemReadings"]>[number] = { itemIndex: item.index, description: item.description, sourceAttempt: selectedAttempt, crop: rowCrop, attempts: [] };
      itemReadings.push(reading);
      try {
        range = [.97, 1]; report("Checking an unreadable item row", 0);
        const row = flattenCanvas(render(bitmap, rotation, rowCrop, 4096));
        if (diagnostic?.onPrepared) await guard(diagnostic.onPrepared({ blob: await guard(toBlob(row)), width: row.width, height: row.height, preprocessing: "flattened" }));
        for (const mode of ["4", "6"] as const) {
          const data = await recognize(row, mode);
          reading.attempts.push({ text: data.text ?? "", words: (data.words ?? []).map(w => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })), pageSegmentation: mode });
        }
      } catch (e) {
        if (e instanceof OcrCancelled || (e instanceof OcrError && e.stage === "timeout")) throw e;
        reading.error = e instanceof Error ? e.message : String(e);
      }
    }
    check();
    if (!text.trim()) throw new OcrError("recognize", "No text was found. Rotate the photo so the text is upright, crop to the receipt, or retake it in better light.");
    return { text, rotation, crop, passes, attempts, selectedAttempt, ...(itemReadings.length ? { itemReadings } : {}) };
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

