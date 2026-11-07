/**
 * Browser image adapter: decode, rotate, crop, scale and lighting-correct a photo on a canvas.
 * Pixel maths lives in ./image (pure, testable); this file only moves pixels in and out of canvases.
 * Images stay in memory and are never uploaded or persisted.
 */
import { detectPaperBounds, flattenIllumination } from "./image";
import { OcrError, type CropFractions, type Rotation, type ScanOptions } from "./types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * Recognition size budget. Capping by pixel count and short side (instead of the long side) keeps
 * long supermarket receipts legible: a 1:6 strip still gets ~1000px across the paper.
 */
export const MAX_PIXELS = 7_000_000;
export const MAX_SHORT_SIDE = 2000;
export const MAX_LONG_SIDE = 8000; // stays inside mobile Safari's canvas limits
export const PROBE_PIXELS = 700_000;
export const PREVIEW_PIXELS = 600_000;

export function validateImageFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Please choose a JPEG, PNG or WebP image.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES)
    return `Image is too large (${(file.size / 1048576).toFixed(1)} MB). Maximum is 10 MB.`;
  return null;
}

/** Scale factor (≤ 1) that fits a w×h region inside the given budget. Pure; exported for tests. */
export function fitScale(
  w: number,
  h: number,
  maxPixels: number,
  maxShort = MAX_SHORT_SIDE,
  maxLong = MAX_LONG_SIDE,
): number {
  return Math.min(
    1,
    Math.sqrt(maxPixels / Math.max(1, w * h)),
    maxShort / Math.max(1, Math.min(w, h)),
    maxLong / Math.max(1, Math.max(w, h)),
  );
}

export async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new OcrError(
      "decode",
      "This image couldn't be opened. Try a different photo, or save it as JPEG/PNG first.",
    );
  }
}

function orientedSize(b: ImageBitmap, rot: Rotation) {
  return rot % 180 === 0 ? { w: b.width, h: b.height } : { w: b.height, h: b.width };
}

/** Draws the bitmap rotated (clockwise) and cropped, scaled to fit `maxPixels`. */
export function render(
  b: ImageBitmap,
  rot: Rotation,
  crop: CropFractions | null,
  maxPixels: number,
): HTMLCanvasElement {
  const { w: ow, h: oh } = orientedSize(b, rot);
  const c = crop ?? { left: 0, top: 0, right: 1, bottom: 1 };
  const cw = Math.max(1, (c.right - c.left) * ow);
  const ch = Math.max(1, (c.bottom - c.top) * oh);
  const scale = fitScale(cw, ch, maxPixels);
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

export function flattenCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = flattenIllumination({ data: img.data, width: img.width, height: img.height });
  const prepared = ctx.createImageData(out.width, out.height);
  prepared.data.set(out.data);
  ctx.putImageData(prepared, 0, 0);
  return canvas;
}

/** Auto-detects the paper region in the oriented image as crop fractions (null = no clear edge). */
export function autoCrop(b: ImageBitmap, rot: Rotation): CropFractions | null {
  const small = render(b, rot, null, 250_000);
  const ctx = small.getContext("2d")!;
  const img = ctx.getImageData(0, 0, small.width, small.height);
  const r = detectPaperBounds({ data: img.data, width: img.width, height: img.height });
  if (!r) return null;
  return {
    left: r.x / img.width,
    top: r.y / img.height,
    right: (r.x + r.width) / img.width,
    bottom: (r.y + r.height) / img.height,
  };
}

export const toBlob = (c: HTMLCanvasElement) =>
  new Promise<Blob>((res, rej) =>
    c.toBlob(
      (b) => (b ? res(b) : rej(new OcrError("decode", "Could not prepare the image."))),
      "image/png",
    ),
  );

/** Probe order for orientation: receipts are portrait, so landscape photos are likely sideways. */
export function rotationCandidates(b: { width: number; height: number }): Rotation[] {
  return b.width > b.height ? [270, 90, 0, 180] : [0, 180, 270, 90];
}

/** Oriented, cropped, flattened preview so the user sees what the recogniser will read. */
export async function preparePreview(
  file: File,
  opts: ScanOptions,
): Promise<{ blob: Blob; rotation: Rotation; crop: CropFractions | null; autoRotation: boolean }> {
  const b = await decodeImage(file);
  try {
    const rotation = opts.rotation ?? rotationCandidates(b)[0]!;
    const crop = opts.crop ?? autoCrop(b, rotation);
    const blob = await toBlob(flattenCanvas(render(b, rotation, crop, PREVIEW_PIXELS)));
    return { blob, rotation, crop, autoRotation: opts.rotation === null };
  } finally {
    b.close();
  }
}
