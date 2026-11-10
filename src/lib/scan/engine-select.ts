/**
 * Dev-only engine switch (Batch 2b). `?engine=paddle` runs a scan with PaddleOCR instead of
 * Tesseract, but ONLY in builds where the switch is compiled in:
 *   - `npm run dev` (Vite dev server: `import.meta.env.DEV` is true), or
 *   - a build made with the environment variable `VITE_SPLITLAH_ENGINE_SWITCH=on`.
 * Both are replaced by constants at build time. In a normal production build the condition is
 * `false`, the Paddle branch and its dynamic import are removed, and no Paddle code or worker is
 * emitted: production always uses Tesseract. Normal users see nothing.
 */
import { PADDLE_LOAD_TIMEOUT_MS } from "./paddle-assets";
import type { EngineProgress, LayoutHint, OcrEngine } from "./types";

export type EngineChoice = "tesseract" | "paddle";

declare global {
  interface ImportMetaEnv {
    /** "on" compiles the dev engine switch into a non-dev build (never set for deploys). */
    readonly VITE_SPLITLAH_ENGINE_SWITCH?: string;
  }
}

/** True only in dev builds or builds made with VITE_SPLITLAH_ENGINE_SWITCH=on. */
export const ENGINE_SWITCH_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_SPLITLAH_ENGINE_SWITCH === "on";

/** Which engine a page URL's query asks for. Anything but `engine=paddle`, or a disabled switch, is Tesseract. */
export function requestedEngine(search: string, enabled: boolean): EngineChoice {
  if (!enabled) return "tesseract";
  return new URLSearchParams(search).get("engine") === "paddle" ? "paddle" : "tesseract";
}

/** An engine that imports the Paddle adapter on first `load`, so nothing Paddle is in the page bundle. */
function lazyPaddleEngine(): OcrEngine {
  let inner: OcrEngine | null = null;
  let dead = false;
  return {
    name: "paddle",
    loadTimeoutMs: PADDLE_LOAD_TIMEOUT_MS,
    async load(report: (p: EngineProgress) => void) {
      // Statuses are marked, so a developer can see the dev engine is running.
      const tagged = (p: EngineProgress) => report({ ...p, status: `[dev] ${p.status}` });
      tagged({ status: "Loading PaddleOCR adapter", progress: 0 });
      const { createPaddleEngine } = await import("./paddle-engine");
      if (dead) throw new Error("terminated");
      inner = createPaddleEngine();
      await inner.load(tagged);
    },
    recognize(image: Blob, layout: LayoutHint) {
      if (!inner) return Promise.reject(new Error("Engine not loaded"));
      return inner.recognize(image, layout);
    },
    async terminate() {
      dead = true;
      await inner?.terminate();
    },
  };
}

/**
 * The `createEngine` to pass to `scanReceipt` for this page URL (default: the current page's query),
 * or undefined for the default engine (Tesseract). In production builds this whole function folds to
 * `undefined`: the URL is never read and nothing Paddle-related is bundled.
 */
export function engineFactoryFor(search?: string): (() => OcrEngine) | undefined {
  if (!ENGINE_SWITCH_ENABLED) return undefined;
  const query = search ?? globalThis.location?.search ?? "";
  return requestedEngine(query, true) === "paddle" ? lazyPaddleEngine : undefined;
}
