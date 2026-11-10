/**
 * Paddle adapter contract tests (Batch 2b), with a fake PaddleOCR SDK and an in-process fake
 * worker that runs the real worker-side runtime. They show the Paddle engine behaves like
 * Tesseract's: same word-box format, cancel and timeout through the shared workflow, and
 * resources released on terminate. No real model, image or receipt is used.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineFactoryFor, requestedEngine } from "./engine-select";
import {
  PADDLE_LOAD_TIMEOUT_MS,
  PADDLE_MODEL_MANIFEST,
  PADDLE_MODEL_PATHS,
  PADDLE_MODEL_SOURCE_DIR,
  PADDLE_MODEL_URL_DIR,
  PADDLE_ORT_VERSION,
  PADDLE_PREDICT_SETTINGS,
  PADDLE_SDK_VERSION,
  engineSwitchForBuild,
} from "./paddle-assets";
import { createPaddleEngine, paddleItemsToPage, type WorkerLike } from "./paddle-engine";
import {
  createPaddleRuntime,
  type FromPaddleWorker,
  type PaddleInstance,
  type PaddleItem,
  type ToPaddleWorker,
} from "./paddle-runtime";
import { LOAD_TIMEOUT_MS, runOcr, SCAN_TIMEOUT_MS } from "./scan";
import { OcrCancelled, OcrError } from "./types";

const ORIGIN = "https://splitlah.example";
const ITEMS: PaddleItem[] = [
  {
    poly: [
      [300, 52],
      [380, 50],
      [381, 70],
      [301, 72],
    ],
    text: "8.50",
    score: 0.98,
  },
  {
    poly: [
      [10, 50],
      [120, 50],
      [120, 70],
      [10, 70],
    ],
    text: "Fried Rice",
    score: 0.9,
  },
  {
    poly: [
      [10, 10],
      [200, 10],
      [200, 30],
      [10, 30],
    ],
    text: "EXAMPLE CAFE",
    score: 0.5,
  },
  {
    poly: [
      [10, 90],
      [20, 90],
      [20, 95],
      [10, 95],
    ],
    text: "  ",
    score: 0.9,
  },
];

/** A fake SDK instance whose calls the tests can hold open or fail. */
function fakeSdk(
  opts: {
    predict?: () => Promise<Array<{ items: PaddleItem[] }>>;
    init?: () => Promise<unknown>;
  } = {},
) {
  const instance: PaddleInstance & { disposed: number } = {
    disposed: 0,
    cv: { fake: "opencv" },
    initialize: vi.fn(opts.init ?? (async () => ({}))),
    predict: vi.fn(opts.predict ?? (async () => [{ items: ITEMS }])),
    dispose: vi.fn(async () => {
      instance.disposed++;
    }),
  };
  const createSdk = vi.fn(async () => instance);
  const inputs: Array<{ disposed: boolean }> = [];
  const toInput = vi.fn(async () => {
    const input = { disposed: false };
    inputs.push(input);
    return { input, dispose: () => (input.disposed = true) };
  });
  return { instance, createSdk, toInput, inputs };
}

/** An in-process "worker": messages go to the real runtime on a later microtask, like postMessage. */
function fakeWorker(sdk: ReturnType<typeof fakeSdk>) {
  const worker: WorkerLike & { terminated: number } = {
    terminated: 0,
    onmessage: null,
    onerror: null,
    postMessage(msg: ToPaddleWorker) {
      if (worker.terminated) return;
      queueMicrotask(() => void handle(msg));
    },
    terminate() {
      worker.terminated++;
    },
  };
  const handle = createPaddleRuntime(
    {
      createSdk: sdk.createSdk,
      toInput: sdk.toInput,
      ortUrls: { mjs: `${ORIGIN}/assets/ort.mjs`, wasm: `${ORIGIN}/assets/ort.wasm` },
    },
    (m: FromPaddleWorker) => {
      if (!worker.terminated) worker.onmessage?.({ data: m } as MessageEvent<FromPaddleWorker>);
    },
  );
  return worker;
}

const blob = new Blob(["pixels"], { type: "image/png" });

