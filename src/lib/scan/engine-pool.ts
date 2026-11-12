/**
 * Keeps one loaded OCR engine alive between scans in a page session, so a second scan doesn't
 * restart the engine (worker, WASM and models). Same for any engine behind `OcrEngine`.
 *
 * Lifecycle (owner/coordinator decision, 11 Nov 2026):
 * - A scan acquires the engine for its factory. A loaded, idle engine of the same factory is reused;
 *   otherwise a new one is created and must be loaded (with the usual load limit).
 * - After a successful scan the engine is kept, and disposed after `ENGINE_IDLE_MS` without use.
 * - It is disposed straight away on error, cancel or timeout (marked for reload), when another
 *   engine is asked for (engine choice changed), and on page hide/unload (`pagehide`).
 * - While a scan holds the engine, a second concurrent scan gets its own single-use engine.
 *
 * The engine's `load` gets a forwarding progress callback, so progress an engine reports later
 * (Tesseract reports recognition progress through its load-time logger) reaches whichever scan is
 * using it now. No DOM except the optional `pagehide` hook; timers are injectable for tests.
 */
import type { EngineProgress, OcrEngine } from "./types";

/** Idle time after which a kept engine is disposed (3 minutes). */
export const ENGINE_IDLE_MS = 180_000;

type Factory = () => OcrEngine;
type Sink = (p: EngineProgress) => void;
const noop: Sink = () => undefined;

export interface EngineLease {
  readonly engine: OcrEngine;
  /** True when `load` must run before use (new engine). False for a reused, loaded engine. */
  readonly needsLoad: boolean;
  /** Loads the engine; its progress goes to the scan currently holding the lease. */
  load(): Promise<void>;
  /** The scan succeeded: keep the engine for the next scan (single-use leases terminate it). */
  release(): Promise<void>;
  /** Error, cancel or timeout: terminate now; the next scan creates and loads a new engine. Idempotent. */
  discard(): Promise<void>;
}

/** A lease that never keeps its engine: terminated after the scan, whatever the outcome. */
export function singleUseLease(engine: OcrEngine, onProgress: Sink): EngineLease {
  let done = false;
  const end = async () => {
    if (done) return;
    done = true;
    await engine.terminate();
  };
  return {
    engine,
    needsLoad: true,
    load: () => engine.load(onProgress),
    release: end,
    discard: end,
  };
}

export interface EnginePoolOptions {
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Held {
  factory: Factory;
  engine: OcrEngine;
  loaded: boolean;
  busy: boolean;
  sink: Sink;
  timer: unknown;
}

export class EnginePool {
  private held: Held | null = null;
  private readonly idleMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(opts: EnginePoolOptions = {}) {
    this.idleMs = opts.idleMs ?? ENGINE_IDLE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Is a loaded engine of this factory kept and free? (For tests and diagnostics.) */
  isWarm(factory: Factory): boolean {
    return !!this.held && this.held.factory === factory && this.held.loaded && !this.held.busy;
  }

  acquire(factory: Factory, onProgress: Sink): EngineLease {
    const h = this.held;
    if (h && h.factory === factory && h.busy) {
      // A concurrent scan with the same engine: don't share a busy engine.
      return singleUseLease(factory(), onProgress);
    }
    if (h && (h.factory !== factory || !h.loaded)) void this.drop(h); // engine choice changed
    let entry = this.held;
    if (!entry) {
      entry = { factory, engine: factory(), loaded: false, busy: false, sink: noop, timer: null };
      this.held = entry;
    }
    const e = entry;
    this.stopTimer(e);
    e.busy = true;
    e.sink = onProgress;
    const needsLoad = !e.loaded;
    let settled = false;
    return {
      engine: e.engine,
      needsLoad,
      load: async () => {
        await e.engine.load((p) => e.sink(p));
        e.loaded = true;
      },
      release: async () => {
        if (settled) return;
        settled = true;
        e.sink = noop;
        e.busy = false;
        if (this.held !== e || !e.loaded) return this.drop(e);
        e.timer = this.setTimer(() => void this.drop(e), this.idleMs);
      },
      discard: async () => {
        if (settled) return;
        settled = true;
        e.sink = noop;
        e.busy = false;
        await this.drop(e);
      },
    };
  }

  /** Disposes the kept engine (page hide/unload). A scan in progress is not interrupted here. */
  async dispose(): Promise<void> {
    const h = this.held;
    if (h && !h.busy) await this.drop(h);
  }

  private stopTimer(h: Held) {
    if (h.timer !== null) this.clearTimer(h.timer);
    h.timer = null;
  }

  private async drop(h: Held) {
    this.stopTimer(h);
    if (this.held === h) this.held = null;
    await h.engine.terminate();
  }
}

let shared: EnginePool | null = null;

/** The page's engine pool, disposed on `pagehide` (navigation, unload, back-forward cache). */
export function sharedEnginePool(): EnginePool {
  if (shared) return shared;
  const pool = new EnginePool();
  shared = pool;
  globalThis.addEventListener?.("pagehide", () => void pool.dispose());
  return pool;
}
