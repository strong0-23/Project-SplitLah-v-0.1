/**
 * Canvas read-back probe: browsers with fingerprinting protection (Firefox resistFingerprinting,
 * Zen, Brave, Tor Browser) return blank or randomised pixels from a canvas. The scanner must notice
 * that before showing a (black) preview or downloading an engine. Mocked canvases only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_BLOCKED_MESSAGE,
  PROBE_SIZE,
  canvasReadbackWorks,
  preparePreview,
  probeColourAt,
  probeMatches,
  setCanvasReadbackCheckedForTests,
} from "./canvas";
import { runOcr } from "./scan";
import { OcrError, type OcrEngine } from "./types";

type Mode = "faithful" | "zeros" | "white" | "noise" | "throws" | "no-context";

/** The probe pattern as a real browser reads it back. */
function drawnPattern(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(PROBE_SIZE * PROBE_SIZE * 4);
  for (let y = 0; y < PROBE_SIZE; y++)
    for (let x = 0; x < PROBE_SIZE; x++) {
      const [r, g, b] = probeColourAt(x, y);
      d.set([r, g, b, 255], (y * PROBE_SIZE + x) * 4);
    }
  return d;
}

/** Small deterministic noise, like canvas randomisation: a few values nudged by 1–3. */
function withNoise(d: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(d);
  for (let i = 0; i < out.length; i += 37) if (i % 4 !== 3) out[i] = out[i]! ^ (1 + (i % 3));
  return out;
}

/** A canvas whose 2D context draws faithfully, or returns zeros/white/noise, as a protected browser does. */
function fakeCanvas(mode: Mode) {
  const data = new Uint8ClampedArray(PROBE_SIZE * PROBE_SIZE * 4);
  let fill: number[] = [0, 0, 0];
  const ctx = {
    set fillStyle(v: string) {
      fill = v.match(/\d+/g)!.map(Number);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) data.set([...fill, 255], (yy * PROBE_SIZE + xx) * 4);
    },
    getImageData() {
      if (mode === "throws") throw new DOMException("blocked", "SecurityError");
      const out =
        mode === "zeros"
          ? new Uint8ClampedArray(data.length)
          : mode === "white"
            ? new Uint8ClampedArray(data.length).fill(255)
            : mode === "noise"
              ? withNoise(data)
              : new Uint8ClampedArray(data);
      return { data: out, width: PROBE_SIZE, height: PROBE_SIZE };
    },
  };
  return { width: 0, height: 0, getContext: () => (mode === "no-context" ? null : ctx) };
}

let canvasesMade = 0;
function useCanvas(mode: Mode) {
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return original(tag);
    canvasesMade++;
    return fakeCanvas(mode) as unknown as HTMLCanvasElement;
  }) as typeof document.createElement);
}

beforeEach(() => {
  setCanvasReadbackCheckedForTests(false); // run the real probe in this file
  canvasesMade = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("probeMatches (pure)", () => {
  it("accepts exactly the drawn pattern", () => {
    expect(probeMatches(drawnPattern())).toBe(true);
  });
  it("rejects zeros, a blank white image, noise, and the wrong size", () => {
    expect(probeMatches(new Uint8ClampedArray(PROBE_SIZE * PROBE_SIZE * 4))).toBe(false);
    expect(probeMatches(new Uint8ClampedArray(PROBE_SIZE * PROBE_SIZE * 4).fill(255))).toBe(false);
    expect(probeMatches(withNoise(drawnPattern()))).toBe(false);
    expect(probeMatches(drawnPattern().subarray(4))).toBe(false);
  });
});

describe("canvasReadbackWorks", () => {
  it("passes when read-back is faithful, and remembers it for the session", () => {
    useCanvas("faithful");
    expect(canvasReadbackWorks()).toBe(true);
    expect(canvasReadbackWorks()).toBe(true);
    expect(canvasesMade).toBe(1); // probed once
  });

  it.each(["zeros", "white", "noise", "throws"] as const)(
    "fails when read-back returns %s, and checks again next time",
    (mode) => {
      useCanvas(mode);
      expect(canvasReadbackWorks()).toBe(false);
      expect(canvasReadbackWorks()).toBe(false);
      expect(canvasesMade).toBe(2); // not cached: allowing the site takes effect without a reload
    },
  );

  it("passes once the browser starts allowing read-back (site permission granted)", () => {
    useCanvas("zeros");
    expect(canvasReadbackWorks()).toBe(false);
    vi.restoreAllMocks();
    useCanvas("faithful");
    expect(canvasReadbackWorks()).toBe(true);
  });

  it("does not report a browser with no 2D canvas as blocked (render() reports that)", () => {
    useCanvas("no-context");
    expect(canvasReadbackWorks()).toBe(true);
  });
});

describe("blocked read-back stops both the preview and the scan", () => {
  const file = new File(["image"], "receipt.png", { type: "image/png" });

  it.each(["zeros", "noise"] as const)(
    "preview: throws the decode error with %s, before decoding (no black preview)",
    async (mode) => {
      useCanvas(mode);
      const decode = vi.fn();
      vi.stubGlobal("createImageBitmap", decode);
      const err = await preparePreview(file, { rotation: null, crop: null }).catch((e) => e);
      expect(err).toBeInstanceOf(OcrError);
      expect(err).toMatchObject({ stage: "decode", message: CANVAS_BLOCKED_MESSAGE });
      expect(decode).not.toHaveBeenCalled();
    },
  );

  it.each(["zeros", "noise"] as const)(
    "scan: throws the decode error with %s before the engine loads, and releases the engine",
    async (mode) => {
      useCanvas(mode);
      vi.stubGlobal("createImageBitmap", vi.fn());
      const engine: OcrEngine = {
        name: "fake",
        load: vi.fn(async () => undefined),
        recognize: vi.fn(async () => ({ text: "", words: [] })),
        terminate: vi.fn(async () => undefined),
      };
      const err = await runOcr(
        file,
        { rotation: 0, crop: null },
        () => undefined,
        new AbortController().signal,
        { createEngine: () => engine, scorer: () => ({ score: 0, good: true }) },
      ).catch((e) => e);
      expect(err).toMatchObject({ stage: "decode", message: CANVAS_BLOCKED_MESSAGE });
      expect(err).toBeInstanceOf(OcrError);
      expect(engine.load).not.toHaveBeenCalled();
      expect(engine.terminate).toHaveBeenCalled();
      expect(createImageBitmap).not.toHaveBeenCalled();
    },
  );
});