describe("word boxes come back in the same format as Tesseract's", () => {
  it("maps polygons to boxes, 0..1 scores to 0..100, drops empty text, keeps text as read", () => {
    const page = paddleItemsToPage(ITEMS);
    expect(page.words).toEqual([
      { text: "8.50", confidence: 98, bbox: { x0: 300, y0: 50, x1: 381, y1: 72 } },
      { text: "Fried Rice", confidence: 90, bbox: { x0: 10, y0: 50, x1: 120, y1: 70 } },
      { text: "EXAMPLE CAFE", confidence: 50, bbox: { x0: 10, y0: 10, x1: 200, y1: 30 } },
    ]);
    expect(page.text).toBe("EXAMPLE CAFE\nFried Rice\n8.50"); // top-to-bottom, then left-to-right
  });

  it("returns an empty page for no text", () => {
    expect(paddleItemsToPage([])).toEqual({ text: "", words: [] });
  });
});

describe("Paddle engine against a fake SDK", () => {
  it("loads same-origin models and runtime only, with the SDK's own worker off", async () => {
    const sdk = fakeSdk();
    const engine = createPaddleEngine({ createWorker: () => fakeWorker(sdk), origin: ORIGIN });
    const progress = vi.fn();
    await engine.load(progress);
    const opts = (sdk.createSdk.mock.calls[0] as unknown[])[0] as Record<string, never>;
    expect(opts).toMatchObject({
      worker: false,
      initialize: false,
      textDetectionModelAsset: { url: `${ORIGIN}${PADDLE_MODEL_PATHS.det}` },
      textRecognitionModelAsset: { url: `${ORIGIN}${PADDLE_MODEL_PATHS.rec}` },
      ortOptions: {
        backend: "wasm",
        numThreads: 1,
        wasmPaths: { mjs: `${ORIGIN}/assets/ort.mjs`, wasm: `${ORIGIN}/assets/ort.wasm` },
      },
    });
    expect(JSON.stringify(opts)).not.toMatch(/bcebos|jsdelivr|huggingface|unpkg/i);
    expect(sdk.instance.initialize).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith({ status: "Paddle ready", progress: 1 });
    expect(engine.loadTimeoutMs).toBe(PADDLE_LOAD_TIMEOUT_MS);
  });

  it("recognizes with the fixed Paddle960 settings and disposes the image input", async () => {
    const sdk = fakeSdk();
    const engine = createPaddleEngine({ createWorker: () => fakeWorker(sdk), origin: ORIGIN });
    await engine.load(() => undefined);
    const page = await engine.recognize(blob, "column");
    expect(page.words).toHaveLength(3);
    expect(sdk.instance.predict).toHaveBeenCalledWith(sdk.inputs[0], PADDLE_PREDICT_SETTINGS);
    expect(sdk.inputs[0]!.disposed).toBe(true);
  });

  it("reports an SDK failure as an error and still disposes the input", async () => {
    const sdk = fakeSdk({ predict: async () => Promise.reject(new Error("bad image")) });
    const engine = createPaddleEngine({ createWorker: () => fakeWorker(sdk), origin: ORIGIN });
    await engine.load(() => undefined);
    await expect(engine.recognize(blob, "column")).rejects.toThrow("bad image");
    expect(sdk.inputs[0]!.disposed).toBe(true);
  });

  it("fails to load if the SDK starts without its image library", async () => {
    const sdk = fakeSdk();
    delete sdk.instance.cv;
    const engine = createPaddleEngine({ createWorker: () => fakeWorker(sdk), origin: ORIGIN });
    await expect(engine.load(() => undefined)).rejects.toThrow(/image library/);
  });

  it("terminate ends the worker, rejects a running recognition, and is safe to repeat", async () => {
    const sdk = fakeSdk({ predict: () => new Promise(() => {}) });
    let worker!: ReturnType<typeof fakeWorker>;
    const engine = createPaddleEngine({
      createWorker: () => (worker = fakeWorker(sdk)),
      origin: ORIGIN,
    });
    await engine.load(() => undefined);
    const running = engine.recognize(blob, "column");
    await engine.terminate();
    await expect(running).rejects.toThrow("terminated");
    await engine.terminate(); // a second call is harmless
    expect(worker.terminated).toBe(1);
    await expect(engine.recognize(blob, "column")).rejects.toThrow("terminated");
  });

  it("terminate during load stops the load", async () => {
    const sdk = fakeSdk({ init: () => new Promise(() => {}) });
    const engine = createPaddleEngine({ createWorker: () => fakeWorker(sdk), origin: ORIGIN });
    const loading = engine.load(() => undefined);
    await Promise.resolve();
    await engine.terminate();
    await expect(loading).rejects.toThrow("terminated");
  });

  it("a crashed worker fails the pending request", async () => {
    const sdk = fakeSdk({ init: () => new Promise(() => {}) });
    let worker!: ReturnType<typeof fakeWorker>;
    const engine = createPaddleEngine({
      createWorker: () => (worker = fakeWorker(sdk)),
      origin: ORIGIN,
    });
    const loading = engine.load(() => undefined);
    await Promise.resolve();
    worker.onerror?.(new Event("error"));
    await expect(loading).rejects.toThrow(/worker stopped/);
  });
});

