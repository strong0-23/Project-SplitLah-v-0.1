/**
 * Engine runner and held-out safety. SYNTHETIC references (built from the committed blank template
 * and checked with the owner's unchanged contract) and a fake scan; no OCR, no receipt data.
 *
 * The references use unusual product names and amounts, so any leak into the summary, progress
 * text, results or console would be found.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OcrError } from "../../src/lib/scan/types";
import { receiptLine, summaryBlock, type DesktopRun } from "./comparison";
import { runEngineComparison, type EngineCase, type ScanFn } from "./engine-runner";
import { checkReference, toExpected } from "./owner-reference";
import { rework } from "./rework-parser";

type AnyJson = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const TEMPLATE: AnyJson = JSON.parse(
  readFileSync("tools/receipt-regression/reference-format/reference-template.json", "utf8"),
);
const evidence = { kind: "printed", location: "synthetic line" };
const K = (value: unknown) => ({ state: "known", value, evidence });
const KC = (value_cents: number) => ({ state: "known", value_cents, evidence });

const NAMES = ["QUOKKA PLUM TART", "NARWHAL FIZZ"];
const TEXT = [
  "Item                Qty   Amount",
  "QUOKKA PLUM TART     3     87.21",
  "NARWHAL FIZZ         1     11.13",
  "Subtotal                   98.34",
  "GST 9%                      8.85",
  "Total                     107.19",
].join("\n");
const VALUES = ["87.21", "11.13", "98.34", "8.85", "107.19", "8721", "1113", "9834", "10719"];

function reference(id: string): AnyJson {
  const r = structuredClone(TEMPLATE);
  r.annotation.written_independently_of_ocr = true;
  r.annotation.receipt_id = K(id);
  for (const f of [
    "all_product_rows_accounted_for",
    "all_returns_and_adjustments_accounted_for",
    "all_discounts_accounted_for",
    "all_charges_and_taxes_accounted_for",
  ])
    r.inventory_verification[f] = K(true);
  r.products = [
    [NAMES[0], 3, 8721],
    [NAMES[1], 1, 1113],
  ].map(([name, qty, cents], i) => {
    const p = structuredClone(TEMPLATE.products[0]);
    p.reference_row_id = `r${i + 1}`;
    p.description = { ...p.description, ...K(name) };
    p.row_kind = { ...p.row_kind, ...K("purchase") };
    p.quantity = {
      ...p.quantity,
      state: "known",
      value: { numerator: qty, denominator: 1 },
      evidence,
    };
    p.full_line_amount = { ...p.full_line_amount, state: "known", value_cents: cents, evidence };
    return p;
  });
  r.discounts = [];
  r.charges = [];
  r.returns_and_adjustments = [];
  r.gst.printed_amount = { ...r.gst.printed_amount, ...KC(885) };
  r.gst.inclusion_mode = { ...r.gst.inclusion_mode, ...K("added") };
  r.printed_payable_total = { ...r.printed_payable_total, ...KC(10719) };
  return r;
}

function cases(): EngineCase[] {
  return ["REG901", "REG902", "REG903"].map((id) => {
    const ref = reference(id);
    expect(checkReference(ref, id)).toEqual({ ok: true, errors: [] });
    return {
      id,
      image: new File([id], `${id}.png`, { type: "image/png" }),
      expected: toExpected(ref).expected,
    };
  });
}

/**
 * REG901 reads correctly; REG902 misreads one name (recognisable, so matched by default and
 * missing + extra under `exact`); REG903 fails to load.
 */
const fakeScan: ScanFn = async (_engine, image) => {
  const id = image.name.slice(0, 6);
  if (id === "REG903") throw new OcrError("load", `Could not read ${NAMES[0]} at 87.21`); // a message quoting content
  const text = id === "REG902" ? TEXT.replace("NARWHAL", "NARVVHAL") : TEXT;
  const parsed = rework.parse(text);
  return { receipt: { ...parsed.receipt, rawOcrText: text }, warnings: parsed.warnings };
};

let clock = 0;
const now = () => (clock += 1000);
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  clock = 0;
  for (const m of ["log", "info", "warn", "error", "debug", "trace", "table", "dir"] as const)
    spies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

/** Every way receipt content could show up: names, amounts as printed, amounts in cents. */
function expectNoReferenceValues(text: string) {
  for (const n of NAMES) expect(text.toUpperCase()).not.toContain(n);
  expect(text).not.toMatch(/NARVVHAL|PLUM|QUOKKA|NARWHAL/i);
  for (const v of VALUES)
    expect(text).not.toMatch(new RegExp(`(?<![\\d.])${v.replace(".", "\\.")}(?!\\d)`));
}

