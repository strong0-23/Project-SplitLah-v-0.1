/**
 * Engine reuse between scans (engine-pool.ts + scan.ts): reuse, idle disposal, cancel-then-rescan,
 * engine change, errors, page hide and concurrent scans. A fake engine and mocked canvases; no
 * real OCR, image or receipt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENGINE_IDLE_MS, EnginePool, sharedEnginePool } from "./engine-pool";
import { runOcr, type OcrProgress } from "./scan";
import { OcrCancelled, OcrError, type EngineProgress, type OcrEngine, type OcrPage } from "./types";

const file = new File(["image"], "receipt.jpg", { type: "image/jpeg" });
// Fixed rotation and crop: no orientation probes, one recognition per scan.
const options = { rotation: 0 as const, crop: { left: 0, top: 0, right: 1, bottom: 1 } };
const PAGE: OcrPage = {
  text: "EXAMPLE CAFE\nTea 2.50",
  words: [{ text: "EXAMPLE", confidence: 90, bbox: { x0: 0, y0: 0, x1: 50, y1: 10 } }],
};

function setupCanvas() {
  vi.useFakeTimers();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 2, height: 2, close: vi.fn() })),
  );
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
    toBlob: (cb: (b: Blob) => void) => cb(new Blob(["pixels"])),
  } as unknown as HTMLCanvasElement);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A fake engine factory that records every engine it makes. */
function fakeEngines(
  opts: { recognize?: () => Promise<OcrPage>; load?: () => Promise<void> } = {},
) {
  const made: Array<{
    load: ReturnType<typeof vi.fn>;
    recognize: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    report: ((p: EngineProgress) => void) | null;
  }> = [];
  const factory = (): OcrEngine => {
    const rec = {
      report: null as ((p: EngineProgress) => void) | null,
      load: vi.fn(async (report: (p: EngineProgress) => void) => {
        rec.report = report;
        await (opts.load?.() ?? Promise.resolve());
      }),
      recognize: vi.fn(async () => {
        // Like Tesseract: recognition progress comes through the logger given to `load`.
        rec.report?.({ status: "Reading text", progress: 0.5 });
        return (opts.recognize ?? (async () => PAGE))();
      }),
      terminate: vi.fn(async () => undefined),
    };
    made.push(rec);
    return {
      name: "fake",
      load: rec.load,
      recognize: rec.recognize,
      terminate: rec.terminate,
    };
  };
  return { factory, made };
}

const scan = (
  pool: EnginePool | undefined,
  createEngine: () => OcrEngine,
  signal = new AbortController().signal,
  onProgress: (p: OcrProgress) => void = () => undefined,
) =>
  runOcr(file, options, onProgress, signal, {
    scorer: () => ({ score: 1, good: true }),
    createEngine,
    ...(pool ? { pool } : {}),
  });