describe("Paddle engine in the shared scan workflow: cancel and timeout", () => {
  const file = new File(["image"], "receipt.png", { type: "image/png" });
  const options = { rotation: 0 as const, crop: { left: 0, top: 0, right: 1, bottom: 1 } };
  const deps = (engine: () => ReturnType<typeof createPaddleEngine>) => ({
    scorer: () => ({ score: 1, good: true }),
    createEngine: engine,
  });

  function setupCanvas() {
    vi.useFakeTimers();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 2, height: 2, close: vi.fn() }),
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

  it("reads a page end to end", async () => {
    setupCanvas();
    const sdk = fakeSdk();
    const res = await runOcr(
      file,
      options,
      vi.fn(),
      new AbortController().signal,
      deps(() => createPaddleEngine({ createWorker: () => fakeWorker(sdk), origin: ORIGIN })),
    );
    expect(res.engine).toBe("paddle");
    expect(res.lines).toEqual(["EXAMPLE CAFE", "Fried Rice  8.50"]);
  });

  it("cancels a running recognition and ends the worker", async () => {
    setupCanvas();
    const sdk = fakeSdk({ predict: () => new Promise(() => {}) });
    let worker!: ReturnType<typeof fakeWorker>;
    const ctrl = new AbortController();
    const scan = runOcr(
      file,
      options,
      vi.fn(),
      ctrl.signal,
      deps(() =>
        createPaddleEngine({ createWorker: () => (worker = fakeWorker(sdk)), origin: ORIGIN }),
      ),
    );
    const failure = expect(scan).rejects.toBeInstanceOf(OcrCancelled);
    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.instance.predict).toHaveBeenCalledOnce();
    ctrl.abort();
    await failure;
    expect(worker.terminated).toBeGreaterThan(0);
  });

  it("gives Paddle its own 120 s load limit (Tesseract keeps 60 s), then ends the worker", async () => {
    setupCanvas();
    const sdk = fakeSdk({ init: () => new Promise(() => {}) });
    let worker!: ReturnType<typeof fakeWorker>;
    const scan = runOcr(
      file,
      options,
      vi.fn(),
      new AbortController().signal,
      deps(() =>
        createPaddleEngine({ createWorker: () => (worker = fakeWorker(sdk)), origin: ORIGIN }),
      ),
    );
    let settled: unknown = "pending";
    scan.then(
      (v) => (settled = v),
      (e) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1000);
    expect(settled).toBe("pending"); // past Tesseract's limit, still loading
    await vi.advanceTimersByTimeAsync(PADDLE_LOAD_TIMEOUT_MS - LOAD_TIMEOUT_MS);
    expect(settled).toBeInstanceOf(OcrError);
    expect(settled).toMatchObject({ stage: "load" });
    expect(worker.terminated).toBeGreaterThan(0);
  });

  it("extends the overall scan limit by the extra load time, so recognition keeps its time", async () => {
    setupCanvas();
    // Load takes 100 s (allowed); recognition then hangs: the overall timeout fires at
    // SCAN_TIMEOUT_MS + (120 s - 60 s), not at SCAN_TIMEOUT_MS.
    const sdk = fakeSdk({
      init: () => new Promise((r) => setTimeout(r, 100_000)),
      predict: () => new Promise(() => {}),
    });
    const scan = runOcr(
      file,
      options,
      vi.fn(),
      new AbortController().signal,
      deps(() => createPaddleEngine({ createWorker: () => fakeWorker(sdk), origin: ORIGIN })),
    );
    let settled: unknown = "pending";
    scan.then(
      (v) => (settled = v),
      (e) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS + 1000);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(PADDLE_LOAD_TIMEOUT_MS - LOAD_TIMEOUT_MS);
    expect(settled).toMatchObject({ stage: "timeout" });
  });
});

