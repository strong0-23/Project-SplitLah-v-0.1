/**
 * On-device OCR. Tesseract.js is lazy-loaded only when a scan starts. It runs in a Web Worker;
 * worker/core/language files are fetched from the jsDelivr CDN on first use. The image itself
 * never leaves the browser.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_DIMENSION = 2000;

export function validateImageFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Please choose a JPEG, PNG or WebP image.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return `Image is too large (${(file.size / 1048576).toFixed(1)} MB). Maximum is 10 MB.`;
  return null;
}

/** Downscale to MAX_DIMENSION and convert to greyscale to speed up OCR. */
export async function prepareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("This image could not be read. Try another photo.");
  });
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image processing is not supported in this browser.");
  ctx.filter = "grayscale(1) contrast(1.2)";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not prepare image."))), "image/png"),
  );
}

export interface OcrProgress {
  status: string;
  progress: number; // 0..1
}

export async function runOcr(file: File, onProgress: (p: OcrProgress) => void, signal?: AbortSignal): Promise<string> {
  onProgress({ status: "Preparing image", progress: 0 });
  const blob = await prepareImage(file);
  onProgress({ status: "Loading text recogniser", progress: 0 });
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    logger: (m: { status: string; progress: number }) =>
      onProgress({ status: m.status.replace(/^\w/, (c) => c.toUpperCase()), progress: m.progress ?? 0 }),
  });
  const abort = () => void worker.terminate();
  signal?.addEventListener("abort", abort);
  try {
    const { data } = await worker.recognize(blob);
    if (signal?.aborted) throw new Error("Cancelled");
    return data.text ?? "";
  } finally {
    signal?.removeEventListener("abort", abort);
    await worker.terminate().catch(() => undefined);
  }
}
