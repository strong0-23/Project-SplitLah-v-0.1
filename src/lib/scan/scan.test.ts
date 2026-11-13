import { afterEach, describe, expect, it, vi } from "vitest";
import { LOAD_TIMEOUT_MS, SCAN_TIMEOUT_MS, orientationSettled, runOcr } from "./scan";
import { OcrCancelled, OcrError, type OcrEngine, type OcrPage, type OcrWord } from "./types";

const mocks = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker, OEM: { LSTM_ONLY: 1 } }));

const file = new File(["image"], "receipt.jpg", { type: "image/jpeg" });
const options = { rotation: 0 as const, crop: { left: 0, top: 0, right: 1, bottom: 1 } };
const deps = { scorer: () => ({ score: 1, good: true }) };
const tick = () => vi.advanceTimersByTimeAsync(1);

function setup() {
  vi.useFakeTimers();
  const bitmap = { width: 2, height: 2, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const pixels = () => ({ data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 });
  vi.spyOn(document, "createElement").mockReturnValue({
    width: 2,
    height: 2,
    getContext: () => ({
      scale: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
      getImageData: pixels,
      createImageData: pixels,
      putImageData: vi.fn(),
    }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["pixels"])),
  } as unknown as HTMLCanvasElement);
  return bitmap;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.createWorker.mockReset();
});