describe("dev-only engine switch", () => {
  it("only ?engine=paddle with the switch compiled in selects Paddle", () => {
    expect(requestedEngine("?engine=paddle", true)).toBe("paddle");
    expect(requestedEngine("?engine=paddle", false)).toBe("tesseract");
    expect(requestedEngine("?engine=PADDLE", true)).toBe("tesseract");
    expect(requestedEngine("?engine=tesseract", true)).toBe("tesseract");
    expect(requestedEngine("", true)).toBe("tesseract");
  });

  it("gives the default engine unless Paddle is asked for (tests run as a dev build)", () => {
    expect(engineFactoryFor("")).toBeUndefined();
    expect(engineFactoryFor("?engine=other")).toBeUndefined();
    const paddle = engineFactoryFor("?engine=paddle")?.();
    expect(paddle).toMatchObject({ name: "paddle", loadTimeoutMs: PADDLE_LOAD_TIMEOUT_MS });
  });

  it("reads the current page's query when none is passed", () => {
    const before = window.location.href;
    try {
      window.history.replaceState(null, "", "/?step=scan&engine=paddle");
      expect(engineFactoryFor()).toBeDefined();
      window.history.replaceState(null, "", "/?step=scan");
      expect(engineFactoryFor()).toBeUndefined();
    } finally {
      window.history.replaceState(null, "", before);
    }
  });

  it("the lazy Paddle engine marks its statuses and stops if terminated before it loads", async () => {
    const engine = engineFactoryFor("?engine=paddle")!();
    const progress = vi.fn();
    await engine.terminate();
    await expect(engine.load(progress)).rejects.toThrow("terminated");
    expect(progress).toHaveBeenCalledWith({
      status: "[dev] Loading PaddleOCR adapter",
      progress: 0,
    });
    await expect(engine.recognize(blob, "column")).rejects.toThrow(/not loaded/);
    await engine.terminate(); // safe to repeat
  });
});

describe("engine switch at build time", () => {
  it("is on only when requested, and never on the production branch", () => {
    expect(engineSwitchForBuild(undefined, undefined)).toBe("off");
    expect(engineSwitchForBuild("", "engine-eval")).toBe("off");
    expect(engineSwitchForBuild("true", "engine-eval")).toBe("off");
    expect(engineSwitchForBuild("on", undefined)).toBe("on"); // local build
    expect(engineSwitchForBuild("on", "engine-eval")).toBe("on"); // Cloudflare preview build
    expect(engineSwitchForBuild("on", "main")).toBe("blocked"); // Cloudflare production build
  });
});

describe("self-hosted Paddle model archives", () => {
  it.each(PADDLE_MODEL_MANIFEST.map((a) => [a.file, a] as const))(
    "%s is present with its pinned size and SHA-256",
    async (_, asset) => {
      const { createHash } = await import("node:crypto");
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const root = path.resolve(__dirname, "../../..");
      const bytes = readFileSync(path.join(root, PADDLE_MODEL_SOURCE_DIR, asset.file));
      expect(bytes.length).toBe(asset.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    },
  );

  it("are served from /paddle/ under their manifest names, and are not in public/", async () => {
    const { existsSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../../..");
    expect(Object.values(PADDLE_MODEL_PATHS).sort()).toEqual(
      PADDLE_MODEL_MANIFEST.map((a) => `${PADDLE_MODEL_URL_DIR}${a.file}`).sort(),
    );
    // public/ is copied into every build; the archives must only ship with the switch on.
    expect(existsSync(path.join(root, "public", "paddle"))).toBe(false);
  });
});

describe("pinned Paddle packages", () => {
  it("package.json pins the SDK and ONNX Runtime exactly, and the installed copies match", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../../..");
    const read = (p: string) => JSON.parse(readFileSync(path.join(root, p), "utf8"));
    const deps = read("package.json").dependencies;
    expect(deps["@paddleocr/paddleocr-js"]).toBe(PADDLE_SDK_VERSION);
    expect(deps["onnxruntime-web"]).toBe(PADDLE_ORT_VERSION);
    expect(read("node_modules/@paddleocr/paddleocr-js/package.json").version).toBe(
      PADDLE_SDK_VERSION,
    );
    expect(read("node_modules/onnxruntime-web/package.json").version).toBe(PADDLE_ORT_VERSION);
    // The SDK must use that same copy, not a nested one at another version.
    const { existsSync } = await import("node:fs");
    expect(
      existsSync(
        path.join(root, "node_modules/@paddleocr/paddleocr-js/node_modules/onnxruntime-web"),
      ),
    ).toBe(false);
  });
});