async function heldOutRun() {
  const progress: string[] = [];
  const rows: string[] = [];
  const out = await runEngineComparison(cases(), fakeScan, {
    engines: ["tesseract"],
    warmRuns: 3,
    heldOut: true,
    signal: new AbortController().signal,
    now,
    onProgress: (t) => progress.push(t),
    onResult: (r, d) => {
      expect(d).toBeNull();
      rows.push(receiptLine(r));
    },
  });
  const run: DesktopRun = {
    info: {
      set: "held-out",
      runtime: "desktop",
      browser: "Edge",
      version: "142.0",
      os: "Windows",
      revision: "test",
      engines: ["tesseract"],
      warmRuns: 3,
      nameMatch: "recognisable-0.70",
      complete: out.complete,
    },
    results: out.results,
  };
  return { out, progress, rows, summary: summaryBlock(run, true) };
}

describe("held-out mode: no reference values anywhere", () => {
  it("summary, progress text, rendered rows and results hold IDs and counts only", async () => {
    const { out, progress, rows, summary } = await heldOutRun();
    expect(out.details).toBeNull();
    expectNoReferenceValues(summary);
    expectNoReferenceValues(progress.join("\n"));
    expectNoReferenceValues(rows.join("\n"));
    expectNoReferenceValues(JSON.stringify(out.results));
    expect(summary).toContain(
      "receipt | id=REG903 | engine=tesseract | status=failed | stage=load",
    );
    expect(summary).not.toContain("detail |");
  });

  it("writes nothing to the console", async () => {
    await heldOutRun();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("development summaries hold no reference values either (detail is counts only)", async () => {
    const out = await runEngineComparison(cases(), fakeScan, {
      engines: ["tesseract"],
      warmRuns: 0,
      heldOut: false,
      nameMatch: "exact", // so the misread name shows up as missing + extra in the detail line
      signal: new AbortController().signal,
      now,
    });
    expect(out.details).toHaveLength(3);
    const run: DesktopRun = {
      info: {
        set: "development",
        runtime: "desktop",
        browser: "Edge",
        version: "1",
        os: "Windows",
        revision: "t",
        engines: ["tesseract"],
        warmRuns: 0,
        nameMatch: "exact",
        complete: true,
      },
      results: out.results,
    };
    const summary = summaryBlock(run, false);
    expect(summary).toContain("name-match=exact");
    expect(summary).toContain("detail | id=REG902 | engine=tesseract | missing=1 | extra=1");
    expectNoReferenceValues(summary);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("runner: scoring, timing and failures", () => {
  it("scores each receipt, keeps failures in the results and times 1 + 3 scans", async () => {
    const { out } = await heldOutRun();
    expect(out.complete).toBe(true);
    const get = (id: string, e: string) => out.results.find((r) => r.id === id && r.engine === e)!;
    expect(get("REG901", "tesseract")).toMatchObject({
      status: "ok",
      corrections: { total: 0 },
      silent: 0,
      firstMs: 1000,
      warmMs: [1000, 1000, 1000],
      stable: true,
    });
    // A recognisable misspelling is matched with 0 corrections (owner decision, 11 Nov 2026).
    expect(get("REG902", "tesseract").corrections).toMatchObject({
      missing: 0,
      extra: 0,
      total: 0,
    });
    expect(get("REG903", "tesseract")).toMatchObject({
      status: "failed",
      stage: "load",
      corrections: null,
      warmMs: [],
    });
    expect(out.results.map((r) => r.id)).toEqual(["REG901", "REG902", "REG903"]);
  });

  it("records a failed warm scan as null and marks the receipt unstable", async () => {
    let n = 0;
    const flaky: ScanFn = async (e, image, s) => {
      if (++n === 3) throw new OcrError("timeout", "too slow");
      return fakeScan(e, image, s);
    };
    const out = await runEngineComparison(cases().slice(0, 1), flaky, {
      engines: ["tesseract"],
      warmRuns: 3,
      heldOut: true,
      signal: new AbortController().signal,
      now,
    });
    expect(out.results[0]).toMatchObject({
      status: "ok",
      warmMs: [1000, null, 1000],
      stable: false,
    });
  });

  it("stops on cancel and reports the run as incomplete", async () => {
    const ctrl = new AbortController();
    const out = await runEngineComparison(
      cases(),
      async (e, image, s) => {
        ctrl.abort();
        return fakeScan(e, image, s);
      },
      { engines: ["tesseract"], warmRuns: 3, heldOut: true, signal: ctrl.signal, now },
    );
    expect(out.complete).toBe(false);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ status: "cancelled" });
  });

  it("times without scoring when there is no reference", async () => {
    const [c] = cases();
    const out = await runEngineComparison([{ ...c!, expected: null }], fakeScan, {
      engines: ["tesseract"],
      warmRuns: 3,
      heldOut: true,
      signal: new AbortController().signal,
      now,
    });
    expect(out.results[0]).toMatchObject({
      status: "ok",
      corrections: null,
      silent: null,
      warmMs: [1000, 1000, 1000],
    });
  });
});
