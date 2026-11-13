/**
 * Browser image adapter: decode, rotate, crop, scale and lighting-correct a photo on a canvas.
 * Pixel maths lives in ./image (pure, testable); this file only moves pixels in and out of canvases.
 * Images stay in memory and are never uploaded or persisted.
 */
import { detectPaperBounds, flattenIllumination, inkRowProfile } from "./image";
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

/**
 * Shown when the browser blocks or randomises canvas read-back (privacy / anti-fingerprinting
 * protection, e.g. Firefox `privacy.resistFingerprinting`, Zen, Tor Browser, Brave). Without
 * read-back, every processed image comes out blank (a black preview) or noisy, so scanning can't work.
 */
export const CANVAS_BLOCKED_MESSAGE =
  "Your browser is blocking image processing for this site (privacy/fingerprinting protection). Allow it for this site, or use another browser such as Edge or Chrome. You can still enter items manually.";

/** Side of the read-back probe canvas, in pixels. Four solid quadrants of known colours. */
export const PROBE_SIZE = 8;
const PROBE_COLOURS: ReadonlyArray<readonly [number, number, number]> = [
  [220, 20, 60],
  [30, 144, 255],
  [255, 215, 0],
  [16, 16, 16],
];

/** The opaque colour the probe draws at (x, y). Pure. */
export function probeColourAt(x: number, y: number): readonly [number, number, number] {
  const half = PROBE_SIZE / 2;
  return PROBE_COLOURS[(x >= half ? 1 : 0) + (y >= half ? 2 : 0)]!;
}

/**
 * True when RGBA data read back from the probe is exactly what was drawn. Solid opaque sRGB colours
 * round-trip exactly in every normal browser; blocked read-back returns zeros or a blank image, and
 * randomised read-back changes some values. Pure; exported for tests.
 */
export function probeMatches(data: ArrayLike<number>): boolean {
  if (data.length !== PROBE_SIZE * PROBE_SIZE * 4) return false;
  for (let y = 0; y < PROBE_SIZE; y++) {
    for (let x = 0; x < PROBE_SIZE; x++) {
      const i = (y * PROBE_SIZE + x) * 4;
      const [r, g, b] = probeColourAt(x, y);
      if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== 255)
        return false;
    }
  }
  return true;
}

/** A passing check is remembered for the page session; a failing one is re-run next time (cheap),
 *  so allowing the site in the browser's prompt takes effect without a reload. */
let readbackOk = false;

/** Draws the probe on a tiny canvas and reads it back. Returns false if read-back is blocked or altered. */
export function canvasReadbackWorks(): boolean {
  if (readbackOk) return true;
  let ok: boolean;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PROBE_SIZE;
    canvas.height = PROBE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // No 2D canvas at all is a different failure; render() reports it with its own message.
    if (!ctx) return true;
    const half = PROBE_SIZE / 2;
    for (let q = 0; q < 4; q++) {
      const [r, g, b] = PROBE_COLOURS[q]!;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect((q % 2) * half, Math.floor(q / 2) * half, half, half);
    }
    ok = probeMatches(ctx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data);
  } catch {
    ok = false; // some browsers throw (SecurityError) instead of returning blank data
  }
  readbackOk = ok;
  return ok;
}

/** Throws the user-facing "browser is blocking image processing" error when read-back doesn't work. */
export function assertCanvasReadable(): void {
  if (!canvasReadbackWorks()) throw new OcrError("decode", CANVAS_BLOCKED_MESSAGE);
}

/** Tests only: `true` skips the probe (mocked canvases), `false` forces it to run again. */
export function setCanvasReadbackCheckedForTests(passed: boolean): void {
  readbackOk = passed;
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

/** Which rows of a flattened canvas hold print (`inkRowProfile`). */
export function inkRows(canvas: HTMLCanvasElement): Uint8Array {
  const img = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  return inkRowProfile({ data: img.data, width: img.width, height: img.height });
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
  assertCanvasReadable(); // never show a blank (black) preview
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
