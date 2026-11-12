/**
 * Total-anchored item selection (anchor.ts) and total evidence (totals.ts). Synthetic numbers only.
 */
import { describe, expect, it } from "vitest";
import { anchorItems, MAX_CANDIDATES, type AnchorInput, type AnchorRow } from "./anchor";
import { findPaymentTotal, findSumRow, paidAmounts, readTaxTableRow } from "./totals";

const real = (cents: number): AnchorRow => ({ cents, inside: true, protected: true });
const doubt = (cents: number | null, inside = false): AnchorRow => ({
  cents,
  inside,
  protected: false,
});
const input = (rows: AnchorRow[], totalCents: number, extra: Partial<AnchorInput> = {}) => ({
  rows,
  totalCents,
  discountCents: 0,
  serviceCents: 0,
  taxCents: null,
  inclusive: null,
  ...extra,
});

describe("anchorItems", () => {
  it("sets aside a header row that the total does not need", () => {
    const out = anchorItems(input([doubt(300), real(650), real(280)], 930));
    expect(out).toEqual({ status: "matched", setAside: [0], inclusive: null });
  });

  it("keeps a doubtful row that the total needs, and sets aside the one it doesn't", () => {
    const out = anchorItems(input([real(500), doubt(250, true), doubt(9999)], 750));
    expect(out).toMatchObject({ status: "matched", setAside: [2] });
  });

  it("sets aside an unpriced row when the priced rows reach the total exactly", () => {
    const out = anchorItems(input([real(500), doubt(null, true), real(300)], 800));
    expect(out).toMatchObject({ status: "matched", setAside: [1] });
  });

  it("never sets aside a protected row, even when a doubtful row has the same amount", () => {
    // The real 4.00 item is protected; the doubtful 4.00 row is the one left out.
    const out = anchorItems(input([real(400), doubt(400), real(600)], 1000));
    expect(out).toMatchObject({ status: "matched", setAside: [1] });
  });

  it("does not guess when two different subsets rank the same", () => {
    // Two doubtful 2.00 rows inside the item list, only one is needed: which one is unknowable.
    const out = anchorItems(input([real(500), doubt(200, true), doubt(200, true)], 700));
    expect(out).toEqual({ status: "ambiguous" });
  });

  it("prefers rows inside the item section over rows outside it", () => {
    const out = anchorItems(input([doubt(300, false), real(500), doubt(300, true)], 800));
    expect(out).toMatchObject({ status: "matched", setAside: [0] });
  });

  it("prefers keeping more rows when the inside count ties", () => {
    // 1.00 + 2.00 (two rows) beats 3.00 (one row); all inside the item section.
    const out = anchorItems(
      input([real(1000), doubt(100, true), doubt(200, true), doubt(300, true)], 1300),
    );
    expect(out).toMatchObject({ status: "matched", setAside: [3] });
  });

  it("reports no match when no subset reaches the total", () => {
    expect(anchorItems(input([real(500), doubt(120)], 999))).toEqual({ status: "no-match" });
  });

  it("subtracts printed service and added GST, and adds back a bill discount", () => {
    // items 30.00 - discount 3.00 + service 2.70 + GST 2.67 = 32.37
    const rows = [real(1000), real(2000), doubt(4567)];
    const out = anchorItems(
      input(rows, 3237, { discountCents: 300, serviceCents: 270, taxCents: 267, inclusive: false }),
    );
    expect(out).toMatchObject({ status: "matched", setAside: [2], inclusive: false });
  });

  it("does not add GST that is already included", () => {
    const rows = [real(1090), real(1090), doubt(5000)];
    const out = anchorItems(input(rows, 2180, { taxCents: 180, inclusive: true }));
    expect(out).toMatchObject({ status: "matched", setAside: [2], inclusive: true });
  });

  it("finds the tax reading when it is unknown, if only one reading has a subset", () => {
    const rows = [real(1090), real(1090), doubt(777)];
    const out = anchorItems(input(rows, 2180, { taxCents: 180, inclusive: null }));
    expect(out).toMatchObject({ status: "matched", setAside: [2], inclusive: true });
  });

  it("does not guess when both tax readings have a subset", () => {
    // Exclusive: 10.00 + 1.00 tax = 11.00 (drop the 1.00 row); inclusive: 10.00 + 1.00 rows = 11.00.
    const rows = [real(1000), doubt(100)];
    const out = anchorItems(input(rows, 1100, { taxCents: 100, inclusive: null }));
    expect(out).toEqual({ status: "ambiguous" });
  });

  it("refuses more doubtful rows than the bounded search allows", () => {
    const rows = Array.from({ length: MAX_CANDIDATES + 1 }, (_, k) => doubt(100 + k));
    expect(anchorItems(input(rows, 500))).toEqual({ status: "too-large" });
  });

  it("is deterministic for the largest allowed search", () => {
    const rows = Array.from({ length: MAX_CANDIDATES }, (_, k) => doubt(1000 + 37 * k, true));
    const a = anchorItems(input(rows, 1000 + 1037 + 1074));
    const b = anchorItems(input(rows, 1000 + 1037 + 1074));
    expect(a).toEqual(b);
  });
});

describe("totals evidence", () => {
  it("picks the total a payment agrees with", () => {
    const pool = [
      { cents: 5000, split: false, itemsBefore: 3, strength: 2 },
      { cents: 4600, split: false, itemsBefore: 3, strength: 1 },
    ];
    expect(findPaymentTotal(pool, [{ cents: 5000, change: false }])).toEqual({
      kind: "payment",
      index: 0,
    });
  });

  it("uses cash tendered minus change", () => {
    expect([
      ...paidAmounts([
        { cents: 5000, change: false },
        { cents: 750, change: true },
      ]),
    ]).toEqual([5000, 4250]);
  });

  it("adds per-section totals when their sum is what was paid", () => {
    const pool = [
      { cents: 280, split: false, itemsBefore: 1, strength: 3 },
      { cents: 3100, split: false, itemsBefore: 2, strength: 3 },
    ];
    expect(findPaymentTotal(pool, [{ cents: 3380, change: false }])).toEqual({
      kind: "sections",
      cents: 3380,
      parts: [280, 3100],
    });
  });

  it("gives no evidence without a matching payment", () => {
    const pool = [{ cents: 1000, split: false, itemsBefore: 2, strength: 2 }];
    expect(findPaymentTotal(pool, [{ cents: 2000, change: false }])).toBeNull();
    expect(findPaymentTotal(pool, [])).toBeNull();
  });

  it("reads a tax-table row as net + tax = gross", () => {
    expect(readTaxTableRow([900, 4587, 413, 5000])).toEqual({ net: 4587, tax: 413, gross: 5000 });
    expect(readTaxTableRow([100, 200, 400])).toBeNull();
  });

  it("finds a last row equal to the sum of the rows above it", () => {
    expect(findSumRow([500, 300, 800], [false, false, true])).toBe(2);
    expect(findSumRow([500, 300, 800], [false, false, false])).toBe(-1); // a real-looking name
    expect(findSumRow([500, null, 800], [false, false, true])).toBe(-1);
    expect(findSumRow([800, 800], [false, true])).toBe(-1); // needs two rows above
  });
});