describe("engine reuse between scans", () => {
  it("reuses the loaded engine for the next scan: loaded once, never terminated in between", async () => {
    setupCanvas();
    const pool = new EnginePool();
    const { factory, made } = fakeEngines();
    await scan(pool, factory);
    await scan(pool, factory);
    await scan(pool, factory);
    expect(made).toHaveLength(1);
    expect(made[0]!.load).toHaveBeenCalledOnce();
    expect(made[0]!.recognize).toHaveBeenCalledTimes(3);
    expect(made[0]!.terminate).not.toHaveBeenCalled();
    expect(pool.isWarm(factory)).toBe(true);
  });

  it("a warm scan skips loading and still gets the engine's progress", async () => {
    setupCanvas();
    const pool = new EnginePool();
    const { factory } = fakeEngines();
    await scan(pool, factory);
    const progress: OcrProgress[] = [];
    await scan(pool, factory, undefined, (p) => progress.push(p));
    expect(progress.map((p) => p.status)).toContain("Text recogniser ready");
    expect(progress.map((p) => p.status)).not.toContain("Loading text recogniser");
    // Progress the engine reports through its load-time callback reaches the current scan.
    expect(progress.map((p) => p.status)).toContain("Reading text");
  });

  it("disposes the kept engine after the idle timeout, and the next scan loads a new one", async () => {
    setupCanvas();
    const pool = new EnginePool();
    const { factory, made } = fakeEngines();
    await scan(pool, factory);
    await vi.advanceTimersByTimeAsync(ENGINE_IDLE_MS - 1000);
    expect(made[0]!.terminate).not.toHaveBeenCalled();
    await scan(pool, factory); // use resets the idle timer
    await vi.advanceTimersByTimeAsync(ENGINE_IDLE_MS - 1000);
    expect(made[0]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(made[0]!.terminate).toHaveBeenCalledOnce();
    expect(pool.isWarm(factory)).toBe(false);
    await scan(pool, factory);
    expect(made).toHaveLength(2);
    expect(made[1]!.load).toHaveBeenCalledOnce();
  });

  it("cancel stops a running recognition at once; the next scan reloads a fresh engine", async () => {
    setupCanvas();
    const pool = new EnginePool();
    let hang = false;
    const { factory, made } = fakeEngines({
      recognize: () => (hang ? new Promise(() => {}) : Promise.resolve(PAGE)),
    });
    await scan(pool, factory); // warm
    hang = true;
    const ctrl = new AbortController();
    const running = scan(pool, factory, ctrl.signal);
    const failure = expect(running).rejects.toBeInstanceOf(OcrCancelled);
    await vi.advanceTimersByTimeAsync(1);
    expect(made[0]!.recognize).toHaveBeenCalledTimes(2);
    ctrl.abort();
    expect(made[0]!.terminate).toHaveBeenCalledOnce(); // synchronously on cancel
    await failure;
    hang = false;
    await scan(pool, factory);
    expect(made).toHaveLength(2);
    expect(made[1]!.load).toHaveBeenCalledOnce();
    expect(made[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("disposes the engine on a scan error", async () => {
    setupCanvas();
    const pool = new EnginePool();
    let fail = false;
    const { factory, made } = fakeEngines({
      recognize: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve(PAGE)),
    });
    await scan(pool, factory);
    fail = true;
    await expect(scan(pool, factory)).rejects.toBeInstanceOf(OcrError);
    expect(made[0]!.terminate).toHaveBeenCalledOnce();
    expect(pool.isWarm(factory)).toBe(false);
  });

  it("keeps the 60 s load limit for a new engine, and discards an engine that misses it", async () => {
    setupCanvas();
    const pool = new EnginePool();
    const { factory, made } = fakeEngines({ load: () => new Promise(() => {}) });
    const running = scan(pool, factory);
    const failure = expect(running).rejects.toMatchObject({ stage: "load" });
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(made[0]!.terminate).toHaveBeenCalled();
    expect(pool.isWarm(factory)).toBe(false);
  });

  it("disposes the kept engine when another engine is chosen", async () => {
    setupCanvas();
    const pool = new EnginePool();
    const a = fakeEngines();
    const b = fakeEngines();
    await scan(pool, a.factory);
    await scan(pool, b.factory);
    expect(a.made[0]!.terminate).toHaveBeenCalledOnce();
    expect(b.made[0]!.terminate).not.toHaveBeenCalled();
    expect(pool.isWarm(b.factory)).toBe(true);
  });

  it("gives a concurrent scan its own single-use engine", async () => {
    setupCanvas();
    const pool = new EnginePool();
    const { factory, made } = fakeEngines();
    await Promise.all([scan(pool, factory), scan(pool, factory)]);
    expect(made).toHaveLength(2);
    expect(made.filter((m) => m.terminate.mock.calls.length === 1)).toHaveLength(1);
    expect(pool.isWarm(factory)).toBe(true);
  });

  it("without a pool, the engine is terminated after every scan (unchanged behaviour)", async () => {
    setupCanvas();
    const { factory, made } = fakeEngines();
    await scan(undefined, factory);
    await scan(undefined, factory);
    expect(made).toHaveLength(2);
    for (const m of made) expect(m.terminate).toHaveBeenCalledOnce();
  });

  it("the page's shared pool is disposed on pagehide", async () => {
    setupCanvas();
    const pool = sharedEnginePool();
    const { factory, made } = fakeEngines();
    await scan(pool, factory);
    expect(pool.isWarm(factory)).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(1);
    expect(made[0]!.terminate).toHaveBeenCalledOnce();
    expect(pool.isWarm(factory)).toBe(false);
  });
});
