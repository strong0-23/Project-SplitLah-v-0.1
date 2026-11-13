/**
 * Reading coverage (WO-001). Synthetic references and text only.
 */
import { describe, expect, it } from "vitest";
import { amountsInText, coverageShare, printedAmounts, readingCoverage } from "./coverage";
import { parseSummaries, receiptLine, type ReceiptEngineResult } from "./comparison";

const evidence = { kind: "printed", location: "synthetic line" };
const KC = (value_cents: number | null, state = "known") => ({ state, value_cents, evidence });
const K = (value: unknown) => ({ state: "known", value, evidence });

const REFERENCE = {
  products: [
    { row_kind: K("purchase"), full_line_amount: KC(1290) },
    { row_kind: K("purchase"), full_line_amount: KC(350) },
    { row_kind: K("purchase"), full_line_amount: KC(350) },
    { row_kind: K("return"), full_line_amount: KC(-500) }, // the app has no returns
    { row_kind: K("purchase"), full_line_amount: KC(null, "illegible") }, // not known
  ],
  charges: [
    { kind: K("service_charge"), printed_amount: KC(199) },
    { kind: K("gst"), printed_amount: KC(196) },
  ],
  gst: { printed_amount: KC(196) }, // already a charge row: counted once
  printed_payable_total: KC(2385),
};

describe("printed amounts from a reference", () => {
  it("takes known line amounts, charges and the payable total, once each", () => {
    expect(printedAmounts(REFERENCE)).toEqual([1290, 350, 350, 199, 196, 2385]);
  });
  it("adds the GST amount when no charge row holds it, and skips zero amounts", () => {
    expect(
      printedAmounts({ gst: { printed_amount: KC(81) }, printed_payable_total: KC(0) }),
    ).toEqual([81]);
  });
});

describe("amounts in OCR text", () => {
  it("reads two-decimal amounts with either separator, signs and currency marks", () => {
    expect(amountsInText("Tea 3.50  $12,90  -1.00  2.00-  1,234.56  1.234,56")).toEqual([
      350, 1290, 100, 200, 123456, 123456,
    ]);
  });
  it("does not read parts of longer numbers, times, or repaired digits", () => {
    expect(amountsInText("Tel 6123.45678  12:30  1O.50  2026.11.13")).toEqual([]);
  });
});

describe("reading coverage", () => {
  it("counts each printed amount against its own reading (multiset)", () => {
    const amounts = printedAmounts(REFERENCE);
    const full = "A 12.90\nB 3.50\nC 3.50\nSvc 1.99\nGST 1.96\nTotal 23.85";
    expect(readingCoverage(amounts, full)).toEqual({ found: 6, of: 6 });
    // One of the two 3.50 rows and everything below it lost.
    expect(readingCoverage(amounts, "A 12.90\nB 3.50")).toEqual({ found: 2, of: 6 });
    expect(coverageShare({ found: 2, of: 6 })).toBeCloseTo(1 / 3);
    expect(coverageShare({ found: 0, of: 0 })).toBeNull();
  });

  it("travels in summary lines as a count, and is read back", () => {
    const r: ReceiptEngineResult = {
      id: "REG900",
      engine: "tesseract",
      status: "ok",
      corrections: null,
      silent: null,
      firstMs: 1,
      warmMs: [],
      stable: null,
      coverage: { found: 3, of: 4 },
      incomplete: true,
    };
    const line = receiptLine(r);
    expect(line).toMatch(/coverage=3\/4 \| incomplete=yes \| flagged=- \| uncertain=-$/);
    const run = `run | set=development | runtime=desktop | browser=Chrome | version=1 | os=Linux | revision=x | engines=tesseract | warm-runs=0 | condition=first-use | name-match=recognisable-0.70 | complete=yes | receipts=1\n${line}`;
    const back = parseSummaries(run).runs[0]!.results[0]!;
    expect(back.coverage).toEqual({ found: 3, of: 4 });
    expect(back.incomplete).toBe(true);
    // Anything else in the field is ignored.
    expect(
      parseSummaries(run.replace("coverage=3/4", "coverage=12.90")).runs[0]!.results[0]!.coverage,
    ).toBeNull();
  });
});