describe("OCR resource cleanup", () => {
  it("does not start decoding for an already cancelled scan", async () => {
    setup();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runOcr(file, options, vi.fn(), ctrl.signal, deps)).rejects.toBeInstanceOf(
      OcrCancelled,
    );
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("closes a bitmap that arrives after cancellation during decoding", async () => {
    setup();
    let resolve!: (bitmap: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const ctrl = new AbortController();
    const scan = runOcr(file, options, vi.fn(), ctrl.signal, deps);
    const failure = expect(scan).rejects.toBeInstanceOf(OcrCancelled);
    ctrl.abort();
    await failure;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    resolve(bitmap);
    await tick();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("terminates a worker that finishes loading after the load timeout", async () => {
    setup();
    let resolve!: (worker: unknown) => void;
    mocks.createWorker.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const progress = vi.fn();
    const scan = runOcr(file, options, progress, new AbortController().signal, deps);
    const failure = expect(scan).rejects.toMatchObject({ stage: "load" });
    await tick();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await failure;
    const count = progress.mock.calls.length;
    const worker = { terminate: vi.fn().mockResolvedValue(undefined) };
    resolve(worker);
    await tick();
    expect(worker.terminate).toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(count);
  });

  it("cancels a recognition in progress and releases its worker", async () => {
    setup();
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn(() => new Promise(() => {})),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createWorker.mockResolvedValue(worker);
    const ctrl = new AbortController();
    const scan = runOcr(file, options, vi.fn(), ctrl.signal, deps);
    const failure = expect(scan).rejects.toBeInstanceOf(OcrCancelled);
    await tick();
    expect(worker.recognize).toHaveBeenCalledOnce();
    ctrl.abort();
    await failure;
    expect(worker.terminate).toHaveBeenCalled();
  });
});

describe("per-engine load limit (OcrEngine.loadTimeoutMs)", () => {
  /** A fake engine whose load and recognize run as given; records terminate calls. */
  function fakeEngine(o: {
    loadTimeoutMs?: number;
    load: () => Promise<void>;
    recognize: () => Promise<never>;
  }) {
    const engine = {
      name: "fake",
      ...(o.loadTimeoutMs ? { loadTimeoutMs: o.loadTimeoutMs } : {}),
      load: vi.fn(o.load),
      recognize: vi.fn(o.recognize),
      terminate: vi.fn().mockResolvedValue(undefined),
    } satisfies OcrEngine;
    return engine;
  }
  const settle = (p: Promise<unknown>) => {
    const box: { v: unknown } = { v: "pending" };
    p.then(
      (v) => (box.v = v),
      (e) => (box.v = e),
    );
    return box;
  };

  it("uses the engine's own load limit instead of the default, then terminates it", async () => {
    setup();
    const engine = fakeEngine({
      loadTimeoutMs: 120_000,
      load: () => new Promise(() => {}),
      recognize: () => new Promise(() => {}),
    });
    const box = settle(
      runOcr(file, options, vi.fn(), new AbortController().signal, {
        ...deps,
        createEngine: () => engine,
      }),
    );
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1000);
    expect(box.v).toBe("pending"); // past the default limit, still loading
    await vi.advanceTimersByTimeAsync(120_000 - LOAD_TIMEOUT_MS);
    expect(box.v).toBeInstanceOf(OcrError);
    expect(box.v).toMatchObject({ stage: "load" });
    expect(engine.terminate).toHaveBeenCalled();
  });

  it("extends the overall scan limit by the extra load time, so recognition keeps its time", async () => {
    setup();
    const engine = fakeEngine({
      loadTimeoutMs: 120_000,
      load: () => new Promise((r) => setTimeout(r, 100_000)),
      recognize: () => new Promise(() => {}),
    });
    const box = settle(
      runOcr(file, options, vi.fn(), new AbortController().signal, {
        ...deps,
        createEngine: () => engine,
      }),
    );
    await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS + 1000);
    expect(box.v).toBe("pending");
    await vi.advanceTimersByTimeAsync(120_000 - LOAD_TIMEOUT_MS);
    expect(box.v).toMatchObject({ stage: "timeout" });
  });

  it("an engine that sets no limit keeps the default", async () => {
    setup();
    const engine = fakeEngine({
      load: () => new Promise(() => {}),
      recognize: () => new Promise(() => {}),
    });
    const box = settle(
      runOcr(file, options, vi.fn(), new AbortController().signal, {
        ...deps,
        createEngine: () => engine,
      }),
    );
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1000);
    expect(box.v).toMatchObject({ stage: "load" });
  });
});

// ---------------------------------------------------------------------------------------------
// WO-001 (D14): orientation. Synthetic word boxes only.

const word = (text: string, confidence: number, y = 0, wide = true): OcrWord => ({
  text,
  confidence,
  bbox: { x0: 0, y0: y, x1: wide ? 60 : 10, y1: y + 20 },
});
/** `confident` wide words with confidence 90, plus `doubtful` long words with confidence 20. */
const probePage = (confident: number, doubtful: number): OcrPage => ({
  text: "",
  words: [
    ...Array.from({ length: confident }, () => word("SAMPLE", 90)),
    ...Array.from({ length: doubtful }, () => word("XQZW", 20)),
  ],
});

describe("orientation (D14)", () => {
  it("stops early on an upright probe: many confident words, a large share of those read", () => {
    expect(orientationSettled(probePage(60, 20))).toBe(true);
  });

  it("does not stop on an upside-down probe: some confident words, but a small share", () => {
    // Upside-down text on a long receipt still gives a dozen or more confident words.
    expect(orientationSettled(probePage(15, 100))).toBe(false);
  });

  it("does not stop on too few confident words, whatever their share", () => {
    expect(orientationSettled(probePage(8, 0))).toBe(false);
  });

  it("keeps probing past an upside-down first probe and picks the upright rotation", async () => {
    setup();
    const probes = [probePage(15, 100), probePage(60, 20)];
    let calls = 0;
    const engine: OcrEngine = {
      name: "fake",
      load: vi.fn(async () => undefined),
      recognize: vi.fn(async () =>
        calls < probes.length ? probes[calls++]! : { text: "TOTAL 1.00", words: [] },
      ),
      terminate: vi.fn(async () => undefined),
    };
    const res = await runOcr(
      file,
      { rotation: null, crop: null },
      vi.fn(),
      new AbortController().signal,
      { ...deps, createEngine: () => engine },
    );
    expect(res.rotation).toBe(180); // the second candidate for a square/portrait photo
  });
});
