/**
 * Phase 2c runner: scans each receipt with each chosen engine through the app's own scan pipeline,
 * times one first scan plus warm re-scans, and scores the app's receipt against the owner's
 * verified reference. The scan function is injected (main.ts passes `scanReceipt` with an engine
 * factory), so this module has no DOM, no OCR SDK and no console output, and is unit-tested.
 *
 * Held-out mode: nothing per-field is kept. Results hold IDs, counts, stages and timings only;
 * error messages are reduced to their stage; `details` is never built; progress text names the
 * receipt ID, engine and scan number only.
 *
 * Warm time: a re-scan of the same image in the same page session with the engine already loaded.
 * `scanReceipt` keeps the loaded engine between scans (engine-pool.ts), as the app does, so a warm
 * scan is recognition only. The first scan of each engine in a run includes loading it (cold).
 */
import type { Receipt } from "../../src/lib/types";
import { countCorrections, countSilent } from "./corrections";
import type { EngineId, ReceiptEngineResult } from "./comparison";
import { evaluate, type Check, type Expected } from "./model";
import { ENGINE_COMPARISON_NAME_MATCH, type NameMatch } from "./names";
import { rework } from "./rework-parser";

export interface EngineCase {
  /** REG id from the file name. */
  id: string;
  image: File;
  /** The verified reference's scored fields; null = time only, no scoring (phone page). */
  expected: Expected | null;
  /** Sanitised photo-condition tags (comparison.ts `cleanTags`). */
  tags?: string[];
}

export interface ScanOutput {
  receipt: Receipt;
  warnings: string[];
}

export type ScanFn = (engine: EngineId, image: File, signal: AbortSignal) => Promise<ScanOutput>;

/** Per-field detail for the development UI. Never built in held-out mode. */
export interface EngineDetail {
  id: string;
  engine: EngineId;
  checks: Check[];
  receipt: Receipt | null;
  warnings: string[];
  text: string | null;
  error: string | null;
}

export interface RunOptions {
  engines: readonly EngineId[];
  warmRuns: number;
  heldOut: boolean;
  /** Item-name rule for scoring. Default: `recognisable` (owner decision, 11 Nov 2026). */
  nameMatch?: NameMatch;
  signal: AbortSignal;
  now: () => number;
  /** Status text: receipt ID, engine and scan number only. */
  onProgress?: (text: string) => void;
  /** Called after each receipt × engine, e.g. to render a row. */
  onResult?: (r: ReceiptEngineResult, detail: EngineDetail | null) => void;
}

/** A failure's stage: the OcrError stage when there is one (decode, load, orient, recognize, timeout). */
function stageOf(e: unknown, fallback: string): string {
  const stage = (e as { stage?: unknown } | null)?.stage;
  return typeof stage === "string" && /^[a-z]+$/.test(stage) ? stage : fallback;
}

/** Engine-major order: every receipt with the first engine, then every receipt with the next. */
export async function runEngineComparison(
  cases: readonly EngineCase[],
  scan: ScanFn,
  opts: RunOptions,
): Promise<{ results: ReceiptEngineResult[]; details: EngineDetail[] | null; complete: boolean }> {
  const results: ReceiptEngineResult[] = [];
  const details: EngineDetail[] | null = opts.heldOut ? null : [];
  const scansPer = 1 + opts.warmRuns;
  for (const engine of opts.engines) {
    for (const c of cases) {
      if (opts.signal.aborted) return { results, details, complete: false };
      const result: ReceiptEngineResult = {
        id: c.id,
        engine,
        status: "ok",
        corrections: null,
        silent: null,
        firstMs: null,
        warmMs: [],
        stable: null,
        ...(c.tags?.length ? { tags: c.tags } : {}),
      };
      let detail: EngineDetail | null = opts.heldOut
        ? null
        : { id: c.id, engine, checks: [], receipt: null, warnings: [], text: null, error: null };
      let firstText: string | null = null;
      try {
        opts.onProgress?.(`${c.id}: ${engine} scan 1 of ${scansPer}`);
        const t0 = opts.now();
        const first = await scan(engine, c.image, opts.signal);
        result.firstMs = opts.now() - t0;
        firstText = first.receipt.rawOcrText ?? "";
        const checks = c.expected
          ? evaluate(c.expected, first.receipt, rework, {
              nameMatch: opts.nameMatch ?? ENGINE_COMPARISON_NAME_MATCH,
            })
          : [];
        if (c.expected) {
          result.corrections = countCorrections(checks);
          result.silent = countSilent(checks);
        }
        if (detail)
          detail = {
            ...detail,
            checks,
            receipt: first.receipt,
            warnings: first.warnings,
            text: firstText,
          };
      } catch (e) {
        result.status = opts.signal.aborted ? "cancelled" : "failed";
        result.stage = opts.signal.aborted ? "cancelled" : stageOf(e, "scan");
        if (detail) detail.error = e instanceof Error ? e.message : String(e);
      }
      if (result.status === "ok") {
        let stable = true;
        for (let i = 0; i < opts.warmRuns; i++) {
          if (opts.signal.aborted) {
            result.status = "cancelled";
            result.stage = "cancelled";
            break;
          }
          opts.onProgress?.(`${c.id}: ${engine} scan ${i + 2} of ${scansPer} (warm)`);
          const t0 = opts.now();
          try {
            const again = await scan(engine, c.image, opts.signal);
            result.warmMs.push(opts.now() - t0);
            if ((again.receipt.rawOcrText ?? "") !== firstText) stable = false;
          } catch {
            if (opts.signal.aborted) {
              result.status = "cancelled";
              result.stage = "cancelled";
              break;
            }
            result.warmMs.push(null); // a failed or timed-out warm scan stays in the median
            stable = false;
          }
        }
        result.stable = opts.warmRuns > 0 && result.status === "ok" ? stable : null;
      }
      firstText = null;
      results.push(result);
      details?.push(detail!);
      opts.onResult?.(result, detail);
      if (result.status === "cancelled") return { results, details, complete: false };
    }
  }
  return { results, details, complete: true };
}
